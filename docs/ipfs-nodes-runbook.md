# IPFS nodes runbook

Manual steps to provision the three Spiral Devnet-adjacent Kubo nodes. Nothing in
`infra/kubo/` or `scripts/kubo-node-control.ts` creates cloud resources automatically —
this document is what turns them into a real deployment.

## 1. Provision three VPS

| Provider     | Region (example) | Spec                     | Billing |
| ------------ | ---------------- | ------------------------ | ------- |
| Hetzner      | Falkenstein, DE  | 2-4 vCPU / 40-80 GB disk | hourly  |
| DigitalOcean | NYC, US          | 2-4 vCPU / 40-80 GB disk | hourly  |
| Vultr        | São Paulo, BR    | 2-4 vCPU / 40-80 GB disk | hourly  |

Three providers, three autonomous systems, three regions — deliberate, so no single
provider's network conditions dominate the H2 degradation results. Use a fresh Ubuntu
or Debian image on each. The campaign also rents a 4th server (the orchestrator, on
Hetzner); see the [campaign runbook](campaign-runbook.md) for the full sequence and the
cost table.

The campaign runbook fixes which provider hosts replica `a`, `b` and `c` (`a` must not share a
provider with the orchestrator): follow its ordering, [campaign runbook §0](campaign-runbook.md#0-overview-cost-and-the-end-to-end-gate).

**A powered-off server is still billed. Only deleting it stops the cost.**

Create each server with your workstation's SSH public key for `root` (all three providers
offer this at creation). **Administrative steps run as `root`** (`ssh root@<node-host>`), so the
`spiral` operator account never needs general sudo: its only sudo right is the narrow
`systemctl --no-block start/stop ipfs` rule of §6. Install the packages these steps use (Debian
images ship without `sudo` and `ufw`):

```bash
# as root on the node
apt-get update && apt-get install -y sudo ufw python3 wget
```

## 2. Install Kubo and create the accounts

Follow Kubo's own install instructions for your distro (https://docs.ipfs.tech/install/command-line/)
to get the `ipfs` binary on `PATH` at `/usr/local/bin/ipfs`. Install version **0.43.1** exactly:
`campaign:preflight` rejects any other version. The tarball below is for x86-64 (`uname -m`
prints `x86_64`); on an ARM server (`aarch64`, e.g. Hetzner CAX) use
`kubo_v0.43.1_linux-arm64.tar.gz` instead.

```bash
# as root on the node
wget https://dist.ipfs.tech/kubo/v0.43.1/kubo_v0.43.1_linux-amd64.tar.gz
tar -xzf kubo_v0.43.1_linux-amd64.tar.gz
bash kubo/install.sh
ipfs version --number   # 0.43.1
```

Create a dedicated `ipfs` system user to run the node as (matching `infra/kubo/ipfs.service`'s
`User=ipfs`). This account is service-only — it never logs in interactively or over SSH:

```bash
# as root on the node
useradd --system --create-home --shell /usr/sbin/nologin ipfs
```

Also create a separate `spiral` operator account: a normal login account, distinct from the
`ipfs` service account, with **no** general sudo. §5's SSH tunnel and §6's control-agent key
both use it — `ipfs` itself can never be SSH'd into, since it has no shell. Authorize your
workstation's public key for it:

```bash
# as root on the node
useradd -m -s /bin/bash spiral
install -d -m 700 -o spiral -g spiral /home/spiral/.ssh
echo "<contents of your workstation's ~/.ssh/id_ed25519.pub>" | tee -a /home/spiral/.ssh/authorized_keys >/dev/null
chown spiral:spiral /home/spiral/.ssh/authorized_keys
chmod 600 /home/spiral/.ssh/authorized_keys
```

## 3. Run the setup script

Copy `infra/kubo/setup.sh` to the VPS (`scp infra/kubo/setup.sh infra/kubo/ipfs.service
root@<node-host>:`) and run it as the `ipfs` user:

```bash
# as root on the node, in /root
cp setup.sh /home/ipfs/setup.sh
sudo -u ipfs IPFS_PATH=/home/ipfs/.ipfs sh /home/ipfs/setup.sh
```

Safe to re-run — it only initializes the repo if one doesn't already exist, and the
`ipfs config` calls are idempotent.

## 4. Install and start the systemd service

```bash
# as root on the node, in /root
cp ipfs.service /etc/systemd/system/ipfs.service
systemctl daemon-reload
systemctl enable --now ipfs
systemctl status ipfs
```

## 5. Firewall

Open port 4001 (TCP **and** UDP) for the swarm. **Never expose port 5001 (the RPC
API) publicly** — leave it bound to loopback only (`/ip4/127.0.0.1/tcp/5001`, Kubo's
default):

```bash
# as root on the node
ufw allow 22/tcp
ufw allow 4001/tcp
ufw allow 4001/udp
ufw enable
```

Access the API exclusively through an SSH tunnel, using the `spiral` operator account
(set up in §2 — separate from the `ipfs` service account, which has no shell and cannot be
SSH'd into):

```bash
ssh -L 5001:127.0.0.1:5001 spiral@<node-host>
```

## 6. Set up SSH access for the control agent

`scripts/kubo-node-control.ts` drives `start`/`shutdown`/status checks over SSH — this
is what a remote orchestrator will use for the H2 progressive-degradation test
(3 → 2 → 1 → 0 replicas). Create a dedicated control-machine SSH key and authorize it:

```bash
# on the control machine (the orchestrator), as spiral
ssh-keygen -t ed25519 -f ~/.ssh/spiral-node-control -N ""
cat ~/.ssh/spiral-node-control.pub
```

On each node, append it to the `spiral` operator account's `authorized_keys` (**not** the
`ipfs` service account, which has no shell and cannot accept SSH logins at all):

```bash
# as root on the node
echo "<contents of spiral-node-control.pub>" | tee -a /home/spiral/.ssh/authorized_keys >/dev/null
chown spiral:spiral /home/spiral/.ssh/authorized_keys
chmod 600 /home/spiral/.ssh/authorized_keys
```

`startService`/`shutdownService` run `sudo systemctl --no-block start ipfs` /
`sudo systemctl --no-block stop ipfs` over this connection, so `spiral` needs passwordless
sudo for exactly those two invocations — nothing broader. Add a sudoers entry restricted to the literal commands:

```bash
# as root on the node
echo 'spiral ALL=(ALL) NOPASSWD: /usr/bin/systemctl --no-block start ipfs, /usr/bin/systemctl --no-block stop ipfs' > /etc/sudoers.d/spiral
chmod 440 /etc/sudoers.d/spiral
visudo -cf /etc/sudoers.d/spiral
```

The campaign pre-flight checks this rule on each replica with
`sudo -n -l /usr/bin/systemctl --no-block start ipfs` and the same for `stop`; its
`replica <name> sudo` row blocks if either is not permitted.

Do **not** grant a bare `/usr/bin/systemctl` (with no arguments) — that's unrestricted
root, since systemctl can also do things like `link` an arbitrary unit file. Also don't
add `is-active` to this sudoers line: `checkSystemdActive` in
`scripts/kubo-node-control.ts` runs `systemctl is-active ipfs` _without_ `sudo` — any
user can query unit status, so it needs no sudoers entry at all.

Then, from the control machine, `checkStatus({ host, port: 22, user, identityFile:
"~/.ssh/spiral-node-control" }, 4001)` (swarm port 4001, not the RPC port) reports
`{ systemdActive, swarmReachable }` for that node.

## 7. Record the three node addresses

Note each node's public IP and PeerID (`ipfs id` after the daemon is running) —
the submission client and the evaluation harness both need all three.

## 8. Back up and restore the node identity

The PeerID (the `Identity` section of `/home/ipfs/.ipfs/config`: `PeerID` and `PrivKey`) is
declared on-chain for every film at submit and can never be changed afterwards. Back it up off
the server as soon as the node runs, before any submit. The file holds a private key: store it
like the program keypairs, in encrypted storage. `ipfs config Identity.PrivKey` refuses to print
it, so read the config file directly.

**Back up** from your own machine, over the `root` login of §1. Nothing is written on the
server:

```bash
# on your own machine
ssh root@<node-a-host> python3 - > identity-a.json <<'EOF'
import json
print(json.dumps(json.load(open("/home/ipfs/.ipfs/config"))["Identity"]))
EOF
chmod 600 identity-a.json
```

**Restore** on a recreated server: run §1–§6 as for a new node, then put the old identity back
before anything else talks to it:

```bash
# on your own machine
scp identity-a.json root@<new-node-a-host>:
```

```bash
# as root on the node, in /root
systemctl stop ipfs
python3 -c 'import json, sys; p = "/home/ipfs/.ipfs/config"; c = json.load(open(p)); c["Identity"] = json.load(open(sys.argv[1])); json.dump(c, open(p, "w"), indent=2)' identity-a.json
rm identity-a.json
systemctl start ipfs
sudo -u ipfs IPFS_PATH=/home/ipfs/.ipfs ipfs id -f '<id>\n'
```

Expected: the old PeerID. A recreated node has the identity but **not the content**. Re-add each
file with the Spiral Chunking Profile v1 parameters and check that the printed CID equals the
`cid` of its golden line:

```bash
# on your own machine
scp dataset/files/<file_name> root@<new-node-a-host>:/tmp/
```

```bash
# as root on the node
chmod 644 /tmp/<file_name>
sudo -u ipfs IPFS_PATH=/home/ipfs/.ipfs ipfs add --cid-version=1 --raw-leaves --chunker=size-262144 -Q /tmp/<file_name>
rm /tmp/<file_name>
```

If the host name or address changed, update `ssh.host` in the campaign `topology.json` and
accept the new host key from the orchestrator under that same name. Nothing on-chain changes.

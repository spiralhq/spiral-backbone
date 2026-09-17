# IPFS nodes runbook

Manual steps to provision the three Spiral Devnet-adjacent Kubo nodes. Nothing in
`infra/kubo/` or `scripts/kubo-node-control.ts` creates cloud resources automatically —
this document is what turns them into a real deployment.

## 1. Provision three VPS

| Provider     | Region          | Spec                     |
| ------------ | --------------- | ------------------------ |
| Hetzner      | Falkenstein, DE | 2-4 vCPU / 40-80 GB disk |
| DigitalOcean | NYC, US         | 2-4 vCPU / 40-80 GB disk |
| Contabo      | São Paulo, BR   | 2-4 vCPU / 40-80 GB disk |

Three providers, three autonomous systems, three regions — deliberate, so no single
provider's network conditions dominate the H2 degradation results. Use a fresh Ubuntu
or Debian image on each.

## 2. Install Kubo

Follow Kubo's own install instructions for your distro (https://docs.ipfs.tech/install/command-line/)
to get the `ipfs` binary on `PATH` at `/usr/local/bin/ipfs`. Create a dedicated `ipfs`
system user to run the node as (matching `infra/kubo/ipfs.service`'s `User=ipfs`). This
account is service-only — it never logs in interactively or over SSH:

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin ipfs
```

Also create (or reuse your cloud provider's default) a separate `spiral` operator
account: a normal login account with sudo rights, distinct from the `ipfs` service
account above. This is the account §5's SSH tunnel and §6's control-agent key both use —
`ipfs` itself can never be SSH'd into, since it has no shell.

```bash
sudo useradd -m -s /bin/bash spiral
sudo usermod -aG sudo spiral   # or the wheel group, depending on distro
```

## 3. Run the setup script

Copy `infra/kubo/setup.sh` to the VPS and run it as the `ipfs` user:

```bash
sudo -u ipfs IPFS_PATH=/home/ipfs/.ipfs sh setup.sh
```

Safe to re-run — it only initializes the repo if one doesn't already exist, and the
`ipfs config` calls are idempotent.

## 4. Install and start the systemd service

```bash
sudo cp infra/kubo/ipfs.service /etc/systemd/system/ipfs.service
sudo systemctl daemon-reload
sudo systemctl enable --now ipfs
sudo systemctl status ipfs
```

## 5. Firewall

Open port 4001 (TCP **and** UDP) for the swarm. **Never expose port 5001 (the RPC
API) publicly** — leave it bound to loopback only; access it exclusively through an
SSH tunnel, using the `spiral` operator account (a normal login account with sudo
rights, set up in §2 — separate from the `ipfs` service account, which has no shell
and cannot be SSH'd into):

```bash
ssh -L 5001:127.0.0.1:5001 spiral@<node-host>
```

## 6. Set up SSH access for the control agent

`scripts/kubo-node-control.ts` drives `start`/`shutdown`/status checks over SSH — this
is what a remote orchestrator will use for the H2 progressive-degradation test
(3 → 2 → 1 → 0 replicas). Create a dedicated control-machine SSH key and authorize it:

```bash
# on the control machine
ssh-keygen -t ed25519 -f ~/.ssh/spiral-node-control -N ""

# on each node: append the public key to the `spiral` operator account's
# authorized_keys (NOT the ipfs service account, which has no shell and
# cannot accept SSH logins at all)
echo "<contents of spiral-node-control.pub>" >> /home/spiral/.ssh/authorized_keys
```

`startService`/`shutdownService` run `sudo systemctl start ipfs` / `sudo systemctl stop
ipfs` over this connection, so `spiral` needs passwordless sudo for exactly those two
invocations — nothing broader. Add a sudoers entry (e.g. `/etc/sudoers.d/spiral`)
restricted to the literal commands:

```
spiral ALL=(ALL) NOPASSWD: /usr/bin/systemctl start ipfs, /usr/bin/systemctl stop ipfs
```

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

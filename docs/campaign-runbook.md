# Campaign runbook

The exact manual sequence for the real evaluation campaign: from renting the servers to deleting
them. Every command below exists in this repository and is exercised at reduced scale by its
tests (local Docker topology, Surfpool chain); the campaign only adds real infrastructure, real
money and the real Devnet.

Each step gives the command, what you should see and what to do when it fails. Background for
every command is in [the evaluation harness](eval-harness.md) and
[the IPFS nodes runbook](ipfs-nodes-runbook.md).

Machines used below:

| Name             | What it is                                                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **workstation**  | Your own machine. Holds the Anchor toolchain, the program keypairs and the dataset files, and runs `spiral submit` (the submission machine). |
| **node-a/b/c**   | The three replica VPS, each running Kubo 0.43.1 under systemd.                                                                               |
| **orchestrator** | The 4th VPS. Runs pre-flight, H1, H2, H3, H4, the report and the daily archive. Hosts the network node and the H2 executor containers.       |

Commands run from the root of the `spiral-backbone` checkout unless a step says otherwise.

## 0. Overview and cost

The campaign rents four servers, all billed **hourly**:

| Role         | Provider     | Region (example — pick one region per provider) | Suggested size                 |
| ------------ | ------------ | ----------------------------------------------- | ------------------------------ |
| node-a       | Hetzner      | Falkenstein, DE                                 | 2–4 vCPU / 40–80 GB disk       |
| node-b       | DigitalOcean | New York, US                                    | 2–4 vCPU / 40–80 GB disk       |
| node-c       | Vultr        | São Paulo, BR                                   | 2–4 vCPU / 40–80 GB disk       |
| orchestrator | Hetzner      | a location other than node-a's                  | 4 vCPU / 8 GB RAM / 80 GB disk |

Three providers, three autonomous systems and three regions for the replicas: the three IPFS
nodes must run on distinct providers in distinct regions, so that no single provider failure takes
them all down and no single provider's network dominates the H2 degradation results. The orchestrator is the fourth server, so that the
cold-start executors never run on a replica or on the submission machine.

**A powered-off server is still billed. Only deleting it stops the cost.** Snapshots, backups and
separately billed IPv4 addresses are charged too.

Fill in this table from each provider's pricing page on the day you rent (prices are not written
here on purpose; they change):

| Role         | Provider     | Plan | Price per hour | Extras per hour (IPv4, backups) | Expected hours | Expected total |
| ------------ | ------------ | ---- | -------------- | ------------------------------- | -------------- | -------------- |
| node-a       | Hetzner      |      |                |                                 |                |                |
| node-b       | DigitalOcean |      |                |                                 |                |                |
| node-c       | Vultr        |      |                |                                 |                |                |
| orchestrator | Hetzner      |      |                |                                 |                |                |

Expected hours = from creation (§2) to deletion (§13). The H2 run dominates it; §9 shows how to
estimate its duration from the frozen plan before you start it.

## 1. Devnet programs

On the workstation, in the `spiral-programs` checkout:

1. **Back up the program keypairs.** Copy `keys/organization-keypair.json` and
   `keys/film-keypair.json` to encrypted storage outside the repo (see `keys/README.md` in
   `spiral-programs`). Losing them makes the program addresses unrecoverable.
2. **Fund the deployer.**

   ```bash
   solana config set --url devnet
   solana balance
   ```

   Top up with `solana airdrop` or the web faucet until the balance covers the rent of both
   programs (`solana rent <bytes of target/deploy/<p>.so>` per program) plus fees.

3. **Build once, then deploy that exact build.**

   ```bash
   anchor build
   anchor deploy -p organization --program-keypair keys/organization-keypair.json --provider.cluster devnet
   anchor deploy -p film --program-keypair keys/film-keypair.json --provider.cluster devnet
   solana program show 2JWb4r1LgykRNocsxVgfhysLtFtgjWvMRzceBDX79WCw --url devnet
   solana program show 6MK8C7frTETvrmM5dhN6jkUyXdxcMAfTjKkhG1Y7Pcbu --url devnet
   ```

   Expected: both `solana program show` calls print the program with
   `Owner: BPFLoaderUpgradeab1e11111111111111111111111`.

   **Keep this build.** Pre-flight (§5) checks the programs by their deployed bytecode, not by an
   on-chain IDL. For each program it requires:
   - the deployed ELF equals `spiral-programs/target/deploy/<p>.so`, byte for byte;
   - `spiral-programs/target/idl/<p>.json` equals `packages/protocol/src/idl/<p>.json` (the IDL
     the clients in this repo were generated from).

   Anchor builds are **not byte-reproducible across machines**, so a fresh `anchor build` on the
   orchestrator would not match what you deployed. Either deploy from the same build that
   pre-flight checks, or keep that build's `target/deploy/*.so` and `target/idl/*.json` and copy
   them to the campaign host (§3, step 4). **If you rebuild `spiral-programs` after deploying,
   the program check BLOCKS until you redeploy the new build or restore the old `target/`.**

4. **IDL metadata (deploy hygiene).** Anchor 1.x `anchor deploy` uploads the IDL to the Program
   Metadata program by default. If you deployed with `--no-idl`, initialize it once per program:

   ```bash
   anchor idl init -f target/idl/organization.json 2JWb4r1LgykRNocsxVgfhysLtFtgjWvMRzceBDX79WCw --provider.cluster devnet
   anchor idl init -f target/idl/film.json 6MK8C7frTETvrmM5dhN6jkUyXdxcMAfTjKkhG1Y7Pcbu --provider.cluster devnet
   ```

   After **any** redeploy, bring it in line with the new build:

   ```bash
   anchor idl upgrade -f target/idl/organization.json 2JWb4r1LgykRNocsxVgfhysLtFtgjWvMRzceBDX79WCw --provider.cluster devnet
   anchor idl upgrade -f target/idl/film.json 6MK8C7frTETvrmM5dhN6jkUyXdxcMAfTjKkhG1Y7Pcbu --provider.cluster devnet
   ```

   Pre-flight does not read this metadata; it only helps explorers and other tools decode the
   programs.

5. **Bootstrap fixtures (optional).** Create `keys/bootstrap-payer-keypair.json`, fund it, then
   run:

   ```bash
   SPIRAL_DEVNET_RPC=https://<dedicated devnet endpoint> npx tsx scripts/bootstrap-devnet.ts
   ```

   Expected last line: `Bootstrap complete.` `eval:h3` creates its own organizations on every
   run, so the campaign does not depend on these fixtures.

6. **Campaign payer.** One keypair pays for H3's fixtures and is the `--keypair` that pre-flight
   checks. Pre-flight requires at least 2 SOL by default, and every H3 run spends from it (five
   signers funded with 0.02 SOL each, two organizations, a film, fees). Fund it with **at least
   3 SOL**, so the final `--stage all` gate (§7) still passes after H3 has run. `keys/*.json` is
   gitignored in `spiral-programs`:

   ```bash
   solana-keygen new --no-bip39-passphrase -o keys/payer-keypair.json
   solana airdrop 2 "$(solana-keygen pubkey keys/payer-keypair.json)" --url devnet
   solana airdrop 1 "$(solana-keygen pubkey keys/payer-keypair.json)" --url devnet
   solana balance "$(solana-keygen pubkey keys/payer-keypair.json)" --url devnet
   ```

   It goes to the orchestrator in §3. If the airdrop is rate-limited, use the web faucet or
   `solana transfer` from the deployer.

**A dedicated Devnet RPC endpoint is required** (a provider account with an API key). The public
endpoint rate-limits the per-attempt registry reads of H2 and usually refuses the
`getProgramAccounts` call of H4. Use the same endpoint everywhere: `--rpc-url` on the workstation,
`SPIRAL_RPC_URL` and `topology.json` on the orchestrator. It contains a secret: never commit it.

## 2. Replica VPS

Procedure: [IPFS nodes runbook](ipfs-nodes-runbook.md).

1. **Create all four servers** (§0 table) with a fresh Ubuntu or Debian image and your
   workstation's SSH public key for `root`. Billing starts now.

   **Who runs what.** Administrative steps (packages, users, firewall, systemd, Docker install)
   run **as `root`** over `ssh root@<host>`. Everything else runs as the `spiral` operator account,
   which gets **no general sudo**: on the replicas its only sudo right is the narrow
   `NOPASSWD` rule for `systemctl start ipfs` / `systemctl stop ipfs`
   ([IPFS nodes runbook §6](ipfs-nodes-runbook.md#6-set-up-ssh-access-for-the-control-agent)).

2. **The `spiral` account, on all four servers**, as root. It authorizes your workstation's key,
   which every workstation → `spiral@…` step below (`scp`, tunnels, archive copies) uses:

   ```bash
   apt-get update && apt-get install -y sudo ufw python3 wget curl ca-certificates
   useradd -m -s /bin/bash spiral
   install -d -m 700 -o spiral -g spiral /home/spiral/.ssh
   echo "<contents of your workstation's ~/.ssh/id_ed25519.pub>" | tee -a /home/spiral/.ssh/authorized_keys >/dev/null
   chown spiral:spiral /home/spiral/.ssh/authorized_keys
   chmod 600 /home/spiral/.ssh/authorized_keys
   ```

   Debian images ship without `sudo` and `ufw`, hence the install. Check from the workstation:
   `ssh spiral@<host> true` must succeed for all four.

3. **The control key, on the orchestrator**, as `spiral` (the replicas authorize it in step 4):

   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/spiral-node-control -N ""
   cat ~/.ssh/spiral-node-control.pub
   ```

4. **On each replica**, as root, follow [IPFS nodes runbook](ipfs-nodes-runbook.md) §2–§6
   (the `spiral` account already exists from step 2; skip the runbook's commands that create it):
   - install Kubo **0.43.1** exactly (pre-flight rejects any other version). The tarball in the
     IPFS runbook is for x86-64; on an ARM server use the `linux-arm64` one;
   - create the `ipfs` service account;
   - run `infra/kubo/setup.sh` as `ipfs`, install `infra/kubo/ipfs.service`, start it;
   - firewall: swarm port 4001 open (TCP and UDP), API port 5001 on localhost only;
   - append the `spiral-node-control.pub` key to `/home/spiral/.ssh/authorized_keys`, and add the
     sudoers line restricted to `systemctl start ipfs` / `systemctl stop ipfs`.

   Check on the replica, as root:

   ```bash
   ipfs version --number
   sudo -u ipfs IPFS_PATH=/home/ipfs/.ipfs ipfs config Addresses.API
   sudo -u ipfs IPFS_PATH=/home/ipfs/.ipfs ipfs id -f '<id>\n'
   ```

   Expected: `0.43.1`, `/ip4/127.0.0.1/tcp/5001`, and the PeerID (`12D3KooW…`). Write each
   PeerID down with its node name (`a`, `b`, `c`).

5. **Back up each node's Kubo identity off the server, now.** The PeerID is declared on-chain at
   submit (§6) and can never be changed afterwards. If a server is lost and recreated without its
   identity, it gets a new PeerID and stops being a declared replica. Procedure:
   [IPFS nodes runbook §8](ipfs-nodes-runbook.md#8-back-up-and-restore-the-node-identity). Store
   the three `identity-<node>.json` files like the program keypairs: they contain private keys.

## 3. Orchestrator VPS

Background on the H2 orchestrator, executor and network node:
[the evaluation harness, H2](eval-harness.md#h2). Steps 1 and 2 run as root; everything from step 3 on runs as `spiral`.

1. **Software**, as root. Docker, Node 26 (the executor image is `node:26-slim`), git, tmux, and
   lingering for `spiral`'s user services:

   ```bash
   curl -fsSL https://get.docker.com | sh
   usermod -aG docker spiral
   curl -fsSL https://deb.nodesource.com/setup_26.x | bash -
   apt-get install -y nodejs git tmux
   loginctl enable-linger spiral
   ```

   Then, as `spiral` (log in again so the `docker` group applies): `docker run --rm hello-world`
   and `node --version` (`v26.…`). Membership of `docker` is root-equivalent on this host; it is
   the one privilege the harness needs.

2. **Firewall**, as root. Allow SSH and the network node's swarm port; nothing else:

   ```bash
   ufw allow 22/tcp
   ufw allow 4001/tcp
   ufw allow 4001/udp
   ufw enable
   ```

3. **Repositories, side by side** (pre-flight's `--programs-dir` defaults to `../spiral-programs`):

   ```bash
   cd ~
   git clone <spiral-backbone remote> spiral-backbone
   git clone <spiral-programs remote> spiral-programs
   cd ~/spiral-backbone
   npm ci
   docker build -t spiral-h2-executor:dev packages/eval/src/h2/executor
   ```

4. **The deployed build.** From the workstation, copy the `.so` and IDL files of the build you
   deployed in §1 into the orchestrator's `spiral-programs` checkout (never the keypairs):

   ```bash
   ssh spiral@<orchestrator-host> 'mkdir -p spiral-programs/target/deploy spiral-programs/target/idl'
   scp target/deploy/organization.so target/deploy/film.so spiral@<orchestrator-host>:spiral-programs/target/deploy/
   scp target/idl/organization.json target/idl/film.json spiral@<orchestrator-host>:spiral-programs/target/idl/
   ssh spiral@<orchestrator-host> 'mkdir -p -m 700 spiral-campaign'
   scp keys/payer-keypair.json spiral@<orchestrator-host>:spiral-campaign/
   ```

5. **Network node.** A Kubo 0.43.1 container on the public DHT, used by H2 and pre-flight for
   `ping` and `findprovs`. Its API is published on localhost only, and it **never holds content**:
   never `ipfs cat`, `get` or `add` through it, and never point H1's `--kubo-url` at it. Content in
   its cache could reach an executor and contaminate the zero-replica control.

   ```bash
   docker run -d --name spiral-network-node --restart unless-stopped \
     -e IPFS_PROFILE=server \
     -v spiral-network-node:/data/ipfs \
     -p 4001:4001 -p 4001:4001/udp \
     -p 127.0.0.1:15001:5001 \
     ipfs/kubo:v0.43.1
   curl -s -X POST http://127.0.0.1:15001/api/v0/version
   ```

   Expected: a JSON object with `"Version":"0.43.1"`. `IPFS_PROFILE=server` stops it from dialing
   private address ranges, which hosting providers treat as a network scan.

6. **Replica SSH and host keys.** The control scripts use `BatchMode=yes` and strict host key
   checking, so accept each replica's host key once:

   ```bash
   ssh -i ~/.ssh/spiral-node-control spiral@<node-a-host> ipfs version --number
   ssh -i ~/.ssh/spiral-node-control spiral@<node-b-host> ipfs version --number
   ssh -i ~/.ssh/spiral-node-control spiral@<node-c-host> ipfs version --number
   ```

   Answer `yes` to each host key prompt. Expected: `0.43.1` three times. Use exactly the host
   name (or address) that you will write in `ssh.host` of `topology.json` (step 7): the host key
   is stored under that name, and a different spelling of the same server is an unknown host to
   the control scripts.

7. **`topology.json`.** Keep it outside the repo, because its `rpc_url` holds the API key:

   ```bash
   cp packages/eval/campaigns/topology.example.json ~/spiral-campaign/topology.json
   chmod 600 ~/spiral-campaign/topology.json
   ```

   Edit `~/spiral-campaign/topology.json`:
   - `replicas[]`: names `a`, `b`, `c` (the names in `packages/eval/campaigns/h2-final.json`),
     the real PeerIDs from §2, and `ssh.host` per node. Keep `user: "spiral"`,
     `identity_file: "~/.ssh/spiral-node-control"` and `insecure_host_key_checking: false`.
   - `network_node`: `api_url: "http://127.0.0.1:15001"` (step 5) and
     `bootstrap_multiaddr: null` (the public DHT).
   - `gateway_url: "https://ipfs.io"`.
   - `rpc_url`: the dedicated Devnet endpoint (§1).
   - `executor.block_cidrs`: the workstation's public address as `<ip>/32` (run
     `curl -s https://ifconfig.me` on the workstation). If its address can change, block the
     whole range your ISP assigns.
   - `executor.repo_root: "/home/spiral/spiral-backbone"`; keep `image`, `docker_network: null`,
     `add_hosts: []` and `swarm_key_path: null`.

   **The topology `replicas` must equal the active replicas declared on every Film**, PeerID for
   PeerID. Otherwise H2 faults on its first attempt, and `--stage h2` pre-flight (§7) BLOCKS with
   `<work_id>: missing <peer>` or `<work_id>: extra <peer>`.

8. **Environment.** Each new shell that runs H1, H3 or H4 needs the RPC URL. Read it without
   echoing it into the shell history:

   ```bash
   read -rs SPIRAL_RPC_URL && export SPIRAL_RPC_URL
   ```

9. **Long commands.** Run everything that takes more than a few minutes (pre-flight, H1, H2, H4)
   inside `tmux`, so an SSH disconnect does not kill a multi-day run:

   ```bash
   tmux new -s campaign      # detach with Ctrl-b d
   tmux attach -t campaign   # reattach later
   ```

   For H2 only, a user service is an alternative (lingering was enabled in step 1). H2 reads its
   RPC URL from `topology.json`, so it needs no environment; do not use this for H1, H3 or H4,
   which would lose `SPIRAL_RPC_URL`:

   ```bash
   systemd-run --user --same-dir --unit=spiral-h2 npm run eval:h2 -- run --plan plans/h2-<run_id>.json --topology ~/spiral-campaign/topology.json --out results/h2.ndjson
   journalctl --user -u spiral-h2 -f
   ```

**Do not run test or dry-run commands into the campaign's `results/`.** The report shows the
latest run per hypothesis, and H2 dry runs would append to `results/h2.ndjson`. Use another
`--out` (or another checkout) for anything that is not the campaign.

## 4. Dataset

On the workstation, following `dataset/README.md`:

1. Replace the placeholders in `dataset/manifest.json` with the 20 real works: 7 small, 8 medium,
   5 large, exactly 5 with `"cold_cid": true`, each with its public-domain basis.
2. Download every file into `dataset/files/` and run:

   ```bash
   npm run validate:manifest -- --final
   ```

   Expected: `Manifest valid (final).` with no `not downloaded` notes. Any error names the work
   and the field; fix it and run again.

3. Commit the manifest and pull it on the orchestrator (`git pull` in `~/spiral-backbone`), or
   copy it there with `scp`. The orchestrator does not need the media files: without them
   pre-flight reports `20 files not verified` on the manifest row, which is expected because you
   verified them here.

This step comes before the infra pre-flight because that stage already checks the manifest with
`--final`.

## 5. Pre-flight: infrastructure

On the orchestrator:

```bash
npm run campaign:preflight -- --stage infra --topology ~/spiral-campaign/topology.json --keypair ~/spiral-campaign/payer-keypair.json
```

Every check runs, even after a failure, and prints one row of
`| stage | check | status | detail |`. The last line is `Pre-flight: READY` (exit 0) or
`Pre-flight: BLOCKED (N of M checks failed)` (exit 1). The chunking conformance row runs the
chunking conformance test (`packages/eval/src/conformance.test.ts`) in Docker (a 400 MiB synthetic file), so the command takes a few minutes.

| Check                  | OK detail                                                         | When BLOCKED                                                                                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rpc genesis`          | `genesis EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`            | `rpc_url` is not Devnet, or unreachable: fix `topology.json`.                                                                                                                                                  |
| `program organization` | `organization: deployed bytecode = local build <sha8>, protocol…` | Not deployed, closed, or bytecode differs from `target/deploy/organization.so`: copy the deployed build's files (§3 step 4) or redeploy (§1). A differing build IDL means this repo's clients do not match it. |
| `program film`         | same, for `film`                                                  | Same as above.                                                                                                                                                                                                 |
| `payer balance`        | `payer balance X SOL (minimum 2 SOL)`                             | Fund the payer (§1 step 6).                                                                                                                                                                                    |
| `manifest (--final)`   | `20 works, 5 cold, …`                                             | Finish §4.                                                                                                                                                                                                     |
| `chunking conformance` | the vitest `Tests … passed` line                                  | Docker is not usable by `spiral`, or Kubo's chunking diverged: stop, nothing else is trustworthy.                                                                                                              |
| `replica a/b/c`        | `active, swarm reachable, Kubo 0.43.1`                            | Service down, port 4001 closed, wrong Kubo version, or SSH refused (key, sudoers, host key; §2 and §3 step 6).                                                                                                 |
| `network node`         | `API alive, 3 of 3 replicas answer ping`                          | Container down, wrong `api_url`, or a replica PeerID in `topology.json` is wrong.                                                                                                                              |
| `gateway`              | `GET /ipfs/bafkqaaa → 200`                                        | `gateway_url` unreachable from the orchestrator.                                                                                                                                                               |
| `executor image`       | `spiral-h2-executor:dev present`                                  | Build it (§3 step 3).                                                                                                                                                                                          |

Fix every BLOCKED row and run the command again until it prints `Pre-flight: READY`.

Flags worth knowing (`npm run campaign:preflight -- --help` lists them all):

- `--programs-dir <dir>` is the **`spiral-programs` checkout** (the command appends
  `target/deploy` and `target/idl` itself), not its `target/` directory. The default,
  `../spiral-programs`, is right for the layout of §3.
- `--min-balance-sol`, `--ping-timeout-ms`, `--manifest`, `--files-dir`, `--campaign` and
  `--expected-genesis` keep their defaults in the campaign.
- **Never pass `--skip-conformance` in a campaign.** It exists only for the end-to-end tests:
  it reports the conformance row as BLOCKED (`skipped by flag`), so the verdict can never be
  READY with it.

The RPC URL, the topology contents and the keypair never appear in the output; replica hosts may,
as operator diagnostics.

## 6. Submit the 20 works

On the workstation, with all three replicas running:

1. **Tunnels** to each node's API ([IPFS nodes runbook §5](ipfs-nodes-runbook.md#5-firewall)),
   one local port per node:

   ```bash
   ssh -f -N -L 5101:127.0.0.1:5001 spiral@<node-a-host>
   ssh -f -N -L 5102:127.0.0.1:5001 spiral@<node-b-host>
   ssh -f -N -L 5103:127.0.0.1:5001 spiral@<node-c-host>
   read -rs SPIRAL_RPC_URL && export SPIRAL_RPC_URL
   ```

2. **Organization**, once:

   ```bash
   npm run spiral -- org create --slug spiral-campaign --name "Spiral Campaign" --cluster devnet --rpc-url "$SPIRAL_RPC_URL"
   ```

   Expected: `Organization "spiral-campaign" created at <pda>.` and a `Transaction:` line.

3. **Submit every work.** Use `--silent` in this exact position: without it npm prints its
   `> spiral` banner to stdout, and those lines would land in the golden file and break it.

   ```bash
   mkdir -p results
   npm run spiral --silent -- submit --org spiral-campaign --work-id <work_id> \
     --file dataset/files/<file_name> --title "<title>" \
     --replicas http://127.0.0.1:5101,http://127.0.0.1:5102,http://127.0.0.1:5103 \
     --cluster devnet --rpc-url "$SPIRAL_RPC_URL" \
     >> results/inventory-golden.ndjson
   ```

   Run it once per manifest entry (`work_id`, `file_name` and `title` from
   `dataset/manifest.json`). Each successful run appends exactly one JSON line. Check the result:

   ```bash
   wc -l results/inventory-golden.ndjson
   ```

   Expected: `20 results/inventory-golden.ndjson`. If one submit fails after `register_film`, read "Partial submit" in
   [the evaluation harness](eval-harness.md#the-golden-inventory) before retrying.

4. **Copy the golden to the orchestrator:**

   ```bash
   ssh spiral@<orchestrator-host> 'mkdir -p spiral-backbone/results'
   scp results/inventory-golden.ndjson spiral@<orchestrator-host>:spiral-backbone/results/
   ```

5. **Take the submission machine out of the campaign.** It still holds the content it just
   uploaded; if it stayed reachable it could serve that content to the H2 executors, and the
   results would no longer measure retrieval from the declared replicas alone. Close the tunnels
   (`pkill -f 'ssh -f -N -L 510'`). If the workstation runs any Kubo node, unpin the 20 CIDs, clear
   its cache and stop it for the whole campaign:

   ```bash
   ipfs pin rm <cid>          # for every cid in results/inventory-golden.ndjson
   ipfs repo gc
   ipfs shutdown
   ```

   The executors also reject the workstation's address (`block_cidrs`, §3 step 7).

## 7. Pre-flight: H2

On the orchestrator:

```bash
npm run campaign:preflight -- --stage h2 --topology ~/spiral-campaign/topology.json --keypair ~/spiral-campaign/payer-keypair.json --golden results/inventory-golden.ndjson
```

| Check                       | OK detail                                                            | When BLOCKED                                                                                                                                                                        |
| --------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `golden ↔ manifest`         | `20 works match, 5 cold`                                             | The golden and the manifest on the orchestrator disagree: copy the final ones (§4, §6).                                                                                             |
| `Films ↔ golden ↔ topology` | `20 Films: CID matches golden, active replicas = 3 topology PeerIDs` | `missing`/`extra` PeerIDs: `topology.json` does not list exactly the replicas declared on-chain. `Film unreadable`: RPC problem (read with retries) or the golden points elsewhere. |
| `campaign plan`             | `370 attempts in 6 blocks over 20 works`                             | `packages/eval/campaigns/h2-final.json` or the golden is invalid, or a campaign replica name is not in the topology.                                                                |

Right before starting H2 (§9), run both stages together as the final gate. H3 (§8) has spent from
the payer by then; if its balance is below the 2 SOL minimum, top it up first (from the
workstation: `solana airdrop 1 "$(solana-keygen pubkey keys/payer-keypair.json)" --url devnet` in `spiral-programs`, the web faucet, or
`solana transfer` from the deployer), otherwise the `payer balance` row BLOCKS:

```bash
npm run campaign:preflight -- --stage all --topology ~/spiral-campaign/topology.json --keypair ~/spiral-campaign/payer-keypair.json --golden results/inventory-golden.ndjson
```

## 8. H1 and H3

On the orchestrator, with `SPIRAL_RPC_URL` exported (§3 step 8).

**H1** retrieves through a Kubo RPC URL. Use a tunnel to a replica, which already holds the
content; never the network node and never a public gateway:

```bash
ssh -f -N -L 5001:127.0.0.1:5001 -i ~/.ssh/spiral-node-control spiral@<node-a-host>
npm run eval:h1 -- --golden results/inventory-golden.ndjson --kubo-url http://127.0.0.1:5001 --label campaign
pkill -f 'ssh -f -N -L 5001'
```

Expected: one JSON summary line with the `run_id`, exit 0, and `results/h1.ndjson` with 20 intact
and 20 tampered records. Exit 1 means a harness fault (bad golden, local I/O error, RPC 4xx): fix
the cause and run it again; the report shows the latest run.

**H3** needs a fresh label per run; omit `--label` and the default timestamp label is fresh:

```bash
npm run eval:h3 -- --keypair ~/spiral-campaign/payer-keypair.json
```

Expected: a JSON summary line and 7 records in `results/h3.ndjson`. "already in use" means a
reused `--label`.

## 9. H2

Details in [the evaluation harness, H2](eval-harness.md#h2). On the orchestrator, inside `tmux`.

1. **Freeze the plan**, once:

   ```bash
   npm run eval:h2 -- plan --campaign packages/eval/campaigns/h2-final.json --golden results/inventory-golden.ndjson --label campaign
   ```

   Expected: `{"run_id":"<run_id>","plan":"plans/h2-<run_id>.json","attempts":370}`. Note the
   `run_id`. The plan file is never overwritten; do not edit it.

2. **Estimate the duration** before you commit to the hourly bill:

   ```bash
   node -e '
   const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
   const attempts = p.blocks.flatMap((b) => b.attempts);
   const hours = (ms) => `${(ms / 3_600_000).toFixed(1)} h`;
   const gate = p.blocks.length * p.campaign.stabilization_ms;
   console.log(`attempts: ${attempts.length}`);
   console.log(`attempt timeouts, summed: ${hours(attempts.reduce((sum, a) => sum + a.timeout_ms, 0))}`);
   console.log(`gate stabilization, one gate per block: ${hours(gate)}; worst case: ${hours(gate * p.campaign.max_gate_attempts)}`);
   ' plans/h2-<run_id>.json
   ```

   The summed timeouts are the ceiling when every attempt times out; real attempts finish when
   the content is verified. Add the per-attempt container overhead (a fresh Kubo repo and daemon
   per attempt), and up to `max_block_generations` re-runs of any block whose replica state
   drifts.

3. **Run:**

   ```bash
   npm run eval:h2 -- run --plan plans/h2-<run_id>.json --topology ~/spiral-campaign/topology.json --out results/h2.ndjson
   ```

   Expected at the end: one JSON line with the `run_id` and exit 0. Progress is visible in
   `results/h2-blocks.ndjson` (gate and end checks) and `results/h2.ndjson` (one line per
   attempt). Every replica is turned back on after the last block.

4. **Resume** after any fault or interruption, with the **same `--out`**:

   ```bash
   npm run eval:h2 -- run --resume <run_id> --topology ~/spiral-campaign/topology.json --out results/h2.ndjson
   ```

   A different `--out` starts from scratch in the new file. **Never run two `eval:h2 run`
   processes at once**: nothing locks the artifacts.

5. **If the run faults** (exit 1, `H2 run failed: …`), read the message first:

   | Fault                                                                               | Fix, then resume                                                                                                                                                                                                                        |
   | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Registry read (RPC HTTP error, missing Film account)                                | Registry reads are already retried on 429, 5xx and network errors (1 s, 2 s, 4 s); any other registry error faults at once. Check the endpoint, its quota and its API key.                                                              |
   | `declared_replicas` differs from the topology, or `cid_expected`/`film_pda` differs | `topology.json` or `rpc_url` does not match the chain the golden was made on. Fix the configuration, re-run pre-flight `--stage h2`.                                                                                                    |
   | SSH failure, unanswerable probe, a gate that never confirms                         | A node is down or unreachable. Check it with `systemctl status ipfs`. If the server is lost, recreate it and restore its identity and content ([IPFS nodes runbook §8](ipfs-nodes-runbook.md#8-back-up-and-restore-the-node-identity)). |
   | A block exceeded `max_block_generations`                                            | The replica state keeps drifting during the block. Find out why (DHT provider records, flapping node) before resuming.                                                                                                                  |
   | Executor exit 2 (classify by its tail, below), exit 3, inconsistent artifacts       | Exit 3 or inconsistent artifacts: a harness bug or tampered artifacts; stop and investigate, do not resume blindly.                                                                                                                     |

   An executor fault reads `executor for <attempt_id> failed: … executor fault: <tail>`; classify
   it by the tail. A tail from the registry read after its retries ran out — `HTTP error (429): …`,
   `HTTP error (5xx): …`, `fetch failed` or `The operation was aborted due to timeout` (or the
   coded form `Solana error #8100002` for an HTTP error) — means the RPC was unavailable: wait
   until the endpoint recovers, then resume. `Account not found at address: …` or another
   `HTTP error (4xx)` is a configuration problem (row 2 above, or the endpoint's key). Any other
   tail is a harness bug: stop and investigate.

   A fault leaves the replicas in the failing block's state; resume re-applies it. Nothing is
   recorded for a faulted attempt.

## 10. Daily archive

At the end of every campaign day, on the orchestrator (it does not interrupt a running H2):

```bash
npm run campaign:archive-day
```

Expected: `{"dir":"archive/<date>","files":N}`. It snapshots all of `results/` and `plans/` into
`archive/<date>/` with a `manifest.json` of sha256 checksums. `<date>` is today's UTC date (pass
`--date YYYY-MM-DD` to choose it). It refuses to overwrite an existing date
(`archive archive/<date> already exists`), so take one snapshot per date; the next day's snapshot
is again complete. A snapshot taken while H2 is running may end with a partial last NDJSON line;
it still verifies and the next day's snapshot supersedes it, but archiving between blocks is
preferable.

Then copy it **off the orchestrator, keeping the directory name**, and verify the copy:

```bash
mkdir -p ~/spiral-archive
scp -r spiral@<orchestrator-host>:spiral-backbone/archive/<date> ~/spiral-archive/
npm run campaign:archive-day -- --verify ~/spiral-archive/<date>
```

Expected: `Archive verified: …` (exit 0). `--verify` requires the directory's name to equal the
manifest's date, so never rename the copy; it also reports any missing, changed or extra file,
and any symlink.

## 11. H4

Background: [the evaluation harness, H4](eval-harness.md#h4) and [the indexer](indexer.md). H4
drops and rebuilds the target database, so give it a throwaway Postgres on the orchestrator:

```bash
docker run -d --rm --name spiral-h4-postgres -e POSTGRES_PASSWORD=h4 -p 127.0.0.1:55432:5432 postgres:18
npm run eval:h4 -- --golden results/inventory-golden.ndjson --database-url postgres://postgres:h4@127.0.0.1:55432/postgres --label campaign
docker stop spiral-h4-postgres
```

Wait a few seconds after `docker run` for Postgres to accept connections. Expected: a JSON
summary line and exit 0. Exit 1 with `infrastructure_failure: true` in `results/h4.run.json`
(database or RPC problem) writes no records: fix and run it again. With
`infrastructure_failure: false` the chain could not be rebuilt: that is an H4 refutation, not a
harness problem.

## 12. Report

On the orchestrator:

```bash
npm run eval:report -- --plans-dir plans
```

Expected: `{"markdown":"results/report/report.md","csv":[…]}`. It shows the latest run per
hypothesis and needs the frozen H2 plan in `--plans-dir`
(`frozen plan … not found — pass --plans-dir` otherwise). Every section has a `Status:` line;
anything other than `complete (…)` means that run did not finish. Review `results/report/report.md`
against the acceptance criteria of each hypothesis:

- **H1:** 20 of 20 intact works match the on-chain CID, and every tampered copy is flagged.
- **H2:**
  - **Acceptance line**, right after `Attempts included: X of Y planned (…)`:
    `**Success with N active replicas: X% (S of D, excluding E external_cache) — criterion ≥ 95%: met**`.
    N is the highest active replica count of the frozen plan (3). It combines both methods and
    every block with N active replicas, counting only valid generations; `external_cache` is
    outside D. `met` passes the criterion; `NOT met` fails it; `no data` (D = 0, or
    `no valid attempts`) means there is nothing to judge, so the campaign has to be repeated.
  - **`### By active replicas`** (`h2-by-replicas.csv`): one row per active replica count ×
    method. The row with 1 active replica checks operational recovery with a single replica: it
    must show direct successes.
  - **No refutation line.** `**Direct success with zero active replicas: N** — this refutes H2.`
    must not appear.
  - **Contaminated control.** If
    `**Zero-replica control contaminated: N direct recoveries from undeclared sources**` appears,
    H2 is not refuted, but something outside the registry served the content with every replica
    off. Discuss it in the analysis, with the evidence `peers` rows of those attempts.
  - **`### Direct provenance audit`**: the distribution of `unattributed_bytes` and
    `unattributed_pct_of_dag` over the direct successes. Values near zero mean the bitswap ledgers
    explain every byte; large positive values deserve a manual look at those attempts' evidence
    before trusting the success rate. A bold
    `**Direct successes without provenance evidence: N**` line is an artifact inconsistency:
    investigate it before using the H2 numbers.
  - Excluded attempts (unconfirmed or missing end checks) are counted on their own lines; they
    never enter the rates.
- **H3:** seven rows, each refused on-chain with its code: 3012, 6001, 6002, 6003, 6004, 0 and 3007.
- **H4:** zero divergences (`No field divergences.`).

## 13. Teardown

1. Run a final `npm run campaign:archive-day`, copy it off and verify it (§10). If today's date
   is already archived, write the final snapshot under another root, which keeps the date as the
   directory name: `npm run campaign:archive-day -- --archive archive-final`, then copy and verify
   `archive-final/<date>`.
2. Back up off the servers: the three node identities (§2), `results/`, `plans/` and `archive/`
   from the orchestrator, and the frozen `topology.json` with its `rpc_url` removed.
3. **Delete** all four servers in each provider's console. Powering them off does not stop the
   bill.
4. Open each provider's billing page and check that no server, volume, snapshot, backup or
   reserved IPv4 address is still running or reserved.

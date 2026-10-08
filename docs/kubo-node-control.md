# Kubo node setup and remote control

The automation that turns provisioning the three real Kubo nodes into a
command instead of a manual procedure. For the actual step-by-step VPS
provisioning instructions, see
[`docs/ipfs-nodes-runbook.md`](ipfs-nodes-runbook.md) — this document
explains how the underlying code works.

## Setup (`infra/kubo/setup.sh`, `infra/kubo/ipfs.service`)

`setup.sh` is idempotent POSIX `sh` (not bash — the official `ipfs/kubo`
Docker image this is tested against, and some minimal VPS base images,
don't ship bash): it runs `ipfs init --profile server --algorithm ed25519`
only if `$IPFS_PATH/config` doesn't already exist, then unconditionally
re-applies five `ipfs config --json` calls (`Routing.Type=dhtserver` +
`AcceleratedDHTClient` to keep DHT provider records fresh, `Provide.Strategy=pinned`
with `Provide.DHT.Interval` so only pinned content gets reannounced, `Reprovider=null`
because Kubo 0.43.1 refuses to start with the deprecated key, `Swarm.ConnMgr` bounds, and
`Datastore.GCPeriod="0"` so GC never runs mid-campaign) — safe to run twice
because `ipfs config` writes are naturally idempotent.

`ipfs.service` runs the daemon as a dedicated `ipfs` system user under
systemd (`Type=simple`, `--enable-gc=false` matching the config above).

Both are tested against a real `ipfs/kubo:v0.43.1` container in
`scripts/kubo-setup.test.ts` — the script is run twice inside one container
and the final `ipfs config show` output is asserted against, proving
idempotency for real rather than by inspection. The setup test also starts
the daemon, because a config that only parses is not proof the node runs.

## Control agent (`scripts/kubo-node-control.ts`)

The exact surface the remote H2 degradation-test orchestrator
(`packages/eval/src/h2/`) drives: `startService`/`shutdownService`/`checkStatus`, all taking an
`SshTarget` (`host`, `port`, `user`, `identityFile`).

Every command runs over SSH with `BatchMode=yes` (fail immediately on
rejected key auth instead of hanging on a password prompt) and a 15s
timeout (`ConnectTimeout` only bounds the initial TCP/banner phase, not a
connection that hangs after that). Host-key verification is **on** by
default — `SshTarget.insecureHostKeyChecking` exists only so ephemeral
test containers with a freshly-generated key and no stable identity can
opt out; real usage against real nodes must never set it.

`checkStatus` reports `{ systemdActive, swarmReachable }` — a double check:
`systemctl is-active` on the host (no `sudo` needed for a read-only status
query), plus an independent TCP probe against the swarm port. The probe isn't a bare `connect`: it waits a 300ms grace
window for an unsolicited close, because a bare handshake can be completed
by a port-forwarding layer (notably Docker's own published-port proxy, which
this module's own test runs through) before it's confirmed anything is
actually listening behind it. A real listener holds the connection open
instead.

## Test fixture (`scripts/fixtures/kubo-node-control-test/`)

The end-to-end test builds **one** Docker container (not two) — the test
process itself plays the "control machine" role by running the SSH client
directly, which exercises the exact same control-agent code a real
orchestrator would use. The container runs real systemd as PID 1
(`--privileged --cgroupns=host` plus a mounted cgroupfs — the standard,
documented way to run systemd inside Docker) with a stand-in service in
place of a real Kubo daemon, since this test is about the control mechanism,
not Kubo itself.

The stand-in (`ncat -lk 9000 --sh-exec "/bin/cat"`) exists because a plain
`ncat -lk 9000` reads its own stdin — which systemd defaults to `/dev/null` —
and closes the connection within milliseconds regardless of whether the
service is meant to be "up," making it indistinguishable from the
port-forwarding false-positive `checkSwarmReachable`'s grace window exists
to catch. Routing each connection through a per-connection `cat` process
keeps it genuinely open, so the test can actually tell "up" apart from
"down."

The fixture image also copies the real `ipfs` binary from
`ipfs/kubo:v0.43.1` (not run as a service), so `remoteKuboVersion` — which
runs `ipfs version --number` over the same SSH path and is what the
campaign pre-flight `replica <name>` check compares against `0.43.1` — is
tested against an actual Kubo build.

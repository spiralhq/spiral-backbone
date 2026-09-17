#!/bin/sh
# POSIX sh, not bash: the official ipfs/kubo Docker image and some minimal VPS images don't ship bash.
set -eu

: "${IPFS_PATH:=$HOME/.ipfs}"

if [ ! -f "$IPFS_PATH/config" ]; then
  ipfs init --profile server --algorithm ed25519
fi

ipfs config --json Routing '{"Type":"dhtserver","AcceleratedDHTClient":true}'
ipfs config --json Reprovider '{"Strategy":"pinned","Interval":"12h"}'
ipfs config --json Swarm.ConnMgr '{"Type":"basic","LowWater":200,"HighWater":600}'
ipfs config --json Datastore.GCPeriod '"0"'

echo "Spiral Kubo node setup complete."

#!/bin/sh
set -eu
for cidr in ${SPIRAL_BLOCK_CIDRS:-}; do
  iptables -A OUTPUT -d "$cidr" -j REJECT
done
export IPFS_PATH=/tmp/ipfs-repo
exec /app/node_modules/.bin/tsx /app/packages/eval/src/h2/executor/main.ts

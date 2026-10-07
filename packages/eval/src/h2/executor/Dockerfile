FROM ipfs/kubo:v0.43.1 AS kubo
FROM node:26-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends iptables ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=kubo /usr/local/bin/ipfs /usr/local/bin/ipfs
COPY entrypoint.sh /usr/local/bin/spiral-executor
RUN chmod +x /usr/local/bin/spiral-executor
WORKDIR /app
ENTRYPOINT ["/usr/local/bin/spiral-executor"]

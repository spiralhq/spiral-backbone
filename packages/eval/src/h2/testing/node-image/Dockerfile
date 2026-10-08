FROM ipfs/kubo:v0.43.1 AS kubo
FROM ubuntu:24.04
RUN apt-get update \
  && apt-get install -y systemd systemd-sysv openssh-server sudo ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=kubo /usr/local/bin/ipfs /usr/local/bin/ipfs
RUN useradd -m -s /bin/sh ipfs \
  && useradd -m -s /bin/bash spiral \
  && echo "spiral ALL=(ALL) NOPASSWD: /usr/bin/systemctl --no-block start ipfs, /usr/bin/systemctl --no-block stop ipfs" > /etc/sudoers.d/spiral \
  && chmod 440 /etc/sudoers.d/spiral \
  && mkdir -p /run/sshd /home/spiral/.ssh /etc/systemd/system/ipfs.service.d \
  && chmod 700 /home/spiral/.ssh
RUN chown -R spiral:spiral /home/spiral/.ssh
COPY setup.sh /usr/local/bin/spiral-kubo-setup
COPY ipfs.service /etc/systemd/system/ipfs.service
COPY pnet.conf /etc/systemd/system/ipfs.service.d/pnet.conf
RUN chmod +x /usr/local/bin/spiral-kubo-setup && systemctl enable ssh
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]

FROM ubuntu:24.04

RUN apt-get update \
  && apt-get install -y systemd systemd-sysv openssh-server ncat sudo \
  && rm -rf /var/lib/apt/lists/*

COPY --from=ipfs/kubo:v0.43.1 /usr/local/bin/ipfs /usr/local/bin/ipfs

RUN mkdir -p /run/sshd \
  && useradd -m -s /bin/bash spiral \
  && echo "spiral ALL=(ALL) NOPASSWD: /usr/bin/systemctl" > /etc/sudoers.d/spiral \
  && mkdir -p /home/spiral/.ssh \
  && chmod 700 /home/spiral/.ssh

COPY authorized_keys /home/spiral/.ssh/authorized_keys
RUN chown -R spiral:spiral /home/spiral/.ssh \
  && chmod 600 /home/spiral/.ssh/authorized_keys

COPY stand-in.service /etc/systemd/system/stand-in.service
RUN systemctl enable ssh stand-in

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]

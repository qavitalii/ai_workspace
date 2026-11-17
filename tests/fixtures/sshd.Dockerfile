# Disposable SSH target used only by tests/ssh-docker.test.ts.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server \
    && rm -rf /var/lib/apt/lists/* /etc/ssh/ssh_host_* \
    && useradd -m -s /bin/sh tester && usermod -p '*' tester
CMD ["sh", "-c", "mkdir -p /run/sshd; ssh-keygen -A; exec /usr/sbin/sshd -D -e -p 2222 -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o AuthorizedKeysFile=/tmp/authorized_keys -o StrictModes=no"]

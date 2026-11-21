# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS dependencies
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY public ./public
COPY ops/build.mjs ./ops/build.mjs
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS aws
ARG AWS_CLI_VERSION=2.39.3
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates && rm -rf /var/lib/apt/lists/*
RUN set -eu; case "$(dpkg --print-architecture)" in amd64) arch=x86_64 ;; arm64) arch=aarch64 ;; *) exit 1 ;; esac; \
    curl --fail --silent --show-error --location --retry 3 "https://awscli.amazonaws.com/awscli-exe-linux-${arch}-${AWS_CLI_VERSION}.zip" -o /tmp/aws.zip; \
    unzip -q /tmp/aws.zip -d /tmp; /tmp/aws/install; rm -rf /tmp/aws /tmp/aws.zip

FROM node:22-bookworm-slim AS server
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/dist ./dist
COPY package.json ./
COPY ops/skill-zip.py ./ops/skill-zip.py
COPY --from=aws /usr/local/aws-cli /usr/local/aws-cli
RUN ln -s /usr/local/aws-cli/v2/current/bin/aws /usr/local/bin/aws
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node","dist/node/server/main.js"]

FROM node:22-bookworm-slim AS runner
ARG CODEX_VERSION=0.169.0
ARG CLAUDE_VERSION=2.1.325
RUN apt-get update && apt-get install -y --no-install-recommends \
    git openssh-client python3 python3-pip curl ca-certificates ripgrep jq unzip procps bubblewrap util-linux \
    build-essential pkg-config sqlite3 postgresql-client default-mysql-client rsync zip xz-utils file less tree \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g @openai/codex@${CODEX_VERSION} @anthropic-ai/claude-code@${CLAUDE_VERSION} && npm cache clean --force
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/dist/node ./dist/node
COPY package.json ./
COPY --from=aws /usr/local/aws-cli /usr/local/aws-cli
RUN ln -s /usr/local/aws-cli/v2/current/bin/aws /usr/local/bin/aws
COPY --chmod=755 ops/git-askpass.sh /usr/local/bin/workspace-git-askpass
COPY --chmod=755 ops/workspace-package-runner.sh /usr/local/bin/workspace-package-runner
COPY --chmod=755 ops/workspace-install.sh /usr/local/bin/workspace-install
COPY --chmod=644 ops/workspace-project-path.sh /etc/profile.d/workspace-project-path.sh
COPY ops/workspace-apt.conf /etc/workspace-install/apt.conf
COPY ops/workspace-install-sandbox.c /tmp/workspace-install-sandbox.c
RUN install -d -m 0755 /usr/local/lib/workspace-install /run/workspace-packages /etc/workspace-install/empty \
    && install -d -m 0710 -g "$(id -g _apt)" /var/lib/workspace-install \
    && install -d -m 1770 -g "$(id -g _apt)" /var/lib/workspace-install/tmp \
    && sed 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources > /etc/workspace-install/debian.sources \
    && cc -std=c11 -O2 -Wall -Wextra -Werror -o /usr/local/lib/workspace-install/sandbox /tmp/workspace-install-sandbox.c \
    && rm /tmp/workspace-install-sandbox.c \
    && printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d && chmod 0755 /usr/sbin/policy-rc.d
RUN mkdir -p /profile /workspace && chown node:node /profile /workspace
RUN mkdir -p /run/workspace-ssh /private && chown node:node /run/workspace-ssh /private && chmod 700 /run/workspace-ssh /private \
    && printf 'Include /run/workspace-ssh/config\n' > /etc/ssh/ssh_config.d/00-workspace.conf
ENV HOME=/profile CODEX_HOME=/profile/.codex CLAUDE_CONFIG_DIR=/profile/.claude
LABEL ai.workspace.runner.package-installer="1"
USER node
WORKDIR /workspace
CMD ["node","/app/dist/node/runner/main.js"]

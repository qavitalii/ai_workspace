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

FROM node:22-bookworm-slim AS server
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/dist ./dist
COPY package.json ./
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node","dist/node/server/main.js"]

FROM node:22-bookworm-slim AS runner
ARG CODEX_VERSION=0.169.0
ARG CLAUDE_VERSION=2.1.325
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client python3 python3-pip curl ca-certificates ripgrep jq unzip procps bubblewrap && rm -rf /var/lib/apt/lists/*
RUN npm install -g @openai/codex@${CODEX_VERSION} @anthropic-ai/claude-code@${CLAUDE_VERSION} && npm cache clean --force
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/dist/node ./dist/node
COPY package.json ./
COPY --chmod=755 ops/git-askpass.sh /usr/local/bin/workspace-git-askpass
RUN mkdir -p /profile /workspace && chown node:node /profile /workspace
RUN mkdir -p /run/workspace-ssh /private && chown node:node /run/workspace-ssh /private && chmod 700 /run/workspace-ssh /private \
    && printf 'Include /run/workspace-ssh/config\n' > /etc/ssh/ssh_config.d/00-workspace.conf
ENV HOME=/profile CODEX_HOME=/profile/.codex CLAUDE_CONFIG_DIR=/profile/.claude
USER node
WORKDIR /workspace
CMD ["node","/app/dist/node/runner/main.js"]

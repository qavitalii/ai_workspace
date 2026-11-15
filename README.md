# AI Workspace

A private, self-hosted web workspace for **Codex** and **Claude Code**. Work with agents from your computer or phone: persistent chats, attachments, GitHub projects, isolated containers, diffs, a terminal, and permission prompts. Closing your browser does not stop an agent.

> **Status: initial release for local validation.** The application, Docker deployment, and automated tests can run now. Real subscription sign-in, model execution, and switching between your own accounts require verification with your accounts before unattended production use. Automatic account switching is disabled by default.

## Run locally — three commands

Install Git, Python 3 and OpenSSL, and start Docker Desktop (macOS or Windows with WSL2), or Docker Engine with Compose v2.24.4+ (Linux). Python is used by backup restoration. Allocate approximately 8 GB RAM to Docker for three simultaneous agents; project builds may need more.

```bash
git clone https://github.com/qavitalii/ai_workspace.git
cd ai_workspace
./ops/install.sh --local
```

The installer builds the images, creates the database, asks for your **owner password**, displays a **TOTP QR code**, and starts the application at **[http://localhost:8080](http://localhost:8080)**. Add the QR code to your authenticator before closing the terminal. The first build requires internet access and can take several minutes.

Local access is bound to this computer only. Your computer and Docker must remain running. Use a VPS for continuous operation independently of your laptop.

## Deploy to a VPS — three commands

Supported starting point: Ubuntu 24.04 or Debian 12, Git installed, root access through `sudo`, a domain pointing to the server, and inbound **TCP ports 80 and 443** open. Suggested starting resources: 4 vCPU, 8 GB RAM, and 40+ GB free disk, depending on your workloads.

```bash
git clone https://github.com/qavitalii/ai_workspace.git
cd ai_workspace
sudo ./ops/install.sh --server
```

If Docker is missing, the installer installs it using Docker's official installer. Enter your domain without `https://`, choose a password, and save the TOTP QR code. Caddy obtains and renews the HTTPS certificate. A root installation also schedules daily encrypted backups.

**[Detailed deployment guide →](docs/deployment.md)** — prerequisites, DNS, Docker Desktop, installation, updates, backups, recovery, and troubleshooting.

## First use

1. Sign in with your password and a six-digit authenticator code.
2. Open **Settings → GitHub**. For private repositories, add a fine-grained personal access token limited to the repositories you need: **Contents: Read and write**, **Pull requests: Read and write**. Public repositories can be read without a token.
3. Connect a GitHub project using `owner/repository`.
4. Open **Agent accounts**, add an account, and select **Connect**. For Codex, follow the official link and enter the device code. For Claude Code, follow the official CLI sign-in instructions.
5. Create a chat, select the project and a connected account, and describe a task. Attach files, drop them onto the composer, or paste an image.
6. Review files and diffs. Commit, push, and pull requests are separate actions. Open the terminal when the agent is idle.

The default permission mode asks before actions that require approval. Autonomous mode allows the agent to act inside its isolated workspace without those prompts. Each chat has its own checkout and branch.

## Features and boundaries

- One owner, multiple personal accounts, up to three active jobs, and one active run per account.
- Streaming responses and persisted event replay after reconnecting.
- File and image attachments: 10 files per message, 25 MB each by default. Archives are never extracted automatically.
- Supported images are passed as image input; other files are available in the workspace. Reading arbitrary formats depends on the tools installed in the runner.
- Each chat gets an independent checkout and a `workspace/<id>` branch.
- Switching accounts within one provider preserves files and visible history. It creates a **new native session with a context checkpoint**, rather than claiming to preserve identical hidden model state.
- Server failures mark active jobs as interrupted. Resume only after reviewing existing changes and external operations; publishing is never blindly retried.
- Web Push requires browser permission. On iPhone/iPad, use HTTPS and install the web app on the Home Screen.
- A server running 24/7 does not remove subscription limits. Enable automatic switching only after checking integration compatibility and the applicable provider terms.
- Not included in v1: multi-user SaaS, billing, website previews, scheduled tasks, or switching Codex ↔ Claude within a chat.

## Operations

```bash
./ops/compose.sh ps                 # service status
./ops/compose.sh logs -f server     # server logs
./ops/compose.sh stop               # stop without deleting data
./ops/compose.sh up -d --wait        # start again
./ops/backup.sh                     # encrypted backup
./ops/update.sh                     # backup, pull, build, restart
```

Do not run `docker compose down -v` unless you intend to delete the database volume.

## Development and verification

Use Node.js 22, npm, and Docker. After `npm ci`:

```bash
npm run build
npm test
```

Database integration tests require a **disposable test database** on port 54329. These tests clear its tables:

```bash
docker run -d --name ai-workspace-test-db -e POSTGRES_USER=workspace -e POSTGRES_PASSWORD=workspace -e POSTGRES_DB=workspace -p 127.0.0.1:54329:5432 postgres:16-bookworm
INTEGRATION_TESTS=1 DATABASE_URL=postgres://workspace:workspace@127.0.0.1:54329/workspace npm test
```

Without `INTEGRATION_TESTS=1`, database tests are skipped. CI runs them against a dedicated PostgreSQL service. To exercise real Docker runners without using provider accounts or making inference calls:

```bash
./ops/compose.sh exec server node dist/node/server/smoke.js
```

Read the [architecture and API overview](docs/architecture.md) and the [provider verification guide](docs/provider-verification.md).

## Data and credentials

`.env`, `.data/`, `.backup-key`, `backups/`, `.install-mode`, and the local `.wikillm/` are excluded from Git and the Docker build context. Official CLIs manage their own credentials in private server-side profiles. GitHub tokens and TOTP secrets are encrypted using the key in `.env`. Keep `.backup-key` somewhere separate from the server; encrypted backups cannot be restored without it.

The supervisor has Docker socket access and is a trusted component with administrative power. Agent containers have no Docker socket or database access. Use a dedicated VPS for Workspace. Repository Git commands run in separate containers; authenticated pushes use a fresh trusted repository so agent-controlled Git configuration cannot access the GitHub token.

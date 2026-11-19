# AI Workspace

A self-hosted web app for working with **Codex** and **Claude Code** from your computer or phone. Keep chats, project files and agent tasks on your own server. Closing the browser does not stop an agent.

**New here? [Follow the setup guide from installation to your first chat.](docs/getting-started.md)**

[Quick start](#choose-where-to-run-it) · [User guide](docs/user-guide.md) · [Server administration](docs/deployment.md) · [Contributing](CONTRIBUTING.md)

![AI Workspace home with projects, recent chats and account limits](docs/screenshots/workspace.jpg)

## What it does

- Connect your own Codex and Claude Code accounts and work through one browser interface.
- Keep conversations, attachments and project files between sessions.
- Work on GitHub repositories or files-only projects; GitHub is optional.
- Run agents in separate containers, review their changes and respond to permission requests.
- Continue from a phone while your server stays running.

AI Workspace is designed for **one owner**. It does not include team accounts, billing or local AI models. Models run through the providers; no GPU is needed for the workspace itself. Provider access and server hosting are separate from this application.

> **Early release.** Automated checks cover the application and isolated test environments. Verify sign-in and real tasks with your own provider accounts before relying on unattended work. Automatic account switching is disabled by default. See [provider verification](docs/provider-verification.md).

## What you need

| Requirement | Details |
| --- | --- |
| An agent account | At least one account with access to Codex or Claude Code through its official CLI. You do not need both services. |
| A computer or VPS | macOS, Windows with WSL2, or Linux. A VPS is a rented server that stays online independently of your laptop. |
| Docker | Runs the app, database and agent containers. The server installer can install it on Ubuntu/Debian. |
| Git, Python 3 and OpenSSL | Required by the installation and maintenance scripts; platform-specific steps are in the setup guide. |
| An authenticator | An app that generates six-digit verification codes. Installation sets up password + two-factor sign-in. |
| Internet access | Needed to download images, connect provider accounts and run agent tasks. |

You do **not** need to install Node.js, PostgreSQL, Codex CLI or Claude Code on the host for the Docker installation. The images include them. API keys are not part of the documented setup; connect your provider account through its sign-in flow.

## Choose where to run it

| I want to… | Choose | Open the app at |
| --- | --- | --- |
| Try it on this computer | Local installation | `http://localhost:8080` on that computer |
| Use it from a phone or leave tasks running overnight | VPS installation | `https://YOUR_PUBLIC_IP` or your domain |

For three simultaneous agents, start with approximately **4 vCPU, 8 GB RAM and 40+ GB free SSD space**. A **4 GB RAM** server can be a starting point for light workloads with **one concurrent task**. This is an estimate; project builds may need more. On Docker Desktop, allocate memory to Docker itself. [Resource details](docs/deployment.md#small-servers-4-gb-ram).

### Run locally — three commands

Start Docker first. Run these commands in Terminal on macOS/Linux, or in your WSL Ubuntu terminal on Windows:

```bash
git clone https://github.com/qavitalii/ai_workspace.git
cd ai_workspace
./ops/install.sh --local
```

Choose an owner password of at least 14 characters. Scan the displayed QR code with your authenticator and save the setup key securely. Open **[http://localhost:8080](http://localhost:8080)** after installation finishes.

Your computer and Docker must stay running. This local address does not work from another device. [Complete local setup steps](docs/getting-started.md#2a-install-on-your-computer).

### Deploy to a VPS — three commands

Use a dedicated **Ubuntu 24.04 or Debian 12** server with Git, administrator access, a static public IP or domain, and inbound TCP ports **80 and 443** open. Keep SSH access available. In the server's SSH terminal, run:

```bash
git clone https://github.com/qavitalii/ai_workspace.git
cd ai_workspace
sudo ./ops/install.sh --server
```

Enter your domain or public IP **without `https://`, a port or a path**. Set the owner password and authenticator as above. The installer prints the address to open. HTTPS certificates are obtained and renewed automatically, including for public IP addresses; buying a domain is optional. Initial issuance can take a few minutes.

The root server installation also schedules encrypted daily backups. Copy the backup key and archives off the server. [Complete VPS setup steps](docs/getting-started.md#2b-install-on-a-vps).

## First use

1. Sign in with the owner password and the current code from your authenticator.
2. Open **Agent accounts**, choose a service, enter an account label and select **Add account → Connect**. Complete sign-in on the provider's official page.
3. Select **New chat**. Leave **Project** set to **Personal chat**, choose your connected account and select **Create chat**. A GitHub repository is not required.
4. Send a small first task, such as “Create a file named `hello.txt` containing `Hello from AI Workspace`, then tell me where it is.” Review permission requests before approving them.
5. Open **Files** and confirm the result. You are ready to add a project or try a larger task.

On a 4 GB server, set **Settings → Resources → Maximum concurrent tasks** to **1** before starting a task. See the [first-chat walkthrough and troubleshooting](docs/getting-started.md#4-start-your-first-chat) if the account does not connect or the task stays queued.

## Project folders and existing data

Use **Files only** for documents or files without Git, or connect a **GitHub project** to work on a repository. Chats can share the main folder or use a separate working copy. Review a copy before transferring it back. Commit, push and pull-request creation are separate actions.

Deleting a chat keeps its working files; deleting a non-main folder also removes its linked chats and original attachments after confirmation. Back up before upgrading or removing data. See the [user guide](docs/user-guide.md) for folder choices, account switching, SSH, AWS and skills.

Project settings also let you connect HTTPS MCP servers and enable project plugins for Codex and Claude. [Integration setup](docs/deployment.md#project-mcp-servers-and-plugins)

## Operations

Run commands from the cloned `ai_workspace` directory. For a VPS installed with `sudo`, prefix maintenance commands with `sudo` too.

On a supported Linux VPS, use **Settings → Updates** to install tagged releases from the browser. Existing installations need a [one-time setup](docs/deployment.md#7-updates).

```bash
./ops/compose.sh ps                 # check service status
./ops/compose.sh logs --tail=100 server
./ops/compose.sh stop               # stop without deleting data
./ops/compose.sh up -d --wait        # start again
./ops/backup.sh                     # create an encrypted backup
./ops/update.sh                     # back up, pull, build and restart
```

Do not run `docker compose down -v` unless you intend to delete the database. See [backups and recovery](docs/deployment.md#6-backups) and [troubleshooting](docs/deployment.md#8-troubleshooting).

## Screenshots

![A persistent chat with account switching, execution log and file controls](docs/screenshots/conversation.jpg)

![Workspace and conversation on a phone](docs/screenshots/mobile-showcase.jpg)

Screenshots use fictional data. Browse the [desktop and mobile gallery](docs/screenshots/README.md) for projects, working copies, reviews and settings.

## Development and verification

For source changes, use Node.js 22 and follow [Contributing](CONTRIBUTING.md), including the separate database, Docker, SSH and HTTPS test instructions. Tests use synthetic data; successful test runs do not establish live provider compatibility. The [architecture guide](docs/architecture.md) describes components and API boundaries.

## Data and credentials

Workspace stores chats, files and provider sign-in data on the machine where you install it. It is not offline: prompts and relevant task data are sent to the chosen provider, and agents can contact services you authorize. Keep `.env`, `.data/`, backup keys and backup archives private. [Security guidance](SECURITY.md).

The application controls Docker and should run on a trusted, dedicated host. Container isolation does not make arbitrary agent commands harmless. Keep approval prompts enabled while getting familiar with it.

## Project information

- [Setup guide](docs/getting-started.md): prerequisites, installation, sign-in and a first task.
- [User guide](docs/user-guide.md): projects, files, working copies and connections.
- [Deployment guide](docs/deployment.md): configuration, updates, backups and recovery.
- [Provider verification](docs/provider-verification.md): checks with your own accounts.
- [Publication readiness](docs/publication.md): verification records and remaining limits.

This independent project is not affiliated with OpenAI or Anthropic. You supply your own eligible provider accounts; access and subscription limits remain subject to the provider.

Licensed under the [GNU General Public License v3.0 only](LICENSE) (`GPL-3.0-only`). Dependencies and the separately installed provider CLIs retain their own licenses and terms.

# AI Workspace

A private, self-hosted web workspace for **Codex** and **Claude Code**. Work with agents from your computer or phone: persistent chats, attachments, GitHub projects, isolated containers, diffs, a terminal, and permission prompts. Closing your browser does not stop an agent.

[Getting started](#run-locally--three-commands) · [Deployment](docs/deployment.md) · [Architecture](docs/architecture.md) · [Contributing](CONTRIBUTING.md)

![Workspace home with projects, recent chats, and account limits](docs/screenshots/workspace.jpg)

**Your agents, your server, any device.** Keep work moving across persistent conversations, shared project folders, and explicit review and publishing steps.

| Work with agents | Stay in control | Pick up anywhere |
| --- | --- | --- |
| Codex and Claude Code accounts | Container isolation and approval prompts | Responsive browser interface |
| Files, images, folders, and skills | Review diffs before commit, push, and PR | Persistent chats and event replay |
| Per-chat models and reasoning | Password + authenticator sign-in | Self-host locally or on a VPS |

Screenshots show the current interface with fictional accounts, repositories, messages, and usage values. [Desktop and mobile screenshot gallery](docs/screenshots/README.md).

> **Status: initial release for local validation.** The application, Docker deployment, and automated tests can run now. Real subscription sign-in, model execution, and switching between your own accounts require verification with your accounts before unattended production use. Automatic account switching is disabled by default.

## Project folders and existing data

New project chats use **Main folder** by default; you can choose a separate copy when creating a chat. Files saved through its Files panel are visible to every chat using that folder; tasks run one at a time within it. The paperclip adds a conversation attachment instead. Originals stay separate and can be copied into the folder from its attachment library.

On upgrade, existing chat folders are preserved in place as **Saved folders**. In the project page or Project settings, choose an existing folder as the main one, or start a fresh main folder from the repository. Other folders and their chats remain unchanged. A new chat can also continue in an existing saved folder. Deleting a chat keeps its working files and original attachments; folders remain accessible even without chats.

When creating a chat, choose **Main folder**, **New working copy**, or an existing folder. You can also use **New working copy** on the project page. Give each copy a task name. It starts with the main folder’s current files, including uncommitted changes and uploaded files. Git folders use linked Git worktrees with separate branches and a shared managed repository; folders without Git use ordinary file copies. Choose **Files only** when creating a project without a GitHub repository. Existing folders and their files are kept in their original format. Copies do not update each other automatically. One task runs per folder; parallel tasks also need separate available agent accounts and enough capacity in Settings → Resources.

Use **Review changes** to compare the current main files with the proposed result, resolve conflicts, then **Transfer to main folder**. The app combines compatible text changes, detects stale reviews, and saves the previous main folder before applying. Transferring updates working files; it does not commit or push the main repository. A copy remains available for further work. Choosing the main version resolves that proposal; it does not rewrite the copy’s files.

Dependencies, build output, `.env` files (except example/sample/template files), local credential files, app-internal directories and local Git configuration are excluded. The UI lists exact excluded paths. Git worktrees share history, which can still contain previously committed content. Agents can read Git history/status and edit/test files; shared Git metadata is read-only in agent sessions. Use the app’s Git actions for commits and publishing. Connected folders are read-only for copy chats. File copies do not isolate remote services, databases or deployments. Copies/reviews are limited to 50,000 entries, 100 MB per file and 2 GB total; full pre-transfer preparation, including ignored files and Git metadata, has the same limits.

**Resolve with agent** prepares a separate resolution folder and opens a chat with the selected account. The agent compares frozen base/main/copy versions, combines changes and runs checks. The main and original copy stay intact. Review the resolution folder and transfer its result when ready; incomplete checklists or remaining conflict markers block transfer. Unclear product decisions can still require your input. The normal account queue and approval settings apply.

**Delete folder** removes a non-main folder, its linked chats and its original attachments after confirmation by name. Untransferred work is lost. The main folder, connected folders and previous main-folder recovery copies are preserved. To keep files, delete only the chat. **Delete account** removes a saved account and its local sign-in data, while keeping chats and project files. Choose another account to continue those chats. Stop active/queued tasks and close terminals before folder deletion; account operations and active/queued tasks also block account deletion.

Back up both the database and `DATA_ROOT` before upgrading. Migration preserves existing files. Deleting an entire project, with or without its files, is not implemented yet. See the [working-folder guide](docs/deployment.md#11-working-folders-and-conflict-resolution) for practical workflows.

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

Supported starting point: Ubuntu 24.04 or Debian 12, Git installed, root access through `sudo`, a domain pointing to the server **or a static public IP address**, and inbound **TCP ports 80 and 443** open. Suggested starting resources: 4 vCPU, 8 GB RAM, and 40+ GB free disk, depending on your workloads. A 4 GB server can be a starting point for light workloads with **one concurrent task**; see the [deployment guide](docs/deployment.md#small-servers-4-gb-ram).

```bash
git clone https://github.com/qavitalii/ai_workspace.git
cd ai_workspace
sudo ./ops/install.sh --server
```

If Docker is missing, the installer installs it using Docker's official installer. Enter your domain or public IPv4/IPv6 address without `https://`, a port or a path, choose a password, and save the TOTP QR code. Caddy obtains and renews the HTTPS certificate, including short-lived Let's Encrypt certificates for IP addresses. No domain purchase is required. Initial certificate issuance can take a few minutes after the services start. A root installation also schedules daily encrypted backups.

**[Detailed deployment guide →](docs/deployment.md)** — prerequisites, DNS, Docker Desktop, installation, updates, backups, recovery, and troubleshooting.

## First use

1. Sign in with your password and a six-digit authenticator code.
2. Open **Agent accounts**, add an account, and select **Connect**. For Codex, use **Copy code** and enter the device code on the official sign-in page. For Claude Code, follow the official CLI sign-in instructions.
3. Add a project: choose **Files only** and enter a name, or connect a GitHub project using `owner/repository` or `https://github.com/owner/repository`. Add that project's own fine-grained token for private repositories and publishing: **Contents: Read and write**, **Pull requests: Read and write**. Manage each project's token through its settings button or **Settings → Connections**.
4. Create a chat and select an account. Choose **Personal chat** for work outside a project. Within a project, choose **Main folder**, **New working copy**, or **Existing folder** when available. No title is required: the first message supplies a short title. Use the ⋯ button beside any chat to rename or delete it. Deleting a chat removes its conversation history after confirmation; working folders and original attachments are kept and remain accessible from the project or home page. Stop active tasks and close the terminal first.
5. Describe a task. Attach files, drop them onto the composer, or paste an image.
6. Review files and diffs. For repository chats, commit, push, and pull requests are separate actions. Open the terminal when the agent is idle.

The default permission mode asks before actions that require approval. **Run without approval prompts** allows the agent to execute commands and edit files inside its isolated container without those prompts. Project chats share their selected persistent working folder. Only one task can modify that folder at a time; saved legacy folders remain independent.

Use **Disconnect** in Agent accounts to sign out through the official CLI. Stop an active task first. Signing out keeps the account entry, chats, files, and attachments; select **Connect** to sign in again. A failed or interrupted sign-out stays unavailable for jobs until you retry it or sign in again.

## Features and boundaries

- One owner, multiple personal accounts, configurable task concurrency, and one active run per account. The default is three concurrent tasks; Settings → Resources can set 50 or more without a hard-coded three-task ceiling.
- Streaming responses and persisted event replay after reconnecting.
- File and image attachments: 10 files per message, 25 MB each by default. Archives are never extracted automatically.
- Supported images are passed as image input; other original attachments are mounted read-only at `/attachments`. Save edited copies in the working folder. Reading arbitrary formats depends on the tools installed in the runner.
- Project chats can share the main folder, use a new Git worktree/file copy, or continue in an existing folder. Copies support review, agent-assisted conflict resolution and explicit transfer to main.
- Switching accounts within one provider preserves files and visible history. It creates a **new native session with a context checkpoint**, rather than claiming to preserve identical hidden model state.
- Server failures mark active jobs as interrupted. Resume only after reviewing existing changes and external operations; publishing is never blindly retried.
- Web Push requires browser permission. On iPhone/iPad, use HTTPS and install the web app on the Home Screen.
- A server running 24/7 does not remove subscription limits. Enable automatic switching only after checking integration compatibility and the applicable provider terms.
- Not included in v1: multi-user SaaS, billing, website previews, or scheduled tasks.

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

Without `INTEGRATION_TESTS=1`, database tests are skipped. CI runs the database suite against a dedicated PostgreSQL service, but currently does not enable `DOCKER_TESTS=1`.

To verify worktrees, ordinary copies, conflict preparation/transfer, deletion and runner isolation, keep the disposable database above running and build a separate test image:

```bash
docker build --target runner -t ai-workspace-runner:tests .
INTEGRATION_TESTS=1 DOCKER_TESTS=1 RUNNER_IMAGE=ai-workspace-runner:tests DATABASE_URL=postgres://workspace:workspace@127.0.0.1:54329/workspace npm test
```

If the Node Docker client cannot find Docker Desktop's socket on macOS, prefix that test command with `DOCKER_HOST="unix://$HOME/.docker/run/docker.sock"`. The separate image tag avoids replacing the installed runner. Tests use temporary files and simulated agent results; they do not authenticate or make inference calls. Remove the disposable database afterward with `docker rm -f ai-workspace-test-db`.

The installed application's smoke command checks temporary runner containers, terminal/file access, Git helpers and the Codex handshake. It creates and removes temporary records in that installation; it does not replace the disposable-database worktree tests:


```bash
./ops/compose.sh exec server node dist/node/server/smoke.js
```

Read the [architecture and API overview](docs/architecture.md) and the [provider verification guide](docs/provider-verification.md).

## Data and credentials

`.env`, `.data/`, `.backup-key`, `backups/`, `.install-mode`, and the local `.wikillm/` are excluded from Git and the Docker build context. Official CLIs manage their own credentials in private server-side profiles. GitHub tokens and TOTP secrets are encrypted using the key in `.env`. Keep `.backup-key` somewhere separate from the server; encrypted backups cannot be restored without it.

The supervisor has Docker socket access and is a trusted component with administrative power. Agent containers have no Docker socket or database access. Use a dedicated VPS for Workspace. Repository Git commands run in separate containers; authenticated pushes use a fresh trusted repository so agent-controlled Git configuration cannot access the GitHub token.

### Files, folders, models and shortcuts

Chat and project settings include **Folders**: upload files or directories, connect an existing server folder, select read-only or read/write access, browse/download files, and disconnect without deleting data. Project folders are inherited by its chats; shared writers are serialized. See [folder setup and external server paths](docs/deployment.md#9-files-and-connected-folders).

Choose a model and reasoning effort before the first message or from the composer. Type `/` for Workspace commands, `@` for files/folders, and `$` for workspace skills. These are supported Workspace features, not a claim of complete parity with every native CLI command or plugin.

### SSH servers

**Settings → Servers & SSH keys** manages SSH connections. Create or import a key (including passphrase-protected keys), install its public key on your server, confirm the server fingerprint and test the connection. Select servers in project or personal chat settings; project working copies inherit access. Agents and chat terminals can use SSH, SCP and SFTP by alias. Private keys stay in an isolated authentication helper for each run. Removing a connection does not revoke its public key on the remote server. [Setup, access and backup details](docs/deployment.md#ssh-servers-and-keys).

### AWS access and portable skills

Use **Project settings → AWS access** to sign in to AWS IAM Identity Center in your browser and give that project’s agents and terminals a temporary role. Use **Settings → Skills** to import a local skill folder or ZIP for all chats, or **Project settings → Skills** to keep it within a project. Choose imported skills with `$`. Export selected skills as a ZIP with their supporting files. [Setup and limits](docs/deployment.md#aws-access-and-portable-skills).

### Chat models and account limits

**Settings → Models** saves a starting model and thinking depth separately for Codex and Claude Code. New chats copy those values; existing chats keep their own settings. Override the model when creating a chat or in chat settings. The UI displays the provider-reported model once available, including the exact model behind a Claude alias. Older chats without a reported model show that it has not been reported yet.

The sidebar labels each chat with its agent and model, and shows remaining limits for each account. Open **Details** for reset times and the last report timestamp. Limits for both Codex and Claude Code accounts can be refreshed without starting an inference task when the account is idle; opening **Account limits** in the sidebar refreshes stale values automatically. Claude limits are read with the signed-in CLI profile's own token from the same subscription usage data the CLI shows in `/usage`; this is not a documented public API and may change. During tasks, Claude's own reports also update limits and may omit utilization; missing percentages are shown as unknown, never as a full balance. Expired windows require a fresh report. Credits or usage costs are not treated as subscription percentages.

## Screenshots

### A persistent conversation

![A Codex conversation with account switching, an execution log, and controls for files, changes, and terminal](docs/screenshots/conversation.jpg)

### On your phone

Keep your projects and conversations close, with a mobile layout for browsing chats, reviewing replies, and choosing how your agent works.

![Mobile workspace home and conversation shown side by side in decorative phone frames](docs/screenshots/mobile-showcase.jpg)

### Choosing a working folder

![New chat with a choice between the shared main folder and a separate working copy](docs/screenshots/new-chat.jpg)

### Resolving conflicting changes

![Review with agent-assisted conflict resolution and explicit transfer controls](docs/screenshots/resolve-conflicts.jpg)

See the gallery for [switching between Codex and Claude Code](docs/screenshots/ui-refresh/switch-agent-desktop.jpg), [reviewing a commit](docs/screenshots/ui-refresh/changes-desktop.jpg), [configuring AWS access](docs/screenshots/ui-refresh/project-aws-desktop.jpg), and [managing skills](docs/screenshots/ui-refresh/workspace-skills-desktop.jpg).

## Project information

- [Contributing and local checks](CONTRIBUTING.md)
- [Security and sensitive data](SECURITY.md)
- [Publication readiness](docs/publication.md)

This is an independent project and is not affiliated with OpenAI or Anthropic. You supply your own eligible provider accounts. Provider access is not included.

Licensed under the [GNU General Public License v3.0 only](LICENSE) (`GPL-3.0-only`). Third-party dependencies and the separately installed provider CLIs retain their own licenses and terms.

Manual account switching supports Codex ↔ Claude Code in the same chat. Messages, files, attachments, planning mode and permissions remain; a new agent session receives the saved context. Changing providers uses the target provider’s default model and clears native commands from the previous session. Stop or cancel an active/queued task before switching. Automatic quota handoff stays within the current provider.

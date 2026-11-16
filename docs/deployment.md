# Deployment and operations

## 1. Local installation

### macOS

Install and start Docker Desktop. Under Settings → Resources, allocate approximately 8 GB RAM for three concurrent agents; one agent may need less, depending on its workload. Keep the repository in a folder available to Docker Desktop for bind mounts. Use a path without spaces.

```bash
git clone https://github.com/qavitalii/ai_workspace.git
cd ai_workspace
./ops/install.sh --local
```

### Windows

Use WSL2 with Docker Desktop's WSL integration enabled. Clone the repository inside your Linux home directory, such as `~/ai_workspace`, and run the same three commands from WSL. Run the Bash scripts in WSL, not PowerShell.

### Linux

Install Docker Engine and Compose v2.24.4 or newer. Run the installer with `--local`. If your user cannot access Docker, use `sudo`. Docker access effectively grants administrative privileges.

### What the installer does

1. Checks Docker, Compose, Python 3, and OpenSSL. On a supported root VPS installation it installs missing maintenance tools and enables cron.
2. Creates `.env` with a random database password and encryption key, and creates `.data/`.
3. Builds the server and runner images, including the official agent CLIs.
4. Generates Web Push VAPID keys.
5. Starts PostgreSQL, asks for an owner password, and displays a TOTP QR code.
6. Starts the application and Caddy, then waits for health checks.

Open [http://localhost:8080](http://localhost:8080). Rerunning the installer does not overwrite the owner or erase data. If the first build is interrupted, run the same command again.

**Local mode is not intended for public exposure.** Its port is bound to `127.0.0.1`. Cookies omit Secure only for local HTTP testing. Your phone's `localhost` does not point to your computer. Use an HTTPS server deployment for phone access.

## 2. VPS deployment with HTTPS

### Prerequisites

- Ubuntu 24.04 or Debian 12, amd64 or arm64.
- Suggested starting resources: 4 vCPU, 8 GB RAM, and 40+ GB SSD. Each agent runner is limited to 2 CPU, 2 GB RAM, and 256 PIDs. Large builds may require adjusting `src/server/runtime.ts`.
- Git installed: `sudo apt-get update && sudo apt-get install -y git`.
- A domain such as `agents.example.com` pointing to the VPS. Configure the A record and, if present, a valid AAAA record.
- Inbound TCP ports 80 and 443 open. Keep SSH available for administration. PostgreSQL has no published port.
- A checkout path without spaces, for example `/opt/ai_workspace`.

```bash
git clone https://github.com/qavitalii/ai_workspace.git
cd ai_workspace
sudo ./ops/install.sh --server
```

Enter a domain without a scheme or path, set a password of at least 14 characters, and add TOTP to your authenticator. If Docker is missing, the installer uses the official `get.docker.com` installer. Install Docker yourself on operating systems other than the supported Ubuntu/Debian setup.

Caddy obtains and renews the HTTPS certificate. Incorrect DNS or a blocked firewall will prevent certificate issuance; inspect the Caddy logs if necessary.

## 3. Configuration

The installer creates `.env` with permissions `600`. Do not commit it or include it in support requests.

| Variable | Purpose |
|---|---|
| `APP_ORIGIN` | Exact external origin, without a trailing slash, such as `https://agents.example.com` |
| `SITE_ADDRESS` | Caddy domain; `:80` locally |
| `NODE_ENV` | `production` for an HTTPS VPS; `development` for local testing only |
| `DATA_ROOT` | Absolute path on the Docker host; mounted at the same path inside the supervisor |
| `POSTGRES_PASSWORD` | Random database password; changing `.env` alone does not update an existing database user |
| `ENCRYPTION_KEY` | 32 random bytes in hexadecimal; do not rotate without migrating encrypted secrets |
| `MAX_CONCURRENT` | Default maximum concurrent tasks, 3 initially; any positive whole number. A value saved in Settings → Resources overrides this environment default |
| `MAX_FILE_MB` | Maximum attachment size, 25 MB by default |
| `MAX_ATTACHMENTS` | Maximum attachments per message, 10 by default |
| `ENABLE_AUTO_HANDOFF` | `false` initially; see the provider verification guide |
| `VAPID_*` | Web Push keys and contact address, generated during installation |

Apply changes with `./ops/compose.sh up -d server caddy`. To change a domain, update `APP_ORIGIN`, `SITE_ADDRESS`, and DNS together. To migrate local mode to a server, also set `NODE_ENV=production`, change `.install-mode` to `--server`, and use the server Compose configuration without the local override.

For frontend/backend development outside Docker, use Node 22, your own PostgreSQL instance, `npm ci`, the variables from `.env.example`, and `npm run dev`. Docker is still required for agent containers. Set `APP_ORIGIN=http://localhost:5173` for Vite. Never use a production database for tests.

### Capacity and live resource usage

Open **Settings → Resources** to see CPU usage/idle percentage, used/available memory, workspace filesystem space, running tasks, queued tasks, and tasks waiting for an account. Samples refresh every two seconds while this panel is open. Disconnection retains the last sample with an explicit stale-data message.

**Maximum concurrent tasks** accepts any positive whole number, including 50 or more. Saving takes effect for new starts without restarting the server. The value is stored in PostgreSQL and survives restarts and backups. Lowering it does not interrupt running tasks: new starts wait until occupancy drops below the new limit. The initial default comes from `MAX_CONCURRENT=3`; once saved in the UI, the database value takes precedence.

Each account still serves only one running task at a time. Increasing capacity does not create accounts, bypass provider quotas, or reserve CPU/RAM in advance. Each runner retains its configured CPU/RAM/PID limits. Size the server for your workloads and use the live metrics to observe actual usage. A 50-slot scheduler test is not a 50-container performance benchmark.

On Linux VPS deployments, metrics describe the runtime host and the filesystem containing `DATA_ROOT`. Available memory includes reclaimable cache. On Docker Desktop, CPU and RAM describe Docker's Linux VM, not the entire Mac/Windows computer. Shared-host filesystem capacity can be synthetic, so physical disk availability is shown as unavailable there; check the host operating system instead. No external monitoring service is required.

## 4. GitHub and agent accounts

Create a GitHub fine-grained PAT under Settings → Developer settings → Personal access tokens → Fine-grained tokens. Select only the required repositories. Grant `Contents` and `Pull requests` read/write permissions. Organization-owned repositories may require administrator approval.

Each project has its own token. Supply it when connecting a repository, or use the project settings button / Settings → Connections to replace or remove it. There is no global token for new projects. Upgrading copies a previously saved global token into existing projects; it never applies it to newly created projects. Each token is encrypted in the database. It is not stored in Git remote URLs or provided to agent containers. Read-only Git inspection and commits run without GitHub credentials. Publishing exports a bundle into a fresh trusted repository before pushing with credentials.

For Codex, use Copy code and enter the device code on OpenAI's page. For Claude, open the URL shown by the official CLI and supply the browser code if requested. Never enter OpenAI or Anthropic account passwords into Workspace. Account sign-in is blocked while that account is executing a task.

Complete the [provider verification scenarios](provider-verification.md) before relying on unattended execution. Repeat them after changing CLI versions. Disconnect signs out through the official CLI and preserves account records, chats, files, and attachments. It is blocked during active tasks and permission waits. Failed or interrupted sign-out stays unavailable for scheduling and offers Retry disconnect; it does not claim the credentials were removed. Connect starts a new sign-in.

Create chat does not require a name or Git repository. Choose No repository — private workspace to start without Git. A short title comes from the first message and can be changed in chat settings. Git diff and publishing actions are available only for repository chats.

## 5. Routine operations

For a VPS installed as root, run maintenance commands from a root shell or prefix them with `sudo`. Local Docker Desktop installations run as your normal user.

```bash
./ops/compose.sh ps
./ops/compose.sh logs --tail=100 server
./ops/compose.sh logs --tail=100 caddy
./ops/compose.sh stop
./ops/compose.sh up -d --wait
```

Services use `restart: unless-stopped` and restart with Docker after a reboot. On supervisor recovery, old CLI containers are stopped and active jobs become interrupted. Inspect changes and external operations before continuing.

The terminal opens in a side panel. It does not receive an account profile or GitHub token. Closing it stops its container. Use an agent job for persistent background work. A workspace lease prevents terminal use or publishing from overlapping an agent run.

Generated files can be downloaded from the Files panel; downloads are capped at 100 MB per file in this version. Attachment uploads have their separate configurable limit. File reads run in a readonly helper container so symlinks cannot expose supervisor data.

## 6. Backups

```bash
./ops/backup.sh
```

The backup script temporarily stops the supervisor to capture a consistent database and file checkpoint. **Active jobs are interrupted.** It automatically restarts the server afterward. The encrypted archive in `backups/` contains the database, native CLI profiles, workspaces, attachments, and configuration. Backups older than seven days are removed.

A root VPS installation creates `/etc/cron.d/ai-workspace-backup`, scheduled for **03:17 in the server's timezone**. Logs are written to `/var/log/ai-workspace-backup.log`. Local installation does not install a cron job.

**Copy `.backup-key` to a safe location outside the server.** Also copy archives to another disk or remote storage. Offsite upload is not included. A backup on the same VPS disk does not protect against losing that VPS.

### Restore

1. Stop work. Create a current backup if possible.
2. On a new server, install Workspace first to create images, `.env`, and the database volume.
3. Copy the encrypted archive and the **original** `.backup-key` into the installation directory. Restrict permissions with `chmod 600 .backup-key`.
4. Run:

```bash
./ops/restore.sh /absolute/path/workspace-backup.tar.gz.enc --replace-existing
```

This explicitly replaces the installation's current data. The script retains the old `.env` and data directory for manual rollback; remove them only after verification. It preserves the current `DATA_ROOT` and the current database volume's password. Verify the domain, `APP_ORIGIN`, local/server mode, and interrupted jobs after restoration.

## 7. Updates

```bash
./ops/update.sh
```

A clean Git checkout is required. The script creates a backup, runs `git pull --ff-only`, builds both images, and recreates the services. CLI versions are pinned in the Dockerfile and do not update themselves inside running containers.

Read project release notes before updating. Current schema changes are additive. For an incompatible downgrade, restore the matching backup and code version together.

## 8. Troubleshooting

| Symptom | What to check |
|---|---|
| Docker socket permission denied | Docker Desktop is running; on Linux check user permissions or use `sudo` |
| Port 8080 is already allocated | Change the port in `compose.local.yaml` and `APP_ORIGIN` together |
| `Origin not allowed` | Open the exact `APP_ORIGIN`; localhost and 127.0.0.1 are different origins |
| TOTP is rejected | Correct clock on server/phone; the same code cannot be reused |
| HTTPS does not work | DNS A/AAAA records, ports 80/443, `./ops/compose.sh logs caddy` |
| Runner image is missing | Run `./ops/compose.sh build runner-image` |
| GitHub returns 403/404 | PAT repository access, organization approval, correct owner/repository |
| A chat remains queued | Selected account is connected and idle, capacity is available, and the terminal is closed |
| Claude sign-in is waiting | Open the URL from the native CLI and provide the code if requested |
| Job interrupted after reboot | Expected behavior: inspect files and resume explicitly |
| Low disk space | Settings shows free space; inspect `docker system df`; do not remove the database volume |
| No push notifications on iPhone | Use HTTPS, install on the Home Screen, and grant notification permission |

Check configuration with `./ops/compose.sh config --quiet`. Plain `docker compose config` can print resolved secrets; do not share its output.

## 8. Files and connected folders

For files that belong to a message, use the paperclip, drag/drop, or image paste. Originals stay with the chat; agents receive workspace copies.

For reusable data, open **Chat settings → Folders** or **Project settings → Folders**:

1. Select an existing server folder, or create a named folder.
2. Choose **Upload files** or **Upload folder**. Directory uploads retain relative paths. Each file uses `MAX_FILE_MB`; archives are not extracted. Browsers without directory selection can upload individual files. Uploads report progress, never overwrite different existing files, and safely skip identical files when retried.
3. Choose **Read only** (default) or **Read & write**, then **Connect folder**. To change access later, select the same folder, choose the new mode, and connect again.

The agent and terminal see `/workspace/.workspace-folders/<name>`. Project folders are inherited by all its chats. Chat folders apply only to that chat. **Browse** lists and downloads files. **Disconnect folder** removes access without deleting data. Stop tasks and close terminals before changing connections or uploading into a folder in use. Chats sharing a writable folder run one at a time; read-only readers can run together. A waiting chat remains queued until the folder is available.

By default, folders live under `DATA_ROOT/shared` and are included in encrypted backups. To make an existing folder available, place it directly under that directory (for example `shared/assets`). Use ordinary directories, not symbolic links. On Linux, UID 1000 must have read access, plus write access for uploads or writable connections. Workspace never recursively changes ownership of existing folders.

To use an existing collection elsewhere on the server, put `FOLDER_ROOT=/srv/agent-files` in `.env`, then add the optional override:

```bash
# Linux VPS
./ops/compose.sh -f compose.yaml -f compose.folders.yaml up -d --wait
# Local Docker Desktop (include the local ports/HTTP override)
./ops/compose.sh -f compose.yaml -f compose.local.yaml -f compose.folders.yaml up -d --wait
```

Keep this override in subsequent `up`/update commands. Each direct subdirectory appears in the folder picker. The path must be shared with Docker Desktop when running locally. Only selected subfolders are mounted into agents; the supervisor needs the collection mounted at the identical absolute path. Choose a dedicated data directory, not your home directory, system directories, Docker socket directory, or Workspace's private credential/database directories. External collections are **not** part of the built-in backup and need their own backup. Files on a laptop are copied to the server by upload; keeping a laptop folder live requires a separately configured sync service.

## 9. Models, commands and references

Select **Model** and **Reasoning effort** while creating a chat, or use the model button above Send / `/model` before the next task. **Load available models** queries the connected account; Codex model metadata determines advertised reasoning levels when available. Blank/default delegates selection to the official agent. Claude aliases are offered as convenience values; support depends on account and model. Changes are blocked while a task is active.

The composer offers keyboard and touch suggestions: `/` for Workspace commands, `@` for workspace paths and connected folders, `$` for workspace `SKILL.md` files. Arrow keys select, Enter inserts/executes, Escape closes; Ctrl/Cmd+Enter sends. `/help` lists the supported commands. File/skill references become explicit paths in the prompt. Indexing skips symlinks, Git internals, dependency/build folders and scans at most 5,000 entries to depth eight. Repository files appear after checkout initialization. Account-wide native plugins, app mentions and arbitrary native CLI slash commands are not automatically exposed by this interface.

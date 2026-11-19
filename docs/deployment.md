# Deployment and operations

**Installing for the first time?** Start with [the setup walkthrough](getting-started.md). It explains prerequisites, the installer prompts, account sign-in and a first task. This guide is the reference for configuration, maintenance and advanced features. For daily workflows, see the [user guide](user-guide.md).

[Local installation](#1-local-installation) · [VPS and HTTPS](#2-vps-deployment-with-https) · [Configuration](#3-configuration) · [Accounts](#4-github-and-agent-accounts) · [Backups](#6-backups) · [Updates](#7-updates) · [Troubleshooting](#8-troubleshooting)

## 1. Local installation

### macOS

Install Git, Python 3 and OpenSSL, then install and start Docker Desktop. Under Settings → Resources, allocate approximately 8 GB RAM for three concurrent agents; one agent may need less, depending on its workload. Keep the repository in a folder available to Docker Desktop for bind mounts. Use a path without spaces.

```bash
git clone https://github.com/qavitalii/ai_workspace.git
cd ai_workspace
./ops/install.sh --local
```

### Windows

Use WSL2 with Docker Desktop's WSL integration enabled. Install Git, Python 3 and OpenSSL inside WSL. Clone the repository inside your Linux home directory, such as `~/ai_workspace`, and run the same three commands from WSL. Run the Bash scripts in WSL, not PowerShell.

### Linux

Install Git, Python 3, OpenSSL, Docker Engine and Compose v2.24.4 or newer. Run the installer with `--local`. If your user cannot access Docker, use `sudo`. Docker access effectively grants administrative privileges.

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
- A domain such as `agents.example.com` pointing to the VPS, **or a static public IPv4/IPv6 address assigned to the VPS**. For a domain, configure the A record and, if present, a valid AAAA record. IP-only access needs no domain or DNS record.
- Inbound TCP ports 80 and 443 open. Keep SSH available for administration. PostgreSQL has no published port.
- A checkout path without spaces, for example `/opt/ai_workspace`.

```bash
git clone https://github.com/qavitalii/ai_workspace.git
cd ai_workspace
sudo ./ops/install.sh --server
```

Enter a domain or public IP without a scheme, port or path, set a password of at least 14 characters, and add TOTP to your authenticator. IPv6 can be entered bare or in square brackets; the installer formats the HTTPS URL correctly. If Docker is missing, the installer uses the official `get.docker.com` installer. Install Docker yourself on operating systems other than the supported Ubuntu/Debian setup.

Caddy obtains and renews the HTTPS certificate. Incorrect DNS or a blocked firewall will prevent certificate issuance; inspect the Caddy logs if necessary.

### Access without a domain

The same `--server` command accepts your VPS's public IP and prints the resulting `https://IP` address (`https://[IPv6]` for IPv6). Private LAN addresses, loopback, shared carrier NAT addresses and reserved addresses are rejected. Use an IP you control, with TCP ports 80 and 443 routed to this VPS; IPv6 access also requires IPv6 connectivity on the client. For an IPv6 address the installer publishes Docker ports on `[::]`; Docker's userland proxy must support forwarding these IPv6 connections to the container's IPv4 network (the standard Docker bridge configuration does).

For IP installations, the installer selects `ops/Caddyfile.ip`. It explicitly uses Let's Encrypt's `shortlived` ACME profile instead of Caddy's local certificate authority. [Let's Encrypt IP certificates](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability) last 160 hours; Caddy obtains and renews them automatically while running. The configuration also selects the public IP's certificate when a browser omits the TLS server name, as is usual for IP URLs behind Docker's port mapping. Certificate state is kept in the existing `caddy_data` volume. No separate certificate service or renewal cron job is needed.

Keep Caddy running, its data volume intact, and ports 80/443 reachable for renewals. The installer reporting started services does not mean certificate issuance has finished. Open the printed address and check `./ops/compose.sh logs --tail=100 caddy` if HTTPS is not ready after a few minutes. Do not bypass browser certificate warnings or switch production to HTTP. Issuance and renewal on your public IP must be verified on the actual VPS.

### Small servers (4 GB RAM)

For light workloads, 4 GB RAM is a reasonable starting estimate, not a benchmark guarantee. Before starting agent tasks, set **Settings → Resources → Maximum concurrent tasks** to **1**. Each agent is currently limited to 2 GB; the OS, application and database need the remaining memory. A modest swap file can cushion occasional peaks but does not replace RAM. Large builds may need more memory and a higher per-agent limit. The standard installer default remains three tasks for larger servers.

## 3. Configuration

The installer creates `.env` with permissions `600`. Do not commit it or include it in support requests.

| Variable | Purpose |
|---|---|
| `APP_ORIGIN` | Exact external origin, without a trailing slash, such as `https://agents.example.com` |
| `SITE_ADDRESS` | Caddy domain or public IP (IPv6 in square brackets); `:80` locally |
| `CADDY_CONFIG` | `Caddyfile` for domains/local use (default for existing installs); `Caddyfile.ip` for public IP HTTPS |
| `TLS_SERVER_NAME` | Public IP without IPv6 brackets, used to select the IP certificate when the browser sends no TLS server name; set by the installer |
| `HTTP_BIND`, `HTTPS_BIND` | Host interfaces for public ports, `0.0.0.0` by default or `[::]` for an IPv6 installation; the local override binds only `127.0.0.1:8080` |
| `NODE_ENV` | `production` for an HTTPS VPS; `development` for local testing only |
| `DATA_ROOT` | Absolute path on the Docker host; mounted at the same path inside the supervisor |
| `POSTGRES_PASSWORD` | Random database password; changing `.env` alone does not update an existing database user |
| `ENCRYPTION_KEY` | 32 random bytes in hexadecimal; do not rotate without migrating encrypted secrets |
| `MAX_CONCURRENT` | Default maximum concurrent tasks, 3 initially; any positive whole number. A value saved in Settings → Resources overrides this environment default |
| `OUTPUT_LIMIT_GB` | Initial shared saved-output budget in decimal GB, 1 by default (0.01–10000). After the first migration, change it in Settings → Resources |
| `WORKSPACE_PROXY_IP`, `WORKSPACE_SERVER_PROXY_IP`, `WORKSPACE_PROXY_SUBNET` | Dedicated proxy network: defaults `172.30.250.2`, `172.30.250.3`, `172.30.250.0/24`; change all three together if the subnet overlaps another network |
| `TRUSTED_PROXY_IPS` | Outside Compose, comma-separated explicit immediate proxy IPs; empty trusts none. Compose sets this to Caddy’s fixed address |
| `MAX_FILE_MB` | Maximum attachment size, 25 MB by default |
| `MAX_ATTACHMENTS` | Maximum attachments per message, 10 by default |
| `ENABLE_AUTO_HANDOFF` | `false` initially; see the provider verification guide |
| `VAPID_*` | Web Push keys and contact address, generated during installation |

Apply changes with `./ops/compose.sh up -d server caddy`. To change a domain, update `APP_ORIGIN`, `SITE_ADDRESS`, and DNS together. When switching to IP access or changing the public IP, set `APP_ORIGIN=https://IP`, `SITE_ADDRESS=IP`, `CADDY_CONFIG=Caddyfile.ip`, and `TLS_SERVER_NAME=IP`. For IPv6, wrap the address in square brackets only in `APP_ORIGIN` and `SITE_ADDRESS`, and set `HTTP_BIND=[::]` and `HTTPS_BIND=[::]`; use `0.0.0.0` for IPv4. Switching back to a domain requires `CADDY_CONFIG=Caddyfile` and host bindings that accept the address families in its DNS records. Existing `.env` files are never overwritten by rerunning the installer. To migrate local mode to a server, also set `NODE_ENV=production`, change `.install-mode` to `--server`, and use the server Compose configuration without the local override. Sign in again at the new address; browser notification permissions/subscriptions belong to the old origin and need to be enabled again.

The supervisor trusts forwarded client addresses only from the configured immediate proxy. Caddy overwrites `X-Forwarded-For` with its connecting client’s address, so login quotas are per client. An additional CDN/load balancer needs its own explicit trust configuration; do not enable blanket proxy trust.

For IPv6 forwarded through Docker's userland proxy to an IPv4-only bridge, the connecting address seen by Caddy may be the shared bridge gateway. In that case multiple IPv6 users share one login/global rate-limit bucket, so one client can temporarily exhaust another client's quota. This does not bypass authentication. Before relying on IPv6-only access, verify source-address preservation and independent login quotas from two external clients on the actual VPS. If addresses collapse, use the public IPv4 address or configure and verify native IPv6 networking; do not trust incoming forwarded headers to work around it.

For frontend/backend development outside Docker, use Node 22, your own PostgreSQL instance, `npm ci`, the variables from `.env.example`, and `npm run dev`. Docker is still required for agent containers. Set `APP_ORIGIN=http://localhost:5173` for Vite. Never use a production database for tests.

### Capacity and live resource usage

Open **Settings → Resources** to see CPU usage/idle percentage, used/available memory, workspace filesystem space, running tasks, queued tasks, and tasks waiting for an account. Samples refresh every two seconds while this panel is open. Disconnection retains the last sample with an explicit stale-data message.

**Maximum concurrent tasks** accepts any positive whole number, including 50 or more. Saving takes effect for new starts without restarting the server. The value is stored in PostgreSQL and survives restarts and backups. Lowering it does not interrupt running tasks: new starts wait until occupancy drops below the new limit. The initial default comes from `MAX_CONCURRENT=3`; once saved in the UI, the database value takes precedence.

**Saved agent output limit (GB, all chats)** sets one shared budget for responses, persisted activity, approval details and conversation summaries. The default is 1 GB (1,000,000,000 bytes); fractional values from 0.01 to 10000 GB are accepted. Usage includes UTF-8 payload bytes plus a 256-byte allowance per event, assistant message and approval. This is not a total disk quota: PostgreSQL indexes/WAL/physical overhead, project files, attachments, provider-native histories, backups and container logs use additional space.

Writes reserve capacity atomically across simultaneous tasks. If the next output cannot fit, that task stops with an explanation; raise the limit or delete old chats, then retry. Lowering the limit below existing usage keeps all history and blocks further growth. Existing installations are measured during migration, never purged. Completed streaming fragments are consolidated into their saved answer. Separately, the supervisor caps each runner event/frame at 1 MiB and each response at 4 MiB, waits for event processing before reading more, and bounds WebSocket buffering. Runner Docker logs rotate at 10 MB × 3 per container.

Each account still serves only one running task at a time. Increasing capacity does not create accounts, bypass provider quotas, or reserve CPU/RAM in advance. Each runner retains its configured CPU/RAM/PID limits. Size the server for your workloads and use the live metrics to observe actual usage. A 50-slot scheduler test is not a 50-container performance benchmark.

On Linux VPS deployments, metrics describe the runtime host and the filesystem containing `DATA_ROOT`. Available memory includes reclaimable cache. On Docker Desktop, CPU and RAM describe Docker's Linux VM, not the entire Mac/Windows computer. Shared-host filesystem capacity can be synthetic, so physical disk availability is shown as unavailable there; check the host operating system instead. No external monitoring service is required.

## 4. GitHub and agent accounts

Open [Create a fine-grained GitHub token](https://github.com/settings/personal-access-tokens/new), or go to GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens. Choose a name and expiration, select the repository owner, then **Only select repositories**. Select only the required repositories. Grant `Contents` and `Pull requests` read/write permissions. Click **Generate token** and paste the value into the project’s **Access token** field. GitHub only shows the value at creation. Organization-owned repositories may require administrator approval.

Each project has its own token. Supply it when connecting a repository, or use the project settings button / Settings → Connections to replace or remove it. There is no global token for new projects. Upgrading copies a previously saved global token into existing projects; it never applies it to newly created projects. Each token is encrypted in the database. It is not stored in Git remote URLs or provided to agent containers. Read-only Git inspection and commits run without GitHub credentials. Publishing exports a bundle into a fresh trusted repository before pushing with credentials.

For Codex, use Copy code and enter the device code on OpenAI's page. For Claude, open the URL shown by the official CLI and supply the browser code if requested. Never enter OpenAI or Anthropic account passwords into Workspace. Account sign-in is blocked while that account is executing a task.

Complete the [provider verification scenarios](provider-verification.md) before relying on unattended execution. Repeat them after changing CLI versions. Disconnect signs out through the official CLI and preserves account records, chats, files, and attachments. It is blocked during active tasks and permission waits. Failed or interrupted sign-out stays unavailable for scheduling and offers Retry disconnect; it does not claim the credentials were removed. Connect starts a new sign-in.

Create chat does not require a name or Git repository. Choose **Personal chat** for work outside a project, or create a **Files only** project for shared documents without Git. Project chats offer **Main folder**, **New working copy**, and **Existing folder** when one is available. A short title comes from the first message and can be changed in chat settings. Git diff and publishing actions are available only for repository chats.

**Delete account** removes the saved Workspace account and its local sign-in/session files after confirmation. Chats, messages and project files remain; select another account to continue. It does not delete your OpenAI/Anthropic account, cancel a subscription or revoke remote credentials. Stop active/queued tasks first and wait for sign-in, inspection or sign-out to finish. If cleanup fails, retry Delete account.

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

The backup script temporarily stops the supervisor to capture a consistent database and file checkpoint. **Active jobs are interrupted.** It automatically restarts the server afterward. The encrypted archive in `backups/` contains the database, all of `DATA_ROOT`, and configuration, including native CLI profiles, workspaces and attachments. Backups older than seven days are removed.

A root VPS installation creates `/etc/cron.d/ai-workspace-backup`, scheduled for **03:17 in the server's timezone**. Logs are written to `/var/log/ai-workspace-backup.log`. Local installation does not install a cron job.

**Copy `.backup-key` to a safe location outside the server.** Also copy archives to another disk or remote storage. Offsite upload is not included. A backup on the same VPS disk does not protect against losing that VPS.

### Working-folder data included in backups

| Under `DATA_ROOT` | Preserve together with the database |
|---|---|
| `workspaces/` | Main, saved, personal, copy and resolution working files |
| `workspace-git/` | Shared Git history, branches and linked-worktree metadata |
| `workspace-operations/` | Copy baselines, frozen reviews, resolution inputs and recovery journals/files |
| `workspace-checkpoints/` | Previous main folders saved before transfers |
| `uploads/`, `account-auth/`, `account-sessions/`, `shared/` | Original attachments, account sign-in files, per-chat native sessions and default connected folders |
| `profiles/` | Legacy shared account profiles, read once for migration; removed with the account |

Backing up only `workspaces/` is insufficient for linked worktrees and future transfers. Do not delete operation directories as temporary files: current baselines and unresolved reviews depend on them. Main-folder checkpoints and shared Git objects have no automatic retention cleanup. They can remain after a working copy is deleted. Restore the database and the entire data tree from the same backup; worktree links use stable container paths, so manage Git through the application rather than moving individual folders or repairing links on the host.

### Restore

1. Stop work. Create a current backup if possible.
2. On a new server, install Workspace first to create images, `.env`, and the database volume.
3. Copy the encrypted archive and the **original** `.backup-key` into the installation directory. Restrict permissions with `chmod 600 .backup-key`.
4. Run:

```bash
./ops/restore.sh /absolute/path/workspace-backup.tar.gz.enc --replace-existing
```

This explicitly replaces the installation's current data. The script retains the old `.env` and data directory for manual rollback; remove them only after verification. It preserves the current `DATA_ROOT` and the current database volume's password. Verify the domain/IP, `APP_ORIGIN`, `SITE_ADDRESS`, `CADDY_CONFIG`, `TLS_SERVER_NAME`, local/server mode, and interrupted jobs after restoration. A different VPS IP requires updating these values as described above; Caddy will obtain a certificate for the new address.

## 7. Updates

### From the browser on a Linux VPS

Open **Settings → Updates** to see the installed version and any available release. Select **Update to v…** to schedule it. Finish running tasks, respond to pending approvals, and close open terminals. Queued tasks resume after the update. The host updater builds both images, creates an encrypted backup, and restarts Workspace. The browser reconnects and displays the result.

New root-managed Linux VPS installations with systemd enable browser updates during setup. For an existing VPS, run this once from the installation directory:

```bash
sudo ./ops/update.sh && sudo ./ops/enable-browser-updates.sh
```

If you already use the connected-folders override, perform your manual update with the same [Compose files](#9-files-and-connected-folders) before running the enable command. The host updater preserves this override. Docker Desktop and custom Compose setups use the manual update command.

The host checks the checkout's Git `origin` about every ten minutes. Browser updates use stable tags in the form `vX.Y.Z` that match the release's `package.json` version and can fast-forward the installed checkout. Publish these tags only for tested releases you intend to offer through the button. Workspace installs the release selected by the owner.

For updater details, use `sudo journalctl -u ai-workspace-updates.service`. If activation fails, the updater attempts to restart the previous code and images. If the new release changed the database incompatibly, recover using the matching code version and the pre-update [backup](#6-backups).

### Manual updates

```bash
./ops/update.sh
```

A clean Git checkout is required. The script creates a backup, runs `git pull --ff-only`, builds both images, and recreates the services. CLI versions are pinned in the Dockerfile and do not update themselves inside running containers.

Read project release notes before updating. Rebuild both server and runner: the new folder helper is bundled into the runner image. Schema migration preserves existing working files and attachments in place; old folders keep their storage format. Existing projects without a main folder require an explicit selection in Project settings. New copies select Git worktrees or ordinary directories automatically. For an incompatible downgrade, restore the matching backup and code version together.

## 8. Troubleshooting

| Symptom | What to check |
|---|---|
| Docker socket permission denied | Docker Desktop is running; on Linux check user permissions or use `sudo` |
| Port 8080 is already allocated | Change the port in `compose.local.yaml` and `APP_ORIGIN` together |
| `Origin not allowed` | Open the exact `APP_ORIGIN`; localhost and 127.0.0.1 are different origins |
| TOTP is rejected | Correct clock on server/phone; the same code cannot be reused |
| HTTPS does not work | Correct domain/IP, DNS A/AAAA for domains, ports 80/443, `./ops/compose.sh logs caddy`; for IP access check `CADDY_CONFIG=Caddyfile.ip` and `TLS_SERVER_NAME` |
| Runner image is missing | Run `./ops/compose.sh build runner-image` |
| GitHub returns 403/404 | PAT repository access, organization approval, correct owner/repository |
| A chat remains queued | Selected account is connected and idle, capacity is available, and no task, terminal or folder operation is using its working folder; also check writable connected folders |
| Transfer says the review is out of date | Refresh the review; source/main files or the copy baseline changed |
| Resolution cannot transfer yet | Finish the resolution chat; all conflict paths must be acknowledged and markers removed. Review still does not guarantee semantic correctness |
| Cannot delete a source copy | Finish or delete its dependent resolution folder first; stop queued/active tasks and close terminals |
| Git writes fail inside a worktree terminal/agent | Shared Git metadata is intentionally read-only there; use the app’s Git actions for commit/push/PR |
| Claude sign-in is waiting | Open the URL from the native CLI and provide the code if requested |
| Job interrupted after reboot | Expected behavior: inspect files and resume explicitly |
| Low disk space | Settings shows free space; inspect `docker system df`; do not remove the database volume |
| No push notifications on iPhone | Use HTTPS, install on the Home Screen, and grant notification permission |

Check configuration with `./ops/compose.sh config --quiet`. Plain `docker compose config` can print resolved secrets; do not share its output.

## 9. Files and connected folders

For files that belong to a message, use the paperclip, drag/drop, or image paste. Submitted originals are mounted read-only at `/attachments`; agents save edited copies in their working folder. Deleting a chat detaches and preserves its originals in the folder’s attachment library. They are not automatically shared as working files: use the library’s save action to copy them into the folder. Upload directly through a working folder’s **Files** panel when other chats in that folder should see the file immediately.

For reusable data, open **Chat settings → Folders** or **Project settings → Folders**:

1. Select an existing server folder, or create a named folder.
2. Choose **Upload files** or **Upload folder**. Directory uploads retain relative paths. Each file uses `MAX_FILE_MB`; archives are not extracted. Browsers without directory selection can upload individual files. Uploads report progress, never overwrite different existing files, and safely skip identical files when retried.
3. Choose **Read only** (default) or **Read & write**, then **Connect folder**. To change access later, select the same folder, choose the new mode, and connect again.

The agent and terminal see `/workspace/.workspace-folders/<name>`. Project folders are inherited by all its chats. Chat folders apply only to that chat. **Browse** lists and downloads files. **Disconnect folder** removes access without deleting data. Stop tasks and close terminals before changing connections or uploading into a folder in use. Chats sharing a writable folder run one at a time; read-only readers can run together. A waiting chat remains queued until the folder is available. In working-copy and resolution chats, connected folders are always mounted read-only, even if their connection allows writes in the main folder.

By default, folders live under `DATA_ROOT/shared` and are included in encrypted backups. To make an existing folder available, place it directly under that directory (for example `shared/assets`). Use ordinary directories, not symbolic links. On Linux, UID 1000 must have read access, plus write access for uploads or writable connections. Workspace never recursively changes ownership of existing folders.

To use an existing collection elsewhere on the server, put `FOLDER_ROOT=/srv/agent-files` in `.env`, then add the optional override:

```bash
# Linux VPS
./ops/compose.sh -f compose.yaml -f compose.folders.yaml up -d --wait
# Local Docker Desktop (include the local ports/HTTP override)
./ops/compose.sh -f compose.yaml -f compose.local.yaml -f compose.folders.yaml up -d --wait
```

Keep this override in subsequent Compose commands. For the manual update script on a VPS, set `COMPOSE_FILE=compose.yaml:compose.folders.yaml` in the installation's `.env` so its backup and restart use the same files. On local installations with this override, run the backup, fast-forward pull, build, and restart steps with the same three Compose files. Each direct subdirectory appears in the folder picker. The path must be shared with Docker Desktop when running locally. Only selected subfolders are mounted into agents; the supervisor needs the collection mounted at the identical absolute path. Choose a dedicated data directory, not your home directory, system directories, Docker socket directory, or Workspace's private credential/database directories. External collections are **not** part of the built-in backup and need their own backup. Files on a laptop are copied to the server by upload; keeping a laptop folder live requires a separately configured sync service.

## 10. Models, commands and references

Select **Model** and **Reasoning effort** while creating a chat, or use the model button above Send / `/model` before the next task. The Codex model catalog loads automatically when an account is selected. **Refresh models** requests a new catalog; concurrent requests share one lookup, and a per-account one-hour cache avoids launching another CLI on every visit. A cached catalog remains available during an active run; refresh waits until the account is idle. Sign-in/sign-out clears the cache. Codex model metadata determines advertised reasoning levels when available. Blank/default delegates selection to the official agent. Claude aliases are offered as convenience values; support depends on account and model. Changes are blocked while a task is active.

The composer offers keyboard and touch suggestions: `/` for commands specific to the selected agent, `@` for workspace paths and connected folders, `$` for workspace `SKILL.md` files. Arrow keys select, Enter inserts/executes, Escape closes; Ctrl/Cmd+Enter sends. `/help` lists the supported commands. File/skill references become explicit paths in the prompt. Indexing skips symlinks, Git internals, dependency/build folders and scans at most 5,000 entries to depth eight. Repository files appear after checkout initialization. Unknown commands are rejected instead of silently spending a model turn as plain text. Native command selection inserts a draft; press Send to run it. `/help` also explains commands not yet available in this integration.

| Commands | Codex | Claude Code |
| --- | --- | --- |
| `/plan` or `/plan task description` | Native App Server plan collaboration mode, read-only execution sandbox | Native CLI plan permission mode |
| `/model`, `/permissions`, `/rename`, `/status` | Workspace controls | Workspace controls |
| `/compact` | Native session compaction; requires an existing session with this account | Available when reported by the native session |
| `/review [instructions]` | Native review of uncommitted changes, or a custom review | Only if the native session advertises a command with this name |
| `/diff`, `/mention`, `/new` | Changes panel, file references, new chat | Use Files or New chat controls |
| `/clear`, `/usage` | Use New chat or `/status` | New chat (preserves history); provider-reported usage |
| `/context` and workspace/custom commands | Not exposed | Added from the CLI’s `system/init.slash_commands` after the first message |
| `/skills`, `/resume`, `/files`, `/terminal`, `/settings`, `/stop`, `/help` | Workspace actions | Workspace actions |

Plan mode persists across turns. The composer shows **Plan mode** and **Switch to execution**; switching is blocked while a task is active. Planning questions are saved as pending requests and can be answered after reconnecting, including from a phone. Stopping or restarting expires pending requests. Claude may request explicit permission to exit planning during a run. Replies to secret questions are sent to the agent without being copied to the event log.

The web interface does not provide every interactive terminal command. Native session forks, terminal themes and account-wide app mentions are not implemented here. Claude commands are discovered per chat and forwarded only when advertised; availability may change with CLI versions. Codex plan mode uses the experimental collaboration API of the pinned CLI version. See [Codex App Server](https://developers.openai.com/codex/app-server) and [Claude SDK skills and commands](https://code.claude.com/docs/en/agent-sdk/slash-commands).


### AWS access and portable skills

In **Project settings → AWS access**, enter the AWS-hosted SSO start URL or Issuer URL, the Identity Center region, the 12-digit AWS account ID and your permission set name. Use the optional AWS region when it differs from the SSO region. Select **Continue to AWS**, open the sign-in link and enter the displayed code. Workspace verifies the AWS account after sign-in. See the [AWS CLI setup guide](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html) for where to find these values. Your organization must allow device authorization.

AWS CLI v2 is included in the server and runner images. The server stores the sign-in session encrypted and prepares temporary role credentials for each new agent run or terminal in that project, including working copies. AWS CLI and SDKs can use the default profile. A long-running task or terminal may need a fresh run when its credentials expire. Use **Check access** or **Sign in again** in project settings. **Disconnect** stops Workspace from issuing credentials to new runs. Stop active runs and terminals to remove their access within Workspace. AWS decides when already-issued credentials expire.

Use a dedicated permission set with only the permissions this project needs; start with read-only access. Agents and terminals receive every permission granted by that role. Approval prompts and instructions to ask before remote changes do not restrict AWS permissions.

**AWS availability** defaults to **Optional**. If an existing session expires or AWS cannot issue credentials, new tasks and terminals continue without AWS access and display a warning; the agent is told not to attempt AWS work. Sign in again and start a new run when AWS is needed. Choose **Required** to block new tasks and terminals whenever AWS access cannot be prepared, including before the first sign-in or after Disconnect. Changing this choice preserves the saved sign-in session. Internal storage/database failures and concurrent connection changes still stop startup.

To move local skills, open **Settings → Skills** for all chats or **Project settings → Skills** for that project and its working copies. Select a skill folder, a parent folder containing several skills, or a ZIP. On macOS, use **Go to Folder** (`⌘⇧G`) in the picker to reach hidden folders such as `~/.codex/skills` or `~/.claude/skills`. Review the preview and decide whether to skip, replace or keep both versions of a skill with the same name. Select any imported skills in the library and choose **Export selected** to download a ZIP that can be imported into another Workspace.

Workspace keeps each `SKILL.md` and its supporting files together. Each library holds up to 50 skills, 500 files and 20 MB of file contents. Imported directories are available read-only in new agent runs and terminals. The `$` menu lists both imported skills and working-folder skills. Review any dependency hints in the preview and set up tools, plugins and accounts separately. Common local credential files are skipped. Check the scripts and notes for inline secrets before sharing them.

Select imported skills through `$`; importing does not register them for automatic discovery by the native CLI. Descriptions come from the YAML frontmatter at the beginning of `SKILL.md`, including folded (`>`) and literal (`|`) multiline text. Invalid frontmatter is rejected with an import error.

### Reviewing and publishing Git changes

The Changes panel opens a local, read-only preview without contacting GitHub or reserving the folder. It remains available while a task is running, so the displayed files may change. New files are listed separately. Choose **Prepare commit review** when the folder is idle to inspect the complete proposed commit, including new files, then enter a message and select **Commit**. Preparing a commit review does not require GitHub access.

For publishing, choose **Outgoing commits → Review outgoing commits** to compare the committed history with GitHub. Inspect the result before selecting **Push** or **Create PR**. Push does not require a message; Create PR requires a title. Preparing a review briefly reserves the folder. Any subsequent change to the files, commits or destination invalidates that review and requires a new one before publication.

## 11. Working folders and conflict resolution

A chat stores the conversation; its selected working folder stores the files. **New chat** beside a folder starts another conversation using that folder. It does not create another copy. The new-chat form defaults to main, or to the existing folder when launched from that folder’s card.

| Choice | Practical use | File behavior |
|---|---|---|
| **Main folder** | Continue shared work or make a small sequential change | Chats see the same files; one active task at a time |
| **New working copy** | Let one agent update the homepage while another works on navigation | Starts from current main files; edits stay separate until reviewed and transferred |
| **Existing folder** | Continue an earlier task or inspect a preserved legacy folder | Reuses that folder and its current files |

For Git checkouts, new copies are linked worktrees with separate branches in a managed shared repository. The main checkout's Git metadata is preserved. Without Git, the app copies ordinary directories. Neither mode automatically synchronizes later main/copy changes. Dependencies, build output, local credentials, `.env` files (except example/sample/template files) and app-internal paths are excluded; inspect the exclusion list on the folder card. Git history may still contain previously committed files. External services/databases remain shared. Parallel tasks need separate available accounts and sufficient capacity.

To transfer completed work:

1. Open **Review changes** on the copy. Inspect the main version and proposed result. Compatible edits combine automatically.
2. For conflicts, choose a version manually or select an account and **Resolve with agent**. This prepares a separate resolution folder and queues a chat; the main and original copy are preserved. The agent is asked to combine both intentions, run checks and explain its decisions. It may need clarification for ambiguous decisions.
3. When the agent finishes, open the project and **Review changes** on the **Resolve · …** folder. Finish any incomplete resolution in its chat. If main changed in the meantime, the review compares against current main again. A resolution folder does not spawn another resolution folder automatically.
4. Select **Transfer to main folder**. This updates working files and saves the previous main folder for recovery; it does not commit, push or publish. Use separate Git actions when desired. If the original copy has already been transferred since resolution began, start a fresh resolution from its latest review.

A source copy remains available after transfer. Later edits in it remain new changes. If creation of the copy succeeds but creation of the chat fails, the form retains that copy: retry **Create chat** to reuse it.

**Delete folder** is available for non-main folders. It permanently removes that folder, its linked chats and original attachments after confirmation by name. Transfer anything needed first. Main, connected folders and previous main-folder recovery copies are preserved. To keep the folder and files, delete only its chat. A copy with an unfinished dependent resolution cannot be deleted until the resolution is completed or removed. Whole-project deletion with a “keep files” option is not implemented.

## SSH servers and keys

Open **Settings → Servers & SSH keys**. Create an Ed25519 key or import an OpenSSH Ed25519, RSA or ECDSA private key. For an encrypted key, enter its passphrase once. Workspace normalizes and encrypts the key with the installation's `ENCRYPTION_KEY`; it does not save the passphrase or offer private-key export. Hardware keys, SSH certificates, jump hosts and password login are not supported in this version.

Copy the public key and add it as a new line to the intended remote user's `~/.ssh/authorized_keys`, preserving existing entries. On that server, the directory should have mode `700` and the file mode `600`, owned by that user. Create a server entry with its address, port, username, SSH alias and key. The address must be reachable from the Workspace Docker network; `localhost` means the temporary container itself, not your laptop or the Workspace host.

Use **Review fingerprint**, compare the displayed fingerprints with a trusted server console or administrator, then select **I verified these fingerprints**. A network scan alone does not authenticate the server. You can obtain fingerprints on the server with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` (and the corresponding RSA/ECDSA public files if present). Use **Test connection** after confirmation. It authenticates and runs only `true`; it does not install keys or edit remote files. Results include the time and distinguish authentication rejection, identity changes, DNS failures, refusal and timeout. A changed address or port clears stored trust; changed server keys require a new review.

Select servers in **Project settings → SSH server access** or in a personal chat's settings, then click **Save SSH access**. Project chats inherit these connections, including saved folders and working copies. Within a connected chat, the agent and terminal can use `ssh production 'command'`, `scp file production:/path/` and `sftp production`, replacing `production` with your alias. Project chats display inherited access; edit it at the project level. Remote changes are shared across working copies. SSH permissions come from the remote user: planning mode and a read-only local folder do not make the remote server read-only.

Stop queued/active tasks and close affected terminals before editing/removing connections or changing their assignments. Wait for connection checks to finish. Deleting a server removes Workspace assignments but keeps its saved key. A key cannot be deleted while a server references it. **Neither action removes public keys from remote `authorized_keys` files or revokes other copies of a key**; remove those remote entries yourself when retiring access. Already-started remote processes may continue after a chat stops.

The agent receives an isolated authentication socket for its current run, never a private-key file. The helper holds assigned identities in memory with destination constraints tied to confirmed host keys and usernames. Configuration and public keys reside in a disposable Docker volume; private working files use memory-backed storage. Per-run provider profiles, Git helpers and sign-in/model-inspection sessions do not receive these credentials. SSH helpers disable Docker output logging, and cleanup removes helpers and socket volumes after stop or supervisor recovery. No private keys or passphrases are placed in command arguments.

Back up the database and `.env` using the existing encrypted backup procedure: the SSH key ciphertext is in the database and requires the original `ENCRYPTION_KEY`. Restoring that backup restores saved SSH access, so review assignments after recovery. Rebuild **both server and runner images** when upgrading to this feature; the older runner lacks the SSH helper. Existing installations start with no SSH keys or assignments. No provider-account login or remote access is required for migration.

To run isolated SSH tests (in addition to the disposable PostgreSQL and runner tests in [Contributing](../CONTRIBUTING.md#integration-tests)):

```bash
docker build --target runner -t ai-workspace-runner:ssh-tests .
docker build -f tests/fixtures/sshd.Dockerfile -t ai-workspace-sshd:tests .
SSH_DOCKER_TESTS=1 RUNNER_IMAGE=ai-workspace-runner:ssh-tests npm test
```

The SSH tests create temporary keys, SSH targets and authentication helpers, verify SSH/SCP/SFTP and rejection of unassigned destinations, and clean them up. Add `INTEGRATION_TESTS=1` and the disposable `DATABASE_URL` to include actual runtime/terminal access and database/API tests. On Docker Desktop, set `DOCKER_HOST` as described in Contributing if necessary. These checks use synthetic credentials; they do not sign into Codex/Claude or touch real SSH servers.

## Project MCP servers and plugins

Open **Project settings → MCP servers & plugins**. Add an HTTPS Streamable HTTP endpoint, choose Codex, Claude, or both, and optionally supply a bearer token. Use an endpoint without credentials or query parameters. Workspace encrypts the token and excludes it from the settings response. Disable or remove an entry to change the next run in that project, including a new turn in an existing chat.

For a Codex plugin, put the local marketplace catalog at `.agents/plugins/marketplace.json` in the working folder along with the plugin source. Enter its identifier, for example `docs@my-marketplace`. For a Claude plugin, put the native plugin in the working folder and enter its directory, for example `plugins/docs`. Each working copy needs the referenced files. Select trusted plugins because their tools and hooks execute with the agent's permissions. Existing projects start with an empty list.

This release supports HTTPS MCP servers with optional bearer authentication and plugins supplied by the project. Interactive OAuth, stdio server configuration and marketplace browsing are outside this release.

# Architecture

## Services

- **Caddy** handles HTTPS and WebSocket reverse proxying. The local override publishes only `127.0.0.1:8080`.
- **Fastify supervisor** owns the API, owner sessions, PostgreSQL queue, Docker lifecycle, GitHub operations, and event persistence.
- **PostgreSQL 16** stores the owner, sessions, accounts, projects, chats, messages, attachments, jobs, approvals, events, and idempotent publishing operations.
- **Runner containers** execute the official CLIs as UID 1000 with no capabilities and `no-new-privileges`. Each mounts its persistent working folder (possibly shared by several chats), a fresh per-run account profile (see [Account profiles](#account-profiles)), read-only original attachments at `/attachments`, and explicitly connected shared folders. Memory, CPU and PID limits apply. Planning, terminal and account-management containers have a read-only root filesystem. Execution tasks have a disposable writable root filesystem for [system packages](#system-packages). Runners have no Docker socket or control-network access.
- **Helper containers** inspect files and execute Git commands. Agent-controlled repository configuration never runs directly on the supervisor. Authenticated pushes use a fresh trusted repository populated from a credential-free bundle export.

One supervisor owns the installation. A PostgreSQL advisory lock prevents another replica from stopping live containers during recovery. Queue claims use transactions and partial unique indexes to enforce exclusive chat/account use. Each claim reads the persisted concurrency setting under the same advisory lock used by capacity updates; the environment value is only the initial fallback. There is no three-task ceiling. Workspace leases serialize agent work, terminal access, uploads, initialization and publishing by working-folder ID, across all its chats. Active tasks including approval waits exclude other tasks in that folder; queued tasks wait without blocking independent folders. The CLI uses stdin/stdout independently of browser connections.

## Persistence

`DATA_ROOT/workspaces/<workspace-id>` contains persistent working folders, optionally Git checkouts/worktrees; `workspace-git/<main-id>` holds shared Git metadata; `workspace-operations/<operation-id>` holds baselines/reviews/resolution inputs; `workspace-checkpoints/<review-id>` holds pre-transfer main folders; `account-auth/<account-id>` holds only the provider sign-in files; `account-sessions/<account-id>/<chat-id>` holds that chat's native session transcripts; `run-profiles/<run-id>` is the disposable `/profile` of one run; `profiles/<account-id>` is the former shared profile, read once for migration and never mounted; `uploads/` holds original attachments. UUID storage names prevent user filenames from becoming arbitrary paths. Archives stay opaque files. Messages and uploads each carry a `client_id`, so retrying after a network interruption does not duplicate work.

Working folders are records in `workspaces`; chats refer to them using `workspace_id`. New projects have a main folder and new project chats share it by default. Personal chats create a folder or can continue in an existing personal folder. Existing project chats migrate into named saved folders with their original IDs, branches and initialization state. Migration changes only database records: no working files, ignored files, original attachments or interrupted checkout directories are moved, merged or deleted. Existing projects choose their main folder explicitly (promote a saved folder in place or start from the repository). Promotion does not retarget other chats. Migration is transactional and repeatable.

Deleting a chat removes conversation history and detaches its original attachments; it never deletes a working folder or uploaded originals. Folders remain available on the project/home page even when their last chat is deleted. The folder's attachment library offers downloads and an explicit copy into the working files. Unsent attachments can still be removed explicitly. Runners mount only their own submitted attachments read-only; they no longer clear or rebuild `.workspace-attachments` inside the shared folder. Legacy copies in that directory remain untouched.

The Files panel uploads into the selected working folder, while the composer paperclip attaches to a conversation. Uploads stage outside the working directory, acquire its durable lease and use the isolated helper. Different existing content is never overwritten; identical retries succeed. Folder uploads reject internal paths and directory symlinks. Initialization also holds a lease (or the scheduler's exclusive active job), refuses to replace an unexpected nonempty directory and preserves abandoned initialization directories. File browsing is read-only and may observe in-progress agent changes; refresh after a task finishes.

Independent `copy` folders retain `source_workspace_id` and an immutable `base_snapshot_id`. They are created under a main-folder lease by the offline, unprivileged `folder-helper`; filesystem traversal never runs with supervisor privileges. For Git folders, a HEAD bundle imports history into `workspace-git/<main-id>` (a managed bare repository), then `git worktree add` creates a separate branch and working tree. A baseline commit records the selected actual files, including untracked/ignored user files outside explicit exclusions. An unborn repository gets an empty starting commit only in the managed repository. Main Git state is unchanged. Non-Git folders are copied without initializing Git. New metadata is additive: legacy folders are not migrated, moved or deleted. Worktrees use stable container Git-file paths and locked registrations because sibling trees are intentionally not mounted. A per-repository advisory lock serializes trusted Git writes; trusted commands explicitly select their own Git directory, independent of the agent-writable `.git` pointer. Agent sessions mount common metadata read-only with optional Git locks disabled; file editing and read-only Git inspection work, while commits/publishing use the app’s trusted Git actions. Deletion removes only the selected worktree registration and branch, never global worktree pruning. Shared Git object storage remains until administratively reclaimed. Symlinks are copied as links without traversal. Connected folders are forcibly read-only in copy runners, regardless of their original link permissions; shared read-only consumers can run concurrently. External writers/services are not covered by these locks.

Reviews acquire both folder leases atomically, snapshot copy/main and compare them against the immutable base. Nonoverlapping UTF-8 edits merge with `git merge-file`; binary/large-text, mode, delete/modify and file/directory conflicts require explicit choices or agent resolution. File hashes include type, content/link target and permission bits. Apply validates both hashes and the baseline again. It builds a complete prepared main tree in an offline helper, overlays only reviewed paths (preserving excluded files), then journals `applying` before renaming the original main to `workspace-checkpoints/<review-id>` and installing the prepared directory. Git history/index remain unchanged. On success the copy snapshot becomes the next baseline. Choosing main acknowledges that copy proposal without rewriting the copy. Repeated apply is idempotent; superseded reviews are discarded.

Agent resolution pins the source review (`resolving`) and creates a new copy with `resolution_source_id`, `resolution_review_id` and `resolution_operation_id`. Its baseline is the frozen main snapshot; compatible edits are premerged and text conflicts receive explicit markers. Base/main/copy inputs and a conflict manifest are mounted read-only at `/merge-input`. The ordinary jobs queue runs the selected account with normal approval behavior. The visible chat message is a short task description; the worker appends technical resolution instructions on each turn while `resolution_operation_id` remains set. The agent is instructed to write a `.workspace-resolution.json` receipt listing resolved paths and checks; this internal file is excluded from transfers. Review reports incomplete receipts/remaining markers and apply revalidates them. Transfer locks the original source as well, rejects an already-advanced original baseline, then advances both baselines atomically after the main-directory swap. Later edits in the original copy remain new deltas. Main changes made during resolution are merged/reviewed normally. Unfinished resolution folders pin their source against deletion; deleting them unpins the source review. Nested resolution jobs are not created automatically. Validation checks the `resolved_paths` list and remaining markers, not whether the reported tests actually ran or passed. These checks do not certify semantic correctness; the user reviews the agent’s result and test report.

`workspace_operations` journals creation, resolution, transfer and deletion. Non-ready states prevent new chats/tasks/leases; startup recovery runs after stopping orphan containers and before scheduling. An interrupted transfer restores the original main and retains the unconfirmed result for inspection. Failed creations stay visible for removal. Folder deletion marks the folder unavailable, moves it into the operation directory, then transactionally removes linked conversation records and originals; failure before that commit restores the folder, and committed filesystem cleanup retries at startup. Main checkpoints survive copy deletion. A checkpoint can be restored administratively with the app stopped, preserving the current main directory first and moving the checkpoint back to `workspaces/<main-id>`; there is no automatic rollback of remote operations. Keep checkpoints and operation snapshots in backups; checkpoint retention is currently manual.

Account deletion marks an account unavailable under the scheduler lock, removes `account-auth/<id>`, `account-sessions/<id>`, the legacy `profiles/<id>` and `auth-workspaces/<id>`, clears preferred-account/native-session references and historical job foreign keys, then removes the account row. Chats, messages and working folders remain. Active/queued work and sign-in/inspection/sign-out block deletion; interrupted credential cleanup resumes at startup. Failed cleanup keeps an unavailable account with a retry action. No provider account/subscription deletion or remote token revocation is performed.

Saved legacy folders remain independently usable; they cannot be transferred without a baseline. The old `chats.branch` and `chats.initialized` columns remain for migration compatibility; runtime operations and API projections use the working folder's authoritative values.

Projects with `repo=''` are files-only projects and initialize an ordinary main directory without Git. Copy creation detects Git in the initialized source folder. `storage_mode` distinguishes `legacy`, `folder`, and `worktree`; `git_source_id` identifies the managed shared repository for worktrees. Old folders retain `legacy` without a filesystem conversion.

Chats accept a null project and an omitted title. Unnamed chats receive a short title from the first nonempty message; manually named chats are preserved. Tokens belong to projects, are encrypted, and are excluded from API projections. Existing global credentials migrate only into existing projects.

## System packages

An execution task starts a local installer broker before dropping the agent CLI to UID 1000 and clearing its capabilities. The broker serializes requests over a Unix socket and accepts exact Debian package names. Apt uses the image's signed Debian repositories and a private working directory. The broker and its child processes run under a Landlock file-access policy that confines package reads and writes to container system paths, keeping the working folder, account profile, attachments, credentials and shared temporary directory out of those paths.

The installer requires Landlock ABI 3 or newer in the Docker host kernel. When the policy cannot start, the unprivileged agent can still execute tasks with the bundled tools. Before downloading packages, the installer estimates archive and unpacked dependency sizes against a 1 GiB cumulative budget per run and checks available space on the Docker filesystem. It reserves 512 MiB plus one run's budget per other execution slot, counting already active jobs if they exceed the configured limit. This preflight uses package metadata and a snapshot of free space. Successful requests appear in the task log.

Installed files live in the disposable runner container. For project chats, the server also remembers the requested package names in PostgreSQL unless automatic remembering is off. The project settings expose the list and its first successful request, including the source chat when it is still available. Manual additions and removals edit the saved list.

## Project tools

`DATA_ROOT/project-env/<project-id>` backs the `/env` mount shared by project chats, terminals and working copies. The runner adds project tool directories to the end of `PATH` and places supported user-level installations and caches under `/env`. Planning and read-only operations mount it read-only. Personal chats and account-management containers have no project environment.

Before a writable start, a restricted helper measures the directory. If usage is over the configured per-project limit or measurement fails, that session can read existing tools. Workspace checks the limit at session start, so an active session retains its original mount permissions. Clearing tools checks active jobs and terminals under the scheduler lock, invalidates cached usage and detaches the project's directory. Startup retries any unfinished deletion of detached files.

## Account profiles

An agent can be prompt-injected, so `/profile` is not persistent agent-writable state. Before each run the supervisor creates `run-profiles/<run-id>`, copies in the account's sign-in files and, for chat runs, that chat's stored session transcript, and mounts it at `/profile`. Once the container is removed (or its processes have exited), the supervisor:

- copies back only `.claude/.credentials.json` (the `claudeAiOauth` entry), `.claude/.claude.json` (account identity and onboarding flags only) and `.codex/auth.json` (known credential fields only), and only when the run changed them, the content has the expected shape and the stored file has not changed since the run started (compare-and-swap). A removed file (sign-out) is removed from the store. Outside sign-in, a Codex sign-in file must keep the stored account id, mode and API key (a refresh changes only tokens), and a Claude state file naming a different account is rejected together with its credentials;
- keeps the transcript of the chat's current native session (Claude under `.claude/projects/-workspace/<session-id>`, Codex rollouts under `.codex/sessions` and `.codex/archived_sessions`) for that chat and account, unless a later run of the chat already saved a newer one;
- deletes the run directory. Settings, hooks, `CLAUDE.md`/`AGENTS.md`, skills, plugins, Codex config, memory files, shell files and caches written during a run never reach a later run.

Copy-back never follows symlinks and skips special files. If a container cannot be removed, its run directory is left alone and finished by a later startup recovery; recovery also finishes runs interrupted by a restart, so a refreshed token is not lost. Sign-in and sign-out report success only after their copy-back was saved. Existing installations migrate on first use: sign-in files are imported once from the former shared `profiles/<id>` (sanitised the same way), and a chat's native session is imported from it the first time that chat runs. That directory is never mounted again and is removed with the account. Owner-chosen skills, plugins and MCP servers keep coming from the database for each run. Deleting a chat or its folder removes its stored transcript; startup also removes transcripts of chats that no longer exist.

Residual risks, by design:

- The sign-in files are still written by the run. An injected agent can sign the account out, or replace Claude credentials with another account's tokens (Codex's account id, mode and API key and Claude's `oauthAccount` are checked; the tokens themselves are not verified with the provider, so the check is best-effort). Re-sign in if an account behaves unexpectedly.
- A native transcript can carry injected text into later turns of the same chat, invisible in the Workspace UI. Switching account or starting a new session in that chat drops it. Transcripts imported from the former shared profile could have been modified by any chat of that account.

Native session resume is used only for the same account. Switching clears the native session ID but preserves the visible chat ID, files, messages, attachments, and checkpoint. The new agent receives context and an instruction to inspect actual files and command outcomes. A `handoff` event explicitly identifies the transition.

Checkpoints are updated at completed tool boundaries and periodically while text is streaming. They are bounded context extracts, not a guarantee of identical hidden model state. Provider quota errors are handled separately from command failures, permission requests, and transport failures.

Approval requests persist their redacted action arguments in `approvals.details`, keyed to the native request ID. The permission card shows these arguments after reload; requests without details can be denied but cannot be allowed. Worktree pointer reads use no-follow, nonblocking opens and bounded reads before accepting only the expected regular file.

`output_storage` holds the persisted shared output budget and usage counter. Transactional triggers account for events, assistant messages, approvals and chat summaries, including updates/deletions; a failed reservation rolls back the write. Runtime consumption awaits each handler directly, with bounded Docker frame/JSON-line parsing and response accumulation. On termination, accepted deltas are compacted into the assistant message. Job finalization and pending-request denial still happen when output storage is full; an ephemeral WebSocket refresh signal updates clients even when a status event cannot be persisted.

## Main API

All `/api/*` routes except `/login` and `/health` require an HttpOnly session cookie. Mutating requests also require an exact `Origin` matching `APP_ORIGIN`. WebSockets validate the session and Origin.

| Route | Purpose |
|---|---|
| `POST /api/login`, `POST /api/logout` | Password + TOTP, session, sign-out |
| `GET /api/overview`, `GET /api/search` | Projects, chats, accounts, history search |
| `POST /api/projects`, `PATCH /api/projects/:id` | Connect a GitHub URL/`owner/repository`, or create a files-only project with `name` and empty/omitted `repo`; rename and manage project-specific tokens |
| `GET /api/projects/:id/workspaces`, `POST /api/projects/:id/main-workspace` | List persistent folders; explicitly choose the main folder (`workspace_id`, or null for a fresh main folder) |
| `GET /api/projects/:id/environment`, `POST /api/projects/:id/environment/clear` | Check project tool disk usage, optionally with `refresh=1`, and clear tools when idle |
| `POST /api/workspaces/:id/initialize` | Prepare the selected folder under an exclusive lease |
| `POST /api/workspaces/:id/sync` | Sync the selected Git folder from its project’s GitHub base branch under an exclusive lease |
| `GET/POST /api/workspaces/:id/files`, `GET /api/workspaces/:id/file` | Browse, upload and download working files independently of any chat |
| `GET /api/workspaces/:id/attachments`, `POST /api/workspaces/:id/attachments/:attachmentId/save` | Original attachment library and explicit copy into working files |
| `POST /api/accounts` | Create a Codex or Claude account record |
| `POST/GET/DELETE /api/accounts/:id/auth` | Begin, observe, or cancel native sign-in |
| `POST /api/accounts/:id/auth-input` | Supply the browser code for Claude sign-in |
| `POST /api/accounts/:id/logout` | Native CLI sign-out with an exclusive account lease; keeps chats and files |
| `POST /api/accounts/:id/models` | Read the adapter's model catalog |
| `POST /api/chats`, `GET/PATCH /api/chats/:id` | Create with optional `workspace_id` (project main by default), read, or configure a chat |
| `PATCH /api/chats/:id/title`, `DELETE /api/chats/:id` | Rename or delete an idle chat conversation; retain its folder and original attachments |
| `PATCH /api/chats/:id/model`, `/permissions` | Update model/effort or approval mode |
| `POST /api/chats/:id/mode` | Switch planning/execution mode |
| `GET /api/settings/models`, `POST /api/settings/models/:provider` | Read and save provider defaults for new chats |
| `POST /api/settings/environment` | Set the storage limit in GiB for each project's tools |
| `POST /api/accounts/:id/usage` | Refresh reported account limits |
| `POST /api/chats/:id/messages` | Message, attachment IDs, and `client_id` |
| `POST /api/chats/:id/attachments?client_id=…` | Upload one multipart file |
| `GET/DELETE /api/attachments/:id` | Download or remove an unsent attachment |
| `POST /api/chats/:id/stop`, `/continue`, `/switch` | Control execution |
| `POST /api/approvals/:id` | Submit `{allow: boolean}` |
| `GET /api/events?chat_id=…&after=…` | WebSocket replay from an event cursor |
| `GET /api/chats/:id/terminal` | Interactive terminal WebSocket |
| `GET /api/chats/:id/files`, `/file`, `/diff` | Browse, download, inspect changes |
| `POST /api/chats/:id/publication-review` | Prepare a frozen review with `{target: "commit" \| "push"}`; only push reviews contact GitHub |
| `POST /api/chats/:id/git` | Explicit commit/push/PR with `client_id` and `review_token`; message required for commit and PR |
| `POST /api/push` | Web Push subscription |
| `GET/POST /api/folders`, `GET/POST /api/folders/:name/files` | Folder catalog, creation, browsing and isolated uploads |
| `GET/POST/DELETE /api/{chats,projects}/:id/folders[/name]` | Persistent folder connections, project inheritance and read/write permissions |
| `POST /api/workspaces/:id/copies` | Named Git worktree or ordinary folder copy of main; body `{name}` |
| `POST /api/workspaces/:id/resolve` | Prepare an isolated resolution copy and queue an agent chat; body `{review_id, account_id}`, response `{chat_id, workspace_id}` |
| `POST /api/workspaces/:id/review`, `/apply` | Review returns `id`/changes; apply accepts `{review_id, choices}` with each conflict path mapped to `main` or `copy` |
| `GET /api/workspaces/:id/deletion`, `DELETE /api/workspaces/:id` | Removal summary and confirmed non-main folder deletion; DELETE body `{name}` |
| `DELETE /api/accounts/:id` | Remove local account/sign-in state; preserve chats/files; body `{name}` |
| `GET /api/chats/:id/context` | Bounded workspace file/skill index for composer suggestions |
| `GET /api/system` | CPU, memory, disk availability, queue occupancy and configured capacity |
| `POST /api/settings/output` | Persist `{limitGb: number}` (0.01–10000); `GET /api/system` includes output usage and limit |
| `POST /api/settings/execution` | Persist `{maxConcurrent: positive integer}`; applies to new starts |

## Recovery and compatibility

Disconnecting the browser does not affect the queue. After a supervisor failure, active jobs become `interrupted`. Publishing with an uncertain outcome becomes `unknown`, rather than automatically retrying. The owner reviews the actual state before continuing.

The CLI protocols can change, so versions are pinned in the Dockerfile. Follow [provider-verification.md](provider-verification.md) after upgrades. Unknown server requests fail closed instead of receiving implicit permission. A provider's model catalog is not an entitlement guarantee.

## Connected folder isolation

Only direct ordinary subdirectories of the configured folder root can be connected. Runners receive selected mounts under `/workspace/.workspace-folders`; auth/model/logout containers receive none. Folder upload/read helpers have no network or credential mounts. Uploads stage outside agent-controlled trees, copy with exclusive creation in a helper, and accept an existing path only for identical content. They do not extract archives or follow host symlinks. Queue claims and terminal leases serialize readers/writers when a shared folder has write access. Connection changes and uploads acquire the same scheduling lock and reject active use. Read-only readers can run together. External host writers are outside this coordination. Folder content remains after disconnect and account changes.

### SSH access

`ssh_keys` stores public metadata and AES-GCM-encrypted private keys; `ssh_servers` stores aliases, endpoints, selected keys, explicitly trusted host keys and latest check results. `ssh_links` assigns a server to a project or personal chat. Project chat access is inherited, including copies, and is independent of the provider account. Migration only creates these tables/indexes.

Authenticated routes (existing origin/session checks apply):

| Route | Behavior |
| --- | --- |
| `GET/POST /api/ssh-keys` | List public metadata; create with `{name,operation:"generate"}` or import with `{name,operation:"import",private_key,passphrase?}`. Never return private material. |
| `DELETE /api/ssh-keys/:id` | Remove an unreferenced key; otherwise 409. |
| `GET/POST /api/servers`, `PATCH/DELETE /api/servers/:id` | List/create/update/remove connections. Create/update accepts `{name,alias,host,port,username,key_id}`. Aliases are unique. Endpoint changes reset trust. |
| `POST /api/servers/:id/scan` | Scan public host keys; return fingerprints and a short-lived review token. Does not grant trust. |
| `POST /api/servers/:id/trust` | Consume `{token}` from a scan of this server within five minutes. Update pinned keys and clear the previous test result. |
| `POST /api/servers/:id/test` | Use pinned keys, authenticate and execute `true`; return `{ok,message,checked_at}`. |
| `GET/PUT /api/{projects,chats}/:id/servers` | Read `{inherited,server_ids}` or replace `{server_ids}`. Writes for project chats return 409; use project settings. |

SSH access mutations take the scheduler advisory lock and reject affected queued/running/waiting jobs, terminal leases and in-flight scans/tests. Scan tokens are bound to the stored endpoint, expire after five minutes and are invalidated by edits/deletion/restart. A single supervisor owns the in-memory scan/check registry, matching the existing leadership invariant.

Key import/generation runs in a network-disabled disposable helper; encrypted imports use a private PTY to supply the passphrase without argv/environment secrets. Helpers use `LogConfig: none` because the trusted attach channel transports private material. A run's broker uses a separate network-disabled helper with `ssh-agent`, memory-backed private files, and a named volume containing only its socket, configuration and public files. `ssh-add -h` constrains identities to confirmed destination host keys and usernames. OpenSSH constraints authenticate host identity, not a firewall/IP/port boundary; servers sharing a host private key share that identity. The runner mounts the volume read-only, so switching provider accounts cannot persist SSH credentials in the shared profile. Clients use system-included per-run configuration, pinned known-hosts and public IdentityFiles. No SSH forwarding is configured. User-supplied independent credentials or arbitrary remote commands remain outside this connection manager's policy.

Runner launch/attach failure, normal exit, stop and broker failure tear down the paired helper. Recovery first removes managed containers, then orphan SSH volumes for this installation. Authentication/model and file/Git helpers never call SSH preparation. The worker appends the current connection inventory on every turn, including native resumes. Standard provider approval modes remain in effect; remote command safety is not inferred from local filesystem permissions.

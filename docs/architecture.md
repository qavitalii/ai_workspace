# Architecture

## Services

- **Caddy** handles HTTPS and WebSocket reverse proxying. The local override publishes only `127.0.0.1:8080`.
- **Fastify supervisor** owns the API, owner sessions, PostgreSQL queue, Docker lifecycle, GitHub operations, and event persistence.
- **PostgreSQL 16** stores the owner, sessions, accounts, projects, chats, messages, attachments, jobs, approvals, events, and idempotent publishing operations.
- **Runner containers** execute the official CLIs as a non-root user. Each mounts only its selected chat workspace and account profile. Root filesystem is readonly; capabilities are dropped; memory, CPU, and PID limits apply. No Docker socket or control-network access.
- **Helper containers** inspect files and execute Git commands. Agent-controlled repository configuration never runs directly on the supervisor. Authenticated pushes use a fresh trusted repository populated from a credential-free bundle export.

One supervisor owns the installation. A PostgreSQL advisory lock prevents another replica from stopping live containers during recovery. Queue claims use transactions and partial unique indexes to enforce exclusive chat/account use. Workspace leases serialize agent work, terminal access, and publishing. The CLI uses stdin/stdout independently of browser connections.

## Persistence

`DATA_ROOT/workspaces/<chat-id>` contains checkouts; `profiles/<account-id>` contains native authentication/session state; `uploads/` holds original attachments. UUID storage names prevent user filenames from becoming arbitrary paths. Archives stay opaque files. Messages and uploads each carry a `client_id`, so retrying after a network interruption does not duplicate work.

Native session resume is used only for the same account. Switching clears the native session ID but preserves the visible chat ID, files, messages, attachments, and checkpoint. The new agent receives context and an instruction to inspect actual files and command outcomes. A `handoff` event explicitly identifies the transition.

Checkpoints are updated at completed tool boundaries and periodically while text is streaming. They are bounded context extracts, not a guarantee of identical hidden model state. Provider quota errors are handled separately from command failures, permission requests, and transport failures.

## Main API

All `/api/*` routes except `/login` and `/health` require an HttpOnly session cookie. Mutating requests also require an exact `Origin` matching `APP_ORIGIN`. WebSockets validate the session and Origin.

| Route | Purpose |
|---|---|
| `POST /api/login`, `POST /api/logout` | Password + TOTP, session, sign-out |
| `GET /api/overview`, `GET /api/search` | Projects, chats, accounts, history search |
| `POST /api/projects` | Connect `owner/repository` on GitHub |
| `POST /api/accounts` | Create a Codex or Claude account record |
| `POST/GET/DELETE /api/accounts/:id/auth` | Begin, observe, or cancel native sign-in |
| `POST /api/accounts/:id/auth-input` | Supply the browser code for Claude sign-in |
| `POST /api/accounts/:id/models` | Read the adapter's model catalog |
| `POST /api/chats`, `GET/PATCH /api/chats/:id` | Create, read, or configure a chat |
| `POST /api/chats/:id/messages` | Message, attachment IDs, and `client_id` |
| `POST /api/chats/:id/attachments?client_id=…` | Upload one multipart file |
| `GET/DELETE /api/attachments/:id` | Download or remove an unsent attachment |
| `POST /api/chats/:id/stop`, `/continue`, `/switch` | Control execution |
| `POST /api/approvals/:id` | Submit `{allow: boolean}` |
| `GET /api/events?chat_id=…&after=…` | WebSocket replay from an event cursor |
| `GET /api/chats/:id/terminal` | Interactive terminal WebSocket |
| `GET /api/chats/:id/files`, `/file`, `/diff` | Browse, download, inspect changes |
| `POST /api/chats/:id/git` | Explicit commit/push/PR with `client_id` |
| `POST /api/settings/github`, `/api/push` | GitHub token and Web Push subscription |

## Recovery and compatibility

Disconnecting the browser does not affect the queue. After a supervisor failure, active jobs become `interrupted`. Publishing with an uncertain outcome becomes `unknown`, rather than automatically retrying. The owner reviews the actual state before continuing.

The CLI protocols can change, so versions are pinned in the Dockerfile. Follow [provider-verification.md](provider-verification.md) after upgrades. Unknown server requests fail closed instead of receiving implicit permission. A provider's model catalog is not an entitlement guarantee.

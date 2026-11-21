# Using AI Workspace

[Start here](getting-started.md) · [Installation and operations](deployment.md) · [README](../README.md)

This guide covers daily work after installation. If you have not connected an agent yet, follow [your first chat](getting-started.md#4-start-your-first-chat).

## Choose a workspace

| Choice | Use it when | Files |
| --- | --- | --- |
| Personal chat | You want to try an agent or work on a task outside a project | A persistent folder for that chat |
| Files-only project | You want several chats to work with the same documents or files | Shared main folder, with optional separate working copies |
| GitHub project | You want to work on a repository and review or publish code changes | Repository checkout, with optional separate working copies |

GitHub is optional. A project groups related files and chats; it does not represent a separate user account. One agent account can run one task at a time. Chats using the same writable folder also run one at a time.

## Project folders and existing data

New project chats use **Main folder** by default; you can choose a separate copy when creating a chat. Files saved through its Files panel are visible to every chat using that folder; tasks run one at a time within it. The paperclip adds a conversation attachment instead. Originals stay separate and can be copied into the folder from its attachment library.

On upgrade, existing chat folders are preserved in place as **Saved folders**. In the project page or Project settings, choose an existing folder as the main one, or start a fresh main folder from the repository. Other folders and their chats remain unchanged. A new chat can also continue in an existing saved folder. Deleting a chat keeps its working files and original attachments; folders remain accessible even without chats.

When creating a chat, choose **Main folder**, **New working copy**, or an existing folder. You can also use **New working copy** on the project page. Give each copy a task name. It starts with the main folder’s current files, including uncommitted changes and uploaded files. Git folders use linked Git worktrees with separate branches and a shared managed repository; folders without Git use ordinary file copies. Choose **Files only** when creating a project without a GitHub repository. Existing folders and their files are kept in their original format. Copies do not update each other automatically. One task runs per folder; parallel tasks also need separate available agent accounts and enough capacity in Settings → Resources.

Use **Review changes** to compare the current main files with the proposed result, resolve conflicts, then **Transfer to main folder**. The app combines compatible text changes, detects stale reviews, and saves the previous main folder before applying. Transferring updates working files; it does not commit or push the main repository. A copy remains available for further work. Choosing the main version resolves that proposal; it does not rewrite the copy’s files.

Dependencies, build output, `.env` files (except example/sample/template files), local credential files, app-internal directories and local Git configuration are excluded. The UI lists exact excluded paths. Git worktrees share history, which can still contain previously committed content. Agents can read Git history/status and edit/test files; shared Git metadata is read-only in agent sessions. Use the app’s Git actions for commits and publishing. Connected folders are read-only for copy chats. File copies do not isolate remote services, databases or deployments. Copies/reviews are limited to 50,000 entries, 100 MB per file and 2 GB total; full pre-transfer preparation, including ignored files and Git metadata, has the same limits.

**Resolve with agent** prepares a separate resolution folder and opens a chat with the selected account. The agent compares frozen base/main/copy versions, combines changes and runs checks. The main and original copy stay intact. Review the resolution folder and transfer its result when ready; incomplete checklists or remaining conflict markers block transfer. Unclear product decisions can still require your input. The normal account queue and approval settings apply.

**Delete folder** removes a non-main folder, its linked chats and its original attachments after confirmation by name. Untransferred work is lost. The main folder, connected folders and previous main-folder recovery copies are preserved. To keep files, delete only the chat. **Delete account** removes a saved account and its local sign-in data, while keeping chats and project files. Choose another account to continue those chats. Stop active/queued tasks and close terminals before folder deletion; account operations and active/queued tasks also block account deletion.

Back up both the database and `DATA_ROOT` before upgrading. Migration preserves existing files. Deleting an entire project, with or without its files, is not implemented yet. See the [working-folder guide](deployment.md#11-working-folders-and-conflict-resolution) for practical workflows.

## Files, folders, models and shortcuts

Chat and project settings include **Folders**: upload files or directories, connect an existing server folder, select read-only or read/write access, browse/download files, and disconnect without deleting data. Project folders are inherited by its chats; shared writers are serialized. See [folder setup and external server paths](deployment.md#9-files-and-connected-folders).

Choose a model and reasoning effort before the first message or from the composer. Type `/` for Workspace commands, `@` for files/folders, and `$` for workspace skills. These are supported Workspace features, not a claim of complete parity with every native CLI command or plugin.

### Generated images in chat

When Codex returns image data or an accessible image file, Workspace saves it to the working folder. The chat shows a preview when an assistant message links to an available PNG, JPEG, WebP, or GIF in that folder. Select the preview to open the original in a new tab. Use **Download** under the image to save the original file. The files are also available in **Files**.

[Desktop example](screenshots/ui-refresh/chat-image-preview-desktop.png) · [Mobile example](screenshots/ui-refresh/chat-image-preview-mobile.png)

### System tools for agent tasks

Agent tasks and chat terminals include C and C++ build tools (`gcc`, `g++`, `make`, `pkg-config`), the SQLite, PostgreSQL and MySQL-compatible clients (`sqlite3`, `psql`, `mysql`), and `rsync`, `zip`, `xz`, `file`, `less` and `tree`.

During an execution task, ask Codex or Claude Code to install a Debian package such as `ffmpeg`. Both agents have a dedicated installer tool, also available as `workspace-install ffmpeg` in the task container. The tool accepts package names from Debian's signed repositories and records successful installs in the task log. Downloads and dependencies count toward a 1 GiB budget per run. Installed packages last for that run. Files the agent saves in the working folder persist as usual.

### SSH servers

**Settings → Servers & SSH keys** manages SSH connections. Create or import a key (including passphrase-protected keys), install its public key on your server, confirm the server fingerprint and test the connection. Select servers in project or personal chat settings; project working copies inherit access. Agents and chat terminals can use SSH, SCP and SFTP by alias. Private keys stay in an isolated authentication helper for each run. Removing a connection does not revoke its public key on the remote server. [Setup, access and backup details](deployment.md#ssh-servers-and-keys).

### AWS access and portable skills

Use **Project settings → AWS access** to sign in to AWS IAM Identity Center in your browser and give that project’s agents and terminals a temporary role. Use **Settings → Skills** to import a local skill folder or ZIP for all chats, or **Project settings → Skills** to keep it within a project. Choose imported skills with `$`. Export selected skills as a ZIP with their supporting files. [Setup and limits](deployment.md#aws-access-and-portable-skills).

### Chat models and account limits

**Settings → Models** saves a starting model and thinking depth separately for Codex and Claude Code. New chats copy those values; existing chats keep their own settings. Override the model when creating a chat or in chat settings. The UI displays the provider-reported model once available, including the exact model behind a Claude alias. Older chats without a reported model show that it has not been reported yet.

The sidebar labels each chat with its agent and model, and shows remaining limits for each account. Open **Details** for reset times and the last report timestamp. Limits for both Codex and Claude Code accounts can be refreshed without starting an inference task when the account is idle; opening **Account limits** in the sidebar refreshes stale values automatically. Claude limits are read with the signed-in CLI profile's own token from the same subscription usage data the CLI shows in `/usage`; this is not a documented public API and may change. During tasks, Claude's own reports also update limits and may omit utilization; missing percentages are shown as unknown, never as a full balance. Expired windows require a fresh report. Credits or usage costs are not treated as subscription percentages.

## Switching and disconnecting accounts

Manual account switching supports Codex ↔ Claude Code in the same chat. Messages, files, attachments, planning mode and permissions remain; a new agent session receives the saved context. Changing providers uses the target provider’s default model and clears native commands from the previous session. Stop or cancel an active/queued task before switching. Automatic quota handoff stays within the current provider.

Use **Disconnect** in **Agent accounts** to sign out through the official CLI. Stop active tasks first. The saved account entry, chats, files and attachments remain. Select **Connect** to sign in again. If sign-out fails, retry it or reconnect before using that account.

## Review and publish changes

For a GitHub project, open **Changes** to inspect edits. When the folder is idle, choose **Prepare commit review**, review the proposed files and enter a commit message. Committing saves changes in the local repository. Pushing sends commits to GitHub. Creating a pull request asks for review on GitHub. These are separate actions; transferring a working copy into the main folder does not perform them.

See [reviewing and publishing](deployment.md#reviewing-and-publishing-git-changes) for stale reviews, credential handling and retry behavior.

## Understand task states

| What you see | What it means | What to do |
| --- | --- | --- |
| Queued | The account, working folder or execution capacity is busy | Wait, stop another task or choose an available account/folder |
| Waiting for approval | The agent needs a decision before proceeding | Read the action details and allow or deny it |
| Waiting for an account | No eligible account is currently available | Check connection status and provider limits |
| Interrupted | The server or task stopped before completion | Inspect files and external actions before continuing |

Closing the browser does not stop a task. Stopping the server does. You can open the terminal when the agent is idle; closing the terminal stops its container. Use [troubleshooting](deployment.md#8-troubleshooting) if a task cannot continue.

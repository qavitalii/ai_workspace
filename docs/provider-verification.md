# Verify provider integrations before daily use

The automated tests do not use your subscriptions and cannot replace real authentication and inference checks. The Dockerfile pins Codex CLI 0.169.0 and Claude Code 2.1.325. Official binaries run without modification.

## Codex

1. Add an account and begin sign-in. Open the OpenAI URL, verify the intended account, and enter the device code. Enable device-code login in ChatGPT security settings if required.
2. Confirm a successful sign-in in Workspace. Load the model catalog from chat settings. A catalog entry does not guarantee access to that model.
3. In a disposable repository, ask the agent to create `smoke.txt`, execute a command, and read an attached PNG and text file.
4. Exercise both allow and deny decisions. Stop the agent, then resume the same session.
5. Close the browser during work and reconnect. Confirm the event history and result.

## Claude Code

1. Add an account. `claude auth login` runs inside an isolated profile. Open the URL displayed by the CLI. If Claude returns a browser code, submit it in Workspace. This differs from Codex's device-code flow.
2. Repeat the attachment, permission, and resume checks. If a protocol feature fails, record the issue; do not enable bypass mode to hide broken approvals.
3. Verify billing uses your intended subscription. Runners do not inherit API keys from the host shell.

## Shared folders, copies and conflict resolution

Use disposable files/projects and repeat this workflow with each provider you intend to use. The automated suite tests preparation and transfer with simulated agent edits; it does not establish that a live model resolves conflicts correctly.

1. Open two chats in main. Save a file through **Files** and confirm both can read it. Confirm overlapping tasks wait rather than writing the same folder concurrently. Attach a separate file to one message and verify the original is read-only; save a working copy explicitly.
2. Create two working copies from a Git project with an uncommitted edit and an uploaded file. With two available accounts, run separate tasks and confirm changes stay in their selected folders. Read Git status/history; use the app’s Git actions for commits. Repeat with a **Files only** project.
3. Edit the same text differently in main and one copy. Open **Review changes → Resolve with agent**, select the account, and confirm the resolution chat opens in a separate folder. Exercise normal permission prompts, a stop/resume, and an ambiguous choice requiring clarification.
4. Ask the agent to finish and explain its checks. Review the resolution folder. Confirm incomplete resolutions cannot transfer; then transfer the reviewed result and check both intended changes, unrelated files and the untouched original copy. Also check a binary or delete/modify conflict.
5. Change main after a review and verify stale transfer is rejected. Refresh and review again. Delete a disposable copy after transferring; confirm main and other copies remain. Deleting a chat alone must preserve its files and originals.
6. Delete a disposable saved account through **Delete account**. Confirm its chats/files remain and another account can continue them. This removes local sign-in data, not the upstream provider account.

## Switching accounts

1. Connect one Codex and one Claude Code account. Also test two accounts of the same provider when available.
2. Complete or stop a task, then switch to the second account.
3. Test both Codex → Claude and Claude → Codex. Confirm the target model defaults, handoff event, original message authors, working files, and attachments. Ask the agent to continue an unfinished change.
4. Expected behavior: a new native session with a context checkpoint. Exact cross-account native-session restoration is not claimed.
5. Separately test a real quota error, all accounts being unavailable, and recovery. Do not confuse subscription exhaustion with server overload or a shell-command error.

`ENABLE_AUTO_HANDOFF=false` is the default. Set it to `true` only after successful compatibility checks and confirmation that the mode is appropriate under the terms applying to your accounts. Run `./ops/compose.sh up -d server`, then enable automatic switching in chat settings. This gate reflects unverified integration behavior; device-code support alone does not establish unlimited or pooled subscription usage.

Official references: [Codex App Server](https://developers.openai.com/codex/app-server), [Codex authentication](https://developers.openai.com/codex/auth), [Claude CLI reference](https://code.claude.com/docs/en/cli-reference), [Claude authentication](https://code.claude.com/docs/en/authentication), [Claude integration terms](https://code.claude.com/docs/en/legal-and-compliance).

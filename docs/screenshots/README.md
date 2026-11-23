# Documentation screenshots

These browser captures show the React interface as of 2026-11-19 using fictional accounts, conversations, repositories, files, and usage values. The desktop overview and conversation use a presentation frame. The mobile showcase places two 390 × 844 application views in device frames.

| Overview | Capture |
| --- | --- |
| Workspace home | [Framed desktop](workspace.jpg) |
| Conversation | [Framed desktop](conversation.jpg) · [Mobile](mobile.jpg) |
| Workspace home and conversation | [Mobile showcase](mobile-showcase.jpg) |
| Choosing a working copy | [Mobile](new-chat.jpg) |
| Resolving conflicting changes | [Desktop](resolve-conflicts.jpg) |

| Screen | Desktop | Mobile |
| --- | --- | --- |
| Workspace home | [Desktop](ui-refresh/home-desktop.jpg) | [Mobile](ui-refresh/home-mobile.jpg) |
| Sidebar and account limits | [Desktop](ui-refresh/sidebar-desktop.jpg) | [Mobile](ui-refresh/sidebar-mobile.jpg) |
| Agent accounts | [Desktop](ui-refresh/accounts-compact-desktop.jpg) | [Mobile](ui-refresh/accounts-compact-mobile.jpg) |
| New chat | [Desktop](ui-refresh/new-chat-compact-desktop.jpg) | [Mobile](ui-refresh/new-chat-compact-mobile.jpg) |
| Conversation | [Desktop](ui-refresh/chat-desktop.jpg) | [Mobile](ui-refresh/chat-mobile.jpg) |
| Empty chat | | [Mobile](ui-refresh/chat-empty-mobile.jpg) |
| Agent questions | [Desktop](ui-refresh/agent-questions-desktop.jpg) | [Mobile](ui-refresh/agent-questions-mobile.jpg) |
| Permission request | | [Mobile](ui-refresh/agent-permission-mobile.jpg) |
| Switch between Codex and Claude Code | [Desktop](ui-refresh/switch-agent-desktop.jpg) | |
| Execution log | [Desktop](ui-refresh/execution-log-desktop.jpg) | |
| Chat settings | [Desktop](ui-refresh/chat-settings-desktop.jpg) | [Mobile](ui-refresh/chat-settings-mobile.jpg) |
| Files | [Desktop](ui-refresh/files-desktop.jpg) | [Mobile](ui-refresh/files-mobile.jpg) |
| Personal folder files | | [Mobile](ui-refresh/files-dialog-mobile.jpg) |
| File preview | [Desktop](ui-refresh/file-preview-desktop.jpg) | [Mobile](ui-refresh/file-preview-mobile.jpg) |
| Commit review | [Desktop](ui-refresh/changes-desktop.jpg) | [Mobile](ui-refresh/changes-mobile.jpg) |
| Terminal | [Desktop](ui-refresh/terminal-desktop.jpg) | [Mobile](ui-refresh/terminal-mobile.jpg) |
| Project server access and working folders | [Desktop](ui-refresh/project-sections-desktop.jpg) | [Mobile](ui-refresh/project-sections-mobile.jpg) |
| Connected folders | [Desktop](ui-refresh/connected-folders-desktop.jpg) | [Mobile](ui-refresh/connected-folders-mobile.jpg) |
| Project AWS access | [Desktop](ui-refresh/project-aws-desktop.jpg) | |
| Workspace settings | [Desktop](ui-refresh/settings-desktop.jpg) | |
| Model defaults | [Desktop](ui-refresh/workspace-models-desktop.jpg) | |
| Resources | [Desktop](ui-refresh/workspace-resources-desktop.jpg) | |
| Servers and SSH keys | | [Mobile](ui-refresh/workspace-ssh-mobile.jpg) |
| Skills | [Desktop](ui-refresh/workspace-skills-desktop.jpg) | |

## Project tools

These Chromium captures use fictional usage and package data and show the project environment and server resource settings.

| Screen | Desktop | Mobile |
| --- | --- | --- |
| Project environment | [Usage](project-tools/project-tools-desktop.png) | [Over the limit](project-tools/project-tools-over-budget-mobile.png) |
| System packages | [Desktop](system-packages/system-packages-desktop.png) | [Mobile](system-packages/system-packages-mobile.png) |
| Package preinstall warning | [Desktop](system-packages/chat-preset-warning-desktop.png) | [Mobile](system-packages/chat-preset-warning-mobile.png) · [320 px](system-packages/narrow-banner-after-mobile.png) |
| Disabled saved package | [Desktop](system-packages/settings-preset-failed-desktop.png) | [Mobile](system-packages/settings-preset-failed-mobile.png) |
| Workspace resource settings | [Limit setting](project-tools/server-tools-limit-desktop.png) | [Saved limit](project-tools/server-tools-limit-mobile.png) |

## Refresh the captures

1. Run `npm ci`, then `node ops/preview-docs.mjs`. The preview serves fictional data on `http://127.0.0.1:4178` without connecting to the database or providers.
2. Capture `/__docs/frame` at 1600 × 1080 with **Studio website** and **Account limits** expanded. Use `/__docs/frame?view=chat` for the framed conversation and `/__docs/mobile` at 1440 × 1200 for the two-phone showcase.
3. Use `/`, `/?chat=demo-chat`, and `/?project=demo-project` for the gallery. Use 1440 × 1000 for desktop and 390 × 844 for mobile browser views. Open **Changes → Prepare commit review** for the publication example. In the project’s **Working folders**, open **Review changes** for **Mobile navigation** to capture the conflict.
4. Restart with `PREVIEW_INTERACTIONS=1 node ops/preview-docs.mjs` for the question and permission examples. Capture the questions on both sizes before answering. The fixture shows a retry on the first answer submission and opens the permission request after the second.
5. Check that the relevant controls are visible and that the images contain only demo data. Stop the preview with Ctrl+C.

The preview displays simulated reviews, terminal output, and agent prompts. Publishing, transferring files, and provider execution require the application server. Use [provider verification](../provider-verification.md) to test live behavior.

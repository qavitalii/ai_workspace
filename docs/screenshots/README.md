# Documentation screenshots

These are browser captures of the actual React interface with fictional data. `workspace.jpg`, `conversation.jpg`, `mobile.jpg` and `mobile-showcase.jpg` are earlier overview captures from `ops/preview-docs.mjs`; they predate the working-folder controls and should not be used as a current control reference. `new-chat.jpg` and `resolve-conflicts.jpg` show the updated folder selection and agent-resolution controls, captured on 2026-11-16 in an isolated local test installation with synthetic files and a demo account. No inference task was run. Desktop captures include a decorative presentation frame from `ops/docs-frame.html`; the application inside it is rendered without style overrides. No real account, conversation, token, repository, or usage report is included. Example model names and assistant messages are illustrative, not provider verification results.

The read-only preview fixture now includes main, worktree and personal folder records with chat-to-folder associations. It can display current project cards and the new-chat form, but it cannot create copies, perform reviews or queue resolution tasks. To refresh the interactive workflow screenshots, use a disposable test database and an isolated data directory as described in [development and verification](../../README.md#development-and-verification). Keep real profiles and project files out of that environment.

To refresh overview captures:

1. Run `npm ci`, then `node ops/preview-docs.mjs`.
2. Open `http://127.0.0.1:4178/__docs/frame` at 1600 × 1080. Expand **Studio website** in the sidebar and capture the full page as `workspace.jpg`. The decorative frame leaves a 48 px margin around the complete application viewport.
3. Open **Getting started** and capture the full page as `conversation.jpg`. You can also open `/__docs/frame?view=chat` directly.
4. Open `http://127.0.0.1:4178/?chat=demo-chat` directly at 390 × 844 and capture `mobile.jpg`. The full example conversation and composer must be visible.
5. Open `http://127.0.0.1:4178/__docs/mobile` at 1440 × 1200 and capture the full page as `mobile-showcase.jpg`. It displays two real 390 × 844 application views inside decorative device frames from `ops/docs-mobile.html`. Both full screens and device edges must remain visible. This is the mobile image used in README; `mobile.jpg` remains an unframed reference.
6. Review every image for clipped controls and sensitive data. Stop the preview with Ctrl+C.

The preview binds to loopback only, rejects writes, and serves a small set of fixture routes. Other controls are intentionally not functional. It does not start the application server, connect to PostgreSQL, launch agents, or authenticate with providers. Never deploy this preview as the application.

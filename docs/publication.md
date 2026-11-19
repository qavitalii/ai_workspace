# Publication readiness

Review date: 2026-11-16. This records local preparation, not a published release or a complete security audit.

## Prepared

- README with a feature overview, navigation, and desktop screenshots and a two-phone mobile composition of the real UI using fictional data.
- Deployment numbering and internal links corrected; API overview updated for chat controls and model defaults.
- External-folder update instructions clarified: the stock update script does not preserve the optional Compose override.
- Contribution guide, security reporting guidance, bug-report template, and pull-request template.
- GNU GPL v3.0-only license selected by the owner, with matching package metadata. Provider CLIs and dependencies keep their own licenses and terms.

## Current working-folder changes

The source working tree reviewed on 2026-11-16 includes shared main folders, preserved legacy folders, Git worktrees/file copies, new-chat folder selection, files-only projects, review/transfer, agent-assisted conflict resolution, and folder/account removal. The user guide, API/storage documentation, backup/recovery instructions, provider verification scenarios and screenshot fixture have been aligned with these changes.

The working-folder update was subsequently deployed and verified locally on 2026-11-16 after an encrypted backup of the database, data tree and source, including an isolated database restore check. Existing files and pre-migration database fields were verified unchanged after startup. Server health, the served frontend bundle and installed-runner smoke checks passed without inference calls. This local result is not a claim about other installations; updating source or documentation alone does not rebuild their running images. Whole-project deletion remains unimplemented.

## Latest implementation verification — 2026-11-16

- `npm run build` and type checking passed. Vite reports a non-blocking JavaScript chunk size warning.
- With `INTEGRATION_TESTS=1`, `DOCKER_TESTS=1`, a disposable PostgreSQL database on port 54329 and a separate runner image: **82 tests passed, none skipped**. Coverage includes linked worktrees, an unborn Git repository, ordinary folder copies, preserved uncommitted/uploaded files, stale reviews, conflict preparation/transfer, deletion and recovery, and read-only runner mounts.
- Resolution tasks were queued through the real API; agent edits/results were simulated. Live subscription authentication/inference and the model’s semantic conflict-resolution quality were not verified.
- Desktop and mobile UI were checked, including new-chat copy selection, retrying chat creation without duplicating a successfully created copy, files-only project creation and opening the resolution chat. A mobile radio-control layout issue was fixed and rechecked at 390 × 844.
- `git diff --check` passed. The disposable database and preview server were removed after implementation verification.

Follow [provider verification](provider-verification.md) before claiming unattended operation is verified. Current CI enables database tests but does not run Docker-gated tests; run the full local command in [README](../README.md#development-and-verification) for those checks.

## Documentation audit — 2026-11-16

All eight Markdown guides were checked against current source behavior. All 32 local link/image references and their anchors resolved. The updated read-only preview rendered main and copy folder cards with the correct chat associations. `node --check ops/preview-docs.mjs` and `git diff --check` passed. The default test run passed **22 tests, with 60 integration tests skipped**; the full database/Docker suite was not rerun for this documentation-only audit. Its latest result is recorded above.

## Earlier publication preparation

The earlier review ran 17 default tests (40 skipped) and 55 database-enabled tests (2 skipped); these are historical counts, superseded by the full implementation run above. Shell syntax checks passed. The current desktop and mobile captures are listed in the [screenshot gallery](screenshots/README.md).

At that earlier review, all 149 blobs reachable through local Git refs were scanned for common GitHub/OpenAI/AWS token patterns, private-key headers, and exact matches to then-current sensitive `.env` values. No matches were found. That scan was **not repeated for the latest working tree** and does not cover unknown token formats, remote-only refs, GitHub discussions/issues, or deleted remote content. `.env`, `.data/`, `.wikillm/`, backup keys and backups remain excluded from Git. Recheck the final publication revision rather than treating historical results as a current security audit.

## Before making the repository public

1. Review and commit the intended changes, including existing application changes separately from this documentation work. Push and inspect the resulting GitHub diff.
2. Check CI on that exact revision. This review could not reach the GitHub API, so remote status and repository settings were not verified.
3. Review remote branches, tags, releases, issues, pull requests, and attachments for private information. A public repository exposes more than the current checkout.
4. Enable private vulnerability reporting if available and confirm the reporting route in SECURITY.md.
5. Set a repository description and topics. Suggested description: **Self-hosted workspace for Codex and Claude Code with persistent chats, isolated containers, and desktop/mobile access.** Suggested topics: `self-hosted`, `codex`, `claude-code`, `ai-agents`, `docker`, `typescript`.
6. Change visibility to public only after the review is complete. Visibility was not changed during this preparation.

The npm `private` flag intentionally remains enabled: public source code does not require publishing this application to npm.

# Publication readiness

Review date: 2026-11-16. This records local preparation, not a published release or a complete security audit.

## Prepared

- README with a feature overview, navigation, and desktop screenshots and a two-phone mobile composition of the real UI using fictional data.
- Deployment numbering and internal links corrected; API overview updated for chat controls and model defaults.
- External-folder update instructions clarified: the stock update script does not preserve the optional Compose override.
- Contribution guide, security reporting guidance, bug-report template, and pull-request template.
- GNU GPL v3.0-only license selected by the owner, with matching package metadata. Provider CLIs and dependencies keep their own licenses and terms.

## Local verification

- `npm run build` passed. Vite reports a non-blocking JavaScript chunk size warning.
- Default tests: 17 passed, 40 skipped.
- Tests with `INTEGRATION_TESTS=1` against a new disposable PostgreSQL container: 55 passed, 2 skipped. The Docker protocol and isolated folder-upload tests require `DOCKER_TESTS=1`; they were not run in this review.
- Shell syntax checks and `git diff --check` passed.
- Screenshots inspected at desktop (1600 × 1080, including a presentation frame) and mobile (390 × 844) viewport sizes.
- All 149 blobs reachable through local Git refs were scanned for common GitHub/OpenAI/AWS token patterns, private-key headers, and exact matches to current sensitive `.env` values. No matches were found. This limited scan does not cover unknown token formats, remote-only refs, GitHub discussions/issues, or deleted remote content.
- `.env`, `.data/`, `.wikillm/`, backup keys, and backups are excluded from Git. No tracked private installation paths were found.

Live provider authentication and inference were not repeated. Follow [provider verification](provider-verification.md) before claiming unattended operation is verified.

## Before making the repository public

1. Review and commit the intended changes, including existing application changes separately from this documentation work. Push and inspect the resulting GitHub diff.
2. Check CI on that exact revision. This review could not reach the GitHub API, so remote status and repository settings were not verified.
3. Review remote branches, tags, releases, issues, pull requests, and attachments for private information. A public repository exposes more than the current checkout.
4. Enable private vulnerability reporting if available and confirm the reporting route in SECURITY.md.
5. Set a repository description and topics. Suggested description: **Self-hosted workspace for Codex and Claude Code with persistent chats, isolated containers, and desktop/mobile access.** Suggested topics: `self-hosted`, `codex`, `claude-code`, `ai-agents`, `docker`, `typescript`.
6. Change visibility to public only after the review is complete. Visibility was not changed during this preparation.

The npm `private` flag intentionally remains enabled: public source code does not require publishing this application to npm.

# Publication readiness

Review date: **2026-11-19**. This records preparation for public source availability, not a published release or a complete security audit. Repository visibility was still **private** at review time.

## Documentation

- [README](../README.md) introduces the application, requirements, local/VPS choices, quick starts and first use.
- [Getting started](getting-started.md) takes a new user through platform prerequisites, installation, password and authenticator setup, provider sign-in, a first task, maintenance and troubleshooting.
- [User guide](user-guide.md) covers project folders, working copies, files, account switching and optional connections.
- [Deployment](deployment.md) provides the administration reference, including public-IP HTTPS, 4 GB sizing, configuration, backups and recovery.
- [Contributing](../CONTRIBUTING.md) separates development checks from end-user installation and documents the optional integration suites.
- The [screenshot gallery](screenshots/README.md) uses fictional data. The repository includes a contribution guide, security reporting guidance, bug-report template and pull-request template.

Local Markdown links and heading anchors, shell example syntax, and whitespace were checked for this documentation revision. Application tests were not rerun for these documentation-only changes; the verified implementation result below remains the relevant baseline.

## Verified implementation

Revision: [`caa6573`](https://github.com/qavitalii/ai_workspace/commit/caa6573069199ebb40988d577b9ef43e33b8be21), pushed to `main` on 2026-11-19.

- **263 tests passed across 19 files, none skipped**, with a disposable PostgreSQL database, separate runner/SSH test images, Docker checks, Compose checks and native Caddy HTTPS checks enabled. Temporary test containers were removed afterward.
- Coverage includes database/API behavior, working folders, runner isolation, SSH/SCP/SFTP, deployment validation, authentication/origin checks, and loopback IP-certificate HTTPS/WebSocket behavior.
- [GitHub CI for that exact revision](https://github.com/qavitalii/ai_workspace/actions/runs/44523083089) completed successfully. CI includes database and proxy checks; it does not enable the runner and SSH container suites, which were verified locally.
- The production dependency audit reported no known vulnerabilities at review time. This does not establish that the application has no security defects.

See [integration test instructions](../CONTRIBUTING.md#integration-tests) to reproduce the local checks. Test counts describe this revision and will change as coverage grows.

### What remains environment-dependent

Automated tests use synthetic data and simulated agent results. They do not verify real subscription sign-in, inference, model quality or unattended provider operation. Complete [provider verification](provider-verification.md) with the intended accounts.

The HTTPS tests use temporary test certificates. Public certificate issuance and renewal, browser behavior, IPv6 client-address preservation through Docker and capacity on a 4 GB VPS still require checks on the intended server. The [deployment guide](deployment.md#access-without-a-domain) explains these conditions.

An earlier working-folder upgrade was deployed and verified locally on 2026-11-16 after an encrypted backup and isolated restore check. Existing files and pre-migration database fields were preserved; health and installed-runner smoke checks passed without inference calls. That result applies to the tested installation, not to every deployment. Whole-project deletion remains unimplemented.

## Publication exposure review

The review examined all **15 commits and 386 unique blobs reachable from `origin/main`**, checking common GitHub/OpenAI/Anthropic/AWS token patterns, private-key headers, and exact matches to the installation's current sensitive values and backup key. No matches or sensitive-path candidates were found. All **58 available GitHub Actions log files** were checked with the same secret checks; no matches were found and no run logs were unavailable.

Remote inventory showed one branch (`main`), no tags, no releases, and no issues. This review does not establish the absence of secrets in unknown formats, historical credentials not matching the patterns, pull-request attachments, discussions, deleted remote content or separately uploaded artifacts. Recheck changes made after this review.

`.env`, `.data/`, `.wikillm/`, backup keys and backup archives remain excluded from Git. Never add actual chats, provider profiles, credentials or private repository contents to examples or issue reports.

## Before changing visibility

1. Review and commit the documentation revision, push it, and check CI on the new exact commit. The successful CI result above applies to the implementation revision.
2. Review any pull requests, discussions, attachments or other repository content outside the checked source and logs. [GitHub's visibility guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility) explains what becomes accessible.
3. Confirm the private reporting route in [SECURITY.md](../SECURITY.md) and enable GitHub private vulnerability reporting when available. Its setting was not verified in this review.
4. Add a repository description and topics. Suggested description: **Self-hosted workspace for Codex and Claude Code with persistent chats, isolated containers, and desktop/mobile access.** Suggested topics: `self-hosted`, `codex`, `claude-code`, `ai-agents`, `docker`, `typescript`.
5. Change visibility only after the final publication review. No visibility or repository settings were changed as part of this documentation work.

The project uses the [GNU GPL v3.0-only license](../LICENSE), matching its package metadata. Provider CLIs and dependencies retain their own licenses and terms. The npm `private` flag intentionally remains enabled: public source availability does not require publishing the application to npm.

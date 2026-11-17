# Security

AI Workspace is intended for one owner on a trusted, dedicated host. It is not a multi-tenant service. The supervisor controls Docker and must be treated as an administrative component. Container isolation does not make arbitrary agent work risk-free.

## Report a vulnerability

Do not put credentials, private chat data, or exploit details in a public issue. Use the repository's **Security → Report a vulnerability** option if the maintainer has enabled private vulnerability reporting. If it is unavailable, ask the maintainer for a private reporting channel without disclosing the vulnerability publicly.

Include the affected revision, deployment mode, impact, and minimal reproduction using synthetic data. Remove tokens, cookies, TOTP material, and personal content from logs and screenshots. There is no guaranteed response time or supported-version schedule yet.

## Deployment boundaries

- Use HTTPS for remote access and keep password + TOTP authentication enabled.
- Preserve the explicit proxy address allowlist and Caddy’s forwarded-address overwrite; never trust arbitrary forwarded headers.
- Review the action arguments shown on each permission card. Missing arguments require denying and retrying the request.
- Configure the shared saved-output GB budget in Settings → Resources. It bounds application output history, not project files, native provider histories, backups or total host disk usage.
- Keep `.env`, `.data`, account profiles, encryption keys, and backup keys private. Backups contain credentials even when encrypted.
- Agent containers must not receive the Docker socket, database credentials, or project GitHub tokens.
- Review connected folder permissions and agent changes before publishing. Working copies force these connections to read-only, but remote services and databases are not isolated.
- Worktree agent/terminal sessions receive shared Git metadata read-only. Use application Git actions for writes. Shared history can contain previously committed secrets even when those paths are excluded from the copied working files.
- Agent conflict-resolution inputs are read-only snapshots. Completion checks detect missing acknowledgements and conflict markers; they do not establish semantic correctness or verify the agent’s test report.
- Use the [backup and recovery guide](docs/deployment.md#6-backups) and repeat [provider verification](docs/provider-verification.md) after CLI upgrades.

A clean automated check is not a security audit or a guarantee that no secret exists in repository history.

## SSH connections

Saved SSH keys use the installation's encrypted database storage and are never returned by list/create APIs. SSH helpers disable Docker logging and receive secrets through their private attach stream. Per-run SSH agents hold only assigned identities with destination constraints; runner containers receive a socket and public configuration, not private-key files. The remote server's account permissions determine what an authorized agent can do. Confirm server fingerprints through a trusted channel before granting access. Remote servers and remote processes are not isolated by local working copies or planning mode. Removing a saved connection/key does not remove its public key from a remote server; revoke it there separately. Database backups plus the installation encryption key restore SSH credentials and must remain private.

# Security

AI Workspace is intended for one owner on a trusted, dedicated host. It is not a multi-tenant service. The supervisor controls Docker and must be treated as an administrative component. Container isolation does not make arbitrary agent work risk-free.

## Report a vulnerability

Do not put credentials, private chat data, or exploit details in a public issue. Use the repository's **Security → Report a vulnerability** option if the maintainer has enabled private vulnerability reporting. If it is unavailable, ask the maintainer for a private reporting channel without disclosing the vulnerability publicly.

Include the affected revision, deployment mode, impact, and minimal reproduction using synthetic data. Remove tokens, cookies, TOTP material, and personal content from logs and screenshots. There is no guaranteed response time or supported-version schedule yet.

## Deployment boundaries

- Use HTTPS for remote access and keep password + TOTP authentication enabled.
- Keep `.env`, `.data`, account profiles, encryption keys, and backup keys private. Backups contain credentials even when encrypted.
- Agent containers must not receive the Docker socket, database credentials, or project GitHub tokens.
- Review connected folder permissions and agent changes before publishing.
- Use the [backup and recovery guide](docs/deployment.md#6-backups) and repeat [provider verification](docs/provider-verification.md) after CLI upgrades.

A clean automated check is not a security audit or a guarantee that no secret exists in repository history.

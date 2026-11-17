# Contributing

AI Workspace is an early-stage, single-owner application. Small, focused fixes, documentation improvements, and reproducible bug reports are welcome.

## Before making a change

Read the [architecture](docs/architecture.md) and [deployment guide](docs/deployment.md). For substantial changes, open an issue explaining the problem and proposed behavior first. Keep provider compatibility claims tied to the pinned CLI versions and verified behavior.

## Local checks

Use Node.js 22 and npm:

```bash
npm ci
npm run build
npm test
for script in ops/*.sh; do bash -n "$script"; done
```

The default test run skips database and runner integration tests. Follow the disposable database instructions in [README](README.md#development-and-verification) to run the database suite. The same README documents the full `DOCKER_TESTS=1` run with an isolated runner image. It covers worktrees, ordinary copies, merge/recovery behavior and runner isolation as well as protocol fixtures. CI currently enables database tests but not Docker-gated tests. Never point integration tests at an installation you want to keep.

For UI documentation, run `node ops/preview-docs.mjs` and open `http://127.0.0.1:4178`. This read-only fixture uses fictional data and never connects to your accounts or database. See [screenshot instructions](docs/screenshots/README.md).

## Pull requests

Explain the problem, resulting behavior, and checks performed. Add meaningful regression coverage for behavior changes, update affected documentation, and include screenshots for visible UI changes. State which integration checks were skipped. Preserve the isolation, approval, and credential boundaries described in the architecture.

Never include `.env`, credentials, real conversations, account profiles, backups, or private repository content. Report security issues privately; see [SECURITY.md](SECURITY.md).

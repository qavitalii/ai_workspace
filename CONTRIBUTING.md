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

Deployment tests validate address parsing, secret-file permissions, reruns and legacy settings, and simulate the installer without starting services. They use Python 3 and OpenSSL; installer simulations skip when run as root. Run `CADDY_TESTS=1 COMPOSE_TESTS=1 npx vitest run tests/deployment.test.ts` to additionally validate the domain, public IP and local configurations with the exact Caddy image from Compose, plus the effective mounts and published ports. These proxy parser checks disable container networking and do not request certificates. Alternatively, set `CADDY_BIN=/absolute/path/to/caddy` to test with a local Caddy 2.11.9 binary.

Run `CADDY_BIN=/absolute/path/to/caddy CADDY_HTTPS_TESTS=1 npx vitest run tests/ip-https.test.ts` for real loopback HTTPS and WebSocket connections using IPv4/IPv6 certificate subjects. The tests verify IP SANs without SNI, host routing, forwarded-header overwrite and restart behavior. They use temporary certificates trusted only by the test clients, replace ACME issuance, and contact no public address or CA. They test IPv6 identity over loopback IPv4 transport, not actual IPv6 routing through Docker. CI extracts the executable from the same Caddy image to run these checks. The database-enabled API suite also checks production IP-origin login, Secure/HttpOnly/SameSite cookies, TOTP replay, session invalidation and HTTP/WebSocket origin rejection.

Actual public-IP issuance/renewal, browser cookie acceptance, IPv6 Docker client-address preservation and 4 GB capacity still require validation on the intended VPS; local test success is not evidence for those deployment conditions.

For UI documentation, run `node ops/preview-docs.mjs` and open `http://127.0.0.1:4178`. This read-only fixture uses fictional data and never connects to your accounts or database. See [screenshot instructions](docs/screenshots/README.md).

## Pull requests

Explain the problem, resulting behavior, and checks performed. Add meaningful regression coverage for behavior changes, update affected documentation, and include screenshots for visible UI changes. State which integration checks were skipped. Preserve the isolation, approval, and credential boundaries described in the architecture.

Never include `.env`, credentials, real conversations, account profiles, backups, or private repository content. Report security issues privately; see [SECURITY.md](SECURITY.md).

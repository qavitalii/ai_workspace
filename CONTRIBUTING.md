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

The default test run skips database, runner and live HTTPS integration tests. Follow [integration tests](#integration-tests) to enable them. CI runs the database and proxy checks; runner and SSH tests must also be run explicitly. Never point integration tests at an installation you want to keep.

Deployment tests validate address parsing, secret-file permissions, reruns and legacy settings, and simulate the installer without starting services. They use Python 3 and OpenSSL; installer simulations skip when run as root. Run `CADDY_TESTS=1 COMPOSE_TESTS=1 npx vitest run tests/deployment.test.ts` to additionally validate the domain, public IP and local configurations with the exact Caddy image from Compose, plus the effective mounts and published ports. These proxy parser checks disable container networking and do not request certificates. Alternatively, set `CADDY_BIN=/absolute/path/to/caddy` to test with a local Caddy 2.11.9 binary.

Run `CADDY_BIN=/absolute/path/to/caddy CADDY_HTTPS_TESTS=1 npx vitest run tests/ip-https.test.ts` for real loopback HTTPS and WebSocket connections using IPv4/IPv6 certificate subjects. The tests verify IP SANs without SNI, host routing, forwarded-header overwrite and restart behavior. They use temporary certificates trusted only by the test clients, replace ACME issuance, and contact no public address or CA. They test IPv6 identity over loopback IPv4 transport, not actual IPv6 routing through Docker. CI extracts the executable from the same Caddy image to run these checks. The database-enabled API suite also checks production IP-origin login, Secure/HttpOnly/SameSite cookies, TOTP replay, session invalidation and HTTP/WebSocket origin rejection.

Actual public-IP issuance/renewal, browser cookie acceptance, IPv6 Docker client-address preservation and 4 GB capacity still require validation on the intended VPS; local test success is not evidence for those deployment conditions.

For UI documentation, run `node ops/preview-docs.mjs` and open `http://127.0.0.1:4178`. This read-only fixture uses fictional data and never connects to your accounts or database. See [screenshot instructions](docs/screenshots/README.md).

## Integration tests

Use Node.js 22, npm, and Docker. Complete the local checks above first. Database integration tests require a **disposable test database** on port 54329. These tests clear its tables:

```bash
docker run -d --name ai-workspace-test-db -e POSTGRES_USER=workspace -e POSTGRES_PASSWORD=workspace -e POSTGRES_DB=workspace -p 127.0.0.1:54329:5432 postgres:16-bookworm
docker exec ai-workspace-test-db pg_isready -U workspace -d workspace
```

Wait until the second command reports `accepting connections`; repeat it if PostgreSQL is still starting. Then run:

```bash
INTEGRATION_TESTS=1 DATABASE_URL=postgres://workspace:workspace@127.0.0.1:54329/workspace npm test
```

Without `INTEGRATION_TESTS=1`, database tests are skipped. CI runs the database suite against a dedicated PostgreSQL service, but currently does not enable `DOCKER_TESTS=1`.

To verify worktrees, ordinary copies, conflict preparation/transfer, deletion and runner isolation, keep the disposable database above running and build a separate test image:

```bash
docker build --target runner -t ai-workspace-runner:tests .
INTEGRATION_TESTS=1 DOCKER_TESTS=1 RUNNER_IMAGE=ai-workspace-runner:tests DATABASE_URL=postgres://workspace:workspace@127.0.0.1:54329/workspace npm test
```

If the Node Docker client cannot find Docker Desktop's socket on macOS, prefix that test command with `DOCKER_HOST="unix://$HOME/.docker/run/docker.sock"`. The separate image tag avoids replacing the installed runner. Tests use temporary files and simulated agent results; they do not authenticate or make inference calls.

### Include SSH tests

Build the disposable SSH target, then enable both container test groups:

```bash
docker build -f tests/fixtures/sshd.Dockerfile -t ai-workspace-sshd:tests tests/fixtures
INTEGRATION_TESTS=1 DOCKER_TESTS=1 SSH_DOCKER_TESTS=1 RUNNER_IMAGE=ai-workspace-runner:tests DATABASE_URL=postgres://workspace:workspace@127.0.0.1:54329/workspace npm test
```

Keep the test database running until this command finishes. On macOS, include the `DOCKER_HOST` setting above when needed. To include the deployment and native HTTPS checks in the same run, also set `COMPOSE_TESTS=1`, `CADDY_HTTPS_TESTS=1` and `CADDY_BIN` to your local Caddy 2.11.9 executable. Without those flags, some tests intentionally skip. No test authenticates with a real provider or spends inference credits.

After all chosen integration checks finish, remove the disposable database:

```bash
docker rm -f ai-workspace-test-db
```

### Installed application smoke check

The installed application's smoke command checks temporary runner containers, terminal/file access, Git helpers and the Codex handshake. It creates and removes temporary records in that installation; it does not replace the disposable-database worktree tests. Run it from the installation directory, with `sudo` for a root-installed VPS:

```bash
./ops/compose.sh exec server node dist/node/server/smoke.js
```

Read the [architecture and API overview](docs/architecture.md) and the [provider verification guide](docs/provider-verification.md).

## Pull requests

Explain the problem, resulting behavior, and checks performed. Add meaningful regression coverage for behavior changes, update affected documentation, and include screenshots for visible UI changes. State which integration checks were skipped. Preserve the isolation, approval, and credential boundaries described in the architecture.

Never include `.env`, credentials, real conversations, account profiles, backups, or private repository content. Report security issues privately; see [SECURITY.md](SECURITY.md).

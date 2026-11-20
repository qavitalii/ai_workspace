import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ busy: false }));
vi.mock("../src/server/db.js", () => ({
  db: { query: async () => ({ rowCount: 1 }) },
  transaction: async (callback: (client: unknown) => unknown) =>
    callback({ query: async () => ({ rows: [{ busy: database.busy }] }) }),
}));

const repository = path.resolve(import.meta.dirname, "..");
const temporary: string[] = [];
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "workspace-updates-"));
  temporary.push(root);
  return root;
}
afterEach(() => {
  for (const root of temporary.splice(0))
    rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.resetModules();
  database.busy = false;
});

describe("browser update API", () => {
  it("requires owner authentication and records one exact release request", async () => {
    const root = fixture();
    const statusFile = path.join(root, "status.json");
    const requests = path.join(root, "requests");
    mkdirSync(requests);
    vi.stubEnv("WORKSPACE_UPDATE_STATUS", statusFile);
    vi.stubEnv("WORKSPACE_UPDATE_REQUESTS", requests);
    const { config } = await import("../src/server/config.js");
    const { authRoutes } = await import("../src/server/auth.js");
    const { updateRoutes } = await import("../src/server/updates.js");
    const release = { version: "v1.2.3", commit: "a".repeat(40) };
    const state = {
      phase: "idle",
      heartbeat: Date.now(),
      available: release,
      target: null,
      checkedAt: Date.now(),
      checkFailed: false,
      message: null,
    };
    const save = (phase = state.phase) =>
      writeFileSync(statusFile, JSON.stringify({ ...state, phase }));
    save();
    const app = Fastify();
    await app.register(cookie);
    updateRoutes(app, () => false);
    await authRoutes(app);
    app.post("/api/chats/:id/messages", async () => ({ accepted: true }));
    app.post("/api/approvals/:id", async () => ({ accepted: true }));
    const headers = { cookie: "session=test-session", origin: config.origin };
    const get = () => app.inject({ url: "/api/updates", headers });
    const post = (payload: object, requestHeaders = headers) =>
      app.inject({
        method: "POST",
        url: "/api/updates",
        headers: requestHeaders,
        payload,
      });
    try {
      expect((await get()).json()).toMatchObject({
        updater: "ready",
        available: release,
      });
      expect((await post(release, { ...headers, cookie: "" })).statusCode).toBe(
        401,
      );
      expect(
        (await post(release, { ...headers, origin: "https://other.example" }))
          .statusCode,
      ).toBe(403);
      expect((await post({ ...release, version: "v1.2.4" })).statusCode).toBe(
        409,
      );
      const check = (requestHeaders = headers) =>
        app.inject({
          method: "POST",
          url: "/api/updates/check",
          headers: requestHeaders,
          payload: {},
        });
      expect((await check({ ...headers, cookie: "" })).statusCode).toBe(401);
      expect(
        (await check({ ...headers, origin: "https://other.example" }))
          .statusCode,
      ).toBe(403);
      expect(
        (await Promise.all([check(), check()])).map((r) => r.statusCode),
      ).toEqual([202, 202]);
      expect(readFileSync(path.join(requests, "check"), "utf8")).toBe("");
      expect((await get()).json().checking).toBe(true);
      rmSync(path.join(requests, "check"));
      expect((await get()).json().checking).toBe(false);
      save("waiting");
      expect((await check()).statusCode).toBe(409);
      save();
      writeFileSync(
        statusFile,
        JSON.stringify({ ...state, heartbeat: Date.now() - 120_000 }),
      );
      expect((await check()).statusCode).toBe(503);
      save();
      const results = await Promise.all([post(release), post(release)]);
      expect(results.map((response) => response.statusCode).sort()).toEqual([
        202, 409,
      ]);
      expect(
        JSON.parse(readFileSync(path.join(requests, "update.json"), "utf8")),
      ).toEqual(release);
      expect((await get()).json()).toMatchObject({
        phase: "waiting",
        target: release,
      });

      save("waiting");
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/chats/a/messages",
            headers,
          })
        ).statusCode,
      ).toBe(503);
      expect(
        (await app.inject({ method: "POST", url: "/api/approvals/a", headers }))
          .statusCode,
      ).toBe(200);
      const probe = (remoteAddress: string) =>
        app.inject({ url: "/internal/update-ready", remoteAddress });
      expect((await probe("192.0.2.20")).statusCode).toBe(404);
      database.busy = true;
      expect((await probe("127.0.0.1")).json()).toEqual({ ready: false });
      database.busy = false;
      expect((await probe("127.0.0.1")).json()).toEqual({ ready: true });
      save("updating");
      expect(
        (await app.inject({ method: "POST", url: "/api/approvals/a", headers }))
          .statusCode,
      ).toBe(503);
    } finally {
      await app.close();
    }
  });
});

function hostFixture() {
  const root = fixture();
  const origin = path.join(root, "origin");
  const checkout = path.join(root, "checkout");
  const bin = path.join(root, "bin");
  const log = path.join(root, "commands.log");
  mkdirSync(path.join(origin, "ops"), { recursive: true });
  mkdirSync(bin);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
  const script = (file: string, body: string) =>
    writeFileSync(file, "#!/bin/sh\nset -eu\n" + body, { mode: 0o755 });
  script(
    path.join(origin, "ops", "compose.sh"),
    `
printf '%s\n' "$*" >> "$UPDATE_TEST_LOG"
case "$1" in
  exec) test "$UPDATE_TEST_READY" = yes ;;
  --profile) printf '%s\n' '{"services":{"server":{"image":"server:current"},"runner-image":{"image":"runner:current"}}}' ;;
  ps) echo server-container ;;
  build) test "$UPDATE_TEST_FAILURE" != build ;;
  up)
    if [ "$UPDATE_TEST_FAILURE" = up ]; then
      version=$(cat package.json)
      test "$version" = '{"version":"0.1.0"}'
    fi ;;
esac
`,
  );
  script(
    path.join(origin, "ops", "backup.sh"),
    `
printf 'backup %s\n' "$*" >> "$UPDATE_TEST_LOG"
test "$*" = --keep-stopped
`,
  );
  script(
    path.join(bin, "docker"),
    `
printf 'docker %s\n' "$*" >> "$UPDATE_TEST_LOG"
case "$1" in
  inspect) echo sha256:old-server ;;
  image)
    if [ "$2" = inspect ]; then echo sha256:old-runner; fi ;;
esac
`,
  );
  writeFileSync(path.join(origin, ".gitignore"), ".update-state/\n");
  const setVersion = (version: string) =>
    writeFileSync(
      path.join(origin, "package.json"),
      JSON.stringify({ version }),
    );
  setVersion("0.1.0");
  git(origin, "init", "-b", "main");
  git(origin, "add", ".");
  git(origin, "commit", "-m", "Installed version");
  git(root, "clone", origin, checkout);
  const previous = git(checkout, "rev-parse", "HEAD");
  setVersion("0.2.0");
  git(origin, "commit", "-am", "Next release");
  const candidate = git(origin, "rev-parse", "HEAD");
  git(origin, "tag", "-am", "Release 0.2.0", "v0.2.0");
  setVersion("0.3.0-dev");
  git(origin, "commit", "-am", "Unreleased changes");
  git(origin, "tag", "v10.0.0-rc1");
  const state = path.join(checkout, ".update-state");
  mkdirSync(path.join(state, "status"), { recursive: true });
  mkdirSync(path.join(state, "requests"));
  const request = path.join(state, "requests", "update.json");
  const release = { version: "v0.2.0", commit: candidate };
  return {
    request,
    release,
    previous,
    head: () => git(checkout, "rev-parse", "HEAD"),
    moveTag: () => git(origin, "tag", "-f", "v0.2.0", "HEAD"),
    writeRequest: () => writeFileSync(request, JSON.stringify(release)),
    check: path.join(state, "requests", "check"),
    publish: () => {
      setVersion("0.4.0");
      git(origin, "commit", "-am", "Release 0.4.0");
      git(origin, "tag", "-am", "Release 0.4.0", "v0.4.0");
    },
    status: () =>
      JSON.parse(
        readFileSync(path.join(state, "status", "status.json"), "utf8"),
      ),
    commands: () =>
      existsSync(log) ? readFileSync(log, "utf8").split("\n") : [],
    tick(options: { ready?: boolean; failure?: string } = {}) {
      const result = spawnSync(
        "python3",
        ["-I", path.join(repository, "ops", "browser-updates.py")],
        {
          cwd: checkout,
          env: {
            ...process.env,
            PATH: bin + path.delimiter + process.env.PATH,
            UPDATE_TEST_LOG: log,
            UPDATE_TEST_READY: options.ready === false ? "no" : "yes",
            UPDATE_TEST_FAILURE: options.failure ?? "",
          },
          encoding: "utf8",
        },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
    },
  };
}

describe("Linux update worker with a real Git origin", () => {
  it("waits for an idle server, then builds, backs up and deploys the selected tag", () => {
    const host = hostFixture();
    host.tick();
    expect(host.status().available).toEqual(host.release);
    host.writeRequest();
    host.tick({ ready: false });
    expect(host.status().phase).toBe("waiting");
    expect(host.head()).toBe(host.previous);
    expect(host.commands().some((command) => command.startsWith("build"))).toBe(
      false,
    );
    host.tick();
    expect(host.status().phase).toBe("succeeded");
    expect(host.head()).toBe(host.release.commit);
    expect(existsSync(host.request)).toBe(false);
    expect(
      host.commands().filter((command) => /^(build|backup|up) /.test(command)),
    ).toEqual([
      "build server runner-image",
      "backup --keep-stopped",
      "up -d --wait --wait-timeout 240 server caddy",
    ]);
    host.tick();
    expect(host.status().available).toBeNull();
  }, 15_000);

  it.each(["build", "up"])(
    "restores the previous checkout and both image tags when %s fails",
    (failure) => {
      const host = hostFixture();
      host.tick();
      host.writeRequest();
      host.tick({ failure });
      expect(host.status()).toMatchObject({
        phase: "failed",
        message: expect.stringContaining("previous version"),
      });
      expect(host.head()).toBe(host.previous);
      expect(existsSync(host.request)).toBe(false);
      expect(host.commands()).toContain(
        "docker image tag sha256:old-server server:current",
      );
      expect(host.commands()).toContain(
        "docker image tag sha256:old-runner runner:current",
      );
    },
  );

  it("checks for releases at once when the app requests it, without reading the request", () => {
    const host = hostFixture();
    host.tick();
    const first = host.status().checkedAt;
    expect(host.status().available?.version).toBe("v0.2.0");
    host.publish();
    host.tick();
    // The periodic check has not come due yet.
    expect(host.status().available?.version).toBe("v0.2.0");
    const secret = path.join(fixture(), "secret");
    writeFileSync(secret, "keep");
    symlinkSync(secret, host.check);
    host.tick();
    expect(existsSync(host.check)).toBe(false);
    expect(readFileSync(secret, "utf8")).toBe("keep");
    expect(host.status().available?.version).toBe("v0.4.0");
    expect(host.status().checkedAt).toBeGreaterThanOrEqual(first);
    // A directory in place of the request is ignored, not fatal.
    mkdirSync(host.check);
    host.tick();
    expect(host.status().checkFailed).toBe(false);
  }, 15_000);

  it("rejects symlinks and refuses to install a tag moved after approval", () => {
    const host = hostFixture();
    host.tick();
    const other = path.join(fixture(), "other.json");
    writeFileSync(other, JSON.stringify(host.release));
    symlinkSync(other, host.request);
    host.tick();
    expect(host.status().phase).toBe("failed");
    expect(existsSync(other)).toBe(true);
    host.writeRequest();
    host.moveTag();
    host.tick();
    expect(host.status()).toMatchObject({ phase: "failed", available: null });
    expect(host.head()).toBe(host.previous);
    expect(host.commands().some((command) => command.startsWith("build"))).toBe(
      false,
    );
  });
});

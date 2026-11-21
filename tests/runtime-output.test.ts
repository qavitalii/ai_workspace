import { afterEach, describe, expect, it, vi } from "vitest";
import { Duplex } from "node:stream";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { config } from "../src/server/config";
import { db } from "../src/server/db";
import { docker, launch, type Running } from "../src/server/runtime";
import * as settings from "../src/server/settings";
import * as projectEnvironment from "../src/server/project-env";

function frame(value: unknown) {
  const body = Buffer.from(JSON.stringify(value) + "\n");
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}
describe("runtime output lifecycle with an isolated Docker fixture", () => {
  let root: string;
  const originalData = config.data;
  afterEach(async () => {
    vi.restoreAllMocks();
    config.data = originalData;
    if (root) await rm(root, { recursive: true, force: true });
  });
  async function fixture() {
    root = await mkdtemp(path.join(os.tmpdir(), "workspace-runtime-fixture-"));
    config.data = root;
    const stream = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    let exit!: () => void;
    const waiting = new Promise<void>((resolve) => {
      exit = resolve;
    });
    const container = {
      id: "synthetic-container",
      modem: {
        dial: vi.fn((options: any, callback: any) => {
          expect(options.file).toEqual(Buffer.alloc(0));
          expect(options.options.stdin).toBe(true);
          callback(null, stream);
        }),
      },
      start: vi.fn(async () => {}),
      wait: vi.fn(() => waiting),
      stop: vi.fn(async () => {
        exit();
      }),
      remove: vi.fn(async () => {}),
    };
    const create = vi
      .spyOn(docker, "createContainer")
      .mockResolvedValue(container as any);
    return { stream, container, exit, create };
  }
  it("runs an older image without package-install privileges", async () => {
    const { create } = await fixture();
    const inspect = vi.fn().mockResolvedValue({
      Id: "sha256:legacy",
      Config: { Labels: null },
    });
    vi.spyOn(docker, "getImage").mockReturnValue({ inspect } as any);
    const concurrentTasks = vi.spyOn(settings, "concurrentTasks");
    const onEvent = vi.fn();
    const running = await launch(null, "fixture-account", onEvent, {
      installPackages: true,
    });
    try {
      expect(inspect).toHaveBeenCalledOnce();
      expect(concurrentTasks).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledOnce();
      const options = create.mock.calls[0][0];
      expect(options).toMatchObject({
        Image: "sha256:legacy",
        User: "1000:1000",
        WorkingDir: "/workspace",
        HostConfig: {
          CapDrop: ["ALL"],
          ReadonlyRootfs: true,
          SecurityOpt: ["no-new-privileges:true"],
        },
      });
      expect(options.Entrypoint).toBeUndefined();
      expect(options.Cmd).toBeUndefined();
      expect(options.HostConfig?.CapAdd).toBeUndefined();
      expect(options.HostConfig?.Mounts?.some((m) => m.Target === "/env")).toBe(
        false,
      );
      await expect(
        access(path.join(root, "project-env")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(onEvent).toHaveBeenCalledWith({
        type: "warning",
        message: expect.stringContaining("./ops/compose.sh build runner-image"),
      });
    } finally {
      await running.stop();
    }
  });
  it.each([
    [null, undefined],
    ["fixture-project", undefined],
    ["custom-runner-project", "/opt/toolchain/bin:/usr/bin:/bin"],
  ])(
    "limits the environment to project agents (project %s)",
    async (projectId, imagePath) => {
      const { create } = await fixture();
      const measure = vi
        .spyOn(projectEnvironment, "measureProjectEnv")
        .mockResolvedValue(0);
      const folder = { id: "fixture-folder", project_id: projectId };
      vi.spyOn(db, "query").mockImplementation(async (query) => ({
        rows: String(query).includes("SELECT w.* FROM workspaces w JOIN chats")
          ? [folder]
          : [],
      }));
      const inspect = vi.fn().mockResolvedValue({
        Id: "sha256:project-runner",
        Config: {
          Env: imagePath ? ["PATH=" + imagePath] : undefined,
          Labels: { "ai.workspace.runner.package-installer": "1" },
        },
      });
      vi.spyOn(docker, "getImage").mockReturnValue({ inspect } as any);
      for (const projectEnv of [
        undefined,
        "read-only",
        "read-write",
      ] as const) {
        const run = await launch("fixture-chat", null, vi.fn(), { projectEnv });
        try {
          const options = create.mock.lastCall![0];
          const mount = options.HostConfig?.Mounts?.find(
            (m) => m.Target === "/env",
          );
          if (!projectId || !projectEnv) {
            expect(mount).toBeUndefined();
            expect(options.Env).not.toEqual(
              expect.arrayContaining([expect.stringMatching(/^PATH=/)]),
            );
            await expect(
              access(path.join(root, "project-env")),
            ).rejects.toMatchObject({ code: "ENOENT" });
            continue;
          }
          expect(options.Image).toBe("sha256:project-runner");
          expect(measure).toHaveBeenLastCalledWith(projectId, {
            fresh: projectEnv === "read-write",
            image: "sha256:project-runner",
          });
          expect(options.Entrypoint).toBeUndefined();
          expect(options.HostConfig?.CapAdd).toBeUndefined();
          const source = path.join(root, "project-env", projectId);
          expect(mount).toEqual({
            Type: "bind",
            Source: source,
            Target: "/env",
            ReadOnly: projectEnv === "read-only",
          });
          const directory = await stat(source);
          expect(directory.mode & 0o777).toBe(0o700);
          if (process.getuid?.() === 0)
            expect([directory.uid, directory.gid]).toEqual([1000, 1000]);
          const projectPath =
            (imagePath ??
              "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin") +
            ":/env/bin:/env/npm-global/bin:/env/python/bin:/env/cargo/bin:/env/go/bin";
          expect(options.Env).toEqual(
            expect.arrayContaining([
              "PATH=" + projectPath,
              "WORKSPACE_PROJECT_TOOL_PATH=" + projectPath,
              "NPM_CONFIG_PREFIX=/env/npm-global",
              "NPM_CONFIG_CACHE=/env/cache/npm",
              "PYTHONUSERBASE=/env/python",
              "PIP_CACHE_DIR=/env/cache/pip",
              "PIP_BREAK_SYSTEM_PACKAGES=1",
              "UV_CACHE_DIR=/env/cache/uv",
              "UV_TOOL_DIR=/env/uv",
              "UV_TOOL_BIN_DIR=/env/bin",
              "PIPX_HOME=/env/pipx",
              "PIPX_BIN_DIR=/env/bin",
              "CARGO_HOME=/env/cargo",
              "GOPATH=/env/go",
              "GOMODCACHE=/env/go/pkg/mod",
              "PLAYWRIGHT_BROWSERS_PATH=/env/ms-playwright",
              "XDG_CACHE_HOME=/env/cache",
            ]),
          );
          expect(options.Env).not.toEqual(
            expect.arrayContaining([expect.stringMatching(/^PIP_USER=/)]),
          );
        } finally {
          await run.stop();
        }
      }
    },
  );
  it.each([
    [2 * 1024 ** 3, "Project tools exceed the 1 GiB limit"],
    [null, "Could not measure project tools"],
  ])(
    "keeps project tools read-only with a warning (%s bytes)",
    async (bytes, message) => {
      const { create } = await fixture();
      const folder = { id: "fixture-folder", project_id: "fixture-project" };
      vi.spyOn(db, "query").mockImplementation(async (query) => ({
        rows: String(query).includes("SELECT w.* FROM workspaces w JOIN chats")
          ? [folder]
          : [],
      }));
      vi.spyOn(docker, "getImage").mockReturnValue({
        inspect: vi.fn().mockResolvedValue({ Id: "sha256:project-runner" }),
      } as any);
      vi.spyOn(settings, "projectEnvLimitGib").mockResolvedValue(1);
      const measure = vi.spyOn(projectEnvironment, "measureProjectEnv");
      if (bytes === null) measure.mockRejectedValue(new Error("du failed"));
      else measure.mockResolvedValue(bytes);
      const onEvent = vi.fn();
      const run = await launch("fixture-chat", null, onEvent, {
        projectEnv: "read-write",
      });
      try {
        expect(create.mock.lastCall![0].HostConfig?.Mounts).toContainEqual(
          expect.objectContaining({ Target: "/env", ReadOnly: true }),
        );
        expect(run.projectEnvWarning).toContain(message);
        expect(onEvent).toHaveBeenCalledWith({
          type: "warning",
          message: run.projectEnvWarning,
        });
      } finally {
        await run.stop();
      }
    },
  );
  it("uses the installer entrypoint only on the exact compatible image and never retries startup", async () => {
    const { container, create } = await fixture();
    const inspect = vi.fn().mockResolvedValue({
      Id: "sha256:compatible",
      Config: {
        Labels: { "ai.workspace.runner.package-installer": "1" },
        Entrypoint: ["/other-image-entrypoint"],
      },
    });
    vi.spyOn(docker, "getImage").mockReturnValue({ inspect } as any);
    vi.spyOn(settings, "concurrentTasks").mockResolvedValue(7);
    vi.spyOn(db, "query").mockResolvedValue({ rows: [{ n: "9" }] } as any);
    container.start.mockRejectedValueOnce(new Error("Docker start failed"));
    await expect(
      launch(null, "fixture-account", vi.fn(), { installPackages: true }),
    ).rejects.toThrow("Docker start failed");
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0]).toMatchObject({
      Image: "sha256:compatible",
      User: "0:0",
      Entrypoint: ["/usr/local/bin/workspace-package-runner"],
      Cmd: [],
      Healthcheck: { Test: ["NONE"] },
      Env: expect.arrayContaining(["WORKSPACE_PACKAGE_CONCURRENCY=9"]),
      HostConfig: {
        ReadonlyRootfs: false,
        SecurityOpt: ["no-new-privileges:true"],
      },
    });
    expect(container.remove).toHaveBeenCalledOnce();
  });
  it("allows a completion handler to await stop without deadlocking or double stopping", async () => {
    const { stream, container } = await fixture();
    let running!: Running, completed!: () => void;
    const done = new Promise<void>((resolve) => {
      completed = resolve;
    });
    running = await launch(null, "fixture-account", async (event) => {
      if (event.type === "completed") {
        await running.stop();
        completed();
      }
    });
    stream.push(frame({ type: "completed" }));
    await done;
    await running.stop();
    expect(container.stop).toHaveBeenCalledTimes(1);
    expect(container.remove).toHaveBeenCalledTimes(1);
    expect(stream.destroyed).toBe(true);
  }, 2000);
  it("stops and removes a runner after an oversized event before reporting failure", async () => {
    const { stream, container } = await fixture();
    let failed!: (e: any) => void;
    const failure = new Promise<any>((resolve) => {
      failed = resolve;
    });
    await launch(null, "fixture-account", (event) => {
      if (event.type === "failed") failed(event);
    });
    const header = Buffer.alloc(8);
    header[0] = 1;
    header.writeUInt32BE(2 * 1024 * 1024, 4);
    stream.push(header);
    expect((await failure).error).toContain("oversized");
    expect(container.stop).toHaveBeenCalledTimes(1);
    expect(container.remove).toHaveBeenCalledTimes(1);
    expect(stream.destroyed).toBe(true);
  }, 2000);
  it("delivers the final output before the container exit event", async () => {
    const { stream, exit } = await fixture();
    const events: string[] = [];
    let release!: () => void, exited!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done = new Promise<void>((resolve) => {
      exited = resolve;
    });
    const running = await launch(null, "fixture-account", async (event) => {
      if (event.type === "delta") await gate;
      events.push(event.type);
      if (event.type === "exit") exited();
    });
    stream.push(frame({ type: "delta", text: "last" }));
    stream.push(null);
    exit();
    await new Promise((r) => setImmediate(r));
    expect(events).toEqual([]);
    release();
    await done;
    expect(events).toEqual(["delta", "exit"]);
    await running.stop();
  }, 2000);
});

import type { InjectOptions } from "fastify";
import { runIntegrations } from "../src/server/integrations";
import { prepareAws } from "../src/server/aws";
import { prepareSkills } from "../src/server/skills";
import * as sshRuntime from "../src/server/ssh-runtime";
import { accountUsage, saveUsage } from "../src/server/usage";
import { accountModels } from "../src/server/models";
import {
  availableFolders,
  folderPath,
  folderMounts,
} from "../src/server/folders";
import { copyFolderUpload } from "../src/server/folder-routes";
import { inspectDirectory } from "../src/server/files";
import * as workspaceFiles from "../src/server/files";
import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import Docker from "dockerode";
import WebSocket from "ws";
import {
  mkdtemp,
  mkdir,
  rm,
  readFile,
  writeFile,
  access,
  readdir,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import argon2 from "argon2";
import * as OTPAuth from "otpauth";
import { disconnectAccount } from "../src/server/accounts";
import * as runtimeModule from "../src/server/runtime";
import * as gitModule from "../src/server/git";
import * as githubSync from "../src/server/github-sync";
import { outputStorage, GB } from "../src/server/output-storage";
import { claim, active, runJob } from "../src/server/worker";
import { concurrentTasks } from "../src/server/settings";
import {
  createWorkspace,
  chatWorkspace,
  workspacePath,
} from "../src/server/workspaces";
import { acquireFolder, releaseFolder } from "../src/server/leases";
import { acquireWorkspace, releaseWorkspace } from "../src/server/leases";
import { event } from "../src/server/events";
import { config } from "../src/server/config";
import { db, migrate } from "../src/server/db";
import { createApp } from "../src/server/app";
import { docker, launch, type Running } from "../src/server/runtime";
import { initializeWorkspace, projectToken } from "../src/server/git";
import { hash, seal, unseal } from "../src/server/security";
import { projectToolEnvironment } from "../src/project-tool-environment";
import { measureProjectEnv } from "../src/server/project-env";
import {
  projectPackagePresets,
  recordPackagePresetResults,
  rememberProjectPackages,
  addProjectPackage,
} from "../src/server/project-packages";
import { ProjectImageBuilds } from "../src/server/project-images";
const enabled = process.env.INTEGRATION_TESTS === "1";
describe.skipIf(!enabled)("PostgreSQL API integration", () => {
  let app: Awaited<ReturnType<typeof createApp>>,
    data: string,
    chat: string,
    account: string;
  const token = "test-session-token",
    origin = "http://localhost:5173";
  const headers = { origin, cookie: "session=" + token };
  async function openTerminal(chatId = chat) {
    // Exercise the real close handshake: injectWS uses paired in-memory streams
    // whose server-side close may wait for the WebSocket timeout.
    if (!app.server.listening) await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("No test port");
    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/api/chats/${chatId}/terminal`,
      { headers },
    );
    await once(socket, "open");
    return socket;
  }
  beforeAll(async () => {
    if (!config.database.includes("54329"))
      throw new Error(
        "Integration suite requires isolated test database on port 54329",
      );
    config.key = "ab".repeat(32);
    data = await mkdtemp(path.join(os.tmpdir(), "workspace-api-"));
    config.data = data;
    config.maxFile = 1024;
    await migrate();
    app = await createApp();
  });
  beforeEach(async () => {
    config.maxConcurrent = 3;
    config.projectEnvLimitGib = 8;
    await db.query(
      "TRUNCATE ssh_links,ssh_servers,ssh_keys,workspaces,workspace_leases,publications,push_subscriptions,approvals,events,jobs,attachments,messages,project_packages,chats,accounts,projects,sessions,owner,settings CASCADE",
    );
    await db.query("UPDATE output_storage SET limit_bytes=$1 WHERE id=1", [GB]);
    await db.query("INSERT INTO sessions VALUES($1,now()+interval '1 hour')", [
      hash(token),
    ]);
    const project = randomUUID();
    account = randomUUID();
    chat = randomUUID();
    await db.query("INSERT INTO projects(id,name,repo) VALUES($1,$2,$3)", [
      project,
      "Test",
      "test/repo",
    ]);
    await db.query(
      "INSERT INTO accounts(id,name,provider,status) VALUES($1,'A','codex','ready')",
      [account],
    );
    await createWorkspace(project, "main", "Main folder", db, chat);
    await db.query(
      "UPDATE workspaces SET branch='workspace/test' WHERE id=$1",
      [chat],
    );
    await db.query(
      "INSERT INTO chats(id,project_id,workspace_id,title,provider,account_id,branch) VALUES($1,$2,$1,'Test','codex',$3,'workspace/test')",
      [chat, project, account],
    );
  });

  describe("project images", () => {
    async function newProject() {
      const id = randomUUID();
      await db.query(
        "INSERT INTO projects(id,name,repo) VALUES($1,'Image test','')",
        [id],
      );
      return id;
    }

    async function imageState(project: string) {
      return (
        await db.query("SELECT * FROM project_images WHERE project_id=$1", [
          project,
        ])
      ).rows[0];
    }

    function managedImageTag(hash: string, owner: string) {
      return `ai-workspace-env:${hash.slice(0, 12)}-${owner.slice(0, 12)}`;
    }

    async function queuedImageAt(project: string) {
      const { rows } = await db.query(
        "SELECT package_image_requested_at FROM projects WHERE id=$1",
        [project],
      );
      return rows[0].package_image_requested_at;
    }

    it.skipIf(process.env.DOCKER_TESTS !== "1")(
      "launches cached project packages and falls back when the image is missing or stale",
      async () => {
        const project = (await chatWorkspace(chat)).project_id!;
        const base = await docker.getImage(config.image).inspect();
        const builder = new ProjectImageBuilds();
        let runner: Running | undefined;
        let tag: string | undefined;
        let output = "";
        const options = {
          installPackages: true,
          projectEnv: "read-write",
        } as const;
        const preset = `WORKSPACE_PROJECT_PACKAGES=${JSON.stringify(["hello"])}`;
        const clearRequest = () =>
          db.query(
            "UPDATE projects SET package_image_requested_at=NULL WHERE id=$1",
            [project],
          );
        const queuedAt = () => queuedImageAt(project);
        async function start(
          launchOptions: Parameters<typeof launch>[3] = options,
        ) {
          output = "";
          runner = await launch(
            chat,
            null,
            (e) => {
              if (e.type === "terminal") output += e.data;
            },
            launchOptions,
          );
          return docker.getContainer(runner.id).inspect();
        }
        async function expectHello() {
          runner!.send({
            type: "terminal",
            data: "test \"$(id -u)\" = 1000 && hello && printf '\\nPROJECT_''HELLO\\n'\r",
          });
          await vi.waitFor(
            () => expect(output).toMatch(/^PROJECT_HELLO\r?$/m),
            {
              timeout: 90_000,
            },
          );
        }
        try {
          await addProjectPackage(project, "hello");
          await clearRequest();
          const missing = await start();
          expect(missing.Image).toBe(base.Id);
          expect(missing.Config.Env).toContain(preset);
          expect(await queuedAt()).toBeInstanceOf(Date);
          expect(await imageState(project)).toBeUndefined();
          await expectHello();
          await runner?.stop();

          await builder.tick();
          const built = await vi.waitFor(
            async () => {
              const state = await imageState(project);
              expect(state?.state, state?.log).toBe("ready");
              return state;
            },
            { timeout: 120_000 },
          );
          tag = (await docker.getImage(built.image_id).inspect()).RepoTags[0];
          expect(await queuedAt()).toBeNull();
          const cached = await start();
          expect(cached.Image).toBe(built.image_id);
          expect(cached.Config.Env).not.toContain(preset);
          expect(cached.Config.Env).toContain(
            'WORKSPACE_PROJECT_PACKAGE_RESULT={"results":[{"name":"hello","ok":true}],"incomplete":false}',
          );
          await expectHello();
          await runner?.stop();
          expect(await queuedAt()).toBeNull();

          const readOnly = await start({ projectEnv: "read-only" });
          expect(readOnly.Image).toBe(built.image_id);
          expect(readOnly.HostConfig.ReadonlyRootfs).toBe(true);
          await expectHello();
          await runner?.stop();

          const { Size: imageSize } = await docker
            .getImage(built.image_id)
            .inspect();
          const imageBytes = imageSize - base.Size;
          const envBytes = await measureProjectEnv(project, { fresh: true });
          const addedBytes = Math.min(1024 * 1024, Math.floor(imageBytes / 2));
          const limitBytes = envBytes + imageBytes + Math.floor(addedBytes / 4);
          const payload = path.join(data, "project-env", project, "new-tool");
          const previousLimit = config.projectEnvLimitGib;
          config.projectEnvLimitGib = limitBytes / 1024 ** 3;
          try {
            await writeFile(payload, randomBytes(addedBytes));
            expect(await measureProjectEnv(project)).toBe(envBytes);
            const plan = await start({ projectEnv: "read-only" });
            expect(plan.Image).toBe(base.Id);
            expect(plan.HostConfig.ReadonlyRootfs).toBe(true);
            const actual = await measureProjectEnv(project);
            expect(actual).toBeLessThan(limitBytes);
            expect(actual + imageBytes).toBeGreaterThan(limitBytes);
            await runner?.stop();
          } finally {
            config.projectEnvLimitGib = previousLimit;
            await rm(payload, { force: true });
          }

          vi.stubEnv("WORKSPACE_PACKAGE_PRESET_BUDGET", "1");
          const overBudget = await start();
          expect(overBudget.Image).toBe(base.Id);
          expect(overBudget.Config.Env).toContain(preset);
          expect(await queuedAt()).toBeNull();
          await runner?.stop();
          vi.unstubAllEnvs();

          await db.query(
            "UPDATE project_images SET state='failed' WHERE project_id=$1",
            [project],
          );
          const failed = await start();
          expect(failed.Image).toBe(base.Id);
          expect(failed.Config.Env).toContain(preset);
          expect(await queuedAt()).toBeNull();
          await runner?.stop();
          await db.query(
            "UPDATE project_images SET state='ready' WHERE project_id=$1",
            [project],
          );

          const create = docker.createContainer.bind(docker);
          const container = vi
            .spyOn(docker, "createContainer")
            .mockImplementation((options) => {
              if (options?.Image === built.image_id)
                return Promise.reject(
                  Object.assign(new Error("Image not found"), {
                    statusCode: 404,
                  }),
                );
              return create(options);
            });
          try {
            const removed = await start();
            expect(removed.Image).toBe(base.Id);
            expect(removed.Config.Env).toContain(preset);
            expect(await queuedAt()).toBeInstanceOf(Date);
            expect(
              container.mock.calls.map(([options]) => options?.Image),
            ).toEqual([
              base.Id, // The /env measurement helper.
              built.image_id,
              base.Id,
            ]);
            await runner?.stop();
          } finally {
            container.mockRestore();
          }

          await addProjectPackage(project, "jq");
          await clearRequest();
          const stale = await start();
          expect(stale.Image).toBe(base.Id);
          expect(stale.Config.Env).toContain(
            'WORKSPACE_PROJECT_PACKAGES=["hello","jq"]',
          );
          expect(await queuedAt()).toBeInstanceOf(Date);
          expect(await imageState(project)).toEqual(built);
        } finally {
          vi.unstubAllEnvs();
          await runner?.stop();
          await builder.stop();
          if (tag)
            await docker
              .getImage(tag)
              .remove()
              .catch(() => {});
        }
      },
      260_000,
    );

    it.skipIf(process.env.DOCKER_TESTS !== "1")(
      "retries budget-blocked project image builds when more storage becomes available",
      async () => {
        const project = (await chatWorkspace(chat)).project_id!;
        const base = await docker.getImage(config.image).inspect();
        const builder = new ProjectImageBuilds();
        let runner: Running | undefined;
        let tag: string | undefined;
        async function planningImage() {
          runner = await launch(chat, null, () => {}, {
            projectEnv: "read-only",
          });
          try {
            return (await docker.getContainer(runner.id).inspect()).Image;
          } finally {
            await runner.stop();
            runner = undefined;
          }
        }
        try {
          const envPath = path.join(data, "project-env", project);
          await mkdir(envPath, { recursive: true });
          await writeFile(path.join(envPath, "tool"), randomBytes(4096));
          config.projectEnvLimitGib = 1 / 1024 ** 3;
          await addProjectPackage(project, "hello");
          await builder.tick();
          await vi.waitFor(
            async () => {
              expect(await imageState(project)).toMatchObject({
                state: "failed",
                error:
                  "No project tool storage is available for Debian packages.",
                failed_budget_bytes: "0",
              });
            },
            { timeout: 10_000 },
          );
          expect(await queuedImageAt(project)).toBeNull();

          const smallLimit = 128 * 1024 ** 2;
          config.projectEnvLimitGib = smallLimit / 1024 ** 3;
          expect(await planningImage()).toBe(base.Id);
          expect(await queuedImageAt(project)).toBeInstanceOf(Date);
          await builder.tick();
          const smallBudget = smallLimit - (await measureProjectEnv(project));
          await vi.waitFor(
            async () => {
              expect(await imageState(project)).toMatchObject({
                state: "failed",
                log: expect.stringContaining("system-package budget"),
                failed_budget_bytes: String(smallBudget),
              });
            },
            { timeout: 60_000 },
          );
          expect(await planningImage()).toBe(base.Id);
          expect(await queuedImageAt(project)).toBeNull();

          config.projectEnvLimitGib = 8;
          expect(await planningImage()).toBe(base.Id);
          expect(await queuedImageAt(project)).toBeInstanceOf(Date);
          await builder.tick();
          const built = await vi.waitFor(
            async () => {
              const state = await imageState(project);
              expect(state?.state, state?.log).toBe("ready");
              expect(state.failed_budget_bytes).toBeNull();
              return state;
            },
            { timeout: 120_000 },
          );
          tag = (await docker.getImage(built.image_id).inspect()).RepoTags[0];
          expect(await planningImage()).toBe(built.image_id);
          expect(await queuedImageAt(project)).toBeNull();
        } finally {
          await runner?.stop();
          await builder.stop();
          if (tag)
            await docker
              .getImage(tag)
              .remove()
              .catch(() => {});
        }
      },
      240_000,
    );

    function mockImageDaemon() {
      const built = new Map<string, Partial<Docker.ImageInspectInfo>>();
      let baseId = "sha256:" + "a".repeat(64);
      let baseInspectError: Error | undefined;
      let inspectError: Error | undefined;
      const realGetImage = Docker.prototype.getImage;
      const list = vi
        .spyOn(Docker.prototype, "listImages")
        .mockResolvedValue([]);
      const get = vi
        .spyOn(Docker.prototype, "getImage")
        .mockImplementation(function (this: Docker, name) {
          const image = realGetImage.call(this, name);
          const inspect = vi.spyOn(image, "inspect");
          const cached = built.get(name);
          if (name === config.image && baseInspectError)
            inspect.mockRejectedValue(baseInspectError);
          else if (name === config.image)
            inspect.mockResolvedValue({
              Id: baseId,
              Config: {
                Labels: { "ai.workspace.runner.project-image-builder": "1" },
              },
            } as unknown as Docker.ImageInspectInfo);
          else if (cached && inspectError) {
            inspect.mockRejectedValue(inspectError);
            inspectError = undefined;
          } else if (cached)
            inspect.mockResolvedValue(cached as Docker.ImageInspectInfo);
          else
            inspect.mockRejectedValue(
              Object.assign(new Error("Image not found"), { statusCode: 404 }),
            );
          return image;
        });
      return {
        get,
        replaceBase(id: string) {
          baseId = id;
        },
        failBaseInspect(error: Error) {
          baseInspectError = error;
        },
        complete(
          labels: Record<string, string>,
          id = "sha256:" + "b".repeat(64),
        ) {
          const tag = managedImageTag(
            labels["ai.workspace.env-hash"],
            labels["ai.workspace.env-owner"],
          );
          built.set(tag, {
            Id: id,
            Created: new Date().toISOString(),
            Config: {
              User: "node",
              Labels: labels,
            } as Docker.ImageInspectInfo["Config"],
          });
        },
        failNextBuiltImageInspect(error: Error) {
          inspectError = error;
        },
        restore() {
          list.mockRestore();
          get.mockRestore();
        },
      };
    }

    it.skipIf(process.env.DOCKER_TESTS !== "1")(
      "builds, shares and cleans up project images, preserving runner configuration and recording failures",
      async () => {
        const builder = new ProjectImageBuilds();
        const buildImage = vi.spyOn(docker, "buildImage");
        let container:
          Awaited<ReturnType<typeof docker.createContainer>> | undefined;
        let imageTag: string | undefined;
        try {
          const first = await newProject();
          const second = await newProject();
          const failing = await newProject();
          expect(
            (
              await app.inject({
                method: "POST",
                url: `/api/projects/${first}/packages`,
                headers,
                payload: { name: "hello" },
              })
            ).statusCode,
          ).toBe(200);
          await addProjectPackage(first, "jq");
          await addProjectPackage(second, "jq");
          await addProjectPackage(second, "hello");
          const missing = "workspace-missing-" + randomUUID();
          await addProjectPackage(failing, missing);

          const base = await docker.getImage(config.image).inspect();
          await builder.tick();
          const built = await vi.waitFor(
            async () => {
              const state = await imageState(first);
              expect(state?.state, state?.log).toBe("ready");
              return state;
            },
            { timeout: 120_000 },
          );
          const image = await docker.getImage(built.image_id).inspect();
          imageTag = image.RepoTags[0];
          expect(image.Config.Labels).toMatchObject({
            "ai.workspace.instance": config.data,
            "ai.workspace.env-hash": built.hash,
            "ai.workspace.base-image": base.Id,
            "ai.workspace.runner.package-installer": "1",
            "ai.workspace.runner.package-presets": "1",
          });
          expect(image.Config.User).toBe("node");
          expect(image.Config.Cmd).toEqual(base.Config.Cmd);
          expect(image.Config.Entrypoint).toEqual(base.Config.Entrypoint);
          expect(built.built_at).toBeInstanceOf(Date);
          container = await docker.createContainer({
            Image: built.image_id,
            NetworkDisabled: true,
            Entrypoint: ["/bin/sh", "-c"],
            Cmd: [
              'test "$(id -u)" = 1000 && test "$(command -v hello)" = /usr/bin/hello',
            ],
          });
          await container.start();
          expect((await container.wait()).StatusCode).toBe(0);

          await vi.waitFor(async () => {
            await builder.tick();
            expect(await imageState(second)).toMatchObject({
              state: "ready",
              hash: built.hash,
              image_id: built.image_id,
              built_at: built.built_at,
            });
          });
          expect(buildImage).toHaveBeenCalledTimes(1);
          async function expectFailure() {
            expect(await imageState(failing)).toMatchObject({
              state: "failed",
              image_id: null,
              built_at: null,
              log: expect.stringContaining(missing),
              error: expect.any(String),
            });
          }
          await vi.waitFor(
            async () => {
              await builder.tick();
              await expectFailure();
            },
            { timeout: 120_000 },
          );
          expect(buildImage).toHaveBeenCalledTimes(2);

          await builder.stop();
          const retry = new ProjectImageBuilds();
          try {
            await retry.recover();
            await vi.waitFor(async () => {
              await retry.tick();
              expect(buildImage).toHaveBeenCalledTimes(3);
            });
            expect(await imageState(first)).toEqual(built);
            await vi.waitFor(expectFailure, { timeout: 120_000 });

            const limit = await newProject();
            await addProjectPackage(limit, "hello");
            vi.stubEnv(
              "WORKSPACE_PACKAGE_RUN_BUDGET",
              String(128 * 1024 * 1024),
            );
            try {
              await vi.waitFor(
                async () => {
                  await retry.tick();
                  expect(await imageState(limit)).toMatchObject({
                    state: "failed",
                    log: expect.stringContaining("system-package budget"),
                  });
                },
                { timeout: 120_000 },
              );
            } finally {
              vi.unstubAllEnvs();
            }

            await container.remove();
            container = undefined;
            const pending = await newProject();
            const beforeRemoval = buildImage.mock.calls.length;
            async function removeSavedPackages(project: string) {
              for (const name of ["hello", "jq"]) {
                expect(
                  (
                    await app.inject({
                      method: "DELETE",
                      url: `/api/projects/${project}/packages/${name}`,
                      headers,
                    })
                  ).statusCode,
                ).toBe(200);
              }
            }
            await removeSavedPackages(first);
            await vi.waitFor(async () => {
              await retry.tick();
              expect(await imageState(first)).toBeUndefined();
            });
            expect((await docker.getImage(imageTag).inspect()).Id).toBe(
              built.image_id,
            );

            await removeSavedPackages(second);
            await addProjectPackage(pending, "jq");
            await addProjectPackage(pending, "hello");
            await vi.waitFor(async () => {
              await retry.tick();
              expect(await imageState(second)).toBeUndefined();
              expect(await imageState(pending)).toMatchObject({
                state: "ready",
                image_id: built.image_id,
                built_at: built.built_at,
              });
            });
            expect(buildImage).toHaveBeenCalledTimes(beforeRemoval);

            await removeSavedPackages(pending);
            await vi.waitFor(async () => {
              await retry.tick();
              expect(await imageState(pending)).toBeUndefined();
              await expect(
                docker.getImage(imageTag!).inspect(),
              ).rejects.toMatchObject({ statusCode: 404 });
              expect(
                await docker.listImages({
                  all: true,
                  filters: {
                    label: [
                      `ai.workspace.env-hash=${built.hash}`,
                      `ai.workspace.env-owner=${image.Config.Labels["ai.workspace.env-owner"]}`,
                    ],
                  },
                }),
              ).toEqual([]);
            });
            expect((await docker.getImage(config.image).inspect()).Id).toBe(
              base.Id,
            );
            imageTag = undefined;
          } finally {
            await retry.stop();
          }
        } finally {
          await builder.stop();
          buildImage.mockRestore();
          await container?.remove({ force: true });
          if (imageTag)
            await docker
              .getImage(imageTag)
              .remove()
              .catch((error) => {
                if (error.statusCode !== 404) throw error;
              });
        }
      },
      500_000,
    );

    it("builds while a queued job cannot run and yields when it is claimed", async () => {
      await db.query("UPDATE accounts SET status='disconnected' WHERE id=$1", [
        account,
      ]);
      const queued = await app.inject({
        method: "POST",
        url: `/api/chats/${chat}/messages`,
        headers,
        payload: { content: "Queued task", client_id: randomUUID() },
      });
      expect(queued.statusCode).toBe(200);
      expect(await claim()).toBeNull();
      const project = await newProject();
      await addProjectPackage(project, "hello");
      const builder = new ProjectImageBuilds();
      const daemon = mockImageDaemon();
      let buildSignal: AbortSignal | undefined;
      const build = vi
        .spyOn(docker, "buildImage")
        .mockImplementation(async (_context, options) => {
          const signal = options!.abortSignal!;
          buildSignal = signal;
          const stream = new PassThrough();
          signal.addEventListener("abort", () => stream.destroy(), {
            once: true,
          });
          return stream;
        });
      try {
        await builder.tick();
        await vi.waitFor(() => expect(buildSignal).toBeDefined());
        await db.query("UPDATE accounts SET status='ready' WHERE id=$1", [
          account,
        ]);
        expect((await claim())?.id).toBe(queued.json().job_id);
        await builder.tick();
        expect(buildSignal?.aborted).toBe(true);
      } finally {
        await builder.stop();
        build.mockRestore();
        daemon.restore();
      }
    });

    it("discards an idle result already in flight when a foreground job is claimed", async () => {
      const project = await newProject();
      await addProjectPackage(project, "hello");
      const builder = new ProjectImageBuilds();
      const daemon = mockImageDaemon();
      let releaseIdleResult!: () => void;
      const idleResultGate = new Promise<void>((resolve) => {
        releaseIdleResult = resolve;
      });
      const realQuery = db.query.bind(db);
      let checks = 0;
      const query = vi
        .spyOn(db, "query")
        .mockImplementation(async (...args) => {
          const result = await Reflect.apply(realQuery, db, args);
          if (
            typeof args[0] === "string" &&
            args[0].includes(
              "OR EXISTS(SELECT 1 FROM workspace_leases WHERE kind='terminal')",
            ) &&
            ++checks === 2
          )
            await idleResultGate;
          return result;
        });
      const polling = builder.tick();
      try {
        await vi.waitFor(() => expect(checks).toBe(2));
        const queued = await app.inject({
          method: "POST",
          url: `/api/chats/${chat}/messages`,
          headers,
          payload: { content: "Foreground task", client_id: randomUUID() },
        });
        expect(queued.statusCode).toBe(200);
        expect((await claim())?.id).toBe(queued.json().job_id);
        await builder.tick(false);
        await builder.tick();
        releaseIdleResult();
        await polling;
        expect(daemon.get.mock.calls).toEqual([[config.image]]);
      } finally {
        releaseIdleResult();
        await builder.stop();
        query.mockRestore();
        daemon.restore();
      }
    });

    it("yields to a terminal and cancels a build when its package list changes", async () => {
      const builder = new ProjectImageBuilds();
      const signals: AbortSignal[] = [];
      const daemon = mockImageDaemon();
      const buildImage = vi
        .spyOn(docker, "buildImage")
        .mockImplementation(async (_file, options) => {
          const signal = options!.abortSignal!;
          signals.push(signal);
          const stream = new PassThrough();
          signal.addEventListener(
            "abort",
            () => stream.destroy(signal.reason),
            { once: true },
          );
          return stream;
        });
      try {
        const {
          rows: [{ project_id: project }],
        } = await db.query("SELECT project_id FROM chats WHERE id=$1", [chat]);
        await rememberProjectPackages(project, chat, randomUUID(), ["hello"]);
        await db.query(
          "INSERT INTO workspace_leases(workspace_id,chat_id,kind) VALUES($1,$1,'terminal')",
          [chat],
        );
        await builder.tick();
        expect(buildImage).not.toHaveBeenCalled();
        await db.query("DELETE FROM workspace_leases WHERE chat_id=$1", [chat]);

        await Promise.all([builder.tick(), builder.tick()]);
        await vi.waitFor(() => expect(signals).toHaveLength(1));
        const initial = await imageState(project);
        expect(initial.state).toBe("building");
        await addProjectPackage(project, "jq");
        await builder.tick();
        expect(signals[0].aborted).toBe(true);
        await vi.waitFor(async () => {
          await builder.tick();
          expect(signals).toHaveLength(2);
        });
        expect(await imageState(project)).toMatchObject({
          state: "building",
          hash: expect.not.stringMatching(initial.hash),
        });
        await db.query(
          "INSERT INTO workspace_leases(workspace_id,chat_id,kind) VALUES($1,$1,'terminal')",
          [chat],
        );
        await builder.tick();
        expect(signals[1].aborted).toBe(true);
      } finally {
        await builder.stop();
        buildImage.mockRestore();
        daemon.restore();
      }
    });

    it("retries database faults before and after a build without rebuilding the image", async () => {
      const project = await newProject();
      await addProjectPackage(project, "hello");
      const builder = new ProjectImageBuilds();
      const daemon = mockImageDaemon();
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const now = Date.now.bind(Date);
      const clock = vi.spyOn(Date, "now");
      const build = vi
        .spyOn(docker, "buildImage")
        .mockImplementation(async (_context, options) => {
          daemon.complete(options!.labels!);
          const stream = new PassThrough();
          stream.end('{"stream":"Built image."}\n');
          return stream;
        });
      const realConnect = db.connect.bind(db);
      const realQuery = db.query.bind(db);
      let starts = 0;
      let finalizations = 0;
      const query = vi.spyOn(db, "query").mockImplementation((...args) => {
        const [sql] = args;
        if (
          typeof sql === "string" &&
          sql.includes("SELECT id,$3,'building'") &&
          ++starts === 1
        )
          return Promise.reject(new Error("Could not mark image building"));
        return Reflect.apply(realQuery, db, args);
      });
      const connect = vi.spyOn(db, "connect").mockImplementation((callback) => {
        if (callback) return realConnect(callback);
        if (++finalizations === 1)
          return Promise.reject(new Error("Database temporarily unavailable"));
        return realConnect();
      });
      try {
        await builder.tick();
        await vi.waitFor(() =>
          expect(log).toHaveBeenCalledWith(
            "Project image build failed:",
            expect.stringContaining("Could not mark image building"),
          ),
        );
        expect(await imageState(project)).toBeUndefined();
        expect(build).not.toHaveBeenCalled();
        clock.mockImplementation(() => now() + 10_000);
        await builder.tick();
        await vi.waitFor(() =>
          expect(log).toHaveBeenCalledWith(
            "Project image build failed:",
            expect.stringContaining("Database temporarily unavailable"),
          ),
        );
        expect((await imageState(project)).state).toBe("building");
        await builder.tick();
        expect(finalizations).toBe(1);
        clock.mockImplementation(() => now() + 20_000);
        await vi.waitFor(async () => {
          await builder.tick();
          expect(await imageState(project)).toMatchObject({
            state: "ready",
            image_id: "sha256:" + "b".repeat(64),
          });
        });
        expect(build).toHaveBeenCalledTimes(1);
      } finally {
        await builder.stop();
        connect.mockRestore();
        query.mockRestore();
        build.mockRestore();
        clock.mockRestore();
        log.mockRestore();
        daemon.restore();
      }
    });

    it("rebuilds an invalid project image under the expected tag", async () => {
      const project = await newProject();
      const builder = new ProjectImageBuilds();
      const daemon = mockImageDaemon();
      const build = vi
        .spyOn(docker, "buildImage")
        .mockImplementation(async (_context, options) => {
          daemon.complete(options!.labels!);
          return new PassThrough().end('{"stream":"Built image."}\n');
        });
      try {
        await addProjectPackage(project, "hello");
        const base = await docker.getImage(config.image).inspect();
        const hash = createHash("sha256")
          .update(JSON.stringify([base.Id, ["hello"]]))
          .digest("hex");
        const owner = createHash("sha256").update(config.data).digest("hex");
        const tag = managedImageTag(hash, owner);
        const staleImage = "sha256:" + "c".repeat(64);
        daemon.complete(
          {
            "ai.workspace.instance": config.data,
            "ai.workspace.env-owner": owner,
            "ai.workspace.env-hash": hash,
            "ai.workspace.base-image": "sha256:" + "d".repeat(64),
            "ai.workspace.runner.package-installer": "1",
          },
          staleImage,
        );
        expect((await docker.getImage(tag).inspect()).Id).toBe(staleImage);

        await builder.tick();
        const ready = await vi.waitFor(async () => {
          const state = await imageState(project);
          expect(state?.state, state?.log).toBe("ready");
          return state;
        });
        expect(build).toHaveBeenCalledExactlyOnceWith(
          expect.anything(),
          expect.objectContaining({ t: tag }),
        );
        expect(ready).toMatchObject({
          hash,
          image_id: "sha256:" + "b".repeat(64),
          error: null,
        });
        expect((await docker.getImage(tag).inspect()).Id).toBe(ready.image_id);
        expect(await queuedImageAt(project)).toBeNull();
      } finally {
        await builder.stop();
        build.mockRestore();
        daemon.restore();
      }
    });

    it("retries a failed post-build inspection and reuses the completed image", async () => {
      const project = await newProject();
      await addProjectPackage(project, "hello");
      const builder = new ProjectImageBuilds();
      const daemon = mockImageDaemon();
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const now = Date.now.bind(Date);
      const clock = vi.spyOn(Date, "now");
      const build = vi
        .spyOn(docker, "buildImage")
        .mockImplementation(async (_context, options) => {
          daemon.complete(options!.labels!);
          daemon.failNextBuiltImageInspect(
            Object.assign(new Error("Docker is temporarily unavailable"), {
              statusCode: 503,
            }),
          );
          const stream = new PassThrough();
          stream.end('{"stream":"Built image."}\n');
          return stream;
        });
      try {
        await builder.tick();
        await vi.waitFor(() =>
          expect(log).toHaveBeenCalledWith(
            "Project image build failed:",
            expect.stringContaining("Docker is temporarily unavailable"),
          ),
        );
        expect((await imageState(project)).state).toBe("building");
        clock.mockImplementation(() => now() + 10_000);
        await vi.waitFor(async () => {
          await builder.tick();
          expect(await imageState(project)).toMatchObject({
            state: "ready",
            image_id: "sha256:" + "b".repeat(64),
          });
        });
        expect(build).toHaveBeenCalledTimes(1);
      } finally {
        await builder.stop();
        build.mockRestore();
        clock.mockRestore();
        log.mockRestore();
        daemon.restore();
      }
    });

    it.each([{ statusCode: 503 }, { code: "ECONNRESET" }])(
      "keeps the build queued after a transient Docker failure (%j)",
      async (details) => {
        const project = await newProject();
        await addProjectPackage(project, "hello");
        const builder = new ProjectImageBuilds();
        const daemon = mockImageDaemon();
        const log = vi.spyOn(console, "error").mockImplementation(() => {});
        const now = Date.now.bind(Date);
        const clock = vi.spyOn(Date, "now");
        const build = vi
          .spyOn(docker, "buildImage")
          .mockRejectedValueOnce(
            Object.assign(new Error("Build connection failed"), details),
          )
          .mockImplementation(async (_context, options) => {
            daemon.complete(options!.labels!);
            return new PassThrough().end('{"stream":"Built image."}\n');
          });
        try {
          await builder.tick();
          await vi.waitFor(() =>
            expect(log).toHaveBeenCalledWith(
              "Project image build failed:",
              expect.stringContaining("Build connection failed"),
            ),
          );
          expect((await imageState(project)).state).toBe("building");
          await builder.tick();
          expect(build).toHaveBeenCalledTimes(1);
          clock.mockImplementation(() => now() + 10_000);
          await vi.waitFor(async () => {
            await builder.tick();
            expect((await imageState(project)).state).toBe("ready");
          });
          expect(build).toHaveBeenCalledTimes(2);
        } finally {
          await builder.stop();
          build.mockRestore();
          clock.mockRestore();
          log.mockRestore();
          daemon.restore();
        }
      },
    );

    it("rebuilds a ready project when the base runner tag changes while idle", async () => {
      const project = await newProject();
      await addProjectPackage(project, "hello");
      const builder = new ProjectImageBuilds();
      const daemon = mockImageDaemon();
      const nextBase = "sha256:" + "c".repeat(64);
      const nextImage = "sha256:" + "d".repeat(64);
      const now = Date.now.bind(Date);
      const clock = vi.spyOn(Date, "now");
      const build = vi
        .spyOn(docker, "buildImage")
        .mockImplementation(async (_context, options) => {
          const labels = options!.labels!;
          daemon.complete(
            labels,
            labels["ai.workspace.base-image"] === nextBase
              ? nextImage
              : undefined,
          );
          return new PassThrough().end('{"stream":"Built image."}\n');
        });
      try {
        await builder.tick();
        const original = await vi.waitFor(async () => {
          const state = await imageState(project);
          expect(state?.state).toBe("ready");
          return state;
        });
        await builder.tick();
        expect(build).toHaveBeenCalledTimes(1);

        daemon.replaceBase(nextBase);
        clock.mockImplementation(() => now() + 120_000);
        await vi.waitFor(async () => {
          await builder.tick();
          expect(await imageState(project)).toMatchObject({
            state: "ready",
            image_id: nextImage,
          });
        });
        expect((await imageState(project)).hash).not.toBe(original.hash);
        expect(build).toHaveBeenCalledTimes(2);
      } finally {
        await builder.stop();
        build.mockRestore();
        clock.mockRestore();
        daemon.restore();
      }
    });

    it("clears an empty package request even when Docker inspection fails", async () => {
      const project = await newProject();
      await addProjectPackage(project, "hello");
      await db.query(
        "INSERT INTO project_images(project_id,hash,image_id,state) VALUES($1,'previous','image','ready')",
        [project],
      );
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: `/api/projects/${project}/packages/hello`,
            headers,
          })
        ).statusCode,
      ).toBe(200);
      const builder = new ProjectImageBuilds();
      const daemon = mockImageDaemon();
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      daemon.failBaseInspect(
        Object.assign(new Error("Docker temporarily unavailable"), {
          statusCode: 503,
        }),
      );
      try {
        await builder.tick();
        expect(await imageState(project)).toBeUndefined();
        expect(
          (
            await db.query(
              "SELECT package_image_requested_at FROM projects WHERE id=$1",
              [project],
            )
          ).rows[0].package_image_requested_at,
        ).toBeNull();
      } finally {
        await builder.stop();
        log.mockRestore();
        daemon.restore();
      }
    });

    it("preserves ready and reusable pending image chains and removes detached layers", async () => {
      const builder = new ProjectImageBuilds();
      const baseId = "sha256:" + "a".repeat(64);
      const layerId = "sha256:" + "b".repeat(64);
      const taggedId = "sha256:" + "c".repeat(64);
      const referencedHash = "d".repeat(64);
      const orphanHash = "e".repeat(64);
      const pendingHash = createHash("sha256")
        .update(JSON.stringify([baseId, ["hello", "jq"]]))
        .digest("hex");
      const owner = createHash("sha256").update(config.data).digest("hex");
      const tag = managedImageTag(orphanHash, owner);
      const project = await newProject();
      await db.query(
        "INSERT INTO project_images(project_id,hash,image_id,state) VALUES($1,$2,'shared','ready')",
        [project, referencedHash],
      );
      const pending = await newProject();
      await addProjectPackage(pending, "jq");
      await addProjectPackage(pending, "hello");
      function image(
        Id: string,
        ParentId: string,
        hash: string,
        RepoTags?: string[],
      ): Docker.ImageInfo {
        return {
          Id,
          ParentId,
          RepoTags,
          Created: 0,
          Size: 0,
          VirtualSize: 0,
          SharedSize: 0,
          Containers: 0,
          Labels: {
            "ai.workspace.env-owner": owner,
            "ai.workspace.env-hash": hash,
            "ai.workspace.base-image": baseId,
          },
        };
      }
      const list = vi
        .spyOn(Docker.prototype, "listImages")
        .mockResolvedValue([
          image(layerId, baseId, orphanHash),
          image(taggedId, layerId, orphanHash, [tag]),
          image(baseId, "", orphanHash),
          image("shared", "shared-layer", referencedHash),
          image("shared-layer", baseId, referencedHash),
          image("detached-ready-layer", baseId, referencedHash),
          image("foreign", baseId, orphanHash, ["manual:keep"]),
          image("pending", "pending-layer", pendingHash, [
            managedImageTag(pendingHash, owner),
          ]),
          image("pending-layer", baseId, pendingHash),
          image("detached-pending-layer", baseId, pendingHash),
        ]);
      const remove = vi.fn().mockResolvedValue([]);
      const get = vi.spyOn(Docker.prototype, "getImage").mockImplementation(
        (name) =>
          ({
            inspect: async () => ({ Id: baseId }),
            remove: async () => remove(name),
          }) as unknown as Docker.Image,
      );
      try {
        await builder.tick();
        expect(remove.mock.calls).toEqual([
          [tag],
          [layerId],
          ["detached-ready-layer"],
          ["detached-pending-layer"],
        ]);
      } finally {
        await builder.stop();
        get.mockRestore();
        list.mockRestore();
      }
    });
  });

  describe("project Debian packages", () => {
    let project: string, url: string;

    beforeEach(async () => {
      const { rows } = await db.query<{ project_id: string }>(
        "SELECT project_id FROM chats WHERE id=$1",
        [chat],
      );
      project = rows[0].project_id;
      url = `/api/projects/${project}/packages`;
    });

    function request(options: InjectOptions) {
      return app.inject({ ...options, remoteAddress: "192.0.2.40" });
    }

    async function list() {
      const response = await request({ url, headers });
      expect(response.statusCode).toBe(200);
      return response.json<import("../src/shared").ProjectPackages>();
    }

    function add(name: string) {
      return request({ method: "POST", url, headers, payload: { name } });
    }

    async function withRunningJob<T>(
      run: (emit: Parameters<typeof launch>[2], jobId: string) => Promise<T>,
    ) {
      const message = await request({
        method: "POST",
        url: `/api/chats/${chat}/messages`,
        headers,
        payload: { content: "Install project tools", client_id: randomUUID() },
      });
      expect(message.statusCode).toBe(200);
      const job = await claim();
      expect(job?.chat_id).toBe(chat);
      let emit!: Parameters<typeof launch>[2];
      const initialize = vi
        .spyOn(gitModule, "initializeWorkspace")
        .mockResolvedValue();
      const runner = vi
        .spyOn(runtimeModule, "launch")
        .mockImplementation(async (_chat, _account, handler) => {
          emit = handler;
          return {
            id: "packages-runtime",
            send: vi.fn(),
            stop: async () => {},
          };
        });
      try {
        await runJob(job);
        return await run(emit, job.id);
      } finally {
        runner.mockRestore();
        initialize.mockRestore();
        active.delete(job.id);
      }
    }

    function emitInstallRequests(...requests: string[][]) {
      return withRunningJob(async (emit, jobId) => {
        for (const packages of requests)
          await emit({ type: "packages_installed", packages });
        await emit({ type: "completed" });
        const { rows } = await db.query("SELECT state FROM jobs WHERE id=$1", [
          jobId,
        ]);
        expect(rows[0].state).toBe("completed");
        return (
          await db.query(
            "SELECT type,data FROM events WHERE job_id=$1 AND type IN ('log','packages_installed') ORDER BY id",
            [jobId],
          )
        ).rows;
      });
    }

    it("remembers an installed package when the chat output limit blocks logging", async () => {
      await withRunningJob(async (emit, jobId) => {
        await db.query(
          "UPDATE output_storage SET limit_bytes=used_bytes WHERE id=1",
        );
        await emit({ type: "packages_installed", packages: ["curl"] });
        const { rows } = await db.query(
          "SELECT state,error FROM jobs WHERE id=$1",
          [jobId],
        );
        expect(rows[0]).toMatchObject({
          state: "failed",
          error: expect.stringContaining("output limit reached"),
        });
      });
      expect((await list()).packages).toMatchObject([
        { name: "curl", source: "agent", source_chat_id: chat },
      ]);
    });

    it("counts concurrent preset failures once each and ignores replaced entries", async () => {
      expect((await add("hello")).statusCode).toBe(200);
      expect((await add("sl")).statusCode).toBe(200);
      const presets = await projectPackagePresets(project);
      const fail = () =>
        recordPackagePresetResults(project, presets, [
          { name: "hello", ok: false },
        ]);
      await Promise.all([fail(), fail(), fail()]);
      expect((await list()).packages).toContainEqual(
        expect.objectContaining({ name: "hello", failures: 3, disabled: true }),
      );
      expect([...(await projectPackagePresets(project)).keys()]).toEqual([
        "sl",
      ]);

      expect(
        (await request({ method: "DELETE", url: url + "/sl", headers }))
          .statusCode,
      ).toBe(200);
      expect((await add("sl")).statusCode).toBe(200);
      await recordPackagePresetResults(project, presets, [
        { name: "sl", ok: false },
      ]);
      expect((await list()).packages).toContainEqual(
        expect.objectContaining({ name: "sl", failures: 0, disabled: false }),
      );
    });

    it("returns startup notices beyond the recent history for the latest job", async () => {
      await withRunningJob(async (emit, jobId) => {
        const output = {
          type: "log",
          projectPackageStartup: true,
          text: "Preset budget is zero.\nPackages: hello, sl",
        };
        const warning = {
          type: "warning",
          projectPackageStartup: true,
          message: "Workspace skipped some saved Debian packages.",
        };
        const read = async () => {
          const response = await request({
            url: `/api/chats/${chat}`,
            headers,
          });
          expect(response.statusCode).toBe(200);
          return response.json();
        };
        await emit(output);
        await emit(warning);
        const ids = (await read()).events.map(
          (entry: { id: string }) => entry.id,
        );
        expect(ids).toHaveLength(2);
        await db.query(
          `INSERT INTO events(chat_id,job_id,type,data)
           SELECT $1,$2,'log',jsonb_build_object('text','Later output '||n)
           FROM generate_series(1,165) n`,
          [chat, jobId],
        );
        const { events } = await read();
        expect(events).toHaveLength(102);
        expect(events.slice(0, 2)).toMatchObject([
          { id: ids[0], data: output },
          { id: ids[1], data: warning },
        ]);
        await emit({ type: "completed" });
        expect(
          (
            await request({
              method: "POST",
              url: `/api/chats/${chat}/messages`,
              headers,
              payload: { content: "Next task", client_id: randomUUID() },
            })
          ).statusCode,
        ).toBe(200);
        expect((await read()).events).toHaveLength(100);
      });
    });

    it("keeps a full startup package list when the remaining output quota is small", async () => {
      await withRunningJob(async (emit, jobId) => {
        const packages = Array.from({ length: 256 }, (_, index) =>
          `workspace-fixture-package-${index}`.padEnd(63, "x"),
        );
        const output = {
          type: "log",
          projectPackageStartup: true,
          text: `Preset budget is zero.\nPackages: ${packages.join(", ")}`,
        };
        const warning = {
          type: "warning",
          projectPackageStartup: true,
          message: "Workspace skipped some saved Debian packages.",
        };
        await db.query(
          "UPDATE output_storage SET limit_bytes=used_bytes+5000 WHERE id=1",
        );
        const before = await outputStorage();
        await emit(output);
        await emit(warning);
        expect(await outputStorage()).toEqual(before);

        await emit({ type: "session", id: "fixture-session" });
        const lateLog = { ...output, text: "Marked log after startup." };
        const afterStartup = await outputStorage();
        await emit(lateLog);
        expect((await outputStorage()).usedBytes).toBeGreaterThan(
          afterStartup.usedBytes,
        );
        await emit({ type: "completed", result: "Task completed." });
        const response = await request({ url: `/api/chats/${chat}`, headers });
        expect(response.statusCode).toBe(200);
        const detail = response.json();
        expect(detail.jobs[0]).toMatchObject({ id: jobId, state: "completed" });
        expect(detail.messages.at(-1)).toMatchObject({
          role: "assistant",
          content: "Task completed.",
        });
        expect(detail.events).toMatchObject([
          { data: output },
          { data: warning },
          { data: lateLog },
        ]);
      });
    });

    it("bounds the size and number of quota-exempt startup notices", async () => {
      await withRunningJob(async (emit, jobId) => {
        const startup = {
          type: "log",
          projectPackageStartup: true,
          text: "Startup notice",
        };
        await emit({ ...startup, text: "x".repeat(33 * 1024) });
        for (let i = 0; i < 5; i++) await emit(startup);
        await emit({ type: "completed" });

        const { rows } = await db.query(
          "SELECT package_startup_notice FROM events WHERE job_id=$1 AND type='log' ORDER BY id",
          [jobId],
        );
        expect(rows.map((row) => row.package_startup_notice)).toEqual([
          false,
          true,
          true,
          true,
          true,
          false,
        ]);
        const { usedBytes } = await outputStorage();
        await db.query(
          "DELETE FROM events WHERE job_id=$1 AND package_startup_notice",
          [jobId],
        );
        expect((await outputStorage()).usedBytes).toBe(usedBytes);
      });
    });

    it.skipIf(process.env.DOCKER_TESTS !== "1").each([
      ["zero budget", "the preset budget is zero"],
      ["full project storage", "no project tool storage was available"],
    ])(
      "logs the skipped package names for %s before starting the runner",
      async (scenario, reason) => {
        for (const name of ["hello", "sl"])
          expect((await add(name)).statusCode).toBe(200);
        await db.query(
          "UPDATE project_packages SET failures=2 WHERE project_id=$1",
          [project],
        );
        if (scenario === "zero budget") {
          vi.stubEnv("WORKSPACE_PACKAGE_PRESET_BUDGET", "0");
        } else {
          config.projectEnvLimitGib = 1 / 1024 ** 3;
          const dir = path.join(data, "project-env", project);
          await mkdir(dir, { recursive: true });
          await writeFile(path.join(dir, "fixture"), Buffer.alloc(4096, 1));
        }
        const events: import("../src/shared").AgentEvent[] = [];
        let runner;
        try {
          runner = await launch(
            chat,
            account,
            (e) => {
              events.push(e);
            },
            {
              installPackages: true,
              projectEnv: "read-write",
            },
          );
          expect(events).toContainEqual({
            type: "log",
            projectPackageStartup: true,
            text: `Skipped project Debian packages because ${reason}.\nPackages: hello, sl`,
          });
          expect((await list()).packages).toMatchObject([
            { name: "sl", failures: 2, disabled: false },
            { name: "hello", failures: 2, disabled: false },
          ]);
        } finally {
          vi.unstubAllEnvs();
          await runner?.stop();
        }
      },
      20_000,
    );

    it.skipIf(process.env.DOCKER_TESTS !== "1").each([
      {
        scenario: "the installer cannot start",
        scripts: [
          ["/usr/local/lib/workspace-install/sandbox", "#!/bin/sh\nexit 1\n"],
        ],
        reason: "The Debian package installer is unavailable in this runner.",
      },
      {
        scenario: "the preset helper exits with an error",
        scripts: [
          [
            "/app/dist/node/runner/package-presets.js",
            "process.exitCode = 1;\n",
          ],
        ],
        reason: "The package preset helper exited without a result.",
      },
      {
        scenario: "the preset helper exits successfully without output",
        scripts: [
          [
            "/app/dist/node/runner/package-presets.js",
            "process.exitCode = 0;\n",
          ],
        ],
        reason: "The package preset helper exited without a result.",
      },
      {
        scenario: "apt-cache exits with code 127",
        scripts: [
          ["/usr/bin/apt-get", "#!/bin/sh\nexit 0\n"],
          [
            "/usr/bin/apt-cache",
            "#!/bin/sh\necho 'apt-cache: error while loading shared libraries' >&2\nexit 127\n",
          ],
        ],
        reason: "apt-cache: error while loading shared libraries",
      },
    ])(
      "logs all skipped package names when $scenario",
      async ({ scripts, reason }) => {
        for (const name of ["hello", "sl"])
          expect((await add(name)).statusCode).toBe(200);
        await db.query(
          "UPDATE project_packages SET failures=2 WHERE project_id=$1",
          [project],
        );
        const mounts = await Promise.all(
          scripts.map(async ([target, script], index) => {
            const fixture = path.join(data, `package-startup-failure-${index}`);
            await writeFile(fixture, script, { mode: 0o755 });
            return {
              Type: "bind",
              Source: fixture,
              Target: target,
              ReadOnly: true,
            } as const;
          }),
        );
        const createContainer = docker.createContainer.bind(docker);
        const containers = vi
          .spyOn(docker, "createContainer")
          .mockImplementation((options) => {
            if (
              options.Entrypoint?.[0] ===
              "/usr/local/bin/workspace-package-runner"
            )
              options.HostConfig?.Mounts?.push(...mounts);
            return createContainer(options);
          });
        let runner;
        try {
          let output = "";
          const logs: string[] = [];
          runner = await launch(
            chat,
            account,
            (e) => {
              if (e.type === "terminal") output += e.data;
              if (e.type === "log" && e.projectPackageStartup)
                logs.push(e.text);
            },
            { installPackages: true, projectEnv: "read-write" },
          );
          runner.send({
            type: "terminal",
            data: "printf '\\nRUNNER_''READY\\n'\r",
          });
          await vi.waitFor(() => expect(output).toMatch(/^RUNNER_READY\r?$/m), {
            timeout: 15_000,
          });
          expect(logs).toEqual([
            `Skipped project Debian packages. ${reason}\nPackages: hello, sl`,
          ]);
          expect((await list()).packages).toMatchObject([
            { name: "sl", failures: 2, disabled: false },
            { name: "hello", failures: 2, disabled: false },
          ]);
        } finally {
          containers.mockRestore();
          await runner?.stop();
        }
      },
      25_000,
    );

    it.skipIf(process.env.DOCKER_TESTS !== "1")(
      "logs the preset disk-budget skip and leaves the package enabled",
      async () => {
        expect((await add("hello")).statusCode).toBe(200);
        const morePackages = Array.from(
          { length: 64 },
          (_, i) => `workspace-fixture-package-${String(i).padStart(2, "0")}`,
        );
        await db.query(
          `INSERT INTO project_packages(project_id,name,source,request_id)
           SELECT $1,name,'owner',$2 FROM unnest($3::text[]) AS packages(name)`,
          [project, randomUUID(), morePackages],
        );
        await db.query(
          "UPDATE project_packages SET failures=2 WHERE project_id=$1 AND name='hello'",
          [project],
        );
        const budget = String(64 * 1024 ** 2);
        vi.stubEnv("WORKSPACE_PACKAGE_PRESET_BUDGET", budget);
        const events: import("../src/shared").AgentEvent[] = [];
        let runner;
        try {
          let output = "";
          runner = await launch(
            chat,
            account,
            (e) => {
              if (e.type === "terminal") output += e.data;
              else events.push(e);
            },
            { installPackages: true, projectEnv: "read-write" },
          );
          runner.send({
            type: "terminal",
            data: "printf '\\nRUNNER_''READY\\n'\r",
          });
          await vi.waitFor(() => expect(output).toMatch(/^RUNNER_READY\r?$/m), {
            timeout: 15_000,
          });
          expect(events).toContainEqual({
            type: "log",
            projectPackageStartup: true,
            text: expect.stringContaining(
              `exceed the ${budget} bytes system-package budget for this preset.\nPackages: ${["hello", ...morePackages].join(", ")}`,
            ),
          });
          expect((await list()).packages).toContainEqual(
            expect.objectContaining({
              name: "hello",
              failures: 2,
              disabled: false,
            }),
          );
        } finally {
          vi.unstubAllEnvs();
          await runner?.stop();
        }
      },
      45_000,
    );

    it.skipIf(process.env.DOCKER_TESTS !== "1")(
      "preinstalls remembered Debian packages before the first command in another chat",
      async () => {
        let output = "";
        const first = await launch(
          chat,
          account,
          async (e) => {
            if (e.type === "terminal") output += e.data;
            if (e.type === "packages_installed")
              await rememberProjectPackages(
                project,
                chat,
                randomUUID(),
                e.packages,
              );
          },
          { installPackages: true, projectEnv: "read-write" },
        );
        try {
          first.send({
            type: "terminal",
            data: "if ! command -v hello && workspace-install hello; then printf '\\nHELLO_''INSTALLED\\n'; fi\r",
          });
          await vi.waitFor(
            () => expect(output).toMatch(/^HELLO_INSTALLED\r?$/m),
            { timeout: 90_000 },
          );
          await vi.waitFor(async () =>
            expect((await projectPackagePresets(project)).has("hello")).toBe(
              true,
            ),
          );
        } finally {
          await first.stop();
        }

        const missing = "workspace-nonexistent-fixture-name";
        const disabled = "workspace-disabled-fixture-name";
        expect((await add(missing)).statusCode).toBe(200);
        expect((await add(disabled)).statusCode).toBe(200);
        await db.query(
          "UPDATE project_packages SET added_at=now()-interval '1 day',failures=2 WHERE project_id=$1 AND name=$2",
          [project, missing],
        );
        await db.query(
          "UPDATE project_packages SET failures=1 WHERE project_id=$1 AND name='hello'",
          [project],
        );
        await db.query(
          "UPDATE project_packages SET failures=3,disabled=true WHERE project_id=$1 AND name=$2",
          [project, disabled],
        );
        await db.query("UPDATE projects SET auto_packages=false WHERE id=$1", [
          project,
        ]);
        // Revalidate even rows that predate or bypass the current owner API.
        await db.query(
          "INSERT INTO project_packages(project_id,name,source,request_id) VALUES($1,'hello --bad','owner',$2)",
          [project, randomUUID()],
        );
        const secondChat = randomUUID();
        await db.query(
          "INSERT INTO chats(id,project_id,workspace_id,title,provider,account_id,branch) VALUES($1,$2,$3,'Next chat','codex',$4,'workspace/test')",
          [secondChat, project, chat, account],
        );
        output = "";
        const events: import("../src/shared").AgentEvent[] = [];
        const second = await launch(
          secondChat,
          account,
          (e) => {
            if (e.type === "terminal") output += e.data;
            else events.push(e);
          },
          { installPackages: true, projectEnv: "read-write" },
        );
        try {
          second.send({
            type: "terminal",
            data: "hello && test -z \"$WORKSPACE_PROJECT_PACKAGES$WORKSPACE_PROJECT_PACKAGE_RESULT\" && printf '\\nPRESET_''AVAILABLE\\n'\r",
          });
          const { Config } = await docker.getContainer(second.id).inspect();
          expect(Config.Env).toContain(
            `WORKSPACE_PROJECT_PACKAGES=${JSON.stringify([missing, "hello"])}`,
          );
          await vi.waitFor(
            () => expect(output).toMatch(/^PRESET_AVAILABLE\r?$/m),
            { timeout: 105_000 },
          );
          expect(
            events.some(({ type }) => type === "project_packages_ready"),
          ).toBe(false);
          expect(events).toContainEqual({
            type: "warning",
            projectPackageStartup: true,
            message: expect.stringContaining(missing),
          });
          expect(events.some(({ type }) => type === "packages_installed")).toBe(
            false,
          );
          expect((await list()).packages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                name: "hello",
                failures: 0,
                disabled: false,
                source_chat_id: chat,
              }),
              expect.objectContaining({
                name: missing,
                failures: 3,
                disabled: true,
              }),
              expect.objectContaining({
                name: disabled,
                failures: 3,
                disabled: true,
              }),
            ]),
          );
        } finally {
          await second.stop();
        }
      },
      210_000,
    );

    it("groups requests, upserts successes, and keeps packages when the source chat is deleted", async () => {
      expect(await list()).toEqual({ auto_packages: true, packages: [] });
      expect((await add("git")).statusCode).toBe(200);
      const [manual] = (await list()).packages;

      const firstEvents = await emitInstallRequests(["jq", "jq", "ffmpeg"]);
      const installedRequest = firstEvents.find(
        ({ type }) => type === "packages_installed",
      )?.data;
      expect(installedRequest).toEqual({
        packages: ["jq", "ffmpeg"],
        request_id: expect.any(String),
      });
      const first = (await list()).packages;
      const jq = first.find(({ name }) => name === "jq");
      expect(jq).toMatchObject({
        source: "agent",
        source_chat_id: chat,
        source_chat_title: "Test",
        request_id: installedRequest.request_id,
        added_at: expect.any(String),
      });
      expect(first.find(({ name }) => name === "ffmpeg")).toMatchObject({
        request_id: installedRequest.request_id,
        added_at: jq?.added_at,
      });

      await db.query(
        "UPDATE project_packages SET failures=3,disabled=true WHERE project_id=$1 AND name IN ('jq','git')",
        [project],
      );
      await emitInstallRequests(["jq", "git", "unzip"]);
      const second = (await list()).packages;
      expect(second).toHaveLength(4);
      expect(second.find(({ name }) => name === "jq")).toEqual(jq);
      expect(second.find(({ name }) => name === "git")).toEqual(manual);
      expect(second.find(({ name }) => name === "unzip")?.request_id).not.toBe(
        installedRequest.request_id,
      );

      const otherProject = randomUUID();
      await db.query(
        "INSERT INTO projects(id,name,repo) VALUES($1,'Other','')",
        [otherProject],
      );
      const otherUrl = `/api/projects/${otherProject}/packages`;
      expect((await request({ url: otherUrl, headers })).json()).toEqual({
        auto_packages: true,
        packages: [],
      });
      expect(
        (
          await request({
            method: "DELETE",
            url: `${otherUrl}/requests/${installedRequest.request_id}`,
            headers,
          })
        ).statusCode,
      ).toBe(200);
      expect((await list()).packages).toHaveLength(4);
      expect(
        (
          await request({
            method: "DELETE",
            url: `/api/chats/${chat}`,
            headers,
          })
        ).statusCode,
      ).toBe(200);
      expect((await list()).packages.find(({ name }) => name === "jq")).toEqual(
        {
          ...jq,
          source_chat_id: null,
          source_chat_title: null,
        },
      );
      expect(
        (
          await request({
            method: "DELETE",
            url: `${url}/requests/${installedRequest.request_id}`,
            headers,
          })
        ).statusCode,
      ).toBe(200);
      expect((await list()).packages.map(({ name }) => name).sort()).toEqual([
        "git",
        "unzip",
      ]);
      expect(
        (await request({ method: "DELETE", url: `${url}/git`, headers }))
          .statusCode,
      ).toBe(200);
      expect((await list()).packages.map(({ name }) => name)).toEqual([
        "unzip",
      ]);
    });

    it("requires the owner, validates input and keeps manual adds available with remembering off", async () => {
      expect((await request({ url })).statusCode).toBe(401);
      expect(
        (
          await request({
            method: "POST",
            url,
            headers: { origin },
            payload: { name: "jq" },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await request({
            method: "PATCH",
            url,
            headers: { cookie: headers.cookie },
            payload: { auto_packages: false },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await request({
            url: `/api/projects/${randomUUID()}/packages`,
            headers,
          })
        ).statusCode,
      ).toBe(404);
      expect((await add("jq=1.0")).statusCode).toBe(400);
      expect(
        (
          await request({
            method: "PATCH",
            url,
            headers,
            payload: { auto_packages: "false" },
          })
        ).statusCode,
      ).toBe(400);
      const toggle = (auto_packages: boolean) =>
        request({
          method: "PATCH",
          url,
          headers,
          payload: { auto_packages },
        });
      expect((await toggle(false)).json()).toEqual({ auto_packages: false });
      expect((await add("libstdc++6")).statusCode).toBe(200);
      expect(await emitInstallRequests(["ffmpeg"])).toContainEqual({
        type: "log",
        data: {
          text: "Debian packages not remembered because automatic remembering is off: ffmpeg",
        },
      });
      expect(await list()).toMatchObject({
        auto_packages: false,
        packages: [
          { name: "libstdc++6", source: "owner", source_chat_id: null },
        ],
      });
      expect(
        (
          await request({
            method: "DELETE",
            url: `${url}/${encodeURIComponent("libstdc++6")}`,
            headers,
          })
        ).statusCode,
      ).toBe(200);
      expect((await toggle(true)).json()).toEqual({ auto_packages: true });
      await emitInstallRequests(["ffmpeg"]);
      expect((await list()).packages).toMatchObject([
        { name: "ffmpeg", source: "agent", source_chat_id: chat },
      ]);
    });

    it("fills the remaining slots, explains skipped names and serializes concurrent additions", async () => {
      await db.query(
        `INSERT INTO project_packages(project_id,name,source,request_id)
         SELECT $1,'fixture-' || i,'owner',$2 FROM generate_series(1,254) AS fixture(i)`,
        [project, randomUUID()],
      );
      expect(
        await emitInstallRequests(["fixture-1", "jq", "ffmpeg", "unzip"]),
      ).toContainEqual({
        type: "log",
        data: {
          text: "Debian packages not remembered because the project limit of 256 packages was reached: unzip",
        },
      });
      const { packages } = await list();
      expect(packages).toHaveLength(256);
      expect(packages.filter(({ source }) => source === "agent")).toMatchObject(
        [{ name: "ffmpeg" }, { name: "jq" }],
      );
      expect((await add("jq")).statusCode).toBe(200);
      expect((await add("unzip")).statusCode).toBe(409);
      expect(
        (await request({ method: "DELETE", url: `${url}/jq`, headers }))
          .statusCode,
      ).toBe(200);
      const replies = await Promise.all([add("git"), add("unzip")]);
      expect(replies.map(({ statusCode }) => statusCode).sort()).toEqual([
        200, 409,
      ]);
      expect((await list()).packages).toHaveLength(256);
    });
  });

  it("scopes enabled integrations to the project and provider and protects tokens", async () => {
    const project = (
      await db.query("SELECT project_id FROM chats WHERE id=$1", [chat])
    ).rows[0].project_id;
    const url = "/api/projects/" + project + "/integrations";
    const payload = {
      kind: "mcp",
      provider: "codex",
      name: "docs",
      target: "https://example.test/mcp",
      token: "test-secret",
    };
    expect(
      (await app.inject({ method: "POST", url, headers, payload })).statusCode,
    ).toBe(200);
    const list = await app.inject({ url, headers });
    expect(list.body).not.toContain("test-secret");
    expect(
      (
        await db.query(
          "SELECT secret FROM project_integrations WHERE project_id=$1",
          [project],
        )
      ).rows[0].secret,
    ).not.toBe("test-secret");
    expect(await runIntegrations(project, "codex")).toMatchObject([
      { token: "test-secret" },
    ]);
    expect(await runIntegrations(project, "claude")).toEqual([]);
    expect(await runIntegrations(randomUUID(), "codex")).toEqual([]);
    const entry = url + "/" + list.json()[0].id;
    await app.inject({
      method: "PATCH",
      url: entry,
      headers,
      payload: { enabled: false },
    });
    expect(await runIntegrations(project, "codex")).toEqual([]);
    await app.inject({ method: "DELETE", url: entry, headers });
    expect((await app.inject({ url, headers })).json()).toEqual([]);
  });

  it("authorizes GitHub sync and holds the folder lease until it finishes", async () => {
    const url = `/api/workspaces/${chat}/sync`;
    const lease = () =>
      db.query("SELECT kind FROM workspace_leases WHERE workspace_id=$1", [
        chat,
      ]);
    const result = {
      status: "updated" as const,
      sourceBranch: "main",
      commit: "a".repeat(40),
    };
    const operation = vi
      .spyOn(githubSync, "syncFromGithub")
      .mockImplementation(async (id) => {
        expect(id).toBe(chat);
        expect((await lease()).rows).toEqual([{ kind: "GitHub sync" }]);
        return result;
      });
    try {
      expect((await app.inject({ method: "POST", url })).statusCode).toBe(403);
      expect(
        (await app.inject({ method: "POST", url, headers: { origin } }))
          .statusCode,
      ).toBe(401);
      await acquireFolder(chat, "test terminal");
      try {
        expect(
          (await app.inject({ method: "POST", url, headers })).statusCode,
        ).toBe(409);
        expect(operation).not.toHaveBeenCalled();
      } finally {
        await releaseFolder(chat);
      }
      const response = await app.inject({ method: "POST", url, headers });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(result);
      expect((await lease()).rows).toEqual([]);
      operation.mockRejectedValueOnce(
        Object.assign(new Error("Local changes"), { statusCode: 409 }),
      );
      const rejected = await app.inject({ method: "POST", url, headers });
      expect(rejected.statusCode).toBe(409);
      expect(rejected.json()).toEqual({ error: "Local changes" });
      expect((await lease()).rows).toEqual([]);
    } finally {
      operation.mockRestore();
    }
  });

  it("previews, scopes and round-trips imported skill files", async () => {
    const project = (
      await db.query("SELECT project_id FROM chats WHERE id=$1", [chat])
    ).rows[0].project_id;
    const previewPath = "/api/skills/preview?project=" + project;
    const importPath = "/api/skills/import?project=" + project;
    const files = [
      [
        "local-skills/deploy/SKILL.md",
        "---\nname: deploy\ndescription: Prepare a release\n---\nUse the script.",
      ],
      ["local-skills/deploy/scripts/підготовка.sh", "#!/bin/sh\nexit 0\n"],
      ["local-skills/deploy/.env", "PRIVATE_VALUE=fixture"],
    ];
    const boundary = "workspace-test-skill";
    const body = (parts: string[][], zipped = false) =>
      Buffer.from(
        parts
          .map(
            ([name, value]) =>
              `--${boundary}\r\nContent-Disposition: form-data; name="${zipped ? "archive" : "path:" + encodeURIComponent(name)}"; filename="file"\r\nContent-Type: application/octet-stream\r\n\r\n${value}\r\n`,
          )
          .join("") + `--${boundary}--\r\n`,
      );
    const preview = () =>
      app.inject({
        method: "POST",
        url: previewPath,
        headers: {
          ...headers,
          "content-type": "multipart/form-data; boundary=" + boundary,
        },
        payload: body(files),
      });
    const first = await preview();
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({
      excluded: 1,
      skills: [{ name: "deploy", fileCount: 2, conflict: false }],
    });
    const save = (id: string, conflicts = {}) =>
      app.inject({
        method: "POST",
        url: importPath,
        headers,
        payload: { id, conflicts },
      });
    expect((await save(first.json().id)).json()).toMatchObject({ saved: 1 });
    const another = await preview();
    expect(another.json().skills[0].conflict).toBe(true);
    expect(
      (await save(another.json().id, { deploy: "copy" }))
        .json()
        .skills.map((skill: any) => skill.name),
    ).toEqual(["deploy", "deploy-2"]);

    const context = await app.inject({
      method: "GET",
      headers,
      url: `/api/chats/${chat}/context`,
    });
    expect(context.json().entries).toContainEqual(
      expect.objectContaining({ path: "/skills/project/deploy/SKILL.md" }),
    );
    expect(await prepareSkills(null)).toBeNull();
    const snapshot = await prepareSkills(project);
    try {
      expect(snapshot?.mount.ReadOnly).toBe(true);
      const script = path.join(
        snapshot!.mount.Source,
        "project/deploy/scripts/підготовка.sh",
      );
      expect(await readFile(script, "utf8")).toBe(files[1][1]);
      await expect(
        access(path.join(snapshot!.mount.Source, "project/deploy/.env")),
      ).rejects.toThrow();
    } finally {
      await snapshot?.stop();
    }

    const archive = await app.inject({
      method: "GET",
      headers,
      url: `/api/skills/export?project=${project}&names=deploy`,
    });
    expect(archive.statusCode, archive.body).toBe(200);
    const roundTrip = await app.inject({
      method: "POST",
      url: "/api/skills/preview",
      headers: {
        ...headers,
        "content-type": "multipart/form-data; boundary=" + boundary,
      },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="skills.zip"\r\nContent-Type: application/zip\r\n\r\n`,
        ),
        archive.rawPayload,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    expect(roundTrip.json()).toMatchObject({
      excluded: 0,
      skills: [{ name: "deploy", fileCount: 2, conflict: false }],
    });
    const skipped = await preview();
    expect(
      (await save(skipped.json().id, { deploy: "skip" })).json().saved,
    ).toBe(0);
    const stale = await preview();
    files[0][1] =
      "---\ndescription: >\n  Updated deployment\n  instructions.\n---\n# Deploy";
    const replacement = await preview();
    expect(
      (await save(replacement.json().id, { deploy: "replace" })).json().saved,
    ).toBe(1);
    expect(
      (await save(stale.json().id, { deploy: "replace" })).statusCode,
    ).toBe(409);
    const library = (
      await app.inject({ url: `/api/skills?project=${project}`, headers })
    ).json();
    expect(library).toHaveLength(2);
    expect(library.find((s: any) => s.name === "deploy").description).toBe(
      "Updated deployment instructions.",
    );
  });

  it.each(["skills", "files", "bytes"])(
    "rolls back a skill import exceeding the library %s limit",
    async (limit) => {
      const project = (
        await db.query("SELECT project_id FROM chats WHERE id=$1", [chat])
      ).rows[0].project_id;
      const count = limit === "skills" ? 50 : 1;
      const storedFiles = Array.from(
        { length: limit === "files" ? 500 : 1 },
        (_, i) => ({ path: i ? `file-${i}` : "SKILL.md", data: "eA==" }),
      );
      for (let i = 0; i < count; i++)
        await db.query(
          "INSERT INTO imported_skills(project_id,name,revision,description,hints,bytes,files) VALUES($1,$2,$3,'','{}',$4,$5)",
          [
            project,
            `seed-${i}`,
            randomUUID(),
            limit === "bytes" ? 20 * 1024 * 1024 : storedFiles.length,
            JSON.stringify(storedFiles),
          ],
        );
      const boundary = "skill-limit-test";
      const preview = await app.inject({
        method: "POST",
        url: `/api/skills/preview?project=${project}`,
        headers: {
          ...headers,
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload: `--${boundary}\r\nContent-Disposition: form-data; name="path:new/SKILL.md"; filename="SKILL.md"\r\nContent-Type: text/plain\r\n\r\n# New\r\n--${boundary}--\r\n`,
      });
      expect(preview.statusCode, preview.body).toBe(200);
      const imported = await app.inject({
        method: "POST",
        url: `/api/skills/import?project=${project}`,
        headers,
        payload: { id: preview.json().id, conflicts: {} },
      });
      expect(imported.statusCode, imported.body).toBe(409);
      expect(
        (
          await db.query(
            "SELECT name FROM imported_skills WHERE project_id=$1",
            [project],
          )
        ).rows,
      ).toHaveLength(count);
      expect(
        (
          await db.query(
            "SELECT 1 FROM imported_skills WHERE project_id=$1 AND name='new'",
            [project],
          )
        ).rowCount,
      ).toBe(0);
    },
  );

  it("keeps the AWS SSO cache encrypted and gives only the connected project temporary role credentials", async () => {
    const project = (
      await db.query("SELECT project_id FROM chats WHERE id=$1", [chat])
    ).rows[0].project_id;
    const fake = await mkdtemp(path.join(data, "aws-fixture-"));
    await writeFile(
      path.join(fake, "aws"),
      `#!/bin/sh
case " $* " in
  *" sso login "*)
    printf 'https://device.sso.us-east-1.amazonaws.com/\\n\\nThen enter the code:\\n\\nABCD-EF12\\n'
    while [ ! -f "${fake}/authorized" ]; do sleep 0.1; done
    printf '{"accessToken":"test-sso-token"}' > "$HOME/.aws/sso/cache/0123456789012345678901234567890123456789.json"
    ;;
  *" configure export-credentials "*)
    test -f "$HOME/.aws/sso/cache/0123456789012345678901234567890123456789.json" || exit 1
    printf '{"AccessKeyId":"TESTACCESS","SecretAccessKey":"TESTSECRET","SessionToken":"TESTROLE","Expiration":"2099-01-01T00:00:00Z"}'
    ;;
  *" sts get-caller-identity "*)
    test "$AWS_SESSION_TOKEN" = "TESTROLE" || exit 1
    printf '{"Account":"123456789012","Arn":"arn:aws:sts::123456789012:assumed-role/ReadOnlyAccess/test"}'
    ;;
esac
`,
      { mode: 0o700 },
    );
    const awsPath = "/api/projects/" + project + "/aws";
    const before = process.env.PATH;
    process.env.PATH = fake + ":" + before;
    try {
      const config = await app.inject({
        method: "PUT",
        url: awsPath,
        headers,
        payload: {
          startUrl: "https://test.awsapps.com/start",
          ssoRegion: "us-east-1",
          region: "us-east-1",
          accountId: "123456789012",
          role: "ReadOnlyAccess",
        },
      });
      expect(config.statusCode, config.body).toBe(200);
      expect(await prepareAws(project)).toBeNull();
      expect(
        (
          await app.inject({
            method: "POST",
            url: awsPath + "/connect",
            headers,
          })
        ).json().pending,
      ).toBe(true);
      const status = () => app.inject({ method: "GET", url: awsPath, headers });
      await vi.waitFor(async () =>
        expect((await status()).json().challenge?.code).toBe("ABCD-EF12"),
      );
      await writeFile(path.join(fake, "authorized"), "");
      await vi.waitFor(async () =>
        expect((await status()).json().identity).toContain("ReadOnlyAccess"),
      );
      const stored = (
        await db.query(
          "SELECT session FROM aws_connections WHERE project_id=$1",
          [project],
        )
      ).rows[0].session;
      expect(stored).not.toContain("test-sso-token");
      expect(unseal(stored)).toContain("test-sso-token");
      // Changing availability policy must preserve the authenticated role session.
      const connectionSettings = (await status()).json().settings;
      for (const required of [true, false]) {
        const updated = await app.inject({
          method: "PUT",
          url: awsPath,
          headers,
          payload: { ...connectionSettings, required },
        });
        expect(updated.statusCode, updated.body).toBe(200);
        expect(updated.json().identity).toContain("ReadOnlyAccess");
        expect(
          (
            await db.query(
              "SELECT session FROM aws_connections WHERE project_id=$1",
              [project],
            )
          ).rows[0].session,
        ).toBe(stored);
      }
      expect(await prepareAws(randomUUID())).toBeNull();
      const aws = await prepareAws(project);
      try {
        expect(aws?.env.AWS_REGION).toBe("us-east-1");
        expect(aws?.mount.ReadOnly).toBe(true);
        expect(
          await readFile(path.join(aws!.mount.Source, "credentials"), "utf8"),
        ).toContain("aws_session_token = TESTROLE");
        expect(JSON.stringify(aws?.env)).not.toContain("TESTROLE");
      } finally {
        await aws?.stop();
      }
      if (process.env.DOCKER_TESTS === "1") {
        let output = "";
        const terminal = await launch(chat, null, (event) => {
          if (event.type === "terminal") output += event.data;
        });
        try {
          terminal.send({ type: "terminal", data: "aws configure list\r" });
          await vi.waitFor(
            () => {
              expect(output).toContain("shared-credentials-file");
              expect(output).toContain("us-east-1");
            },
            { timeout: 5_000 },
          );
          expect(output).not.toContain("TESTROLE");
        } finally {
          await terminal.stop();
        }
      }
      expect(
        (await app.inject({ method: "DELETE", url: awsPath, headers })).json()
          .identity,
      ).toBeNull();
      expect(await prepareAws(project)).toBeNull();
    } finally {
      await app.inject({
        method: "DELETE",
        url: awsPath + "/connect",
        headers,
      });
      process.env.PATH = before;
    }
  }, 20_000);

  it("keeps local preview independent from publication review and permits Push without a message", async () => {
    const local = vi
      .spyOn(gitModule, "localChanges")
      .mockResolvedValue({ diff: "local preview", untracked: ["new.txt"] });
    const review = vi.spyOn(gitModule, "reviewPublication").mockResolvedValue({
      diff: "frozen",
      pushDiff: "outgoing",
      commits: "commit",
      pushError: "",
      review_token: "reviewed",
    });
    try {
      await acquireWorkspace(chat, "terminal");
      const preview = await app.inject({
        url: `/api/chats/${chat}/diff`,
        headers,
      });
      expect(preview.statusCode, preview.body).toBe(200);
      expect(preview.json()).toEqual({
        diff: "local preview",
        untracked: ["new.txt"],
      });
      expect(local).toHaveBeenCalledTimes(1);
      expect(review).not.toHaveBeenCalled();
      const blocked = await app.inject({
        method: "POST",
        url: `/api/chats/${chat}/publication-review`,
        headers,
        payload: { target: "commit" },
      });
      expect(blocked.statusCode).toBe(409);
      await releaseWorkspace(chat);
      for (const target of ["commit", "push"]) {
        const prepared = await app.inject({
          method: "POST",
          url: `/api/chats/${chat}/publication-review`,
          headers,
          payload: { target },
        });
        expect(prepared.statusCode, prepared.body).toBe(200);
        expect(review).toHaveBeenLastCalledWith(
          expect.objectContaining({ id: chat }),
          expect.anything(),
          target === "push",
        );
      }
      vi.spyOn(gitModule, "validatePublication").mockResolvedValue({
        workspace: chat,
        head: "head",
        tree: "tree",
        repo: "test/repo",
        branch: "workspace/test",
        baseBranch: "main",
        remote: "remote",
      });
      const push = vi
        .spyOn(gitModule, "pushBranch")
        .mockResolvedValue("pushed");
      const post = (action: string, message?: string) =>
        app.inject({
          method: "POST",
          url: `/api/chats/${chat}/git`,
          headers,
          payload: {
            action,
            message,
            review_token: "reviewed",
            client_id: randomUUID(),
          },
        });
      expect((await post("push")).statusCode).toBe(200);
      expect(push).toHaveBeenCalledTimes(1);
      expect((await post("commit", " ")).statusCode).toBe(400);
      expect((await post("pr", " ")).statusCode).toBe(400);
    } finally {
      await releaseWorkspace(chat);
      vi.restoreAllMocks();
    }
  });

  it.skipIf(process.env.DOCKER_TESTS !== "1")(
    "previews a busy repository read-only and requires a fresh frozen review for commit",
    async () => {
      const folder = workspacePath(chat);
      await mkdir(folder, { recursive: true });
      // Match agent writes inside Docker; host-side writes can leave stale stat
      // metadata in Docker Desktop's file sharing cache during rapid tests.
      const write = async (name: string, text: string) => {
        const writer = await docker.createContainer({
          Image: config.image,
          User: "1000:1000",
          Cmd: [
            "node",
            "-e",
            "require('node:fs').writeFileSync('/workspace/' + process.argv[1], process.argv[2])",
            name,
            text,
          ],
          HostConfig: {
            NetworkMode: "none",
            ReadonlyRootfs: true,
            Mounts: [{ Type: "bind", Source: folder, Target: "/workspace" }],
          },
        });
        try {
          await writer.start();
          expect((await writer.wait()).StatusCode).toBe(0);
        } finally {
          await writer.remove({ force: true });
        }
      };
      const git = (args: string[]) => gitModule.git(folder, args);
      await git(["init"]);
      await write("tracked.txt", "base\n");
      await git(["add", "."]);
      await git(["commit", "-m", "base"]);
      expect(await git(["show", "HEAD:tracked.txt"])).toBe("base\n");
      await write("tracked.txt", "local edit\n");
      await write("new.txt", "new file\n");
      expect(await git(["diff", "HEAD"])).toContain("+local edit");
      const index = await readFile(path.join(folder, ".git/index"));
      await acquireWorkspace(chat, "terminal");
      try {
        const response = await app.inject({
          url: `/api/chats/${chat}/diff`,
          headers,
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json().diff).toContain("+local edit");
        expect(response.json().untracked).toContain("new.txt");
        expect(response.json().review_token).toBeUndefined();
        expect(await readFile(path.join(folder, ".git/index"))).toEqual(index);
      } finally {
        await releaseWorkspace(chat);
      }
      const containers = vi.spyOn(docker, "createContainer");
      try {
        const prepare = () =>
          app.inject({
            method: "POST",
            url: `/api/chats/${chat}/publication-review`,
            headers,
            payload: { target: "commit" },
          });
        const prepared = await prepare();
        expect(prepared.statusCode, prepared.body).toBe(200);
        expect(prepared.json().diff).toContain("+new file");
        expect(
          containers.mock.calls.some(
            ([options]) => options?.HostConfig?.NetworkMode === "bridge",
          ),
        ).toBe(false);
        const commit = (token: string) =>
          app.inject({
            method: "POST",
            url: `/api/chats/${chat}/git`,
            headers,
            payload: {
              action: "commit",
              message: "Reviewed changes",
              review_token: token,
              client_id: randomUUID(),
            },
          });
        await write("new.txt", "changed after review\n");
        expect((await commit(prepared.json().review_token)).statusCode).toBe(
          409,
        );
        const refreshed = await prepare();
        expect(refreshed.statusCode, refreshed.body).toBe(200);
        const committed = await commit(refreshed.json().review_token);
        expect(committed.statusCode, committed.body).toBe(200);
        expect(await git(["show", "HEAD:new.txt"])).toBe(
          "changed after review\n",
        );
      } finally {
        containers.mockRestore();
      }
    },
    120_000,
  );

  it("persists the missing-AWS warning and tells the agent while allowing local work", async () => {
    const mid = randomUUID(),
      id = randomUUID();
    await db.query(
      "INSERT INTO messages(id,chat_id,role,content) VALUES($1,$2,'user','Review the local files')",
      [mid, chat],
    );
    const job = (
      await db.query(
        "INSERT INTO jobs(id,chat_id,message_id,account_id,state) VALUES($1,$2,$3,$4,'running') RETURNING *",
        [id, chat, mid, account],
      )
    ).rows[0];
    const warning = "This run started without AWS access.";
    const send = vi.fn();
    let emit!: (event: any) => void | Promise<void>;
    vi.spyOn(gitModule, "initializeWorkspace").mockResolvedValue();
    vi.spyOn(runtimeModule, "launch").mockImplementation(
      async (_chat, _account, handler) => {
        emit = handler;
        return {
          id: "warning-test",
          aws: false,
          awsWarning: warning,
          send,
          stop: async () => {},
        };
      },
    );
    try {
      await runJob(job);
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "start",
          input: expect.objectContaining({
            prompt: expect.stringContaining(warning),
          }),
        }),
      );
      expect(send.mock.calls[0][0].input.prompt).not.toContain(
        "This project has a temporary AWS role",
      );
      const detail = await app.inject({ url: `/api/chats/${chat}`, headers });
      expect(detail.json().events).toContainEqual(
        expect.objectContaining({
          type: "warning",
          data: { message: warning },
        }),
      );
      await emit({ type: "completed", result: "Local review completed" });
      expect(
        (await db.query("SELECT state FROM jobs WHERE id=$1", [id])).rows[0]
          .state,
      ).toBe("completed");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("stores SSH secrets encrypted, controls inheritance and blocks access changes while busy", async () => {
    const pub =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB";
    const mock = vi
      .spyOn(sshRuntime, "sshOperation")
      .mockImplementation(async (input: any) => {
        if (input.operation === "scan") return [pub];
        if (input.operation === "test")
          return { ok: true, message: "Connected successfully." };
        return {
          private_key: "PRIVATE_TEST_SECRET",
          public_key: pub,
          fingerprint: "SHA256:test",
        };
      });
    try {
      const call = (method: any, url: string, payload?: any) =>
        app.inject({
          method,
          url: "/api" + url,
          headers,
          ...(payload !== undefined ? { payload } : {}),
        });
      const project = (
        await db.query("SELECT project_id FROM chats WHERE id=$1", [chat])
      ).rows[0].project_id;
      const keyResponse = await call("POST", "/ssh-keys", {
        name: "Deploy",
        operation: "import",
        private_key: "PRIVATE_TEST_SECRET",
        passphrase: "secret",
      });
      expect(keyResponse.statusCode).toBe(200);
      const key = keyResponse.json();
      expect(keyResponse.body).not.toContain("PRIVATE_TEST_SECRET");
      const stored = (
        await db.query("SELECT private_key FROM ssh_keys WHERE id=$1", [key.id])
      ).rows[0].private_key;
      expect(stored).not.toContain("PRIVATE_TEST_SECRET");
      expect(unseal(stored)).toBe("PRIVATE_TEST_SECRET");
      const fields = {
        name: "VPS",
        alias: "production",
        host: "example.test",
        port: 2222,
        username: "deploy",
        key_id: key.id,
      };
      const response = await call("POST", "/servers", fields);
      expect(response.statusCode).toBe(200);
      const server = response.json();
      expect(
        (await call("POST", `/servers/${server.id}/test`, {})).statusCode,
      ).toBe(409);
      const scan = (
        await call("POST", `/servers/${server.id}/scan`, {})
      ).json();
      expect(
        (
          await call("POST", `/servers/${server.id}/trust`, {
            token: randomUUID(),
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await call("POST", `/servers/${server.id}/trust`, {
            token: scan.token,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (await call("POST", `/servers/${server.id}/test`, {})).json().ok,
      ).toBe(true);
      expect(
        (
          await call("PUT", `/projects/${project}/servers`, {
            server_ids: [server.id],
          })
        ).statusCode,
      ).toBe(200);
      expect((await call("GET", `/chats/${chat}/servers`)).json()).toEqual({
        inherited: true,
        server_ids: [server.id],
      });
      expect(
        (await call("PUT", `/chats/${chat}/servers`, { server_ids: [] }))
          .statusCode,
      ).toBe(409);
      expect((await sshRuntime.chatServers(chat)).map((s) => s.id)).toEqual([
        server.id,
      ]);
      expect((await call("DELETE", `/ssh-keys/${key.id}`)).statusCode).toBe(
        409,
      );
      await acquireWorkspace(chat, "terminal");
      expect((await call("DELETE", `/servers/${server.id}`)).statusCode).toBe(
        409,
      );
      expect(
        (await call("PATCH", `/servers/${server.id}`, fields)).statusCode,
      ).toBe(409);
      expect(
        (await call("PUT", `/projects/${project}/servers`, { server_ids: [] }))
          .statusCode,
      ).toBe(409);
      await releaseWorkspace(chat);
      const personal = randomUUID();
      await createWorkspace(null, "personal", "Personal", db, personal);
      await db.query(
        "INSERT INTO chats(id,workspace_id,title,provider,branch) VALUES($1,$1,'Personal','codex','main')",
        [personal],
      );
      await acquireWorkspace(chat, "terminal");
      // Assignments in an unrelated idle scope may change even when this server
      // is being used elsewhere; the shared server definition stays protected.
      expect(
        (
          await call("PUT", `/chats/${personal}/servers`, {
            server_ids: [server.id],
          })
        ).statusCode,
      ).toBe(200);
      expect((await call("GET", `/chats/${personal}/servers`)).json()).toEqual({
        inherited: false,
        server_ids: [server.id],
      });
      await releaseWorkspace(chat);
      const messageId = randomUUID(),
        jobId = randomUUID();
      await db.query(
        "INSERT INTO messages(id,chat_id,role,content) VALUES($1,$2,'user','test')",
        [messageId, chat],
      );
      await db.query(
        "INSERT INTO jobs(id,chat_id,message_id,state) VALUES($1,$2,$3,'queued')",
        [jobId, chat, messageId],
      );
      for (const state of [
        "queued",
        "running",
        "waiting_approval",
        "waiting_account",
      ]) {
        await db.query("UPDATE jobs SET state=$2 WHERE id=$1", [jobId, state]);
        expect(
          (
            await call("PUT", `/projects/${project}/servers`, {
              server_ids: [],
            })
          ).statusCode,
        ).toBe(409);
        expect((await call("DELETE", `/servers/${server.id}`)).statusCode).toBe(
          409,
        );
      }
      await db.query("DELETE FROM jobs WHERE id=$1", [jobId]);
      let finishScan!: (keys: string[]) => void;
      mock.mockImplementationOnce(
        async () =>
          new Promise<string[]>((r) => {
            finishScan = r;
          }),
      );
      const scanning = call("POST", `/servers/${server.id}/scan`, {});
      // inject begins processing when awaited/then'ed.
      const inFlight = scanning.then((r) => r);
      await vi.waitFor(() => expect(finishScan).toBeTypeOf("function"));
      try {
        expect((await call("DELETE", `/servers/${server.id}`)).statusCode).toBe(
          409,
        );
      } finally {
        finishScan([pub]);
        await inFlight;
      }
      expect(
        (
          await call("PATCH", `/servers/${server.id}`, {
            ...fields,
            host: "new.example.test",
          })
        ).statusCode,
      ).toBe(200);
      expect((await call("GET", "/servers")).json()[0].host_keys).toEqual([]);
      expect((await call("DELETE", `/servers/${server.id}`)).statusCode).toBe(
        200,
      );
      expect(
        (await call("GET", `/chats/${chat}/servers`)).json().server_ids,
      ).toEqual([]);
      expect((await call("DELETE", `/ssh-keys/${key.id}`)).statusCode).toBe(
        200,
      );
      expect((await call("GET", "/ssh-keys")).json()).toEqual([]);
    } finally {
      mock.mockRestore();
    }
  });

  it.skipIf(process.env.SSH_DOCKER_TESTS !== "1")(
    "provides SSH only to assigned runtime and terminal sessions, and removes brokers on stop",
    async () => {
      const key = await sshRuntime.sshOperation({ operation: "generate" });
      const keyId = randomUUID(),
        serverId = randomUUID();
      const project = (
        await db.query("SELECT project_id FROM chats WHERE id=$1", [chat])
      ).rows[0].project_id;
      await db.query(
        "INSERT INTO ssh_keys(id,name,private_key,public_key,fingerprint) VALUES($1,'Test',$2,$3,$4)",
        [keyId, seal(key.private_key), key.public_key, key.fingerprint],
      );
      await db.query(
        "INSERT INTO ssh_servers(id,name,alias,host,port,username,key_id,host_keys) VALUES($1,'Test','assigned','127.0.0.1',2222,'tester',$2,$3)",
        [serverId, keyId, JSON.stringify([key.public_key])],
      );
      await db.query(
        "INSERT INTO ssh_links(id,project_id,server_id) VALUES($1,$2,$3)",
        [randomUUID(), project, serverId],
      );
      const runCheck = async (r: Running, expected: boolean) => {
        const c = docker.getContainer(r.id);
        const check = await c.exec({
          Cmd: [
            "sh",
            "-c",
            expected
              ? "test -S /run/workspace-ssh/agent.sock && test ! -e /private/key && test ! -e /profile/.ssh/id_ed25519"
              : "test ! -e /run/workspace-ssh/agent.sock",
          ],
          AttachStdout: true,
          AttachStderr: true,
        });
        const stream = await check.start({ hijack: true, stdin: false });
        for await (const _ of stream) {
          /* discard test command output */
        }
        expect((await check.inspect()).ExitCode).toBe(0);
      };
      let run: Running | undefined;
      try {
        const create = vi
          .spyOn(docker, "createContainer")
          .mockRejectedValueOnce(
            new Error("simulated runner creation failure"),
          );
        try {
          await expect(launch(chat, account, () => {})).rejects.toThrow(
            "simulated runner creation failure",
          );
        } finally {
          create.mockRestore();
        }
        expect(
          (
            await docker.listVolumes({
              filters: JSON.stringify({
                label: [
                  "ai.workspace.ssh=true",
                  "ai.workspace.instance=" + config.data,
                ],
              }),
            })
          ).Volumes,
        ).toHaveLength(0);
        run = await launch(chat, account, () => {});
        await runCheck(run, true);
        await run.stop();
        run = undefined;
        run = await launch(chat, null, () => {});
        await runCheck(run, true);
        await run.stop();
        run = undefined;
        const personal = randomUUID();
        await createWorkspace(null, "personal", "Personal", db, personal);
        await db.query(
          "INSERT INTO chats(id,workspace_id,title,provider,account_id,branch) VALUES($1,$1,'Personal','codex',$2,'main')",
          [personal, account],
        );
        run = await launch(personal, account, () => {});
        await runCheck(run, false);
        await run.stop();
        run = undefined;
        run = await launch(null, account, () => {});
        await runCheck(run, false);
        await run.stop();
        run = undefined;
        expect(
          (
            await docker.listVolumes({
              filters: JSON.stringify({
                label: [
                  "ai.workspace.ssh=true",
                  "ai.workspace.instance=" + config.data,
                ],
              }),
            })
          ).Volumes,
        ).toHaveLength(0);
      } finally {
        await run?.stop();
      }
    },
    60000,
  );
  it.each(["failed", "exit", "interrupted"])(
    "closes the terminal and releases its folder after a %s event",
    async (type) => {
      vi.spyOn(gitModule, "initializeWorkspace").mockResolvedValue();
      let emit!: (event: any) => void | Promise<void>;
      const stopped = vi.fn(async () => {});
      const launched = vi
        .spyOn(runtimeModule, "launch")
        .mockImplementation(async (_chat, _account, onEvent) => {
          emit = onEvent;
          return { id: "terminal-fixture", send() {}, stop: stopped };
        });
      const socket = await openTerminal();
      const received: any[] = [];
      socket.on("message", (raw) => received.push(JSON.parse(raw.toString())));
      try {
        await vi.waitFor(() => expect(launched).toHaveBeenCalled());
        await emit({ type, error: "SSH access stopped unexpectedly." });
        await vi.waitFor(async () => {
          expect(socket.readyState).toBe(3);
          expect(
            (
              await db.query(
                "SELECT 1 FROM workspace_leases WHERE chat_id=$1",
                [chat],
              )
            ).rowCount,
          ).toBe(0);
        });
        expect(stopped).toHaveBeenCalledTimes(1);
        if (type === "failed")
          expect(received).toContainEqual({
            type: "terminal",
            data: "\r\nSSH access stopped unexpectedly.\r\n",
          });
        // Opening the same terminal again also verifies removal from the registry.
        const reopened = await openTerminal();
        try {
          await vi.waitFor(() => expect(launched).toHaveBeenCalledTimes(2));
        } finally {
          reopened.close();
          await vi.waitFor(() => expect(stopped).toHaveBeenCalledTimes(2));
          await vi.waitFor(async () =>
            expect(
              (
                await db.query(
                  "SELECT 1 FROM workspace_leases WHERE chat_id=$1",
                  [chat],
                )
              ).rowCount,
            ).toBe(0),
          );
        }
      } finally {
        socket.close();
        vi.restoreAllMocks();
      }
    },
  );

  it("keeps the terminal lease until a launch pending at disconnect has been stopped", async () => {
    vi.spyOn(gitModule, "initializeWorkspace").mockResolvedValue();
    let complete!: (runtime: Running) => void;
    const stopped = vi.fn(async () => {});
    vi.spyOn(runtimeModule, "launch").mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const socket = await openTerminal();
    try {
      await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
      socket.close();
      await vi.waitFor(() => expect(socket.readyState).toBe(3));
      expect(
        (
          await db.query("SELECT 1 FROM workspace_leases WHERE chat_id=$1", [
            chat,
          ])
        ).rowCount,
      ).toBe(1);
      complete({ id: "delayed-terminal", send() {}, stop: stopped });
      await vi.waitFor(async () =>
        expect(
          (
            await db.query("SELECT 1 FROM workspace_leases WHERE chat_id=$1", [
              chat,
            ])
          ).rowCount,
        ).toBe(0),
      );
      expect(stopped).toHaveBeenCalledTimes(1);
    } finally {
      complete?.({ id: "delayed-terminal", send() {}, stop: stopped });
      socket.close();
      vi.restoreAllMocks();
    }
  });

  it.skipIf(process.env.SSH_DOCKER_TESTS !== "1")(
    "closes a terminal after its SSH broker crashes and removes the socket volume",
    async () => {
      const key = await sshRuntime.sshOperation({ operation: "generate" });
      const keyId = randomUUID(),
        serverId = randomUUID();
      await db.query(
        "INSERT INTO ssh_keys(id,name,private_key,public_key,fingerprint) VALUES($1,'Test',$2,$3,$4)",
        [keyId, seal(key.private_key), key.public_key, key.fingerprint],
      );
      await db.query(
        "INSERT INTO ssh_servers(id,name,alias,host,port,username,key_id,host_keys) VALUES($1,'Test','assigned','127.0.0.1',2222,'tester',$2,$3)",
        [serverId, keyId, JSON.stringify([key.public_key])],
      );
      await db.query(
        "INSERT INTO ssh_links(id,chat_id,server_id) VALUES($1,$2,$3)",
        [randomUUID(), chat, serverId],
      );
      // No repository checkout or external SSH destination is needed.
      vi.spyOn(gitModule, "initializeWorkspace").mockResolvedValue();
      const filters = JSON.stringify({
        label: [
          "ai.workspace.ssh=true",
          "ai.workspace.instance=" + config.data,
        ],
      });
      const socket = await openTerminal();
      const received: any[] = [];
      socket.on("message", (raw) => received.push(JSON.parse(raw.toString())));
      try {
        await vi.waitFor(
          () => expect(received.some((e) => e.type === "terminal")).toBe(true),
          { timeout: 15000 },
        );
        const brokers = await docker.listContainers({ filters });
        expect(brokers).toHaveLength(1);
        await docker.getContainer(brokers[0].Id).remove({ force: true });
        await vi.waitFor(
          async () => {
            expect(socket.readyState).toBe(3);
            expect(
              (
                await db.query(
                  "SELECT 1 FROM workspace_leases WHERE chat_id=$1",
                  [chat],
                )
              ).rowCount,
            ).toBe(0);
            expect(
              (await docker.listVolumes({ filters })).Volumes,
            ).toHaveLength(0);
          },
          { timeout: 15000 },
        );
        expect(
          received.some(
            (e) =>
              e.type === "terminal" &&
              e.data.includes("SSH access stopped unexpectedly"),
          ),
        ).toBe(true);
        await acquireWorkspace(chat, "terminal");
        await releaseWorkspace(chat);
      } finally {
        socket.close();
        vi.restoreAllMocks();
      }
    },
    30000,
  );

  it("persists a shared GB budget and preserves history when the limit is lowered", async () => {
    const save = (limitGb: number) =>
      app.inject({
        method: "POST",
        url: "/api/settings/output",
        headers,
        payload: { limitGb },
      });
    for (const value of [0, -1, 0.001, 10001])
      expect((await save(value)).statusCode).toBe(400);
    expect((await save(0.02)).json().limitBytes).toBe(20_000_000);
    await db.query(
      "INSERT INTO messages(id,chat_id,role,content) VALUES($1,$2,'assistant',$3)",
      [randomUUID(), chat, "a".repeat(11_000_000)],
    );
    expect((await save(0.01)).statusCode).toBe(200);
    const before = await outputStorage();
    expect(before.usedBytes).toBeGreaterThan(before.limitBytes);
    await expect(
      event(chat, null, "log", { text: "blocked" }),
    ).rejects.toMatchObject({ code: "P5401" });
    await migrate();
    expect(await outputStorage()).toEqual(before);
    await db.query("DELETE FROM messages WHERE chat_id=$1", [chat]);
    expect((await outputStorage()).usedBytes).toBe(0);
    await expect(
      event(chat, null, "log", { text: "room again" }),
    ).resolves.toBeTruthy();
  });
  it("enforces atomic shared reservations and releases bytes after rollback and deletion", async () => {
    await db.query("UPDATE output_storage SET limit_bytes=1000 WHERE id=1");
    const writes = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        db.query("INSERT INTO events(chat_id,type,data) VALUES($1,'log',$2)", [
          chat,
          JSON.stringify({ text: "Привіт".repeat(20) }),
        ]),
      ),
    );
    expect(writes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(writes.filter((r) => r.status === "rejected")).toHaveLength(11);
    const usage = await outputStorage();
    expect(usage.usedBytes).toBeLessThanOrEqual(1000);
    expect(
      Number((await db.query("SELECT output_total_bytes() n")).rows[0].n),
    ).toBe(usage.usedBytes);
    // User messages do not consume the agent-output budget.
    await db.query(
      "INSERT INTO messages(id,chat_id,role,content) VALUES($1,$2,'user',$3)",
      [randomUUID(), chat, "user text".repeat(1000)],
    );
    expect((await outputStorage()).usedBytes).toBe(usage.usedBytes);
    await db.query("DELETE FROM events WHERE chat_id=$1", [chat]);
    expect((await outputStorage()).usedBytes).toBe(0);
    const message = randomUUID();
    await db.query(
      "INSERT INTO messages(id,chat_id,role,content) VALUES($1,$2,'assistant','saved')",
      [message, chat],
    );
    const saved = await outputStorage();
    await db.query(
      "INSERT INTO messages(id,chat_id,role,content) VALUES($1,$2,'assistant','duplicate') ON CONFLICT(id) DO NOTHING",
      [message, chat],
    );
    expect(await outputStorage()).toEqual(saved);
  });
  async function fakeJob() {
    const message = randomUUID(),
      id = randomUUID();
    await db.query(
      "INSERT INTO messages(id,chat_id,role,content) VALUES($1,$2,'user','work')",
      [message, chat],
    );
    const job = (
      await db.query(
        "INSERT INTO jobs(id,chat_id,message_id,account_id,state) VALUES($1,$2,$3,$4,'running') RETURNING *",
        [id, chat, message, account],
      )
    ).rows[0];
    let emit!: (e: any) => void | Promise<void>;
    const runtime = {
      id: "fake-runner",
      send: vi.fn(),
      stop: vi.fn(async () => {}),
    };
    vi.spyOn(gitModule, "initializeWorkspace").mockResolvedValue(undefined);
    vi.spyOn(runtimeModule, "launch").mockImplementation(
      async (_chat, _account, handler) => {
        emit = handler;
        return runtime;
      },
    );
    await runJob(job);
    return { job, runtime, emit };
  }
  it("appends deduplicated image download links to the saved chat reply", async () => {
    const { job, emit } = await fakeJob();
    try {
      const first = `generated-image-${randomUUID()}.png`;
      const second = `generated-image-${randomUUID()}.webp`;
      await emit({ type: "generated_image", name: first });
      await emit({ type: "generated_image", name: first });
      await emit({ type: "generated_image", name: "../private.png" });
      await emit({ type: "delta", text: "Ready." });
      await emit({ type: "generated_image", name: second });
      await emit({ type: "completed" });
      const response = await app.inject({ url: `/api/chats/${chat}`, headers });
      expect(response.statusCode).toBe(200);
      const saved = response
        .json()
        .messages.find((m: any) => m.role === "assistant");
      expect(saved.content).toBe(
        `Ready.\n\n[Download generated image 1 (PNG)](/api/chats/${chat}/file?path=${first})` +
          `\n\n[Download generated image 2 (WEBP)](/api/chats/${chat}/file?path=${second})`,
      );
      expect(
        (await db.query("SELECT state FROM jobs WHERE id=$1", [job.id])).rows[0]
          .state,
      ).toBe("completed");
    } finally {
      vi.restoreAllMocks();
    }
  });
  it("keeps the job completed if its optional image links exceed the output budget", async () => {
    const { job, emit } = await fakeJob();
    try {
      await emit({ type: "delta", text: "Ready." });
      const { usedBytes } = await outputStorage();
      await db.query("UPDATE output_storage SET limit_bytes=$1 WHERE id=1", [
        usedBytes + 350,
      ]);
      for (let i = 0; i < 8; i++)
        await emit({
          type: "generated_image",
          name: `generated-image-${randomUUID()}.png`,
        });
      await emit({ type: "completed" });
      const saved = (
        await app.inject({ url: `/api/chats/${chat}`, headers })
      ).json();
      expect(
        saved.messages.find((m: any) => m.role === "assistant").content,
      ).toBe("Ready.");
      expect(saved.jobs.find((j: any) => j.id === job.id).state).toBe(
        "completed",
      );
    } finally {
      vi.restoreAllMocks();
    }
  });
  it("stores complete correlated approval details for reload and rejects blind approval", async () => {
    const { job, runtime, emit } = await fakeJob();
    try {
      const details = {
        tool: "Bash",
        input: { command: "printf safe", cwd: "/workspace" },
      };
      await emit({
        type: "approval",
        id: "native-a",
        description: "Run command",
        details,
      });
      await emit({
        type: "approval",
        id: "native-b",
        description: "Run command",
        details: { ...details, input: { command: "rm important.txt" } },
      });
      const pending = (
        await app.inject({ url: `/api/chats/${chat}`, headers })
      ).json().approvals;
      expect(pending).toHaveLength(2);
      const first = pending.find((a: any) => a.request_id === "native-a");
      expect(first.details).toEqual(details);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/approvals/${first.id}`,
            headers,
            payload: { allow: true },
          })
        ).statusCode,
      ).toBe(200);
      expect(runtime.send).toHaveBeenLastCalledWith({
        type: "approve",
        id: "native-a",
        allow: true,
      });
      await emit({
        type: "approval",
        id: "legacy",
        description: "Missing arguments",
      });
      const legacy = (
        await db.query("SELECT id FROM approvals WHERE request_id='legacy'")
      ).rows[0];
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/approvals/${legacy.id}`,
            headers,
            payload: { allow: true },
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/approvals/${legacy.id}`,
            headers,
            payload: { allow: false },
          })
        ).statusCode,
      ).toBe(200);
      await emit({ type: "completed" });
      expect(
        (
          await db.query(
            "SELECT decision FROM approvals WHERE job_id=$1 AND request_id='native-b'",
            [job.id],
          )
        ).rows[0].decision,
      ).toBe(false);
    } finally {
      active.delete(job.id);
      vi.restoreAllMocks();
    }
  });
  it.each([false, true])(
    "stops output at capacity and preserves text/denies requests (lowered limit: %s)",
    async (lowered) => {
      const { job, runtime, emit } = await fakeJob();
      try {
        await emit({ type: "delta", text: "Already saved answer" });
        await emit({
          type: "approval",
          id: "request",
          description: "Run",
          details: { command: "ls" },
        });
        const before = await outputStorage();
        await db.query("UPDATE output_storage SET limit_bytes=$1 WHERE id=1", [
          lowered ? 1 : before.usedBytes + 10,
        ]);
        await emit({ type: "log", text: "x".repeat(1000) });
        const state = (
          await db.query(
            "SELECT state,error,container_id FROM jobs WHERE id=$1",
            [job.id],
          )
        ).rows[0];
        expect(state.state).toBe("failed");
        expect(state.error).toContain("output limit reached");
        expect(state.container_id).toBeNull();
        expect(runtime.stop).toHaveBeenCalledTimes(1);
        expect(active.has(job.id)).toBe(false);
        expect(
          (
            await db.query(
              "SELECT content FROM messages WHERE chat_id=$1 AND role='assistant'",
              [chat],
            )
          ).rows[0].content,
        ).toBe("Already saved answer");
        expect(
          (
            await db.query("SELECT decision FROM approvals WHERE job_id=$1", [
              job.id,
            ])
          ).rows[0].decision,
        ).toBe(false);
        expect((await outputStorage()).usedBytes).toBeLessThanOrEqual(
          before.usedBytes + 10,
        );
        expect((await outputStorage()).limitBytes).toBe(
          lowered ? 1 : before.usedBytes + 10,
        );
        await emit({ type: "delta", text: "ignored after stop" });
        expect(
          (
            await db.query(
              "SELECT count(*) n FROM events WHERE data->>'text'='ignored after stop'",
            )
          ).rows[0].n,
        ).toBe("0");
      } finally {
        active.delete(job.id);
        vi.restoreAllMocks();
      }
    },
  );
  it("caps the accumulated response by UTF-8 bytes and keeps the accepted portion", async () => {
    const { job, runtime, emit } = await fakeJob();
    try {
      const fragment = "😀".repeat(65536);
      for (let n = 0; n < 16; n++)
        await emit({ type: "delta", text: fragment });
      await emit({ type: "delta", text: "one byte too many" });
      const state = (
        await db.query("SELECT state,error FROM jobs WHERE id=$1", [job.id])
      ).rows[0];
      expect(state.state).toBe("failed");
      expect(state.error).toContain("4 MiB");
      expect(runtime.stop).toHaveBeenCalledTimes(1);
      const saved = (
        await db.query(
          "SELECT content FROM messages WHERE chat_id=$1 AND role='assistant'",
          [chat],
        )
      ).rows[0].content;
      expect(Buffer.byteLength(saved)).toBe(4 * 1024 * 1024);
      expect(saved).toBe(fragment.repeat(16));
      expect(
        (
          await db.query(
            "SELECT count(*) n FROM events WHERE job_id=$1 AND type='delta'",
            [job.id],
          )
        ).rows[0].n,
      ).toBe("0");
    } finally {
      active.delete(job.id);
      vi.restoreAllMocks();
    }
  });
  it("changes chat model and effort without changing title, permissions or global defaults", async () => {
    await db.query(
      "UPDATE chats SET model='old-model',effort='low',resolved_model='old-model',resolved_effort='low',autonomous=true,auto_title=true WHERE id=$1",
      [chat],
    );
    const update = (payload: any, id = chat) =>
      app.inject({
        method: "PATCH",
        url: `/api/chats/${id}/model`,
        headers,
        payload,
      });
    expect(
      (await update({ model: "new-model", effort: "high" })).statusCode,
    ).toBe(200);
    expect(
      (
        await db.query(
          "SELECT title,model,effort,resolved_model,resolved_effort,autonomous,auto_title,handoff FROM chats WHERE id=$1",
          [chat],
        )
      ).rows[0],
    ).toEqual({
      title: "Test",
      model: "new-model",
      effort: "high",
      resolved_model: "",
      resolved_effort: "",
      autonomous: true,
      auto_title: true,
      handoff: "manual",
    });
    expect(
      (await update({ model: "new-model", effort: "medium" })).statusCode,
    ).toBe(200);
    expect((await update({ model: " ", effort: "high" })).statusCode).toBe(400);
    expect(
      (await update({ model: "new-model", effort: "invalid" })).statusCode,
    ).toBe(400);
    expect(
      (await update({ model: "new-model", effort: "high" }, randomUUID()))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ url: "/api/settings/models", headers })).json(),
    ).toEqual({});
    await app.inject({
      method: "POST",
      url: `/api/chats/${chat}/messages`,
      headers,
      payload: { content: "Task", client_id: randomUUID() },
    });
    expect(
      (await update({ model: "new-model", effort: "low" })).statusCode,
    ).toBe(409);
  });
  it("switches approval modes independently of other chat settings", async () => {
    const before = (await db.query("SELECT * FROM chats WHERE id=$1", [chat]))
      .rows[0];
    const update = (autonomous: unknown, id = chat) =>
      app.inject({
        method: "PATCH",
        url: `/api/chats/${id}/permissions`,
        headers,
        payload: { autonomous },
      });
    for (const autonomous of [true, false]) {
      expect((await update(autonomous)).statusCode).toBe(200);
      expect(
        (await db.query("SELECT * FROM chats WHERE id=$1", [chat])).rows[0],
      ).toEqual({ ...before, autonomous });
    }
    expect((await update("true")).statusCode).toBe(400);
    expect((await update(true, randomUUID())).statusCode).toBe(404);
    await app.inject({
      method: "POST",
      url: `/api/chats/${chat}/messages`,
      headers,
      payload: { content: "Task", client_id: randomUUID() },
    });
    expect((await update(true)).statusCode).toBe(409);
    expect(
      (await db.query("SELECT autonomous FROM chats WHERE id=$1", [chat]))
        .rows[0].autonomous,
    ).toBe(false);
  });
  it("applies global model defaults only to new chats and respects per-chat overrides", async () => {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/settings/models/codex",
          headers,
          payload: { model: "global-model", effort: "high" },
        })
      ).statusCode,
    ).toBe(200);
    const create = (extra: any = {}) =>
      app.inject({
        method: "POST",
        url: "/api/chats",
        headers,
        payload: { provider: "codex", account_id: account, ...extra },
      });
    const first = (await create()).json();
    expect(first).toMatchObject({ model: "global-model", effort: "high" });
    expect(
      (await create({ model: "override-model", effort: "low" })).json(),
    ).toMatchObject({ model: "override-model", effort: "low" });
    await app.inject({
      method: "POST",
      url: "/api/settings/models/codex",
      headers,
      payload: { model: "next-model", effort: "medium" },
    });
    expect((await create()).json()).toMatchObject({
      model: "next-model",
      effort: "medium",
    });
    expect(
      (await db.query("SELECT model,effort FROM chats WHERE id=$1", [first.id]))
        .rows[0],
    ).toEqual({ model: "global-model", effort: "high" });
    expect(
      (await db.query("SELECT model FROM chats WHERE id=$1", [chat])).rows[0]
        .model,
    ).toBe("");
    expect(
      (await app.inject({ url: "/api/settings/models", headers })).json(),
    ).toEqual({ codex: { model: "next-model", effort: "medium" } });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/settings/models/claude",
          headers,
          payload: { model: "claude-specific", effort: "low" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: "/api/overview", headers })).json().modelDefaults
        .claude.model,
    ).toBe("claude-specific");
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/settings/models/codex",
          headers,
          payload: { model: "  " },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/settings/models/codex",
          headers: { origin },
          payload: { model: "no-auth" },
        })
      ).statusCode,
    ).toBe(401);
  });
  it("renames an active chat without changing model settings or allowing auto-title to overwrite it", async () => {
    await db.query(
      "UPDATE chats SET auto_title=true,model='chosen-model',effort='high' WHERE id=$1",
      [chat],
    );
    await app.inject({
      method: "POST",
      url: `/api/chats/${chat}/messages`,
      headers,
      payload: { content: "Task", client_id: randomUUID() },
    });
    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/chats/${chat}/title`,
      headers,
      payload: { title: "  My name  " },
    });
    expect(renamed.statusCode).toBe(200);
    expect(
      (
        await db.query(
          "SELECT title,auto_title,model,effort FROM chats WHERE id=$1",
          [chat],
        )
      ).rows[0],
    ).toEqual({
      title: "My name",
      auto_title: false,
      model: "chosen-model",
      effort: "high",
    });
    for (const title of ["  ", "a".repeat(161)])
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: `/api/chats/${chat}/title`,
            headers,
            payload: { title },
          })
        ).statusCode,
      ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/chats/${randomUUID()}/title`,
          headers,
          payload: { title: "Missing" },
        })
      ).statusCode,
    ).toBe(404);
  });
  it("deletes chat history while preserving working folders, original attachments and account", async () => {
    const mid = randomUUID(),
      jid = randomUUID();
    const project = (
      await db.query("SELECT project_id FROM chats WHERE id=$1", [chat])
    ).rows[0].project_id;
    await db.query(
      "INSERT INTO messages(id,chat_id,role,content) VALUES($1,$2,'user','Delete me')",
      [mid, chat],
    );
    await db.query(
      "INSERT INTO jobs(id,chat_id,message_id,state) VALUES($1,$2,$3,'completed')",
      [jid, chat, mid],
    );
    await db.query(
      "INSERT INTO approvals(id,job_id,request_id,description) VALUES($1,$2,'r','Approval')",
      [randomUUID(), jid],
    );
    await event(chat, jid, "status", { state: "completed" });
    await db.query(
      "INSERT INTO publications(id,chat_id,kind,status) VALUES($1,$2,'commit','done')",
      [randomUUID(), chat],
    );
    const storage = randomUUID() + "-upload.txt";
    await db.query(
      "INSERT INTO attachments(id,chat_id,workspace_id,message_id,name,mime,size,storage_name,client_id) VALUES($1,$2,$2,$3,'upload.txt','text/plain',4,$4,$5)",
      [randomUUID(), chat, mid, storage, randomUUID()],
    );
    await db.query(
      "INSERT INTO folder_links(id,name,chat_id) VALUES($1,'keep-shared',$2)",
      [randomUUID(), chat],
    );
    await db.query(
      "INSERT INTO folder_links(id,name,project_id) VALUES($1,'keep-project',$2)",
      [randomUUID(), project],
    );
    for (const dir of [
      path.join(data, "workspaces", chat),
      path.join(data, "uploads"),
      path.join(data, "shared", "keep-shared"),
    ])
      await mkdir(dir, { recursive: true });
    await writeFile(path.join(data, "uploads", storage), "file");
    await writeFile(
      path.join(data, "workspaces", chat, "private.txt"),
      "private",
    );
    const result = await app.inject({
      method: "DELETE",
      url: `/api/chats/${chat}`,
      headers,
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().cleanupPending).toBe(false);
    for (const table of [
      "chats",
      "jobs",
      "messages",
      "approvals",
      "events",
      "publications",
    ])
      expect((await db.query(`SELECT * FROM ${table}`)).rowCount).toBe(0);
    expect((await db.query("SELECT * FROM accounts")).rowCount).toBe(1);
    expect((await db.query("SELECT * FROM projects")).rowCount).toBe(1);
    expect((await db.query("SELECT name FROM folder_links")).rows).toEqual([
      { name: "keep-project" },
    ]);
    expect(
      (
        await db.query(
          "SELECT chat_id,message_id,workspace_id FROM attachments",
        )
      ).rows,
    ).toEqual([{ chat_id: null, message_id: null, workspace_id: chat }]);
    expect((await db.query("SELECT id FROM workspaces")).rows).toEqual([
      { id: chat },
    ]);
    expect(
      await readFile(
        path.join(data, "workspaces", chat, "private.txt"),
        "utf8",
      ),
    ).toBe("private");
    expect(await readFile(path.join(data, "uploads", storage), "utf8")).toBe(
      "file",
    );
    const library = (
      await app.inject({ url: `/api/workspaces/${chat}/attachments`, headers })
    ).json();
    expect(library).toHaveLength(1);
    expect(library[0].chat_title).toBeNull();
    await access(path.join(data, "shared", "keep-shared"));
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/chats/${chat}`,
          headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ url: "/api/overview", headers })).json().chats,
    ).toEqual([]);
    expect(
      (await app.inject({ url: "/api/search?q=Delete", headers })).json(),
    ).toEqual([]);
  });
  it("rejects deletion while a task or terminal owns the workspace", async () => {
    await acquireWorkspace(chat, "terminal");
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/chats/${chat}`,
          headers,
        })
      ).statusCode,
    ).toBe(409);
    await releaseWorkspace(chat);
    const mid = randomUUID(),
      jid = randomUUID();
    await db.query(
      "INSERT INTO messages(id,chat_id,role,content) VALUES($1,$2,'user','Keep me')",
      [mid, chat],
    );
    await db.query("INSERT INTO jobs(id,chat_id,message_id) VALUES($1,$2,$3)", [
      jid,
      chat,
      mid,
    ]);
    for (const state of [
      "queued",
      "running",
      "waiting_approval",
      "waiting_account",
    ]) {
      await db.query("UPDATE jobs SET state=$2 WHERE id=$1", [jid, state]);
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: `/api/chats/${chat}`,
            headers,
          })
        ).statusCode,
      ).toBe(409);
    }
    expect(
      (await db.query("SELECT * FROM messages WHERE id=$1", [mid])).rowCount,
    ).toBe(1);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/chats/${chat}`,
          headers: { origin },
        })
      ).statusCode,
    ).toBe(401);
  });
  it("saves all Claude windows, timestamps reports and waits for every exhausted limit to reset", async () => {
    await saveUsage(account, {
      rateLimitType: "five_hour",
      utilization: 1,
      resetsAt: 2000000000,
    });
    await saveUsage(account, {
      rateLimitType: "seven_day",
      utilization: 1,
      resetsAt: 2000100000,
    });
    const saved = (
      await db.query("SELECT * FROM accounts WHERE id=$1", [account])
    ).rows[0];
    expect(Object.keys(saved.limits.windows)).toEqual([
      "five_hour",
      "seven_day",
    ]);
    expect(saved.reset_at.getTime()).toBe(2000100000000);
    expect(saved.limits_updated_at).toBeTruthy();
  });
  it("refreshes Codex usage once per account without inference and releases the account on failure", async () => {
    const start = vi.fn(async (_chat, _id, emit) => ({
      id: "usage-test",
      send: () =>
        emit({
          type: "limits_read",
          limits: {
            rateLimits: {
              primary: { usedPercent: 25, windowDurationMins: 300 },
            },
          },
        }),
      stop: async () => {},
    }));
    const [a, b] = await Promise.all([
      accountUsage(account, start),
      accountUsage(account, start),
    ]);
    expect(a.limits).toEqual(b.limits);
    expect(start).toHaveBeenCalledTimes(1);
    expect(
      (await db.query("SELECT status FROM accounts WHERE id=$1", [account]))
        .rows[0].status,
    ).toBe("ready");
    await expect(
      accountUsage(account, async (_chat, _id, emit) => ({
        id: "usage-fail",
        send: () => emit({ type: "failed" }),
        stop: async () => {},
      })),
    ).rejects.toThrow("unavailable");
    expect(
      (await db.query("SELECT status FROM accounts WHERE id=$1", [account]))
        .rows[0].status,
    ).toBe("ready");
  });
  it("deduplicates model loading and serves a cached catalog while the account is busy", async () => {
    const models = [
      {
        id: "test-model",
        supportedReasoningEfforts: [{ reasoningEffort: "high" }],
      },
    ];
    const start = vi.fn(async (_chat, _id, emit) => ({
      id: "models-test",
      send: () => emit({ type: "models", models }),
      stop: async () => {},
    }));
    expect(
      await Promise.all([
        accountModels(account, false, start),
        accountModels(account, false, start),
      ]),
    ).toEqual([models, models]);
    expect(start).toHaveBeenCalledTimes(1);
    const mid = randomUUID();
    await db.query(
      "INSERT INTO messages(id,chat_id,role,content) VALUES($1,$2,'user','test')",
      [mid, chat],
    );
    await db.query(
      "INSERT INTO jobs(id,chat_id,message_id,account_id,state) VALUES($1,$2,$3,$4,'running')",
      [randomUUID(), chat, mid, account],
    );
    expect(await accountModels(account, false, start)).toEqual(models);
    await expect(accountModels(account, true, start)).rejects.toThrow(
      "available",
    );
    expect(start).toHaveBeenCalledTimes(1);
  });
  it("releases the model lease after a failed native catalog request", async () => {
    const start = vi.fn(async (_chat, _id, emit) => ({
      id: "bad-models",
      send: () => emit({ type: "failed" }),
      stop: async () => {},
    }));
    await expect(accountModels(account, false, start)).rejects.toThrow(
      "temporarily unavailable",
    );
    expect(
      (
        await db.query(
          "SELECT status,model_catalog FROM accounts WHERE id=$1",
          [account],
        )
      ).rows[0],
    ).toMatchObject({ status: "ready", model_catalog: null });
  });
  it("persists plan mode and rejects unknown commands without creating a model turn", async () => {
    const post = (url: string, payload: any) =>
      app.inject({ method: "POST", url, headers, payload });
    expect(
      (
        await post(`/api/chats/${chat}/messages`, {
          content: "/fake-command",
          client_id: randomUUID(),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await post(`/api/chats/${chat}/messages`, {
          content: "/compact",
          client_id: randomUUID(),
        })
      ).statusCode,
    ).toBe(400);
    const payload = {
      content: "/plan Design the API",
      client_id: randomUUID(),
    };
    const first = await post(`/api/chats/${chat}/messages`, payload);
    expect(first.statusCode).toBe(200);
    expect((await post(`/api/chats/${chat}/messages`, payload)).json().id).toBe(
      first.json().id,
    );
    expect(
      (await db.query("SELECT mode FROM chats WHERE id=$1", [chat])).rows[0]
        .mode,
    ).toBe("plan");
    expect(
      (await post(`/api/chats/${chat}/mode`, { mode: "default" })).statusCode,
    ).toBe(409);
    await db.query("UPDATE jobs SET state='completed' WHERE chat_id=$1", [
      chat,
    ]);
    expect(
      (await post(`/api/chats/${chat}/mode`, { mode: "default" })).statusCode,
    ).toBe(200);
  });
  it("routes only Claude commands reported by this chat's native session", async () => {
    await db.query(
      "UPDATE chats SET provider='claude',native_commands='[\"context\",\"my-skill\"]' WHERE id=$1",
      [chat],
    );
    const post = (content: string) =>
      app.inject({
        method: "POST",
        url: `/api/chats/${chat}/messages`,
        headers,
        payload: { content, client_id: randomUUID() },
      });
    expect((await post("/review")).statusCode).toBe(400);
    expect((await post("/my-skill inspect files")).statusCode).toBe(200);
  });
  it("retains unanswered questions on reconnect and accepts one complete answer", async () => {
    const mid = randomUUID(),
      jid = randomUUID(),
      id = randomUUID();
    await db.query(
      "INSERT INTO messages(id,chat_id,role,content) VALUES($1,$2,'user','plan')",
      [mid, chat],
    );
    await db.query(
      "INSERT INTO jobs(id,chat_id,message_id,state) VALUES($1,$2,$3,'waiting_approval')",
      [jid, chat, mid],
    );
    await db.query(
      "INSERT INTO approvals(id,job_id,request_id,description,kind,questions) VALUES($1,$2,'native-1','Choose','question',$3)",
      [id, jid, JSON.stringify([{ id: "choice", question: "Which?" }])],
    );
    const send = vi.fn();
    active.set(jid, { id: "test", send, stop: async () => {} });
    try {
      const detail = await app.inject({
        method: "GET",
        url: `/api/chats/${chat}`,
        headers,
      });
      expect(detail.json().approvals[0].questions[0].id).toBe("choice");
      const wrong = await app.inject({
        method: "POST",
        url: `/api/approvals/${id}`,
        headers,
        payload: { allow: true },
      });
      expect(wrong.statusCode).toBe(409);
      const answer = (answers: any) =>
        app.inject({
          method: "POST",
          url: `/api/questions/${id}`,
          headers,
          payload: { answers },
        });
      expect((await answer({})).statusCode).toBe(400);
      expect(
        (await answer({ choice: { answers: ["First"] } })).statusCode,
      ).toBe(200);
      expect(send).toHaveBeenCalledWith({
        type: "answer",
        id: "native-1",
        answers: { choice: { answers: ["First"] } },
      });
      expect(
        (await answer({ choice: { answers: ["First"] } })).statusCode,
      ).toBe(409);
      expect(
        (await db.query("SELECT state FROM jobs WHERE id=$1", [jid])).rows[0]
          .state,
      ).toBe("running");
    } finally {
      active.delete(jid);
    }
  });
  it("disconnects through the native runner before releasing the account", async () => {
    const start = vi.fn(async (_chat, id, emit) => {
      expect(id).toBe(account);
      expect(
        (await db.query("SELECT status FROM accounts WHERE id=$1", [account]))
          .rows[0].status,
      ).toBe("disconnecting");
      return {
        id: "logout-test",
        send: (command: any) => {
          expect(command).toEqual({ type: "logout", provider: "codex" });
          emit({ type: "logout_complete", success: true });
        },
        stop: async () => {
          expect(
            (
              await db.query("SELECT status FROM accounts WHERE id=$1", [
                account,
              ])
            ).rows[0].status,
          ).toBe("disconnecting");
        },
      };
    });
    await disconnectAccount(account, start);
    expect(
      (await db.query("SELECT status FROM accounts WHERE id=$1", [account]))
        .rows[0].status,
    ).toBe("disconnected");
    expect(
      (await db.query("SELECT id FROM chats WHERE id=$1", [chat])).rowCount,
    ).toBe(1);
  });
  it("blocks logout during tasks and retains uncertain sign-out as unavailable", async () => {
    const message = randomUUID();
    await db.query(
      "INSERT INTO messages(id,chat_id,role,content) VALUES($1,$2,'user','test')",
      [message, chat],
    );
    await db.query(
      "INSERT INTO jobs(id,chat_id,message_id,account_id,state) VALUES($1,$2,$3,$4,'waiting_approval')",
      [randomUUID(), chat, message, account],
    );
    const start = vi.fn();
    await expect(disconnectAccount(account, start)).rejects.toThrow(
      "Stop the active task",
    );
    expect(start).not.toHaveBeenCalled();
    await db.query("DELETE FROM jobs");
    await expect(
      disconnectAccount(account, async (_chat, _id, emit) => ({
        id: "failed-logout",
        send: () => emit({ type: "logout_complete", success: false }),
        stop: async () => {},
      })),
    ).rejects.toThrow("could not sign out");
    expect(
      (await db.query("SELECT status FROM accounts WHERE id=$1", [account]))
        .rows[0].status,
    ).toBe("disconnect_failed");
  });
  it("preserves model and reasoning choices reported by the agent", async () => {
    const result = await app.inject({
      method: "POST",
      url: "/api/chats",
      headers,
      payload: {
        provider: "codex",
        account_id: account,
        model: "gpt-6.1",
        effort: "ultra",
      },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().model).toBe("gpt-6.1");
    expect(result.json().effort).toBe("ultra");
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/chats/${result.json().id}`,
      headers,
      payload: {
        title: "Renamed chat",
        model: "gpt-6.1",
        effort: "ultra",
        autonomous: false,
        handoff: "manual",
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(
      (
        await db.query("SELECT effort,title FROM chats WHERE id=$1", [
          result.json().id,
        ])
      ).rows[0],
    ).toEqual({ effort: "ultra", title: "Renamed chat" });
  });
  it("creates unnamed chats and titles them once from the first message", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/chats",
      headers,
      payload: { provider: "codex", account_id: account },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().id;
    expect(created.json().title).toBe("New chat");
    const payload = {
      content: "  Build a\n simple app  ",
      client_id: randomUUID(),
    };
    for (let i = 0; i < 2; i++)
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/chats/${id}/messages`,
            headers,
            payload,
          })
        ).statusCode,
      ).toBe(200);
    expect(
      (await db.query("SELECT title FROM chats WHERE id=$1", [id])).rows[0]
        .title,
    ).toBe("Build a simple app");
    await db.query("UPDATE jobs SET state='completed' WHERE chat_id=$1", [id]);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/chats/${id}/messages`,
          headers,
          payload: { content: "Another message", client_id: randomUUID() },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await db.query("SELECT title FROM chats WHERE id=$1", [id])).rows[0]
        .title,
    ).toBe("Build a simple app");
    expect(
      (await db.query("SELECT * FROM messages WHERE chat_id=$1", [id]))
        .rowCount,
    ).toBe(2);
  });
  it("connects project and chat folders and serializes shared writers", async () => {
    const name = "test-" + randomUUID();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/folders",
          headers,
          payload: { name },
        })
      ).statusCode,
    ).toBe(200);
    expect(await availableFolders()).toContain(name);
    const source = await folderPath(name);
    await writeFile(path.join(source, "keep.txt"), "keep");
    const project = (
      await db.query("SELECT project_id FROM chats WHERE id=$1", [chat])
    ).rows[0].project_id;
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${project}/folders`,
          headers,
          payload: { name, read_only: false },
        })
      ).statusCode,
    ).toBe(200);
    const links = (
      await app.inject({
        method: "GET",
        url: `/api/chats/${chat}/folders`,
        headers,
      })
    ).json();
    expect(links[0].inherited).toBe(true);
    const mounts = await folderMounts(chat);
    expect(mounts[0].ReadOnly).toBe(false);
    expect(mounts[0].Target).toBe("/workspace/.workspace-folders/" + name);
    const account2 = randomUUID();
    await db.query(
      "INSERT INTO accounts(id,name,provider,status) VALUES($1,'B','codex','ready')",
      [account2],
    );
    const separateFolder = await createWorkspace(
      project,
      "saved",
      "Other folder",
      db,
    );
    const second = (
      await app.inject({
        method: "POST",
        url: "/api/chats",
        headers,
        payload: {
          project_id: project,
          workspace_id: separateFolder.id,
          provider: "codex",
          account_id: account2,
        },
      })
    ).json();
    for (const id of [chat, second.id])
      await app.inject({
        method: "POST",
        url: `/api/chats/${id}/messages`,
        headers,
        payload: { content: "test", client_id: randomUUID() },
      });
    expect(await claim()).toBeTruthy();
    expect(await claim()).toBeNull();
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/projects/${project}/folders/${name}`,
          headers,
        })
      ).statusCode,
    ).toBe(409);
    await db.query("UPDATE jobs SET state='completed'");
    await acquireWorkspace(chat, "terminal");
    await expect(acquireWorkspace(second.id, "terminal")).rejects.toThrow(
      "connected folder",
    );
    await releaseWorkspace(chat);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${project}/folders`,
          headers,
          payload: { name, read_only: true },
        })
      ).statusCode,
    ).toBe(200);
    await acquireWorkspace(chat, "terminal");
    await acquireWorkspace(second.id, "terminal");
    await releaseWorkspace(chat);
    await releaseWorkspace(second.id);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/projects/${project}/folders/${name}`,
          headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(await readFile(path.join(source, "keep.txt"), "utf8")).toBe("keep");
  });
  it.skipIf(process.env.DOCKER_TESTS !== "1")(
    "uploads nested folders in isolation, retries safely and prevents overwrite",
    async () => {
      const name = "docker-" + randomUUID();
      await app.inject({
        method: "POST",
        url: "/api/folders",
        headers,
        payload: { name },
      });
      const source = await folderPath(name),
        staged = path.join(data, "staged-file");
      await writeFile(staged, "upload");
      const ro = await docker.createContainer({
        Image: config.image,
        User: "1000:1000",
        Cmd: [
          "node",
          "-e",
          "const fs=require('fs');try{fs.writeFileSync('/folder/forbidden','x');process.exit(1)}catch(e){process.exit(e.code==='EROFS'?0:2)}",
        ],
        HostConfig: {
          Mounts: [
            { Type: "bind", Source: source, Target: "/folder", ReadOnly: true },
          ],
          NetworkMode: "none",
          ReadonlyRootfs: true,
          CapDrop: ["ALL"],
        },
      });
      try {
        await ro.start();
        expect((await ro.wait()).StatusCode).toBe(0);
      } finally {
        await ro.remove({ force: true });
      }

      await copyFolderUpload(source, staged, "nested/test.txt");
      await copyFolderUpload(source, staged, "nested/test.txt");
      expect(await readFile(path.join(source, "nested/test.txt"), "utf8")).toBe(
        "upload",
      );
      await writeFile(staged, "changed");
      await expect(
        copyFolderUpload(source, staged, "nested/test.txt"),
      ).rejects.toThrow("could not be saved");
      expect((await inspectDirectory(source, "nested", "list"))[0].name).toBe(
        "test.txt",
      );
      await mkdir(path.join(source, ".agents/skills/demo"), {
        recursive: true,
      });
      await writeFile(
        path.join(source, ".agents/skills/demo/SKILL.md"),
        "# Demo",
      );
      const entries = await inspectDirectory(source, "", "index");
      expect(entries).toContainEqual({
        kind: "skill",
        name: "demo",
        path: "/workspace/.agents/skills/demo/SKILL.md",
      });
      await import("node:fs/promises").then((fs) =>
        fs.symlink("/outside", path.join(source, "escape")),
      );
      await expect(
        copyFolderUpload(source, staged, "escape/leak.txt"),
      ).rejects.toThrow();
    },
  );
  it("migrates legacy folders in place and requires an explicit main-folder choice", async () => {
    const project = (
      await db.query("SELECT project_id FROM chats WHERE id=$1", [chat])
    ).rows[0].project_id;
    const folder = workspacePath(chat);
    await mkdir(path.join(folder, ".workspace-attachments"), {
      recursive: true,
    });
    await mkdir(folder + ".initializing", { recursive: true });
    const files = ["uncommitted.txt", ".workspace-attachments/original.txt"];
    for (const f of files) await writeFile(path.join(folder, f), "keep " + f);
    await writeFile(
      path.join(folder + ".initializing", "partial.txt"),
      "keep partial clone",
    );
    const originalId = randomUUID(),
      storage = originalId + "-original.txt";
    await mkdir(path.join(data, "uploads"), { recursive: true });
    await writeFile(path.join(data, "uploads", storage), "original upload");
    await db.query(
      "INSERT INTO attachments(id,chat_id,workspace_id,name,mime,size,storage_name,client_id) VALUES($1,$2,$2,'original.txt','text/plain',15,$3,$4)",
      [originalId, chat, storage, randomUUID()],
    );
    await db.query("UPDATE chats SET initialized=true WHERE id=$1", [chat]);
    await acquireWorkspace(chat, "terminal");
    // Simulate the old schema, including an existing terminal lease.
    await db.query(
      "ALTER TABLE chats DROP COLUMN workspace_id; ALTER TABLE attachments DROP COLUMN workspace_id; ALTER TABLE workspace_leases DROP COLUMN workspace_id; DELETE FROM workspaces",
    );
    await migrate();
    await migrate();
    expect(await chatWorkspace(chat)).toMatchObject({
      id: chat,
      kind: "saved",
      name: "Test",
      initialized: true,
      branch: "workspace/test",
    });
    expect(
      (await db.query("SELECT workspace_id FROM workspace_leases")).rows,
    ).toEqual([{ workspace_id: chat }]);
    for (const f of files)
      expect(await readFile(path.join(folder, f), "utf8")).toBe("keep " + f);
    expect(
      await readFile(
        path.join(folder + ".initializing", "partial.txt"),
        "utf8",
      ),
    ).toBe("keep partial clone");
    expect(
      (
        await db.query("SELECT workspace_id FROM attachments WHERE id=$1", [
          originalId,
        ])
      ).rows[0].workspace_id,
    ).toBe(chat);
    expect(await readFile(path.join(data, "uploads", storage), "utf8")).toBe(
      "original upload",
    );
    const create = () =>
      app.inject({
        method: "POST",
        url: "/api/chats",
        headers,
        payload: {
          project_id: project,
          provider: "codex",
          account_id: account,
        },
      });
    expect((await create()).statusCode).toBe(409);
    const choose = () =>
      app.inject({
        method: "POST",
        url: `/api/projects/${project}/main-workspace`,
        headers,
        payload: { workspace_id: chat },
      });
    expect((await choose()).statusCode).toBe(409);
    await releaseWorkspace(chat);
    expect((await choose()).statusCode).toBe(200);
    const created = await create();
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      workspace_id: chat,
      workspace_kind: "main",
      initialized: true,
    });
    expect((await choose()).statusCode).toBe(409);
    expect((await db.query("SELECT * FROM workspaces")).rowCount).toBe(1);
    await migrate();
    expect((await chatWorkspace(chat)).kind).toBe("main");
    for (const f of files)
      expect(await readFile(path.join(folder, f), "utf8")).toBe("keep " + f);
  });
  it("refuses to initialize over existing project files", async () => {
    const folder = workspacePath(chat);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "unsaved.txt"), "keep my work");
    await expect(initializeWorkspace({ id: chat })).rejects.toThrow(
      "already contains files",
    );
    expect(await readFile(path.join(folder, "unsaved.txt"), "utf8")).toBe(
      "keep my work",
    );
    expect((await chatWorkspace(chat)).initialized).toBe(false);
  });
  it("can start a fresh main folder without changing preserved folders or their chats", async () => {
    const previous = await chatWorkspace(chat);
    await db.query("UPDATE workspaces SET kind='saved' WHERE id=$1", [
      previous.id,
    ]);
    await mkdir(workspacePath(previous.id), { recursive: true });
    await writeFile(
      path.join(workspacePath(previous.id), "keep.txt"),
      "unmerged work",
    );
    const r = await app.inject({
      method: "POST",
      url: `/api/projects/${previous.project_id}/main-workspace`,
      headers,
      payload: { workspace_id: null },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().id).not.toBe(previous.id);
    expect((await chatWorkspace(chat)).id).toBe(previous.id);
    expect(
      await readFile(path.join(workspacePath(previous.id), "keep.txt"), "utf8"),
    ).toBe("unmerged work");
    const created = await app.inject({
      method: "POST",
      url: "/api/chats",
      headers,
      payload: {
        project_id: previous.project_id,
        provider: "codex",
        account_id: account,
      },
    });
    expect(created.json().workspace_id).toBe(r.json().id);
    const foreign = await createWorkspace(null, "personal", "Unrelated", db);
    const rejected = await app.inject({
      method: "POST",
      url: "/api/chats",
      headers,
      payload: {
        project_id: previous.project_id,
        workspace_id: foreign.id,
        provider: "codex",
        account_id: account,
      },
    });
    expect(rejected.statusCode).toBe(400);
  });
  it("serializes tasks and terminals across chats sharing a folder but permits other folders", async () => {
    const w = await chatWorkspace(chat);
    const account2 = randomUUID();
    await db.query(
      "INSERT INTO accounts(id,name,provider,status) VALUES($1,'Second','codex','ready')",
      [account2],
    );
    const create = async (project_id: string | null) => {
      const r = await app.inject({
        method: "POST",
        url: "/api/chats",
        headers,
        payload: { project_id, provider: "codex", account_id: account2 },
      });
      expect(r.statusCode).toBe(200);
      return r.json();
    };
    const second = await create(w.project_id);
    expect(second.workspace_id).toBe(w.id);
    const separate = await create(null);
    await acquireWorkspace(chat, "terminal");
    await expect(acquireWorkspace(second.id, "terminal")).rejects.toThrow(
      "folder is in use",
    );
    await expect(acquireFolder(w.id, "upload")).rejects.toThrow(
      "folder is in use",
    );
    await acquireWorkspace(separate.id, "terminal");
    await releaseWorkspace(separate.id);
    await releaseWorkspace(chat);
    await acquireFolder(w.id, "upload");
    const queue = async (id: string) => {
      const r = await app.inject({
        method: "POST",
        url: `/api/chats/${id}/messages`,
        headers,
        payload: { content: "work", client_id: randomUUID() },
      });
      expect(r.statusCode).toBe(200);
    };
    await queue(chat);
    await queue(second.id);
    expect(await claim()).toBeNull();
    await releaseFolder(w.id);
    const claims = (await Promise.all([claim(), claim()])).filter(Boolean);
    expect(claims).toHaveLength(1);
    expect(claims[0].chat_id).toBe(chat);
    await db.query("UPDATE jobs SET state='waiting_approval' WHERE id=$1", [
      claims[0].id,
    ]);
    expect(await claim()).toBeNull();
    await queue(separate.id);
    const other = await claim();
    expect(other.chat_id).toBe(separate.id);
    await db.query(
      "UPDATE jobs SET state='completed' WHERE id=ANY($1::uuid[])",
      [[claims[0].id, other.id]],
    );
    expect((await claim()).chat_id).toBe(second.id);
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM messages WHERE chat_id=$1",
          [second.id],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("keeps the shared folder accessible after deleting its original and last chat", async () => {
    const w = await chatWorkspace(chat);
    await mkdir(workspacePath(w.id), { recursive: true });
    await writeFile(
      path.join(workspacePath(w.id), "shared.txt"),
      "keep forever",
    );
    const create = () =>
      app.inject({
        method: "POST",
        url: "/api/chats",
        headers,
        payload: {
          project_id: w.project_id,
          provider: "codex",
          account_id: account,
        },
      });
    const second = (await create()).json();
    for (const id of [chat, second.id]) {
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: `/api/chats/${id}`,
            headers,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        await readFile(path.join(workspacePath(w.id), "shared.txt"), "utf8"),
      ).toBe("keep forever");
    }
    const overview = (
      await app.inject({ url: "/api/overview", headers })
    ).json();
    expect(overview.chats).toEqual([]);
    expect(overview.workspaces).toContainEqual(
      expect.objectContaining({ id: w.id, kind: "main" }),
    );
    expect((await create()).json().workspace_id).toBe(w.id);
  });
  it("limits the number of simultaneous inline image reads", async () => {
    let activeReads = 0;
    let peakReads = 0;
    const source = vi
      .spyOn(workspaceFiles, "inspectWorkspace")
      .mockImplementation(async (_chat, relative) => {
        peakReads = Math.max(peakReads, ++activeReads);
        await new Promise((resolve) => setTimeout(resolve, 50));
        activeReads--;
        return relative === "fake.png"
          ? Buffer.from("not an image")
          : Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
      });
    try {
      const responses = await Promise.all(
        ["one.png", "fake.png", "two.png", "three.png", "four.png"].map(
          (file) =>
            app.inject({
              url: `/api/chats/${chat}/file?path=${file}&inline=1`,
              headers,
            }),
        ),
      );
      expect(peakReads).toBe(2);
      expect(responses.map((response) => response.statusCode)).toEqual([
        200, 415, 200, 200, 200,
      ]);
    } finally {
      source.mockRestore();
    }
  });

  it.skipIf(process.env.DOCKER_TESTS !== "1")(
    "opens authentic raster files inline and preserves the normal download route",
    async () => {
      const name = "render.png";
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKZQAAAAASUVORK5CYII=",
        "base64",
      );
      const folder = workspacePath(chat);
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, name), png);
      await writeFile(
        path.join(folder, "fake.png"),
        "<html><script>console.log(1)</script></html>",
      );
      await writeFile(
        path.join(folder, "vector.svg"),
        '<svg xmlns="http://www.w3.org/2000/svg"/>',
      );
      const file = (relative: string) =>
        `/api/chats/${chat}/file?path=${encodeURIComponent(relative)}`;
      const inline = await app.inject({
        url: file(name) + "&inline=1",
        headers,
      });
      expect(inline.statusCode).toBe(200);
      expect(inline.headers).toMatchObject({
        "content-type": "image/png",
        "content-disposition": "inline; filename*=UTF-8''render.png",
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      });
      expect(inline.rawPayload.equals(png)).toBe(true);
      const download = await app.inject({ url: file(name), headers });
      expect(download.statusCode).toBe(200);
      expect(download.headers).toMatchObject({
        "content-type": "application/octet-stream",
        "content-disposition": "attachment; filename*=UTF-8''render.png",
      });
      expect(download.rawPayload.equals(png)).toBe(true);
      expect(
        (await app.inject({ url: file(name) + "&inline=1" })).statusCode,
      ).toBe(401);
      for (const invalid of ["fake.png", "vector.svg"])
        expect(
          (await app.inject({ url: file(invalid) + "&inline=1", headers }))
            .statusCode,
        ).toBe(415);
      expect(
        (
          await app.inject({
            url: file("../render.png") + "&inline=1",
            headers,
          })
        ).statusCode,
      ).toBe(400);
    },
    30000,
  );
  it.skipIf(process.env.DOCKER_TESTS !== "1")(
    "shares uploaded files through both chats and preserves originals on deletion",
    async () => {
      const w = await chatWorkspace(chat);
      // A local prepared folder avoids GitHub or provider calls in this test.
      await mkdir(workspacePath(w.id), { recursive: true });
      await db.query("UPDATE workspaces SET initialized=true WHERE id=$1", [
        w.id,
      ]);
      const second = (
        await app.inject({
          method: "POST",
          url: "/api/chats",
          headers,
          payload: {
            project_id: w.project_id,
            provider: "codex",
            account_id: account,
          },
        })
      ).json();
      const uploadFile = (content: string, relative = "phone.txt") =>
        app.inject({
          method: "POST",
          url: `/api/workspaces/${w.id}/files?path=${encodeURIComponent(relative)}`,
          headers: {
            ...headers,
            "content-type": "multipart/form-data; boundary=test-boundary",
          },
          payload: `--test-boundary\r\nContent-Disposition: form-data; name="file"; filename="phone.txt"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--test-boundary--\r\n`,
        });
      expect((await uploadFile("from phone")).statusCode).toBe(200);
      for (const id of [chat, second.id]) {
        const r = await app.inject({
          url: `/api/chats/${id}/file?path=phone.txt`,
          headers,
        });
        expect(r.statusCode).toBe(200);
        expect(r.body).toBe("from phone");
      }
      expect((await uploadFile("overwrite")).statusCode).toBe(409);
      expect(
        (await uploadFile("original", ".workspace-attachments/new.txt"))
          .statusCode,
      ).toBe(400);
      await acquireWorkspace(second.id, "terminal");
      expect((await uploadFile("blocked", "another.txt")).statusCode).toBe(409);
      await releaseWorkspace(second.id);
      expect((await uploadFile("from phone")).statusCode).toBe(200);
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: `/api/chats/${chat}`,
            headers,
          })
        ).statusCode,
      ).toBe(200);
      const r = await app.inject({
        url: `/api/workspaces/${w.id}/file?path=phone.txt`,
        headers,
      });
      expect(r.body).toBe("from phone");
    },
    30000,
  );

  it.skipIf(process.env.DOCKER_TESTS !== "1")(
    "mounts the shared folder and read-only chat originals without changing legacy files",
    async () => {
      const w = await chatWorkspace(chat);
      await mkdir(path.join(workspacePath(w.id), ".workspace-attachments"), {
        recursive: true,
      });
      await writeFile(
        path.join(workspacePath(w.id), "shared.txt"),
        "SHARED_FOLDER_CONTENT",
      );
      await writeFile(
        path.join(workspacePath(w.id), ".workspace-attachments", "keep.txt"),
        "legacy attachment edits",
      );
      const second = (
        await app.inject({
          method: "POST",
          url: "/api/chats",
          headers,
          payload: {
            project_id: w.project_id,
            provider: "codex",
            account_id: account,
          },
        })
      ).json();
      expect(second.id).not.toBe(w.id);
      const mid = randomUUID(),
        fid = randomUUID(),
        storage = fid + "-original.txt";
      await mkdir(path.join(data, "uploads"), { recursive: true });
      await writeFile(
        path.join(data, "uploads", storage),
        "ORIGINAL_ATTACHMENT",
      );
      await db.query(
        "INSERT INTO messages(id,chat_id,role,content) VALUES($1,$2,'user','Attachment')",
        [mid, second.id],
      );
      await db.query(
        "INSERT INTO attachments(id,chat_id,workspace_id,message_id,name,mime,size,storage_name,client_id) VALUES($1,$2,$3,$4,'original.txt','text/plain',19,$5,$6)",
        [fid, second.id, w.id, mid, storage, randomUUID()],
      );
      let output = "",
        done!: () => void;
      const ready = new Promise<void>((resolve) => {
        done = resolve;
      });
      let runtime: Running | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await acquireWorkspace(second.id, "terminal");
      try {
        runtime = await launch(second.id, null, (e) => {
          if (e.type === "terminal") {
            output += e.data;
            if (output.includes("MOUNT_CHECK_DONE")) done();
          }
        });
        runtime.send({
          type: "terminal",
          data:
            "cat /workspace/shared.txt; cat /attachments/" +
            storage +
            "; node -e \"try{require('fs').writeFileSync('/attachments/" +
            storage +
            "','bad');console.log('WRITABLE_ORIGINAL')}catch(e){console.log(e.code)}\"; printf '\\nMOUNT_CHECK_%s\\n' DONE\r",
        });
        await Promise.race([
          ready,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Terminal check timed out: " + output)),
              10000,
            );
          }),
        ]);
        expect(output).toContain("SHARED_FOLDER_CONTENT");
        expect(output).toContain("ORIGINAL_ATTACHMENT");
        expect(output).toMatch(/EROFS|EACCES/);
        expect(
          await readFile(path.join(data, "uploads", storage), "utf8"),
        ).toBe("ORIGINAL_ATTACHMENT");
        expect(
          await readFile(
            path.join(
              workspacePath(w.id),
              ".workspace-attachments",
              "keep.txt",
            ),
            "utf8",
          ),
        ).toBe("legacy attachment edits");
      } finally {
        if (timer) clearTimeout(timer);
        await runtime?.stop();
        await releaseWorkspace(second.id);
      }
      await db.query("UPDATE workspaces SET initialized=true WHERE id=$1", [
        w.id,
      ]);
      const saved = await app.inject({
        method: "POST",
        url: `/api/workspaces/${w.id}/attachments/${fid}/save`,
        headers,
        payload: { path: "copied-original.txt" },
      });
      expect(saved.statusCode).toBe(200);
      expect(
        await readFile(
          path.join(workspacePath(w.id), "copied-original.txt"),
          "utf8",
        ),
      ).toBe("ORIGINAL_ATTACHMENT");
    },
    30000,
  );

  afterAll(async () => {
    await app.close();
    await db.end();
    await rm(data, { recursive: true, force: true });
  });
  it("requires auth and matching origin", async () => {
    expect((await app.inject("/api/overview")).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/accounts",
          headers: { ...headers, origin: "https://evil.test" },
          payload: { provider: "codex", name: "x" },
        })
      ).statusCode,
    ).toBe(403);
  });
  it("connects the same GitHub repository from either supported input format", async () => {
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () =>
          new Response(
            JSON.stringify({ name: "partcar", default_branch: "main" }),
            { status: 200 },
          ),
      );
    try {
      for (const repo of [
        "qavitalii/partcar",
        "https://github.com/qavitalii/partcar.git/",
      ]) {
        const response = await app.inject({
          method: "POST",
          url: "/api/projects",
          headers,
          payload: { repo },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().repo).toBe("qavitalii/partcar");
        expect(request.mock.calls.at(-1)?.[0]).toBe(
          "https://api.github.com/repos/qavitalii/partcar",
        );
      }
      const response = await app.inject({
        method: "POST",
        url: "/api/projects",
        headers,
        payload: { repo: "https://evil.example/a/b" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain("owner/repository");
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      request.mockRestore();
    }
  });
  it("keeps project tokens encrypted, separate and out of API responses", async () => {
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () =>
          new Response(
            JSON.stringify({ name: "Private project", default_branch: "main" }),
            { status: 200 },
          ),
      );
    try {
      const projects: { id: string; github_token: string }[] = [];
      for (const [repo, token] of [
        ["owner/one", "test-token-project-one"],
        ["owner/two", "test-token-project-two"],
      ]) {
        const response = await app.inject({
          method: "POST",
          url: "/api/projects",
          headers,
          payload: { repo, token },
        });
        expect(response.statusCode).toBe(200);
        expect(
          (request.mock.calls.at(-1)?.[1]?.headers as any).Authorization,
        ).toBe("Bearer " + token);
        expect(response.body).not.toContain(token);
        expect(response.json().github_token).toBeUndefined();
        expect(response.json().github_configured).toBe(true);
        const row = (
          await db.query("SELECT * FROM projects WHERE id=$1", [
            response.json().id,
          ])
        ).rows[0];
        expect(row.github_token).not.toBe(token);
        expect(projectToken(row)).toBe(token);
        projects.push(row);
      }
      const replacement = "test-token-replacement";
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: "/api/projects/" + projects[0].id,
            headers,
            payload: { token: replacement },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (request.mock.calls.at(-1)?.[1]?.headers as any).Authorization,
      ).toBe("Bearer " + replacement);
      const rows = (
        await db.query("SELECT * FROM projects WHERE id=ANY($1::uuid[])", [
          projects.map((p) => p.id),
        ])
      ).rows;
      expect(projectToken(rows.find((p) => p.id === projects[0].id))).toBe(
        replacement,
      );
      expect(projectToken(rows.find((p) => p.id === projects[1].id))).toBe(
        "test-token-project-two",
      );
      const overview = (await app.inject({ url: "/api/overview", headers }))
        .body;
      for (const p of rows) {
        expect(overview).not.toContain(p.github_token);
        expect(overview).not.toContain(projectToken(p));
      }
      await app.inject({
        method: "PATCH",
        url: "/api/projects/" + projects[0].id,
        headers,
        payload: { token: null },
      });
      expect(
        (
          await db.query("SELECT github_token FROM projects WHERE id=$1", [
            projects[0].id,
          ])
        ).rows[0].github_token,
      ).toBe("");
    } finally {
      request.mockRestore();
    }
  });
  it("migrates legacy access only to existing projects without changing later project tokens", async () => {
    const old = seal("legacy-test-token");
    await db.query(
      "INSERT INTO settings(key,value) VALUES('github_token',$1)",
      [old],
    );
    await db.query("ALTER TABLE projects DROP COLUMN github_token");
    await migrate();
    expect(
      (await db.query("SELECT github_token FROM projects")).rows[0]
        .github_token,
    ).toBe(old);
    const id = randomUUID();
    await db.query(
      "INSERT INTO projects(id,name,repo) VALUES($1,'Public','owner/public')",
      [id],
    );
    await migrate();
    expect(
      (await db.query("SELECT github_token FROM projects WHERE id=$1", [id]))
        .rows[0].github_token,
    ).toBe("");
  });
  it("creates a persistent chat workspace without any Git repository", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/chats",
      headers,
      payload: { title: "No Git", provider: "codex", account_id: account },
    });
    expect(response.statusCode).toBe(200);
    const created = response.json();
    expect(created.project_id).toBeNull();
    await initializeWorkspace(created);
    const folder = path.join(config.data, "workspaces", created.id);
    await expect(access(path.join(folder, ".git"))).rejects.toThrow();
    await writeFile(path.join(folder, "keep.txt"), "persistent");
    await initializeWorkspace(created);
    expect(await readFile(path.join(folder, "keep.txt"), "utf8")).toBe(
      "persistent",
    );
    expect(
      (await app.inject({ url: `/api/chats/${created.id}/diff`, headers }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/chats/${created.id}/git`,
          headers,
          payload: { action: "push", message: "test", client_id: randomUUID() },
        })
      ).statusCode,
    ).toBe(409);
    const message = await app.inject({
      method: "POST",
      url: `/api/chats/${created.id}/messages`,
      headers,
      payload: { content: "Create a file", client_id: randomUUID() },
    });
    expect(message.statusCode).toBe(200);
    expect((await claim())?.chat_id).toBe(created.id);
  });
  it("reports task capacity and resource samples without requiring a live Docker daemon", async () => {
    const info = vi
      .spyOn(docker, "info")
      .mockResolvedValue({ OperatingSystem: "Docker Desktop" } as any);
    try {
      await app.inject({
        method: "POST",
        url: "/api/settings/execution",
        headers,
        payload: { maxConcurrent: 50 },
      });
      const response = await app.inject({ url: "/api/system", headers });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.maxConcurrent).toBe(50);
      expect(body.running).toBe(0);
      expect(body.queued).toBe(0);
      expect(body.resources.cpu.cores).toBeGreaterThan(0);
      expect(Date.parse(body.resources.sampledAt)).toBeGreaterThan(0);
      if (process.platform === "linux") {
        expect(body.resources.scope).toBe("Docker Desktop VM");
        expect(body.resources.disk).toBeNull();
      }
    } finally {
      info.mockRestore();
    }
  });
  it.each(["https://8.8.8.8", "https://[2606:4700:4700::1111]"])(
    "protects production login, sessions and origins at %s",
    async (ipOrigin) => {
      const previous = { origin: config.origin, production: config.production };
      config.origin = ipOrigin;
      config.production = true;
      try {
        const totp = new OTPAuth.TOTP({
          secret: new OTPAuth.Secret({ size: 20 }),
        });
        await db.query(
          "INSERT INTO owner(id,password_hash,totp_secret) VALUES(1,$1,$2)",
          [
            await argon2.hash("correct-long-password"),
            seal(totp.secret.base32),
          ],
        );
        const login = {
          method: "POST" as const,
          url: "/api/login",
          remoteAddress: ipOrigin.includes("[")
            ? "2001:db8::71"
            : "198.51.100.71",
          headers: { origin: ipOrigin },
          payload: { password: "correct-long-password", code: totp.generate() },
        };
        const response = await app.inject(login);
        expect(response.statusCode, response.body).toBe(200);
        const setCookie = String(response.headers["set-cookie"]);
        expect(setCookie).toContain("; Secure");
        expect(setCookie).toContain("; HttpOnly");
        expect(setCookie).toContain("; SameSite=Strict");
        expect(setCookie).not.toMatch(/;\s*Domain=/i);
        const cookie = setCookie.split(";")[0];
        expect(
          (
            await app.inject({
              url: "/api/me",
              headers: { cookie, origin: ipOrigin },
            })
          ).statusCode,
        ).toBe(200);
        expect(
          (
            await app.inject({
              url: "/api/me",
              headers: { cookie: "session=forged", origin: ipOrigin },
            })
          ).statusCode,
        ).toBe(401);
        for (const wrongOrigin of [
          "https://evil.test",
          ipOrigin.replace("https:", "http:"),
          ipOrigin + ":444",
        ]) {
          expect(
            (
              await app.inject({
                url: "/api/me",
                headers: { cookie, origin: wrongOrigin },
              })
            ).statusCode,
          ).toBe(403);
          await expect(
            app.injectWS("/api/events", {
              headers: { cookie, origin: wrongOrigin },
            }),
          ).rejects.toThrow("Unexpected server response: 403");
        }
        expect(
          (
            await app.inject({
              method: "POST",
              url: "/api/logout",
              headers: { cookie },
            })
          ).statusCode,
        ).toBe(403);
        await expect(
          app.injectWS("/api/events", { headers: { cookie } }),
        ).rejects.toThrow("Unexpected server response: 403");
        expect((await app.inject(login)).statusCode).toBe(401);
        expect(
          (
            await app.inject({
              method: "POST",
              url: "/api/logout",
              headers: { cookie, origin: ipOrigin },
            })
          ).statusCode,
        ).toBe(200);
        expect(
          (
            await app.inject({
              url: "/api/me",
              headers: { cookie, origin: ipOrigin },
            })
          ).statusCode,
        ).toBe(401);
      } finally {
        Object.assign(config, previous);
      }
    },
  );

  it("uses password and a non-replayable TOTP", async () => {
    const totp = new OTPAuth.TOTP({ secret: new OTPAuth.Secret({ size: 20 }) });
    await db.query(
      "INSERT INTO owner(id,password_hash,totp_secret) VALUES(1,$1,$2)",
      [await argon2.hash("correct-long-password"), seal(totp.secret.base32)],
    );
    const payload = {
      password: "correct-long-password",
      code: totp.generate(),
    };
    const r = await app.inject({
      method: "POST",
      url: "/api/login",
      headers: { origin },
      payload,
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers["set-cookie"]).toContain("HttpOnly");
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/login",
          headers: { origin },
          payload,
        })
      ).statusCode,
    ).toBe(401);
  });
  it("deduplicates a message and its durable job after reconnection", async () => {
    const payload = {
      content: "Build it",
      client_id: randomUUID(),
      attachment_ids: [],
    };
    const send = () =>
      app.inject({
        method: "POST",
        url: `/api/chats/${chat}/messages`,
        headers,
        payload,
      });
    const [a, b] = await Promise.all([send(), send()]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.json().id).toBe(b.json().id);
    expect((await db.query("SELECT * FROM jobs")).rowCount).toBe(1);
  });
  it("rejects a second active job without storing its message", async () => {
    for (let i = 0; i < 2; i++) {
      const r = await app.inject({
        method: "POST",
        url: `/api/chats/${chat}/messages`,
        headers,
        payload: { content: "work", client_id: randomUUID() },
      });
      expect(r.statusCode).toBe(i ? 409 : 200);
    }
    expect((await db.query("SELECT * FROM messages")).rowCount).toBe(1);
  });
  it("cannot attach another chat’s files", async () => {
    const f = randomUUID();
    const r = await app.inject({
      method: "POST",
      url: `/api/chats/${chat}/messages`,
      headers,
      payload: {
        content: "work",
        client_id: randomUUID(),
        attachment_ids: [f],
      },
    });
    expect(r.statusCode).toBe(400);
    expect((await db.query("SELECT * FROM messages")).rowCount).toBe(0);
  });
  it("uploads a file idempotently and retains it through account handoff", async () => {
    const client = randomUUID(),
      boundary = "test-boundary";
    const payload = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="note.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--${boundary}--\r\n`,
    );
    const send = () =>
      app.inject({
        method: "POST",
        url: `/api/chats/${chat}/attachments?client_id=${client}`,
        headers: {
          ...headers,
          "content-type": "multipart/form-data; boundary=" + boundary,
        },
        payload,
      });
    const a = await send(),
      b = await send();
    expect(a.statusCode).toBe(200);
    expect(a.json().id).toBe(b.json().id);
    const f = a.json();
    await app.inject({
      method: "POST",
      url: `/api/chats/${chat}/messages`,
      headers,
      payload: {
        content: "Read this",
        client_id: randomUUID(),
        attachment_ids: [f.id],
      },
    });
    await db.query("UPDATE jobs SET state='waiting_account'");
    const account2 = randomUUID();
    await db.query(
      "INSERT INTO accounts(id,name,provider,status) VALUES($1,'B','claude','ready')",
      [account2],
    );
    const r = await app.inject({
      method: "POST",
      url: `/api/chats/${chat}/switch`,
      headers,
      payload: { account_id: account2 },
    });
    expect(r.statusCode).toBe(200);
    expect((await db.query("SELECT * FROM attachments")).rowCount).toBe(1);
    expect(
      (await app.inject({ url: "/api/attachments/" + f.id, headers })).body,
    ).toBe("hello");
    expect(
      (await db.query("SELECT * FROM events WHERE type='handoff'")).rowCount,
    ).toBe(1);
  });
  it("enforces file size limits and removes partial uploads", async () => {
    const boundary = "test-boundary";
    const payload = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.txt"\r\nContent-Type: text/plain\r\n\r\n${"a".repeat(2048)}\r\n--${boundary}--\r\n`,
    );
    const r = await app.inject({
      method: "POST",
      url: `/api/chats/${chat}/attachments?client_id=${randomUUID()}`,
      headers: {
        ...headers,
        "content-type": "multipart/form-data; boundary=" + boundary,
      },
      payload,
    });
    expect(r.statusCode).toBe(413);
    expect((await db.query("SELECT * FROM attachments")).rowCount).toBe(0);
  });
  it.each([
    ["codex", "claude"],
    ["claude", "codex"],
  ])(
    "switches %s to %s with a fresh session and preserved context",
    async (from, to) => {
      const other = randomUUID();
      await db.query("UPDATE accounts SET provider=$2 WHERE id=$1", [
        account,
        from,
      ]);
      await db.query(
        "INSERT INTO accounts(id,name,provider,status) VALUES($1,'Other',$2,'ready')",
        [other, to],
      );
      await db.query("INSERT INTO settings(key,value) VALUES($1,$2)", [
        "model_default_" + to,
        JSON.stringify({ model: "target-model", effort: "high" }),
      ]);
      await db.query(
        "UPDATE chats SET provider=$2,model='old-model',effort='low',resolved_model='old-resolved',resolved_effort='low',native_commands='[\"context\"]',session_id='old-session',session_account=$3,mode='plan',summary='Checkpoint: navigation was updated' WHERE id=$1",
        [chat, from, account],
      );
      const reply = randomUUID();
      await db.query(
        "INSERT INTO messages(id,chat_id,role,content) VALUES($1,$2,'assistant','Previous answer')",
        [reply, chat],
      );
      const before = (await db.query("SELECT * FROM chats WHERE id=$1", [chat]))
        .rows[0];
      const response = await app.inject({
        method: "POST",
        url: `/api/chats/${chat}/switch`,
        headers,
        payload: { account_id: other },
      });
      expect(response.statusCode).toBe(200);
      const after = (await db.query("SELECT * FROM chats WHERE id=$1", [chat]))
        .rows[0];
      expect(after).toMatchObject({
        provider: to,
        account_id: other,
        session_id: null,
        session_account: null,
        model: "target-model",
        effort: "high",
        resolved_model: "",
        resolved_effort: "",
        native_commands: [],
        mode: "plan",
        autonomous: false,
        summary: before.summary,
        workspace_id: before.workspace_id,
        branch: before.branch,
      });
      expect(
        (await app.inject({ url: `/api/chats/${chat}`, headers })).json()
          .messages,
      ).toContainEqual(
        expect.objectContaining({
          id: reply,
          provider: from,
          content: "Previous answer",
        }),
      );
      // Returning to the previous provider must not relabel old messages or reuse a native session.
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/chats/${chat}/switch`,
            headers,
            payload: { account_id: account },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await db.query(
            "SELECT provider,model,effort,session_id FROM chats WHERE id=$1",
            [chat],
          )
        ).rows[0],
      ).toEqual({ provider: from, model: "", effort: "", session_id: null });
      expect(
        (await db.query("SELECT provider FROM messages WHERE id=$1", [reply]))
          .rows[0].provider,
      ).toBe(from);
    },
  );
  it("keeps model settings when switching accounts of the same provider and builds missing context", async () => {
    const other = randomUUID();
    await db.query(
      "INSERT INTO accounts(id,name,provider,status) VALUES($1,'Other','codex','ready')",
      [other],
    );
    await db.query(
      "UPDATE chats SET model='chosen-model',effort='high' WHERE id=$1",
      [chat],
    );
    await db.query(
      "INSERT INTO messages(id,chat_id,role,content) VALUES($1,$2,'assistant','Saved progress')",
      [randomUUID(), chat],
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/chats/${chat}/switch`,
          headers,
          payload: { account_id: other },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await db.query("SELECT model,effort,summary FROM chats WHERE id=$1", [
          chat,
        ])
      ).rows[0],
    ).toMatchObject({
      model: "chosen-model",
      effort: "high",
      summary: expect.stringContaining("Saved progress"),
    });
  });
  it.each(["queued", "running", "waiting_approval"])(
    "blocks switching while a task is %s",
    async (state) => {
      const other = randomUUID();
      await db.query(
        "INSERT INTO accounts(id,name,provider,status) VALUES($1,'Other','claude','ready')",
        [other],
      );
      await app.inject({
        method: "POST",
        url: `/api/chats/${chat}/messages`,
        headers,
        payload: { content: "Work", client_id: randomUUID() },
      });
      await db.query("UPDATE jobs SET state=$1", [state]);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/chats/${chat}/switch`,
            headers,
            payload: { account_id: other },
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await db.query("SELECT account_id,provider FROM chats WHERE id=$1", [
            chat,
          ])
        ).rows[0],
      ).toEqual({ account_id: account, provider: "codex" });
    },
  );
  it("does not forward a pending provider-specific command to another agent", async () => {
    const other = randomUUID();
    await db.query(
      "INSERT INTO accounts(id,name,provider,status) VALUES($1,'Other','claude','ready')",
      [other],
    );
    await app.inject({
      method: "POST",
      url: `/api/chats/${chat}/messages`,
      headers,
      payload: { content: "/review", client_id: randomUUID() },
    });
    await db.query("UPDATE jobs SET state='waiting_account'");
    const response = await app.inject({
      method: "POST",
      url: `/api/chats/${chat}/switch`,
      headers,
      payload: { account_id: other },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("Cancel the pending /review");
    expect(
      (await db.query("SELECT provider FROM chats WHERE id=$1", [chat])).rows[0]
        .provider,
    ).toBe("codex");
  });
  it.each(["disconnected", "limited"])(
    "rejects a %s target account",
    async (status) => {
      const other = randomUUID();
      await db.query(
        "INSERT INTO accounts(id,name,provider,status) VALUES($1,'Other','claude',$2)",
        [other, status],
      );
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/chats/${chat}/switch`,
            headers,
            payload: { account_id: other },
          })
        ).statusCode,
      ).toBe(409);
    },
  );
  it("resumes a waiting task on the new provider with context and records the correct author", async () => {
    const other = randomUUID();
    await db.query(
      "INSERT INTO accounts(id,name,provider,status) VALUES($1,'Other','claude','ready')",
      [other],
    );
    await db.query(
      "UPDATE chats SET summary='Previous work: updated navigation',session_id='old-session',session_account=$2 WHERE id=$1",
      [chat, account],
    );
    await app.inject({
      method: "POST",
      url: `/api/chats/${chat}/messages`,
      headers,
      payload: { content: "Continue the change", client_id: randomUUID() },
    });
    await db.query("UPDATE jobs SET state='waiting_account',account_id=$1", [
      account,
    ]);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/chats/${chat}/switch`,
          headers,
          payload: { account_id: other },
        })
      ).statusCode,
    ).toBe(200);
    const job = await claim();
    expect(job).toMatchObject({ account_id: other, provider: "claude" });
    const send = vi.fn();
    let emit!: (event: any) => void | Promise<void>;
    vi.spyOn(gitModule, "initializeWorkspace").mockResolvedValue();
    const launch = vi
      .spyOn(runtimeModule, "launch")
      .mockImplementation(async (_chat, _account, handler) => {
        emit = handler;
        return { id: "switched-runtime", send, stop: async () => {} };
      });
    try {
      await runJob(job);
      expect(launch).toHaveBeenCalledWith(chat, other, expect.any(Function), {
        sessionId: null,
        installPackages: true,
        projectEnv: "read-write",
      });
      expect(send.mock.calls[0][0].input).toMatchObject({
        provider: "claude",
        sessionId: undefined,
        prompt: expect.stringContaining("Previous work: updated navigation"),
      });
      expect(send.mock.calls[0][0].input.prompt).toContain(
        "Continue the change",
      );
      await emit({ type: "packages_installed", packages: ["ffmpeg"] });
      await emit({ type: "delta", text: "Continued with Claude" });
      await emit({ type: "completed" });
      expect(
        (
          await db.query(
            "SELECT provider,content FROM messages WHERE role='assistant' AND chat_id=$1",
            [chat],
          )
        ).rows,
      ).toEqual([{ provider: "claude", content: "Continued with Claude" }]);
      const saved = await app.inject({
        method: "GET",
        url: `/api/chats/${chat}`,
        headers,
      });
      expect(saved.json().events).toContainEqual(
        expect.objectContaining({
          type: "log",
          data: { text: "Debian packages ready for this run: ffmpeg" },
        }),
      );
    } finally {
      vi.restoreAllMocks();
      active.delete(job.id);
    }
  });
  it.each([false, true])(
    "transitions a Claude plan with cancellation=%s",
    async (cancelAfterApproval) => {
      await db.query("UPDATE accounts SET provider='claude' WHERE id=$1", [
        account,
      ]);
      await db.query(
        "UPDATE chats SET provider='claude',autonomous=true WHERE id=$1",
        [chat],
      );
      await app.inject({
        method: "POST",
        url: `/api/chats/${chat}/messages`,
        headers,
        payload: {
          content: "/plan Convert the video",
          client_id: randomUUID(),
        },
      });
      const job = await claim();
      const runners = [vi.fn(), vi.fn()];
      const handlers: ((event: any) => void | Promise<void>)[] = [];
      const stop = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(gitModule, "initializeWorkspace").mockResolvedValue();
      const launch = vi
        .spyOn(runtimeModule, "launch")
        .mockImplementation(async (_chat, _account, handler) => {
          const index = handlers.push(handler) - 1;
          return {
            id: `plan-stage-${index}`,
            send: runners[index],
            stop,
            profileSaved: async () => true,
          };
        });
      try {
        await runJob(job);
        expect(launch).toHaveBeenLastCalledWith(
          chat,
          account,
          expect.any(Function),
          {
            sessionId: null,
            installPackages: false,
            projectEnv: "read-only",
          },
        );
        expect(runners[0].mock.calls[0][0].input.mode).toBe("plan");
        await handlers[0]({
          type: "session",
          id: "existing-claude-plan-session",
        });
        async function approval(allow: boolean) {
          await handlers[0]({
            type: "approval",
            id: randomUUID(),
            description: "Approve the plan and start execution?",
            planExit: true,
            details: "Install ffmpeg and convert the attached video.",
          });
          const plan = (
            await db.query(
              "SELECT id,request_id FROM approvals WHERE job_id=$1 AND kind='plan_exit' AND decision IS NULL",
              [job.id],
            )
          ).rows[0];
          const decision = await app.inject({
            method: "POST",
            url: `/api/approvals/${plan.id}`,
            headers,
            payload: { allow },
          });
          expect(decision.statusCode).toBe(200);
          return plan;
        }
        const denied = await approval(false);
        expect(runners[0]).toHaveBeenLastCalledWith({
          type: "approve",
          id: denied.request_id,
          allow: false,
        });
        const accepted = await approval(true);
        expect(runners[0]).toHaveBeenLastCalledWith({ type: "stop" });
        expect(runners[0]).not.toHaveBeenCalledWith({
          type: "approve",
          id: accepted.request_id,
          allow: true,
        });
        expect(await claim()).toBeNull();
        if (cancelAfterApproval) {
          const result = await app.inject({
            method: "POST",
            url: `/api/chats/${chat}/stop`,
            headers,
          });
          expect(result.statusCode).toBe(200);
        }
        await handlers[0]({ type: "interrupted" });
        expect(stop).toHaveBeenCalledTimes(1);
        const continued = await claim();
        if (cancelAfterApproval) {
          expect(continued).toBeNull();
          expect(
            (await db.query("SELECT state FROM jobs WHERE id=$1", [job.id]))
              .rows[0].state,
          ).toBe("cancelled");
          return;
        }
        expect(continued.id).toBe(job.id);
        await runJob(continued);
        expect(launch).toHaveBeenLastCalledWith(
          chat,
          account,
          expect.any(Function),
          {
            sessionId: "existing-claude-plan-session",
            installPackages: true,
            projectEnv: "read-write",
          },
        );
        expect(runners[1].mock.calls[0][0].input).toMatchObject({
          mode: "default",
          operation: undefined,
          autonomous: false,
          prompt: expect.stringContaining(
            "Install ffmpeg and convert the attached video.",
          ),
        });
        expect(runners[1].mock.calls[0][0].input.prompt).not.toContain("/plan");
        await handlers[1]({ type: "completed", result: "Video converted." });
        expect(
          (await db.query("SELECT state FROM jobs WHERE id=$1", [job.id]))
            .rows[0].state,
        ).toBe("completed");
      } finally {
        vi.restoreAllMocks();
        active.delete(job.id);
      }
    },
  );
  it("respects the default capacity and never shares one account concurrently", async () => {
    const project = (
      await db.query("SELECT project_id FROM chats WHERE id=$1", [chat])
    ).rows[0].project_id;
    for (let i = 0; i < 5; i++) {
      const aid = i < 2 ? account : randomUUID();
      if (i >= 2)
        await db.query(
          "INSERT INTO accounts(id,provider,name,status) VALUES($1,'codex','Parallel','ready')",
          [aid],
        );
      const cid = i === 0 ? chat : randomUUID();
      if (i !== 0) {
        await createWorkspace(project, "saved", "Parallel", db, cid);
        await db.query(
          "INSERT INTO chats(id,project_id,workspace_id,title,provider,account_id,branch) VALUES($1,$2,$1,'Parallel','codex',$3,$4)",
          [cid, project, aid, "workspace/" + cid],
        );
      }
      await app.inject({
        method: "POST",
        url: `/api/chats/${cid}/messages`,
        headers,
        payload: { content: "parallel", client_id: randomUUID() },
      });
    }
    const claims = await Promise.all(Array.from({ length: 5 }, () => claim()));
    expect(claims.filter(Boolean)).toHaveLength(3);
    expect(new Set(claims.filter(Boolean).map((j) => j.account_id)).size).toBe(
      3,
    );
  });
  it("persists capacity 50, claims above three, and lowers capacity without stopping running work", async () => {
    config.maxConcurrent = 50;
    expect(await concurrentTasks()).toBe(50);
    const response = await app.inject({
      method: "POST",
      url: "/api/settings/execution",
      headers,
      payload: { maxConcurrent: 50 },
    });
    expect(response.statusCode).toBe(200);
    expect(await concurrentTasks()).toBe(50);
    config.maxConcurrent = 1;
    expect(await concurrentTasks()).toBe(50); // Persistent setting survives process defaults.
    const project = (
      await db.query("SELECT project_id FROM chats WHERE id=$1", [chat])
    ).rows[0].project_id;
    for (let i = 0; i < 52; i++) {
      const aid = i < 2 ? account : randomUUID(),
        cid = randomUUID(),
        mid = randomUUID();
      if (i >= 2)
        await db.query(
          "INSERT INTO accounts(id,provider,name,status) VALUES($1,'codex','Capacity test','ready')",
          [aid],
        );
      await createWorkspace(project, "saved", "Capacity test", db, cid);
      await db.query(
        "INSERT INTO chats(id,project_id,workspace_id,title,provider,account_id,branch) VALUES($1,$2,$1,'Capacity test','codex',$3,$4)",
        [cid, project, aid, "workspace/" + cid],
      );
      await db.query(
        "INSERT INTO messages(id,chat_id,role,content) VALUES($1,$2,'user','test')",
        [mid, cid],
      );
      await db.query(
        "INSERT INTO jobs(id,chat_id,message_id) VALUES($1,$2,$3)",
        [randomUUID(), cid, mid],
      );
    }
    const claimed = (
      await Promise.all(Array.from({ length: 52 }, () => claim()))
    ).filter(Boolean);
    expect(claimed).toHaveLength(50);
    expect(new Set(claimed.map((j) => j.account_id)).size).toBe(50);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/settings/execution",
          headers,
          payload: { maxConcurrent: 2 },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await db.query("SELECT count(*)::int n FROM jobs WHERE state='running'"))
        .rows[0].n,
    ).toBe(50);
    expect(await claim()).toBeNull();
    await db.query(
      "UPDATE jobs SET state='completed' WHERE state='running' AND id<>$1",
      [claimed[0].id],
    );
    expect(await claim()).toBeTruthy();
    expect(await claim()).toBeNull();
  });
  it("validates capacity and requires the owner session", async () => {
    for (const maxConcurrent of [0, -1, 1.5, "50", Number.MAX_SAFE_INTEGER + 1])
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/settings/execution",
            headers,
            payload: { maxConcurrent },
          })
        ).statusCode,
      ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/settings/execution",
          headers: { origin },
          payload: { maxConcurrent: 50 },
        })
      ).statusCode,
    ).toBe(401);
  });
  it("holds queued work while a terminal owns the workspace", async () => {
    await acquireWorkspace(chat, "terminal");
    await app.inject({
      method: "POST",
      url: `/api/chats/${chat}/messages`,
      headers,
      payload: { content: "work", client_id: randomUUID() },
    });
    expect(await claim()).toBeNull();
    await releaseWorkspace(chat);
    expect(await claim()).toBeTruthy();
  });
  it("persists cancellation even before the runner has started", async () => {
    await app.inject({
      method: "POST",
      url: `/api/chats/${chat}/messages`,
      headers,
      payload: { content: "work", client_id: randomUUID() },
    });
    const j = await claim();
    expect(j).toBeTruthy();
    await app.inject({
      method: "POST",
      url: `/api/chats/${chat}/stop`,
      headers,
      payload: {},
    });
    expect(
      (await db.query("SELECT cancel_requested FROM jobs WHERE id=$1", [j.id]))
        .rows[0].cancel_requested,
    ).toBe(true);
  });
  it("answers each approval once and sends the decision to the runner", async () => {
    await app.inject({
      method: "POST",
      url: `/api/chats/${chat}/messages`,
      headers,
      payload: { content: "work", client_id: randomUUID() },
    });
    const j = await claim(),
      id = randomUUID(),
      decisions: any[] = [];
    await db.query("UPDATE jobs SET state='waiting_approval' WHERE id=$1", [
      j.id,
    ]);
    await db.query(
      "INSERT INTO approvals(id,job_id,request_id,description) VALUES($1,$2,$3,$4)",
      [id, j.id, "request-1", "Run a command"],
    );
    active.set(j.id, {
      id: "test",
      send: (c) => decisions.push(c),
      stop: async () => {},
    });
    try {
      const a = await app.inject({
        method: "POST",
        url: "/api/approvals/" + id,
        headers,
        payload: { allow: false },
      });
      expect(a.statusCode).toBe(200);
      expect(decisions).toEqual([
        { type: "approve", id: "request-1", allow: false },
      ]);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/approvals/" + id,
            headers,
            payload: { allow: true },
          })
        ).statusCode,
      ).toBe(409);
    } finally {
      active.delete(j.id);
    }
  });
  it("replays persisted events from the last cursor on websocket reconnect", async () => {
    const first = await event(chat, null, "log", { text: "first" });
    const second = await event(chat, null, "log", { text: "second" });
    const socket = await app.injectWS(
      `/api/events?chat_id=${chat}&after=${first.id}`,
      { headers },
    );
    const received = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Replay timed out")),
        3000,
      );
      socket.on("message", (data) => {
        clearTimeout(timer);
        resolve(JSON.parse(data.toString()));
      });
    });
    expect(received.id).toBe(second.id);
    socket.close();
  });
  it.skipIf(process.env.DOCKER_TESTS !== "1")(
    "gives each real run a fresh profile that keeps only sign-in and this chat's sessions",
    async () => {
      const session = randomUUID();
      const store = path.join(data, "account-auth", account);
      await mkdir(path.join(store, ".codex"), { recursive: true });
      await writeFile(
        path.join(store, ".codex", "auth.json"),
        JSON.stringify({ tokens: { access_token: "seeded" } }),
      );
      const shell = async (chatId: string, command: string) => {
        let output = "";
        const run = await launch(chatId, account, (e) => {
          if (e.type === "terminal") output += e.data;
        });
        try {
          // The quotes keep the terminal's echo of the command from matching.
          run.send({
            type: "terminal",
            data: command + "; echo; echo DO''NE\r",
          });
          await vi.waitFor(() => expect(output).toMatch(/^DONE\r?$/m), {
            timeout: 15_000,
          });
        } finally {
          await run.stop();
        }
        return output;
      };
      const first = await shell(
        chat,
        [
          "cat /profile/.codex/auth.json",
          "echo planted > /profile/.codex/config.toml",
          "mkdir -p /profile/.claude/projects/-workspace/memory",
          "echo hook > /profile/.claude/settings.json",
          "echo memo > /profile/.claude/projects/-workspace/memory/MEMORY.md",
          `echo history > /profile/.claude/projects/-workspace/${session}.jsonl`,
          "echo planted > /profile/.bashrc",
          `printf '{"tokens":{"access_token":"refreshed"}}' > /profile/.codex/auth.json`,
        ].join(" && "),
      );
      expect(first).toContain('"seeded"');
      const check = [
        "cat /profile/.codex/auth.json; echo",
        "for f in .codex/config.toml .claude/settings.json .bashrc .claude/projects/-workspace/memory; do test -e /profile/$f && echo FOUND:$f; done",
        `cat /profile/.claude/projects/-workspace/${session}.jsonl 2>/dev/null`,
        "touch /profile/.write-check && echo WRITA''BLE",
      ].join("; ");
      const second = await shell(chat, check);
      expect(second).toContain('"refreshed"');
      expect(second).not.toMatch(/^FOUND:\./m);
      expect(second).toMatch(/^history\r?$/m);
      expect(second).toMatch(/^WRITABLE\r?$/m);
      const other = randomUUID();
      await createWorkspace(null, "personal", "Other", db, other);
      await db.query(
        "INSERT INTO chats(id,workspace_id,title,provider,account_id,branch) VALUES($1,$1,'Other','codex',$2,'main')",
        [other, account],
      );
      const third = await shell(other, check);
      expect(third).toContain('"refreshed"');
      expect(third).not.toMatch(/^history\r?$/m);
      expect(third).not.toMatch(/^FOUND:\./m);
      expect(await readdir(path.join(data, "run-profiles"))).toEqual([]);
    },
    60_000,
  );
  it.skipIf(process.env.DOCKER_TESTS !== "1")(
    "mounts one project tool directory across run modes and working copies",
    async () => {
      const { project_id: project } = await chatWorkspace(chat);
      const otherProject = randomUUID();
      await db.query(
        "INSERT INTO projects(id,name,repo) VALUES($1,'Other','test/other')",
        [otherProject],
      );
      async function addChat(projectId: string | null, kind: "copy" | "main") {
        const folder = await createWorkspace(projectId, kind, kind, db);
        await db.query(
          "INSERT INTO chats(id,project_id,workspace_id,title,provider,branch) VALUES($1,$2,$1,$3,'codex',$4)",
          [folder.id, projectId, kind, folder.branch],
        );
        return folder.id;
      }

      const copy = await addChat(project, "copy");
      const other = await addChat(otherProject, "main");
      async function shell(
        chatId: string,
        mode: "read-only" | "read-write",
        command: string,
      ) {
        const run = await launch(chatId, account, () => {}, {
          projectEnv: mode,
          installPackages: mode === "read-write",
        });
        try {
          const container = docker.getContainer(run.id);
          const { Mounts } = await container.inspect();
          const exec = await container.exec({
            User: "1000:1000",
            Cmd: ["/bin/bash", "-lec", command],
            AttachStdout: true,
            AttachStderr: true,
            Tty: true,
          });
          const stream = await exec.start({ hijack: true, stdin: false });
          let output = "";
          for await (const chunk of stream) output += chunk.toString();
          expect((await exec.inspect()).ExitCode, output).toBe(0);
          return Mounts.find((mount) => mount.Destination === "/env");
        } finally {
          await run.stop();
        }
      }

      const first = await shell(
        chat,
        "read-write",
        String.raw`
          test "$PATH" = "$WORKSPACE_PROJECT_TOOL_PATH"
          test "$NPM_CONFIG_PREFIX" = /env/npm-global
          mkdir -p /env/bin
          printf '#!/bin/sh\nprintf "runner marker"\n' > /env/bin/workspace-env-probe
          chmod +x /env/bin/workspace-env-probe
        `,
      );
      expect(first).toMatchObject({ Type: "bind", RW: true });
      const plan = await shell(
        copy,
        "read-only",
        'test "$(workspace-env-probe)" = "runner marker" && ! touch /env/plan-probe',
      );
      expect(plan).toMatchObject({ Source: first?.Source, RW: false });
      const separate = await shell(
        other,
        "read-only",
        "! command -v workspace-env-probe",
      );
      expect(separate).toMatchObject({ Type: "bind", RW: false });
      expect(separate?.Source).not.toBe(first?.Source);
      expect(
        await readFile(
          path.join(
            data,
            "project-env",
            project!,
            "bin",
            "workspace-env-probe",
          ),
          "utf8",
        ),
      ).toContain("runner marker");
    },
    60_000,
  );
  it("validates and persists the project environment limit", async () => {
    const url = "/api/settings/environment";
    const system = async () =>
      (await app.inject({ url: "/api/system", headers })).json();
    expect((await system()).projectEnvLimitGib).toBe(8);
    const save = (projectEnvLimitGib: unknown) =>
      app.inject({
        method: "POST",
        url,
        headers,
        payload: { projectEnvLimitGib },
      });
    for (const invalid of [0, -1, "8", null, Number.MAX_SAFE_INTEGER])
      expect((await save(invalid)).statusCode).toBe(400);
    const updated = await save(0.5);
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({ projectEnvLimitGib: 0.5 });
    config.projectEnvLimitGib = 4;
    expect((await system()).projectEnvLimitGib).toBe(0.5);
    expect(
      await app.inject({
        method: "POST",
        url,
        headers: { origin },
        payload: { projectEnvLimitGib: 8 },
      }),
    ).toMatchObject({ statusCode: 401 });
  });
  // These scenarios make several requests after the shared test client has
  // exercised most of the API. Give them a separate rate-limit bucket.
  function projectEnvironmentRequest(options: InjectOptions) {
    return app.inject({ ...options, remoteAddress: "192.0.2.41" });
  }

  it("reports project tool usage and clears only an idle project's tool directory", async () => {
    const project = (await chatWorkspace(chat)).project_id!;
    const otherProject = randomUUID();
    await db.query(
      "INSERT INTO projects(id,name,repo) VALUES($1,'Another project','')",
      [otherProject],
    );
    const env = path.join(data, "project-env", project);
    const otherEnv = path.join(data, "project-env", otherProject);
    await mkdir(env, { recursive: true });
    await mkdir(otherEnv, { recursive: true });
    await writeFile(path.join(env, "tool"), "Installed tool");
    await writeFile(path.join(otherEnv, "tool"), "Other project's tool");
    await symlink(otherEnv, path.join(env, "other-env"));
    await db.query(
      "UPDATE projects SET env_size_bytes=$2,env_measured_at=now() WHERE id=$1",
      [project, 9 * 1024 ** 3],
    );

    const url = "/api/projects/" + project.toUpperCase() + "/environment";
    const read = async () =>
      (await projectEnvironmentRequest({ url, headers })).json();
    const clear = () =>
      projectEnvironmentRequest({
        method: "POST",
        url: url + "/clear",
        headers,
      });
    expect(await read()).toEqual({
      usedBytes: 9 * 1024 ** 3,
      limitBytes: 8 * 1024 ** 3,
      limitGib: 8,
      busy: false,
      state: "over-budget",
    });
    expect(
      (
        await projectEnvironmentRequest({
          url: "/api/projects/" + randomUUID() + "/environment",
          headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await projectEnvironmentRequest({
          method: "POST",
          url: url + "/clear",
          headers: { origin },
        })
      ).statusCode,
    ).toBe(401);

    const message = randomUUID();
    await db.query(
      "INSERT INTO messages(id,chat_id,role,content) VALUES($1,$2,'user','Pending work')",
      [message, chat],
    );
    const job = randomUUID();
    await db.query(
      "INSERT INTO jobs(id,chat_id,message_id,account_id,state) VALUES($1,$2,$3,$4,'waiting_approval')",
      [job, chat, message, account],
    );
    expect(await read()).toMatchObject({ busy: true });
    const conflict = await clear();
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toMatch(
      /Stop active tasks and close open terminals/,
    );
    await db.query("DELETE FROM jobs WHERE id=$1", [job]);

    const copy = await createWorkspace(project, "copy", "Review copy", db);
    await acquireFolder(copy.id, "terminal");
    expect(await read()).toMatchObject({ busy: true });
    expect((await clear()).statusCode).toBe(409);
    expect(await readFile(path.join(env, "tool"), "utf8")).toBe(
      "Installed tool",
    );
    await releaseFolder(copy.id);

    const otherFolder = await createWorkspace(
      otherProject,
      "main",
      "Other project",
      db,
    );
    await acquireFolder(otherFolder.id, "terminal");
    const containers = vi
      .spyOn(docker, "listContainers")
      .mockResolvedValueOnce([
        {
          Labels: { "ai.workspace.chat": chat },
          Mounts: [{ Type: "bind", Source: env, Destination: "/env" }],
        },
      ] as unknown as Awaited<ReturnType<typeof docker.listContainers>>)
      .mockResolvedValue([]);
    try {
      // A launched runner can still hold the mount while its failed start is stopping.
      expect((await clear()).statusCode).toBe(409);
      expect(await readFile(path.join(env, "tool"), "utf8")).toBe(
        "Installed tool",
      );
      await db.query(`
        CREATE FUNCTION reject_project_env_update() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN RAISE EXCEPTION 'Test error updating project tool usage'; END; $$;
        CREATE TRIGGER reject_project_env_update
        BEFORE UPDATE OF env_measured_at ON projects FOR EACH ROW
        EXECUTE FUNCTION reject_project_env_update();
      `);
      try {
        expect((await clear()).statusCode).toBe(500);
        expect(await readFile(path.join(env, "tool"), "utf8")).toBe(
          "Installed tool",
        );
      } finally {
        await db.query(
          "DROP TRIGGER reject_project_env_update ON projects; DROP FUNCTION reject_project_env_update()",
        );
      }
      const result = await clear();
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({
        usedBytes: 0,
        busy: false,
        state: "ready",
      });
      expect(await read()).toEqual(result.json());
      expect((await clear()).statusCode).toBe(200);
    } finally {
      containers.mockRestore();
    }
    await expect(access(env)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(otherEnv, "tool"), "utf8")).toBe(
      "Other project's tool",
    );
    await releaseFolder(otherFolder.id);
  });
  it.skipIf(process.env.DOCKER_TESTS !== "1")(
    "remeasures before allowing project tool writes and warns in the terminal over budget",
    async () => {
      const { project_id: project } = await chatWorkspace(chat);
      const url = "/api/projects/" + project + "/environment";
      await db.query("UPDATE workspaces SET initialized=true WHERE id=$1", [
        chat,
      ]);
      const limit = 0.0001;
      expect(
        (
          await projectEnvironmentRequest({
            method: "POST",
            url: "/api/settings/environment",
            headers,
            payload: { projectEnvLimitGib: limit },
          })
        ).statusCode,
      ).toBe(200);
      const initial = await launch(chat, account, () => {}, {
        projectEnv: "read-write",
      });
      try {
        const { Mounts } = await docker.getContainer(initial.id).inspect();
        expect(Mounts).toContainEqual(
          expect.objectContaining({ Destination: "/env", RW: true }),
        );
        expect(initial.projectEnvWarning).toBeUndefined();
      } finally {
        await initial.stop();
      }
      const cached = await measureProjectEnv(project!);
      expect(cached).toBeLessThan(100_000);
      const payload = path.join(
        data,
        "project-env",
        project!,
        "budget-fixture",
      );
      await writeFile(payload, randomBytes(512 * 1024));
      expect(await measureProjectEnv(project!)).toBe(cached);

      const socket = await openTerminal();
      let output = "";
      socket.on("message", (raw) => {
        const event = JSON.parse(raw.toString());
        if (event.type === "terminal") output += event.data;
      });
      try {
        await vi.waitFor(
          () =>
            expect(output).toContain(
              `Project tools exceed the ${limit} GiB limit`,
            ),
          { timeout: 15000 },
        );
        await vi.waitFor(() => expect(output).toMatch(/\$ /), {
          timeout: 15000,
        });
        const blocked = await projectEnvironmentRequest({
          method: "POST",
          url: url + "/clear",
          headers,
        });
        expect(blocked.statusCode).toBe(409);
        socket.send(
          JSON.stringify({
            type: "terminal",
            data: "test -r /env/budget-fixture && ! touch /env/blocked && printf '\\nBUDGET_''READONLY\\n'\r",
          }),
        );
        await vi.waitFor(
          () => expect(output).toMatch(/^BUDGET_READONLY\r?$/m),
          { timeout: 15000 },
        );
        expect(await measureProjectEnv(project!)).toBeGreaterThanOrEqual(
          512 * 1024,
        );
      } finally {
        socket.close();
        await vi.waitFor(
          async () => {
            expect(
              (
                await db.query(
                  "SELECT 1 FROM workspace_leases WHERE chat_id=$1",
                  [chat],
                )
              ).rowCount,
            ).toBe(0);
          },
          { timeout: 15000 },
        );
      }
      await rm(payload);
      const after = await launch(chat, account, () => {}, {
        projectEnv: "read-write",
      });
      try {
        expect(after.projectEnvWarning).toBeUndefined();
        const { Mounts } = await docker.getContainer(after.id).inspect();
        expect(Mounts).toContainEqual(
          expect.objectContaining({ Destination: "/env", RW: true }),
        );
      } finally {
        await after.stop();
      }
      await writeFile(payload, randomBytes(512 * 1024));
      expect(
        (await projectEnvironmentRequest({ url, headers })).json().state,
      ).toBe("ready");
      const refreshed = await projectEnvironmentRequest({
        url: url + "?refresh=1",
        headers,
      });
      expect(refreshed.json()).toMatchObject({ state: "over-budget" });
      expect(refreshed.json().usedBytes).toBeGreaterThanOrEqual(512 * 1024);
      const cleared = await projectEnvironmentRequest({
        method: "POST",
        url: url + "/clear",
        headers,
      });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json()).toMatchObject({ usedBytes: 0, state: "ready" });
      await expect(access(payload)).rejects.toMatchObject({ code: "ENOENT" });
    },
    60_000,
  );
  it.skipIf(process.env.DOCKER_TESTS !== "1")(
    "uses an agent-installed tool from the project terminal without agent credentials",
    async () => {
      const { project_id: project } = await chatWorkspace(chat);
      const copy = await createWorkspace(project, "copy", "Terminal copy", db);
      await db.query("UPDATE workspaces SET initialized=true WHERE id=$1", [
        copy.id,
      ]);
      await db.query(
        "INSERT INTO chats(id,project_id,workspace_id,title,provider,account_id,branch,mode) VALUES($1,$2,$1,'Terminal copy','codex',$3,$4,'plan')",
        [copy.id, project, account, copy.branch],
      );
      await db.query("UPDATE projects SET github_token=$2 WHERE id=$1", [
        project,
        seal("terminal-test-github-token"),
      ]);
      const profile = path.join(data, "account-auth", account, ".codex");
      await mkdir(profile, { recursive: true });
      await writeFile(
        path.join(profile, "auth.json"),
        JSON.stringify({ tokens: { access_token: "terminal-test-account" } }),
      );

      const agent = await launch(chat, account, () => {}, {
        projectEnv: "read-write",
      });
      try {
        const exec = await docker.getContainer(agent.id).exec({
          User: "1000:1000",
          Cmd: [
            "/bin/bash",
            "-ec",
            String.raw`
              test -f /profile/.codex/auth.json
              mkdir /tmp/package
              printf '%s\n' '{"name":"workspace-terminal-fixture","version":"1.0.0","bin":{"workspace-terminal-fixture":"fixture.sh"}}' > /tmp/package/package.json
              printf '#!/bin/sh\nprintf "project tool ready"\n' > /tmp/package/fixture.sh
              chmod +x /tmp/package/fixture.sh
              tar -czf /tmp/workspace-terminal-fixture.tgz -C /tmp package
              npm install --global --offline --no-audit --no-fund /tmp/workspace-terminal-fixture.tgz
            `,
          ],
          AttachStdout: true,
          AttachStderr: true,
          Tty: true,
        });
        const stream = await exec.start({ hijack: true, stdin: false });
        let output = "";
        for await (const chunk of stream) output += chunk.toString();
        expect((await exec.inspect()).ExitCode, output).toBe(0);
      } finally {
        await agent.stop();
      }

      const socket = await openTerminal(copy.id);
      let output = "";
      socket.on("message", (raw) => {
        const event = JSON.parse(raw.toString());
        if (event.type === "terminal") output += event.data;
      });
      try {
        await vi.waitFor(() => expect(output).not.toBe(""), { timeout: 15000 });
        const command = [
          ...Object.entries(projectToolEnvironment).map(
            ([key, value]) => 'test "$' + key + '" = "' + value + '"',
          ),
          'test "$PATH" = "$WORKSPACE_PROJECT_TOOL_PATH"',
          'test "$(workspace-terminal-fixture)" = "project tool ready"',
          'test "$HOME" = /tmp',
          "test ! -e /profile/.codex/auth.json",
          'test -z "${CODEX_HOME+x}${CLAUDE_CONFIG_DIR+x}"',
          'test -z "${WORKSPACE_GIT_TOKEN+x}${GITHUB_TOKEN+x}${GH_TOKEN+x}${GIT_ASKPASS+x}"',
          'printf "terminal wrote here" > /env/terminal-proof',
          "printf '\\nPROJECT_TERMINAL_''CHECK_PASSED\\n'",
        ].join(" && ");
        socket.send(JSON.stringify({ type: "terminal", data: command + "\r" }));
        await vi.waitFor(
          () => expect(output).toMatch(/^PROJECT_TERMINAL_CHECK_PASSED\r?$/m),
          { timeout: 15000 },
        );
        expect(
          await readFile(
            path.join(data, "project-env", project!, "terminal-proof"),
            "utf8",
          ),
        ).toBe("terminal wrote here");
      } finally {
        socket.close();
        await vi.waitFor(
          async () =>
            expect(
              (
                await db.query(
                  "SELECT 1 FROM workspace_leases WHERE chat_id=$1",
                  [copy.id],
                )
              ).rowCount,
            ).toBe(0),
          { timeout: 15000 },
        );
      }
    },
    60_000,
  );
  it.skipIf(process.env.DOCKER_TESTS !== "1")(
    "installs a Debian package for one task while keeping the runner unprivileged",
    async () => {
      const baseTools = [
        "gcc",
        "g++",
        "make",
        "pkg-config",
        "sqlite3",
        "psql",
        "mysql",
        "rsync",
        "zip",
        "xz",
        "file",
        "less",
        "tree",
      ];
      async function execute(command: string, installed?: string) {
        let output = "";
        const packages: string[] = [];
        const run = await launch(
          chat,
          account,
          (event) => {
            if (event.type === "terminal") output += event.data;
            if (event.type === "packages_installed")
              packages.push(...event.packages);
          },
          { installPackages: true },
        );
        try {
          const { HostConfig: host } = await docker
            .getContainer(run.id)
            .inspect();
          expect(host).toMatchObject({
            Memory: 2 * 1024 ** 3,
            NanoCpus: 2e9,
            PidsLimit: 256,
            CapDrop: ["ALL"],
            SecurityOpt: ["no-new-privileges:true"],
            NetworkMode: "bridge",
            AutoRemove: true,
          });
          expect(host.Privileged).toBe(false);
          expect(host.CapAdd).not.toContain("SYS_ADMIN");
          expect(host.CapAdd).not.toContain("NET_RAW");
          run.send({
            type: "terminal",
            data: `( ${command} ); rc=$?; echo; echo WORKSPACE_PACKAGE_EXIT_''$rc\r`,
          });
          await vi.waitFor(
            () => expect(output).toMatch(/^WORKSPACE_PACKAGE_EXIT_\d+\r?$/m),
            {
              timeout: 150_000,
            },
          );
          expect(output, "Package runner output").toMatch(
            /^WORKSPACE_PACKAGE_EXIT_0\r?$/m,
          );
          if (installed)
            await vi.waitFor(() => expect(packages).toContain(installed));
          return { output, packages };
        } finally {
          await run.stop();
        }
      }

      const mcpInstall = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "install", arguments: { packages: ["g++"] } },
      });
      const mcpClient = `
        const { spawn } = require("node:child_process");
        const { createInterface } = require("node:readline");
        const server = spawn(process.execPath, ["/app/dist/node/runner/package-tools.js"], { stdio: ["pipe", "pipe", "inherit"] });
        createInterface({ input: server.stdout }).once("line", (line) => {
          console.log(line);
          server.stdin.end();
        });
        server.stdin.write(process.argv[1] + "\\n");
      `.replace(/\s+/g, " ");
      const first = await execute(
        [
          `for tool in ${baseTools.join(" ")}; do "$tool" --version >/dev/null || exit 1; done`,
          'test "$(id -u):$(id -g)" = 1000:1000',
          "awk '/^Cap(Inh|Prm|Eff|Bnd|Amb):/ && $2 != \"0000000000000000\" {bad=1} /^NoNewPrivs:/ && $2 == 1 {nnp=1} END {exit (bad || !nnp)}' /proc/self/status",
          "test ! -S /var/run/docker.sock",
          "! command -v ffmpeg",
          "for arg in --reinstall https://example.invalid/file.deb ./file.deb bash=1 'tree; echo invalid'; do if workspace-install \"$arg\"; then exit 1; fi; done",
          "! workspace-install tree-",
          "workspace-install ffmpeg",
          "ffmpeg -version | head -n 1",
          `node -e '${mcpClient}' '${mcpInstall}' | tee /dev/stderr | grep -Fq '"isError":false'`,
          'test "$(command -v sudo)" = /usr/local/bin/sudo',
          "if sudo id; then exit 1; fi",
          "sudo -n apt update",
          "sudo apt-get install -y jq",
          "! command -v hello",
          "sudo -- sh -c 'apt-get update&& apt-get install -y --no-install-recommends hello'",
          "hello",
          'test "$(id -u):$(id -g)" = 1000:1000',
          'touch /workspace/package-test && test "$(stat -c %u /workspace/package-test)" = 1000',
          "echo PACKAGE_CHECKS_PASSED",
        ].join(" && "),
        "hello",
      );
      expect(first.output).toMatch(/^ffmpeg version /m);
      expect(first.output).toMatch(/^Workspace sudo supports only /m);
      expect(first.output).toMatch(/^Hello, world!\r?$/m);
      expect(first.output).toMatch(/^PACKAGE_CHECKS_PASSED\r?$/m);
      expect(first.packages).toEqual(["ffmpeg", "g++", "jq", "hello"]);

      const next = await execute(
        "test -f /workspace/package-test && ! command -v ffmpeg && echo CLEAN_NEXT_RUN",
      );
      expect(next.output).toMatch(/^CLEAN_NEXT_RUN\r?$/m);
      expect(next.packages).toEqual([]);
    },
    190_000,
  );
  it("removes an account and local credentials while keeping chats, files and history", async () => {
    await mkdir(path.join(data, "profiles", account), { recursive: true });
    await writeFile(
      path.join(data, "profiles", account, "auth"),
      "test credentials",
    );
    for (const dir of ["account-auth", "account-sessions"]) {
      await mkdir(path.join(data, dir, account, ".claude"), {
        recursive: true,
      });
      await writeFile(path.join(data, dir, account, ".claude", "f"), "x");
    }
    await mkdir(workspacePath(chat), { recursive: true });
    await writeFile(path.join(workspacePath(chat), "kept.txt"), "keep");
    await db.query(
      "UPDATE chats SET session_id='old',session_account=$1 WHERE id=$2",
      [account, chat],
    );
    const wrong = await app.inject({
      method: "DELETE",
      url: `/api/accounts/${account}`,
      headers,
      payload: { name: "wrong" },
    });
    expect(wrong.statusCode).toBe(400);
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/accounts/${account}`,
      headers,
      payload: { name: "A" },
    });
    expect(removed.statusCode).toBe(200);
    expect(
      (await db.query("SELECT * FROM accounts WHERE id=$1", [account]))
        .rowCount,
    ).toBe(0);
    const c = (await db.query("SELECT * FROM chats WHERE id=$1", [chat]))
      .rows[0];
    expect(c.account_id).toBeNull();
    expect(c.session_id).toBeNull();
    expect(
      await readFile(path.join(workspacePath(chat), "kept.txt"), "utf8"),
    ).toBe("keep");
    for (const dir of ["profiles", "account-auth", "account-sessions"])
      await expect(access(path.join(data, dir, account))).rejects.toThrow();
  });
  it("blocks account removal during sign-in, inspections and queued work", async () => {
    for (const status of ["authenticating", "inspecting", "disconnecting"]) {
      await db.query("UPDATE accounts SET status=$2 WHERE id=$1", [
        account,
        status,
      ]);
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: `/api/accounts/${account}`,
            headers,
            payload: { name: "A" },
          })
        ).statusCode,
      ).toBe(409);
    }
    await db.query("UPDATE accounts SET status='ready' WHERE id=$1", [account]);
    await app.inject({
      method: "POST",
      url: `/api/chats/${chat}/messages`,
      headers,
      payload: {
        content: "queued",
        client_id: randomUUID(),
        attachment_ids: [],
      },
    });
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/accounts/${account}`,
          headers,
          payload: { name: "A" },
        })
      ).statusCode,
    ).toBe(409);
  });
  it("protects main and deletes a saved folder with linked chats and originals only after confirmation", async () => {
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/workspaces/${chat}`,
          headers,
          payload: { name: "Main folder" },
        })
      ).statusCode,
    ).toBe(409);
    await db.query(
      "UPDATE workspaces SET kind='saved',name='Old folder' WHERE id=$1",
      [chat],
    );
    await mkdir(workspacePath(chat), { recursive: true });
    await writeFile(path.join(workspacePath(chat), "file"), "old");
    const staging = workspacePath(chat) + ".initializing",
      original = path.join(data, "uploads", randomUUID() + "-original.txt"),
      shared = path.join(data, "shared", randomUUID());
    await mkdir(staging, { recursive: true });
    await writeFile(path.join(staging, "partial"), "partial");
    await mkdir(path.dirname(original), { recursive: true });
    await writeFile(original, "original");
    await mkdir(shared, { recursive: true });
    await writeFile(path.join(shared, "external.txt"), "preserve");
    await (
      await import("node:fs/promises")
    ).symlink(shared, path.join(workspacePath(chat), "external-link"));
    await db.query(
      "INSERT INTO attachments(id,chat_id,workspace_id,name,mime,size,storage_name,client_id) VALUES($1,$2,$2,'original.txt','text/plain',8,$3,$4)",
      [randomUUID(), chat, path.basename(original), randomUUID()],
    );
    const info = await app.inject({
      url: `/api/workspaces/${chat}/deletion`,
      headers,
    });
    expect(info.json().chats).toHaveLength(1);
    expect(info.json().attachments).toBe(1);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/workspaces/${chat}`,
          headers,
          payload: { name: "wrong" },
        })
      ).statusCode,
    ).toBe(409);
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/workspaces/${chat}`,
      headers,
      payload: { name: "Old folder" },
    });
    expect(deleted.json()).toEqual({ ok: true, cleanupPending: false });
    expect(
      (await db.query("SELECT id FROM chats WHERE id=$1", [chat])).rowCount,
    ).toBe(0);
    await expect(access(workspacePath(chat))).rejects.toThrow();
    await expect(access(staging)).rejects.toThrow();
    await expect(access(original)).rejects.toThrow();
    expect(await readFile(path.join(shared, "external.txt"), "utf8")).toBe(
      "preserve",
    );
    expect((await db.query("SELECT id FROM attachments")).rowCount).toBe(0);
    expect((await db.query("SELECT id FROM projects")).rowCount).toBe(1);
  });
  it.skipIf(process.env.DOCKER_TESTS !== "1")(
    "creates linked worktrees, reviews conflicts, rejects stale transfers and preserves main checkpoints",
    async () => {
      const { createCopy, reviewCopy, applyCopy } =
        await import("../src/server/folder-operations");
      const { git } = await import("../src/server/git");
      await mkdir(workspacePath(chat), { recursive: true });
      const root = workspacePath(chat),
        original = "one\ntwo\nthree\nfour\nfive\nsix\n";
      await writeFile(path.join(root, "text.txt"), original);
      await git(root, ["init", "-b", "workspace/test"]);
      await git(root, ["add", "."]);
      await git(root, ["commit", "-m", "initial"]);
      const head = (await git(root, ["rev-parse", "HEAD"])).trim();
      await writeFile(path.join(root, "uploaded.pdf"), Buffer.from([0, 1, 2]));
      await writeFile(path.join(root, ".env"), "do not copy");
      await writeFile(
        path.join(root, "text.txt"),
        original.replace("two", "TWO"),
      );
      await db.query("UPDATE workspaces SET initialized=true WHERE id=$1", [
        chat,
      ]);
      const copy = await createCopy(chat, "Parallel work"),
        cp = workspacePath(copy.id);
      expect(copy.storage_mode).toBe("worktree");
      expect(copy.git_source_id).toBe(chat);
      expect(await readFile(path.join(cp, ".git"), "utf8")).toContain(
        `/workspace-git/${chat}/worktrees/${copy.id}`,
      );
      const sibling = await createCopy(chat, "Other task");
      expect((await git(cp, ["rev-parse", "--git-common-dir"])).trim()).toBe(
        (
          await git(workspacePath(sibling.id), [
            "rev-parse",
            "--git-common-dir",
          ])
        ).trim(),
      );
      expect((await git(cp, ["branch", "--show-current"])).trim()).toBe(
        copy.branch,
      );
      expect(await readFile(path.join(cp, "text.txt"), "utf8")).toContain(
        "TWO",
      );
      expect(await readFile(path.join(cp, "uploaded.pdf"))).toEqual(
        Buffer.from([0, 1, 2]),
      );
      await expect(access(path.join(cp, ".env"))).rejects.toThrow();
      expect((await git(cp, ["rev-parse", "HEAD^"])).trim()).toBe(head);
      expect((await git(root, ["rev-parse", "HEAD"])).trim()).toBe(head);
      await writeFile(
        path.join(cp, "text.txt"),
        original.replace("two", "TWO").replace("one", "ONE"),
      );
      await writeFile(
        path.join(root, "text.txt"),
        original.replace("two", "TWO").replace("six", "SIX"),
      );
      let review = await reviewCopy(copy.id);
      expect(review.changes[0].conflict).toBe(false);
      await writeFile(path.join(root, "later.txt"), "later");
      await expect(applyCopy(copy.id, review.id, {})).rejects.toThrow(
        /Files changed/,
      );
      review = await reviewCopy(copy.id);
      await applyCopy(copy.id, review.id, {});
      expect(await readFile(path.join(root, "text.txt"), "utf8")).toBe(
        original
          .replace("two", "TWO")
          .replace("one", "ONE")
          .replace("six", "SIX"),
      );
      expect(await readFile(path.join(root, ".env"), "utf8")).toBe(
        "do not copy",
      );
      expect((await git(root, ["rev-parse", "HEAD"])).trim()).toBe(head);
      expect(
        await readFile(
          path.join(data, "workspace-checkpoints", review.id, "text.txt"),
          "utf8",
        ),
      ).not.toContain("ONE");
      expect((await reviewCopy(copy.id)).changes).toHaveLength(0);
      await applyCopy(copy.id, review.id, {}); // repeated request is harmless
      await writeFile(path.join(cp, "uploaded.pdf"), Buffer.from([0, 2]));
      await writeFile(path.join(root, "uploaded.pdf"), Buffer.from([0, 3]));
      const conflict = await reviewCopy(copy.id);
      expect(conflict.changes).toContainEqual(
        expect.objectContaining({ path: "uploaded.pdf", conflict: true }),
      );
      await expect(applyCopy(copy.id, conflict.id, {})).rejects.toThrow(
        /every conflict/,
      );
      await applyCopy(copy.id, conflict.id, { "uploaded.pdf": "main" });
      expect(await readFile(path.join(root, "uploaded.pdf"))).toEqual(
        Buffer.from([0, 3]),
      );
      const removed = await app.inject({
        method: "DELETE",
        url: `/api/workspaces/${copy.id}`,
        headers,
        payload: { name: copy.name },
      });
      expect(removed.statusCode).toBe(200);
      expect(removed.json().cleanupPending).toBe(false);
      expect(
        (
          await git(workspacePath(sibling.id), ["status", "--porcelain"])
        ).trim(),
      ).toBe("");
      await expect(
        access(path.join(data, "workspace-git", chat, "worktrees", copy.id)),
      ).rejects.toThrow();
      await writeFile(
        path.join(workspacePath(sibling.id), ".git"),
        `gitdir: /workspace-git/${chat}/worktrees/${copy.id}\n`,
      );
      await expect(git(workspacePath(sibling.id), ["status"])).rejects.toThrow(
        /Git link/,
      );
      await access(path.join(data, "workspace-checkpoints", review.id));
    },
    120000,
  );
  it.skipIf(process.env.DOCKER_TESTS !== "1")(
    "creates a files-only project and plain folder copies without Git metadata",
    async () => {
      const { createCopy, reviewCopy, applyCopy, deleteWorkingFolder } =
        await import("../src/server/folder-operations");
      const { initializeFolder } = await import("../src/server/git");
      const { workspaceBy } = await import("../src/server/workspaces");
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        headers,
        payload: { name: "Documents", repo: "" },
      });
      expect(project.statusCode).toBe(200);
      const main = (
        await db.query("SELECT * FROM workspaces WHERE project_id=$1", [
          project.json().id,
        ])
      ).rows[0];
      await initializeFolder(main);
      await writeFile(
        path.join(workspacePath(main.id), "brief.txt"),
        "Original brief",
      );
      const cp = await createCopy(main.id, "Draft");
      expect(cp.storage_mode).toBe("folder");
      expect(cp.git_source_id).toBeNull();
      await expect(
        access(path.join(workspacePath(cp.id), ".git")),
      ).rejects.toThrow();
      await writeFile(
        path.join(workspacePath(cp.id), "brief.txt"),
        "Updated brief",
      );
      const review = await reviewCopy(cp.id);
      await applyCopy(cp.id, review.id, {});
      expect(
        await readFile(path.join(workspacePath(main.id), "brief.txt"), "utf8"),
      ).toBe("Updated brief");
      expect((await deleteWorkingFolder(cp.id, cp.name)).cleanupPending).toBe(
        false,
      );
      expect((await workspaceBy(main.id)).status).toBe("ready");
    },
    60000,
  );
  it.skipIf(process.env.DOCKER_TESTS !== "1").each(["git", "folder"])(
    "queues agent conflict resolution in an isolated %s copy and gates transfer on completed resolution",
    async (mode) => {
      const {
        createCopy,
        reviewCopy,
        applyCopy,
        deleteWorkingFolder,
        operationPath,
      } = await import("../src/server/folder-operations");
      const { workspaceBy } = await import("../src/server/workspaces");
      const { git } = await import("../src/server/git");
      const root = workspacePath(chat);
      await mkdir(root, { recursive: true });
      await writeFile(path.join(root, "text.txt"), "Original\n");
      await writeFile(path.join(root, "image.bin"), Buffer.from([0, 1]));
      if (mode === "git") {
        await git(root, ["init", "-b", "workspace/test"]);
        await git(root, ["add", "."]);
        await git(root, ["commit", "-m", "Initial"]);
      }
      await db.query("UPDATE workspaces SET initialized=true WHERE id=$1", [
        chat,
      ]);
      const copy = await createCopy(chat, "Feature");
      const cp = workspacePath(copy.id);
      await writeFile(path.join(root, "text.txt"), "Main intent\n");
      await writeFile(path.join(cp, "text.txt"), "Copy intent\n");
      await writeFile(path.join(root, "image.bin"), Buffer.from([0, 2]));
      await writeFile(path.join(cp, "image.bin"), Buffer.from([0, 3]));
      let review = await reviewCopy(copy.id);
      const resolve = (review_id: string) =>
        app.inject({
          method: "POST",
          url: `/api/workspaces/${copy.id}/resolve`,
          headers,
          payload: { review_id, account_id: account },
        });
      await writeFile(path.join(root, "later.txt"), "Added after review");
      expect((await resolve(review.id)).statusCode).toBe(409);
      // Remove the preserved failed preparation so it doesn't pin the old source.
      const failed = (
        await db.query(
          "SELECT * FROM workspaces WHERE resolution_source_id=$1",
          [copy.id],
        )
      ).rows[0];
      await deleteWorkingFolder(failed.id, failed.name);
      review = await reviewCopy(copy.id);
      const response = await resolve(review.id);
      expect(response.statusCode, response.body).toBe(200);
      const resolution = await workspaceBy(response.json().workspace_id),
        rp = workspacePath(resolution.id);
      expect(resolution.storage_mode).toBe(
        mode === "git" ? "worktree" : "folder",
      );
      const runtime = await launch(response.json().chat_id, null, () => {});
      try {
        const container = docker.getContainer(runtime.id);
        const info = await container.inspect();
        expect(
          info.Mounts.find((m) => m.Destination === "/merge-input")?.RW,
        ).toBe(false);
        if (mode === "git") {
          expect(
            info.Mounts.find((m) => m.Destination === `/workspace-git/${chat}`)
              ?.RW,
          ).toBe(false);
          const command = await container.exec({
            Cmd: [
              "sh",
              "-c",
              "git -c safe.directory=/workspace status --porcelain >/dev/null && ! git -c safe.directory=/workspace add . 2>/dev/null",
            ],
            AttachStdout: true,
            AttachStderr: true,
          });
          const stream = await command.start({});
          for await (const _ of stream) {
          }
          expect((await command.inspect()).ExitCode).toBe(0);
        }
      } finally {
        await runtime.stop();
      }
      expect(await readFile(path.join(rp, "text.txt"), "utf8")).toContain(
        "<<<<<<< WORKSPACE MAIN",
      );
      expect(await readFile(path.join(root, "text.txt"), "utf8")).toBe(
        "Main intent\n",
      );
      expect(await readFile(path.join(cp, "text.txt"), "utf8")).toBe(
        "Copy intent\n",
      );
      expect(
        await readFile(
          path.join(
            operationPath(resolution.resolution_operation_id!),
            "inputs",
            "base",
            "text.txt",
          ),
          "utf8",
        ),
      ).toBe("Original\n");
      expect(
        (
          await db.query("SELECT state FROM jobs WHERE chat_id=$1", [
            response.json().chat_id,
          ])
        ).rows[0].state,
      ).toBe("queued");
      expect(
        (
          await db.query("SELECT autonomous FROM chats WHERE id=$1", [
            response.json().chat_id,
          ])
        ).rows[0].autonomous,
      ).toBe(false);
      expect((await resolve(review.id)).statusCode).toBe(409);
      await expect(deleteWorkingFolder(copy.id, copy.name)).rejects.toThrow(
        /conflict-resolution/,
      );
      await expect(reviewCopy(resolution.id)).rejects.toThrow(); // pending agent owns folder
      await db.query("UPDATE jobs SET state='completed' WHERE chat_id=$1", [
        response.json().chat_id,
      ]);
      let ready = await reviewCopy(resolution.id);
      expect(ready.resolutionMessage).toContain("not confirmed");
      await expect(applyCopy(resolution.id, ready.id, {})).rejects.toThrow(
        /not confirmed/,
      );
      await writeFile(
        path.join(rp, ".workspace-resolution.json"),
        JSON.stringify({
          resolved_paths: ["text.txt", "image.bin"],
          checks: "simulated test agent",
        }),
      );
      ready = await reviewCopy(resolution.id);
      expect(ready.resolutionMessage).toContain("markers remain");
      await writeFile(
        path.join(rp, "text.txt"),
        "Main intent and copy intent\n",
      );
      await writeFile(path.join(rp, "image.bin"), Buffer.from([0, 4]));
      await writeFile(
        path.join(root, "new-main.txt"),
        "Preserve concurrent work",
      );
      await writeFile(
        path.join(cp, "after-resolution.txt"),
        "Later original-copy work",
      );
      ready = await reviewCopy(resolution.id);
      expect(ready.resolutionMessage).toBe("");
      await applyCopy(resolution.id, ready.id, {});
      expect(await readFile(path.join(root, "text.txt"), "utf8")).toBe(
        "Main intent and copy intent\n",
      );
      expect(await readFile(path.join(root, "image.bin"))).toEqual(
        Buffer.from([0, 4]),
      );
      expect(await readFile(path.join(root, "new-main.txt"), "utf8")).toBe(
        "Preserve concurrent work",
      );
      await expect(
        access(path.join(root, ".workspace-resolution.json")),
      ).rejects.toThrow();
      const remaining = await reviewCopy(copy.id);
      expect(remaining.changes.map((c: any) => c.path)).toEqual([
        "after-resolution.txt",
      ]);
      expect(
        (await workspaceBy(resolution.id)).resolution_source_id,
      ).toBeNull();
      await deleteWorkingFolder(copy.id, copy.name);
      if (mode === "git")
        expect(await git(rp, ["status", "--porcelain"])).toContain("text.txt");
    },
    120000,
  );
  it.skipIf(process.env.DOCKER_TESTS !== "1")(
    "creates a worktree from an unborn Git repository without committing main",
    async () => {
      const { createCopy } = await import("../src/server/folder-operations");
      const { git } = await import("../src/server/git");
      const root = workspacePath(chat);
      await mkdir(root, { recursive: true });
      await git(root, ["init", "-b", "workspace/test"]);
      await writeFile(path.join(root, "uploaded.txt"), "Keep this");
      await db.query("UPDATE workspaces SET initialized=true WHERE id=$1", [
        chat,
      ]);
      const copy = await createCopy(chat, "First task");
      expect(copy.storage_mode).toBe("worktree");
      expect(
        await readFile(
          path.join(workspacePath(copy.id), "uploaded.txt"),
          "utf8",
        ),
      ).toBe("Keep this");
      await expect(
        git(root, ["rev-parse", "--verify", "HEAD"]),
      ).rejects.toThrow();
    },
    30000,
  );
  it("restores the original main folder after an interrupted transfer", async () => {
    const { recoverFolderOperations } =
      await import("../src/server/folder-operations");
    const op = randomUUID(),
      copy = randomUUID();
    const project = (
      await db.query("SELECT project_id FROM chats WHERE id=$1", [chat])
    ).rows[0].project_id;
    await createWorkspace(project, "copy", "Copy", db, copy);
    await db.query(
      "UPDATE workspaces SET status='applying' WHERE id=ANY($1::uuid[])",
      [[chat, copy]],
    );
    await db.query(
      "INSERT INTO workspace_operations(id,kind,workspace_id,main_workspace_id,status) VALUES($1,'review',$2,$3,'applying')",
      [op, copy, chat],
    );
    await mkdir(path.join(data, "workspace-checkpoints", op), {
      recursive: true,
    });
    await writeFile(
      path.join(data, "workspace-checkpoints", op, "original"),
      "safe",
    );
    await mkdir(path.join(data, "workspace-operations", op), {
      recursive: true,
    });
    await mkdir(workspacePath(chat), { recursive: true });
    await writeFile(path.join(workspacePath(chat), "partial"), "incomplete");
    await recoverFolderOperations();
    expect(
      await readFile(path.join(workspacePath(chat), "original"), "utf8"),
    ).toBe("safe");
    await access(
      path.join(
        data,
        "workspace-operations",
        op,
        "unconfirmed-result",
        "partial",
      ),
    );
    expect((await chatWorkspace(chat)).status).toBe("ready");
  });
  it("runs two copies concurrently with shared connections forced read-only", async () => {
    const { chatFolders } = await import("../src/server/folders");
    const project = (
      await db.query("SELECT project_id FROM chats WHERE id=$1", [chat])
    ).rows[0].project_id;
    await db.query(
      "INSERT INTO folder_links(id,project_id,name,read_only) VALUES($1,$2,'shared-data',false)",
      [randomUUID(), project],
    );
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const id = randomUUID(),
        a = randomUUID(),
        m = randomUUID();
      ids.push(id);
      await createWorkspace(project, "copy", "Copy " + i, db, id);
      await db.query(
        "INSERT INTO accounts(id,name,provider,status) VALUES($1,'Parallel','codex','ready')",
        [a],
      );
      await db.query(
        "INSERT INTO chats(id,project_id,workspace_id,title,provider,account_id,branch) VALUES($1,$2,$1,'Copy chat','codex',$3,'copy')",
        [id, project, a],
      );
      await db.query(
        "INSERT INTO messages(id,chat_id,role,content) VALUES($1,$2,'user','work')",
        [m, id],
      );
      await db.query(
        "INSERT INTO jobs(id,chat_id,message_id) VALUES($1,$2,$3)",
        [randomUUID(), id, m],
      );
      expect((await chatFolders(id))[0].read_only).toBe(true);
    }
    expect((await chatFolders(chat))[0].read_only).toBe(false);
    expect((await claim())?.chat_id).toBe(ids[0]);
    expect((await claim())?.chat_id).toBe(ids[1]);
  });
  it("acquires both folders atomically and blocks deletion while tasks are queued", async () => {
    const { acquireFolders } = await import("../src/server/leases");
    const project = (
      await db.query("SELECT project_id FROM chats WHERE id=$1", [chat])
    ).rows[0].project_id;
    const copy = await createWorkspace(project, "copy", "Copy", db);
    await acquireFolder(chat, "terminal");
    await expect(acquireFolders([copy.id, chat], "review")).rejects.toThrow();
    expect(
      (
        await db.query("SELECT 1 FROM workspace_leases WHERE workspace_id=$1", [
          copy.id,
        ])
      ).rowCount,
    ).toBe(0);
    await releaseFolder(chat);
    await db.query("UPDATE workspaces SET kind='saved' WHERE id=$1", [chat]);
    await app.inject({
      method: "POST",
      url: `/api/chats/${chat}/messages`,
      headers,
      payload: { content: "queued", client_id: randomUUID() },
    });
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/workspaces/${chat}`,
          headers,
          payload: { name: "Main folder" },
        })
      ).statusCode,
    ).toBe(409);
  });
  it("recovers an interrupted folder deletion without removing chats or files", async () => {
    const { recoverFolderOperations } =
      await import("../src/server/folder-operations");
    const op = randomUUID();
    await db.query(
      "UPDATE workspaces SET kind='saved',status='deleting' WHERE id=$1",
      [chat],
    );
    await db.query(
      "INSERT INTO workspace_operations(id,kind,workspace_id,status,result) VALUES($1,'delete',$2,'deleting',$3)",
      [op, chat, JSON.stringify({ previousStatus: "ready" })],
    );
    await mkdir(path.join(data, "workspace-operations", op, "deleted-folder"), {
      recursive: true,
    });
    await writeFile(
      path.join(data, "workspace-operations", op, "deleted-folder", "keep.txt"),
      "safe",
    );
    await recoverFolderOperations();
    expect(
      await readFile(path.join(workspacePath(chat), "keep.txt"), "utf8"),
    ).toBe("safe");
    expect((await chatWorkspace(chat)).status).toBe("ready");
  });
  it("completes interrupted account removal while preserving conversation records", async () => {
    const { recoverAccountDeletions } = await import("../src/server/accounts");
    await db.query("UPDATE accounts SET status='deleting' WHERE id=$1", [
      account,
    ]);
    await mkdir(path.join(data, "profiles", account), { recursive: true });
    await writeFile(
      path.join(data, "profiles", account, "remaining"),
      "credential",
    );
    await recoverAccountDeletions();
    expect(
      (await db.query("SELECT id FROM accounts WHERE id=$1", [account]))
        .rowCount,
    ).toBe(0);
    expect(
      (await db.query("SELECT id FROM chats WHERE id=$1", [chat])).rowCount,
    ).toBe(1);
    await expect(
      access(path.join(data, "profiles", account)),
    ).rejects.toThrow();
  });
});

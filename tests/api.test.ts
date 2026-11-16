import {
  availableFolders,
  folderPath,
  folderMounts,
} from "../src/server/folders";
import { copyFolderUpload } from "../src/server/folder-routes";
import { inspectDirectory } from "../src/server/files";
import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  rm,
  readFile,
  writeFile,
  access,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import argon2 from "argon2";
import * as OTPAuth from "otpauth";
import { disconnectAccount } from "../src/server/accounts";
import { claim, active } from "../src/server/worker";
import { concurrentTasks } from "../src/server/settings";
import { acquireWorkspace, releaseWorkspace } from "../src/server/leases";
import { event } from "../src/server/events";
import { config } from "../src/server/config";
import { db, migrate } from "../src/server/db";
import { createApp } from "../src/server/app";
import { docker } from "../src/server/runtime";
import { initializeWorkspace, projectToken } from "../src/server/git";
import { hash, seal } from "../src/server/security";
const enabled = process.env.INTEGRATION_TESTS === "1";
describe.skipIf(!enabled)("PostgreSQL API integration", () => {
  let app: Awaited<ReturnType<typeof createApp>>,
    data: string,
    chat: string,
    account: string;
  const token = "test-session-token",
    origin = "http://localhost:5173";
  const headers = { origin, cookie: "session=" + token };
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
    await db.query(
      "TRUNCATE workspace_leases,publications,push_subscriptions,approvals,events,jobs,attachments,messages,chats,accounts,projects,sessions,owner,settings CASCADE",
    );
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
    await db.query(
      "INSERT INTO chats(id,project_id,title,provider,account_id,branch) VALUES($1,$2,'Test','codex',$3,'workspace/test')",
      [chat, project, account],
    );
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
    const second = (
      await app.inject({
        method: "POST",
        url: "/api/chats",
        headers,
        payload: {
          project_id: project,
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
      "INSERT INTO accounts(id,name,provider,status) VALUES($1,'B','codex','ready')",
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
  it("blocks provider changes and switching while running", async () => {
    const other = randomUUID();
    await db.query(
      "INSERT INTO accounts(id,name,provider,status) VALUES($1,'Other','claude','ready')",
      [other],
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
    ).toBeGreaterThanOrEqual(400);
  });
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
      if (i !== 0)
        await db.query(
          "INSERT INTO chats(id,project_id,title,provider,account_id,branch) VALUES($1,$2,'Parallel','codex',$3,$4)",
          [cid, project, aid, "workspace/" + cid],
        );
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
      await db.query(
        "INSERT INTO chats(id,project_id,title,provider,account_id,branch) VALUES($1,$2,'Capacity test','codex',$3,$4)",
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
});

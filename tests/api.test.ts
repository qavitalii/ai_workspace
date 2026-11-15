import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import argon2 from "argon2";
import * as OTPAuth from "otpauth";
import { claim, active } from "../src/server/worker";
import { acquireWorkspace, releaseWorkspace } from "../src/server/leases";
import { event } from "../src/server/events";
import { config } from "../src/server/config";
import { db, migrate } from "../src/server/db";
import { createApp } from "../src/server/app";
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
  it("claims at most three jobs and never shares one account concurrently", async () => {
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

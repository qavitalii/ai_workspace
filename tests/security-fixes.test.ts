import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  consumeRunnerOutput,
  MAX_EVENT_BYTES,
} from "../src/server/runner-output";
import { proxyTrust } from "../src/server/proxy";
import { createApp } from "../src/server/app";
import { config } from "../src/server/config";
import {
  validateWorktree,
  workspacePath,
  type Workspace,
} from "../src/server/workspaces";

function frame(data: string | Buffer, channel = 1) {
  const bytes = Buffer.from(data);
  const header = Buffer.alloc(8);
  header[0] = channel;
  header.writeUInt32BE(bytes.length, 4);
  return Buffer.concat([header, bytes]);
}
async function* chunks(...values: Buffer[]) {
  yield* values;
}

describe("bounded runner output", () => {
  it("handles split Docker headers, split UTF-8, multiple events and stderr", async () => {
    const bytes = Buffer.concat([
      frame('{"type":"delta","text":"Привіт"}\n{"type":"completed"}\n'),
      frame("error", 2),
    ]);
    const events: any[] = [];
    await consumeRunnerOutput(
      chunks(...Array.from(bytes, (b) => Buffer.from([b]))),
      (e) => {
        events.push(e);
      },
    );
    expect(events.slice(0, 2)).toEqual([
      { type: "delta", text: "Привіт" },
      { type: "completed" },
    ]);
    expect(
      events
        .slice(2)
        .map((e) => e.text)
        .join(""),
    ).toBe("error");
  });
  it("waits for persistence before reading another event", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: string[] = [];
    const consuming = consumeRunnerOutput(
      chunks(frame('{"type":"first"}\n{"type":"second"}\n')),
      async (e) => {
        events.push(e.type);
        if (e.type === "first") await gate;
      },
    );
    await new Promise((r) => setImmediate(r));
    expect(events).toEqual(["first"]);
    release();
    await consuming;
    expect(events).toEqual(["first", "second"]);
  });
  it("rejects oversized frames immediately and oversized lines across frames", async () => {
    const header = Buffer.alloc(8);
    header[0] = 1;
    header.writeUInt32BE(MAX_EVENT_BYTES + 1, 4);
    await expect(consumeRunnerOutput(chunks(header), () => {})).rejects.toThrow(
      "oversized",
    );
    await expect(
      consumeRunnerOutput(
        chunks(frame(Buffer.alloc(MAX_EVENT_BYTES, 97)), frame("x")),
        () => {},
      ),
    ).rejects.toThrow("1 MiB");
  });
  it("rejects invalid and truncated events rather than hiding consumer failures", async () => {
    for (const bytes of [
      frame("null\n"),
      frame("{}\n"),
      frame("unfinished"),
      Buffer.from([1, 0]),
    ])
      await expect(
        consumeRunnerOutput(chunks(bytes), () => {}),
      ).rejects.toThrow();
    await expect(
      consumeRunnerOutput(chunks(frame('{"type":"delta"}\n')), async () => {
        throw new Error("Storage full");
      }),
    ).rejects.toThrow("Storage full");
  });
});

describe("Git link validation", () => {
  let root: string | undefined;
  const oldData = config.data;
  afterEach(async () => {
    config.data = oldData;
    if (root) await rm(root, { recursive: true, force: true });
  });
  it("accepts the original link and promptly rejects FIFO, directory, symlink and oversized replacements", async () => {
    root = await mkdtemp(path.join(tmpdir(), "workspace-git-security-"));
    config.data = root;
    const w = { id: "copy", git_source_id: "source" } as Workspace;
    await mkdir(workspacePath(w.id), { recursive: true });
    const file = path.join(workspacePath(w.id), ".git");
    const valid = "gitdir: /workspace-git/source/worktrees/copy\n";
    await writeFile(file, valid);
    await expect(validateWorktree(w)).resolves.toBeUndefined();
    await rm(file);
    execFileSync("mkfifo", [file]);
    await expect(validateWorktree(w)).rejects.toMatchObject({
      statusCode: 409,
    });
    await rm(file);
    await mkdir(file);
    await expect(validateWorktree(w)).rejects.toThrow();
    await rm(file, { recursive: true });
    await writeFile(path.join(root, "target"), valid);
    await symlink(path.join(root, "target"), file);
    await expect(validateWorktree(w)).rejects.toThrow();
    await rm(file);
    await writeFile(file, valid + " ".repeat(1024));
    await expect(validateWorktree(w)).rejects.toThrow();
  }, 3000);
});

describe("login proxy boundary", () => {
  it("trusts only exact configured addresses at the immediate hop", () => {
    const trust = proxyTrust("172.30.250.2");
    expect(trust("::ffff:172.30.250.2", 0)).toBe(true);
    expect(trust("172.30.250.2", 1)).toBe(false);
    expect(trust("172.30.250.3", 0)).toBe(false);
    expect(proxyTrust("")("127.0.0.1", 0)).toBe(false);
    expect(() => proxyTrust("0.0.0.0/0")).toThrow();
  });
  it("separates real clients behind Caddy and ignores spoofed direct headers", async () => {
    const old = config.trustedProxyIps;
    config.trustedProxyIps = "172.30.250.2";
    const app = await createApp();
    try {
      const login = (remoteAddress: string, forwarded: string) =>
        app.inject({
          method: "POST",
          url: "/api/login",
          remoteAddress,
          headers: { origin: config.origin, "x-forwarded-for": forwarded },
          payload: {},
        });
      for (let n = 0; n < 5; n++)
        expect((await login("172.30.250.2", "198.51.100.1")).statusCode).toBe(
          400,
        );
      expect((await login("172.30.250.2", "198.51.100.1")).statusCode).toBe(
        429,
      );
      expect((await login("172.30.250.2", "198.51.100.2")).statusCode).toBe(
        400,
      );
      // An injected leftmost value cannot change the rightmost client address.
      expect(
        (await login("172.30.250.2", "203.0.113.99, 198.51.100.1")).statusCode,
      ).toBe(429);
      for (let n = 0; n < 5; n++)
        expect(
          (await login("203.0.113.5", `198.51.100.${n + 10}`)).statusCode,
        ).toBe(400);
      expect((await login("203.0.113.5", "198.51.100.100")).statusCode).toBe(
        429,
      );
    } finally {
      config.trustedProxyIps = old;
      await app.close();
    }
  });
});

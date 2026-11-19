import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../src/server/config";
import {
  authStore,
  legacyProfile,
  prepareProfile,
  readInside,
  recoverRunProfiles,
  removeAccountProfiles,
  removeChatSessions,
  removeSessionsExcept,
  sessionStore,
} from "../src/server/profiles";

const account = "11111111-1111-4111-8111-111111111111";
const chatA = "22222222-2222-4222-8222-222222222222";
const chatB = "33333333-3333-4333-8333-333333333333";
const session = "44444444-4444-4444-8444-444444444444";
const credentials = (token: string) =>
  JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: "r" } });
const codexAuth = (token: string) =>
  JSON.stringify({ tokens: { access_token: token }, last_refresh: "x" });

const originalData = config.data;
let data = "";
beforeEach(async () => {
  data = await mkdtemp(path.join(tmpdir(), "profiles-"));
  config.data = data;
});
afterEach(async () => {
  config.data = originalData;
  await rm(data, { recursive: true, force: true });
});

const present = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );
async function put(root: string, rel: string, content: string) {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), content);
}
/** Simulates a run: the agent writes into the mounted profile, then it exits. */
async function run(
  chat: string | null,
  write: (dir: string) => Promise<void> = async () => {},
  sessionId?: string,
) {
  const p = await prepareProfile(account, chat, { session: sessionId });
  await write(p.dir);
  await p.finish();
  return p.dir;
}
async function signIn() {
  await run(null, async (dir) => {
    await put(dir, ".claude/.credentials.json", credentials("t1"));
    await put(dir, ".codex/auth.json", codexAuth("c1"));
  });
}

describe("per-run account profile", () => {
  it("persists sign-in and discards everything else written to /profile", async () => {
    await signIn();
    const planted = [
      ".claude/settings.json",
      ".claude/CLAUDE.md",
      ".claude/skills/evil/SKILL.md",
      ".claude/plugins/evil/plugin.json",
      `.claude/projects/-workspace/memory/MEMORY.md`,
      ".codex/config.toml",
      ".codex/AGENTS.md",
      ".bashrc",
      ".gitconfig",
    ];
    const first = await run(chatA, async (dir) => {
      for (const file of planted) await put(dir, file, "planted");
    });
    expect(await present(first)).toBe(false);
    for (const chat of [chatA, chatB]) {
      const p = await prepareProfile(account, chat);
      for (const file of planted)
        expect(await present(path.join(p.dir, file)), file).toBe(false);
      expect(
        JSON.parse(
          await readFile(path.join(p.dir, ".claude/.credentials.json"), "utf8"),
        ).claudeAiOauth.accessToken,
      ).toBe("t1");
      expect(
        await readFile(path.join(p.dir, ".codex/auth.json"), "utf8"),
      ).toContain("c1");
      await p.finish();
    }
    expect(await readdir(authStore(account), { recursive: true })).toEqual(
      expect.arrayContaining([".claude", ".codex"]),
    );
  });

  it("keeps refreshed credentials, ignores invalid ones and mirrors sign-out", async () => {
    await signIn();
    await run(null, (dir) =>
      put(dir, ".claude/.credentials.json", credentials("t2")),
    );
    await run(null, (dir) => put(dir, ".codex/auth.json", "not json"));
    await run(null, (dir) =>
      put(
        dir,
        ".claude/.credentials.json",
        JSON.stringify({ claudeAiOauth: {}, extra: 1 }),
      ),
    );
    const store = authStore(account);
    expect(
      JSON.parse(
        await readFile(path.join(store, ".claude/.credentials.json"), "utf8"),
      ),
    ).toEqual({ claudeAiOauth: { accessToken: "t2", refreshToken: "r" } });
    expect(
      await readFile(path.join(store, ".codex/auth.json"), "utf8"),
    ).toContain("c1");
    await run(null, (dir) => rm(path.join(dir, ".codex/auth.json")));
    expect(await present(path.join(store, ".codex/auth.json"))).toBe(false);
    expect(await present(path.join(store, ".claude/.credentials.json"))).toBe(
      true,
    );
  });

  it("does not let a run overwrite a newer credential with its own unchanged copy", async () => {
    await signIn();
    const stale = await prepareProfile(account, null);
    await run(null, (dir) =>
      put(dir, ".claude/.credentials.json", credentials("t2")),
    );
    await stale.finish();
    expect(
      await readFile(
        path.join(authStore(account), ".claude/.credentials.json"),
        "utf8",
      ),
    ).toContain("t2");
  });

  it("keeps only allow-listed keys of Claude's global state file", async () => {
    await signIn();
    await run(null, (dir) =>
      put(
        dir,
        ".claude/.claude.json",
        JSON.stringify({
          oauthAccount: { emailAddress: "a@example.test" },
          hasCompletedOnboarding: true,
          mcpServers: { evil: { command: "sh" } },
          projects: { "/workspace": { mcpServers: {} } },
        }),
      ),
    );
    expect(
      JSON.parse(
        await readFile(
          path.join(authStore(account), ".claude/.claude.json"),
          "utf8",
        ),
      ),
    ).toEqual({
      oauthAccount: { emailAddress: "a@example.test" },
      hasCompletedOnboarding: true,
    });
  });

  it("never follows symlinks or opens special files from the run profile", async () => {
    await signIn();
    const outside = path.join(data, "outside.json");
    await writeFile(outside, credentials("stolen"));
    await run(null, async (dir) => {
      await rm(path.join(dir, ".claude/.credentials.json"));
      await symlink(outside, path.join(dir, ".claude/.credentials.json"));
      await rm(path.join(dir, ".codex"), { recursive: true });
      await symlink(path.dirname(outside), path.join(dir, ".codex"));
    });
    const store = authStore(account);
    expect(
      await readFile(path.join(store, ".claude/.credentials.json"), "utf8"),
    ).toContain("t1");
    expect(
      await readFile(path.join(store, ".codex/auth.json"), "utf8"),
    ).toContain("c1");
    const dir = await mkdtemp(path.join(data, "fifo-"));
    await mkdir(path.join(dir, ".codex"));
    execFileSync("mkfifo", [path.join(dir, ".codex/auth.json")]);
    expect(await readInside(dir, ".codex/auth.json")).toEqual({
      state: "unsafe",
    });
  });

  it("keeps native session transcripts per chat only", async () => {
    await signIn();
    const transcript = `.claude/projects/-workspace/${session}.jsonl`;
    const rollout = `.codex/sessions/2026/11/19/rollout-2026-11-19T10-00-00-${session}.jsonl`;
    await run(chatA, async (dir) => {
      await put(dir, transcript, "claude history");
      await put(
        dir,
        `.claude/projects/-workspace/${session}/subagents/a.jsonl`,
        "sub",
      );
      await put(dir, rollout, "codex history");
      await put(dir, ".codex/sessions/2026/11/19/notes.txt", "dropped");
      await put(dir, ".claude/projects/-other/x.jsonl", "dropped");
    });
    const a = await prepareProfile(account, chatA);
    expect(await readFile(path.join(a.dir, transcript), "utf8")).toBe(
      "claude history",
    );
    expect(await readFile(path.join(a.dir, rollout), "utf8")).toBe(
      "codex history",
    );
    expect(
      await present(
        path.join(
          a.dir,
          `.claude/projects/-workspace/${session}/subagents/a.jsonl`,
        ),
      ),
    ).toBe(true);
    expect(
      await present(path.join(a.dir, ".codex/sessions/2026/11/19/notes.txt")),
    ).toBe(false);
    expect(await present(path.join(a.dir, ".claude/projects/-other"))).toBe(
      false,
    );
    await a.finish();
    const b = await prepareProfile(account, chatB);
    expect(await present(path.join(b.dir, transcript))).toBe(false);
    expect(await present(path.join(b.dir, rollout))).toBe(false);
    await b.finish();
    await removeChatSessions([chatA]);
    expect(await present(sessionStore(account, chatA))).toBe(false);
  });

  it("migrates sign-in and one chat's session from the legacy shared profile", async () => {
    const legacy = legacyProfile(account);
    await put(legacy, ".claude/.credentials.json", credentials("old"));
    await put(
      legacy,
      ".claude.json",
      JSON.stringify({ userID: "u", hooks: 1 }),
    );
    await put(legacy, ".codex/auth.json", codexAuth("old-codex"));
    await put(legacy, ".claude/settings.json", "hooks");
    await put(legacy, `.claude/projects/-workspace/${session}.jsonl`, "mine");
    await put(
      legacy,
      ".claude/projects/-workspace/55555555-5555-4555-8555-555555555555.jsonl",
      "another chat",
    );
    const p = await prepareProfile(account, chatA, { session });
    expect(
      await readFile(path.join(p.dir, ".claude/.credentials.json"), "utf8"),
    ).toContain("old");
    expect(
      JSON.parse(
        await readFile(path.join(p.dir, ".claude/.claude.json"), "utf8"),
      ),
    ).toEqual({ userID: "u" });
    expect(
      await readFile(path.join(p.dir, ".codex/auth.json"), "utf8"),
    ).toContain("old-codex");
    expect(await present(path.join(p.dir, ".claude/settings.json"))).toBe(
      false,
    );
    expect(
      await readFile(
        path.join(p.dir, `.claude/projects/-workspace/${session}.jsonl`),
        "utf8",
      ),
    ).toBe("mine");
    expect(
      await present(
        path.join(
          p.dir,
          ".claude/projects/-workspace/55555555-5555-4555-8555-555555555555.jsonl",
        ),
      ),
    ).toBe(false);
    await p.finish();
    // Migration happens once: later legacy changes are ignored.
    await put(legacy, ".claude/.credentials.json", credentials("later"));
    const next = await prepareProfile(account, null);
    expect(
      await readFile(path.join(next.dir, ".claude/.credentials.json"), "utf8"),
    ).toContain("old");
    await next.finish();
    await removeAccountProfiles(account);
    for (const dir of [
      legacy,
      authStore(account),
      sessionStore(account, chatA),
    ])
      expect(await present(dir)).toBe(false);
  });

  it("recovers a refreshed credential from a run interrupted by a restart", async () => {
    await signIn();
    const p = await prepareProfile(account, null);
    await put(p.dir, ".claude/.credentials.json", credentials("refreshed"));
    await mkdir(path.join(data, "run-profiles", "never-started"));
    await recoverRunProfiles();
    expect(await readdir(path.join(data, "run-profiles"))).toEqual([]);
    expect(
      await readFile(
        path.join(authStore(account), ".claude/.credentials.json"),
        "utf8",
      ),
    ).toContain("refreshed");
  });

  it("does not recreate the store of a deleted account", async () => {
    await signIn();
    const p = await prepareProfile(account, chatA);
    await removeAccountProfiles(account);
    await put(p.dir, ".claude/.credentials.json", credentials("late"));
    await p.finish();
    expect(await present(authStore(account))).toBe(false);
    expect(await present(sessionStore(account, chatA))).toBe(false);
  });

  it("never lets a stale run overwrite credentials or transcripts saved by a later run", async () => {
    await signIn();
    const stale = await prepareProfile(account, chatA);
    await run(chatA, async (dir) => {
      await put(dir, ".claude/.credentials.json", credentials("t2"));
      await put(dir, `.claude/projects/-workspace/${session}.jsonl`, "newer");
    });
    await put(stale.dir, ".claude/.credentials.json", credentials("t-old"));
    await put(
      stale.dir,
      `.claude/projects/-workspace/${session}.jsonl`,
      "older",
    );
    expect(await stale.finish(session)).toBe(true);
    const p = await prepareProfile(account, chatA);
    expect(
      await readFile(path.join(p.dir, ".claude/.credentials.json"), "utf8"),
    ).toContain("t2");
    expect(
      await readFile(
        path.join(p.dir, `.claude/projects/-workspace/${session}.jsonl`),
        "utf8",
      ),
    ).toBe("newer");
    await p.finish();
  });

  it("rejects a switch to another provider account outside sign-in and drops unknown Codex keys", async () => {
    await run(
      null,
      (dir) =>
        put(
          dir,
          ".codex/auth.json",
          JSON.stringify({
            tokens: { access_token: "a", account_id: "owner" },
            extra: { evil: true },
          }),
        ),
      undefined,
    );
    const store = path.join(authStore(account), ".codex/auth.json");
    expect(JSON.parse(await readFile(store, "utf8"))).toEqual({
      tokens: { access_token: "a", account_id: "owner" },
    });
    await run(null, (dir) =>
      put(
        dir,
        ".codex/auth.json",
        JSON.stringify({
          tokens: { access_token: "b", account_id: "attacker" },
        }),
      ),
    );
    await run(null, (dir) =>
      put(dir, ".codex/auth.json", JSON.stringify({ OPENAI_API_KEY: "sk-x" })),
    );
    expect(await readFile(store, "utf8")).toContain('"owner"');
    const signInRun = await prepareProfile(account, null, { signIn: true });
    await put(
      signInRun.dir,
      ".codex/auth.json",
      JSON.stringify({ tokens: { access_token: "c", account_id: "second" } }),
    );
    await signInRun.finish();
    expect(await readFile(store, "utf8")).toContain('"second"');
  });

  it("rejects Codex credentials without the account id or switched to an API key", async () => {
    const owner = {
      access_token: "a",
      refresh_token: "r",
      account_id: "owner",
    };
    const signInRun = await prepareProfile(account, null, { signIn: true });
    await put(
      signInRun.dir,
      ".codex/auth.json",
      JSON.stringify({ tokens: owner }),
    );
    expect(await signInRun.finish()).toBe(true);
    const store = path.join(authStore(account), ".codex/auth.json");
    for (const attack of [
      { tokens: { id_token: "x", access_token: "evil", refresh_token: "e" } },
      { tokens: owner, auth_mode: "apikey", OPENAI_API_KEY: "sk-evil" },
    ])
      await run(null, (dir) =>
        put(dir, ".codex/auth.json", JSON.stringify(attack)),
      );
    expect(JSON.parse(await readFile(store, "utf8"))).toEqual({
      tokens: owner,
    });
    // An ordinary refresh changes only tokens and last_refresh.
    await run(null, (dir) =>
      put(
        dir,
        ".codex/auth.json",
        JSON.stringify({
          tokens: { ...owner, access_token: "b" },
          last_refresh: "now",
        }),
      ),
    );
    expect(await readFile(store, "utf8")).toContain('"b"');
  });

  it("reports a sign-in that stored no usable credential as failed", async () => {
    const p = await prepareProfile(account, null, { signIn: true });
    await put(p.dir, ".claude/.credentials.json", JSON.stringify({ other: 1 }));
    expect(await p.finish()).toBe(false);
  });

  it("keeps only the chat's current session and sweeps transcripts of deleted chats", async () => {
    await signIn();
    const old = "66666666-6666-4666-8666-666666666666";
    await run(chatA, async (dir) => {
      await put(dir, `.claude/projects/-workspace/${old}.jsonl`, "old");
      await put(dir, `.claude/projects/-workspace/${session}.jsonl`, "current");
    });
    const p = await prepareProfile(account, chatA);
    expect(
      await present(
        path.join(p.dir, `.claude/projects/-workspace/${old}.jsonl`),
      ),
    ).toBe(true);
    expect(await p.finish(session)).toBe(true);
    const next = await prepareProfile(account, chatA);
    expect(
      await present(
        path.join(next.dir, `.claude/projects/-workspace/${old}.jsonl`),
      ),
    ).toBe(false);
    expect(
      await present(
        path.join(next.dir, `.claude/projects/-workspace/${session}.jsonl`),
      ),
    ).toBe(true);
    await next.finish(session);
    await run(chatB, (dir) =>
      put(dir, `.claude/projects/-workspace/${old}.jsonl`, "b"),
    );
    await removeSessionsExcept(new Set([chatB]));
    expect(await present(sessionStore(account, chatA))).toBe(false);
    expect(await present(sessionStore(account, chatB))).toBe(true);
  });

  it("leaves runs whose container is still alive for a later recovery", async () => {
    await signIn();
    const p = await prepareProfile(account, null);
    await put(p.dir, ".claude/.credentials.json", credentials("later"));
    await recoverRunProfiles(new Set([p.name]));
    expect(await present(p.dir)).toBe(true);
    await recoverRunProfiles();
    expect(await present(p.dir)).toBe(false);
    expect(
      await readFile(
        path.join(authStore(account), ".claude/.credentials.json"),
        "utf8",
      ),
    ).toContain("later");
  });

  it("persists Claude's account identity even when the state file is large", async () => {
    await signIn();
    await run(null, (dir) =>
      put(
        dir,
        ".claude/.claude.json",
        JSON.stringify({
          oauthAccount: { accountUuid: "u1" },
          cachedGrowthBookFeatures: "x".repeat(600 * 1024),
        }),
      ),
    );
    expect(
      JSON.parse(
        await readFile(
          path.join(authStore(account), ".claude/.claude.json"),
          "utf8",
        ),
      ),
    ).toEqual({ oauthAccount: { accountUuid: "u1" } });
  });
});

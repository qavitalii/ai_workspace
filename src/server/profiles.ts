// Account profiles for runner containers.
//
// An agent can be prompt-injected, so everything it can write must be treated
// as untrusted. Only two kinds of state outlive a run:
// - per account: the provider sign-in files (allow-listed and shape-checked);
// - per chat and account: the transcript of the chat's current native
//   session, so resume keeps working without sharing it across chats.
// Everything else the CLIs or the agent write to /profile (settings, hooks,
// CLAUDE.md, skills, plugins, Codex config, memory, shell files, caches) lives
// in a fresh directory that is discarded after the run.
import { createHash, randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { config } from "./config.js";

type Json = Record<string, unknown>;
const plain = (value: unknown): value is Json =>
  !!value && typeof value === "object" && !Array.isArray(value);
const pick = (value: Json, keys: Record<string, (v: unknown) => boolean>) =>
  Object.fromEntries(
    Object.entries(keys)
      .filter(([key, valid]) => valid(value[key]))
      .map(([key]) => [key, value[key]]),
  );
const isString = (v: unknown) => typeof v === "string";

const RUNNER_UID = 1000;
const AUTH_LIMIT = 256 * 1024;
const SESSION_FILE_LIMIT = 1024 ** 3;
const SESSION_TOTAL_LIMIT = 2 * 1024 ** 3;
const SESSION_ENTRY_COUNT = 20000;
const GENERATION = ".generation";

export const authStore = (account: string) =>
  path.join(config.data, "account-auth", account);
const sessionsRoot = () => path.join(config.data, "account-sessions");
export const sessionRoot = (account: string) =>
  path.join(sessionsRoot(), account);
export const sessionStore = (account: string, chat: string) =>
  path.join(sessionRoot(account), chat);
/** Former shared profile. Read for migration only, never mounted again. */
export const legacyProfile = (account: string) =>
  path.join(config.data, "profiles", account);
const runRoot = () => path.join(config.data, "run-profiles");

type AuthFile = {
  file: string;
  legacy: string[];
  limit: number;
  /** The document to store, or null to keep the stored one. */
  clean: (value: unknown) => Json | null;
  /** Provider account the document belongs to, when it names one. */
  identity?: (value: Json) => string | undefined;
  /**
   * Outside sign-in, a stored identity must be kept exactly. Codex rewrites
   * only tokens and last_refresh when refreshing; account, mode and API key
   * never change on their own.
   */
  strict?: boolean;
};

export const AUTH_FILES: AuthFile[] = [
  {
    file: ".claude/.credentials.json",
    legacy: [".claude/.credentials.json"],
    limit: AUTH_LIMIT,
    clean: (v) =>
      plain(v) &&
      plain(v.claudeAiOauth) &&
      typeof v.claudeAiOauth.accessToken === "string"
        ? { claudeAiOauth: v.claudeAiOauth }
        : null,
  },
  {
    // Account identity and onboarding flags only; never MCP servers,
    // per-project settings or anything else the CLI keeps in this file. The
    // CLI also caches large feature-flag sets here, hence the larger limit.
    file: ".claude/.claude.json",
    legacy: [".claude/.claude.json", ".claude.json"],
    limit: 8 * 1024 ** 2,
    clean: (v) =>
      plain(v)
        ? pick(v, {
            oauthAccount: plain,
            userID: isString,
            hasCompletedOnboarding: (x) => typeof x === "boolean",
            lastOnboardingVersion: isString,
          })
        : null,
    identity: (v) =>
      plain(v.oauthAccount) && isString(v.oauthAccount.accountUuid)
        ? "claude:" + v.oauthAccount.accountUuid
        : undefined,
  },
  {
    file: ".codex/auth.json",
    legacy: [".codex/auth.json"],
    limit: AUTH_LIMIT,
    clean: (v) => {
      if (!plain(v)) return null;
      const tokens = plain(v.tokens)
        ? pick(v.tokens, {
            id_token: isString,
            access_token: isString,
            refresh_token: isString,
            account_id: isString,
          })
        : undefined;
      if (!tokens?.access_token && !isString(v.OPENAI_API_KEY)) return null;
      return {
        ...pick(v, {
          OPENAI_API_KEY: (x) => x === null || isString(x),
          last_refresh: isString,
          auth_mode: isString,
        }),
        ...(tokens ? { tokens } : {}),
      };
    },
    strict: true,
    identity: (v) =>
      JSON.stringify([
        plain(v.tokens) && isString(v.tokens.account_id)
          ? v.tokens.account_id
          : null,
        isString(v.auth_mode) ? v.auth_mode : null,
        isString(v.OPENAI_API_KEY) ? hash(v.OPENAI_API_KEY) : null,
      ]),
  },
];

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const isUuid = (value: string) => new RegExp(`^${UUID}$`).test(value);
// Runs always start in /workspace, which Claude stores as "-workspace".
const CLAUDE_SESSIONS = ".claude/projects/-workspace";
const SESSION_FILES = [
  new RegExp(`^\\.claude/projects/-workspace/${UUID}\\.jsonl$`),
  new RegExp(`^\\.claude/projects/-workspace/${UUID}(?:/[^/]+){1,4}$`),
  /^\.codex\/sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-[^/]+\.jsonl$/,
  /^\.codex\/archived_sessions\/rollout-[^/]+\.jsonl$/,
];
const SESSION_DIRS = [
  /^\.claude(?:\/projects(?:\/-workspace)?)?$/,
  new RegExp(`^\\.claude/projects/-workspace/${UUID}(?:/[^/]+){0,3}$`),
  /^\.codex(?:\/sessions(?:\/\d{4}(?:\/\d{2}(?:\/\d{2})?)?)?)?$/,
  /^\.codex\/archived_sessions$/,
];
/** Transcript paths kept per chat. Memory files and anything else are dropped. */
export function sessionPath(rel: string, directory = false) {
  return (directory ? SESSION_DIRS : SESSION_FILES).some((r) => r.test(rel));
}
/** Files of one native session, for both providers. */
const ofSession = (id: string) => (rel: string) =>
  rel === `${CLAUDE_SESSIONS}/${id}.jsonl` ||
  rel.startsWith(`${CLAUDE_SESSIONS}/${id}/`) ||
  (rel.startsWith(".codex/") && rel.endsWith(`-${id}.jsonl`));

const NOFOLLOW =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/**
 * Opens a regular file without following a final symlink or blocking on a
 * FIFO and, where the OS can tell, confirms it really is below root.
 */
async function openInside(root: string, file: string) {
  const handle = await open(file, NOFOLLOW).catch(() => null);
  if (!handle) return null;
  try {
    const stat = await handle.stat();
    if (stat.isFile()) {
      const real = await realpath(`/proc/self/fd/${handle.fd}`).catch(
        (e: any) => (e.code === "ENOENT" ? null : ""),
      );
      if (real === null || real.startsWith(root + path.sep))
        return { handle, size: stat.size };
    }
  } catch {}
  await handle.close();
  return null;
}

type Read =
  { state: "missing" } | { state: "unsafe" } | { state: "ok"; data: Buffer };

/**
 * Reads a regular file below root without following symlinks in any path
 * component. Only call once nothing an agent controls can modify root.
 */
export async function readInside(
  root: string,
  rel: string,
  limit = AUTH_LIMIT,
): Promise<Read> {
  const parts = rel.split("/");
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await lstat(current);
    } catch (e: any) {
      if (e.code === "ENOENT" || e.code === "ENOTDIR")
        return { state: "missing" };
      throw e;
    }
    const last = index === parts.length - 1;
    if (last ? !stat.isFile() : !stat.isDirectory()) return { state: "unsafe" };
  }
  const opened = await openInside(await realpath(root), current);
  if (!opened) return { state: "unsafe" };
  try {
    if (opened.size > limit) return { state: "unsafe" };
    return { state: "ok", data: await opened.handle.readFile() };
  } finally {
    await opened.handle.close();
  }
}

const hash = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");

async function readStored(file: string) {
  return readFile(file).catch((e: any) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
}

/** Writes below an existing store; never recreates a removed store. */
async function writeInStore(store: string, rel: string, data: string) {
  const file = path.join(store, rel);
  await mkdir(path.dirname(file), { mode: 0o700 }).catch((e: any) => {
    if (e.code !== "EEXIST") throw e;
  });
  const temp = file + ".tmp-" + randomUUID();
  await writeFile(temp, data, { mode: 0o600, flag: "wx" });
  await rename(temp, file);
}

function parse(data: Buffer) {
  try {
    return JSON.parse(data.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Copies session transcripts between profile-shaped trees. Only regular files
 * on allow-listed paths are copied; symlinks and special files are skipped.
 */
async function copySessions(
  from: string,
  to: string,
  only: (rel: string) => boolean = () => true,
) {
  const root = await realpath(from).catch(() => null);
  if (!root) return;
  const budget = { bytes: SESSION_TOTAL_LIMIT, entries: SESSION_ENTRY_COUNT };
  let skipped = 0;
  async function walk(rel: string) {
    let entries;
    try {
      entries = await readdir(rel ? path.join(root!, rel) : root!, {
        withFileTypes: true,
      });
    } catch (e: any) {
      if (e.code === "ENOENT" || e.code === "ENOTDIR") return;
      throw e;
    }
    for (const entry of entries) {
      if (--budget.entries < 0) {
        skipped++;
        return;
      }
      const child = rel ? rel + "/" + entry.name : entry.name;
      if (entry.isDirectory()) {
        if (sessionPath(child, true)) await walk(child);
        continue;
      }
      if (!entry.isFile() || !sessionPath(child) || !only(child)) continue;
      const opened = await openInside(root!, path.join(root!, child));
      if (!opened) continue;
      try {
        if (opened.size > SESSION_FILE_LIMIT || opened.size > budget.bytes) {
          skipped++;
          continue;
        }
        budget.bytes -= opened.size;
        const dest = path.join(to, child);
        await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
        await pipeline(
          opened.handle.createReadStream({ autoClose: false }),
          createWriteStream(dest, { mode: 0o600, flags: "wx" }),
        );
      } finally {
        await opened.handle.close();
      }
    }
  }
  await walk("");
  if (skipped)
    console.warn(
      `Session storage limit reached; ${skipped} transcript entries were not kept`,
    );
}

/** Replaces a directory with one built by fill, never leaving a partial copy. */
async function replaceDirectory(
  target: string,
  fill: (dir: string) => Promise<void>,
  stillWanted: () => Promise<boolean> = async () => true,
) {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const next = target + ".next-" + randomUUID();
  const old = target + ".old-" + randomUUID();
  try {
    await mkdir(next, { mode: 0o700 });
    await fill(next);
    await writeFile(path.join(next, GENERATION), randomUUID(), { mode: 0o600 });
    if (!(await stillWanted())) return;
    await rename(target, old).catch((e: any) => {
      if (e.code !== "ENOENT") throw e;
    });
    await rename(next, target);
  } finally {
    await rm(next, { recursive: true, force: true });
    await rm(old, { recursive: true, force: true });
  }
}

const generation = (store: string) =>
  readFile(path.join(store, GENERATION), "utf8").catch((e: any) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });

const exists = (file: string) =>
  lstat(file).then(
    () => true,
    (e: any) => {
      if (e.code === "ENOENT") return false;
      throw e;
    },
  );

/** One-time import of sign-in files from the former shared profile. */
async function migrateAuth(account: string) {
  const store = authStore(account);
  if (await exists(store)) return;
  const legacy = legacyProfile(account);
  await replaceDirectory(store, async (dir) => {
    if (!(await exists(legacy))) return;
    await mkdir(path.join(dir, ".claude"), { mode: 0o700 });
    await mkdir(path.join(dir, ".codex"), { mode: 0o700 });
    for (const item of AUTH_FILES) {
      for (const source of item.legacy) {
        const read = await readInside(legacy, source, item.limit);
        if (read.state !== "ok") continue;
        const clean = item.clean(parse(read.data));
        if (clean) {
          await writeInStore(dir, item.file, JSON.stringify(clean));
          break;
        }
      }
    }
  });
}

/** Imports only this chat's native session from the former shared profile. */
async function migrateSession(account: string, chat: string, session: string) {
  const store = sessionStore(account, chat);
  const legacy = legacyProfile(account);
  const id = session.toLowerCase();
  if (!isUuid(id) || (await exists(store)) || !(await exists(legacy))) return;
  await replaceDirectory(store, (dir) =>
    copySessions(legacy, dir, ofSession(id)),
  );
}

async function giveToRunner(dir: string) {
  if (process.getuid?.() !== 0) return;
  await chown(dir, RUNNER_UID, RUNNER_UID);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) await giveToRunner(child);
    else if (entry.isFile()) await chown(child, RUNNER_UID, RUNNER_UID);
  }
}

type Meta = {
  account: string;
  chat: string | null;
  /** A sign-in run may replace the provider account; other runs may not. */
  signIn: boolean;
  /** Store hashes when the run was seeded; copy-back is compare-and-swap. */
  seeded: Record<string, string | null>;
  generation: string | null;
  session: string | null;
};

export type ProfileRun = {
  /** Run id, also the Docker label used by recovery. */
  name: string;
  /** Host directory to mount at /profile. */
  dir: string;
  /**
   * Persists allow-listed state and discards the rest. Call only once the
   * container is gone. `session` is the chat's current native session; only
   * its transcript is kept. Resolves to false when nothing could be saved.
   */
  finish: (session?: string | null) => Promise<boolean>;
};

export async function prepareProfile(
  account: string,
  chat: string | null,
  options: { session?: string | null; signIn?: boolean } = {},
): Promise<ProfileRun> {
  await migrateAuth(account);
  if (chat && options.session)
    await migrateSession(account, chat, options.session);
  await mkdir(runRoot(), { recursive: true, mode: 0o700 });
  const name = randomUUID();
  const dir = path.join(runRoot(), name);
  const meta: Meta = {
    account,
    chat,
    signIn: !!options.signIn,
    seeded: {},
    generation: null,
    session: options.session?.toLowerCase() || null,
  };
  try {
    await mkdir(dir, { mode: 0o700 });
    await mkdir(path.join(dir, ".claude"), { mode: 0o700 });
    await mkdir(path.join(dir, ".codex"), { mode: 0o700 });
    for (const { file } of AUTH_FILES) {
      const data = await readStored(path.join(authStore(account), file));
      meta.seeded[file] = data ? hash(data) : null;
      if (data)
        await writeFile(path.join(dir, file), data, {
          mode: 0o600,
          flag: "wx",
        });
    }
    if (chat) {
      meta.generation = await generation(sessionStore(account, chat));
      await copySessions(sessionStore(account, chat), dir);
    }
    await giveToRunner(dir);
    await chmod(dir, 0o700);
    await writeFile(
      path.join(runRoot(), name + ".json"),
      JSON.stringify(meta),
      {
        mode: 0o600,
      },
    );
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  let finishing: Promise<boolean> | undefined;
  return {
    name,
    dir,
    finish: (session) => (finishing ??= finishRun(name, meta, session)),
  };
}

async function saveAuth(dir: string, meta: Meta) {
  const store = authStore(meta.account);
  const changes: { item: AuthFile; clean: Json | null }[] = [];
  const identities = new Map<string, string>();
  for (const item of AUTH_FILES) {
    const stored = await readStored(path.join(store, item.file));
    // Another run already changed this file; never overwrite it with an older view.
    if ((stored ? hash(stored) : null) !== meta.seeded[item.file]) continue;
    const read = await readInside(dir, item.file, item.limit);
    if (read.state === "unsafe") continue;
    if (read.state === "missing") {
      // Sign-out removes the file; mirror it.
      if (stored) changes.push({ item, clean: null });
      continue;
    }
    if (hash(read.data) === meta.seeded[item.file]) continue;
    const clean = item.clean(parse(read.data));
    if (!clean) continue;
    const before = stored ? item.identity?.(parse(stored) as Json) : undefined;
    const after = item.identity?.(clean);
    // Outside sign-in, a run must not switch the account to other credentials.
    if (
      !meta.signIn &&
      before !== undefined &&
      before !== after &&
      (item.strict || after !== undefined)
    ) {
      identities.set(item.file.split("/")[0], after ?? "none");
      continue;
    }
    changes.push({ item, clean });
  }
  for (const { item, clean } of changes) {
    // A rejected identity change on one Claude file rejects its pair as well.
    if (identities.has(item.file.split("/")[0])) continue;
    if (clean) await writeInStore(store, item.file, JSON.stringify(clean));
    else await rm(path.join(store, item.file), { force: true });
  }
  if (identities.size)
    console.warn(
      "Ignored provider credentials for a different account written during a run",
    );
}

async function finishRun(
  name: string,
  meta: Meta,
  session?: string | null,
): Promise<boolean> {
  const dir = path.join(runRoot(), name);
  try {
    // A deleted account must not be recreated by a late copy-back.
    if (!(await exists(authStore(meta.account)))) {
      await discardRun(name);
      return false;
    }
    await saveAuth(dir, meta);
    // A sign-in that left no usable credential did not succeed.
    if (meta.signIn) {
      const stored = await Promise.all(
        [".claude/.credentials.json", ".codex/auth.json"].map((f) =>
          exists(path.join(authStore(meta.account), f)),
        ),
      );
      if (!stored.some(Boolean)) {
        await discardRun(name);
        return false;
      }
    }
    const id = (session || meta.session || "").toLowerCase();
    if (meta.chat) {
      const store = sessionStore(meta.account, meta.chat);
      const unchanged = async () =>
        (await exists(authStore(meta.account))) &&
        (await generation(store)) === meta.generation;
      // A later run of this chat has already saved newer transcripts.
      if (await unchanged())
        await replaceDirectory(
          store,
          (next) =>
            copySessions(dir, next, isUuid(id) ? ofSession(id) : () => true),
          unchanged,
        );
    }
    await discardRun(name);
    return true;
  } catch (error) {
    // Keep the run directory and its metadata: startup recovery retries, so a
    // refreshed credential is not lost to a transient disk error.
    console.error("Could not save the account profile of a run", error);
    return false;
  }
}

async function discardRun(name: string) {
  await rm(path.join(runRoot(), name), { recursive: true, force: true });
  await rm(path.join(runRoot(), name + ".json"), { force: true });
}

/**
 * Finishes runs interrupted by a supervisor restart. `live` names runs whose
 * container could not be removed; those stay untouched until a later start.
 */
export async function recoverRunProfiles(live: Set<string> = new Set()) {
  let entries: string[];
  try {
    entries = await readdir(runRoot());
  } catch (e: any) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  for (const entry of entries.filter((e) => e.endsWith(".json"))) {
    const name = entry.slice(0, -5);
    if (live.has(name)) continue;
    let meta: Meta | undefined;
    try {
      meta = JSON.parse(await readFile(path.join(runRoot(), entry), "utf8"));
    } catch {}
    if (meta && isUuid(name)) await finishRun(name, meta);
    else await rm(path.join(runRoot(), entry), { force: true });
  }
  // Directories without metadata were never handed to a container.
  for (const entry of await readdir(runRoot())) {
    if (entry.endsWith(".json") || live.has(entry)) continue;
    if (!(await exists(path.join(runRoot(), entry + ".json"))))
      await rm(path.join(runRoot(), entry), { recursive: true, force: true });
  }
}

export async function removeAccountProfiles(account: string) {
  for (const dir of [
    authStore(account),
    sessionRoot(account),
    legacyProfile(account),
  ])
    await rm(dir, { recursive: true, force: true });
}

async function accountsWithSessions() {
  try {
    return await readdir(sessionsRoot());
  } catch (e: any) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

export async function removeChatSessions(chats: string[]) {
  for (const account of await accountsWithSessions())
    for (const chat of chats)
      await rm(sessionStore(account, chat), { recursive: true, force: true });
}

/** Startup sweep: drops transcripts of chats that no longer exist. */
export async function removeSessionsExcept(chats: Set<string>) {
  for (const account of await accountsWithSessions()) {
    const entries = await readdir(sessionRoot(account)).catch(() => []);
    for (const entry of entries)
      if (!chats.has(entry))
        await rm(path.join(sessionRoot(account), entry), {
          recursive: true,
          force: true,
        });
  }
}

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "./db.js";
import { config as serverConfig } from "./config.js";
import { seal, unseal } from "./security.js";

const exec = promisify(execFile);
const region = z
  .string()
  .trim()
  .regex(/^[a-z]{2}(?:-[a-z0-9]+){1,4}-\d{1,2}$/);
const settings = z.object({
  startUrl: z
    .string()
    .trim()
    .max(300)
    .url()
    .refine((value) => {
      const url = new URL(value);
      const host = url.hostname;
      const official =
        /^[a-z0-9-]+\.awsapps\.com(?:\.cn)?$/.test(host) ||
        /^ssoins-[a-z0-9-]+\.portal\.[a-z0-9-]+\.app\.aws$/.test(host) ||
        /^ssoins-[a-z0-9-]+\.[a-z0-9-]+\.portal\.amazonaws\.com$/.test(host) ||
        host === "identitycenter.amazonaws.com";
      return (
        official &&
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.port &&
        !url.search &&
        !url.hash &&
        /^\/[a-zA-Z0-9/_-]*$/.test(url.pathname)
      );
    }),
  ssoRegion: region,
  accountId: z
    .string()
    .trim()
    .regex(/^\d{12}$/),
  role: z
    .string()
    .trim()
    .regex(/^[\w+=,.@-]{1,64}$/),
  region,
  required: z.boolean().default(false),
});
type Settings = z.infer<typeof settings>;
type Connection = {
  settings: Settings;
  session: string | null;
  identity: string | null;
  generation: string | null;
};
type Login = {
  abort: AbortController;
  done: Promise<void>;
  challenge?: { url: string; code: string };
};
const logins = new Map<string, Login>();
const problems = new Map<string, string>();
const awsProfile = "workspace";

class AwsUnavailable extends Error {
  statusCode = 409;
}

class AwsDeviceCodeUnavailable extends Error {}

function httpError(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode });
}

async function connection(id: string): Promise<Connection | undefined> {
  return (
    await db.query(
      "SELECT settings,session,identity,generation FROM aws_connections WHERE project_id=$1",
      [id],
    )
  ).rows[0];
}

function awsEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    AWS_CONFIG_FILE: path.join(home, ".aws", "config"),
    AWS_SHARED_CREDENTIALS_FILE: path.join(home, ".aws", "credentials"),
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_MAX_ATTEMPTS: "2",
    PYTHONUNBUFFERED: "1",
  };
}

async function withProfile<T>(
  config: Settings,
  session: string | null,
  work: (home: string, cache: string) => Promise<T>,
) {
  const home = await mkdtemp(path.join(tmpdir(), "workspace-aws-"));
  try {
    const cache = path.join(home, ".aws", "sso", "cache");
    await mkdir(cache, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(home, ".aws", "config"),
      [
        "[profile workspace]",
        "sso_session = workspace",
        "sso_account_id = " + config.accountId,
        "sso_role_name = " + config.role,
        "region = " + config.region,
        "[sso-session workspace]",
        "sso_start_url = " + config.startUrl,
        "sso_region = " + config.ssoRegion,
        "sso_registration_scopes = sso:account:access",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    if (session) {
      const files = z
        .record(z.string().regex(/^[a-f0-9]{40}\.json$/), z.string())
        .parse(JSON.parse(unseal(session)));
      for (const [name, contents] of Object.entries(files))
        await writeFile(path.join(cache, name), contents, { mode: 0o600 });
    }
    return await work(home, cache);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function cacheSession(cache: string) {
  const files: Record<string, string> = {};
  for (const name of await readdir(cache)) {
    if (/^[a-f0-9]{40}\.json$/.test(name))
      files[name] = await readFile(path.join(cache, name), "utf8");
  }
  if (!Object.keys(files).length) throw new Error("Missing AWS SSO session");
  return JSON.stringify(files);
}

function runAws(home: string, args: string[], env = awsEnv(home)) {
  return exec("aws", ["--no-cli-pager", "--no-cli-auto-prompt", ...args], {
    cwd: home,
    env,
    timeout: 25_000,
    maxBuffer: 128 * 1024,
  });
}

function deviceChallenge(output: string) {
  // Use the manual verification URL, including any AWS request parameters.
  // The CLI prints the autofill URL separately, after the code.
  const match = output.match(
    /^(https:\/\/\S+)\r?\n(?:\r?\n)*Then enter the code:\r?\n(?:\r?\n)*([A-Z0-9]{4}-[A-Z0-9]{4})\r?\n/m,
  );
  if (!match) return;
  const [, url, code] = match;
  const parsed = URL.parse(url);
  if (parsed?.protocol === "https:" && !parsed.username && !parsed.password)
    return { url, code };
}

function deviceLogin(home: string, login: Login) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      "aws",
      [
        "sso",
        "login",
        "--profile",
        awsProfile,
        "--no-browser",
        "--use-device-code",
        "--no-cli-pager",
        "--no-cli-auto-prompt",
      ],
      { cwd: home, env: awsEnv(home), stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    const collect = (bytes: Buffer) => {
      output = (output + bytes.toString()).slice(-16_384);
      login.challenge ??= deviceChallenge(output);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const stop = () => child.kill("SIGKILL");
    const deadline = setTimeout(stop, 10 * 60_000);
    login.abort.signal.addEventListener("abort", stop, { once: true });
    if (login.abort.signal.aborted) stop();
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(deadline);
      login.abort.signal.removeEventListener("abort", stop);
      if (code === 0 && !login.abort.signal.aborted) resolve();
      else if (!login.challenge) reject(new AwsDeviceCodeUnavailable());
      else reject(new Error("AWS sign-in did not finish"));
    });
  });
}

async function credentials(home: string, config: Settings) {
  const { stdout } = await runAws(home, [
    "configure",
    "export-credentials",
    "--profile",
    awsProfile,
  ]);
  const result = z
    .object({
      AccessKeyId: z.string().regex(/^[A-Za-z0-9+/=]+$/),
      SecretAccessKey: z.string().regex(/^[A-Za-z0-9+/=]+$/),
      SessionToken: z.string().regex(/^[^\s\x00-\x1f\x7f]+$/),
      Expiration: z.string().refine((value) => Date.parse(value) > Date.now()),
    })
    .parse(JSON.parse(stdout));
  return {
    AWS_ACCESS_KEY_ID: result.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: result.SecretAccessKey,
    AWS_SESSION_TOKEN: result.SessionToken,
    AWS_REGION: config.region,
    AWS_DEFAULT_REGION: config.region,
    AWS_EC2_METADATA_DISABLED: "true",
  };
}

const pendingCredentials = new Map<string, ReturnType<typeof credentials>>();

async function projectCredentials(id: string) {
  const current = await connection(id);
  // Optional connections do not block local work before sign-in.
  if (!current?.session) {
    if (current?.settings.required)
      throw new AwsUnavailable(
        "AWS is required for this project. Sign in in Project settings → AWS access before starting a task or terminal.",
      );
    return null;
  }
  const session = current.session;
  let pending = pendingCredentials.get(session);
  if (!pending) {
    pending = withProfile(current.settings, session, async (home, cache) => {
      const env = await credentials(home, current.settings).catch(() => {
        throw new AwsUnavailable(
          "AWS access is unavailable. Check access or sign in again in Project settings → AWS access.",
        );
      });
      const updated = await cacheSession(cache);
      if (updated !== unseal(session))
        await db.query(
          "UPDATE aws_connections SET session=$3 WHERE project_id=$1 AND session=$2",
          [id, session, seal(updated)],
        );
      return env;
    }).finally(() => {
      pendingCredentials.delete(session);
    });
    pendingCredentials.set(session, pending);
  }
  const env = await pending.catch((error) => {
    if (error instanceof AwsUnavailable) problems.set(id, error.message);
    throw error;
  });
  const latest = await connection(id);
  if (latest?.generation !== current.generation || !latest?.session)
    throw httpError(
      "AWS access changed. Retry to use the current project connection.",
      409,
    );
  problems.delete(id);
  return env;
}

const runtimeAws = () => path.join(serverConfig.data, "aws-run-credentials");
const awsMount = "/run/workspace-aws";

export async function prepareAws(id: string | null) {
  const env = id ? await projectCredentials(id) : null;
  if (!env) return null;
  await mkdir(runtimeAws(), { recursive: true, mode: 0o700 });
  const source = await mkdtemp(path.join(runtimeAws(), "run-"));
  const stop = () => rm(source, { recursive: true, force: true });
  try {
    await chmod(source, 0o755);
    await writeFile(
      path.join(source, "config"),
      "[default]\nregion = " + env.AWS_REGION + "\n",
      { mode: 0o444 },
    );
    await writeFile(
      path.join(source, "credentials"),
      [
        "[default]",
        "aws_access_key_id = " + env.AWS_ACCESS_KEY_ID,
        "aws_secret_access_key = " + env.AWS_SECRET_ACCESS_KEY,
        "aws_session_token = " + env.AWS_SESSION_TOKEN,
        "",
      ].join("\n"),
      { mode: 0o444 },
    );
    return {
      mount: {
        Type: "bind" as const,
        Source: source,
        Target: awsMount,
        ReadOnly: true,
      },
      env: {
        AWS_CONFIG_FILE: awsMount + "/config",
        AWS_SHARED_CREDENTIALS_FILE: awsMount + "/credentials",
        AWS_PROFILE: "default",
        AWS_REGION: env.AWS_REGION,
        AWS_DEFAULT_REGION: env.AWS_DEFAULT_REGION,
        AWS_EC2_METADATA_DISABLED: env.AWS_EC2_METADATA_DISABLED,
      },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

export function cleanAwsCredentials() {
  return rm(runtimeAws(), { recursive: true, force: true });
}

export async function awsForRun(id: string | null) {
  try {
    return { access: await prepareAws(id), warning: "" };
  } catch (error) {
    // Database, storage and connection-change failures must not silently downgrade access.
    if (!(error instanceof AwsUnavailable) || !id) throw error;
    if ((await connection(id))?.settings.required) throw error;
    return {
      access: null,
      warning:
        "This run started without AWS access because the project connection is unavailable. Local work can continue. Sign in again in Project settings → AWS access and start a new run for AWS work.",
    };
  }
}

async function signIn(id: string, current: Connection, login: Login) {
  try {
    await withProfile(current.settings, null, async (home, cache) => {
      await deviceLogin(home, login);
      delete login.challenge;
      const env = await credentials(home, current.settings);
      const { stdout } = await runAws(
        home,
        ["sts", "get-caller-identity", "--output", "json"],
        {
          ...awsEnv(home),
          ...env,
        },
      );
      const identity = z
        .object({ Account: z.string(), Arn: z.string().max(2048) })
        .parse(JSON.parse(stdout));
      if (identity.Account !== current.settings.accountId)
        throw new Error("Unexpected AWS account");
      const token = seal(await cacheSession(cache));
      if (!login.abort.signal.aborted)
        await db.query(
          "UPDATE aws_connections SET session=$2,identity=$3,generation=$4 WHERE project_id=$1",
          [id, token, identity.Arn, randomUUID()],
        );
    });
  } catch (error) {
    if (!login.abort.signal.aborted)
      problems.set(
        id,
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "AWS CLI v2 is required on the Workspace server."
          : error instanceof AwsDeviceCodeUnavailable
            ? "Workspace could not get a sign-in code from AWS. Check the SSO start URL and Identity Center region, then try again."
            : "AWS sign-in could not be verified. Check the SSO URL, region and assigned role, then try again.",
      );
  } finally {
    logins.delete(id);
  }
}

export function awsRoutes(app: FastifyInstance) {
  const route = "/api/projects/:id/aws";
  async function project(req: { params: unknown }) {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!(await db.query("SELECT 1 FROM projects WHERE id=$1", [id])).rowCount)
      throw httpError("Project not found", 404);
    return id;
  }
  const busy = new Set<string>();
  async function edit<T>(id: string, change: () => Promise<T>) {
    if (busy.has(id))
      throw httpError("An AWS settings change is in progress.", 409);
    busy.add(id);
    try {
      return await change();
    } finally {
      busy.delete(id);
    }
  }
  const status = async (id: string) => {
    const current = await connection(id);
    const login = logins.get(id);
    return {
      settings: current?.settings ?? null,
      identity: current?.identity ?? null,
      pending: !!login,
      challenge: login?.challenge,
      problem: problems.get(id),
    };
  };
  app.addHook("onClose", async () => {
    for (const login of logins.values()) login.abort.abort();
    await Promise.all([...logins.values()].map((login) => login.done));
  });
  app.get(route, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return status(await project(req));
  });
  app.put(route, async (req) => {
    const id = await project(req);
    const config = settings.safeParse(req.body);
    if (!config.success)
      throw httpError(
        "Use the AWS-hosted SSO start URL or Issuer URL, valid AWS regions, a 12-digit account ID and your role name.",
        400,
      );
    return edit(id, async () => {
      if (logins.has(id))
        throw httpError("Cancel the current sign-in first.", 409);
      await db.query(
        `INSERT INTO aws_connections(project_id,settings) VALUES($1,$2)
        ON CONFLICT(project_id) DO UPDATE SET settings=EXCLUDED.settings,
          session=CASE WHEN aws_connections.settings - 'required' = EXCLUDED.settings - 'required' THEN aws_connections.session ELSE NULL END,
          identity=CASE WHEN aws_connections.settings - 'required' = EXCLUDED.settings - 'required' THEN aws_connections.identity ELSE NULL END,
          generation=CASE WHEN aws_connections.settings - 'required' = EXCLUDED.settings - 'required' THEN aws_connections.generation ELSE NULL END
        WHERE aws_connections.settings IS DISTINCT FROM EXCLUDED.settings`,
        [id, config.data],
      );
      problems.delete(id);
      return status(id);
    });
  });
  app.post(route + "/connect", async (req, reply) => {
    const id = await project(req);
    reply.header("Cache-Control", "no-store");
    return edit(id, async () => {
      if (!logins.has(id)) {
        const current = await connection(id);
        if (!current) throw httpError("Save your AWS settings first.", 409);
        problems.delete(id);
        const login: Login = {
          abort: new AbortController(),
          done: Promise.resolve(),
        };
        logins.set(id, login);
        login.done = signIn(id, current, login);
      }
      return status(id);
    });
  });
  app.post(route + "/check", async (req) => {
    const id = await project(req);
    try {
      await projectCredentials(id);
    } catch (error) {
      if (!problems.has(id)) throw error;
    }
    return status(id);
  });
  app.delete(route + "/connect", async (req) => {
    const id = await project(req);
    return edit(id, async () => {
      const login = logins.get(id);
      login?.abort.abort();
      await login?.done;
      return status(id);
    });
  });
  app.delete(route, async (req) => {
    const id = await project(req);
    return edit(id, async () => {
      if (logins.has(id))
        throw httpError("Cancel the current sign-in first.", 409);
      await db.query(
        "UPDATE aws_connections SET session=NULL,identity=NULL,generation=NULL WHERE project_id=$1",
        [id],
      );
      problems.delete(id);
      return status(id);
    });
  });
}

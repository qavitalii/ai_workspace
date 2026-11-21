import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { config, GiB } from "./config.js";
import type { ProjectEnvironmentInfo } from "../shared.js";
import { projectToolEnvironment } from "../project-tool-environment.js";
import { db } from "./db.js";
import { docker } from "./docker.js";
import { removeDockerResource } from "./docker-cleanup.js";
import { projectEnvLimitGib } from "./settings.js";

const bundledSystemPath =
  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const projectBinaries = [
  "/env/bin",
  "/env/npm-global/bin",
  "/env/python/bin",
  "/env/cargo/bin",
  "/env/go/bin",
].join(":");
const projectEnvRoot = () => path.join(config.data, "project-env");
const projectEnvPath = (projectId: string) =>
  path.join(projectEnvRoot(), projectId);

export async function prepareProjectEnv(
  projectId: string,
  { writable, imagePath }: { writable: boolean; imagePath?: string },
) {
  const source = projectEnvPath(projectId);
  await mkdir(source, { recursive: true, mode: 0o700 });
  // Only the project mount root needs server-side setup. Tools create their
  // own directories as UID 1000 inside the mount.
  const directory = await open(
    source,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await directory.chmod(0o700);
    if (process.getuid?.() === 0) await directory.chown(1000, 1000);
  } finally {
    await directory.close();
  }

  const projectPath = (imagePath || bundledSystemPath) + ":" + projectBinaries;
  return {
    mount: {
      Type: "bind" as const,
      Source: source,
      Target: "/env",
      ReadOnly: !writable,
    },
    env: {
      PATH: projectPath,
      WORKSPACE_PROJECT_TOOL_PATH: projectPath,
      ...projectToolEnvironment,
    },
  };
}

async function measureDirectory(source: string, image: string) {
  const container = await docker.createContainer({
    Image: image,
    User: "1000:1000",
    WorkingDir: "/",
    Entrypoint: ["/usr/bin/du"],
    Cmd: ["--one-file-system", "--summarize", "--block-size=1", "--", "/env"],
    Healthcheck: { Test: ["NONE"] },
    Tty: true,
    Labels: {
      "ai.workspace.managed": "true",
      "ai.workspace.instance": config.data,
    },
    HostConfig: {
      Mounts: [
        { Type: "bind", Source: source, Target: "/env", ReadOnly: true },
      ],
      NetworkMode: "none",
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Memory: 64 * 1024 ** 2,
      NanoCpus: 1e9,
      PidsLimit: 16,
      LogConfig: {
        Type: "json-file",
        Config: { "max-size": "64k", "max-file": "1" },
      },
    },
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await container.start();
    timeout = setTimeout(() => void container.kill().catch(() => {}), 30_000);
    if ((await container.wait()).StatusCode !== 0)
      throw new Error("Project environment measurement failed");
    const output = await container.logs({
      stdout: true,
      stderr: false,
      tail: 1,
    });
    const match = /^(\d+)\t\/env$/.exec(output.toString().trim());
    const bytes = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(bytes))
      throw new Error("Invalid project environment measurement");
    return bytes;
  } finally {
    clearTimeout(timeout);
    await removeDockerResource(() => container.remove({ force: true }));
  }
}

export async function measureProjectEnv(
  projectId: string,
  {
    fresh = false,
    image = config.image,
  }: { fresh?: boolean; image?: string } = {},
) {
  const measuredAt = new Date();
  const source = projectEnvPath(projectId);
  const directory = await lstat(source).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!directory) return 0;
  if (!directory.isDirectory())
    throw new Error("Invalid project environment directory");
  if (!fresh) {
    const { rows } = await db.query(
      "SELECT env_size_bytes FROM projects WHERE id=$1 AND env_measured_at >= now() - interval '30 seconds'",
      [projectId],
    );
    if (rows[0]?.env_size_bytes != null) return Number(rows[0].env_size_bytes);
  }
  const bytes = await measureDirectory(source, image);
  await db.query(
    "UPDATE projects SET env_size_bytes=$2,env_measured_at=$3 WHERE id=$1 AND (env_measured_at IS NULL OR env_measured_at <= $3)",
    [projectId, bytes, measuredAt],
  );
  return bytes;
}

async function projectToolsBusy(
  projectId: string,
  queryable: Pick<typeof db, "query"> = db,
) {
  const { rows } = await queryable.query<{ busy: boolean }>(
    `SELECT EXISTS (
      SELECT 1 FROM jobs j JOIN chats c ON c.id=j.chat_id
      JOIN workspaces w ON w.id=c.workspace_id
      WHERE w.project_id=p.id AND j.state IN ('running','waiting_approval')
    ) OR EXISTS (
      SELECT 1 FROM workspace_leases l JOIN workspaces w ON w.id=l.workspace_id
      WHERE w.project_id=p.id AND l.kind='terminal'
    ) AS busy FROM projects p WHERE p.id=$1`,
    [projectId],
  );
  if (!rows.length)
    throw Object.assign(new Error("Project not found"), { statusCode: 404 });
  return rows[0].busy;
}

export async function projectEnvironment(
  projectId: string,
  fresh = false,
): Promise<ProjectEnvironmentInfo> {
  const busy = await projectToolsBusy(projectId);
  const [limitGib, usedBytes] = await Promise.all([
    projectEnvLimitGib(),
    measureProjectEnv(projectId, { fresh }).catch(() => null),
  ]);
  const limitBytes = Math.round(limitGib * GiB);
  return {
    usedBytes,
    limitBytes,
    limitGib,
    busy,
    state:
      usedBytes === null
        ? "unavailable"
        : usedBytes > limitBytes
          ? "over-budget"
          : "ready",
  };
}

export async function clearProjectEnv(projectId: string) {
  const source = projectEnvPath(projectId);
  const staged = projectEnvPath(".cleared-" + randomUUID());
  const c = await db.connect();
  try {
    await c.query("SELECT pg_advisory_lock(417028)");
    if (
      (await projectToolsBusy(projectId, c)) ||
      (await hasMountedProjectEnv(source))
    )
      throw Object.assign(
        new Error(
          "Stop active tasks and close open terminals in this project before clearing tools.",
        ),
        { statusCode: 409 },
      );
    // Commit cache invalidation before detaching the directory. The session
    // lock keeps starts blocked until the rename, even across that commit.
    await c.query(
      "UPDATE projects SET env_size_bytes=NULL,env_measured_at=clock_timestamp() WHERE id=$1",
      [projectId],
    );
    try {
      await rename(source, staged);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  } finally {
    const unlocked = await c.query("SELECT pg_advisory_unlock(417028)").then(
      () => true,
      () => false,
    );
    c.release(!unlocked);
  }
  await rm(staged, { recursive: true, force: true }).catch((error) =>
    console.warn("Could not remove detached project tools", error),
  );
}

async function hasMountedProjectEnv(source: string) {
  const directory = await lstat(source).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!directory) return false;
  const containers = await docker.listContainers({
    abortSignal: AbortSignal.timeout(3_000),
    filters: JSON.stringify({
      label: [
        "ai.workspace.managed=true",
        "ai.workspace.instance=" + config.data,
      ],
    }),
  });
  return containers.some(
    (container) =>
      container.Labels["ai.workspace.chat"] &&
      container.Mounts.some(
        (mount) =>
          mount.Type === "bind" &&
          mount.Source === source &&
          mount.Destination === "/env",
      ),
  );
}

export async function recoverClearedProjectEnvs() {
  const entries = await readdir(projectEnvRoot()).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries)
    if (/^\.cleared-[0-9a-f-]{36}$/.test(entry))
      await rm(projectEnvPath(entry), { recursive: true, force: true });
}

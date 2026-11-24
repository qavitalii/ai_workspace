import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Docker from "dockerode";
import { packageBudgets } from "../runner/package-disk.js";
import { projectPackageNames } from "../runner/package-request.js";
import { config } from "./config.js";
import { db, transaction } from "./db.js";
import { docker } from "./docker.js";
import {
  pendingProjectPackageNames,
  projectPackagePresets,
} from "./project-packages.js";
import { redact } from "./security.js";
import { concurrentTasks } from "./settings.js";

const installerLabel = "ai.workspace.runner.package-installer";
const builderLabel = "ai.workspace.runner.project-image-builder";
const instanceLabel = "ai.workspace.instance";
const ownerLabel = "ai.workspace.env-owner";
const hashLabel = "ai.workspace.env-hash";
const baseLabel = "ai.workspace.base-image";
const imageIdPattern = /^sha256:[a-f0-9]{64}$/;
const maxLogLength = 32 * 1024;
const maxBuildEventLength = 1024 * 1024;
const buildTimeout = 5 * 60_000;
const retryDelay = 5_000;
const pruneInterval = 60_000;
const inspectOptions = { connectionTimeout: 10_000, timeout: 10_000 };
const imageDocker = new Docker(inspectOptions);

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function imageHash(base: string, packages: Iterable<string>) {
  return sha256(JSON.stringify([base, [...packages].sort()]));
}

function imageTag(hash: string, instance: string) {
  return `ai-workspace-env:${hash.slice(0, 12)}-${sha256(instance).slice(0, 12)}`;
}

async function inspectImage(tag: string) {
  try {
    return await imageDocker.getImage(tag).inspect();
  } catch (error: any) {
    if (error.statusCode !== 404) throw error;
    return null;
  }
}

async function buildImage(
  tag: string,
  base: string,
  packages: string[],
  concurrency: number,
  labels: Record<string, string>,
  signal: AbortSignal,
  appendLog: (text: string) => void,
) {
  if (!imageIdPattern.test(base))
    throw new Error("Invalid Workspace runner image ID.");
  if (!projectPackageNames(packages))
    throw new Error("Invalid project Debian package list.");

  const names = packages.map((name) => `'${name}'`).join(" ");
  const { run: budget } = packageBudgets(process.env);
  signal.throwIfAborted();
  const dockerfile = [
    `FROM ${base}`,
    // The classic builder can keep untagged layers from a completed RUN.
    `LABEL ${ownerLabel}=${labels[ownerLabel]} ${hashLabel}=${labels[hashLabel]} ${baseLabel}=${base}`,
    "USER root",
    `RUN WORKSPACE_PACKAGE_RUN_BUDGET=${budget} node /app/dist/node/runner/project-image-install.js ${concurrency} ${names} && rm -rf /var/lib/apt/lists/*`,
    "USER node",
    "",
  ].join("\n");
  const context = await mkdtemp(
    path.join(tmpdir(), "workspace-project-image-"),
  );
  try {
    await writeFile(path.join(context, "Dockerfile"), dockerfile);
    const stream = await docker.buildImage(
      { context, src: ["Dockerfile"] },
      {
        t: tag,
        // The classic builder can resolve the immutable local image ID.
        version: "1",
        pull: false,
        nocache: true,
        forcerm: true,
        labels,
        abortSignal: signal,
      },
    );
    stream.setEncoding("utf8");
    let partial = "";
    function consume(line: string) {
      if (!line.trim()) return;
      if (line.length > maxBuildEventLength)
        throw new Error("Docker returned an oversized build event.");
      const event = JSON.parse(line);
      const message = event.errorDetail?.message ?? event.error;
      if (typeof message === "string" && message) throw new Error(message);
      if (typeof event.stream === "string") appendLog(event.stream);
      else if (typeof event.status === "string") appendLog(event.status + "\n");
    }
    for await (const chunk of stream) {
      const lines = (partial + chunk).split("\n");
      partial = lines.pop()!;
      for (const line of lines) consume(line);
      if (partial.length > maxBuildEventLength)
        throw new Error("Docker returned an oversized build event.");
    }
    consume(partial);
  } finally {
    await rm(context, { recursive: true, force: true });
  }
}

type Build = {
  projectId: string;
  base: string;
  hash: string;
  abort: AbortController;
  done: Promise<void>;
};

type ImageRequest = { projectId: string; requestedAt: string };

async function clearRequest(
  c: Pick<typeof db, "query">,
  request: ImageRequest,
) {
  const { rowCount } = await c.query(
    `UPDATE projects SET package_image_requested_at=NULL
     WHERE id=$1 AND package_image_requested_at=$2::timestamptz`,
    [request.projectId, request.requestedAt],
  );
  return !!rowCount;
}

async function pruneProjectImages(signal: AbortSignal) {
  const instance = config.data;
  const owner = sha256(instance);
  const images = await imageDocker.listImages({
    all: true,
    filters: { label: [`${ownerLabel}=${owner}`] },
    abortSignal: signal,
  });
  if (!images.length) return;
  signal.throwIfAborted();
  const base = await inspectImage(config.image);
  const { rows } = await db.query<{ hash: string }>(
    "SELECT hash FROM project_images WHERE state IN ('building','ready')",
  );
  const retained = new Set(rows.map(({ hash }) => hash));
  if (base) {
    for (const names of await pendingProjectPackageNames()) {
      if (names.length) retained.add(imageHash(base.Id, names));
    }
  }
  const candidates = new Map(
    images
      .filter(({ Labels }) => {
        const hash = Labels?.[hashLabel];
        return (
          Labels?.[ownerLabel] === owner &&
          /^[a-f0-9]{64}$/.test(hash) &&
          imageIdPattern.test(Labels[baseLabel]) &&
          !retained.has(hash)
        );
      })
      .map((image) => [image.Id, image]),
  );
  if (!candidates.size) return;
  function depth(image: Docker.ImageInfo) {
    let depth = 0;
    let parent = candidates.get(image.ParentId);
    while (parent) {
      depth++;
      parent = candidates.get(parent.ParentId);
    }
    return depth;
  }
  // Remove children first. Use only the managed tag on tagged images, and
  // remove untagged build layers individually without pruning their parents.
  const ordered = [...candidates.values()].sort((a, b) => depth(b) - depth(a));
  for (const { Id, Labels, RepoTags, RepoDigests } of ordered) {
    signal.throwIfAborted();
    if (Id === base?.Id || Id === Labels[baseLabel]) continue;
    const tag = imageTag(Labels[hashLabel], instance);
    const managedTag = RepoTags?.includes(tag);
    const untagged =
      !RepoTags?.some((name) => name !== "<none>:<none>") &&
      !RepoDigests?.some((name) => name !== "<none>@<none>");
    if (!managedTag && !untagged) continue;
    try {
      await imageDocker
        .getImage(managedTag ? tag : Id)
        .remove({ force: false, noprune: true, abortSignal: signal });
    } catch (error: any) {
      if (error.statusCode !== 404 && error.statusCode !== 409) throw error;
    }
  }
}

async function foregroundBusy() {
  // The scheduler preempts builds as soon as it claims a runnable task.
  const { rows } = await db.query<{ busy: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM jobs WHERE state IN ('running','waiting_approval'))
         OR EXISTS(SELECT 1 FROM workspace_leases WHERE kind='terminal') AS busy`,
  );
  return rows[0].busy;
}

export class ProjectImageBuilds {
  private active?: Build;
  private polling?: { abort: AbortController; done: Promise<void> };
  private stopped = false;
  private retryAt = 0;
  private pruneAt = 0;

  async recover() {
    // Reconcile existing projects and interrupted builds against the current
    // runner at startup. Leave any queued requests in their original order.
    await db.query(
      `UPDATE projects p SET package_image_requested_at=clock_timestamp()
       WHERE package_image_requested_at IS NULL AND (
         EXISTS(SELECT 1 FROM project_packages pp WHERE pp.project_id=p.id AND NOT pp.disabled)
         OR EXISTS(SELECT 1 FROM project_images i WHERE i.project_id=p.id)
       )`,
    );
  }

  async tick(allowBuild = true) {
    if (!allowBuild) {
      this.active?.abort.abort();
      this.polling?.abort.abort();
    }
    if (
      this.stopped ||
      !allowBuild ||
      this.polling ||
      (!this.active && Date.now() < this.retryAt)
    )
      return;
    const abort = new AbortController();
    const done = this.poll(abort.signal)
      .catch((error) => {
        this.retryAt = Date.now() + retryDelay;
        throw error;
      })
      .finally(() => {
        this.polling = undefined;
      });
    this.polling = { abort, done };
    await done;
  }

  private async poll(signal: AbortSignal) {
    const busy = await foregroundBusy();
    if (signal.aborted) return;
    if (this.active) {
      const { projectId, base, hash, abort } = this.active;
      if (
        busy ||
        imageHash(base, (await projectPackagePresets(projectId)).keys()) !==
          hash
      )
        abort.abort();
      return;
    }
    if (busy) return;
    if (Date.now() >= this.pruneAt) {
      this.pruneAt = Date.now() + pruneInterval;
      try {
        await pruneProjectImages(signal);
      } catch (error) {
        if (!signal.aborted)
          console.error("Project image cleanup failed:", redact(String(error)));
      }
    }
    if (signal.aborted) return;
    const { rows } = await db.query<ImageRequest>(
      `SELECT id AS "projectId",package_image_requested_at::text AS "requestedAt"
       FROM projects WHERE package_image_requested_at IS NOT NULL
       ORDER BY package_image_requested_at,id LIMIT 1`,
    );
    const request = rows[0];
    if (!request || signal.aborted) return;
    const { projectId } = request;
    const packages = [
      ...(await projectPackagePresets(projectId)).keys(),
    ].sort();
    if (signal.aborted) return;
    if (!packages.length) {
      await transaction(async (c) => {
        if (await clearRequest(c, request))
          await c.query("DELETE FROM project_images WHERE project_id=$1", [
            projectId,
          ]);
      });
      this.pruneAt = 0;
      return;
    }
    const base = await imageDocker.getImage(config.image).inspect();
    if (signal.aborted) return;
    if ((await foregroundBusy()) || signal.aborted) return;
    const hash = imageHash(base.Id, packages);
    const abort = new AbortController();
    const done = this.build(
      request,
      base.Id,
      base.Config?.Labels,
      packages,
      hash,
      abort.signal,
    )
      .then(() => {
        this.pruneAt = 0;
      })
      .catch((error) => {
        this.retryAt = Date.now() + retryDelay;
        console.error("Project image build failed:", redact(String(error)));
      })
      .finally(() => {
        this.active = undefined;
      });
    this.active = { projectId, base: base.Id, hash, abort, done };
  }

  async stop() {
    this.stopped = true;
    this.active?.abort.abort();
    this.polling?.abort.abort();
    await Promise.allSettled([this.polling?.done, this.active?.done]);
  }

  private async build(
    request: ImageRequest,
    base: string,
    baseLabels: Record<string, string> | undefined,
    packages: string[],
    hash: string,
    signal: AbortSignal,
  ) {
    const { projectId } = request;
    const instance = config.data;
    // Separate installations may share a Docker daemon and runner base.
    const tag = imageTag(hash, instance);
    const labels = {
      [instanceLabel]: instance,
      [ownerLabel]: sha256(instance),
      [hashLabel]: hash,
      [baseLabel]: base,
      [installerLabel]: "1",
    };
    let imageId: string | null = null;
    let created: string | null = null;
    let failure: string | null = null;
    let log = "";
    const appendLog = (text: string) => {
      log = (log + redact(text.replaceAll("\0", ""))).slice(-maxLogLength);
    };
    if (signal.aborted) return;
    const supported = baseLabels?.[builderLabel] === "1";
    let image = supported ? await inspectImage(tag) : null;
    let concurrency = 0;
    if (supported && !image && !signal.aborted) {
      concurrency = await concurrentTasks();
      const { rowCount } = await db.query(
        `INSERT INTO project_images(project_id,hash,state)
         SELECT id,$3,'building' FROM projects
         WHERE id=$1 AND package_image_requested_at=$2::timestamptz
         FOR NO KEY UPDATE
         ON CONFLICT(project_id) DO UPDATE SET hash=$3,state='building',image_id=NULL,error=NULL,log='',built_at=NULL`,
        [projectId, request.requestedAt, hash],
      );
      if (!rowCount) return;
    }
    try {
      signal.throwIfAborted();
      if (!supported)
        throw new Error(
          "The runner image does not support building project images.",
        );
      if (!image) {
        const timeout = AbortSignal.timeout(buildTimeout);
        try {
          await buildImage(
            tag,
            base,
            packages,
            concurrency,
            labels,
            AbortSignal.any([signal, timeout]),
            appendLog,
          );
        } catch (error) {
          if (timeout.aborted)
            throw new Error("The project image build timed out.");
          throw error;
        }
      } else {
        appendLog("Reused an existing project image.\n");
      }
    } catch (error) {
      failure = redact(
        (error instanceof Error ? error.message : String(error)).replaceAll(
          "\0",
          "",
        ),
      ).slice(-2048);
    }

    if (signal.aborted) return;
    if (failure === null) {
      // An Engine error here leaves the request pending so the next tick can
      // inspect and reuse the already-built image.
      image ??= await inspectImage(tag);
      const imageLabels = image?.Config?.Labels;
      if (
        image?.Config?.User === "node" &&
        Object.entries(labels).every(
          ([name, value]) => imageLabels?.[name] === value,
        )
      ) {
        imageId = image.Id;
        created = image.Created;
      } else {
        failure = "Docker did not return the expected project image.";
      }
    }
    if (failure) appendLog("\n" + failure);
    if (signal.aborted) return;
    await transaction(async (c) => {
      // Clearing the exact request and publishing its result commit together.
      // A package edit locks the same project and supersedes the old request.
      if (!(await clearRequest(c, request))) return;
      await c.query(
        `INSERT INTO project_images(project_id,hash,image_id,state,error,log,built_at)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(project_id) DO UPDATE SET hash=$2,image_id=$3,state=$4,error=$5,log=$6,built_at=$7
         WHERE project_images.state<>'ready' OR project_images.hash<>$2 OR project_images.image_id IS DISTINCT FROM $3`,
        [
          projectId,
          hash,
          imageId,
          imageId ? "ready" : "failed",
          failure,
          log,
          created,
        ],
      );
    });
  }
}

export const projectImageBuilds = new ProjectImageBuilds();

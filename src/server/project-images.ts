import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Docker from "dockerode";
import { packageBudgetError, packageBudgets } from "../runner/package-disk.js";
import { projectPackageNames } from "../runner/package-request.js";
import { config, GiB } from "./config.js";
import { db, transaction } from "./db.js";
import { docker } from "./docker.js";
import { removeDockerResource } from "./docker-cleanup.js";
import {
  measureProjectEnv,
  ProjectEnvMeasurementError,
} from "./project-env.js";
import {
  pendingProjectPackageNames,
  projectPackagePresets,
} from "./project-packages.js";
import { redact } from "./security.js";
import { concurrentTasks, projectEnvLimitGib } from "./settings.js";
import { updatePhase } from "./updates.js";

const installerLabel = "ai.workspace.runner.package-installer";
const builderLabel = "ai.workspace.runner.project-image-builder";
const instanceLabel = "ai.workspace.instance";
const ownerLabel = "ai.workspace.env-owner";
const hashLabel = "ai.workspace.env-hash";
const baseLabel = "ai.workspace.base-image";
const installProgram = "node /app/dist/node/runner/project-image-install.js";
const imageIdPattern = /^sha256:[a-f0-9]{64}$/;
const maxLogLength = 32 * 1024;
const maxBuildEventLength = 1024 * 1024;
const buildTimeout = 5 * 60_000;
const retryDelay = 5_000;
const pruneInterval = 60_000;
const imageMaxAge = 7 * 24 * 60 * 60_000;
const transientDockerCodes = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOENT",
  "EPIPE",
  "ERR_STREAM_PREMATURE_CLOSE",
  "ETIMEDOUT",
]);
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

function imageLabels(base: string, hash: string) {
  return {
    [instanceLabel]: config.data,
    [ownerLabel]: sha256(config.data),
    [hashLabel]: hash,
    [baseLabel]: base,
    [installerLabel]: "1",
  };
}

function buildInstructions(labels: Record<string, string>, run: string | null) {
  return [
    // The classic builder can keep untagged layers from a completed RUN.
    `LABEL ${ownerLabel}=${labels[ownerLabel]} ${hashLabel}=${labels[hashLabel]} ${baseLabel}=${labels[baseLabel]}`,
    "USER root",
    run,
    "USER node",
  ];
}

function matchesFreshProjectImage(
  image: Docker.ImageInspectInfo | null,
  base: string,
  hash: string,
) {
  return (
    image?.Config?.User === "node" &&
    Date.parse(image.Created) > Date.now() - imageMaxAge &&
    Object.entries(imageLabels(base, hash)).every(
      ([name, value]) => image.Config.Labels?.[name] === value,
    )
  );
}

export function supportsProjectImages(base: Docker.ImageInspectInfo) {
  return base.Config?.Labels?.[builderLabel] === "1";
}

export async function queueProjectImage(projectId: string) {
  // Keep the original queue position and leave an active build's request intact.
  await db.query(
    `UPDATE projects SET package_image_requested_at=clock_timestamp()
     WHERE id=$1 AND package_image_requested_at IS NULL`,
    [projectId],
  );
}

export async function findProjectImage(
  projectId: string,
  base: Docker.ImageInspectInfo,
  packages: Iterable<string>,
  budget: number,
) {
  const hash = imageHash(base.Id, packages);
  const { rows } = await db.query<{
    image_id: string | null;
    state: "building" | "ready" | "failed";
    failed_budget_bytes: string | null;
    failed_env_measurement: boolean;
  }>(
    "SELECT image_id,state,failed_budget_bytes,failed_env_measurement FROM project_images WHERE project_id=$1 AND hash=$2",
    [projectId, hash],
  );
  const cached = rows[0];
  const id = cached?.state === "ready" ? cached.image_id : null;
  const candidates = [
    ...(id && imageIdPattern.test(id) && id !== base.Id ? [id] : []),
    imageTag(hash, config.data),
  ];
  let oversized = false;
  for (const candidate of candidates) {
    const image = await inspectImage(candidate);
    if (
      image &&
      imageIdPattern.test(image.Id) &&
      image.Id !== base.Id &&
      (candidate !== id || image.Id === id) &&
      matchesFreshProjectImage(image, base.Id, hash)
    ) {
      // Only the additional layers count towards project storage. A shared
      // image can fit even when this project's build needed too much APT space.
      const bytes = image.Size - base.Size;
      if (Number.isSafeInteger(bytes) && bytes >= 0) {
        if (bytes > budget) {
          oversized = true;
          continue;
        }
        // Publish the shared image for this project on the next worker tick.
        // The queued package list also protects it from image cleanup.
        if (candidate !== id) await queueProjectImage(projectId);
        return image.Id;
      }
    }
  }
  if (oversized) return;
  // Launches only reach selection after successfully measuring /env. Retry a
  // failed measurement now that the environment is readable again.
  if (cached?.state === "failed" && !cached.failed_env_measurement) {
    if (cached.failed_budget_bytes === null) return;
    const buildBudget = Math.min(budget, packageBudgets(process.env).run);
    if (buildBudget <= Number(cached.failed_budget_bytes)) return;
  }
  await queueProjectImage(projectId);
}

async function inspectImage(tag: string) {
  try {
    return await imageDocker.getImage(tag).inspect();
  } catch (error: any) {
    if (error.statusCode !== 404) throw error;
    return null;
  }
}

function isTransientDockerError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const { statusCode, code } = error as Error & {
    statusCode?: number;
    code?: string;
  };
  return (
    statusCode === 408 ||
    statusCode === 429 ||
    (statusCode !== undefined && statusCode >= 500 && statusCode < 600) ||
    (code !== undefined && transientDockerCodes.has(code))
  );
}

async function buildImage(
  tag: string,
  base: string,
  packages: string[],
  concurrency: number,
  budget: number,
  labels: Record<string, string>,
  signal: AbortSignal,
  timeout: AbortSignal,
  shutdown: AbortSignal,
  appendLog: (text: string) => void,
) {
  if (!imageIdPattern.test(base))
    throw new Error("Invalid Workspace runner image ID.");
  if (!projectPackageNames(packages))
    throw new Error("Invalid project Debian package list.");

  const names = packages.map((name) => `'${name}'`).join(" ");
  signal.throwIfAborted();
  const dockerfile = [
    `FROM ${base}`,
    ...buildInstructions(
      labels,
      `RUN WORKSPACE_PACKAGE_RUN_BUDGET=${budget} ${installProgram} ${concurrency} ${names} && rm -rf /var/lib/apt/lists/*`,
    ),
    "",
  ].join("\n");
  const context = await mkdtemp(
    path.join(tmpdir(), "workspace-project-image-"),
  );
  const finished = new AbortController();
  const cancel = AbortSignal.any([signal, timeout]);
  let draining: Promise<void> | undefined;
  function onCancel() {
    draining = drainCancelledBuild(
      labels[hashLabel],
      finished.signal,
      shutdown,
    );
  }
  try {
    await writeFile(path.join(context, "Dockerfile"), dockerfile);
    cancel.throwIfAborted();
    cancel.addEventListener("abort", onCancel, { once: true });
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
        // Preemption and the deadline stop the installer. Keep the response
        // open until Docker finishes, even if its first RUN is still pending.
        abortSignal: shutdown,
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
      if (cancel.aborted) continue;
      const lines = (partial + chunk).split("\n");
      partial = lines.pop()!;
      for (const line of lines) consume(line);
      if (partial.length > maxBuildEventLength)
        throw new Error("Docker returned an oversized build event.");
    }
    cancel.throwIfAborted();
    consume(partial);
  } finally {
    cancel.removeEventListener("abort", onCancel);
    finished.abort();
    await draining;
    await rm(context, { recursive: true, force: true });
  }
}

async function drainCancelledBuild(
  hash: string,
  finished: AbortSignal,
  shutdown: AbortSignal,
) {
  for (;;) {
    // A build can create another intermediate after a scan. Do the final
    // scan only once the build response has settled.
    const finalScan = finished.aborted;
    try {
      await cleanBuildContainers(hash);
      if (finalScan) return;
    } catch (error) {
      console.error("Cancelled build cleanup failed:", redact(String(error)));
      // Startup recovers remaining containers if the daemon is offline at exit.
      if (shutdown.aborted) return;
      await delay(retryDelay);
      continue;
    }
    await delay(100);
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

async function pruneProjectImages(baseId: string, signal?: AbortSignal) {
  const instance = config.data;
  const owner = sha256(instance);
  const images = await imageDocker.listImages({
    all: true,
    filters: { label: [`${ownerLabel}=${owner}`] },
    abortSignal: signal,
  });
  if (!images.length) return;
  signal?.throwIfAborted();
  const { rows } = await db.query<{
    hash: string;
    image_id: string | null;
    state: "building" | "ready";
  }>(
    "SELECT hash,image_id,state FROM project_images WHERE state IN ('building','ready')",
  );
  const pending = new Set<string>();
  const retained = new Set<string>();
  const byId = new Map(images.map((image) => [image.Id, image]));
  function retain(id: string) {
    while (id && !retained.has(id)) {
      retained.add(id);
      id = byId.get(id)?.ParentId ?? "";
    }
  }
  retain(baseId);
  for (const { hash, image_id, state } of rows) {
    if (state === "building") pending.add(hash);
    if (image_id) retain(image_id);
  }
  for (const names of await pendingProjectPackageNames()) {
    if (names.length) pending.add(imageHash(baseId, names));
  }
  // A request can reuse a tagged image left by an interrupted build. An
  // untagged layer with the same hash may belong to a different build.
  for (const { Id, Labels, RepoTags } of images) {
    const hash = Labels?.[hashLabel];
    if (pending.has(hash) && RepoTags?.includes(imageTag(hash, instance)))
      retain(Id);
  }
  const candidates = new Map(
    images
      .filter(({ Id, Labels }) => {
        const hash = Labels?.[hashLabel];
        return (
          Labels?.[ownerLabel] === owner &&
          /^[a-f0-9]{64}$/.test(hash) &&
          imageIdPattern.test(Labels[baseLabel]) &&
          !retained.has(Id)
        );
      })
      .map((image) => [image.Id, image]),
  );
  if (!candidates.size) return;
  // Even a stopped or externally created container may still need its tag.
  for (const container of await imageDocker.listContainers({
    all: true,
    abortSignal: signal,
  }))
    retain(container.ImageID);
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
    signal?.throwIfAborted();
    if (retained.has(Id) || Id === Labels[baseLabel]) continue;
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

function matchesInstallCommand(command: string, base: string, hash: string) {
  const parts = command.split(` ${installProgram} `);
  if (
    parts.length !== 2 ||
    !/^WORKSPACE_PACKAGE_RUN_BUDGET=\d+$/.test(parts[0])
  )
    return false;
  const args = /^\d+ '(.+)' && rm -rf \/var\/lib\/apt\/lists\/\*$/.exec(
    parts[1],
  );
  const names = args && projectPackageNames(args[1].split("' '"));
  return !!names && imageHash(base, names) === hash;
}

async function isBuildContainer(
  info: Docker.ContainerInspectInfo,
  base: string,
  hash: string,
) {
  const { Shell } = info.Config as Docker.ContainerCreateOptions;
  const shell = Shell?.length ? Shell : ["/bin/sh", "-c"];
  const cmd = info.Config.Cmd ?? [];
  if (!shell.every((arg, i) => cmd[i] === arg)) return false;
  const args = cmd.slice(shell.length);
  const metadata =
    args.length === 2 &&
    args[0] === "#(nop) " &&
    (info.State.Status === "created" || info.State.Status === "removing");
  if (
    !metadata &&
    (args.length !== 1 || !matchesInstallCommand(args[0], base, hash))
  )
    return false;

  const labels = imageLabels(base, hash);
  // Docker appends the build-option labels in key order after the Dockerfile.
  const steps = [
    ...buildInstructions(labels, null),
    ...Object.entries(labels)
      .map(([key, value]) => `LABEL ${key}=${value}`)
      .sort(),
  ];
  const step = steps.indexOf(metadata ? args[1] : null);
  if (step < 0) return false;
  const history: { Id: string; CreatedBy: string }[] = await imageDocker
    .getImage(info.Image)
    .history()
    .catch((error) => {
      if (error.statusCode !== 404) throw error;
      return [];
    });
  // History is newest first. Each committed ONBUILD trigger in FROM adds a
  // layer before our first LABEL. A downstream build also contains the
  // finished Workspace layers between its own instructions and that same ID.
  const depth = history.findIndex(({ Id }) => Id === base);
  if (depth < step) return false;
  const runner = await inspectImage(base);
  if (depth - step !== (runner?.Config?.OnBuild?.length ?? 0)) return false;
  const prefix = shell.join(" ") + " ";
  return history.slice(0, step).every(({ CreatedBy }, i) => {
    const expected = steps[step - 1 - i];
    if (expected === null) {
      // The classic builder prepends "|N key=value ..." to a committed RUN
      // when the base declared build arguments. Config.Cmd has no prefix.
      const start = CreatedBy.lastIndexOf(
        `${prefix}WORKSPACE_PACKAGE_RUN_BUDGET=`,
      );
      return (
        start >= 0 &&
        (start === 0 || /^\|\d+ [\s\S]* $/.test(CreatedBy.slice(0, start))) &&
        matchesInstallCommand(
          CreatedBy.slice(start + prefix.length),
          base,
          hash,
        )
      );
    }
    return CreatedBy === `${prefix}#(nop)  ${expected}`;
  });
}

async function cleanBuildContainers(hash?: string) {
  const owner = sha256(config.data);
  const filter = [`${ownerLabel}=${owner}`];
  if (hash) filter.push(`${hashLabel}=${hash}`);
  // The classic builder's intermediate containers inherit the owner label.
  // Finished project images also carry it, including in external containers.
  for (const { Id, Labels, Command } of await imageDocker.listContainers({
    all: true,
    filters: { label: filter },
  })) {
    if (
      Labels?.[ownerLabel] !== owner ||
      (hash !== undefined && Labels[hashLabel] !== hash) ||
      !imageIdPattern.test(Labels[baseLabel]) ||
      !/^[a-f0-9]{64}$/.test(Labels[hashLabel]) ||
      (!Command.includes("#(nop)") && !Command.includes(installProgram))
    )
      continue;
    const container = imageDocker.getContainer(Id);
    const info = await container.inspect().catch((error) => {
      if (error.statusCode !== 404) throw error;
      return null;
    });
    if (
      !info ||
      !(await isBuildContainer(info, Labels[baseLabel], Labels[hashLabel]))
    )
      continue;
    await removeDockerResource(() =>
      container.remove({ force: true, v: true }),
    );
  }
}

export async function cleanProjectImageOrphans() {
  await cleanBuildContainers();
  // The idle worker retries image GC. Orphan container removal above must
  // finish before the scheduler can admit another build.
  try {
    const base = await inspectImage(config.image);
    if (base) await pruneProjectImages(base.Id);
  } catch (error) {
    console.error("Project image cleanup failed:", redact(String(error)));
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
  private readonly shutdown = new AbortController();
  private retryAt = 0;
  private pruneAt = 0;
  private baseId?: string;

  get busy() {
    return Boolean(this.polling || this.active);
  }

  async recover() {
    // Reconcile existing projects after startup or a runner replacement.
    // Keep queued requests in order. The idle scan reconciles failures once
    // it knows whether the base changed or the weekly retry is due.
    await db.query(
      `UPDATE projects p SET package_image_requested_at=clock_timestamp()
       WHERE package_image_requested_at IS NULL AND NOT EXISTS(
         SELECT 1 FROM project_images i WHERE i.project_id=p.id AND i.state='failed'
       ) AND (
         EXISTS(SELECT 1 FROM project_packages pp WHERE pp.project_id=p.id AND NOT pp.disabled)
         OR EXISTS(SELECT 1 FROM project_images i WHERE i.project_id=p.id)
       )`,
    );
  }

  private async inspectBase(signal: AbortSignal) {
    const base = await inspectImage(config.image);
    if (base && !signal.aborted && base.Id !== this.baseId) {
      if (this.baseId !== undefined) await this.recover();
      this.baseId = base.Id;
    }
    return base;
  }

  async tick(allowBuild = true) {
    if (!allowBuild) {
      this.active?.abort.abort();
      this.polling?.abort.abort();
    }
    if (
      this.shutdown.signal.aborted ||
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
    // An already-running scheduler iteration can reach this poll after the
    // update probe. Read the phase while the poll is visible to that probe.
    const phase = await updatePhase();
    if (signal.aborted || phase === "waiting" || phase === "updating") return;
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
    let base: Docker.ImageInspectInfo | null | undefined;
    if (Date.now() >= this.pruneAt) {
      this.pruneAt = Date.now() + pruneInterval;
      try {
        base = await this.inspectBase(signal);
        if (base && !signal.aborted) {
          // Queue existing installations even when nobody opens the project.
          // Keep the original timestamp of any request already in progress.
          await db.query(
            `UPDATE projects p SET package_image_requested_at=clock_timestamp()
             FROM project_images i WHERE i.project_id=p.id
             AND ((i.state='ready' AND (i.built_at IS NULL OR i.built_at <= $1))
               OR (i.state='failed' AND (i.failed_at IS NULL OR i.failed_at <= $1
                 OR i.failed_base_id IS DISTINCT FROM $2)))
             AND p.package_image_requested_at IS NULL`,
            [new Date(Date.now() - imageMaxAge), base.Id],
          );
          await pruneProjectImages(base.Id, signal);
        }
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
    if (base === undefined) base = await this.inspectBase(signal);
    if (signal.aborted) return;
    if (!base) throw new Error("The Workspace runner image is missing.");
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
    this.shutdown.abort();
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
    const labels = imageLabels(base, hash);
    let imageId: string | null = null;
    let created: string | null = null;
    let failure: string | null = null;
    let failedBudget: number | null = null;
    let log = "";
    const appendLog = (text: string) => {
      log = (log + redact(text.replaceAll("\0", ""))).slice(-maxLogLength);
    };
    if (signal.aborted) return;
    const supported = baseLabels?.[builderLabel] === "1";
    let image = supported ? await inspectImage(tag) : null;
    if (!matchesFreshProjectImage(image, base, hash)) image = null;
    let concurrency = 0;
    let runBudget = 0;
    let budget = 0;
    let measurementFailure: ProjectEnvMeasurementError | undefined;
    if (supported && !image && !signal.aborted) {
      concurrency = await concurrentTasks();
      const { rowCount } = await db.query(
        `INSERT INTO project_images(project_id,hash,state)
         SELECT id,$3,'building' FROM projects
         WHERE id=$1 AND package_image_requested_at=$2::timestamptz
         FOR NO KEY UPDATE
         ON CONFLICT(project_id) DO UPDATE SET hash=$3,state='building',image_id=NULL,error=NULL,log='',built_at=NULL,failed_budget_bytes=NULL,failed_env_measurement=false,failed_at=NULL,failed_base_id=NULL`,
        [projectId, request.requestedAt, hash],
      );
      if (!rowCount) return;
      // Preparation failures leave the request pending for the worker retry.
      // Measurement failures clear the request so other projects can proceed.
      // A later launch can queue it again after a successful measurement.
      const [envBytes, limitGib] = await Promise.all([
        measureProjectEnv(projectId, { fresh: true, image: base }).catch(
          (error) => {
            if (!(error instanceof ProjectEnvMeasurementError)) throw error;
            measurementFailure = error;
            return 0;
          },
        ),
        projectEnvLimitGib(),
      ]);
      const projectLimit = Math.round(limitGib * GiB);
      const { run, preset } = packageBudgets(process.env, projectLimit);
      runBudget = run;
      budget = Math.min(run, preset, projectLimit - envBytes);
      if (signal.aborted || (await foregroundBusy())) return;
    }
    try {
      signal.throwIfAborted();
      if (measurementFailure) throw measurementFailure;
      if (!supported)
        throw new Error(
          "The runner image does not support building project images.",
        );
      if (!image) {
        if (budget <= 0) {
          failedBudget = 0;
          throw new Error(
            "No project tool storage is available for Debian packages.",
          );
        }
        // The runner reserves its build budget per slot. Round up to preserve
        // the full run budget for each foreground slot when the build cap is lower.
        const buildBudget = BigInt(budget);
        const reservedSlots =
          (BigInt(concurrency) * BigInt(runBudget) + buildBudget - 1n) /
          buildBudget;
        if (reservedSlots >= BigInt(Number.MAX_SAFE_INTEGER))
          throw new Error("The project image disk reservation is too large.");
        const timeout = AbortSignal.timeout(buildTimeout);
        try {
          await buildImage(
            tag,
            base,
            packages,
            Number(reservedSlots),
            budget,
            labels,
            signal,
            timeout,
            this.shutdown.signal,
            appendLog,
          );
        } catch (error) {
          if (timeout.aborted)
            throw new Error("The project image build timed out.");
          // The installer in the base image reports its budget rejection in
          // the Docker build stream. Other build errors wait for the weekly
          // retry unless a new request is queued explicitly.
          if (log.includes(packageBudgetError("run", budget)))
            failedBudget = budget;
          throw error;
        }
      } else {
        appendLog("Reused an existing project image.\n");
      }
    } catch (error) {
      if (signal.aborted) return;
      if (isTransientDockerError(error)) throw error;
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
      if (image && matchesFreshProjectImage(image, base, hash)) {
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
        `INSERT INTO project_images(project_id,hash,image_id,state,error,log,built_at,failed_budget_bytes,failed_env_measurement,failed_at,failed_base_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $4='failed' THEN clock_timestamp() END,$10)
         ON CONFLICT(project_id) DO UPDATE SET hash=$2,image_id=$3,state=$4,error=$5,log=$6,built_at=$7,failed_budget_bytes=$8,failed_env_measurement=$9,failed_at=excluded.failed_at,failed_base_id=excluded.failed_base_id
         WHERE project_images.state<>'ready' OR project_images.hash<>$2 OR project_images.image_id IS DISTINCT FROM $3
            OR project_images.built_at IS DISTINCT FROM excluded.built_at`,
        [
          projectId,
          hash,
          imageId,
          imageId ? "ready" : "failed",
          failure,
          log,
          created,
          failedBudget,
          Boolean(measurementFailure),
          imageId ? null : base,
        ],
      );
    });
  }
}

export const projectImageBuilds = new ProjectImageBuilds();

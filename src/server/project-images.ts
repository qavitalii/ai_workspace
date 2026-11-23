import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Docker from "dockerode";
import {
  exactPackagePattern,
  projectPackageNames,
} from "../runner/package-request.js";
import { config } from "./config.js";
import { db, transaction } from "./db.js";
import { docker } from "./docker.js";
import { projectPackagePresets } from "./project-packages.js";
import { redact } from "./security.js";

const installerLabel = "ai.workspace.runner.package-installer";
const maxLogLength = 32 * 1024;
const maxBuildEventLength = 1024 * 1024;
const buildTimeout = 5 * 60_000;
const inspectOptions = { connectionTimeout: 10_000, timeout: 10_000 };
const imageDocker = new Docker(inspectOptions);

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function imageHash(base: string, packages: Iterable<string>) {
  return sha256(JSON.stringify([base, [...packages].sort()]));
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
  labels: Record<string, string>,
  signal: AbortSignal,
  appendLog: (text: string) => void,
) {
  if (!/^sha256:[a-f0-9]{64}$/.test(base))
    throw new Error("Invalid Workspace runner image ID.");
  if (!projectPackageNames(packages))
    throw new Error("Invalid project Debian package list.");

  const sources =
    "-o Dir::Etc::sourcelist=/etc/workspace-install/debian.sources -o Dir::Etc::sourceparts=-";
  const names = packages.map((name) => `'${name}'`).join(" ");
  const patterns = packages
    .map((name) => `'${exactPackagePattern(name)}'`)
    .join(" ");
  const status = "${db:Status-Status}";
  const commands = [
    `apt-get ${sources} -o APT::Update::Error-Mode=any update`,
    `DEBIAN_FRONTEND=noninteractive apt-get ${sources} install -y --no-install-recommends --no-remove -- ${patterns}`,
    `for name in ${names}; do test "$(dpkg-query -W -f '${status}' -- "$name")" = installed || { echo "Package was not installed: $name" >&2; exit 1; }; done`,
    "rm -rf /var/lib/apt/lists/*",
  ];
  const dockerfile = [
    `FROM ${base}`,
    "USER root",
    `RUN ${commands.join(" && " + "\\" + "\n    ")}`,
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

async function foregroundBusy() {
  const { rows } = await db.query<{ busy: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM jobs WHERE state IN ('queued','running','waiting_approval'))
         OR EXISTS(SELECT 1 FROM workspace_leases WHERE kind='terminal') AS busy`,
  );
  return rows[0].busy;
}

export class ProjectImageBuilds {
  private readonly pending = new Set<string>();
  private active?: Build;
  private polling?: Promise<void>;
  private allowBuild = true;
  private stopped = false;

  request(projectId: string) {
    if (!this.stopped && this.active?.projectId !== projectId)
      this.pending.add(projectId);
  }

  async tick(allowBuild = true) {
    this.allowBuild = allowBuild;
    if (!allowBuild) this.active?.abort.abort();
    if (
      this.stopped ||
      !allowBuild ||
      this.polling ||
      (!this.active && !this.pending.size)
    )
      return;
    this.polling = this.poll().finally(() => {
      this.polling = undefined;
    });
    await this.polling;
  }

  private async poll() {
    const busy = await foregroundBusy();
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
    if (busy || !this.allowBuild || this.stopped) return;
    const projectId = this.pending.values().next().value;
    if (projectId === undefined) return;
    const packages = [
      ...(await projectPackagePresets(projectId)).keys(),
    ].sort();
    if (!packages.length) {
      this.pending.delete(projectId);
      await db.query("DELETE FROM project_images WHERE project_id=$1", [
        projectId,
      ]);
      return;
    }
    const base = await imageDocker.getImage(config.image).inspect();
    if ((await foregroundBusy()) || this.stopped || !this.allowBuild) return;
    const hash = imageHash(base.Id, packages);
    this.pending.delete(projectId);
    const abort = new AbortController();
    const done = this.build(
      projectId,
      base.Id,
      base.Config?.Labels,
      packages,
      hash,
      abort.signal,
    )
      .then((retry) => {
        if (retry && !this.stopped) this.pending.add(projectId);
      })
      .catch((error) =>
        console.error("Project image build failed:", redact(String(error))),
      )
      .finally(() => {
        this.active = undefined;
      });
    this.active = { projectId, base: base.Id, hash, abort, done };
  }

  async stop() {
    this.stopped = true;
    this.pending.clear();
    this.active?.abort.abort();
    await Promise.allSettled([this.polling, this.active?.done]);
  }

  private async build(
    projectId: string,
    base: string,
    baseLabels: Record<string, string> | undefined,
    packages: string[],
    hash: string,
    signal: AbortSignal,
  ) {
    const instance = config.data;
    // Separate installations may share a Docker daemon and runner base.
    const tag = `ai-workspace-env:${hash.slice(0, 12)}-${sha256(instance).slice(0, 12)}`;
    const labels = {
      "ai.workspace.instance": instance,
      "ai.workspace.env-hash": hash,
      "ai.workspace.base-image": base,
      [installerLabel]: "1",
    };
    let imageId: string | null = null;
    let created: string | null = null;
    let failure: string | null = null;
    let log = "";
    const appendLog = (text: string) => {
      log = (log + redact(text.replaceAll("\0", ""))).slice(-maxLogLength);
    };
    try {
      signal.throwIfAborted();
      if (baseLabels?.[installerLabel] !== "1")
        throw new Error(
          "The runner image does not support Debian package installation.",
        );
      let image = await inspectImage(tag);
      if (!image) {
        signal.throwIfAborted();
        const requested = await db.query(
          `INSERT INTO project_images(project_id,hash,state)
           SELECT id,$2,'building' FROM projects WHERE id=$1
           ON CONFLICT(project_id) DO UPDATE SET hash=$2,state='building',image_id=NULL,error=NULL,log='',built_at=NULL
           RETURNING project_id`,
          [projectId, hash],
        );
        if (!requested.rowCount) return false;
        const timeout = AbortSignal.timeout(buildTimeout);
        try {
          await buildImage(
            tag,
            base,
            packages,
            labels,
            AbortSignal.any([signal, timeout]),
            appendLog,
          );
        } catch (error) {
          if (timeout.aborted)
            throw new Error("The project image build timed out.");
          throw error;
        }
        image = await inspectImage(tag);
      } else {
        appendLog("Reused an existing project image.\n");
      }
      if (
        !image ||
        image.Config.User !== "node" ||
        Object.entries(labels).some(
          ([name, value]) => image.Config.Labels?.[name] !== value,
        )
      )
        throw new Error("Docker did not return the expected project image.");
      imageId = image.Id;
      created = image.Created;
    } catch (error) {
      failure = redact(
        (error instanceof Error ? error.message : String(error)).replaceAll(
          "\0",
          "",
        ),
      ).slice(-2048);
      appendLog("\n" + failure);
    }

    return transaction(async (c) => {
      // Package edits lock the same project row. An obsolete result must never
      // be published after the new list commits.
      const project = await c.query(
        "SELECT id FROM projects WHERE id=$1 FOR NO KEY UPDATE",
        [projectId],
      );
      if (!project.rowCount) return false;
      const current = await projectPackagePresets(projectId, c);
      if (signal.aborted || imageHash(base, current.keys()) !== hash) {
        await c.query(
          "DELETE FROM project_images WHERE project_id=$1 AND hash=$2 AND state='building'",
          [projectId, hash],
        );
        return current.size > 0;
      }
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
      return false;
    });
  }
}

export const projectImageBuilds = new ProjectImageBuilds();

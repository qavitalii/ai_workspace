import Docker from "dockerode";
import type { Duplex } from "node:stream";
import { consumeRunnerOutput } from "./runner-output.js";
import { mkdir, chown, chmod } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { concurrentTasks } from "./settings.js";
import type { AgentEvent, RunnerCommand } from "../shared.js";
import { db } from "./db.js";
import {
  chatWorkspace,
  workspacePath,
  workspaceGitMounts,
} from "./workspaces.js";
import { folderMounts } from "./folders.js";
import { prepareSsh, cleanSshVolumes } from "./ssh-runtime.js";
import { attachInput } from "./docker-attach.js";
import { removeDockerResource } from "./docker-cleanup.js";
import { cleanAwsCredentials, awsForRun } from "./aws.js";
import { cleanSkillSnapshots, prepareSkills } from "./skills.js";
import {
  prepareProfile,
  recoverRunProfiles,
  removeSessionsExcept,
  type ProfileRun,
} from "./profiles.js";
export const docker = new Docker();
// IDs here identify persistent folders, not chats.
export const workspace = workspacePath;
async function writable(dir: string) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  if (process.getuid?.() === 0) await chown(dir, 1000, 1000);
}
export type Running = {
  id: string;
  aws?: boolean;
  awsWarning?: string;
  send: (c: RunnerCommand) => void;
  stop: () => Promise<void>;
  withPausedWorkspace?: <T>(operation: () => Promise<T>) => Promise<T>;
  /** After stop: whether the account's sign-in and session state was saved. */
  profileSaved?: () => Promise<boolean>;
};
export async function launch(
  chatId: string | null,
  accountId: string | null,
  onEvent: (e: AgentEvent) => void | Promise<void>,
  options: {
    sessionId?: string | null;
    signIn?: boolean;
    installPackages?: boolean;
  } = {},
): Promise<Running> {
  const image = options.installPackages
    ? await docker.getImage(config.image).inspect()
    : undefined;
  const installPackages =
    image?.Config?.Labels?.["ai.workspace.runner.package-installer"] === "1";
  let packageConcurrency: number | undefined;
  if (installPackages) {
    const [configured, running] = await Promise.all([
      concurrentTasks(),
      db.query(
        "SELECT count(*) n FROM jobs WHERE state IN ('running','waiting_approval')",
      ),
    ]);
    // Lowering the limit does not stop the jobs already admitted.
    packageConcurrency = Math.max(configured, Number(running.rows[0].n));
  }
  const w = chatId ? await chatWorkspace(chatId) : null;
  const work = w
    ? workspace(w.id)
    : path.join(config.data, "auth-workspaces", accountId!);
  await writable(work);
  const mounts: any[] = [{ Type: "bind", Source: work, Target: "/workspace" }];
  if (chatId && w) {
    mounts.push(...workspaceGitMounts(w));
    if (w.resolution_operation_id)
      mounts.push({
        Type: "bind",
        Source: path.join(
          config.data,
          "workspace-operations",
          w.resolution_operation_id,
          "inputs",
        ),
        Target: "/merge-input",
        ReadOnly: true,
      });
    mounts.push(...(await folderMounts(chatId)));
    const attachments = (
      await db.query(
        "SELECT storage_name FROM attachments WHERE chat_id=$1 AND message_id IS NOT NULL",
        [chatId],
      )
    ).rows;
    if (process.getuid?.() === 0) {
      for (const f of attachments)
        await chown(
          path.join(config.data, "uploads", f.storage_name),
          1000,
          1000,
        );
    }
    mounts.push(
      ...attachments.map((f) => ({
        Type: "bind",
        Source: path.join(config.data, "uploads", f.storage_name),
        Target: "/attachments/" + f.storage_name,
        ReadOnly: true,
      })),
    );
  }
  // Fresh per run: only sign-in files and this chat's own sessions persist.
  let profile: ProfileRun | null = null;
  if (accountId) {
    profile = await prepareProfile(accountId, chatId, {
      session: options.sessionId,
      signIn: options.signIn,
    });
    mounts.push({ Type: "bind", Source: profile.dir, Target: "/profile" });
  }
  let aws: Awaited<ReturnType<typeof awsForRun>>["access"] = null;
  let awsWarning = "";
  let skills: Awaited<ReturnType<typeof prepareSkills>> = null;
  let ssh: Awaited<ReturnType<typeof prepareSsh>> = null;
  let session: string | null = null;
  let saved: Promise<boolean> | undefined;
  // The profile is read back only when the container is known to be gone (or
  // its processes have exited); otherwise startup recovery handles it later.
  const cleanMounts = (gone = true) => {
    if (!saved || gone)
      saved = !profile
        ? Promise.resolve(true)
        : gone
          ? profile.finish(session)
          : Promise.resolve(false);
    return Promise.all([ssh?.stop(), skills?.stop(), aws?.stop(), saved]);
  };
  try {
    if (w && !w.resolution_operation_id)
      ({ access: aws, warning: awsWarning } = await awsForRun(w.project_id));
    if (w) skills = await prepareSkills(w.project_id);
    if (chatId) ssh = await prepareSsh(chatId);
  } catch (error) {
    await cleanMounts();
    throw error;
  }
  if (ssh) mounts.push(ssh.mount);
  if (skills) mounts.push(skills.mount);
  if (aws) mounts.push(aws.mount);
  let c: Docker.Container;
  try {
    c = await docker.createContainer({
      // A concurrently retagged image must not inherit the inspected image's
      // permission to start the broker.
      Image: image?.Id ?? config.image,
      User: installPackages ? "0:0" : "1000:1000",
      WorkingDir: installPackages ? "/" : "/workspace",
      ...(installPackages
        ? {
            Entrypoint: ["/usr/local/bin/workspace-package-runner"],
            Cmd: [],
            Healthcheck: { Test: ["NONE"] },
          }
        : {}),
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      OpenStdin: true,
      StdinOnce: false,
      Labels: {
        "ai.workspace.managed": "true",
        "ai.workspace.instance": config.data,
        "ai.workspace.chat": chatId || "",
        "ai.workspace.account": accountId || "",
        "ai.workspace.profile": profile?.name || "",
      },
      Env: [
        "HOME=/profile",
        "CODEX_HOME=/profile/.codex",
        "CLAUDE_CONFIG_DIR=/profile/.claude",
        "GIT_OPTIONAL_LOCKS=0",
        ...Object.entries(aws?.env ?? {}).map(
          ([key, value]) => key + "=" + value,
        ),
        ...(packageConcurrency === undefined
          ? []
          : ["WORKSPACE_PACKAGE_CONCURRENCY=" + packageConcurrency]),
      ],
      HostConfig: {
        Mounts: mounts,
        Memory: 2 * 1024 ** 3,
        LogConfig: {
          Type: "json-file",
          Config: { "max-size": "10m", "max-file": "3" },
        },
        NanoCpus: 2e9,
        PidsLimit: 256,
        CapDrop: ["ALL"],
        ...(installPackages
          ? {
              CapAdd: [
                "CHOWN",
                "DAC_OVERRIDE",
                "FOWNER",
                "SETUID",
                "SETGID",
                "SETPCAP",
              ],
            }
          : {}),
        SecurityOpt: ["no-new-privileges:true"],
        ReadonlyRootfs: !installPackages,
        Tmpfs: {
          "/tmp": "rw,nosuid,nodev,size=512m",
          ...(!accountId
            ? { "/profile": "rw,nosuid,nodev,uid=1000,gid=1000,size=32m" }
            : {}),
        },
        NetworkMode: "bridge",
        AutoRemove: true,
      },
      StopTimeout: 10,
    });
  } catch (error) {
    await cleanMounts();
    throw error;
  }
  let stream: Duplex;
  try {
    stream = await attachInput(c);
  } catch (error) {
    const gone = await c.remove({ force: true }).then(
      () => true,
      () => false,
    );
    await cleanMounts(gone);
    throw error;
  }
  let stopped = false;
  let exited = false;
  let stopping: Promise<void> | undefined;
  let pausedWork: Promise<unknown> | undefined;
  let containerPaused = false;
  async function withPausedWorkspace<T>(operation: () => Promise<T>) {
    if (stopped || exited || pausedWork)
      throw Object.assign(
        new Error("The agent is no longer available to sync this folder."),
        { statusCode: 409 },
      );
    const pending = (async () => {
      await c.pause().catch(async (error) => {
        containerPaused = !!(await c.inspect().catch(() => null))?.State.Paused;
        throw error;
      });
      containerPaused = true;
      try {
        return await operation();
      } finally {
        await c.unpause().catch(() => c.unpause());
        containerPaused = false;
      }
    })();
    pausedWork = pending;
    try {
      return await pending;
    } finally {
      pausedWork = undefined;
      if (containerPaused && !stopped)
        void stop()
          .finally(() =>
            onEvent({
              type: "failed",
              error:
                "Could not resume the agent after GitHub sync. Check the working folder before retrying.",
            }),
          )
          .catch(() => {});
    }
  }
  function stop() {
    if (stopping) return stopping;
    stopped = true;
    stream.destroy();
    stopping = (async () => {
      let gone = false;
      try {
        await pausedWork?.catch(() => {});
        // Recover if the first unpause failed while the container was stopping.
        if (containerPaused) await c.unpause().catch(() => {});
        await c.stop({ t: 5 }).catch(() => {});
        await removeDockerResource(() => c.remove({ force: true }));
        gone = true;
      } finally {
        await cleanMounts(gone || exited);
      }
    })().catch((error) => {
      stopping = undefined;
      throw error;
    });
    return stopping;
  }
  const output = consumeRunnerOutput(stream, async (e) => {
    if (e.type === "session" && typeof e.id === "string") session = e.id;
    if (!stopped) await onEvent(e);
  }).catch(async (error) => {
    if (stopped) return;
    await stop();
    await onEvent({ type: "failed", error: error.message });
  });
  // Attach a rejection handler immediately; a failed consumer must not become
  // an unhandled rejection while the container is still starting.
  void output.catch(() => {});
  try {
    await c.start();
    if (image && !installPackages)
      await onEvent({
        type: "warning",
        message:
          "This runner image does not support installing system packages during a task. Refresh the bundled image with ./ops/compose.sh build runner-image, or rebuild your custom image from the current Workspace runner.",
      });
  } catch (error) {
    await stop();
    throw error;
  }
  if (ssh)
    void ssh.closed
      .then(async () => {
        if (!stopped && !exited) {
          try {
            await stop();
          } finally {
            await onEvent({
              type: "failed",
              error:
                "SSH access stopped unexpectedly. Retry the task after checking server connections.",
            });
          }
        }
      })
      .catch(() => {});
  void c
    .wait()
    .then(async () => {
      exited = true;
      await output;
      await cleanMounts();
      if (!stopped) await onEvent({ type: "exit" });
    })
    .catch(() => {});
  return {
    id: c.id,
    aws: !!aws,
    awsWarning,
    withPausedWorkspace,
    send(c) {
      if (!stopped) stream.write(JSON.stringify(c) + "\n");
    },
    profileSaved: () => saved ?? Promise.resolve(!profile),
    async stop() {
      if (stopped) return stop();
      await stop();
      // Do not await the consumer from stop: it may itself be stopping us.
      void Promise.resolve(onEvent({ type: "interrupted" })).catch(() => {});
    },
  };
}
export async function cleanOrphans() {
  // Runs whose container survives removal keep their profile for a later start.
  const live = new Set<string>();
  for (const c of await docker.listContainers({
    all: true,
    filters: JSON.stringify({
      label: [
        "ai.workspace.managed=true",
        "ai.workspace.instance=" + config.data,
      ],
    }),
  })) {
    await docker
      .getContainer(c.Id)
      .remove({ force: true })
      .catch(() => {
        const name = c.Labels?.["ai.workspace.profile"];
        if (name) live.add(name);
      });
  }
  await cleanSshVolumes();
  await Promise.all([
    cleanSkillSnapshots(),
    cleanAwsCredentials(),
    recoverRunProfiles(live),
  ]);
  await removeSessionsExcept(
    new Set((await db.query("SELECT id FROM chats")).rows.map((r) => r.id)),
  );
}

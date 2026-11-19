import Docker from "dockerode";
import type { Duplex } from "node:stream";
import { consumeRunnerOutput } from "./runner-output.js";
import { mkdir, chown, chmod } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
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
export const docker = new Docker();
// IDs here identify persistent folders, not chats.
export const workspace = workspacePath;
export const profile = (id: string) => path.join(config.data, "profiles", id);
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
};
export async function launch(
  chatId: string | null,
  accountId: string | null,
  onEvent: (e: AgentEvent) => void | Promise<void>,
): Promise<Running> {
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
  if (accountId) {
    await writable(profile(accountId));
    mounts.push({
      Type: "bind",
      Source: profile(accountId),
      Target: "/profile",
    });
  }
  const { access: aws, warning: awsWarning } =
    w && !w.resolution_operation_id
      ? await awsForRun(w.project_id)
      : { access: null, warning: "" };
  let skills: Awaited<ReturnType<typeof prepareSkills>> = null;
  let ssh: Awaited<ReturnType<typeof prepareSsh>> = null;
  const cleanMounts = () =>
    Promise.all([ssh?.stop(), skills?.stop(), aws?.stop()]);
  try {
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
      Image: config.image,
      User: "1000:1000",
      WorkingDir: "/workspace",
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
      },
      Env: [
        "HOME=/profile",
        "CODEX_HOME=/profile/.codex",
        "CLAUDE_CONFIG_DIR=/profile/.claude",
        "GIT_OPTIONAL_LOCKS=0",
        ...Object.entries(aws?.env ?? {}).map(
          ([key, value]) => key + "=" + value,
        ),
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
        SecurityOpt: ["no-new-privileges:true"],
        ReadonlyRootfs: true,
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
    await c.remove({ force: true }).catch(() => {});
    await cleanMounts();
    throw error;
  }
  let stopped = false;
  let exited = false;
  let stopping: Promise<void> | undefined;
  function stop() {
    if (stopping) return stopping;
    stopped = true;
    stream.destroy();
    stopping = (async () => {
      try {
        await c.stop({ t: 5 }).catch(() => {});
        await removeDockerResource(() => c.remove({ force: true }));
      } finally {
        await cleanMounts();
      }
    })().catch((error) => {
      stopping = undefined;
      throw error;
    });
    return stopping;
  }
  const output = consumeRunnerOutput(stream, async (e) => {
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
    send(c) {
      if (!stopped) stream.write(JSON.stringify(c) + "\n");
    },
    async stop() {
      if (stopped) return stop();
      await stop();
      // Do not await the consumer from stop: it may itself be stopping us.
      void Promise.resolve(onEvent({ type: "interrupted" })).catch(() => {});
    },
  };
}
export async function cleanOrphans() {
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
      .catch(() => {});
  }
  await cleanSshVolumes();
  await Promise.all([cleanSkillSnapshots(), cleanAwsCredentials()]);
}

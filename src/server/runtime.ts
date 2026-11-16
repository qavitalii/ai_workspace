import Docker from "dockerode";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { mkdir, chown, chmod } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import type { AgentEvent, RunnerCommand } from "../shared.js";
import { folderMounts } from "./folders.js";
export const docker = new Docker();
export const workspace = (id: string) =>
  path.join(config.data, "workspaces", id);
export const profile = (id: string) => path.join(config.data, "profiles", id);
async function writable(dir: string) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  if (process.getuid?.() === 0) await chown(dir, 1000, 1000);
}
export type Running = {
  id: string;
  send: (c: RunnerCommand) => void;
  stop: () => Promise<void>;
};
export async function launch(
  chatId: string | null,
  accountId: string | null,
  onEvent: (e: AgentEvent) => void,
): Promise<Running> {
  const work = chatId
    ? workspace(chatId)
    : path.join(config.data, "auth-workspaces", accountId!);
  await writable(work);
  const mounts: any[] = [{ Type: "bind", Source: work, Target: "/workspace" }];
  if (chatId) mounts.push(...(await folderMounts(chatId)));
  if (accountId) {
    await writable(profile(accountId));
    mounts.push({
      Type: "bind",
      Source: profile(accountId),
      Target: "/profile",
    });
  }
  const c = await docker.createContainer({
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
    ],
    HostConfig: {
      Mounts: mounts,
      Memory: 2 * 1024 ** 3,
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
  const stream = await c.attach({
    hijack: true,
    stream: true,
    stdin: true,
    stdout: true,
    stderr: true,
  });
  const out = new PassThrough(),
    err = new PassThrough();
  docker.modem.demuxStream(stream, out, err);
  createInterface({ input: out }).on("line", (line) => {
    try {
      onEvent(JSON.parse(line));
    } catch {
      onEvent({ type: "log", text: "Invalid runner event" });
    }
  });
  err.on("data", (b) => onEvent({ type: "log", text: b.toString() }));
  await c.start();
  let stopped = false;
  c.wait()
    .then(() => {
      if (!stopped) onEvent({ type: "exit" });
    })
    .catch(() => {});
  return {
    id: c.id,
    send(c) {
      stream.write(JSON.stringify(c) + "\n");
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      stream.end();
      await c.stop({ t: 5 }).catch(() => {});
      await c.remove({ force: true }).catch(() => {});
      onEvent({ type: "interrupted" });
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
}

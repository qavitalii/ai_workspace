import Docker from "dockerode";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { consumeRunnerOutput } from "./runner-output.js";
import { db } from "./db.js";
import { unseal } from "./security.js";
import type { SshServer } from "../ssh.js";
import { attachInput } from "./docker-attach.js";
import { removeDockerResource } from "./docker-cleanup.js";
const docker = new Docker();
const labels = () => ({
  "ai.workspace.managed": "true",
  "ai.workspace.instance": config.data,
  "ai.workspace.ssh": "true",
});

export async function startSshHelper(input: object, broker = false) {
  let container: Docker.Container | undefined, stream: Duplex | undefined;
  let volume: Docker.Volume | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ||= (async () => {
      stream?.destroy();
      if (container)
        await removeDockerResource(() => container!.remove({ force: true }));
      if (volume) await removeDockerResource(() => volume!.remove());
    })().catch((error) => {
      // Failed cleanup must remain retryable by the lifecycle owner.
      stopping = undefined;
      throw error;
    }));
  try {
    const volumeName = "workspace-ssh-" + randomUUID();
    if (broker) {
      await docker.createVolume({ Name: volumeName, Labels: labels() });
      volume = docker.getVolume(volumeName);
    }
    container = await docker.createContainer({
      Image: config.image,
      User: "1000:1000",
      WorkingDir: "/private",
      Cmd: ["node", "/app/dist/node/server/ssh-helper.js"],
      Env: ["HOME=/private", "LC_ALL=C"],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      OpenStdin: true,
      Labels: labels(),
      HostConfig: {
        NetworkMode:
          broker || ["generate", "import"].includes((input as any).operation)
            ? "none"
            : "bridge",
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        Memory: 256 * 1024 ** 2,
        PidsLimit: 32,
        NanoCpus: 1e9,
        // Key import returns a secret over attach. Docker must not persist it.
        LogConfig: { Type: "none", Config: {} },
        Mounts: broker
          ? [
              {
                Type: "volume",
                Source: volumeName,
                Target: "/run/workspace-ssh",
              },
            ]
          : [],
        Tmpfs: {
          "/private":
            "rw,nosuid,nodev,noexec,uid=1000,gid=1000,mode=0700,size=8m",
          "/tmp": "rw,nosuid,nodev,size=8m",
          ...(!broker
            ? {
                "/run/workspace-ssh":
                  "rw,nosuid,nodev,noexec,uid=1000,gid=1000,mode=0700,size=8m",
              }
            : {}),
        },
      },
    });
    stream = await attachInput(container);
    let resolve!: (v: any) => void,
      reject!: (e: Error) => void,
      received = false;
    const result = new Promise<any>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // Install rejection handler before start/attach can fail.
    void result.catch(() => {});
    const operation = String((input as any).operation);
    const failure = () =>
      reject(
        new Error(
          `SSH ${operation} helper failed. Check the key, passphrase and server availability.`,
        ),
      );
    void consumeRunnerOutput(stream, (e) => {
      if (e.type === "result" && !received) {
        received = true;
        resolve(e.result);
      } else if (e.type === "error") failure();
    }).then(() => {
      if (!received) failure();
    }, failure);
    const timer = setTimeout(
      () => reject(new Error("SSH operation timed out.")),
      30000,
    );
    try {
      await container.start();
      stream.write(JSON.stringify(input) + "\n");
      const value = await result;
      const closed = container.wait().then(
        () => {},
        () => {},
      );
      return {
        value,
        stop,
        closed,
        mount: {
          Type: "volume" as const,
          Source: volumeName,
          Target: "/run/workspace-ssh",
          ReadOnly: true,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    if (container && e instanceof Error) {
      const state = await container.inspect().then(
        (c) => c.State,
        () => null,
      );
      if (state && !state.Running)
        e.message += ` (helper ${state.Status}, exit ${state.ExitCode})`;
    }
    await stop();
    throw e;
  }
}

export async function sshOperation(input: object) {
  const helper = await startSshHelper(input);
  try {
    return helper.value;
  } finally {
    await helper.stop();
  }
}

export async function chatServers(chatId: string): Promise<SshServer[]> {
  return (
    await db.query(
      `SELECT s.*,k.public_key FROM ssh_servers s
    JOIN ssh_keys k ON k.id=s.key_id
    JOIN ssh_links l ON l.server_id=s.id JOIN chats c ON c.id=$1
    WHERE l.project_id=c.project_id OR l.chat_id=c.id ORDER BY s.alias`,
      [chatId],
    )
  ).rows;
}
export async function withPrivateKeys(servers: SshServer[]) {
  const keys = (
    await db.query(
      "SELECT id,private_key FROM ssh_keys WHERE id=ANY($1::uuid[])",
      [servers.map((s) => s.key_id)],
    )
  ).rows;
  return servers.map((s) => ({
    ...s,
    private_key: unseal(keys.find((k) => k.id === s.key_id).private_key),
  }));
}
export async function prepareSsh(chatId: string) {
  const servers = await chatServers(chatId);
  if (!servers.length) return null;
  if (servers.some((s) => !s.host_keys.length))
    throw new Error(
      "A connected SSH server needs fingerprint confirmation in Settings → Servers & SSH keys.",
    );
  return startSshHelper(
    { operation: "broker", servers: await withPrivateKeys(servers) },
    true,
  );
}
export async function cleanSshVolumes() {
  const volumes = await docker.listVolumes({
    filters: JSON.stringify({
      label: ["ai.workspace.ssh=true", "ai.workspace.instance=" + config.data],
    }),
  });
  for (const v of volumes.Volumes || [])
    await docker
      .getVolume(v.Name)
      .remove()
      .catch(() => {});
}

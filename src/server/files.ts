import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { chown } from "node:fs/promises";
import { docker, workspace } from "./runtime.js";
import { config } from "./config.js";
/** Read through a container so symlink races in agent-controlled folders cannot reach supervisor files. */
export async function inspectWorkspace(
  chatId: string,
  relative: string,
  mode: "list" | "file",
) {
  if (
    relative.includes("\0") ||
    relative.split(/[\\/]/).some((p) => p === ".." || p === ".git") ||
    relative.startsWith("/")
  )
    throw Object.assign(new Error("Invalid path"), { statusCode: 400 });
  const script = `const fs=require('fs'),path=require('path');const p=fs.realpathSync(path.resolve('/workspace',process.argv[1]));if(p!='/workspace'&&!p.startsWith('/workspace/'))throw Error('Path escapes workspace');if(process.argv[2]==='list'){process.stdout.write(JSON.stringify(fs.readdirSync(p,{withFileTypes:true}).filter(f=>!f.isSymbolicLink()&&f.name!=='.git').slice(0,500).map(f=>({name:f.name,path:path.posix.join(process.argv[1],f.name),directory:f.isDirectory()}))));}else{const s=fs.statSync(p);if(!s.isFile()||s.size>100*1024*1024)throw Error('File must be regular and at most 100 MB');fs.createReadStream(p).pipe(process.stdout);}`;
  const c = await docker.createContainer({
    Image: config.image,
    User: "1000:1000",
    WorkingDir: "/workspace",
    Cmd: ["node", "-e", script, relative, mode],
    AttachStdout: true,
    AttachStderr: true,
    Labels: {
      "ai.workspace.managed": "true",
      "ai.workspace.instance": config.data,
    },
    HostConfig: {
      Mounts: [
        {
          Type: "bind",
          Source: workspace(chatId),
          Target: "/workspace",
          ReadOnly: true,
        },
      ],
      NetworkMode: "none",
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Memory: 256 * 1024 ** 2,
      PidsLimit: 32,
    },
  });
  const stream = await c.attach({ stream: true, stdout: true, stderr: true }),
    out = new PassThrough(),
    err = new PassThrough();
  docker.modem.demuxStream(stream, out, err);
  const drained = finished(stream, { readable: true, writable: false });
  void drained.catch(() => {});
  const chunks: Buffer[] = [];
  let total = 0;
  out.on("data", (b) => {
    total += b.length;
    if (total <= 100 * 1024 ** 2) chunks.push(b);
    else void c.kill().catch(() => {});
  });
  err.resume();
  const timer = setTimeout(() => void c.kill().catch(() => {}), 30000);
  try {
    await c.start();
    const result = await c.wait();
    await drained;
    if (result.StatusCode !== 0 || total > 100 * 1024 ** 2)
      throw Object.assign(
        new Error(
          "Unable to read this file. Check its path and size (up to 100 MB).",
        ),
        { statusCode: 400 },
      );
    const resultBuffer = Buffer.concat(chunks);
    return mode === "list" ? JSON.parse(resultBuffer.toString()) : resultBuffer;
  } finally {
    clearTimeout(timer);
    (stream as import("node:stream").Duplex).destroy();
    await c.remove({ force: true }).catch(() => {});
  }
}

/** Copy only this chat's uploads through a helper; agent-controlled symlinks never reach the host. */
export async function syncAttachments(chatId: string, storageNames: string[]) {
  if (!storageNames.length) return;
  for (const name of storageNames) {
    if (
      name.includes("/") ||
      name.includes("\\") ||
      name === "." ||
      name === ".."
    )
      throw new Error("Invalid attachment name");
    if (process.getuid?.() === 0)
      await chown(config.data + "/uploads/" + name, 1000, 1000);
  }
  const script = `const fs=require('fs'),path=require('path');const names=JSON.parse(process.argv[1]);const dest='/workspace/.workspace-attachments';fs.rmSync(dest,{recursive:true,force:true});fs.mkdirSync(dest);for(const [i,n] of names.entries()){if(n!==path.basename(n))throw Error('Invalid attachment name');fs.copyFileSync('/input/'+i,path.join(dest,n));}`;
  const c = await docker.createContainer({
    Image: config.image,
    User: "1000:1000",
    WorkingDir: "/workspace",
    Cmd: ["node", "-e", script, JSON.stringify(storageNames)],
    Labels: {
      "ai.workspace.managed": "true",
      "ai.workspace.instance": config.data,
    },
    HostConfig: {
      Mounts: [
        { Type: "bind", Source: workspace(chatId), Target: "/workspace" },
        ...storageNames.map((name, i) => ({
          Type: "bind" as const,
          Source: config.data + "/uploads/" + name,
          Target: "/input/" + i,
          ReadOnly: true,
        })),
      ],
      NetworkMode: "none",
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Memory: 256 * 1024 ** 2,
      PidsLimit: 32,
    },
  });
  const timer = setTimeout(() => void c.kill().catch(() => {}), 60000);
  try {
    await c.start();
    if ((await c.wait()).StatusCode !== 0)
      throw new Error("Unable to prepare attachments in the workspace");
  } finally {
    clearTimeout(timer);
    await c.remove({ force: true }).catch(() => {});
  }
}

import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { chatWorkspace } from "./workspaces.js";
import { docker, workspace } from "./runtime.js";
import { MAX_WORKSPACE_FILE_BYTES } from "../shared.js";
import { config } from "./config.js";
/** Read through a container so symlink races in agent-controlled folders cannot reach supervisor files. */
export async function inspectWorkspace(
  chatId: string,
  relative: string,
  mode: "list" | "file" | "index",
) {
  return inspectDirectory(
    workspace((await chatWorkspace(chatId)).id),
    relative,
    mode,
  );
}
export async function inspectDirectory(
  source: string,
  relative: string,
  mode: "list" | "file" | "index",
) {
  if (
    relative.includes("\0") ||
    relative.split(/[\\/]/).some((p) => p === ".." || p === ".git") ||
    relative.startsWith("/")
  )
    throw Object.assign(new Error("Invalid path"), { statusCode: 400 });
  const script = `const fs=require('fs'),path=require('path');const p=fs.realpathSync(path.resolve('/workspace',process.argv[1]));if(p!='/workspace'&&!p.startsWith('/workspace/'))throw Error('Path escapes workspace');if(process.argv[2]==='index'){const out=[],skip=new Set(['.git','node_modules','.workspace-folders','.workspace-attachments','.venv','dist']);let visited=0;function walk(dir,depth){if(depth>8||visited>5000)return;for(const f of fs.readdirSync(dir,{withFileTypes:true})){if(++visited>5000)return;if(f.isSymbolicLink()||skip.has(f.name))continue;const next=path.join(dir,f.name),rel=path.relative('/workspace',next);if(f.isDirectory())walk(next,depth+1);else if(f.isFile()){out.push({kind:'file',name:rel,path:'/workspace/'+rel});if(f.name==='SKILL.md')out.push({kind:'skill',name:path.basename(dir),path:'/workspace/'+rel});}}}walk(p,0);process.stdout.write(JSON.stringify(out));}else if(process.argv[2]==='list'){process.stdout.write(JSON.stringify(fs.readdirSync(p,{withFileTypes:true}).filter(f=>!f.isSymbolicLink()&&f.name!=='.git').slice(0,500).map(f=>({name:f.name,path:path.posix.join(process.argv[1],f.name),directory:f.isDirectory()}))));}else{const s=fs.statSync(p);if(!s.isFile()||s.size>${MAX_WORKSPACE_FILE_BYTES})throw Error('File must be regular and at most 100 MB');fs.createReadStream(p).pipe(process.stdout);}`;
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
          Source: source,
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
    if (total <= MAX_WORKSPACE_FILE_BYTES) chunks.push(b);
    else void c.kill().catch(() => {});
  });
  err.resume();
  const timer = setTimeout(() => void c.kill().catch(() => {}), 30000);
  try {
    await c.start();
    const result = await c.wait();
    await drained;
    if (result.StatusCode !== 0 || total > MAX_WORKSPACE_FILE_BYTES)
      throw Object.assign(
        new Error(
          "Unable to read this file. Check its path and size (up to 100 MB).",
        ),
        { statusCode: 400 },
      );
    const resultBuffer = Buffer.concat(chunks);
    return mode !== "file" ? JSON.parse(resultBuffer.toString()) : resultBuffer;
  } finally {
    clearTimeout(timer);
    (stream as import("node:stream").Duplex).destroy();
    await c.remove({ force: true }).catch(() => {});
  }
}

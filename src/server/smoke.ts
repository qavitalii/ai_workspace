import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import { launch, workspace, type Running } from "./runtime.js";
import { git } from "./git.js";
import { inspectWorkspace, syncAttachments } from "./files.js";
import { config } from "./config.js";

// No provider credentials or inference calls. Uses only temporary UUID workspaces.
const ids = Array.from({ length: 3 }, () => randomUUID()),
  runners: Running[] = [];
try {
  for (const [i, id] of ids.entries()) {
    let resolve!: () => void, reject!: (e: Error) => void;
    const ready = new Promise<void>((a, b) => {
      resolve = a;
      reject = b;
    });
    let text = "";
    const r = await launch(id, null, (e) => {
      if (e.type === "terminal") {
        text += e.data;
        if (text.includes("WORKSPACE_SMOKE_OK_" + i)) resolve();
      }
      if (e.type === "failed") reject(new Error(e.error));
    });
    runners.push(r);
    r.send({
      type: "terminal",
      data: `printf 'workspace-${i}' > /workspace/probe.txt; test ! -S /var/run/docker.sock && printf '\\nWORKSPACE_SMOKE_OK_${i}\\n'\r`,
    });
    await Promise.race([
      ready,
      new Promise((_, reject) => {
        const t = setTimeout(
          () => reject(new Error("Terminal bridge timed out")),
          15000,
        );
        t.unref();
      }),
    ]);
  }
  for (const [i, id] of ids.entries())
    assert.equal(
      await readFile(path.join(workspace(id), "probe.txt"), "utf8"),
      "workspace-" + i,
    );
  for (const r of runners) await r.stop();
  runners.length = 0;
  await git(workspace(ids[0]), ["init"]);
  await git(workspace(ids[0]), ["add", "probe.txt"]);
  await git(workspace(ids[0]), ["commit", "-m", "Smoke test"]);
  assert.match(
    await git(workspace(ids[0]), ["log", "-1", "--format=%s"]),
    /Smoke test/,
  );
  const files = await inspectWorkspace(ids[0], "", "list");
  assert.ok(files.some((f: any) => f.name === "probe.txt"));
  assert.equal(
    (await inspectWorkspace(ids[0], "probe.txt", "file")).toString(),
    "workspace-0",
  );
  await assert.rejects(() => inspectWorkspace(ids[0], "../secret", "file"));
  const uploadName = ids[0] + "-probe.txt";
  await mkdir(path.join(config.data, "uploads"), { recursive: true });
  await writeFile(
    path.join(config.data, "uploads", uploadName),
    "attachment probe",
    { mode: 0o600 },
  );
  try {
    await symlink(
      "/outside-workspace",
      path.join(workspace(ids[0]), ".workspace-attachments"),
    );
    await syncAttachments(ids[0], [uploadName]);
    assert.equal(
      (
        await inspectWorkspace(
          ids[0],
          ".workspace-attachments/" + uploadName,
          "file",
        )
      ).toString(),
      "attachment probe",
    );
    const large = Buffer.alloc(3 * 1024 ** 2, "workspace");
    await writeFile(path.join(workspace(ids[0]), "large.bin"), large);
    assert.deepEqual(
      await inspectWorkspace(ids[0], "large.bin", "file"),
      large,
    );
  } finally {
    await rm(path.join(config.data, "uploads", uploadName), { force: true });
  }
  let resolveModels!: (x: any) => void, rejectModels!: (e: Error) => void;
  const models = new Promise<any>((resolve, reject) => {
    resolveModels = resolve;
    rejectModels = reject;
  });
  const r = await launch(ids[0], null, (e) => {
    if (e.type === "models") resolveModels(e.models);
    if (e.type === "failed") rejectModels(new Error(e.error));
  });
  runners.push(r);
  r.send({ type: "models", provider: "codex" });
  const list = await Promise.race([
    models,
    new Promise((_, reject) => {
      const t = setTimeout(
        () => reject(new Error("Codex handshake timed out")),
        30000,
      );
      t.unref();
    }),
  ]);
  assert.ok(Array.isArray(list));
  console.log(
    "PASS: three isolated runners, terminal I/O, persistent files, Git helper, safe attachment staging, complete large-file reads, Codex app-server handshake and model catalog. No inference calls.",
  );
} finally {
  for (const r of runners) await r.stop();
  for (const id of ids)
    await rm(workspace(id), { recursive: true, force: true });
}

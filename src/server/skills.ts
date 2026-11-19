import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { isMap, isScalar, parseDocument } from "yaml";
import { config } from "./config.js";
import { db, transaction } from "./db.js";

const maxBytes = 20 * 1024 * 1024;
const maxArchiveBytes = maxBytes + 2 * 1024 * 1024;
const maxFiles = 500;
const maxSkills = 50;
const previews = new Map<string, Preview>();

type FileEntry = { path: string; data: string };
type Skill = {
  name: string;
  files: FileEntry[];
  description: string;
  hints: string[];
  bytes: number;
};
type Summary = Pick<Skill, "name" | "description" | "hints" | "bytes"> & {
  fileCount: number;
  revision: string;
};
type Preview = {
  project: string | null;
  skills: Skill[];
  existing: Map<string, string>;
  timer: ReturnType<typeof setTimeout>;
};
const scopeWhere = "project_id IS NOT DISTINCT FROM $1::uuid";
const scopeParams = z.object({ project: z.string().uuid().optional() });
const namePattern = /^[a-z0-9][a-z0-9_-]{0,79}$/i;

function invalid(message: string, statusCode = 400): never {
  throw Object.assign(new Error(message), { statusCode });
}

function zip(mode: "import" | "export", input: Buffer | string) {
  return new Promise<Buffer>((resolve, reject) => {
    const child = execFile(
      "python3",
      ["-I", path.resolve("ops/skill-zip.py"), mode],
      {
        encoding: "buffer",
        timeout: 15_000,
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout) => {
        if (!error) return resolve(stdout);
        if (mode === "import" && error.code !== "ENOENT")
          return reject(
            Object.assign(
              new Error(
                "Could not open this ZIP. Use an unencrypted archive with regular files, up to 500 files and 20 MB unpacked.",
              ),
              { statusCode: 400 },
            ),
          );
        reject(new Error("The skill ZIP utility is unavailable."));
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

function ignored(parts: string[]) {
  return parts.some(
    (part) =>
      /^(?:__macosx|\.ds_store|\.git|node_modules|__pycache__|\.aws|\.ssh|\.gnupg|\.kube|\.npmrc|\.netrc|\.pypirc|auth\.json|credentials(?:\.json)?|\.mcp\.json|\.claude\.json|id_(?:ed25519|rsa|ecdsa))$/i.test(
        part,
      ) ||
      (/^\.env(?:\.|$)/i.test(part) &&
        !/^\.env\.(?:example|sample|template)$/i.test(part)) ||
      /\.(?:key|pem|pfx|p12)$/i.test(part),
  );
}

function skillDescription(markdown: string) {
  const normalized = markdown.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return "";
  const closing = /^---[ \t]*$/m.exec(normalized.slice(4));
  if (!closing) invalid("SKILL.md has an unclosed YAML frontmatter block.");
  const frontmatter = normalized.slice(4, 4 + closing.index);
  if (Buffer.byteLength(frontmatter) > 64 * 1024)
    invalid("SKILL.md frontmatter must be at most 64 KB.");
  const document = parseDocument(frontmatter, {
    prettyErrors: false,
    stringKeys: true,
  });
  if (
    document.errors.length ||
    document.warnings.length ||
    !isMap(document.contents)
  )
    invalid("SKILL.md frontmatter must be a valid YAML mapping.");
  // Read a scalar directly: never expand aliases or arbitrary YAML objects.
  const description = document.get("description", true);
  if (description === undefined) return "";
  if (!isScalar(description) || typeof description.value !== "string")
    invalid("SKILL.md description must be text.");
  return description.value.trim().slice(0, 250);
}

function inspectSkillFiles(input: FileEntry[], fallback: string) {
  const files = new Map<string, FileEntry>();
  const directories = new Map<string, string>();
  let excluded = 0;
  for (const entry of input) {
    const parts = entry.path.split("/");
    if (
      entry.path.length > 512 ||
      /^[a-z]:/i.test(entry.path) ||
      /[\\\x00-\x1f\x7f]/u.test(entry.path) ||
      parts.some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          Buffer.byteLength(part) > 255,
      )
    )
      invalid("The selected files contain an invalid path.");
    if (ignored(parts)) {
      excluded++;
      continue;
    }
    const key = entry.path.normalize("NFC").toLowerCase();
    if (files.has(key)) invalid("The selected files contain duplicate paths.");
    files.set(key, entry);
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      const normalized = dir.normalize("NFC").toLowerCase();
      const previous = directories.get(normalized);
      if (previous && previous !== dir)
        invalid(
          "Folder names must use the same capitalization throughout the import.",
        );
      directories.set(normalized, dir);
    }
  }
  for (const dir of directories.keys())
    if (files.has(dir)) invalid("A file and folder have the same path.");

  const roots = [...files.values()]
    .filter((entry) => entry.path.split("/").at(-1) === "SKILL.md")
    .map((entry) => ({
      entry,
      root: entry.path.split("/").slice(0, -1).join("/"),
    }));
  if (!roots.length)
    invalid("Choose a skill folder or ZIP that contains SKILL.md.");
  if (roots.length > maxSkills) invalid("Import up to 50 skills at a time.");
  const skills = new Map<string, Skill>();
  for (const { entry, root } of roots) {
    if (
      roots.some(
        (other) =>
          other.root !== root &&
          (!other.root || root.startsWith(other.root + "/")),
      )
    )
      invalid(
        "Each skill needs its own folder. Nested skills are not supported.",
      );
    const name = (root.split("/").at(-1) || fallback).toLowerCase();
    if (!namePattern.test(name))
      invalid(
        "Skill folder names must use letters, numbers, dashes or underscores.",
      );
    if (skills.has(name)) invalid("Two skill folders have the same name.");
    const markdown = Buffer.from(entry.data, "base64").toString("utf8");
    if (!markdown.trim() || markdown.includes("\u0000"))
      invalid("SKILL.md must contain text.");
    const description = skillDescription(markdown);
    const hints: string[] = [];
    if (/(?:\/Users\/|\/home\/|[A-Z]:\\|~\/)/.test(markdown))
      hints.push("References local paths. Check them on this server.");
    if (/\b(?:MCP|plugin|connector)s?\b/i.test(markdown))
      hints.push(
        "Mentions a plugin or connector. Check that it is available here.",
      );
    if (
      /\b(?:pip install|npm (?:i|install)|brew install|apt(?:-get)? install|requires|prerequisites)\b/i.test(
        markdown,
      )
    )
      hints.push(
        "Mentions prerequisites. Check that the required tools are installed.",
      );
    const contents = [...files.values()]
      .filter((file) => !root || file.path.startsWith(root + "/"))
      .map((file) => ({
        ...file,
        path: root ? file.path.slice(root.length + 1) : file.path,
      }));
    skills.set(name, {
      name,
      files: contents,
      description,
      hints,
      bytes: contents.reduce(
        (total, file) => total + Buffer.from(file.data, "base64").length,
        0,
      ),
    });
  }
  return { skills: [...skills.values()], excluded };
}

function list(project: string | null): Promise<Summary[]> {
  return db
    .query(
      `SELECT name,description,hints,bytes,revision,jsonb_array_length(files) AS "fileCount"
     FROM imported_skills WHERE ${scopeWhere} ORDER BY name`,
      [project],
    )
    .then((result) => result.rows);
}

export async function skillEntries(project: string | null) {
  const { rows } = await db.query<{
    name: string;
    description: string;
    project_id: string | null;
  }>(
    "SELECT name,description,project_id FROM imported_skills WHERE project_id IS NULL OR project_id=$1 ORDER BY project_id NULLS LAST,name",
    [project],
  );
  return rows.map((skill) => ({
    kind: "skill",
    name: skill.name,
    path:
      "/skills/" +
      (skill.project_id ? "project/" : "personal/") +
      skill.name +
      "/SKILL.md",
    description:
      (skill.project_id ? "Project skill" : "Personal skill") +
      (skill.description ? " · " + skill.description : ""),
  }));
}

const runtimeSkills = () => path.join(config.data, "skill-snapshots");

export async function prepareSkills(project: string | null) {
  const { rows } = await db.query<Skill & { project_id: string | null }>(
    "SELECT name,files,project_id FROM imported_skills WHERE project_id IS NULL OR project_id=$1",
    [project],
  );
  if (!rows.length) return null;
  await mkdir(runtimeSkills(), { recursive: true, mode: 0o700 });
  const source = await mkdtemp(path.join(runtimeSkills(), "run-"));
  const stop = () => rm(source, { recursive: true, force: true });
  try {
    await chmod(source, 0o755);
    for (const skill of rows) {
      const root = path.join(
        source,
        skill.project_id ? "project" : "personal",
        skill.name,
      );
      for (const file of skill.files) {
        const dest = path.join(root, file.path);
        await mkdir(path.dirname(dest), { recursive: true, mode: 0o755 });
        const data = Buffer.from(file.data, "base64");
        await writeFile(dest, data, {
          mode: data.subarray(0, 2).toString() === "#!" ? 0o755 : 0o644,
        });
      }
    }
    return {
      mount: {
        Type: "bind" as const,
        Source: source,
        Target: "/skills",
        ReadOnly: true,
      },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

export function cleanSkillSnapshots() {
  return rm(runtimeSkills(), { recursive: true, force: true });
}

function uploadPath(field: string) {
  try {
    return decodeURIComponent(field.slice(5));
  } catch {
    return invalid("A selected file has an invalid name.");
  }
}

async function upload(req: FastifyRequest) {
  if (!req.isMultipart()) invalid("Choose a ZIP or folder.");
  const parts = req.parts({
    limits: {
      files: maxFiles,
      fields: 0,
      parts: maxFiles + 1,
      fileSize: maxArchiveBytes,
      fieldNameSize: 6400,
    },
  });
  const files: FileEntry[] = [];
  let bytes = 0;
  let archive: { data: Buffer; name: string } | undefined;
  for await (const part of parts) {
    if (part.type !== "file") invalid("Choose a ZIP or folder.");
    const limit = part.fieldname === "archive" ? maxArchiveBytes : maxBytes;
    const chunks: Buffer[] = [];
    for await (const chunk of part.file) {
      bytes += chunk.length;
      if (bytes > limit)
        invalid("Choose up to 20 MB of files or a ZIP under 22 MB.", 413);
      chunks.push(chunk);
    }
    if (part.file.truncated)
      invalid("Choose up to 20 MB of files or a ZIP under 22 MB.", 413);
    const data = Buffer.concat(chunks);
    if (part.fieldname === "archive" && !archive && !files.length)
      archive = {
        data,
        name:
          path
            .basename(part.filename)
            .replace(/\.zip$/i, "")
            .replace(/[^a-z0-9_-]+/gi, "-")
            .replace(/^[^a-z0-9]+/i, "")
            .slice(0, 80) || "skill",
      };
    else if (!archive && part.fieldname.startsWith("path:"))
      files.push({
        path: uploadPath(part.fieldname),
        data: data.toString("base64"),
      });
    else invalid("Choose one ZIP or one folder.");
  }
  return archive
    ? inspectSkillFiles(
        JSON.parse((await zip("import", archive.data)).toString()),
        archive.name,
      )
    : inspectSkillFiles(files, "skill");
}

function discard(id: string) {
  const preview = previews.get(id);
  if (preview) clearTimeout(preview.timer);
  previews.delete(id);
}

export function skillRoutes(app: FastifyInstance) {
  app.addHook("onClose", async () => {
    for (const id of previews.keys()) discard(id);
  });
  async function scope(req: FastifyRequest) {
    const project = scopeParams.parse(req.query).project ?? null;
    if (
      project &&
      !(await db.query("SELECT 1 FROM projects WHERE id=$1", [project]))
        .rowCount
    )
      invalid("Project not found.", 404);
    return project;
  }
  app.get("/api/skills", async (req) => list(await scope(req)));
  app.post("/api/skills/preview", async (req) => {
    const project = await scope(req);
    const { skills, excluded } = await upload(req);
    const existing = new Map(
      (await list(project)).map((skill) => [skill.name, skill.revision]),
    );
    const id = randomUUID();
    if (previews.size >= 4) discard(previews.keys().next().value!);
    previews.set(id, {
      project,
      skills,
      existing,
      timer: setTimeout(() => discard(id), 10 * 60_000).unref(),
    });
    return {
      id,
      excluded,
      skills: skills.map(({ name, description, hints, bytes, files }) => ({
        name,
        description,
        hints,
        bytes,
        fileCount: files.length,
        conflict: existing.has(name),
      })),
    };
  });
  app.post("/api/skills/import", async (req) => {
    const project = await scope(req);
    const { id, conflicts } = z
      .object({
        id: z.string().uuid(),
        conflicts: z.record(
          z.string().regex(namePattern),
          z.enum(["skip", "replace", "copy"]),
        ),
      })
      .parse(req.body);
    const preview = previews.get(id);
    if (!preview || preview.project !== project)
      invalid("This preview expired. Choose the files again.", 409);
    const saved = await transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "skills:" + project,
      ]);
      const { rows } = await tx.query<Summary>(
        `SELECT name,revision,bytes,jsonb_array_length(files) AS "fileCount" FROM imported_skills WHERE ${scopeWhere}`,
        [project],
      );
      const existing = new Map(rows.map((skill) => [skill.name, skill]));
      const names = new Set([
        ...existing.keys(),
        ...preview.skills.map((skill) => skill.name),
      ]);
      let totalBytes = rows.reduce((sum, row) => sum + row.bytes, 0);
      let totalSkills = rows.length;
      let totalFiles = rows.reduce((sum, row) => sum + row.fileCount, 0);
      let count = 0;
      for (const skill of preview.skills) {
        const previous = existing.get(skill.name);
        if (previous?.revision !== preview.existing.get(skill.name))
          invalid(
            "A skill changed after preview. Choose the files again to review the latest version.",
            409,
          );
        const choice = previous
          ? Object.hasOwn(conflicts, skill.name)
            ? conflicts[skill.name]
            : "skip"
          : "replace";
        if (choice === "skip") continue;
        let name = skill.name;
        if (choice === "copy") {
          let index = 2;
          do {
            name = skill.name.slice(0, 72) + "-" + index++;
          } while (names.has(name));
          names.add(name);
        }
        const replaced = choice === "replace" && previous;
        totalBytes += skill.bytes - (replaced ? replaced.bytes : 0);
        totalSkills += replaced ? 0 : 1;
        totalFiles += skill.files.length - (replaced ? replaced.fileCount : 0);
        await tx.query(
          `INSERT INTO imported_skills(project_id,name,revision,description,hints,bytes,files) VALUES($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT(project_id,name) DO UPDATE SET revision=EXCLUDED.revision,description=EXCLUDED.description,
          hints=EXCLUDED.hints,bytes=EXCLUDED.bytes,files=EXCLUDED.files`,
          [
            project,
            name,
            randomUUID(),
            skill.description,
            skill.hints,
            skill.bytes,
            JSON.stringify(skill.files),
          ],
        );
        count++;
      }
      if (
        totalSkills > maxSkills ||
        totalBytes > maxBytes ||
        totalFiles > maxFiles
      )
        invalid(
          "This library can hold up to 50 skills, 500 files and 20 MB. Remove an existing skill or import fewer files.",
          409,
        );
      return count;
    });
    discard(id);
    return { saved, skills: await list(project) };
  });
  app.get("/api/skills/export", async (req, reply) => {
    const project = await scope(req);
    const { names } = z
      .object({ names: z.string().max(4100) })
      .parse(req.query);
    const selected = z
      .array(z.string().regex(namePattern))
      .min(1)
      .max(maxSkills)
      .parse(names.split(","));
    const { rows } = await db.query<Skill>(
      `SELECT name,files FROM imported_skills WHERE ${scopeWhere} AND name=ANY($2)`,
      [project, selected],
    );
    if (rows.length !== new Set(selected).size)
      invalid("Some selected skills are no longer available.", 409);
    const files = rows.flatMap((skill) =>
      skill.files.map((file) => ({
        ...file,
        path: skill.name + "/" + file.path,
      })),
    );
    const archive = await zip("export", JSON.stringify(files));
    return reply
      .header(
        "Content-Disposition",
        'attachment; filename="workspace-skills.zip"',
      )
      .header("Cache-Control", "no-store")
      .type("application/zip")
      .send(archive);
  });
  app.delete("/api/skills/:name", async (req) => {
    const project = await scope(req);
    const { name } = z
      .object({ name: z.string().regex(namePattern) })
      .parse(req.params);
    const { revision } = z
      .object({ revision: z.string().uuid() })
      .parse(req.query);
    await transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "skills:" + project,
      ]);
      if (
        !(
          await tx.query(
            `DELETE FROM imported_skills WHERE ${scopeWhere} AND name=$2 AND revision=$3`,
            [project, name, revision],
          )
        ).rowCount
      )
        invalid("This skill changed. Reload the library and try again.", 409);
    });
    return list(project);
  });
}

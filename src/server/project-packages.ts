import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { ProjectPackages } from "../shared.js";
import {
  maxProjectPackages as packageLimit,
  validPackageName,
  type PackagePresetResult,
} from "../runner/package-request.js";
import { db, transaction } from "./db.js";

const limitMessage = `Projects can remember up to ${packageLimit} Debian packages.`;

function projectNotFound() {
  return Object.assign(new Error("Project not found"), { statusCode: 404 });
}

async function lockProject(c: PoolClient, projectId: string) {
  const { rows } = await c.query<{ auto_packages: boolean }>(
    "SELECT auto_packages FROM projects WHERE id=$1 FOR NO KEY UPDATE",
    [projectId],
  );
  if (!rows[0]) throw projectNotFound();
  return rows[0];
}

async function requestImage(c: PoolClient, projectId: string) {
  await c.query(
    `UPDATE projects SET package_image_requested_at=
       GREATEST(clock_timestamp(),package_image_requested_at + interval '1 microsecond')
     WHERE id=$1`,
    [projectId],
  );
}

export async function listProjectPackages(projectId: string) {
  const { rows } = await db.query<ProjectPackages>(
    `SELECT p.auto_packages, COALESCE((
       SELECT json_agg(item ORDER BY item.added_at DESC,item.request_id,item.name)
       FROM (
         SELECT pp.name,pp.source,pp.source_chat_id,c.title AS source_chat_title,
           pp.request_id,pp.added_at,pp.failures,pp.disabled
         FROM project_packages pp LEFT JOIN chats c ON c.id=pp.source_chat_id
         WHERE pp.project_id=p.id
       ) item
     ),'[]'::json) AS packages FROM projects p WHERE p.id=$1`,
    [projectId],
  );
  if (!rows[0]) throw projectNotFound();
  return rows[0];
}

export async function projectPackagePresets(projectId: string) {
  const { rows } = await db.query<{ name: string; request_id: string }>(
    `SELECT name,request_id FROM project_packages
     WHERE project_id=$1 AND NOT disabled
     ORDER BY added_at,name LIMIT $2`,
    [projectId, packageLimit],
  );
  return new Map(
    rows
      .filter(({ name }) => validPackageName(name))
      .map(({ name, request_id }) => [name, request_id]),
  );
}

export async function pendingProjectPackageNames() {
  const { rows } = await db.query<{ names: string[] }>(
    `SELECT ARRAY(
       SELECT pp.name FROM project_packages pp
       WHERE pp.project_id=p.id AND NOT pp.disabled
       ORDER BY pp.added_at,pp.name LIMIT $1
     ) AS names FROM projects p WHERE p.package_image_requested_at IS NOT NULL`,
    [packageLimit],
  );
  return rows.map(({ names }) => names.filter(validPackageName));
}

export async function recordPackagePresetResults(
  projectId: string,
  presets: ReadonlyMap<string, string>,
  results: PackagePresetResult[],
) {
  const reported = results.map(({ name, ok }) => ({
    name,
    ok,
    request_id: presets.get(name),
  }));
  await transaction(async (c) => {
    await lockProject(c, projectId);
    // The owner may have removed or replaced a package while apt was running.
    const { rows } = await c.query<{ changed: boolean }>(
      `UPDATE project_packages pp
       SET failures=CASE WHEN result.ok THEN 0 ELSE pp.failures+1 END,
           disabled=NOT result.ok AND pp.failures+1>=3
       FROM project_packages previous,
            json_to_recordset($2::json) AS result(name text,ok boolean,request_id uuid)
       WHERE pp.project_id=$1 AND pp.name=result.name
         AND pp.request_id=result.request_id AND (result.ok OR NOT pp.disabled)
         AND previous.project_id=pp.project_id AND previous.name=pp.name
       RETURNING previous.disabled IS DISTINCT FROM pp.disabled AS changed`,
      [projectId, JSON.stringify(reported)],
    );
    if (rows.some(({ changed }) => changed)) await requestImage(c, projectId);
  });
}

async function savePackages(
  projectId: string,
  names: string[],
  requestId: string,
  chatId: string | null,
) {
  return transaction(async (c) => {
    // Serialize package edits and the toggle by project, including across workers.
    const settings = await lockProject(c, projectId);
    if (chatId && !settings.auto_packages)
      return { skipped: names, reason: "automatic remembering is off" };

    const { rows } = await c.query<{ name: string }>(
      "SELECT name FROM project_packages WHERE project_id=$1",
      [projectId],
    );
    const existing = new Set(rows.map(({ name }) => name));
    const newNames = names.filter((name) => !existing.has(name));
    const skipped = newNames.slice(Math.max(0, packageLimit - existing.size));
    const overLimit = new Set(skipped);
    const accepted = names.filter((name) => !overLimit.has(name));
    if (accepted.length) {
      // Keep the original request group. A successful agent install clears a
      // previously recorded failure even when the package was added by the owner.
      const { rowCount } = await c.query(
        `INSERT INTO project_packages(project_id,name,source,source_chat_id,request_id)
         SELECT $1,pkg.name,$3,$4,$5 FROM unnest($2::text[]) AS pkg(name)
         ON CONFLICT(project_id,name) DO UPDATE SET failures=0,disabled=false
         WHERE excluded.source='agent'
           AND (project_packages.failures<>0 OR project_packages.disabled)`,
        [projectId, accepted, chatId ? "agent" : "owner", chatId, requestId],
      );
      if (rowCount || !chatId) await requestImage(c, projectId);
    }
    return {
      skipped,
      reason: "the project limit of " + packageLimit + " packages was reached",
    };
  });
}

export function rememberProjectPackages(
  projectId: string,
  chatId: string,
  requestId: string,
  names: string[],
) {
  return savePackages(projectId, names, requestId, chatId);
}

export async function addProjectPackage(projectId: string, name: string) {
  const { skipped } = await savePackages(projectId, [name], randomUUID(), null);
  if (skipped.length)
    throw Object.assign(new Error(limitMessage), { statusCode: 409 });
  return { ok: true };
}

export async function setAutoPackages(projectId: string, enabled: boolean) {
  const { rows } = await db.query<{ auto_packages: boolean }>(
    "UPDATE projects SET auto_packages=$2 WHERE id=$1 RETURNING auto_packages",
    [projectId, enabled],
  );
  if (!rows[0]) throw projectNotFound();
  return rows[0];
}

export async function removeProjectPackages(
  projectId: string,
  target: { name: string } | { requestId: string },
) {
  return transaction(async (c) => {
    await lockProject(c, projectId);
    const { rowCount } =
      "name" in target
        ? await c.query(
            "DELETE FROM project_packages WHERE project_id=$1 AND name=$2",
            [projectId, target.name],
          )
        : await c.query(
            "DELETE FROM project_packages WHERE project_id=$1 AND request_id=$2",
            [projectId, target.requestId],
          );
    if (rowCount) await requestImage(c, projectId);
    return { ok: true };
  });
}

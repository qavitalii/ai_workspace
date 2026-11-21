import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { ProjectPackages } from "../shared.js";
import { db, transaction } from "./db.js";

const packageLimit = 256;
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
      await c.query(
        `INSERT INTO project_packages(project_id,name,source,source_chat_id,request_id)
         SELECT $1,pkg.name,$3,$4,$5 FROM unnest($2::text[]) AS pkg(name)
         ON CONFLICT(project_id,name) DO UPDATE SET failures=0,disabled=false
         WHERE excluded.source='agent'
           AND (project_packages.failures<>0 OR project_packages.disabled)`,
        [projectId, accepted, chatId ? "agent" : "owner", chatId, requestId],
      );
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
    if ("name" in target)
      await c.query(
        "DELETE FROM project_packages WHERE project_id=$1 AND name=$2",
        [projectId, target.name],
      );
    else
      await c.query(
        "DELETE FROM project_packages WHERE project_id=$1 AND request_id=$2",
        [projectId, target.requestId],
      );
    return { ok: true };
  });
}

import { db } from "./db.js";
import { config, validProjectEnvLimitGib } from "./config.js";

export async function concurrentTasks(
  queryable: Pick<typeof db, "query"> = db,
): Promise<number> {
  const row = (
    await queryable.query(
      "SELECT value FROM settings WHERE key='max_concurrent'",
    )
  ).rows[0];
  const value = row ? Number(row.value) : config.maxConcurrent;
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("Invalid concurrency setting");
  return value;
}

export async function projectEnvLimitGib() {
  const { rows } = await db.query(
    "SELECT value FROM settings WHERE key='project_env_limit_gib'",
  );
  const value = rows[0] ? Number(rows[0].value) : config.projectEnvLimitGib;
  if (!validProjectEnvLimitGib(value))
    throw new Error("Invalid project environment limit");
  return value;
}

export type ModelDefaults = Partial<
  Record<"codex" | "claude", { model: string; effort: string }>
>;
export async function modelDefaults(
  queryable: Pick<typeof db, "query"> = db,
): Promise<ModelDefaults> {
  const rows = (
    await queryable.query(
      "SELECT key,value FROM settings WHERE key IN ('model_default_codex','model_default_claude')",
    )
  ).rows;
  return Object.fromEntries(
    rows.map((r) => [r.key.replace("model_default_", ""), JSON.parse(r.value)]),
  );
}

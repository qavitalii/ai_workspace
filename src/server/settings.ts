import { db } from "./db.js";
import { config } from "./config.js";

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

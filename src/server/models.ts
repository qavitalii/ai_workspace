import { db, transaction } from "./db.js";
import { launch, type Running } from "./runtime.js";

const requests = new Map<string, Promise<any[]>>();
export async function accountModels(
  id: string,
  refresh = false,
  start = launch,
): Promise<any[]> {
  const pending = requests.get(id);
  if (pending) return pending;
  const task = load(id, refresh, start);
  requests.set(id, task);
  try {
    return await task;
  } finally {
    if (requests.get(id) === task) requests.delete(id);
  }
}
async function load(
  id: string,
  refresh: boolean,
  start: typeof launch,
): Promise<any[]> {
  const account = await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(417028)");
    const a = (
      await c.query("SELECT * FROM accounts WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (!a)
      throw Object.assign(new Error("Account not found"), { statusCode: 404 });
    if (!["ready", "limited"].includes(a.status))
      throw Object.assign(
        new Error("Connect this account to load its models."),
        { statusCode: 409 },
      );
    const busy = (
      await c.query(
        "SELECT 1 FROM jobs WHERE account_id=$1 AND state IN ('running','waiting_approval')",
        [id],
      )
    ).rowCount;
    const fresh =
      a.models_updated_at &&
      Date.now() - new Date(a.models_updated_at).getTime() < 3600000;
    if (
      a.model_catalog &&
      !refresh &&
      (fresh || busy || a.status === "limited")
    )
      return { cached: a.model_catalog };
    if (busy || a.status !== "ready")
      throw Object.assign(
        new Error(
          "Models can be refreshed when this account is available. Your saved model still works.",
        ),
        { statusCode: 409 },
      );
    await c.query("UPDATE accounts SET status='inspecting' WHERE id=$1", [id]);
    return a;
  });
  if (account.cached) return account.cached;
  let runtime: Running | undefined,
    timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let resolve!: (models: any[]) => void, reject!: (error: Error) => void;
    const result = new Promise<any[]>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void result.catch(() => {});
    runtime = await start(null, id, (e) => {
      if (e.type === "models" && Array.isArray(e.models)) resolve(e.models);
      if (["failed", "exit"].includes(e.type))
        reject(
          new Error("The model list is temporarily unavailable. Try again."),
        );
    });
    timer = setTimeout(
      () => reject(new Error("Loading models timed out. Try again.")),
      30000,
    );
    runtime.send({ type: "models", provider: account.provider });
    const models = await result;
    await db.query(
      "UPDATE accounts SET model_catalog=$2,models_updated_at=now() WHERE id=$1",
      [id, JSON.stringify(models)],
    );
    return models;
  } finally {
    clearTimeout(timer);
    try {
      await runtime?.stop();
    } finally {
      await db.query(
        "UPDATE accounts SET status='ready' WHERE id=$1 AND status='inspecting'",
        [id],
      );
    }
  }
}

import { db, transaction } from "./db.js";
import { launch, type Running } from "./runtime.js";
import { usageWindows } from "../usage.js";

export async function saveUsage(id: string, limits: any) {
  if (!limits || typeof limits !== "object") return;
  await transaction(async (c) => {
    const previous = (
      await c.query("SELECT limits FROM accounts WHERE id=$1 FOR UPDATE", [id])
    ).rows[0]?.limits;
    const type = limits.rateLimitType || limits.rate_limit_type;
    let merged = limits;
    if (type) merged = { windows: { ...previous?.windows, [type]: limits } };
    else if (limits.limitId && previous?.rateLimitsByLimitId)
      merged = {
        ...previous,
        rateLimitsByLimitId: {
          ...previous.rateLimitsByLimitId,
          [limits.limitId]: limits,
        },
      };
    const blocked = usageWindows(merged).filter(
      (w) => w.remaining === 0 || w.status === "rejected",
    );
    const reset =
      blocked.length && blocked.every((w) => w.resetsAt !== null)
        ? new Date(Math.max(...blocked.map((w) => w.resetsAt!)) * 1000)
        : null;
    await c.query(
      "UPDATE accounts SET limits=$2,limits_updated_at=now(),reset_at=$3 WHERE id=$1",
      [id, JSON.stringify(merged), reset],
    );
  });
}
const requests = new Map<string, Promise<any>>();
export async function accountUsage(id: string, start = launch): Promise<any> {
  if (requests.has(id)) return requests.get(id);
  const task = load(id, start);
  requests.set(id, task);
  try {
    return await task;
  } finally {
    requests.delete(id);
  }
}
async function load(id: string, start: typeof launch) {
  const account = await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(417028)");
    const a = (
      await c.query("SELECT * FROM accounts WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (!a)
      throw Object.assign(new Error("Account not found"), { statusCode: 404 });
    if (!["ready", "limited"].includes(a.status))
      throw Object.assign(
        new Error(
          "Connect this account and wait for other account checks to finish.",
        ),
        { statusCode: 409 },
      );
    if (
      (
        await c.query(
          "SELECT 1 FROM jobs WHERE account_id=$1 AND state IN ('running','waiting_approval')",
          [id],
        )
      ).rowCount
    )
      throw Object.assign(
        new Error(
          "This account is working. Limits update during the task; refresh again when it finishes.",
        ),
        { statusCode: 409 },
      );
    await c.query("UPDATE accounts SET status='inspecting' WHERE id=$1", [id]);
    return a;
  });
  let runtime: Running | undefined,
    timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let resolve!: (value: any) => void, reject!: (e: Error) => void;
    const result = new Promise<any>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void result.catch(() => {});
    runtime = await start(null, id, (e) => {
      if (e.type === "limits_read") resolve(e.limits);
      if (e.type === "limits_error")
        reject(Object.assign(new Error(e.error), { statusCode: 409 }));
      if (["failed", "exit"].includes(e.type))
        reject(
          new Error("Usage limits are temporarily unavailable. Try again."),
        );
    });
    timer = setTimeout(
      () => reject(new Error("Loading usage limits timed out. Try again.")),
      30000,
    );
    runtime.send({ type: "usage", provider: account.provider });
    await saveUsage(id, await result);
    return (
      await db.query(
        "SELECT limits,limits_updated_at,reset_at FROM accounts WHERE id=$1",
        [id],
      )
    ).rows[0];
  } finally {
    clearTimeout(timer);
    try {
      await runtime?.stop();
    } finally {
      await db.query(
        "UPDATE accounts SET status=$2 WHERE id=$1 AND status='inspecting'",
        [id, account.status],
      );
    }
  }
}

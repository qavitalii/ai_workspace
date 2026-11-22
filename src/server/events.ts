import { EventEmitter } from "node:events";
import webpush from "web-push";
import { db } from "./db.js";
import { redact } from "./security.js";
export const bus = new EventEmitter();
bus.setMaxListeners(100);
let writing: Promise<unknown> = Promise.resolve();
async function writeEvent(
  chatId: string | null,
  jobId: string | null,
  type: string,
  data: unknown,
  packageStartupNotice: boolean,
) {
  const clean = JSON.parse(redact(JSON.stringify(data)));
  const row = (
    await db.query(
      "INSERT INTO events(chat_id,job_id,type,data,package_startup_notice) VALUES($1,$2,$3,$4,$5) RETURNING *",
      [chatId, jobId, type, clean, packageStartupNotice],
    )
  ).rows[0];
  bus.emit("event", row);
  return row;
}
export function event(
  chatId: string | null,
  jobId: string | null,
  type: string,
  data: unknown,
  { packageStartupNotice = false } = {},
) {
  const next = writing.then(() =>
    writeEvent(chatId, jobId, type, data, packageStartupNotice),
  );
  writing = next.catch(() => {});
  return next;
}
export async function notify(chatId: string, title: string, body: string) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:owner@example.com",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
  for (const row of (await db.query("SELECT * FROM push_subscriptions")).rows) {
    try {
      await webpush.sendNotification(
        row.subscription,
        JSON.stringify({ chatId, title, body }),
        { TTL: 3600, timeout: 10000 },
      );
    } catch (e: any) {
      if ([404, 410].includes(e.statusCode))
        await db.query("DELETE FROM push_subscriptions WHERE endpoint=$1", [
          row.endpoint,
        ]);
    }
  }
}

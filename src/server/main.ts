import { mkdir } from "node:fs/promises";
import { config, validateConfig } from "./config.js";
import { db, migrate } from "./db.js";
import { createApp } from "./app.js";
import { startWorker } from "./worker.js";
validateConfig();
await mkdir(config.data, { recursive: true, mode: 0o700 });
await migrate();
// One supervisor owns Docker leases and event delivery. A second replica must not recover live jobs.
const leader = await db.connect();
if (!(await leader.query("SELECT pg_try_advisory_lock(417029) ok")).rows[0].ok)
  throw new Error("Another workspace supervisor is already running");
const app = await createApp();
const stop = await startWorker();
await app.listen({ host: "0.0.0.0", port: config.port });
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await stop();
  await app.close();
  await leader.query("SELECT pg_advisory_unlock(417029)");
  leader.release();
  await db.end();
  process.exit(0);
}
process.on("SIGINT", close);
process.on("SIGTERM", close);

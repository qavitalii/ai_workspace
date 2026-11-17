import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, transaction } from "./db.js";
import { seal } from "./security.js";
import { serverInput, fingerprint } from "../ssh.js";
import { sshOperation, withPrivateKeys } from "./ssh-runtime.js";

const serverFields =
  "id,name,alias,host,port,username,key_id,host_keys,last_checked_at,last_check_ok,last_check_message";
const keyFields = "id,name,public_key,fingerprint,created_at";
const pending = new Map<
  string,
  { serverId: string; keys: string[]; expires: number }
>();
const checks = new Set<string>();
const fail = (message: string, statusCode = 409) =>
  Object.assign(new Error(message), { statusCode });
const idOf = (req: any) => z.uuid().parse(req.params.id);
type Query = Pick<typeof db, "query">;
async function exists(c: Query, scope: "projects" | "chats", id: string) {
  const row = (await c.query(`SELECT * FROM ${scope} WHERE id=$1`, [id]))
    .rows[0];
  if (!row) throw fail("Not found", 404);
  return row;
}
export async function requireSshIdle(
  c: Query,
  serverIds: string[] = [],
  scope?: "projects" | "chats",
  id?: string,
) {
  if (serverIds.some((id) => checks.has(id)))
    throw fail("Wait for the SSH check to finish.");
  const busy = await c.query(
    `SELECT 1 FROM chats ch WHERE
    (($2::text='projects' AND ch.project_id=$3::uuid) OR ($2::text='chats' AND ch.id=$3::uuid) OR
    EXISTS(SELECT 1 FROM ssh_links l WHERE l.server_id=ANY($1::uuid[]) AND (l.chat_id=ch.id OR l.project_id=ch.project_id)))
    AND (EXISTS(SELECT 1 FROM jobs j WHERE j.chat_id=ch.id AND j.state IN ('queued','running','waiting_approval','waiting_account'))
      OR EXISTS(SELECT 1 FROM workspace_leases w WHERE w.chat_id=ch.id)) LIMIT 1`,
    [scope ? [] : serverIds, scope || null, id || null],
  );
  if (busy.rowCount)
    throw fail(
      "Stop queued or active tasks and close terminals before changing SSH access.",
    );
}
async function lock(c: Query) {
  await c.query("SELECT pg_advisory_xact_lock(417028)");
}
async function server(c: Query, id: string) {
  const s = (
    await c.query(
      "SELECT s.*,k.public_key FROM ssh_servers s JOIN ssh_keys k ON k.id=s.key_id WHERE s.id=$1",
      [id],
    )
  ).rows[0];
  if (!s) throw fail("Server not found", 404);
  return s;
}

export function sshRoutes(app: FastifyInstance) {
  app.get(
    "/api/ssh-keys",
    async () =>
      (await db.query(`SELECT ${keyFields} FROM ssh_keys ORDER BY created_at`))
        .rows,
  );
  app.post(
    "/api/ssh-keys",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req) => {
      const input = z
        .object({
          name: z.string().trim().min(1).max(100),
          operation: z.enum(["generate", "import"]),
          private_key: z.string().max(65536).optional(),
          passphrase: z
            .string()
            .max(1024)
            .regex(/^[^\x00-\x1f\x7f]*$/)
            .optional(),
        })
        .parse(req.body);
      if (input.operation === "import" && !input.private_key?.trim())
        throw fail("Choose a private key to import.", 400);
      let key;
      try {
        key = await sshOperation(input);
      } catch {
        throw fail(
          "Could not read the SSH key. Check its format and passphrase, and that the runner image is up to date.",
          400,
        );
      }
      return (
        await db.query(
          `INSERT INTO ssh_keys(id,name,private_key,public_key,fingerprint) VALUES($1,$2,$3,$4,$5) RETURNING ${keyFields}`,
          [
            randomUUID(),
            input.name,
            seal(key.private_key),
            key.public_key,
            key.fingerprint,
          ],
        )
      ).rows[0];
    },
  );
  app.delete("/api/ssh-keys/:id", async (req) =>
    transaction(async (c) => {
      await lock(c);
      const id = idOf(req);
      if (
        (await c.query("SELECT 1 FROM ssh_servers WHERE key_id=$1", [id]))
          .rowCount
      )
        throw fail(
          "Replace this key on its servers or remove those connections first.",
        );
      await c.query("DELETE FROM ssh_keys WHERE id=$1", [id]);
      return { ok: true };
    }),
  );
  app.get(
    "/api/servers",
    async () =>
      (await db.query(`SELECT ${serverFields} FROM ssh_servers ORDER BY name`))
        .rows,
  );
  app.post("/api/servers", async (req) =>
    transaction(async (c) => {
      await lock(c);
      const s = serverInput.parse(req.body);
      if (
        !(await c.query("SELECT 1 FROM ssh_keys WHERE id=$1", [s.key_id]))
          .rowCount
      )
        throw fail("SSH key not found", 400);
      return (
        await c.query(
          `INSERT INTO ssh_servers(id,name,alias,host,port,username,key_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${serverFields}`,
          [randomUUID(), s.name, s.alias, s.host, s.port, s.username, s.key_id],
        )
      ).rows[0];
    }),
  );
  app.patch("/api/servers/:id", async (req) =>
    transaction(async (c) => {
      await lock(c);
      const id = idOf(req),
        s = serverInput.parse(req.body),
        old = await server(c, id);
      await requireSshIdle(c, [id]);
      if (
        !(await c.query("SELECT 1 FROM ssh_keys WHERE id=$1", [s.key_id]))
          .rowCount
      )
        throw fail("SSH key not found", 400);
      const resetTrust = s.host !== old.host || s.port !== old.port;
      await c.query(
        `UPDATE ssh_servers SET name=$2,alias=$3,host=$4,port=$5,username=$6,key_id=$7,
      host_keys=CASE WHEN $8 THEN '[]'::jsonb ELSE host_keys END,last_checked_at=NULL,last_check_ok=NULL,last_check_message=NULL WHERE id=$1`,
        [id, s.name, s.alias, s.host, s.port, s.username, s.key_id, resetTrust],
      );
      for (const [token, p] of pending)
        if (p.serverId === id) pending.delete(token);
      return { ok: true };
    }),
  );
  app.delete("/api/servers/:id", async (req) =>
    transaction(async (c) => {
      await lock(c);
      const id = idOf(req);
      await requireSshIdle(c, [id]);
      await c.query("DELETE FROM ssh_servers WHERE id=$1", [id]);
      for (const [token, p] of pending)
        if (p.serverId === id) pending.delete(token);
      return { ok: true };
    }),
  );

  for (const action of ["scan", "test"] as const)
    app.post(
      `/api/servers/:id/${action}`,
      { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
      async (req) => {
        const id = idOf(req);
        const s = await transaction(async (c) => {
          await lock(c);
          const s = await server(c, id);
          if (checks.has(id)) throw fail("An SSH check is already running.");
          if (action === "test" && !s.host_keys.length)
            throw fail("Confirm the server fingerprint first.");
          checks.add(id);
          return s;
        });
        try {
          if (action === "scan") {
            const keys = await sshOperation({ operation: "scan", server: s });
            for (const [token, p] of pending)
              if (p.expires < Date.now() || p.serverId === id)
                pending.delete(token);
            const token = randomUUID();
            pending.set(token, {
              serverId: id,
              keys,
              expires: Date.now() + 5 * 60000,
            });
            return {
              token,
              keys: keys.map((key: string) => ({
                key,
                fingerprint: fingerprint(key),
              })),
            };
          }
          const result = await sshOperation({
            operation: "test",
            servers: await withPrivateKeys([s]),
          });
          const checked_at = new Date().toISOString();
          await db.query(
            "UPDATE ssh_servers SET last_checked_at=$2,last_check_ok=$3,last_check_message=$4 WHERE id=$1",
            [id, checked_at, result.ok, result.message],
          );
          return { ...result, checked_at };
        } catch {
          throw fail(
            "SSH check could not finish. Check the server address, port and availability.",
            400,
          );
        } finally {
          checks.delete(id);
        }
      },
    );
  app.post("/api/servers/:id/trust", async (req) =>
    transaction(async (c) => {
      await lock(c);
      const id = idOf(req),
        { token } = z.object({ token: z.uuid() }).parse(req.body);
      await server(c, id);
      await requireSshIdle(c, [id]);
      const p = pending.get(token);
      if (!p || p.serverId !== id || p.expires < Date.now())
        throw fail("Fingerprint review expired. Scan the server again.");
      await c.query(
        "UPDATE ssh_servers SET host_keys=$2,last_checked_at=NULL,last_check_ok=NULL,last_check_message=NULL WHERE id=$1",
        [id, JSON.stringify(p.keys)],
      );
      pending.delete(token);
      return { ok: true };
    }),
  );
  for (const scope of ["projects", "chats"] as const) {
    const column = scope === "projects" ? "project_id" : "chat_id";
    app.get(`/api/${scope}/:id/servers`, async (req) => {
      const id = idOf(req),
        row = await exists(db, scope, id);
      const projectId = scope === "chats" ? row.project_id : id;
      return {
        inherited: scope === "chats" && !!projectId,
        server_ids: (
          await db.query(
            `SELECT server_id FROM ssh_links WHERE ${projectId ? "project_id" : "chat_id"}=$1`,
            [projectId || id],
          )
        ).rows.map((r) => r.server_id),
      };
    });
    app.put(`/api/${scope}/:id/servers`, async (req) =>
      transaction(async (c) => {
        await lock(c);
        const id = idOf(req),
          row = await exists(c, scope, id);
        if (scope === "chats" && row.project_id)
          throw fail("Manage inherited SSH access in project settings.");
        const { server_ids } = z
          .object({ server_ids: z.array(z.uuid()).max(100) })
          .parse(req.body);
        const old = (
          await c.query(`SELECT server_id FROM ssh_links WHERE ${column}=$1`, [
            id,
          ])
        ).rows.map((r) => r.server_id);
        await requireSshIdle(c, [...old, ...server_ids], scope, id);
        if (
          (
            await c.query(
              "SELECT id FROM ssh_servers WHERE id=ANY($1::uuid[])",
              [server_ids],
            )
          ).rowCount !== new Set(server_ids).size
        )
          throw fail("Server not found", 400);
        await c.query(`DELETE FROM ssh_links WHERE ${column}=$1`, [id]);
        for (const serverId of new Set(server_ids))
          await c.query(
            `INSERT INTO ssh_links(id,server_id,${column}) VALUES($1,$2,$3)`,
            [randomUUID(), serverId, id],
          );
        return { ok: true };
      }),
    );
  }
}

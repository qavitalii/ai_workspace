import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "./db.js";
import { seal, unseal } from "./security.js";
import type { ProjectIntegration, Provider } from "../shared.js";

const provider = z.enum(["codex", "claude", "both"]);
const name = z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/);
const endpoint = z
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  });
const mcp = z.object({
  kind: z.literal("mcp"),
  name,
  provider,
  target: endpoint,
  token: z
    .string()
    .max(4096)
    .regex(/^[\x21-\x7e]*$/)
    .default(""),
});
export const integrationInput = z.union([
  mcp,
  z.object({
    kind: z.literal("plugin"),
    name,
    provider: z.literal("codex"),
    target: z
      .string()
      .max(180)
      .regex(/^[a-z0-9][a-z0-9_-]*@[a-z0-9][a-z0-9_-]*$/),
  }),
  z.object({
    kind: z.literal("plugin"),
    name,
    provider: z.literal("claude"),
    target: z
      .string()
      .max(300)
      .regex(/^[\w-]+(?:\/[\w.-]+)*$/)
      .refine((p) => p.split("/").every((s) => s !== "." && s !== "..")),
  }),
]);
export async function runIntegrations(
  project: string | null,
  agent: Provider,
): Promise<ProjectIntegration[]> {
  if (!project) return [];
  const rows = await db.query(
    "SELECT kind,name,target,secret FROM project_integrations WHERE project_id=$1 AND enabled AND provider IN ($2,'both') ORDER BY name",
    [project, agent],
  );
  return rows.rows.map(({ kind, name, target, secret }) => ({
    kind,
    name,
    target,
    ...(secret ? { token: unseal(secret) } : {}),
  }));
}

export function integrationRoutes(app: FastifyInstance) {
  const route = "/api/projects/:id/integrations";
  const project = (params: unknown) =>
    z.object({ id: z.uuid() }).parse(params).id;
  const keys = (params: unknown) => {
    const { id, entry } = z
      .object({ id: z.uuid(), entry: z.uuid() })
      .parse(params);
    return [id, entry];
  };
  app.get(
    route,
    async (req) =>
      (
        await db.query(
          "SELECT id,kind,name,provider,target,enabled FROM project_integrations WHERE project_id=$1 ORDER BY name",
          [project(req.params)],
        )
      ).rows,
  );
  app.post(route, async (req, reply) => {
    const entry = integrationInput.parse(req.body);
    const result = await db.query(
      "INSERT INTO project_integrations(project_id,kind,name,provider,target,secret) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (project_id,name) DO NOTHING",
      [
        project(req.params),
        entry.kind,
        entry.name,
        entry.provider,
        entry.target,
        entry.kind === "mcp" && entry.token ? seal(entry.token) : null,
      ],
    );
    if (!result.rowCount)
      return reply
        .code(409)
        .send({
          error: "This project already has a connection with that name.",
        });
    return { ok: true };
  });
  app.patch(route + "/:entry", async (req, reply) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    const result = await db.query(
      "UPDATE project_integrations SET enabled=$3 WHERE project_id=$1 AND id=$2",
      [...keys(req.params), enabled],
    );
    if (!result.rowCount)
      return reply.code(404).send({ error: "Integration not found" });
    return { ok: true };
  });
  app.delete(route + "/:entry", async (req) => {
    await db.query(
      "DELETE FROM project_integrations WHERE project_id=$1 AND id=$2",
      keys(req.params),
    );
    return { ok: true };
  });
}

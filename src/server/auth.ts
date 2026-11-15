import type { FastifyInstance } from "fastify";
import argon2 from "argon2";
import * as OTPAuth from "otpauth";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { db, transaction } from "./db.js";
import { hash, unseal } from "./security.js";
import { config } from "./config.js";
export async function authenticated(token?: string) {
  if (!token) return false;
  return (
    (
      await db.query(
        "SELECT 1 FROM sessions WHERE token_hash=$1 AND expires_at>now()",
        [hash(token)],
      )
    ).rowCount === 1
  );
}
export async function authRoutes(app: FastifyInstance) {
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    if (req.headers.origin && req.headers.origin !== config.origin)
      return reply.code(403).send({ error: "Origin not allowed" });
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin !== config.origin
    )
      return reply.code(403).send({ error: "Origin required" });
    if (req.url === "/api/login" || req.url === "/api/health") return;
    if (!(await authenticated(req.cookies.session)))
      return reply.code(401).send({ error: "Sign in to Workspace" });
  });
  app.get("/api/health", async () => {
    await db.query("SELECT 1");
    return { ok: true };
  });
  app.post(
    "/api/login",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { password, code } = z
        .object({
          password: z.string().max(256),
          code: z.string().regex(/^\d{6}$/),
        })
        .parse(req.body);
      const owner = (await db.query("SELECT * FROM owner WHERE id=1")).rows[0];
      if (!owner || !(await argon2.verify(owner.password_hash, password)))
        return reply.code(401).send({ error: "Incorrect password or code" });
      const totp = new OTPAuth.TOTP({
        secret: OTPAuth.Secret.fromBase32(unseal(owner.totp_secret)),
        digits: 6,
        period: 30,
      });
      const delta = totp.validate({ token: code, window: 1 });
      if (delta === null)
        return reply.code(401).send({ error: "Incorrect password or code" });
      const counter = Math.floor(Date.now() / 30000) + delta,
        token = randomBytes(32).toString("hex");
      const ok = await transaction(async (c) => {
        const r = await c.query(
          "UPDATE owner SET last_totp=$1 WHERE id=1 AND last_totp<$1",
          [counter],
        );
        if (!r.rowCount) return false;
        await c.query(
          "INSERT INTO sessions VALUES($1,now()+interval '7 days')",
          [hash(token)],
        );
        return true;
      });
      if (!ok)
        return reply
          .code(401)
          .send({
            error: "This code has already been used. Wait for the next one.",
          });
      reply.setCookie("session", token, {
        path: "/",
        httpOnly: true,
        secure: config.production,
        sameSite: "strict",
        maxAge: 604800,
      });
      return { ok: true };
    },
  );
  app.get("/api/me", async () => ({
    ok: true,
    maxAttachments: config.maxAttachments,
    maxFileBytes: config.maxFile,
    autoHandoff: config.autoHandoff,
    vapidKey: process.env.VAPID_PUBLIC_KEY || "",
  }));
  app.post("/api/logout", async (req, reply) => {
    await db.query("DELETE FROM sessions WHERE token_hash=$1", [
      hash(req.cookies.session || ""),
    ]);
    reply.clearCookie("session", { path: "/" });
    return { ok: true };
  });
}

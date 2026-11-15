import pg from "pg";
import { config } from "./config.js";
export const db = new pg.Pool({ connectionString: config.database, max: 12 });
export async function transaction<T>(fn: (c: pg.PoolClient) => Promise<T>) {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
export async function migrate() {
  await db.query(`
CREATE TABLE IF NOT EXISTS owner(id int PRIMARY KEY CHECK(id=1),password_hash text NOT NULL,totp_secret text NOT NULL,last_totp bigint NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(token_hash text PRIMARY KEY,expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key text PRIMARY KEY,value text NOT NULL);
CREATE TABLE IF NOT EXISTS projects(id uuid PRIMARY KEY,name text NOT NULL,repo text NOT NULL,base_branch text NOT NULL DEFAULT 'main',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS accounts(id uuid PRIMARY KEY,provider text NOT NULL CHECK(provider IN ('codex','claude')),name text NOT NULL,status text NOT NULL DEFAULT 'disconnected',priority int NOT NULL DEFAULT 0,reset_at timestamptz,limits jsonb,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS chats(id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id),title text NOT NULL,provider text NOT NULL CHECK(provider IN ('codex','claude')),account_id uuid REFERENCES accounts(id),model text NOT NULL DEFAULT '',effort text NOT NULL DEFAULT '',autonomous boolean NOT NULL DEFAULT false,handoff text NOT NULL DEFAULT 'manual' CHECK(handoff IN ('manual','auto')),session_id text,session_account uuid,summary text NOT NULL DEFAULT '',branch text NOT NULL,initialized boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS messages(id uuid PRIMARY KEY,chat_id uuid NOT NULL REFERENCES chats(id),role text NOT NULL,content text NOT NULL,client_id uuid,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(chat_id,client_id));
CREATE TABLE IF NOT EXISTS attachments(id uuid PRIMARY KEY,chat_id uuid NOT NULL REFERENCES chats(id),message_id uuid REFERENCES messages(id),name text NOT NULL,mime text NOT NULL,size bigint NOT NULL,storage_name text NOT NULL,client_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(chat_id,client_id));
CREATE TABLE IF NOT EXISTS jobs(id uuid PRIMARY KEY,chat_id uuid NOT NULL REFERENCES chats(id),message_id uuid NOT NULL REFERENCES messages(id),account_id uuid REFERENCES accounts(id),state text NOT NULL DEFAULT 'queued',attempt int NOT NULL DEFAULT 0,error text,container_id text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS one_live_job_per_chat ON jobs(chat_id) WHERE state IN ('queued','running','waiting_approval','waiting_account');
CREATE UNIQUE INDEX IF NOT EXISTS one_live_job_per_account ON jobs(account_id) WHERE state IN ('running','waiting_approval');
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cancel_requested boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS workspace_leases(chat_id uuid PRIMARY KEY REFERENCES chats(id),kind text NOT NULL);
CREATE TABLE IF NOT EXISTS events(id bigserial PRIMARY KEY,chat_id uuid REFERENCES chats(id),job_id uuid REFERENCES jobs(id),type text NOT NULL,data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS events_chat ON events(chat_id,id);
CREATE TABLE IF NOT EXISTS approvals(id uuid PRIMARY KEY,job_id uuid NOT NULL REFERENCES jobs(id),request_id text NOT NULL,description text NOT NULL,decision boolean,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS push_subscriptions(endpoint text PRIMARY KEY,subscription jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS publications(id uuid PRIMARY KEY,chat_id uuid NOT NULL REFERENCES chats(id),kind text NOT NULL,status text NOT NULL,result jsonb,created_at timestamptz NOT NULL DEFAULT now());
`);
}

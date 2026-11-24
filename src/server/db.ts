import pg from "pg";
import { migrateOutputStorage } from "./output-storage.js";
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
  await transaction(async (c) => {
    await c.query(`
CREATE TABLE IF NOT EXISTS owner(id int PRIMARY KEY CHECK(id=1),password_hash text NOT NULL,totp_secret text NOT NULL,last_totp bigint NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(token_hash text PRIMARY KEY,expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key text PRIMARY KEY,value text NOT NULL);
CREATE TABLE IF NOT EXISTS ssh_keys(id uuid PRIMARY KEY,name text NOT NULL,private_key text NOT NULL,public_key text NOT NULL,fingerprint text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS ssh_servers(id uuid PRIMARY KEY,name text NOT NULL,alias text NOT NULL UNIQUE,host text NOT NULL,port int NOT NULL CHECK(port BETWEEN 1 AND 65535),username text NOT NULL,key_id uuid NOT NULL REFERENCES ssh_keys(id),host_keys jsonb NOT NULL DEFAULT '[]',last_checked_at timestamptz,last_check_ok boolean,last_check_message text);
CREATE TABLE IF NOT EXISTS projects(id uuid PRIMARY KEY,name text NOT NULL,repo text NOT NULL,base_branch text NOT NULL DEFAULT 'main',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS project_integrations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE, kind text NOT NULL, name text NOT NULL, provider text NOT NULL, target text NOT NULL, secret text, enabled boolean NOT NULL DEFAULT true, UNIQUE(project_id,name));
CREATE TABLE IF NOT EXISTS aws_connections(project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,settings jsonb NOT NULL,session text,identity text,generation uuid);
CREATE TABLE IF NOT EXISTS imported_skills(
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  revision uuid NOT NULL,
  description text NOT NULL,
  hints text[] NOT NULL,
  bytes int NOT NULL,
  files jsonb NOT NULL,
  UNIQUE NULLS NOT DISTINCT(project_id,name)
);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_token text;
UPDATE projects SET github_token=COALESCE((SELECT value FROM settings WHERE key='github_token'),'') WHERE github_token IS NULL;
ALTER TABLE projects ALTER COLUMN github_token SET DEFAULT '';
ALTER TABLE projects ALTER COLUMN github_token SET NOT NULL;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS auto_packages boolean NOT NULL DEFAULT true;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS env_size_bytes bigint;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS env_measured_at timestamptz;
CREATE TABLE IF NOT EXISTS accounts(id uuid PRIMARY KEY,provider text NOT NULL CHECK(provider IN ('codex','claude')),name text NOT NULL,status text NOT NULL DEFAULT 'disconnected',priority int NOT NULL DEFAULT 0,reset_at timestamptz,limits jsonb,created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS limits_updated_at timestamptz;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS model_catalog jsonb;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS models_updated_at timestamptz;
CREATE TABLE IF NOT EXISTS chats(id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id),title text NOT NULL,provider text NOT NULL CHECK(provider IN ('codex','claude')),account_id uuid REFERENCES accounts(id),model text NOT NULL DEFAULT '',effort text NOT NULL DEFAULT '',autonomous boolean NOT NULL DEFAULT false,handoff text NOT NULL DEFAULT 'manual' CHECK(handoff IN ('manual','auto')),session_id text,session_account uuid,summary text NOT NULL DEFAULT '',branch text NOT NULL,initialized boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE chats ALTER COLUMN project_id DROP NOT NULL;
CREATE TABLE IF NOT EXISTS project_packages(
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  source text NOT NULL CHECK(source IN ('agent','owner')),
  source_chat_id uuid REFERENCES chats(id) ON DELETE SET NULL,
  request_id uuid NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  failures integer NOT NULL DEFAULT 0,
  disabled boolean NOT NULL DEFAULT false,
  PRIMARY KEY(project_id,name)
);
CREATE INDEX IF NOT EXISTS project_packages_source_chat ON project_packages(source_chat_id) WHERE source_chat_id IS NOT NULL;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS package_image_requested_at timestamptz;
CREATE INDEX IF NOT EXISTS projects_pending_images ON projects(package_image_requested_at,id)
  WHERE package_image_requested_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS project_images(
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  hash text NOT NULL,
  image_id text,
  state text NOT NULL CHECK(state IN ('building','ready','failed')),
  error text,
  log text NOT NULL DEFAULT '',
  built_at timestamptz
);
CREATE TABLE IF NOT EXISTS ssh_links(id uuid PRIMARY KEY,server_id uuid NOT NULL REFERENCES ssh_servers(id) ON DELETE CASCADE,project_id uuid REFERENCES projects(id) ON DELETE CASCADE,chat_id uuid REFERENCES chats(id) ON DELETE CASCADE,CHECK((project_id IS NULL) <> (chat_id IS NULL)));
CREATE UNIQUE INDEX IF NOT EXISTS ssh_link_project ON ssh_links(project_id,server_id) WHERE project_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ssh_link_chat ON ssh_links(chat_id,server_id) WHERE chat_id IS NOT NULL;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS auto_title boolean NOT NULL DEFAULT false;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS resolved_model text NOT NULL DEFAULT '';
ALTER TABLE chats ADD COLUMN IF NOT EXISTS resolved_effort text NOT NULL DEFAULT '';
ALTER TABLE chats ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'default';
ALTER TABLE chats ADD COLUMN IF NOT EXISTS native_commands jsonb NOT NULL DEFAULT '[]';
CREATE TABLE IF NOT EXISTS workspaces(
  id uuid PRIMARY KEY,
  project_id uuid REFERENCES projects(id),
  name text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('main','saved','personal')),
  branch text NOT NULL,
  initialized boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK((kind='personal') = (project_id IS NULL))
);
ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS workspaces_kind_check;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_kind_check CHECK(kind IN ('main','saved','personal','copy'));
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ready';
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS source_workspace_id uuid REFERENCES workspaces(id);
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS base_snapshot_id uuid;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS last_applied_at timestamptz;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS copy_exclusions jsonb NOT NULL DEFAULT '[]';
CREATE TABLE IF NOT EXISTS workspace_operations(id uuid PRIMARY KEY,kind text NOT NULL,workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,main_workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,status text NOT NULL,result jsonb,base_snapshot_id uuid,created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS storage_mode text NOT NULL DEFAULT 'legacy';
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS git_source_id uuid REFERENCES workspaces(id);
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS resolution_review_id uuid REFERENCES workspace_operations(id);
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS resolution_operation_id uuid REFERENCES workspace_operations(id);
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS resolution_source_id uuid REFERENCES workspaces(id);
CREATE UNIQUE INDEX IF NOT EXISTS one_main_workspace ON workspaces(project_id) WHERE kind='main';
ALTER TABLE chats ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES workspaces(id);
-- Existing directory IDs remain unchanged. No files are moved, merged or removed.
INSERT INTO workspaces(id,project_id,name,kind,branch,initialized,created_at)
SELECT id,project_id,title,CASE WHEN project_id IS NULL THEN 'personal' ELSE 'saved' END,branch,initialized,created_at
FROM chats WHERE workspace_id IS NULL ON CONFLICT(id) DO NOTHING;
UPDATE chats SET workspace_id=id WHERE workspace_id IS NULL;
ALTER TABLE chats ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS chats_workspace ON chats(workspace_id);
CREATE TABLE IF NOT EXISTS folder_links(id uuid PRIMARY KEY,name text NOT NULL,chat_id uuid REFERENCES chats(id) ON DELETE CASCADE,project_id uuid REFERENCES projects(id) ON DELETE CASCADE,read_only boolean NOT NULL DEFAULT true,CHECK((chat_id IS NULL) <> (project_id IS NULL)));
CREATE UNIQUE INDEX IF NOT EXISTS folder_link_chat ON folder_links(chat_id,name) WHERE chat_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS folder_link_project ON folder_links(project_id,name) WHERE project_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS messages(id uuid PRIMARY KEY,chat_id uuid NOT NULL REFERENCES chats(id),role text NOT NULL,content text NOT NULL,client_id uuid,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(chat_id,client_id));
ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider text CHECK(provider IN ('codex','claude'));
CREATE TABLE IF NOT EXISTS attachments(id uuid PRIMARY KEY,chat_id uuid NOT NULL REFERENCES chats(id),message_id uuid REFERENCES messages(id),name text NOT NULL,mime text NOT NULL,size bigint NOT NULL,storage_name text NOT NULL,client_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(chat_id,client_id));
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES workspaces(id);
UPDATE attachments a SET workspace_id=c.workspace_id FROM chats c WHERE a.chat_id=c.id AND a.workspace_id IS NULL;
ALTER TABLE attachments ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE attachments ALTER COLUMN chat_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS attachments_workspace ON attachments(workspace_id);
CREATE TABLE IF NOT EXISTS jobs(id uuid PRIMARY KEY,chat_id uuid NOT NULL REFERENCES chats(id),message_id uuid NOT NULL REFERENCES messages(id),account_id uuid REFERENCES accounts(id),state text NOT NULL DEFAULT 'queued',attempt int NOT NULL DEFAULT 0,error text,container_id text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS one_live_job_per_chat ON jobs(chat_id) WHERE state IN ('queued','running','waiting_approval','waiting_account');
CREATE UNIQUE INDEX IF NOT EXISTS one_live_job_per_account ON jobs(account_id) WHERE state IN ('running','waiting_approval');
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cancel_requested boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS workspace_leases(chat_id uuid PRIMARY KEY REFERENCES chats(id),kind text NOT NULL);
ALTER TABLE workspace_leases ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES workspaces(id);
UPDATE workspace_leases l SET workspace_id=c.workspace_id FROM chats c WHERE l.chat_id=c.id AND l.workspace_id IS NULL;
ALTER TABLE workspace_leases DROP CONSTRAINT IF EXISTS workspace_leases_pkey;
ALTER TABLE workspace_leases ALTER COLUMN chat_id DROP NOT NULL;
ALTER TABLE workspace_leases ADD PRIMARY KEY(workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_lease_chat ON workspace_leases(chat_id);
CREATE TABLE IF NOT EXISTS events(id bigserial PRIMARY KEY,chat_id uuid REFERENCES chats(id),job_id uuid REFERENCES jobs(id),type text NOT NULL,data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE events ADD COLUMN IF NOT EXISTS package_startup_notice boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS events_chat ON events(chat_id,id);
CREATE INDEX IF NOT EXISTS events_job_output ON events(job_id) WHERE type IN ('delta','completed');
CREATE INDEX IF NOT EXISTS events_project_package_startup ON events(job_id,id) WHERE type IN ('log','warning') AND data @> '{"projectPackageStartup":true}';
CREATE TABLE IF NOT EXISTS approvals(id uuid PRIMARY KEY,job_id uuid NOT NULL REFERENCES jobs(id),request_id text NOT NULL,description text NOT NULL,decision boolean,created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'permission';
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS questions jsonb;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS details jsonb;
CREATE TABLE IF NOT EXISTS push_subscriptions(endpoint text PRIMARY KEY,subscription jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS publications(id uuid PRIMARY KEY,chat_id uuid NOT NULL REFERENCES chats(id),kind text NOT NULL,status text NOT NULL,result jsonb,created_at timestamptz NOT NULL DEFAULT now());
`);
    await migrateOutputStorage(c);
  });
}

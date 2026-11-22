import type pg from "pg";
import { db } from "./db.js";
import { config } from "./config.js";

export const GB = 1_000_000_000;
export const outputLimitMessage =
  "Saved agent output limit reached. Increase the GB limit in Server settings or delete old chats, then retry.";
export function isOutputLimit(error: any) {
  return error?.code === "P5401";
}
export async function outputStorage() {
  const row = (await db.query("SELECT * FROM output_storage WHERE id=1"))
    .rows[0];
  return {
    usedBytes: Number(row.used_bytes),
    limitBytes: Number(row.limit_bytes),
    limitGb: Number(row.limit_bytes) / GB,
  };
}

// Database triggers serialize reservations across simultaneous jobs and release
// bytes in the same transaction as deletion. Existing data is never evicted.
export async function migrateOutputStorage(c: pg.PoolClient) {
  await c.query(`
CREATE TABLE IF NOT EXISTS output_storage(
  id int PRIMARY KEY CHECK(id=1),
  used_bytes bigint NOT NULL CHECK(used_bytes>=0),
  limit_bytes bigint NOT NULL CHECK(limit_bytes>0)
);
CREATE OR REPLACE FUNCTION output_row_bytes(tbl text, r jsonb) RETURNS bigint
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN r IS NULL THEN 0 ELSE CASE tbl
    WHEN 'events' THEN CASE WHEN r->>'package_startup_notice'='true' THEN 0 ELSE octet_length((r->'data')::text) + 256 END
    WHEN 'messages' THEN CASE WHEN r->>'role'='assistant' THEN octet_length(r->>'content') + 256 ELSE 0 END
    WHEN 'approvals' THEN octet_length(r->>'description') + COALESCE(octet_length((r->'details')::text),0) + COALESCE(octet_length((r->'questions')::text),0) + 256
    WHEN 'chats' THEN octet_length(r->>'summary')
    ELSE 0 END END::bigint
$$;
CREATE OR REPLACE FUNCTION output_total_bytes() RETURNS bigint LANGUAGE sql AS $$
  SELECT COALESCE((SELECT sum(output_row_bytes('events',to_jsonb(e))) FROM events e),0)
    + COALESCE((SELECT sum(output_row_bytes('messages',to_jsonb(m))) FROM messages m),0)
    + COALESCE((SELECT sum(output_row_bytes('approvals',to_jsonb(a))) FROM approvals a),0)
    + COALESCE((SELECT sum(output_row_bytes('chats',to_jsonb(c))) FROM chats c),0)
$$;
`);
  await c.query(
    "INSERT INTO output_storage(id,used_bytes,limit_bytes) SELECT 1,output_total_bytes(),$1 WHERE NOT EXISTS(SELECT 1 FROM output_storage WHERE id=1)",
    [Math.round(config.outputLimitGb * GB)],
  );
  await c.query(`
CREATE OR REPLACE FUNCTION account_output_bytes() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE delta bigint;
BEGIN
  IF TG_OP='TRUNCATE' THEN
    UPDATE output_storage SET used_bytes=output_total_bytes() WHERE id=1;
    RETURN NULL;
  END IF;
  delta := output_row_bytes(TG_TABLE_NAME,CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END)
         - output_row_bytes(TG_TABLE_NAME,CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END);
  IF delta<>0 THEN
    UPDATE output_storage SET used_bytes=used_bytes+delta
      WHERE id=1 AND (delta<0 OR used_bytes+delta<=limit_bytes);
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE='P5401', MESSAGE='Saved agent output limit reached. Increase the GB limit in Server settings or delete old chats, then retry.';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
`);
  for (const table of ["events", "messages", "approvals", "chats"]) {
    await c.query(`
DROP TRIGGER IF EXISTS output_bytes ON ${table};
CREATE TRIGGER output_bytes AFTER INSERT OR UPDATE OR DELETE ON ${table}
  FOR EACH ROW EXECUTE FUNCTION account_output_bytes();
DROP TRIGGER IF EXISTS output_truncate ON ${table};
CREATE TRIGGER output_truncate AFTER TRUNCATE ON ${table}
  FOR EACH STATEMENT EXECUTE FUNCTION account_output_bytes();
`);
  }
}

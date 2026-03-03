import { randomUUID, createHash } from "node:crypto";
import type { Pool } from "pg";
import pg from "pg";

export type PgAuditSettings = {
  connectionString: string;
  schema: string;
  eventsTable: string;
  memoryTable: string;
  maxBatchSize: number;
  flushIntervalMs: number;
};

export type AuditEventRow = {
  id: string;
  ts: Date;
  teamId: string | null;
  instanceId: string | null;
  sessionKey: string;
  kind: string;
  action: string;
  payload: Record<string, unknown>;
};

export type MemoryPatchRow = {
  id: string;
  ts: Date;
  teamId: string | null;
  instanceId: string | null;
  agentId: string | null;
  workspaceDir: string | null;
  path: string;
  baseVersion: bigint;
  version: bigint;
  beforeHash: string;
  afterHash: string;
  patch: string;
};

export function newEventId(): string {
  return randomUUID();
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function resolvePgSettings(raw?: Partial<PgAuditSettings> & { connectionString?: string }) {
  const connectionString = raw?.connectionString?.trim() ?? "";
  if (!connectionString) {
    return null;
  }
  return {
    connectionString,
    schema: raw?.schema?.trim() || "public",
    eventsTable: raw?.eventsTable?.trim() || "openclaw_audit_events",
    memoryTable: raw?.memoryTable?.trim() || "openclaw_memory_patches",
    maxBatchSize: Math.max(1, raw?.maxBatchSize ?? 200),
    flushIntervalMs: Math.max(50, raw?.flushIntervalMs ?? 1000),
  } satisfies PgAuditSettings;
}

export function createPool(settings: PgAuditSettings): Pool {
  const { Pool } = pg;
  return new Pool({
    connectionString: settings.connectionString,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

export async function ensureSchemaAndTables(pool: Pool, settings: PgAuditSettings) {
  const schema = settings.schema;
  const eventsTable = settings.eventsTable;
  const memoryTable = settings.memoryTable;

  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "${schema}"."${eventsTable}" (
      id uuid PRIMARY KEY,
      ts timestamptz NOT NULL,
      team_id text NULL,
      instance_id text NULL,
      session_key text NOT NULL,
      kind text NOT NULL,
      action text NOT NULL,
      payload jsonb NOT NULL
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS "${eventsTable}_ts_idx"
    ON "${schema}"."${eventsTable}" (ts DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS "${eventsTable}_team_ts_idx"
    ON "${schema}"."${eventsTable}" (team_id, ts DESC)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS "${schema}"."${memoryTable}" (
      id uuid PRIMARY KEY,
      ts timestamptz NOT NULL,
      team_id text NULL,
      instance_id text NULL,
      agent_id text NULL,
      workspace_dir text NULL,
      path text NOT NULL,
      base_version bigint NOT NULL,
      version bigint NOT NULL,
      before_hash text NOT NULL,
      after_hash text NOT NULL,
      patch text NOT NULL
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS "${memoryTable}_ts_idx"
    ON "${schema}"."${memoryTable}" (ts DESC)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "${memoryTable}_uniq_idx"
    ON "${schema}"."${memoryTable}" (team_id, agent_id, path, version)
  `);
}

export async function insertAuditEvents(pool: Pool, settings: PgAuditSettings, rows: AuditEventRow[]) {
  if (rows.length === 0) {
    return;
  }
  const schema = settings.schema;
  const table = settings.eventsTable;
  const values: unknown[] = [];
  const chunks: string[] = [];
  let i = 1;
  for (const row of rows) {
    chunks.push(
      `($${i++}::uuid,$${i++}::timestamptz,$${i++}::text,$${i++}::text,$${i++}::text,$${i++}::text,$${i++}::text,$${i++}::jsonb)`,
    );
    values.push(
      row.id,
      row.ts,
      row.teamId,
      row.instanceId,
      row.sessionKey,
      row.kind,
      row.action,
      row.payload,
    );
  }
  const sql = `INSERT INTO "${schema}"."${table}" (id, ts, team_id, instance_id, session_key, kind, action, payload) VALUES ${chunks.join(
    ",",
  )}`;
  await pool.query(sql, values);
}

export async function insertMemoryPatch(
  pool: Pool,
  settings: PgAuditSettings,
  row: Omit<MemoryPatchRow, "id" | "baseVersion" | "version">,
) {
  const schema = settings.schema;
  const table = settings.memoryTable;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const res = await client.query(
      `SELECT COALESCE(MAX(version), 0) AS v
       FROM "${schema}"."${table}"
       WHERE team_id IS NOT DISTINCT FROM $1::text
         AND agent_id IS NOT DISTINCT FROM $2::text
         AND path = $3::text`,
      [row.teamId, row.agentId, row.path],
    );
    const current = BigInt(res.rows[0]?.v ?? 0);
    const next = current + 1n;
    const baseVersion = current;

    await client.query(
      `INSERT INTO "${schema}"."${table}"
       (id, ts, team_id, instance_id, agent_id, workspace_dir, path, base_version, version, before_hash, after_hash, patch)
       VALUES ($1::uuid,$2::timestamptz,$3::text,$4::text,$5::text,$6::text,$7::text,$8::bigint,$9::bigint,$10::text,$11::text,$12::text)`,
      [
        randomUUID(),
        row.ts,
        row.teamId,
        row.instanceId,
        row.agentId,
        row.workspaceDir,
        row.path,
        baseVersion,
        next,
        row.beforeHash,
        row.afterHash,
        row.patch,
      ],
    );
    await client.query("COMMIT");
    return { baseVersion, version: next };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}


import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS oauth_tokens (
    id             INTEGER PRIMARY KEY CHECK (id = 1),
    access_token   TEXT NOT NULL,
    refresh_token  TEXT,
    expiry         TEXT NOT NULL,
    scopes         TEXT NOT NULL,
    health_user_id TEXT,
    legacy_user_id TEXT,
    updated_at     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS data_points (
    name       TEXT PRIMARY KEY,
    data_type  TEXT NOT NULL,
    start_time TEXT,
    end_time   TEXT,
    raw_json   TEXT NOT NULL,
    synced_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_data_points_type_start ON data_points (data_type, start_time);

  CREATE TABLE IF NOT EXISTS sync_state (
    data_type      TEXT PRIMARY KEY,
    cursor         TEXT,
    last_synced_at TEXT,
    last_error     TEXT
  );

  CREATE TABLE IF NOT EXISTS sync_runs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at   TEXT NOT NULL,
    finished_at  TEXT,
    status       TEXT NOT NULL,
    details_json TEXT
  );
`);

// ---------- tokens ----------

export interface StoredTokens {
  access_token: string;
  refresh_token: string | null;
  expiry: string;
  scopes: string;
  health_user_id: string | null;
  legacy_user_id: string | null;
  updated_at: string;
}

export function getTokens(): StoredTokens | undefined {
  return db.prepare('SELECT * FROM oauth_tokens WHERE id = 1').get() as StoredTokens | undefined;
}

export function saveTokens(t: { accessToken: string; refreshToken?: string; expiry: string; scopes: string }) {
  db.prepare(
    `INSERT INTO oauth_tokens (id, access_token, refresh_token, expiry, scopes, updated_at)
     VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       access_token  = excluded.access_token,
       refresh_token = COALESCE(excluded.refresh_token, oauth_tokens.refresh_token),
       expiry        = excluded.expiry,
       scopes        = excluded.scopes,
       updated_at    = excluded.updated_at`,
  ).run(t.accessToken, t.refreshToken ?? null, t.expiry, t.scopes, new Date().toISOString());
}

export function saveIdentity(healthUserId: string | null, legacyUserId: string | null) {
  db.prepare('UPDATE oauth_tokens SET health_user_id = ?, legacy_user_id = ? WHERE id = 1').run(
    healthUserId,
    legacyUserId,
  );
}

export function deleteTokens() {
  db.prepare('DELETE FROM oauth_tokens').run();
}

// ---------- data points ----------

export interface DataPointRow {
  name: string;
  data_type: string;
  start_time: string | null;
  end_time: string | null;
  raw_json: string;
  synced_at: string;
}

const upsertStmt = db.prepare(
  `INSERT INTO data_points (name, data_type, start_time, end_time, raw_json, synced_at)
   VALUES (?, ?, ?, ?, ?, ?)
   ON CONFLICT (name) DO UPDATE SET
     start_time = excluded.start_time,
     end_time   = excluded.end_time,
     raw_json   = excluded.raw_json,
     synced_at  = excluded.synced_at`,
);

export function upsertDataPoints(rows: Omit<DataPointRow, 'synced_at'>[]) {
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      upsertStmt.run(r.name, r.data_type, r.start_time, r.end_time, r.raw_json, now);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export interface DataQuery {
  dataType: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

function rangeWhere(q: DataQuery): { sql: string; params: string[] } {
  const clauses = ['data_type = ?'];
  const params = [q.dataType];
  if (q.from) {
    clauses.push('start_time >= ?');
    params.push(q.from);
  }
  if (q.to) {
    clauses.push('start_time < ?');
    params.push(q.to);
  }
  return { sql: clauses.join(' AND '), params };
}

export function queryDataPoints(q: DataQuery): { total: number; rows: DataPointRow[] } {
  const where = rangeWhere(q);
  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM data_points WHERE ${where.sql}`)
    .get(...where.params) as { total: number };
  const limitSql = q.limit === undefined ? '' : ` LIMIT ${Math.max(0, q.limit)} OFFSET ${Math.max(0, q.offset ?? 0)}`;
  const rows = db
    .prepare(`SELECT * FROM data_points WHERE ${where.sql} ORDER BY start_time DESC${limitSql}`)
    .all(...where.params) as unknown as DataPointRow[];
  return { total, rows };
}

export function countsByType(): Record<string, { count: number; first: string | null; last: string | null }> {
  const rows = db
    .prepare(
      'SELECT data_type, COUNT(*) AS count, MIN(start_time) AS first, MAX(start_time) AS last FROM data_points GROUP BY data_type',
    )
    .all() as { data_type: string; count: number; first: string | null; last: string | null }[];
  return Object.fromEntries(rows.map((r) => [r.data_type, { count: r.count, first: r.first, last: r.last }]));
}

// ---------- sync state ----------

export interface SyncStateRow {
  data_type: string;
  cursor: string | null;
  last_synced_at: string | null;
  last_error: string | null;
}

export function getSyncState(dataType: string): SyncStateRow | undefined {
  return db.prepare('SELECT * FROM sync_state WHERE data_type = ?').get(dataType) as SyncStateRow | undefined;
}

export function allSyncState(): SyncStateRow[] {
  return db.prepare('SELECT * FROM sync_state').all() as unknown as SyncStateRow[];
}

export function saveSyncState(s: SyncStateRow) {
  db.prepare(
    `INSERT INTO sync_state (data_type, cursor, last_synced_at, last_error) VALUES (?, ?, ?, ?)
     ON CONFLICT (data_type) DO UPDATE SET
       cursor = excluded.cursor, last_synced_at = excluded.last_synced_at, last_error = excluded.last_error`,
  ).run(s.data_type, s.cursor, s.last_synced_at, s.last_error);
}

// ---------- sync runs ----------

export interface SyncRunRow {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: 'running' | 'success' | 'partial' | 'failed';
  details_json: string | null;
}

export function startSyncRun(): number {
  const result = db
    .prepare("INSERT INTO sync_runs (started_at, status) VALUES (?, 'running')")
    .run(new Date().toISOString());
  return Number(result.lastInsertRowid);
}

export function finishSyncRun(id: number, status: SyncRunRow['status'], details: unknown) {
  db.prepare('UPDATE sync_runs SET finished_at = ?, status = ?, details_json = ? WHERE id = ?').run(
    new Date().toISOString(),
    status,
    JSON.stringify(details),
    id,
  );
}

export function lastSyncRun(): SyncRunRow | undefined {
  return db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').get() as SyncRunRow | undefined;
}

export function markStaleRunsFailed() {
  db.prepare("UPDATE sync_runs SET status = 'failed', finished_at = ? WHERE status = 'running'").run(
    new Date().toISOString(),
  );
}

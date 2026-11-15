import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
export function openDB(dir: string): Database.Database {
  if (dir !== ':memory:') mkdirSync(dir, { recursive: true });
  const db = new Database(dir === ':memory:' ? dir : join(dir, 'airlock.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(`
  CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY, canvas_json TEXT NOT NULL, tokens_json TEXT NOT NULL, base_hash TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS snapshot_base ON snapshots(base_hash);
  CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY, title TEXT NOT NULL, agent TEXT NOT NULL, snapshot_id TEXT NOT NULL REFERENCES snapshots(id), projection_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', approval_token_hash TEXT, approved_diff_hash TEXT, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES reviews(id), ordinal INTEGER NOT NULL, tool TEXT NOT NULL, args_json TEXT NOT NULL, contract_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', error_json TEXT, UNIQUE(review_id,ordinal));
  CREATE TABLE IF NOT EXISTS node_ops(op_id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id), review_id TEXT NOT NULL REFERENCES reviews(id), op_key TEXT NOT NULL, json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS token_ops(op_id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id), review_id TEXT NOT NULL REFERENCES reviews(id), var_name TEXT NOT NULL, json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS locks(key TEXT PRIMARY KEY, owner TEXT NOT NULL);
  `);
  return db;
}
export type DB = ReturnType<typeof openDB>;

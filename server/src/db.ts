import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, statSync } from "fs";
import { join } from "path";
import type { Session, Turn } from "./parsers/index";

// ── Path config ───────────────────────────────────────────────────────────────

const API_DASHBOARD_DIR = process.env.API_DASHBOARD_DIR
  ?? join(process.env.HOME ?? "~", ".api-dashboard");

mkdirSync(API_DASHBOARD_DIR, { recursive: true });

export const SESSIONS_DB_PATH = join(API_DASHBOARD_DIR, "sessions.db");

// ── Singleton DB connection ───────────────────────────────────────────────────

let _db: Database | null = null;

export function getDb(): Database {
  if (!_db) {
    _db = new Database(SESSIONS_DB_PATH, { create: true });
    _db.exec("PRAGMA journal_mode=WAL");
    _db.exec("PRAGMA foreign_keys=ON");
    _db.exec("PRAGMA busy_timeout=10000"); // wait up to 10s instead of failing immediately
  }
  return _db;
}

// ── Write serialization queue ─────────────────────────────────────────────────
// bun:sqlite Database is not concurrent-safe for writes. All write operations
// must be serialized through this queue to avoid "database is locked" errors.

let _writeQueue: Promise<unknown> = Promise.resolve();

export function serializeWrite<T>(fn: () => T | Promise<T>): Promise<T> {
  const next = _writeQueue.then(() => fn());
  // Swallow errors in the queue chain so one failure doesn't block subsequent writes
  _writeQueue = next.catch(() => {});
  return next;
}

// ── Schema init ───────────────────────────────────────────────────────────────

export function initDb(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      tool TEXT NOT NULL,
      project TEXT,
      cwd TEXT,
      started_at TEXT,
      ended_at TEXT,
      turn_count INTEGER DEFAULT 0,
      human_turn_count INTEGER DEFAULT 0,
      model TEXT,
      source_file TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      tool_call_count INTEGER DEFAULT 0,
      tool_call_names TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      turn_kind TEXT NOT NULL DEFAULT 'assistant',
      content TEXT,
      timestamp TEXT,
      turn_index INTEGER,
      tool_calls INTEGER DEFAULT 0,
      tool_names TEXT DEFAULT '[]',
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      source_file TEXT PRIMARY KEY,
      mtime REAL,
      size INTEGER,
      last_updated TEXT,
      synced_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_tool ON sessions(tool);
    CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source_file);
    CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
    CREATE INDEX IF NOT EXISTS idx_turns_timestamp ON turns(timestamp);
    CREATE INDEX IF NOT EXISTS idx_turns_kind ON turns(turn_kind);
  `);

  // FTS5 virtual table
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
      content,
      content='turns',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
      INSERT INTO turns_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS turns_ad AFTER DELETE ON turns BEGIN
      INSERT INTO turns_fts(turns_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    END;
  `);

  // turn_pairs view
  db.exec(`
    CREATE VIEW IF NOT EXISTS turn_pairs AS
    SELECT
      u.id,
      u.session_id,
      s.tool,
      s.project,
      date(u.timestamp) AS date,
      u.content AS user_content,
      u.timestamp AS user_ts,
      (
        SELECT a.content FROM turns a
        WHERE a.session_id = u.session_id
          AND a.role = 'assistant'
          AND a.turn_index > u.turn_index
          AND a.turn_index < COALESCE(
            (SELECT MIN(u2.turn_index) FROM turns u2
             WHERE u2.session_id = u.session_id
               AND u2.role = 'user'
               AND u2.turn_index > u.turn_index),
            999999)
        ORDER BY a.turn_index DESC LIMIT 1
      ) AS assistant_final,
      (
        SELECT a.timestamp FROM turns a
        WHERE a.session_id = u.session_id
          AND a.role = 'assistant'
          AND a.turn_index > u.turn_index
          AND a.turn_index < COALESCE(
            (SELECT MIN(u2.turn_index) FROM turns u2
             WHERE u2.session_id = u.session_id
               AND u2.role = 'user'
               AND u2.turn_index > u.turn_index),
            999999)
        ORDER BY a.turn_index DESC LIMIT 1
      ) AS assistant_ts
    FROM turns u
    JOIN sessions s ON s.id = u.session_id
    WHERE u.role = 'user' AND u.turn_kind = 'human_input';
  `);

  initDigestSchema();
}

export function initDigestSchema(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_digest (
      date TEXT PRIMARY KEY,
      summary TEXT,
      pair_count INTEGER,
      model TEXT,
      mock INTEGER DEFAULT 1,
      generated_at TEXT,
      stale INTEGER DEFAULT 0
    );
  `);
}

// ── Upsert session + turns ────────────────────────────────────────────────────

export function upsertSession(
  session: Session,
  turns: Turn[],
  filePath: string,
): Promise<void> {
  return serializeWrite(() => _upsertSessionSync(session, turns, filePath));
}

function _upsertSessionSync(
  session: Session,
  turns: Turn[],
  filePath: string,
): void {
  const db = getDb();

  const insertSession = db.prepare(`
    INSERT OR REPLACE INTO sessions
      (id, tool, project, cwd, started_at, ended_at, turn_count, human_turn_count,
       model, source_file, input_tokens, output_tokens, cache_creation_tokens,
       cache_read_tokens, tool_call_count, tool_call_names)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const deleteTurns = db.prepare("DELETE FROM turns WHERE session_id = ?");

  const insertTurn = db.prepare(`
    INSERT OR REPLACE INTO turns
      (id, session_id, role, turn_kind, content, timestamp, turn_index,
       tool_calls, tool_names, input_tokens, output_tokens,
       cache_creation_tokens, cache_read_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const upsertSync = db.prepare(`
    INSERT OR REPLACE INTO sync_state (source_file, mtime, size, synced_at)
    VALUES (?, ?, ?, ?)
  `);

  const markStale = db.prepare(`
    UPDATE daily_digest SET stale = 1
    WHERE date = date(?) AND stale = 0
  `);

  db.transaction(() => {
    insertSession.run(
      session.id,
      session.tool,
      session.project,
      session.cwd,
      session.started_at,
      session.ended_at,
      session.turn_count,
      session.human_turn_count,
      session.model,
      session.source_file,
      session.input_tokens,
      session.output_tokens,
      session.cache_creation_tokens,
      session.cache_read_tokens,
      session.tool_call_count,
      JSON.stringify(session.tool_call_names),
    );

    deleteTurns.run(session.id);

    for (const t of turns) {
      insertTurn.run(
        t.id,
        t.session_id,
        t.role,
        t.turn_kind,
        t.content,
        t.timestamp,
        t.turn_index,
        t.tool_calls,
        JSON.stringify(t.tool_names),
        t.input_tokens,
        t.output_tokens,
        t.cache_creation_tokens,
        t.cache_read_tokens,
      );
    }

    // Update sync state
    const stat = statSync(filePath);
    upsertSync.run(filePath, stat.mtimeMs, stat.size, new Date().toISOString());

    // Mark digest stale for affected dates
    if (session.started_at) {
      markStale.run(session.started_at);
    }
    if (session.ended_at && session.ended_at !== session.started_at) {
      markStale.run(session.ended_at);
    }
  })();
}

// ── File change detection ─────────────────────────────────────────────────────

export function fileChanged(filePath: string): boolean {
  const db = getDb();
  const row = db
    .query<{ mtime: number; size: number }, [string]>(
      "SELECT mtime, size FROM sync_state WHERE source_file = ?",
    )
    .get(filePath);

  if (!row) return true;

  try {
    const stat = statSync(filePath);
    return stat.mtimeMs !== row.mtime || stat.size !== row.size;
  } catch {
    return true;
  }
}

export function markDigestStale(date: string): void {
  const db = getDb();
  db.prepare("UPDATE daily_digest SET stale = 1 WHERE date = ? AND stale = 0").run(date);
}

// ── DB health check ───────────────────────────────────────────────────────────

const REQUIRED_TABLES = ["sessions", "turns", "sync_state", "daily_digest"];
const REQUIRED_INDEXES = ["idx_sessions_started", "idx_turns_session", "idx_turns_timestamp"];

export type DbHealthResult =
  | { status: "missing" }
  | { status: "ok"; sessions: number; turns: number }
  | { status: "incomplete"; missing: string[] };

export function checkDbHealth(): DbHealthResult {
  if (!existsSync(SESSIONS_DB_PATH)) return { status: "missing" };

  const db = getDb();

  const existing = new Set(
    db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type IN ('table','index')")
      .all()
      .map((r) => r.name),
  );

  const missing = [
    ...REQUIRED_TABLES.filter((t) => !existing.has(t)),
    ...REQUIRED_INDEXES.filter((i) => !existing.has(i)),
  ];

  if (missing.length > 0) return { status: "incomplete", missing };

  const { sessions } = db.query<{ sessions: number }, []>("SELECT COUNT(*) as sessions FROM sessions").get()!;
  const { turns } = db.query<{ turns: number }, []>("SELECT COUNT(*) as turns FROM turns").get()!;

  return { status: "ok", sessions, turns };
}

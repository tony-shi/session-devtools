import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

// ── Path config ───────────────────────────────────────────────────────────────

const API_DASHBOARD_DIR = process.env.API_DASHBOARD_DIR
  ?? join(process.env.HOME ?? "~", ".api-dashboard");

mkdirSync(API_DASHBOARD_DIR, { recursive: true });

export const SESSIONS_DB_PATH = join(API_DASHBOARD_DIR, "sessions.db");

// ── Singleton DB connection ───────────────────────────────────────────────────

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(SESSIONS_DB_PATH);
    _db.exec("PRAGMA journal_mode=WAL");
    _db.exec("PRAGMA foreign_keys=ON");
    _db.exec("PRAGMA busy_timeout=10000"); // wait up to 10s instead of failing immediately
  }
  return _db;
}

// ── Write serialization queue ─────────────────────────────────────────────────
// better-sqlite3 is synchronous; this queue exists for API compatibility with
// callers that await serializeWrite(). All writes still happen synchronously
// under the hood, but the queue ensures ordering if callers ever mix async work.

let _writeQueue: Promise<unknown> = Promise.resolve();

export function serializeWrite<T>(fn: () => T | Promise<T>): Promise<T> {
  const next = _writeQueue.then(() => fn());
  // Swallow errors in the queue chain so one failure doesn't block subsequent writes
  _writeQueue = next.catch(() => {});
  return next;
}

// ── Schema init ───────────────────────────────────────────────────────────────

export function initDb(): void {
  initProxySchema();
}

export function initProxySchema(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS proxy_requests (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      ts              TEXT NOT NULL,
      started_at      TEXT,
      sni             TEXT NOT NULL,
      method          TEXT NOT NULL DEFAULT 'GET',
      url             TEXT NOT NULL,
      status          INTEGER,
      bytes_in        INTEGER DEFAULT 0,
      bytes_out       INTEGER DEFAULT 0,
      duration_ms     INTEGER,
      req_headers     TEXT DEFAULT '{}',
      res_headers     TEXT DEFAULT '{}',
      sse_event_count INTEGER DEFAULT 0,
      is_stream       INTEGER DEFAULT 0,
      jsonl_file        TEXT NOT NULL DEFAULT '',
      jsonl_byte_offset INTEGER NOT NULL DEFAULT 0,
      request_id      TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_proxy_started ON proxy_requests(started_at);
    CREATE INDEX IF NOT EXISTS idx_proxy_sni     ON proxy_requests(sni);
    CREATE INDEX IF NOT EXISTS idx_proxy_status  ON proxy_requests(status);

    CREATE TABLE IF NOT EXISTS indexed_cold_files (
      file_path     TEXT PRIMARY KEY,
      ts_start      TEXT,
      ts_end        TEXT,
      record_count  INTEGER NOT NULL,
      byte_size     INTEGER NOT NULL,
      indexed_at    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cold_ts ON indexed_cold_files(ts_start, ts_end);

    -- side_call_facts: derived index of background ("side") LLM calls per session.
    -- Populated by the cold-indexer enricher (server/src/side-call/enricher.ts) on
    -- ingest, and lazily backfilled for historical sessions. Lets per-session
    -- side-call scanning read a table instead of decompressing dozens of gz files.
    CREATE TABLE IF NOT EXISTS side_call_facts (
      session_id  TEXT NOT NULL,
      request_id  TEXT NOT NULL,
      query_kind  TEXT NOT NULL,           -- generate_session_title | quota | prompt_suggestion | agent_summary | auto_dream | extract_memories
      link_fact   TEXT,                    -- kind-specific link value; for generate_session_title = the response title text; null otherwise
      classifier_version INTEGER NOT NULL,
      PRIMARY KEY (session_id, request_id)
    );
    CREATE INDEX IF NOT EXISTS idx_side_call_facts_session ON side_call_facts(session_id);

    CREATE TABLE IF NOT EXISTS side_call_scanned_sessions (
      session_id  TEXT PRIMARY KEY,
      classifier_version INTEGER NOT NULL,
      scanned_at  TEXT NOT NULL
    );
  `);

  // 迁移：为存量 DB 补新字段（幂等）
  const columns = db.prepare("PRAGMA table_info(proxy_requests)").all() as { name: string }[];
  if (!columns.some((c) => c.name === "started_at")) {
    db.exec("ALTER TABLE proxy_requests ADD COLUMN started_at TEXT");
    db.exec("UPDATE proxy_requests SET started_at = ts WHERE started_at IS NULL");
  }
  if (!columns.some((c) => c.name === "jsonl_file")) {
    db.exec("ALTER TABLE proxy_requests ADD COLUMN jsonl_file TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.some((c) => c.name === "jsonl_byte_offset")) {
    db.exec("ALTER TABLE proxy_requests ADD COLUMN jsonl_byte_offset INTEGER NOT NULL DEFAULT 0");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_proxy_file ON proxy_requests(jsonl_file)");

  // §5 meta columns (idempotent)
  const colSet = new Set(columns.map((c) => c.name));
  if (!colSet.has("session_id"))                db.exec("ALTER TABLE proxy_requests ADD COLUMN session_id                TEXT");
  if (!colSet.has("cli_tool"))                  db.exec("ALTER TABLE proxy_requests ADD COLUMN cli_tool                  TEXT");
  if (!colSet.has("model"))                     db.exec("ALTER TABLE proxy_requests ADD COLUMN model                     TEXT");
  if (!colSet.has("req_message_count"))         db.exec("ALTER TABLE proxy_requests ADD COLUMN req_message_count         INTEGER");
  if (!colSet.has("req_has_tools"))             db.exec("ALTER TABLE proxy_requests ADD COLUMN req_has_tools             INTEGER");
  if (!colSet.has("res_input_tokens"))          db.exec("ALTER TABLE proxy_requests ADD COLUMN res_input_tokens          INTEGER");
  if (!colSet.has("res_output_tokens"))         db.exec("ALTER TABLE proxy_requests ADD COLUMN res_output_tokens         INTEGER");
  if (!colSet.has("res_cache_creation_tokens")) db.exec("ALTER TABLE proxy_requests ADD COLUMN res_cache_creation_tokens INTEGER");
  if (!colSet.has("res_cache_read_tokens"))     db.exec("ALTER TABLE proxy_requests ADD COLUMN res_cache_read_tokens     INTEGER");
  if (!colSet.has("res_stop_reason"))           db.exec("ALTER TABLE proxy_requests ADD COLUMN res_stop_reason           TEXT");
  if (!colSet.has("error_class"))               db.exec("ALTER TABLE proxy_requests ADD COLUMN error_class               TEXT");

  if (!colSet.has("request_id"))                db.exec("ALTER TABLE proxy_requests ADD COLUMN request_id               TEXT");

  db.exec("CREATE INDEX IF NOT EXISTS idx_proxy_session    ON proxy_requests(session_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_proxy_cli        ON proxy_requests(cli_tool)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_proxy_model      ON proxy_requests(model)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_proxy_request_id ON proxy_requests(session_id, request_id)");
  // 旧的 body 列（仅存量 DB 可能有，不在新表里 — 留给迁移脚本处理，这里不删）
}

export function initV2Schema(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions_meta_v2 (
      session_id          TEXT PRIMARY KEY,
      tool                TEXT NOT NULL,
      source_file         TEXT NOT NULL,

      file_mtime          REAL NOT NULL,
      file_size           INTEGER NOT NULL,
      parser_version      INTEGER NOT NULL,
      schema_fingerprint  TEXT,
      source_present      INTEGER NOT NULL DEFAULT 1,

      first_event_at      TEXT,
      last_event_at       TEXT,

      cwd                 TEXT,
      project             TEXT,
      title               TEXT,
      first_user_message  TEXT,

      event_count         INTEGER NOT NULL DEFAULT 0,

      input_tokens               INTEGER NOT NULL DEFAULT 0,
      output_tokens              INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens      INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens          INTEGER NOT NULL DEFAULT 0,
      models                     TEXT NOT NULL DEFAULT '[]',

      tool_call_count            INTEGER NOT NULL DEFAULT 0,
      llm_call_count             INTEGER NOT NULL DEFAULT 0,
      human_input_count          INTEGER NOT NULL DEFAULT 0,
      sub_agent_count            INTEGER NOT NULL DEFAULT 0,

      claude_code_api_error_count INTEGER NOT NULL DEFAULT 0,  -- Claude Code "system/api_error" events; NOT HTTP errors (those live in proxy_requests.error_class)
      parser_warnings            TEXT NOT NULL DEFAULT '[]'
    );

    CREATE INDEX IF NOT EXISTS idx_sm2_last_event   ON sessions_meta_v2(last_event_at);
    CREATE INDEX IF NOT EXISTS idx_sm2_first_event  ON sessions_meta_v2(first_event_at);
    CREATE INDEX IF NOT EXISTS idx_sm2_tool         ON sessions_meta_v2(tool);
    CREATE INDEX IF NOT EXISTS idx_sm2_source       ON sessions_meta_v2(source_file);
    CREATE INDEX IF NOT EXISTS idx_sm2_present      ON sessions_meta_v2(source_present);
  `);
  // Migrate: rename api_error_count → claude_code_api_error_count (idempotent)
  const v2cols = db.prepare("PRAGMA table_info(sessions_meta_v2)").all() as { name: string }[];
  const v2colSet = new Set(v2cols.map((c) => c.name));
  if (v2colSet.has("api_error_count")) {
    db.exec("ALTER TABLE sessions_meta_v2 RENAME COLUMN api_error_count TO claude_code_api_error_count");
  }
  // Migrate: split title → custom_title + ai_title (idempotent)
  if (!v2colSet.has("custom_title")) {
    db.exec("ALTER TABLE sessions_meta_v2 ADD COLUMN custom_title TEXT");
    db.exec("ALTER TABLE sessions_meta_v2 ADD COLUMN ai_title TEXT");
    // Backfill: existing title is ambiguous (custom or AI) — copy into ai_title as best-effort.
    // Re-parse will overwrite with correct separation when files change (PARSER_VERSION bump).
    db.exec("UPDATE sessions_meta_v2 SET ai_title = title WHERE title IS NOT NULL AND ai_title IS NULL");
  }
  // Migrate: add summary candidate columns (idempotent)
  if (!v2colSet.has("away_summary")) {
    db.exec("ALTER TABLE sessions_meta_v2 ADD COLUMN away_summary TEXT");
  }
  if (!v2colSet.has("last_assistant_text")) {
    db.exec("ALTER TABLE sessions_meta_v2 ADD COLUMN last_assistant_text TEXT");
  }
  if (!v2colSet.has("sub_agent_count")) {
    db.exec("ALTER TABLE sessions_meta_v2 ADD COLUMN sub_agent_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!v2colSet.has("llm_call_count")) {
    db.exec("ALTER TABLE sessions_meta_v2 ADD COLUMN llm_call_count INTEGER NOT NULL DEFAULT 0");
  }
  // Migrate: agent teams 成员标识（team 域分组键；NULL = 非 team 会话）
  if (!v2colSet.has("team_name")) {
    db.exec("ALTER TABLE sessions_meta_v2 ADD COLUMN team_name TEXT");
    db.exec("ALTER TABLE sessions_meta_v2 ADD COLUMN team_agent_name TEXT");
  }
}

// ── DB health check ───────────────────────────────────────────────────────────

// NOTE: side_call_facts / side_call_scanned_sessions are intentionally NOT
// listed here. They are created idempotently by initProxySchema() at every
// startup, so an existing pre-migration DB must NOT be flagged "incomplete"
// (which would gate boot). The health check only guards the original tables.
const REQUIRED_TABLES = ["proxy_requests", "indexed_cold_files"];

export type DbHealthResult =
  | { status: "missing" }
  | { status: "ok"; sessions: number }
  | { status: "incomplete"; missing: string[] };

export function checkDbHealth(): DbHealthResult {
  if (!existsSync(SESSIONS_DB_PATH)) return { status: "missing" };

  const db = getDb();

  const existing = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all() as { name: string }[])
      .map((r) => r.name),
  );

  const missing = REQUIRED_TABLES.filter((t) => !existing.has(t));
  if (missing.length > 0) return { status: "incomplete", missing };

  // sessions_meta_v2 may not exist yet on a fresh DB; tolerate that.
  let sessions = 0;
  if (existing.has("sessions_meta_v2")) {
    sessions = (db.prepare("SELECT COUNT(*) as n FROM sessions_meta_v2").get() as { n: number }).n;
  }

  return { status: "ok", sessions };
}

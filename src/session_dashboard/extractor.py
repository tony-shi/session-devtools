"""
Session Extractor
Parses conversation sessions from Claude Code, Codex, and Gemini CLI,
stores them in a unified SQLite database at ~/.api-dashboard/sessions.db.
"""
import configparser
import hashlib
import json
import logging
import os
import sqlite3
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger("session-extractor")

API_DASHBOARD_DIR = Path(
    os.environ.get("API_DASHBOARD_DIR", str(Path.home() / ".api-dashboard"))
).expanduser()
SESSIONS_DB_PATH = API_DASHBOARD_DIR / "sessions.db"

_db_lock = threading.RLock()

_CLAUDE_GLOB = Path.home() / ".claude" / "projects"
_CODEX_GLOB = Path.home() / ".codex" / "sessions"
_GEMINI_GLOB = Path.home() / ".gemini" / "tmp"

SESSION_SYNC_INTERVAL = int(os.environ.get("SESSION_SYNC_INTERVAL", "300"))  # seconds, default 5 min
_sync_timer: threading.Timer | None = None
_sync_timer_lock = threading.Lock()


def _schedule_next_sync() -> None:
    global _sync_timer
    with _sync_timer_lock:
        _sync_timer = threading.Timer(SESSION_SYNC_INTERVAL, _background_sync)
        _sync_timer.daemon = True
        _sync_timer.start()


def _background_sync() -> None:
    try:
        result = run_sync()
        if result["synced"] > 0:
            logger.info("Auto-sync: synced=%d skipped=%d errors=%d (%.0fms)",
                        result["synced"], result["skipped"], result["errors"], result["duration_ms"])
    except Exception as e:
        logger.warning("Auto-sync failed: %s", e)
    finally:
        _schedule_next_sync()


def start_auto_sync() -> None:
    """Start background periodic sync. Call once after init_sessions_db()."""
    logger.info("Session auto-sync enabled, interval=%ds", SESSION_SYNC_INTERVAL)
    _schedule_next_sync()


def stop_auto_sync() -> None:
    global _sync_timer
    with _sync_timer_lock:
        if _sync_timer is not None:
            _sync_timer.cancel()
            _sync_timer = None


# ── Database ────────────────────────────────────────────────────────────────

def init_sessions_db() -> None:
    API_DASHBOARD_DIR.mkdir(parents=True, exist_ok=True)
    with _get_db_conn() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS sessions (
                id          TEXT PRIMARY KEY,
                tool        TEXT NOT NULL,
                project     TEXT,
                cwd         TEXT,
                started_at  TEXT,
                ended_at    TEXT,
                turn_count  INTEGER DEFAULT 0,
                model       TEXT,
                source_file TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS turns (
                id          TEXT PRIMARY KEY,
                session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                role        TEXT NOT NULL,
                content     TEXT,
                timestamp   TEXT,
                turn_index  INTEGER,
                tool_calls  INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS sync_state (
                source_file  TEXT PRIMARY KEY,
                mtime        REAL,
                size         INTEGER,
                last_updated TEXT,
                synced_at    TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_sessions_tool       ON sessions(tool);
            CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at);
            CREATE INDEX IF NOT EXISTS idx_turns_session_id    ON turns(session_id);
            CREATE INDEX IF NOT EXISTS idx_turns_timestamp     ON turns(timestamp);
        """)

        # FTS virtual table and triggers (can't be in executescript with IF NOT EXISTS easily)
        tables = {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )}
        if "turns_fts" not in tables:
            conn.execute("""
                CREATE VIRTUAL TABLE turns_fts USING fts5(
                    content,
                    content='turns',
                    content_rowid='rowid'
                )
            """)
            conn.execute("""
                CREATE TRIGGER turns_ai AFTER INSERT ON turns BEGIN
                    INSERT INTO turns_fts(rowid, content) VALUES (new.rowid, new.content);
                END
            """)
            conn.execute("""
                CREATE TRIGGER turns_ad AFTER DELETE ON turns BEGIN
                    INSERT INTO turns_fts(turns_fts, rowid, content)
                    VALUES ('delete', old.rowid, old.content);
                END
            """)

        _init_digest_schema(conn)


def _get_db_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(SESSIONS_DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


# ── Content helpers ─────────────────────────────────────────────────────────

def _extract_text(content) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = []
        for block in content:
            if not isinstance(block, dict):
                continue
            block_type = block.get("type", "")
            if block_type == "thinking":
                continue
            text = block.get("text") or block.get("input_text") or block.get("output_text")
            if text and isinstance(text, str):
                parts.append(text.strip())
        return "\n".join(parts)
    return ""


def _project_from_cwd(cwd: str | None) -> str:
    if not cwd:
        return ""
    return Path(cwd).name


def _make_turn_id(session_id: str, index: int, role: str) -> str:
    raw = f"{session_id}:{index}:{role}"
    return hashlib.sha1(raw.encode()).hexdigest()


# ── Claude parser ────────────────────────────────────────────────────────────

def _parse_claude_session(file_path: Path):
    session_id = None
    cwd = None
    turns = []
    index = 0

    with open(file_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue

            rec_type = rec.get("type")
            if rec_type not in ("user", "assistant"):
                continue

            if session_id is None:
                session_id = rec.get("sessionId")
            if cwd is None and rec_type == "user":
                cwd = rec.get("cwd")

            msg = rec.get("message", {})
            role = msg.get("role") or rec_type
            if role == "assistant":
                role = "assistant"
            elif role == "user":
                role = "user"
            else:
                continue

            content = _extract_text(msg.get("content", ""))
            if not content:
                continue

            timestamp = rec.get("timestamp", "")
            turn_id = rec.get("uuid") or _make_turn_id(session_id or str(file_path), index, role)

            turns.append({
                "id": turn_id,
                "session_id": None,  # filled after session_id is finalized
                "role": role,
                "content": content,
                "timestamp": timestamp,
                "turn_index": index,
                "tool_calls": 0,
            })
            index += 1

    if not session_id:
        session_id = file_path.stem

    for t in turns:
        t["session_id"] = session_id

    timestamps = [t["timestamp"] for t in turns if t["timestamp"]]
    started_at = min(timestamps) if timestamps else ""
    ended_at = max(timestamps) if timestamps else ""

    session = {
        "id": session_id,
        "tool": "claude",
        "project": _project_from_cwd(cwd),
        "cwd": cwd or "",
        "started_at": started_at,
        "ended_at": ended_at,
        "turn_count": len(turns),
        "model": "",
        "source_file": str(file_path),
    }
    return session, turns


# ── Codex parser ─────────────────────────────────────────────────────────────

def _parse_codex_session(file_path: Path):
    session_id = None
    cwd = None
    model = None
    turns = []
    turn_index = 0

    # We collect (user_text, assistant_text, timestamp, tool_call_count) per turn
    current_user_text = None
    current_user_ts = None
    current_assistant_text = None
    current_assistant_ts = None
    current_tool_calls = 0

    def _flush_turn():
        nonlocal turn_index, current_user_text, current_user_ts
        nonlocal current_assistant_text, current_assistant_ts, current_tool_calls

        if current_user_text:
            turns.append({
                "id": _make_turn_id(session_id or str(file_path), turn_index, "user"),
                "session_id": None,
                "role": "user",
                "content": current_user_text,
                "timestamp": current_user_ts or "",
                "turn_index": turn_index,
                "tool_calls": 0,
            })
            turn_index += 1

        if current_assistant_text:
            turns.append({
                "id": _make_turn_id(session_id or str(file_path), turn_index, "assistant"),
                "session_id": None,
                "role": "assistant",
                "content": current_assistant_text,
                "timestamp": current_assistant_ts or "",
                "turn_index": turn_index,
                "tool_calls": current_tool_calls,
            })
            turn_index += 1

        current_user_text = None
        current_user_ts = None
        current_assistant_text = None
        current_assistant_ts = None
        current_tool_calls = 0

    with open(file_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue

            rec_type = rec.get("type")
            payload = rec.get("payload", {})
            ts = rec.get("timestamp", "")

            if rec_type == "session_meta":
                session_id = payload.get("id")
                cwd = payload.get("cwd")
                model = payload.get("model_provider", "")

            elif rec_type == "turn_context":
                _flush_turn()
                if not model:
                    model = payload.get("model", "")

            elif rec_type == "event_msg":
                if payload.get("type") == "user_message":
                    current_user_text = payload.get("content", "").strip()
                    current_user_ts = ts

            elif rec_type == "response_item":
                p_type = payload.get("type")
                if p_type == "message":
                    role = payload.get("role")
                    if role == "assistant":
                        content_list = payload.get("content", [])
                        text = _extract_text(content_list)
                        if text:
                            current_assistant_text = text
                            current_assistant_ts = ts
                    # skip role=user (contains system noise)
                elif p_type == "function_call":
                    current_tool_calls += 1

    _flush_turn()

    if not session_id:
        session_id = file_path.stem

    for t in turns:
        t["session_id"] = session_id

    timestamps = [t["timestamp"] for t in turns if t["timestamp"]]
    started_at = min(timestamps) if timestamps else ""
    ended_at = max(timestamps) if timestamps else ""

    session = {
        "id": session_id,
        "tool": "codex",
        "project": _project_from_cwd(cwd),
        "cwd": cwd or "",
        "started_at": started_at,
        "ended_at": ended_at,
        "turn_count": len(turns),
        "model": model or "",
        "source_file": str(file_path),
    }
    return session, turns


# ── Gemini parser ────────────────────────────────────────────────────────────

def _parse_gemini_session(file_path: Path):
    with open(file_path, encoding="utf-8") as f:
        data = json.load(f)

    session_id = data.get("sessionId", file_path.stem)
    started_at = data.get("startTime", "")
    ended_at = data.get("lastUpdated", "")
    messages = data.get("messages", [])

    turns = []
    model = ""

    for idx, msg in enumerate(messages):
        msg_type = msg.get("type", "")
        if msg_type == "user":
            role = "user"
            content = _extract_text(msg.get("content", []))
            tool_calls = 0
        elif msg_type == "gemini":
            role = "assistant"
            content = _extract_text(msg.get("content", ""))
            tool_calls = len(msg.get("toolCalls", []))
            if not model and msg.get("model"):
                model = msg["model"]
        else:
            continue

        if not content:
            continue

        turns.append({
            "id": msg.get("id") or _make_turn_id(session_id, idx, role),
            "session_id": session_id,
            "role": role,
            "content": content,
            "timestamp": msg.get("timestamp", ""),
            "turn_index": len(turns),
            "tool_calls": tool_calls,
        })

    # Derive project from projectHash directory name (parent of chats/)
    project_dir = file_path.parent.parent.name
    cwd = ""
    project_root_file = Path.home() / ".gemini" / "history" / project_dir / ".project_root"
    if project_root_file.exists():
        try:
            cwd = project_root_file.read_text().strip()
        except OSError:
            pass

    session = {
        "id": session_id,
        "tool": "gemini",
        "project": _project_from_cwd(cwd) or project_dir,
        "cwd": cwd,
        "started_at": started_at,
        "ended_at": ended_at,
        "turn_count": len(turns),
        "model": model,
        "source_file": str(file_path),
    }
    return session, turns


# ── Sync engine ──────────────────────────────────────────────────────────────

def _discover_files() -> list:
    results = []

    if _CLAUDE_GLOB.exists():
        for p in _CLAUDE_GLOB.rglob("*.jsonl"):
            results.append(("claude", p))

    if _CODEX_GLOB.exists():
        for p in _CODEX_GLOB.rglob("*.jsonl"):
            results.append(("codex", p))

    if _GEMINI_GLOB.exists():
        for p in _GEMINI_GLOB.rglob("session-*.json"):
            results.append(("gemini", p))

    return results


def _file_changed(conn: sqlite3.Connection, file_path: Path, tool: str) -> bool:
    try:
        current_mtime = file_path.stat().st_mtime
        current_size = file_path.stat().st_size
    except OSError:
        return False

    row = conn.execute(
        "SELECT mtime, size, last_updated FROM sync_state WHERE source_file = ?",
        (str(file_path),)
    ).fetchone()

    if row is None:
        return True

    if tool == "gemini":
        try:
            with open(file_path, encoding="utf-8") as f:
                data = json.load(f)
            return data.get("lastUpdated") != row["last_updated"]
        except (OSError, json.JSONDecodeError):
            return current_mtime != row["mtime"]

    return current_mtime != row["mtime"] or current_size != row["size"]


def _upsert_session(conn: sqlite3.Connection, session: dict, turns: list, file_path: Path, tool: str) -> None:
    now = datetime.now(timezone.utc).isoformat()

    try:
        mtime = file_path.stat().st_mtime
        size = file_path.stat().st_size
    except OSError:
        mtime, size = 0.0, 0

    last_updated = None
    if tool == "gemini":
        try:
            with open(file_path, encoding="utf-8") as f:
                last_updated = json.load(f).get("lastUpdated")
        except (OSError, json.JSONDecodeError):
            pass

    with conn:
        conn.execute("DELETE FROM turns WHERE session_id = ?", (session["id"],))
        conn.execute("""
            INSERT OR REPLACE INTO sessions
              (id, tool, project, cwd, started_at, ended_at, turn_count, model, source_file)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            session["id"], session["tool"], session["project"], session["cwd"],
            session["started_at"], session["ended_at"], session["turn_count"],
            session["model"], session["source_file"],
        ))
        conn.executemany("""
            INSERT INTO turns (id, session_id, role, content, timestamp, turn_index, tool_calls)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, [
            (t["id"], t["session_id"], t["role"], t["content"],
             t["timestamp"], t["turn_index"], t["tool_calls"])
            for t in turns
        ])
        conn.execute("""
            INSERT OR REPLACE INTO sync_state (source_file, mtime, size, last_updated, synced_at)
            VALUES (?, ?, ?, ?, ?)
        """, (str(file_path), mtime, size, last_updated, now))

        # Mark affected dates' digests as stale
        affected_dates = {
            t["timestamp"][:10] for t in turns if t.get("timestamp") and len(t["timestamp"]) >= 10
        }
        for d in affected_dates:
            _mark_digest_stale(conn, d)


_PARSERS = {
    "claude": _parse_claude_session,
    "codex": _parse_codex_session,
    "gemini": _parse_gemini_session,
}


def _sync_file(conn: sqlite3.Connection, tool: str, file_path: Path) -> dict:
    try:
        session, turns = _PARSERS[tool](file_path)
        _upsert_session(conn, session, turns, file_path, tool)
        return {"file": str(file_path), "tool": tool, "status": "ok", "turns": len(turns)}
    except Exception as e:
        logger.warning("Failed to sync %s: %s", file_path, e)
        return {"file": str(file_path), "tool": tool, "status": "error", "error": str(e)}


def run_sync() -> dict:
    start = time.monotonic()
    files = _discover_files()
    synced = skipped = errors = 0

    with _db_lock:
        conn = _get_db_conn()
        try:
            for tool, path in files:
                if not _file_changed(conn, path, tool):
                    skipped += 1
                    continue
                result = _sync_file(conn, tool, path)
                if result["status"] == "ok":
                    synced += 1
                else:
                    errors += 1
        finally:
            conn.close()

    return {
        "synced": synced,
        "skipped": skipped,
        "errors": errors,
        "total_files": len(files),
        "duration_ms": round((time.monotonic() - start) * 1000, 1),
    }


# ── Flask routes ─────────────────────────────────────────────────────────────

def register_session_routes(app) -> None:
    from flask import jsonify, request

    @app.route("/api/sessions/sync")
    def sessions_sync():
        result = run_sync()
        return jsonify(result)

    @app.route("/api/sessions/summary")
    def sessions_summary():
        date = request.args.get("date") or datetime.now(timezone.utc).strftime("%Y-%m-%d")
        date_start = f"{date}T00:00:00"
        date_end = f"{date}T23:59:59"

        with _db_lock:
            conn = _get_db_conn()
            try:
                rows = conn.execute("""
                    SELECT tool, COUNT(*) as session_count, SUM(turn_count) as turn_count,
                           GROUP_CONCAT(DISTINCT project) as projects
                    FROM sessions
                    WHERE started_at BETWEEN ? AND ?
                    GROUP BY tool
                """, (date_start, date_end)).fetchall()

                total_sessions = sum(r["session_count"] for r in rows)
                total_turns = sum(r["turn_count"] or 0 for r in rows)

                by_tool = {}
                for r in rows:
                    projects = [p for p in (r["projects"] or "").split(",") if p]
                    by_tool[r["tool"]] = {
                        "sessions": r["session_count"],
                        "turns": r["turn_count"] or 0,
                        "projects": projects,
                    }
            finally:
                conn.close()

        return jsonify({
            "date": date,
            "total_sessions": total_sessions,
            "total_turns": total_turns,
            "by_tool": by_tool,
        })

    @app.route("/api/sessions")
    def sessions_list():
        tool = request.args.get("tool")
        date = request.args.get("date")
        project = request.args.get("project")
        limit = min(int(request.args.get("limit", 50)), 200)
        offset = int(request.args.get("offset", 0))

        conditions = []
        params = []

        if tool:
            conditions.append("tool = ?")
            params.append(tool)
        if date:
            conditions.append("started_at BETWEEN ? AND ?")
            params += [f"{date}T00:00:00", f"{date}T23:59:59"]
        if project:
            conditions.append("project = ?")
            params.append(project)

        where = ("WHERE " + " AND ".join(conditions)) if conditions else ""

        with _db_lock:
            conn = _get_db_conn()
            try:
                total = conn.execute(
                    f"SELECT COUNT(*) FROM sessions {where}", params
                ).fetchone()[0]
                rows = conn.execute(
                    f"SELECT * FROM sessions {where} ORDER BY started_at DESC LIMIT ? OFFSET ?",
                    params + [limit, offset]
                ).fetchall()
            finally:
                conn.close()

        return jsonify({
            "sessions": [dict(r) for r in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
        })

    @app.route("/api/sessions/digest")
    def sessions_digest():
        date = request.args.get("date") or datetime.now(timezone.utc).strftime("%Y-%m-%d")
        force = request.args.get("force", "false").lower() == "true"
        result = generate_digest(date, force=force)
        return jsonify(result)

    @app.route("/api/sessions/digest/list")
    def sessions_digest_list():
        with _db_lock:
            conn = _get_db_conn()
            try:
                _init_digest_schema(conn)
                rows = conn.execute(
                    "SELECT date, pair_count, model, mock, generated_at, stale FROM daily_digest ORDER BY date DESC"
                ).fetchall()
            finally:
                conn.close()
        return jsonify({"digests": [dict(r) for r in rows]})

    @app.route("/api/sessions/<session_id>/turns")
    def sessions_turns(session_id):
        with _db_lock:
            conn = _get_db_conn()
            try:
                session = conn.execute(
                    "SELECT * FROM sessions WHERE id = ?", (session_id,)
                ).fetchone()
                if not session:
                    return jsonify({"error": "session not found"}), 404
                turns = conn.execute(
                    "SELECT * FROM turns WHERE session_id = ? ORDER BY turn_index",
                    (session_id,)
                ).fetchall()
            finally:
                conn.close()

        return jsonify({
            "session": dict(session),
            "turns": [dict(t) for t in turns],
        })


# ── Daily digest ─────────────────────────────────────────────────────────────

_DIGEST_CFG_PATH = Path(
    os.environ.get("DIGEST_CFG", str(Path(__file__).parent.parent.parent.parent / "digest.cfg"))
)

# SQL view: pairs each user turn with the last assistant turn before the next user turn
_TURN_PAIRS_VIEW_SQL = """
CREATE VIEW IF NOT EXISTS turn_pairs AS
SELECT
    u.id            AS id,
    u.session_id    AS session_id,
    s.tool          AS tool,
    s.project       AS project,
    date(u.timestamp) AS date,
    u.content       AS user_content,
    u.timestamp     AS user_ts,
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
WHERE u.role = 'user';
"""


def _init_digest_schema(conn: sqlite3.Connection) -> None:
    conn.execute(_TURN_PAIRS_VIEW_SQL)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS daily_digest (
            date         TEXT PRIMARY KEY,
            summary      TEXT,
            pair_count   INTEGER,
            model        TEXT,
            mock         INTEGER DEFAULT 1,
            generated_at TEXT,
            stale        INTEGER DEFAULT 0
        )
    """)
    conn.commit()


def _load_digest_cfg() -> dict:
    cfg = configparser.ConfigParser()
    if _DIGEST_CFG_PATH.exists():
        cfg.read(str(_DIGEST_CFG_PATH))
    section = cfg["llm"] if cfg.has_section("llm") else {}
    return {
        "api_url":   section.get("api_url",   "https://api.anthropic.com/v1/messages"),
        "api_key":   section.get("api_key",   ""),
        "model":     section.get("model",     "claude-haiku-4-5-20251001"),
        "max_tokens": int(section.get("max_tokens", "512")),
        "enabled":   section.get("enabled",   "false").strip().lower() == "true",
    }


def _fetch_turn_pairs_for_date(conn: sqlite3.Connection, date: str) -> list[dict]:
    rows = conn.execute(
        """
        SELECT tool, project, user_content, assistant_final, user_ts
        FROM turn_pairs
        WHERE date = ?
        ORDER BY tool, project, user_ts
        """,
        (date,)
    ).fetchall()
    return [dict(r) for r in rows]


def _build_digest_prompt(date: str, pairs: list[dict]) -> str:
    # Group by tool + project
    groups: dict[str, list[dict]] = {}
    for p in pairs:
        key = f"{p['tool']} / {p['project'] or '(unknown)'}"
        groups.setdefault(key, []).append(p)

    sections = []
    for group_key, group_pairs in groups.items():
        lines = [f"[{group_key}]"]
        for p in group_pairs:
            user = (p["user_content"] or "").strip().replace("\n", " ")[:300]
            assistant = (p["assistant_final"] or "").strip().replace("\n", " ")[:300]
            lines.append(f"  Q: {user}")
            if assistant:
                lines.append(f"  A: {assistant}")
        sections.append("\n".join(lines))

    body = "\n\n".join(sections)
    return (
        f"以下是 {date} 我与 AI 编程工具的对话摘要，按工具和项目分组，"
        f"每条包含我的问题和 AI 的最终回答。\n\n"
        f"请用中文概括今天的工作进展：\n"
        f"- 每个项目一段，说明做了什么、解决了什么问题\n"
        f"- 不超过 300 字，风格简洁直接\n\n"
        f"---\n{body}"
    )


def _call_llm(prompt: str, cfg: dict) -> tuple[str, bool]:
    """Call LLM API. Returns (summary_text, is_mock)."""
    if not cfg["enabled"] or not cfg["api_key"] or cfg["api_key"] == "YOUR_API_KEY_HERE":
        # Mock: return structured placeholder
        mock_text = (
            f"[MOCK] LLM 未启用。请在 digest.cfg 中设置 api_key 并将 enabled 改为 true。\n\n"
            f"Prompt 长度: {len(prompt)} 字符"
        )
        return mock_text, True

    try:
        import urllib.request
        payload = json.dumps({
            "model": cfg["model"],
            "max_tokens": cfg["max_tokens"],
            "messages": [{"role": "user", "content": prompt}],
        }).encode()
        req = urllib.request.Request(
            cfg["api_url"],
            data=payload,
            headers={
                "Content-Type": "application/json",
                "x-api-key": cfg["api_key"],
                "anthropic-version": "2023-06-01",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
        text = data["content"][0]["text"]
        return text, False
    except Exception as e:
        logger.warning("LLM call failed: %s", e)
        return f"[ERROR] LLM 调用失败: {e}", True


def generate_digest(date: str, force: bool = False) -> dict:
    """Generate (or return cached) daily digest for the given date."""
    cfg = _load_digest_cfg()

    with _db_lock:
        conn = _get_db_conn()
        try:
            _init_digest_schema(conn)

            # Return cached unless forced or stale
            if not force:
                row = conn.execute(
                    "SELECT * FROM daily_digest WHERE date = ? AND stale = 0", (date,)
                ).fetchone()
                if row:
                    return dict(row)

            pairs = _fetch_turn_pairs_for_date(conn, date)
            if not pairs:
                return {"date": date, "summary": None, "pair_count": 0, "error": "no data for this date"}

            prompt = _build_digest_prompt(date, pairs)
            summary, is_mock = _call_llm(prompt, cfg)
            now = datetime.now(timezone.utc).isoformat()

            conn.execute("""
                INSERT OR REPLACE INTO daily_digest
                  (date, summary, pair_count, model, mock, generated_at, stale)
                VALUES (?, ?, ?, ?, ?, ?, 0)
            """, (date, summary, len(pairs), cfg["model"], int(is_mock), now))
            conn.commit()

            return {
                "date": date,
                "summary": summary,
                "pair_count": len(pairs),
                "model": cfg["model"],
                "mock": is_mock,
                "generated_at": now,
            }
        finally:
            conn.close()


def _mark_digest_stale(conn: sqlite3.Connection, date: str) -> None:
    """Mark a date's digest as stale (called when new turns are synced for that date)."""
    conn.execute(
        "UPDATE daily_digest SET stale = 1 WHERE date = ?", (date,)
    )

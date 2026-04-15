import { getDb } from "./db";
import { backfillDigests, findDatesMissingDigest, generateDigest } from "./digest";
import { runSync, runSyncForDate } from "./sync";

// Track dates currently being generated to avoid duplicate LLM calls
const _generatingDates = new Set<string>();

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function parseJsonField<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export async function handleRequest(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  const q = url.searchParams;

  // ── Manual sync ─────────────────────────────────────────────────────────────
  if (path === "/api/sessions/sync" && req.method === "GET") {
    const date = q.get("date");
    const result = date ? await runSyncForDate(date) : await runSync();
    return json(result);
  }

  // ── Digest list ──────────────────────────────────────────────────────────────
  if (path === "/api/sessions/digest/list" && req.method === "GET") {
    const db = getDb();
    const rows = db
      .query("SELECT date, pair_count, model, mock, generated_at, stale FROM daily_digest ORDER BY date DESC")
      .all();
    return json({ digests: rows });
  }

  // ── Digest missing ───────────────────────────────────────────────────────────
  if (path === "/api/sessions/digest/missing" && req.method === "GET") {
    const dates = findDatesMissingDigest();
    return json({ missing_dates: dates, count: dates.length });
  }

  // ── Digest backfill ──────────────────────────────────────────────────────────
  if (path === "/api/sessions/digest/backfill" && (req.method === "POST" || req.method === "GET")) {
    const force = q.get("force") === "true";
    const result = await backfillDigests(force);
    return json(result);
  }

  // ── Digest for date ──────────────────────────────────────────────────────────
  // LLM calls can take 30-120s. Strategy:
  // - If cached (stale=0) and not force: return immediately
  // - Otherwise: kick off background generation, return {generating:true} immediately
  // - Frontend polls until generating:false
  if (path === "/api/sessions/digest" && req.method === "GET") {
    const date = q.get("date") ?? new Date().toISOString().slice(0, 10);
    const force = q.get("force") === "true";

    // Check cache first
    if (!force) {
      const db = getDb();
      const cached = db
        .query<{ summary: string; pair_count: number; model: string; mock: number; generated_at: string; stale: number }, [string]>(
          "SELECT * FROM daily_digest WHERE date = ? AND stale = 0",
        )
        .get(date);
      if (cached) {
        return json({
          date,
          summary: cached.summary,
          pair_count: cached.pair_count,
          model: cached.model,
          mock: cached.mock === 1,
          generated_at: cached.generated_at,
          stale: false,
          cached: true,
          generating: false,
        });
      }
    }

    // Check if already generating
    if (_generatingDates.has(date)) {
      return json({ date, summary: null, pair_count: 0, model: "", mock: true, generated_at: null, stale: false, cached: false, generating: true });
    }

    // Start background generation
    _generatingDates.add(date);
    generateDigest(date, force)
      .catch((e) => console.warn(`[digest] Background generation failed for ${date}: ${e?.message}`))
      .finally(() => _generatingDates.delete(date));

    return json({ date, summary: null, pair_count: 0, model: "", mock: true, generated_at: null, stale: false, cached: false, generating: true });
  }

  // ── Daily summary ────────────────────────────────────────────────────────────
  if (path === "/api/sessions/summary" && req.method === "GET") {
    const date = q.get("date") ?? new Date().toISOString().slice(0, 10);
    const dateStart = `${date}T00:00:00`;
    const dateEnd = `${date}T23:59:59`;

    const db = getDb();
    const rows = db
      .query<
        { tool: string; session_count: number; turn_count: number; projects: string },
        [string, string]
      >(`
        SELECT tool, COUNT(*) as session_count, SUM(turn_count) as turn_count,
               GROUP_CONCAT(DISTINCT project) as projects
        FROM sessions
        WHERE started_at BETWEEN ? AND ?
        GROUP BY tool
      `)
      .all(dateStart, dateEnd);

    const totalSessions = rows.reduce((s, r) => s + r.session_count, 0);
    const totalTurns = rows.reduce((s, r) => s + (r.turn_count ?? 0), 0);
    const byTool: Record<string, { sessions: number; turns: number; projects: string[] }> = {};
    for (const r of rows) {
      byTool[r.tool] = {
        sessions: r.session_count,
        turns: r.turn_count ?? 0,
        projects: (r.projects ?? "").split(",").filter(Boolean),
      };
    }

    return json({ date, total_sessions: totalSessions, total_turns: totalTurns, by_tool: byTool });
  }

  // ── Session list ─────────────────────────────────────────────────────────────
  if (path === "/api/sessions" && req.method === "GET") {
    const tool = q.get("tool");
    const date = q.get("date");
    const project = q.get("project");
    const limit = Math.min(parseInt(q.get("limit") ?? "50"), 200);
    const offset = parseInt(q.get("offset") ?? "0");

    const db = getDb();
    const filterConds: string[] = [];
    const filterParams: unknown[] = [];
    if (tool) { filterConds.push("s.tool = ?"); filterParams.push(tool); }
    if (project) { filterConds.push("s.project = ?"); filterParams.push(project); }
    const filterSql = filterConds.length ? "AND " + filterConds.join(" AND ") : "";

    let rows: any[], total: number;

    if (date) {
      const dateParams = [...filterParams, date, `${date}T00:00:00`, `${date}T23:59:59`];
      const whereSql = `
        WHERE 1=1 ${filterSql}
          AND (
            date(s.started_at) = ?
            OR EXISTS (
              SELECT 1 FROM turns t
              WHERE t.session_id = s.id
                AND t.timestamp BETWEEN ? AND ?
            )
          )
      `;
      total = (db.query<{ cnt: number }, unknown[]>(
        `SELECT COUNT(DISTINCT s.id) as cnt FROM sessions s ${whereSql}`,
      ).get(...dateParams) as any)?.cnt ?? 0;
      rows = db.query(
        `SELECT DISTINCT s.* FROM sessions s ${whereSql} ORDER BY s.started_at DESC LIMIT ? OFFSET ?`,
      ).all(...dateParams, limit, offset) as any[];
    } else {
      const where = filterConds.length
        ? "WHERE " + filterConds.map((c) => c.replace("s.", "")).join(" AND ")
        : "";
      total = (db.query<{ cnt: number }, unknown[]>(
        `SELECT COUNT(*) as cnt FROM sessions ${where}`,
      ).get(...filterParams) as any)?.cnt ?? 0;
      rows = db.query(
        `SELECT * FROM sessions ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
      ).all(...filterParams, limit, offset) as any[];
    }

    const sessions = rows.map((r: any) => ({
      ...r,
      tool_call_names: parseJsonField(r.tool_call_names, {}),
    }));

    return json({ sessions, total, limit, offset });
  }

  // ── Session turns ────────────────────────────────────────────────────────────
  const turnsMatch = path.match(/^\/api\/sessions\/([^/]+)\/turns$/);
  if (turnsMatch && req.method === "GET") {
    const sessionId = decodeURIComponent(turnsMatch[1]);
    const date = q.get("date");
    const db = getDb();

    const sessionRow = db.query("SELECT * FROM sessions WHERE id = ?").get(sessionId) as any;
    if (!sessionRow) return json({ error: "session not found" }, 404);

    let turns: any[];
    if (date) {
      turns = db
        .query("SELECT * FROM turns WHERE session_id = ? AND date(timestamp) = ? ORDER BY turn_index")
        .all(sessionId, date) as any[];
    } else {
      turns = db
        .query("SELECT * FROM turns WHERE session_id = ? ORDER BY turn_index")
        .all(sessionId) as any[];
    }

    const session = {
      ...sessionRow,
      tool_call_names: parseJsonField(sessionRow.tool_call_names, {}),
    };

    const turnsOut = turns.map((t: any) => ({
      ...t,
      tool_names: parseJsonField(t.tool_names, []),
    }));

    return json({ session, turns: turnsOut, date_filter: date });
  }

  // ── Session stats ────────────────────────────────────────────────────────────
  const statsMatch = path.match(/^\/api\/sessions\/([^/]+)\/stats$/);
  if (statsMatch && req.method === "GET") {
    const sessionId = decodeURIComponent(statsMatch[1]);
    const date = q.get("date");
    const db = getDb();

    const sessionRow = db.query("SELECT * FROM sessions WHERE id = ?").get(sessionId) as any;
    if (!sessionRow) return json({ error: "session not found" }, 404);

    let humanTurns: any[];
    let tokRow: any = null;

    if (date) {
      humanTurns = db
        .query(`
          SELECT id, content, timestamp, turn_index FROM turns
          WHERE session_id = ? AND turn_kind = 'human_input' AND date(timestamp) = ?
          ORDER BY turn_index
        `)
        .all(sessionId, date) as any[];
      tokRow = db
        .query(`
          SELECT
            SUM(input_tokens) as input, SUM(output_tokens) as output,
            SUM(cache_creation_tokens) as cache_creation, SUM(cache_read_tokens) as cache_read,
            COUNT(CASE WHEN tool_calls > 0 THEN 1 END) as tool_call_turns,
            SUM(tool_calls) as total_tool_calls
          FROM turns WHERE session_id = ? AND date(timestamp) = ?
        `)
        .get(sessionId, date);
    } else {
      humanTurns = db
        .query(`
          SELECT id, content, timestamp, turn_index FROM turns
          WHERE session_id = ? AND turn_kind = 'human_input'
          ORDER BY turn_index
        `)
        .all(sessionId) as any[];
    }

    const toolCallNames = parseJsonField<Record<string, number>>(sessionRow.tool_call_names, {});

    const tokens = tokRow && date
      ? {
          input: tokRow.input ?? 0,
          output: tokRow.output ?? 0,
          cache_creation: tokRow.cache_creation ?? 0,
          cache_read: tokRow.cache_read ?? 0,
        }
      : {
          input: sessionRow.input_tokens ?? 0,
          output: sessionRow.output_tokens ?? 0,
          cache_creation: sessionRow.cache_creation_tokens ?? 0,
          cache_read: sessionRow.cache_read_tokens ?? 0,
        };

    const toolTotal = tokRow && date
      ? (tokRow.total_tool_calls ?? 0)
      : (sessionRow.tool_call_count ?? 0);

    return json({
      session_id: sessionId,
      tokens,
      tool_calls: { total: toolTotal, by_name: toolCallNames },
      human_turns: humanTurns.map((t: any) => ({
        id: t.id,
        turn_index: t.turn_index,
        timestamp: t.timestamp,
        content: t.content,
      })),
    });
  }

  return null; // not handled
}

import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { fileChanged, getDb, upsertSession } from "./db";
import { PARSERS } from "./parsers/index";

// ── Discovery paths ───────────────────────────────────────────────────────────

const HOME = process.env.HOME ?? "~";
const CLAUDE_ROOT = join(HOME, ".claude", "projects");
const CODEX_ROOT = join(HOME, ".codex", "sessions");
const GEMINI_ROOT = join(HOME, ".gemini", "tmp");

// ── File discovery ────────────────────────────────────────────────────────────

function globRecursive(dir: string, pattern: RegExp, exclude?: (p: string) => boolean): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  function walk(current: string) {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!exclude?.(fullPath)) walk(fullPath);
      } else if (entry.isFile() && pattern.test(entry.name)) {
        results.push(fullPath);
      }
    }
  }
  walk(dir);
  return results;
}

export function discoverFiles(): { tool: string; path: string }[] {
  const results: { tool: string; path: string }[] = [];

  // Claude Code: exclude subagents/
  for (const p of globRecursive(CLAUDE_ROOT, /\.jsonl$/, (path) => path.includes("/subagents"))) {
    results.push({ tool: "claude", path: p });
  }

  // Codex CLI
  for (const p of globRecursive(CODEX_ROOT, /\.jsonl$/)) {
    results.push({ tool: "codex", path: p });
  }

  // Gemini CLI
  for (const p of globRecursive(GEMINI_ROOT, /^session-.*\.json$/)) {
    results.push({ tool: "gemini", path: p });
  }

  return results;
}

// ── Single file sync ──────────────────────────────────────────────────────────

async function syncFile(
  tool: string,
  filePath: string,
): Promise<{ file: string; tool: string; status: "ok" | "error"; turns?: number; error?: string }> {
  const parser = PARSERS[tool];
  if (!parser) return { file: filePath, tool, status: "error", error: `No parser for ${tool}` };

  try {
    const { session, turns } = await parser(filePath);
    await upsertSession(session, turns, filePath);
    return { file: filePath, tool, status: "ok", turns: turns.length };
  } catch (e: any) {
    console.warn(`[sync] Failed to sync ${filePath}: ${e?.message}`);
    return { file: filePath, tool, status: "error", error: String(e?.message) };
  }
}

// ── Incremental sync ──────────────────────────────────────────────────────────

export async function runSync(): Promise<{
  synced: number;
  skipped: number;
  errors: number;
  total_files: number;
  duration_ms: number;
}> {
  const start = performance.now();
  const files = discoverFiles();
  let synced = 0, skipped = 0, errors = 0;

  for (const { tool, path } of files) {
    if (!fileChanged(path)) {
      skipped++;
      continue;
    }
    const result = await syncFile(tool, path);
    if (result.status === "ok") synced++;
    else errors++;
  }

  return {
    synced,
    skipped,
    errors,
    total_files: files.length,
    duration_ms: Math.round(performance.now() - start),
  };
}

// ── Force resync for a specific date ─────────────────────────────────────────

export async function runSyncForDate(date: string): Promise<{
  date: string;
  synced: number;
  skipped: number;
  errors: number;
  total_files: number;
  duration_ms: number;
}> {
  const start = performance.now();
  const files = discoverFiles();
  let synced = 0, errors = 0;

  // Find source files for sessions active on this date
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT DISTINCT source_file FROM sessions WHERE date(started_at) = ?",
    )
    .all(date) as { source_file: string }[];
  const dateFiles = new Set(rows.map((r) => r.source_file));

  let matched = files.filter(({ path }) => dateFiles.has(path));
  if (matched.length === 0) matched = files; // first-time import

  for (const { tool, path } of matched) {
    const result = await syncFile(tool, path);
    if (result.status === "ok") synced++;
    else errors++;
  }

  return {
    date,
    synced,
    skipped: 0,
    errors,
    total_files: matched.length,
    duration_ms: Math.round(performance.now() - start),
  };
}

// ── Background auto-sync ──────────────────────────────────────────────────────

const SYNC_INTERVAL = parseInt(process.env.SESSION_SYNC_INTERVAL ?? "300") * 1000;
let _syncTimer: ReturnType<typeof setTimeout> | null = null;

async function backgroundSync() {
  try {
    const result = await runSync();
    if (result.synced > 0) {
      console.log(
        `[sync] synced=${result.synced} skipped=${result.skipped} errors=${result.errors} (${result.duration_ms}ms)`,
      );
    }
  } catch (e: any) {
    console.warn(`[sync] Auto-sync failed: ${e?.message}`);
  }

  // Backfill missing digests after sync
  try {
    const { backfillDigests } = await import("./digest");
    const bf = await backfillDigests(false);
    if (bf.generated > 0) {
      console.log(
        `[digest] backfill: generated=${bf.generated} skipped=${bf.skipped} errors=${bf.errors}`,
      );
    }
  } catch (e: any) {
    console.warn(`[digest] Backfill failed: ${e?.message}`);
  }

  scheduleNextSync();
}

function scheduleNextSync() {
  _syncTimer = setTimeout(backgroundSync, SYNC_INTERVAL);
}

export function startAutoSync(): void {
  console.log(`[sync] Auto-sync enabled, interval=${SYNC_INTERVAL / 1000}s`);
  // Run immediately, then schedule
  backgroundSync();
}

export function stopAutoSync(): void {
  if (_syncTimer) {
    clearTimeout(_syncTimer);
    _syncTimer = null;
  }
}

// ── Proxy traffic.jsonl 增量同步 ─────────────────────────────────────────────

export async function syncProxyTraffic(): Promise<{ inserted: number; errors: number }> {
  const { parseTrafficFile } = await import("./parsers/proxy-traffic");
  const { initProxySchema, serializeWrite, getDb } = await import("./db");
  const { PROXY_SERVER_PATHS } = await import("./proxy-v2/paths");

  // proxy 是机器级全局设施，traffic.jsonl 固定在 ~/.api-dashboard/proxy。
  // 这里不能跟随 worktree 的 API_DASHBOARD_DIR，否则 UI 会读取旧 worktree 日志，
  // 与当前 dashboard 托管的运行中 proxy 脱节。
  const trafficLog = PROXY_SERVER_PATHS.trafficLog;

  const db = getDb();
  initProxySchema();

  const stateRow = db
    .prepare(
      "SELECT last_line FROM proxy_sync_state WHERE source_file = ?",
    )
    .get(trafficLog) as { last_line: number } | undefined;
  const storedLine = stateRow?.last_line ?? 0;

  const records = await parseTrafficFile(trafficLog);

  // 若文件被轮转（总行数 < storedLine），从头同步
  const lastLine = records.length < storedLine ? 0 : storedLine;

  const newRecords = records.slice(lastLine);
  if (newRecords.length === 0) return { inserted: 0, errors: 0 };

  let inserted = 0, errors = 0;
  await serializeWrite(() => {
    const insert = db.prepare(`
      INSERT INTO proxy_requests
        (ts, started_at, sni, method, url, status, bytes_in, bytes_out, duration_ms,
         req_headers, res_headers, req_body, res_body,
         req_body_encoding, res_body_encoding,
         sse_event_count, is_stream)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.transaction(() => {
      for (const r of newRecords) {
        try {
          insert.run(
            r.ts, r.started_at, r.sni, r.method, r.url, r.status,
            r.bytes_in, r.bytes_out, r.duration_ms,
            r.req_headers, r.res_headers, r.req_body, r.res_body,
            r.req_body_encoding, r.res_body_encoding,
            r.sse_event_count, r.is_stream ? 1 : 0,
          );
          inserted++;
        } catch {
          errors++;
        }
      }
      db.prepare(`
        INSERT OR REPLACE INTO proxy_sync_state (source_file, last_line, synced_at)
        VALUES (?, ?, ?)
      `).run(trafficLog, lastLine + inserted, new Date().toISOString());
    })();
  });

  return { inserted, errors };
}


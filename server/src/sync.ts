import { existsSync, readdirSync, statSync } from "fs";
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
    upsertSession(session, turns, filePath);
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
    .query<{ source_file: string }, [string]>(
      "SELECT DISTINCT source_file FROM sessions WHERE date(started_at) = ?",
    )
    .all(date);
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

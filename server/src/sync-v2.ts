import { statSync } from "fs";
import { getDb, serializeWrite } from "./db.ts";
import { discoverFiles } from "./sync.ts";
import { PARSERS_V2, PARSER_VERSION, type SessionMetaV2 } from "./parsers-v2/index.ts";
import { clearDaySliceCache } from "./day-slice.ts";

// ── Prepared statements (hoisted to avoid re-compilation per file) ────────────

let _stmtLookup: ReturnType<typeof getDb>["prepare"] | null = null;
let _stmtUpsert: ReturnType<typeof getDb>["prepare"] | null = null;

function stmtLookup() {
  if (!_stmtLookup) _stmtLookup = getDb().prepare(
    "SELECT file_mtime, file_size, parser_version FROM sessions_meta_v2 WHERE source_file = ?",
  );
  return _stmtLookup;
}

function stmtUpsert() {
  if (!_stmtUpsert) _stmtUpsert = getDb().prepare(`
    INSERT OR REPLACE INTO sessions_meta_v2 (
      session_id, tool, source_file,
      file_mtime, file_size, parser_version, schema_fingerprint, source_present,
      first_event_at, last_event_at,
      cwd, project, custom_title, ai_title, first_user_message,
      event_count,
      input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, models,
      tool_call_count, human_input_count, sub_agent_count,
      claude_code_api_error_count, parser_warnings,
      away_summary, last_assistant_text
    ) VALUES (
      ?, ?, ?,
      ?, ?, ?, ?, 1,
      ?, ?,
      ?, ?, ?, ?, ?,
      ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?
    )
  `);
  return _stmtUpsert;
}

// ── Upsert ────────────────────────────────────────────────────────────────────

function upsertSessionMetaV2(meta: SessionMetaV2, fileMtime: number, fileSize: number): void {
  stmtUpsert().run(
    meta.session_id, meta.tool, meta.source_file,
    fileMtime, fileSize, PARSER_VERSION, meta.schema_fingerprint,
    meta.first_event_at, meta.last_event_at,
    meta.cwd, meta.project, meta.custom_title, meta.ai_title, meta.first_user_message,
    meta.event_count,
    meta.input_tokens, meta.output_tokens, meta.cache_creation_tokens, meta.cache_read_tokens,
    JSON.stringify(meta.models),
    meta.tool_call_count, meta.human_input_count, meta.sub_agent_count,
    meta.claude_code_api_error_count, JSON.stringify(meta.parser_warnings),
    meta.away_summary ?? null, meta.last_assistant_text ?? null,
  );
}

// ── Change detection ──────────────────────────────────────────────────────────

function needsSync(filePath: string, currentMtime: number, currentSize: number): boolean {
  const row = stmtLookup().get(filePath) as { file_mtime: number; file_size: number; parser_version: number } | undefined;
  if (!row) return true;
  if (row.parser_version < PARSER_VERSION) return true;
  return row.file_mtime !== currentMtime || row.file_size !== currentSize;
}

// ── Soft-delete missing files (SQL-side filtering) ────────────────────────────

function markMissingFiles(presentPaths: Set<string>): void {
  const db = getDb();
  const rows = db.prepare(
    "SELECT source_file FROM sessions_meta_v2 WHERE source_present = 1",
  ).all() as { source_file: string }[];

  const toMark = rows.filter((r) => !presentPaths.has(r.source_file));
  if (toMark.length === 0) return;

  const stmt = db.prepare("UPDATE sessions_meta_v2 SET source_present = 0 WHERE source_file = ?");
  db.transaction(() => {
    for (const r of toMark) {
      stmt.run(r.source_file);
      console.log(`[sync-v2] soft-deleted missing file: ${r.source_file}`);
    }
  })();
}

// ── Known fingerprints for drift detection ────────────────────────────────────

let _knownFingerprints: Set<string> | null = null;

function getKnownFingerprints(): Set<string> {
  if (!_knownFingerprints) {
    const db = getDb();
    const rows = db.prepare("SELECT DISTINCT schema_fingerprint FROM sessions_meta_v2 WHERE schema_fingerprint IS NOT NULL").all() as { schema_fingerprint: string }[];
    _knownFingerprints = new Set(rows.map((r) => r.schema_fingerprint));
  }
  return _knownFingerprints;
}

// ── Incremental sync ──────────────────────────────────────────────────────────

export async function runSyncV2(files?: { tool: string; path: string }[]): Promise<{
  synced: number;
  skipped: number;
  errors: number;
  total_files: number;
  duration_ms: number;
}> {
  const start = performance.now();
  // v2 is Claude-only; codex/gemini continue to be handled by v1 sync
  const fileList = (files ?? discoverFiles()).filter((f) => f.tool === "claude");
  const presentPaths = new Set(fileList.map((f) => f.path));

  await serializeWrite(() => markMissingFiles(presentPaths));

  let synced = 0, skipped = 0, errors = 0;
  const knownFingerprints = getKnownFingerprints();

  for (const { tool, path } of fileList) {
    let mtime: number, size: number;
    try {
      const stat = statSync(path);
      mtime = stat.mtimeMs;
      size = stat.size;
    } catch {
      errors++;
      continue;
    }

    if (!needsSync(path, mtime, size)) {
      skipped++;
      continue;
    }

    const parser = PARSERS_V2[tool];
    if (!parser) { errors++; continue; }

    try {
      const meta = await parser(path);

      // Fingerprint drift detection — warn once per new fingerprint
      if (meta.schema_fingerprint && !knownFingerprints.has(meta.schema_fingerprint)) {
        console.warn(`[sync-v2] new schema fingerprint ${meta.schema_fingerprint} in ${path} (types: ${meta.parser_warnings.length > 0 ? meta.parser_warnings.join(",") : "all known"})`);
        knownFingerprints.add(meta.schema_fingerprint);
        _knownFingerprints?.add(meta.schema_fingerprint);
      }

      await serializeWrite(() => upsertSessionMetaV2(meta, mtime, size));
      synced++;
    } catch (e: any) {
      console.warn(`[sync-v2] Failed to sync ${path}: ${e?.message}`);
      errors++;
    }
  }

  if (synced > 0) clearDaySliceCache();

  return {
    synced,
    skipped,
    errors,
    total_files: fileList.length,
    duration_ms: Math.round(performance.now() - start),
  };
}

// ── Background auto-sync ──────────────────────────────────────────────────────

const SYNC_INTERVAL = parseInt(process.env.SESSION_SYNC_INTERVAL ?? "300") * 1000;
let _syncTimer: ReturnType<typeof setTimeout> | null = null;

async function backgroundSyncV2(files?: { tool: string; path: string }[]) {
  try {
    const result = await runSyncV2(files);
    if (result.synced > 0 || result.errors > 0) {
      console.log(
        `[sync-v2] synced=${result.synced} skipped=${result.skipped} errors=${result.errors} (${result.duration_ms}ms)`,
      );
    }
  } catch (e: any) {
    console.warn(`[sync-v2] Auto-sync failed: ${e?.message}`);
  }
  _syncTimer = setTimeout(backgroundSyncV2, SYNC_INTERVAL);
}

export function startAutoSyncV2(files?: { tool: string; path: string }[]): void {
  console.log(`[sync-v2] Auto-sync enabled, interval=${SYNC_INTERVAL / 1000}s`);
  backgroundSyncV2(files);
}

export function stopAutoSyncV2(): void {
  if (_syncTimer) {
    clearTimeout(_syncTimer);
    _syncTimer = null;
  }
}

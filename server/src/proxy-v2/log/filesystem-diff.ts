import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { PROXY_SERVER_PATHS as PATHS } from "../paths";
import { FILESYSTEM_DIFF_INTERVAL_MS } from "./config";
import { getDb, serializeWrite } from "../../db";

const COLD_FILE_RE = /^traffic\.jsonl\..+\.gz$/;

function listColdFilesOnDisk(): string[] {
  const dir = dirname(PATHS.trafficLog);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((n) => COLD_FILE_RE.test(n))
      .map((n) => join(dir, n));
  } catch {
    return [];
  }
}

function getIndexedColdPaths(): string[] {
  const db = getDb();
  return (db.prepare("SELECT file_path FROM indexed_cold_files").all() as { file_path: string }[])
    .map((r) => r.file_path);
}

async function runDiff(): Promise<void> {
  const diskFiles = new Set(listColdFilesOnDisk());
  const dbFiles = getIndexedColdPaths();

  const deleted = dbFiles.filter((f) => !diskFiles.has(f));
  if (deleted.length === 0) return;

  const db = getDb();
  await serializeWrite(() => {
    db.transaction(() => {
      for (const f of deleted) {
        db.prepare("DELETE FROM proxy_requests WHERE jsonl_file = ?").run(f);
        db.prepare("DELETE FROM indexed_cold_files WHERE file_path = ?").run(f);
        console.log(`[filesystem-diff] removed deleted file from DB: ${f}`);
      }
    })();
  });
}

let _timer: ReturnType<typeof setInterval> | null = null;

export function startFilesystemDiffWorker(): void {
  _timer = setInterval(() => {
    runDiff().catch((e) => console.warn("[filesystem-diff] error:", e));
  }, FILESYSTEM_DIFF_INTERVAL_MS);
}

export function stopFilesystemDiffWorker(): void {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

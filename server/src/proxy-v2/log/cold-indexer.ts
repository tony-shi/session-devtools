import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createGunzip } from "node:zlib";
import readline from "node:readline";
import { PROXY_SERVER_PATHS as PATHS } from "../paths";
import { COLD_INDEXER_IDLE_MS, SYNC_BATCH_RECORDS } from "./config";
import { parseTrafficLine } from "../../parsers/proxy-traffic";
import { getDb, serializeWrite } from "../../db";

const COLD_FILE_RE = /^traffic\.jsonl\..+\.gz$/;

function listColdFiles(): string[] {
  const dir = dirname(PATHS.trafficLog);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((n) => COLD_FILE_RE.test(n))
      .map((n) => join(dir, n))
      .sort()
      .reverse(); // 最新优先
  } catch {
    return [];
  }
}

// indexed_cold_files 中只有 cold-indexer 完整写入的记录（无占位行）
function getIndexedPaths(): Set<string> {
  const db = getDb();
  const rows = db.prepare("SELECT file_path FROM indexed_cold_files").all() as { file_path: string }[];
  return new Set(rows.map((r) => r.file_path));
}

function findUnindexedColdFiles(): string[] {
  const indexed = getIndexedPaths();
  return listColdFiles().filter((f) => !indexed.has(f));
}

async function batchInsert(records: Array<Record<string, unknown>>): Promise<void> {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO proxy_requests
      (ts, started_at, sni, method, url, status, bytes_in, bytes_out, duration_ms,
       req_headers, res_headers, sse_event_count, is_stream,
       jsonl_file, jsonl_byte_offset)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let i = 0; i < records.length; i += SYNC_BATCH_RECORDS) {
    const batch = records.slice(i, i + SYNC_BATCH_RECORDS);
    await serializeWrite(() => {
      db.transaction(() => {
        for (const r of batch) {
          stmt.run(
            r.ts, r.started_at, r.sni, r.method, r.url, r.status,
            r.bytes_in, r.bytes_out, r.duration_ms,
            r.req_headers, r.res_headers,
            r.sse_event_count, r.is_stream ? 1 : 0,
            r.jsonl_file, r.jsonl_byte_offset,
          );
        }
      })();
    });
    await new Promise((r) => setImmediate(r));
  }
}

async function indexColdFile(filePath: string): Promise<void> {
  // 幂等保证：先删这个文件的旧记录，再全量插入。
  // 这样崩溃重启后重新索引，不会产生重复数据。
  await serializeWrite(() => {
    getDb().prepare("DELETE FROM proxy_requests WHERE jsonl_file = ?").run(filePath);
  });

  const stream = createReadStream(filePath).pipe(createGunzip());
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let uncompressedOffset = 0;
  let recordCount = 0;
  let tsStart: string | null = null;
  let tsEnd: string | null = null;
  let buffer: Array<Record<string, unknown>> = [];

  for await (const line of rl) {
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    if (line.trim()) {
      const rec = parseTrafficLine(line);
      if (rec) {
        buffer.push({ ...rec, jsonl_file: filePath, jsonl_byte_offset: uncompressedOffset });
        recordCount++;
        if (!tsStart) tsStart = rec.started_at || rec.ts;
        tsEnd = rec.started_at || rec.ts;
      }
    }
    uncompressedOffset += lineBytes;

    if (buffer.length >= SYNC_BATCH_RECORDS) {
      await batchInsert(buffer.splice(0));
    }
  }
  if (buffer.length > 0) await batchInsert(buffer.splice(0));

  // 全部插入完成后才登记到 indexed_cold_files（登记了 = 完整索引过）
  // ts_start/ts_end 对空文件存 null（不存 "" 避免时间范围查询的边界异常）
  await serializeWrite(() => {
    getDb().prepare(`
      INSERT OR REPLACE INTO indexed_cold_files (file_path, ts_start, ts_end, record_count, byte_size, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      filePath,
      tsStart,
      tsEnd,
      recordCount,
      (() => { try { return statSync(filePath).size; } catch { return 0; } })(),
      new Date().toISOString(),
    );
  });

  console.log(`[cold-indexer] indexed ${filePath}: ${recordCount} records`);
}

export function getColdIndexProgress(): { total: number; indexed: number; pending: number } {
  const all = listColdFiles().length;
  const indexed = getIndexedPaths().size;
  return { total: all, indexed, pending: all - indexed };
}

let _running = false;
let _stop = false;
// 来自 cache-sync 的优先索引请求队列（rotate 后立即通知，不等 30s idle）
const _priorityQueue: string[] = [];

// cache-sync rotate 后调用此函数，让 cold-indexer 立即处理刚压缩完成的文件
export function indexNow(filePath: string): void {
  if (!_priorityQueue.includes(filePath)) {
    _priorityQueue.push(filePath);
  }
}

export async function coldIndexerLoop(): Promise<void> {
  if (_running) return;
  _running = true;
  _stop = false;

  while (!_stop) {
    // 优先处理 cache-sync 通知的文件
    while (_priorityQueue.length > 0 && !_stop) {
      const file = _priorityQueue.shift()!;
      if (getIndexedPaths().has(file)) continue;
      // rotation-worker 5s 一轮，gz 可能还没出现，等最多 30s
      let waited = 0;
      while (!existsSync(file) && waited < 30_000) {
        await new Promise((r) => setTimeout(r, 500));
        waited += 500;
      }
      if (!existsSync(file)) {
        console.warn(`[cold-indexer] priority file not found after 30s: ${file}`);
        continue;
      }
      try {
        await indexColdFile(file);
      } catch (e) {
        console.warn(`[cold-indexer] priority index failed ${file}:`, e);
      }
    }

    const unindexed = findUnindexedColdFiles();
    if (unindexed.length === 0) {
      await new Promise((r) => setTimeout(r, COLD_INDEXER_IDLE_MS));
      continue;
    }
    for (const file of unindexed) {
      if (_stop || _priorityQueue.length > 0) break; // 有优先任务时中断常规扫描
      try {
        await indexColdFile(file);
      } catch (e) {
        console.warn(`[cold-indexer] failed to index ${file}:`, e);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  _running = false;
}

export function startColdIndexer(): void {
  coldIndexerLoop().catch((e) => console.error("[cold-indexer] loop crashed:", e));
}

export function stopColdIndexer(): void {
  _stop = true;
}

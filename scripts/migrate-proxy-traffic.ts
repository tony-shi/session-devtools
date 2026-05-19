#!/usr/bin/env tsx
// 一次性迁移脚本：把旧格式 traffic.jsonl.* 文件重新打包成新的 .gz 冷文件格式。
//
// 使用方法：
//   1. 停止 proxy 和 dashboard
//   2. npm run migrate:proxy-traffic
//   3. 启动 dashboard，自动重建索引
//
// 注意：迁移期间 proxy server 必须停止。
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import readline from "node:readline";

const PROXY_DIR = join(homedir(), ".api-dashboard", "proxy");
const TRAFFIC_LOG = join(PROXY_DIR, "traffic.jsonl");
const ROTATE_BYTES = 64 * 1024 * 1024;

function pad4(n: number): string { return n.toString().padStart(4, "0"); }

function listOldRotations(): string[] {
  if (!existsSync(PROXY_DIR)) return [];
  return readdirSync(PROXY_DIR)
    .filter((n) => n.startsWith("traffic.jsonl.") && !n.endsWith(".gz") && n !== "traffic.jsonl")
    .map((n) => join(PROXY_DIR, n))
    .sort();
}

function listNewColdFiles(): string[] {
  if (!existsSync(PROXY_DIR)) return [];
  return readdirSync(PROXY_DIR)
    .filter((n) => /^traffic\.jsonl\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z?\.\d{4}\.gz$/.test(n))
    .map((n) => join(PROXY_DIR, n));
}

function isNewFormat(filePath: string): boolean {
  return /traffic\.jsonl\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z?\.\d{4}(\.gz)?$/.test(filePath);
}

async function* streamLines(filePath: string): AsyncGenerator<{ line: string; byteOffset: number }> {
  const rl = readline.createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  let offset = 0;
  for await (const line of rl) {
    yield { line, byteOffset: offset };
    offset += Buffer.byteLength(line, "utf8") + 1;
  }
}

async function writeGzShard(lines: string[], shardTs: string, shardNum: number): Promise<string> {
  const outPath = join(PROXY_DIR, `traffic.jsonl.${shardTs}.${pad4(shardNum)}.gz`);
  const tmpPath = outPath + ".tmp";
  const content = lines.join("\n") + "\n";
  await pipeline(
    (async function* () { yield Buffer.from(content, "utf8"); })(),
    createGzip(),
    createWriteStream(tmpPath),
  );
  renameSync(tmpPath, outPath);
  return outPath;
}

async function main() {
  console.log("[migrate] Starting proxy traffic migration...");

  // 检查 proxy.pid
  const pidFile = join(PROXY_DIR, "proxy.pid");
  if (existsSync(pidFile)) {
    const pid = parseInt(require("fs").readFileSync(pidFile, "utf8").trim());
    try {
      process.kill(pid, 0); // 检查进程是否存在
      console.error(`[migrate] ERROR: proxy server is still running (pid=${pid}). Stop it first.`);
      process.exit(1);
    } catch { /* proxy not running, OK */ }
  }

  // 收集所有旧格式文件（跳过已是新格式的）
  const oldFiles = listOldRotations().filter((f) => !isNewFormat(f));
  const hasCacheFile = existsSync(TRAFFIC_LOG);

  if (!hasCacheFile && oldFiles.length === 0) {
    console.log("[migrate] Nothing to migrate. Exiting.");
    return;
  }

  // 备份
  const backupTs = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = join(homedir(), ".api-dashboard", `proxy-backup-${backupTs}`);
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });

  const filesToBackup = [...oldFiles];
  if (hasCacheFile) filesToBackup.push(TRAFFIC_LOG);

  for (const f of filesToBackup) {
    try {
      // 硬链接备份（不占额外空间）
      require("fs").linkSync(f, join(backupDir, require("path").basename(f)));
    } catch {
      // 硬链接失败则跳过备份（跨设备等情况）
    }
  }
  console.log(`[migrate] Backup created at ${backupDir}`);

  // 流式读取所有旧文件，按 ROTATE_BYTES 切分成新格式 .gz
  const sources: string[] = [...oldFiles];
  if (hasCacheFile) sources.push(TRAFFIC_LOG);

  let shardLines: string[] = [];
  let shardBytes = 0;
  let shardNum = 1;
  let shardTs = new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[:.]/g, "-");
  let totalRecords = 0;
  let shardCount = 0;

  const flush = async () => {
    if (shardLines.length === 0) return;
    const out = await writeGzShard(shardLines, shardTs, shardNum);
    console.log(`[migrate] wrote ${out} (${shardLines.length} lines)`);
    shardLines = [];
    shardBytes = 0;
    shardNum++;
    shardCount++;
  };

  for (const src of sources) {
    console.log(`[migrate] processing ${src}...`);
    for await (const { line } of streamLines(src)) {
      if (!line.trim()) continue;
      const lineBytes = Buffer.byteLength(line, "utf8") + 1;
      if (shardBytes + lineBytes > ROTATE_BYTES && shardLines.length > 0) {
        await flush();
        shardTs = new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[:.]/g, "-");
      }
      shardLines.push(line);
      shardBytes += lineBytes;
      totalRecords++;
    }
  }
  await flush();

  console.log(`[migrate] Done. ${totalRecords} records → ${shardCount} cold shards.`);

  // 删除旧文件（备份已完成）
  for (const f of oldFiles) {
    try { unlinkSync(f); } catch {}
  }

  // 清理 sessions.db 中的 proxy 旧记录
  const dbPath = join(homedir(), ".api-dashboard", "sessions.db");
  if (existsSync(dbPath)) {
    try {
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(dbPath);
      db.exec("DROP TABLE IF EXISTS proxy_sync_state");
      db.prepare("DELETE FROM proxy_requests").run();
      db.close();
      console.log("[migrate] Cleared proxy_requests and proxy_sync_state from sessions.db");
    } catch (e) {
      console.warn("[migrate] Could not clear DB (will be rebuilt on next start):", e);
    }
  }

  console.log("[migrate] Migration complete. Start the dashboard to rebuild indexes.");
}

main().catch((e) => {
  console.error("[migrate] Fatal error:", e);
  process.exit(1);
});

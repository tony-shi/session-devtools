import { createReadStream, createWriteStream, existsSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { PROXY_SERVER_PATHS as PATHS } from "../paths";
import { ROTATION_WORKER_INTERVAL_MS } from "./config";

// 匹配中间态文件：traffic.jsonl.<ISO_TS>.<NNNN>（无 .gz 后缀）
const INTERMEDIATE_RE = /^traffic\.jsonl\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.\d{4}$/;

function listIntermediateFiles(): string[] {
  const dir = dirname(PATHS.trafficLog);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((n) => INTERMEDIATE_RE.test(n))
      .map((n) => join(dir, n));
  } catch {
    return [];
  }
}

async function compressFile(filePath: string): Promise<void> {
  const gzPath = filePath + ".gz";
  const tmpPath = gzPath + ".tmp";
  // 如果已经有 .gz 则跳过（幂等）
  if (existsSync(gzPath)) {
    try { unlinkSync(filePath); } catch {}
    return;
  }
  await pipeline(
    createReadStream(filePath),
    createGzip(),
    createWriteStream(tmpPath),
  );
  // 原子 rename：.gz 出现即完整，消除 cold-indexer 读到半截文件的竞态
  renameSync(tmpPath, gzPath);
  unlinkSync(filePath);
}

async function runOnce(): Promise<void> {
  for (const file of listIntermediateFiles()) {
    try {
      await compressFile(file);
    } catch (e) {
      console.warn(`[rotation-worker] compress failed for ${file}:`, e);
    }
  }
}

let _timer: ReturnType<typeof setTimeout> | null = null;

export function startRotationWorker(): void {
  const tick = () => {
    runOnce().catch((e) => console.warn("[rotation-worker] tick error:", e))
      .finally(() => { _timer = setTimeout(tick, ROTATION_WORKER_INTERVAL_MS); });
  };
  // 启动时立刻跑一轮，处理上次主服务崩溃留下的中间态
  tick();
}

export function stopRotationWorker(): void {
  if (_timer) { clearTimeout(_timer); _timer = null; }
}

// 等待某个中间态文件被压缩成 .gz，超时返回 null
export async function waitUntilCompressed(intermediatePath: string, timeoutMs: number): Promise<string | null> {
  const gzPath = intermediatePath.endsWith(".gz") ? intermediatePath : intermediatePath + ".gz";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(gzPath)) {
      try { statSync(gzPath); return gzPath; } catch {}
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

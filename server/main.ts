import "reflect-metadata";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { AppModule } from "./src/app.module.ts";
import { checkDbHealth, initDb, initV2Schema } from "./src/db.ts";
import { runSync, startAutoSync, discoverFiles } from "./src/sync.ts";
import { startAutoSyncV2 } from "./src/sync-v2.ts";

// ── Load .env (then .env.local overrides) ────────────────────────────────────
function loadEnvFile(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    process.env[key] ??= val;
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, "..");
const ROOT = join(__dirname, "..");
loadEnvFile(join(ROOT, ".env"));
loadEnvFile(join(ROOT, ".env.local"));

// ── DB health check ───────────────────────────────────────────────────────────
const health = checkDbHealth();
if (health.status === "missing") {
  console.log("[db] No database found — initializing and running full sync...");
  initDb();
  const result = await runSync();
  console.log(
    `[db] Full sync complete: ${result.synced} sessions synced, ${result.errors} errors (${result.duration_ms}ms)`,
  );
} else if (health.status === "incomplete") {
  console.error("[db] ERROR: Database exists but schema is incomplete.");
  console.error(`[db] Missing: ${health.missing.join(", ")}`);
  console.error(
    `[db] To rebuild: rm ${process.env.API_DASHBOARD_DIR ?? "~/.api-dashboard"}/sessions.db`,
  );
  console.error("[db] Then restart the server.");
  process.exit(1);
} else {
  console.log(`[db] OK — ${health.sessions} sessions, ${health.turns} turns`);
  initDb();
}

// ── Background sync (v1 + v2 share one discoverFiles() call per cycle) ───────
const _initialFiles = discoverFiles();
startAutoSync(_initialFiles);

initV2Schema();
startAutoSyncV2(_initialFiles);

// ── Proxy traffic workers ────────────────────────────────────────────────────
{
  const { PROXY_SERVER_PATHS } = await import("./src/proxy-v2/paths.ts");
  const { getDb } = await import("./src/db.ts");

  // Step 2: 清理 cache 历史记录（上次关机时 sync 状态已丢失，cache 必须重新同步）
  // 只删 jsonl_file = trafficLog（确定是 cache 阶段的实时预览），不删 jsonl_file=''
  // （那是未迁移的存量数据，body 接口会优雅返回 file_deleted，不应在此一刀砍掉）
  try {
    const db = getDb();
    getDb().prepare("DELETE FROM proxy_requests WHERE jsonl_file = ?")
      .run(PROXY_SERVER_PATHS.trafficLog);
    // 提示：如果存量数据的 jsonl_file='' 且 indexed_cold_files 为空，说明用户未跑迁移脚本
    const legacyCount = (db.prepare("SELECT COUNT(*) as n FROM proxy_requests WHERE jsonl_file = ''").get() as { n: number }).n;
    const coldIndexed = (db.prepare("SELECT COUNT(*) as n FROM indexed_cold_files").get() as { n: number }).n;
    if (legacyCount > 0 && coldIndexed === 0) {
      console.warn(`[proxy] ${legacyCount} legacy records with empty jsonl_file — body fetch will return file_deleted. Run "npm run migrate:proxy-traffic" to rebuild.`);
    }
  } catch { /* 表可能还未建，忽略 */ }

  // Step 3: 启动 RotationWorker（先处理未压缩中间态）
  const { startRotationWorker } = await import("./src/proxy-v2/log/rotation-worker.ts");
  startRotationWorker();

  // Step 4: 启动 CacheSyncWorker
  const { startCacheSyncWorker } = await import("./src/proxy-v2/log/cache-sync-worker.ts");
  startCacheSyncWorker();

  // Step 5: 启动 ColdIndexerWorker
  const { startColdIndexer } = await import("./src/proxy-v2/log/cold-indexer.ts");
  startColdIndexer();

  // Step 6: 启动 FilesystemDiffWorker
  const { startFilesystemDiffWorker } = await import("./src/proxy-v2/log/filesystem-diff.ts");
  startFilesystemDiffWorker();
}

// ── Proxy v2 boot reconcile ───────────────────────────────────────────────────
try {
  const { proxyV2Controller } = await import("./src/proxy-v2/controller.ts");
  await proxyV2Controller.reconcileOnBoot();
} catch (err) {
  console.error("[proxy-v2] boot reconcile fatal:", err);
}

// ── NestJS + Fastify ──────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? "5051");
const app = await NestFactory.create<NestFastifyApplication>(
  AppModule,
  new FastifyAdapter({ logger: false }),
);

await app.register(
  (await import("@fastify/cors")).default,
  { origin: "*", methods: ["GET", "POST", "PUT", "OPTIONS"] },
);

const SILENT_PATHS = new Set([
  "/api/proxy-v2/status",
]);

const fastify = app.getHttpAdapter().getInstance();
fastify.addHook("onResponse", (request: any, reply: any, done: () => void) => {
  const url: string = request.url.split("?")[0];
  if (!SILENT_PATHS.has(url)) {
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    console.log(`[http] ${time} ${reply.statusCode} ${request.method} ${request.url} ${Math.round(reply.elapsedTime)}ms`);
  }
  done();
});

await app.init();
await app.listen(PORT, "0.0.0.0");
console.log(
  `[server] Session Dashboard (Node) running at http://localhost:${PORT}`,
);

// ── Shutdown hooks ────────────────────────────────────────────────────────────
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[server] received ${signal}, shutting down...`);
  try {
    const { proxyV2Controller } = await import("./src/proxy-v2/controller.ts");
    await proxyV2Controller.shutdown();
  } catch (err) {
    console.error("[server] proxy-v2 shutdown error:", err);
  }
  await app.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

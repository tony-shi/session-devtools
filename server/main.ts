import "reflect-metadata";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  NestFastifyApplication,
} from "@nestjs/platform-fastify";
import fastifyStatic from "@fastify/static";
import { AppModule } from "./src/app.module.ts";
import { checkDbHealth, initDb, initV2Schema } from "./src/db.ts";
import { discoverFiles, startAutoSyncV2 } from "./src/sync-v2.ts";

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
  console.log("[db] No database found — initializing; initial sync will run in background...");
  initDb();
} else if (health.status === "incomplete") {
  console.error("[db] ERROR: Database exists but schema is incomplete.");
  console.error(`[db] Missing: ${health.missing.join(", ")}`);
  console.error(
    `[db] To rebuild: rm ${process.env.API_DASHBOARD_DIR ?? "~/.api-dashboard"}/sessions.db`,
  );
  console.error("[db] Then restart the server.");
  process.exit(1);
} else {
  console.log(`[db] OK — ${health.sessions} sessions`);
  initDb();
}

initV2Schema();

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

const PUBLIC_DIR = join(__dirname, "public");
if (existsSync(join(PUBLIC_DIR, "index.html"))) {
  await app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    wildcard: false,
  });
}

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

// SPA fallback: serve index.html for any non-API GET that doesn't match a static file.
const INDEX_HTML = join(PUBLIC_DIR, "index.html");
if (existsSync(INDEX_HTML)) {
  const indexHtml = readFileSync(INDEX_HTML, "utf8");
  const instance = app.getHttpAdapter().getInstance() as any;
  instance.get("/*", (_req: any, reply: any) => {
    reply.type("text/html").send(indexHtml);
  });
}

await app.listen(PORT, "0.0.0.0");
console.log(
  `[server] Session Dashboard (Node) running at http://localhost:${PORT}`,
);

// ── Background services ──────────────────────────────────────────────────────
// Keep the HTTP server responsive first; sync/reconcile can take tens of
// seconds on large local session stores and should not block dev-server startup.
setTimeout(() => {
  void startBackgroundServices();
}, 0);

async function startBackgroundServices() {
  // Background sync
  const initialFiles = discoverFiles();
  startAutoSyncV2(initialFiles);

  // Proxy traffic workers
  {
    const { PROXY_SERVER_PATHS } = await import("./src/proxy-v2/paths.ts");
    const { getDb } = await import("./src/db.ts");

    try {
      const db = getDb();
      getDb().prepare("DELETE FROM proxy_requests WHERE jsonl_file = ?")
        .run(PROXY_SERVER_PATHS.trafficLog);
      const legacyCount = (db.prepare("SELECT COUNT(*) as n FROM proxy_requests WHERE jsonl_file = ''").get() as { n: number }).n;
      const coldIndexed = (db.prepare("SELECT COUNT(*) as n FROM indexed_cold_files").get() as { n: number }).n;
      if (legacyCount > 0 && coldIndexed === 0) {
        console.warn(`[proxy] ${legacyCount} legacy records with empty jsonl_file — body fetch will return file_deleted. Run "npm run migrate:proxy-traffic" to rebuild.`);
      }
    } catch { /* 表可能还未建，忽略 */ }

    const { startRotationWorker } = await import("./src/proxy-v2/log/rotation-worker.ts");
    startRotationWorker();

    const { startCacheSyncWorker } = await import("./src/proxy-v2/log/cache-sync-worker.ts");
    startCacheSyncWorker();

    const { startColdIndexer } = await import("./src/proxy-v2/log/cold-indexer.ts");
    startColdIndexer();

    const { startFilesystemDiffWorker } = await import("./src/proxy-v2/log/filesystem-diff.ts");
    startFilesystemDiffWorker();
  }

  // Proxy v2 boot reconcile + auto-start
  try {
    const { proxyV2Controller } = await import("./src/proxy-v2/controller.ts");
    await proxyV2Controller.reconcileOnBoot();
    if (!process.env.SESSION_DEVTOOLS_NO_PROXY) {
      console.log("[proxy-v2] auto-starting proxy (use --no-proxy to disable)");
      await proxyV2Controller.setTarget("RUNNING");
    }
  } catch (err) {
    console.error("[proxy-v2] boot reconcile fatal:", err);
  }
}

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

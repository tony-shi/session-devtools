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
import { checkDbHealth, initDb } from "./src/db.ts";
import { runSync, startAutoSync } from "./src/sync.ts";

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

// ── Background sync ───────────────────────────────────────────────────────────
startAutoSync();

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

// CORS is handled inside handleRequest (LegacyController) for OPTIONS preflight.

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

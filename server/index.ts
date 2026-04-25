import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { checkDbHealth, initDb } from "./src/db";
import { handleRequest } from "./src/routes";
import { runSync, startAutoSync } from "./src/sync";

// ── Load .env (then .env.local overrides) ────────────────────────────────────
// Bun doesn't stack multiple --env-file args, so we load manually.
// Priority: shell env > .env.local > .env > code defaults

function loadEnvFile(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    // ??= : only set if not already defined by shell environment
    process.env[key] ??= val;
  }
}

const ROOT = join(import.meta.dir, "..");
loadEnvFile(join(ROOT, ".env"));
loadEnvFile(join(ROOT, ".env.local"));

// ── Config ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "5051");
const IS_PROD = process.env.NODE_ENV === "production";
const PUBLIC_DIR = join(import.meta.dir, "public");

// ── DB health check ───────────────────────────────────────────────────────────

const health = checkDbHealth();

if (health.status === "missing") {
  console.log("[db] No database found — initializing and running full sync...");
  initDb();
  const result = await runSync();
  console.log(`[db] Full sync complete: ${result.synced} sessions synced, ${result.errors} errors (${result.duration_ms}ms)`);
} else if (health.status === "incomplete") {
  console.error("[db] ERROR: Database exists but schema is incomplete.");
  console.error(`[db] Missing: ${health.missing.join(", ")}`);
  console.error(`[db] To rebuild: rm ${process.env.API_DASHBOARD_DIR ?? "~/.api-dashboard"}/sessions.db`);
  console.error("[db] Then restart the server.");
  process.exit(1);
} else {
  console.log(`[db] OK — ${health.sessions} sessions, ${health.turns} turns`);
  initDb();
}

// ── Background sync ───────────────────────────────────────────────────────────

startAutoSync();

// ── HTTP server ───────────────────────────────────────────────────────────────

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    const apiResponse = await handleRequest(req);
    if (apiResponse) return apiResponse;

    if (IS_PROD && existsSync(PUBLIC_DIR)) {
      const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
      const fullPath = join(PUBLIC_DIR, filePath);
      if (existsSync(fullPath)) return new Response(Bun.file(fullPath));
      const indexPath = join(PUBLIC_DIR, "index.html");
      if (existsSync(indexPath)) return new Response(Bun.file(indexPath));
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`[server] Session Dashboard running at http://localhost:${PORT}`);

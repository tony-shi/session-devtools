#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DIST_SERVER = join(ROOT, "dist", "server.js");

// ── Arg parsing ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
session-devtools — Local devtools for AI coding sessions

Usage:
  session-devtools [options]

Options:
  --port <n>        Port to listen on (default: 5173)
  --data-dir <path> Data directory (default: ~/.api-dashboard)
  --no-open         Do not open browser on start
  --no-proxy        Do not start the proxy on launch
  --quiet           Suppress server logs
  --help            Show this help
`);
  process.exit(0);
}

function getFlag(flag) {
  const i = args.indexOf(flag);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}

const port = getFlag("--port") ?? process.env.PORT ?? "5173";
const dataDir = getFlag("--data-dir") ?? process.env.API_DASHBOARD_DIR;
const noOpen = args.includes("--no-open");
const noProxy = args.includes("--no-proxy");
const quiet = args.includes("--quiet");

// ── update-notifier (best-effort) ─────────────────────────────────────────────
try {
  const require = createRequire(import.meta.url);
  const { default: updateNotifier } = await import("update-notifier").catch(() => ({ default: null }));
  if (updateNotifier) {
    const pkg = require("../package.json");
    const notifier = updateNotifier({ pkg, updateCheckInterval: 1000 * 60 * 60 * 24 });
    notifier.notify();
  }
} catch { /* optional, never crash */ }

// ── Resolve server entry ──────────────────────────────────────────────────────
if (!existsSync(DIST_SERVER)) {
  console.error("[session-devtools] Compiled server not found at", DIST_SERVER);
  console.error("Run: npm run build");
  process.exit(1);
}

// ── Start server ──────────────────────────────────────────────────────────────
const env = {
  ...process.env,
  PORT: port,
  ...(dataDir ? { API_DASHBOARD_DIR: dataDir } : {}),
  ...(quiet ? { SESSION_DEVTOOLS_QUIET: "1" } : {}),
  ...(noProxy ? { SESSION_DEVTOOLS_NO_PROXY: "1" } : {}),
};

const child = spawn(process.execPath, [DIST_SERVER], {
  env,
  stdio: "inherit",
});

// ── Open browser once server is ready ────────────────────────────────────────
if (!noOpen) {
  const url = `http://localhost:${port}`;
  const { setTimeout: wait } = await import("node:timers/promises");
  let attempts = 0;
  const tryOpen = async () => {
    while (attempts++ < 30) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(500) });
        if (res.ok || res.status < 500) break;
      } catch { /* not ready yet */ }
      await wait(500);
    }
    const { default: open } = await import("open").catch(() => ({ default: null }));
    if (open) await open(url).catch(() => {});
  };
  tryOpen();
}

// ── Forward signals ───────────────────────────────────────────────────────────
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("exit", (code) => process.exit(code ?? 0));

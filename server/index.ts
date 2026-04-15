import { existsSync } from "fs";
import { join } from "path";
import { initDb } from "./src/db";
import { handleRequest } from "./src/routes";
import { startAutoSync } from "./src/sync";

const PORT = parseInt(process.env.PORT ?? "5051");
const IS_PROD = process.env.NODE_ENV === "production";
const PUBLIC_DIR = join(import.meta.dir, "public");

// Initialize DB
initDb();

// Start background sync
startAutoSync();

// Start HTTP server
Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // API routes
    const apiResponse = await handleRequest(req);
    if (apiResponse) return apiResponse;

    // Static files (production mode)
    if (IS_PROD && existsSync(PUBLIC_DIR)) {
      const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
      const fullPath = join(PUBLIC_DIR, filePath);
      if (existsSync(fullPath)) {
        return new Response(Bun.file(fullPath));
      }
      // SPA fallback
      const indexPath = join(PUBLIC_DIR, "index.html");
      if (existsSync(indexPath)) {
        return new Response(Bun.file(indexPath));
      }
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`[server] Session Dashboard running at http://localhost:${PORT}`);

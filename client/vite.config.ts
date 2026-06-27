import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";
import { existsSync, createReadStream, cpSync } from "fs";

// Repo-root demo/ dir: demo/data/** holds the frozen session JSON, mirrored from
// the API URLs by `npm run demo:freeze`. The client demo shim fetches them under
// /demo/data/*. This dir lives outside client/public so it never bloats the
// normal (server-served) production build.
const DEMO_DIR = resolve(__dirname, "..", "demo");
const DEMO_OUT_DIR = resolve(__dirname, "..", "dist-demo");

/**
 * Demo-only Vite plugin: serve /demo/* from the repo demo/ dir in dev, and on
 * build copy demo/data into the output + emit a 404.html SPA fallback (GitHub
 * Pages has no history-router fallback, so a direct deep link / refresh 404s
 * onto 404.html, which is just a copy of index.html that boots the SPA).
 */
function demoDataPlugin(): Plugin {
  return {
    name: "demo-data",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const u = (req.url ?? "").split("?")[0];
        if (!u.startsWith("/demo/")) return next();
        const rel = decodeURIComponent(u.slice("/demo/".length));
        const file = resolve(DEMO_DIR, rel);
        if (!file.startsWith(DEMO_DIR) || !existsSync(file)) {
          res.statusCode = 404;
          res.end("demo asset not found");
          return;
        }
        res.setHeader("content-type", u.endsWith(".json") ? "application/json" : "application/octet-stream");
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      const src = resolve(DEMO_DIR, "data");
      if (existsSync(src)) cpSync(src, resolve(DEMO_OUT_DIR, "demo", "data"), { recursive: true });
      const idx = resolve(DEMO_OUT_DIR, "index.html");
      if (existsSync(idx)) cpSync(idx, resolve(DEMO_OUT_DIR, "404.html"));
    },
  };
}

export default defineConfig(({ mode }) => {
  // Load .env from repo root (one level up from client/)
  const env = loadEnv(mode, resolve(__dirname, ".."), "");
  const SERVER_PORT = env.PORT ?? "5051";
  const CLIENT_PORT = parseInt(env.VITE_PORT ?? "5173");
  const isDemo = mode === "demo";

  return {
    plugins: [react(), tailwindcss(), ...(isDemo ? [demoDataPlugin()] : [])],
    // Custom-domain / root deployment -> base "/". Switch to "/<repo>/" if ever
    // hosting under a GitHub project sub-path (also set BrowserRouter basename).
    base: "/",
    resolve: {
      alias: {
        "@": resolve(__dirname, "src"),
      },
    },
    server: {
      port: CLIENT_PORT,
      strictPort: true,
      open: true,
      proxy: {
        "/api": `http://localhost:${SERVER_PORT}`,
      },
    },
    build: isDemo
      ? { outDir: DEMO_OUT_DIR, emptyOutDir: true }
      : { outDir: "../server/public", emptyOutDir: true },
  };
});

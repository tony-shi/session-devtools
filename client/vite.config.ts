import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

export default defineConfig(({ mode }) => {
  // Load .env from repo root (one level up from client/)
  const env = loadEnv(mode, resolve(__dirname, ".."), "");
  const SERVER_PORT = env.PORT ?? "5051";
  const CLIENT_PORT = parseInt(env.VITE_PORT ?? "5173");

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: CLIENT_PORT,
      open: true,
      proxy: {
        "/api": `http://localhost:${SERVER_PORT}`,
      },
    },
    build: {
      outDir: "../server/public",
      emptyOutDir: true,
    },
  };
});

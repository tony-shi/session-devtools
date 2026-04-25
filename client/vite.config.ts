import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      {
        find: "@session-dashboard/agent-viz/prism.css",
        replacement: resolve(__dirname, "../packages/agent-viz/src/prism/prism.css"),
      },
      {
        find: "@session-dashboard/agent-viz",
        replacement: resolve(__dirname, "../packages/agent-viz/src/index.ts"),
      },
    ],
  },
  server: {
    port: parseInt(process.env.VITE_PORT ?? "5173"),
    open: true,
    proxy: {
      "/api": `http://localhost:${process.env.PORT ?? "5051"}`,
    },
  },
  build: {
    outDir: "../server/public",
    emptyOutDir: true,
  },
});

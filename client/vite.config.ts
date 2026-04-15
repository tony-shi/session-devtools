import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    open: true,
    proxy: {
      "/api": "http://localhost:5051",
    },
  },
  build: {
    outDir: "../server/public",
    emptyOutDir: true,
  },
});

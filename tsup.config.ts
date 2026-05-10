import { defineConfig } from "tsup";
import { swcPlugin } from "esbuild-plugin-swc";

export default defineConfig({
  entry: {
    server: "server/main.ts",
    "proxy-server": "server/src/proxy-v2/server/start.ts",
  },
  outDir: "dist",
  format: ["esm"],
  target: "node22",
  platform: "node",
  bundle: true,
  splitting: false,
  sourcemap: false,
  clean: true,
  // better-sqlite3 ships prebuilt native .node files — cannot be bundled
  external: [
    "better-sqlite3",
    // Keep all other node: builtins external (tsup does this by default for platform:node)
  ],
  esbuildPlugins: [
    swcPlugin({
      jsc: {
        parser: {
          syntax: "typescript",
          decorators: true,
          dynamicImport: true,
        },
        transform: {
          legacyDecorator: true,
          decoratorMetadata: true,
        },
        target: "es2022",
      },
    }),
  ],
  esbuildOptions(options) {
    // Preserve import.meta.dirname/url — needed by runner.ts, main.ts, digest.ts
    options.define = {
      ...options.define,
    };
  },
  // Silence the "use of 'require' may not be supported" warning from dynamic imports
  noExternal: [],
});

// 命令行入口：bun run server/src/proxy/cli/start.ts [--port N]
import { startProxy } from "../server";
import { DEFAULT_LISTEN_PORT } from "../config";
import { ensureCa, caFingerprint } from "../ca";

const idx = process.argv.indexOf("--port");
const port = idx > 0 ? Number(process.argv[idx + 1]) : DEFAULT_LISTEN_PORT;

const ca = await ensureCa();
console.log(`[session-dashboard-proxy] CA ready, SHA-256: ${caFingerprint(ca.certPem)}`);

const handle = await startProxy({
  port,
  onListening: (p) => {
    const upstream = process.env.API_DASHBOARD_PROXY_UPSTREAM ?? "(direct)";
    console.log(`[session-dashboard-proxy] listening on 127.0.0.1:${p}, upstream=${upstream}`);
  },
});

const stop = async (sig: string) => {
  console.log(`[session-dashboard-proxy] received ${sig}, closing...`);
  await handle.close();
  process.exit(0);
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

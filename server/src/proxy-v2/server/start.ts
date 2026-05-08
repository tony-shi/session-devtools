// proxy-v2 server 入口。由 runner.ts 通过 spawn("bun run ...") 启动。
// A5.2: 监听 mitm-hosts.json 变化，热重载白名单（免重启）。
import { watch } from "node:fs";
import { startProxy } from "./index";
import { LISTEN_HOST, getMitmWhitelist, reloadMitmWhitelist } from "../config";
import { PROXY_SERVER_PATHS } from "../paths";
import { ensureCa, caFingerprint } from "../ca";
import { writeTraffic } from "../log/jsonl";
import { FIXED_PORT } from "../port";

const idx = process.argv.indexOf("--port");
const port = idx > 0 ? Number(process.argv[idx + 1]) : FIXED_PORT;

const ca = await ensureCa();
console.log(`[session-dashboard-proxy] CA ready, SHA-256: ${caFingerprint(ca.certPem)}`);

const handle = await startProxy({
  port,
  onListening: (p) => {
    const upstream = process.env.API_DASHBOARD_PROXY_UPSTREAM ?? "(direct)";
    console.log(`[session-dashboard-proxy] listening on ${LISTEN_HOST}:${p}, upstream=${upstream}`);
    console.log(`[session-dashboard-proxy] MITM whitelist: ${[...getMitmWhitelist()].join(", ")}`);
  },
});

// A5.2: 热重载 mitm-hosts.json
try {
  const watcher = watch(PROXY_SERVER_PATHS.home, { persistent: false }, (event, filename) => {
    if (filename !== "mitm-hosts.json") return;
    reloadMitmWhitelist();
    const hosts = [...getMitmWhitelist()];
    console.log(`[session-dashboard-proxy] whitelist 热重载：${hosts.join(", ")}`);
    writeTraffic({
      ts: new Date().toISOString(),
      kind: "event",
      msg: "whitelist_reloaded",
      meta: { hosts },
    });
  });
  process.on("exit", () => watcher.close());
} catch {
  // proxy server 数据目录不存在时 watch 失败，忽略
}

const stop = async (sig: string) => {
  console.log(`[session-dashboard-proxy] received ${sig}, closing...`);
  await handle.close();
  process.exit(0);
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

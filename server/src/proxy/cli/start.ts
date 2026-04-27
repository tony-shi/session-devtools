// 命令行入口：bun run server/src/proxy/cli/start.ts [--port N]
// A5.2: 监听 mitm-hosts.json 变化，热重载白名单（免重启 daemon）。
import { watch } from "node:fs";
import { startProxy } from "../server";
import { DEFAULT_LISTEN_PORT, PATHS, reloadMitmWhitelist, getMitmWhitelist } from "../config";
import { ensureCa, caFingerprint } from "../ca";
import { writeTraffic } from "../log/jsonl";

const idx = process.argv.indexOf("--port");
const port = idx > 0 ? Number(process.argv[idx + 1]) : DEFAULT_LISTEN_PORT;

const ca = await ensureCa();
console.log(`[session-dashboard-proxy] CA ready, SHA-256: ${caFingerprint(ca.certPem)}`);

const handle = await startProxy({
  port,
  onListening: (p) => {
    const upstream = process.env.API_DASHBOARD_PROXY_UPSTREAM ?? "(direct)";
    console.log(`[session-dashboard-proxy] listening on 127.0.0.1:${p}, upstream=${upstream}`);
    console.log(`[session-dashboard-proxy] MITM whitelist: ${[...getMitmWhitelist()].join(", ")}`);
  },
});

// A5.2: 热重载 mitm-hosts.json
// chokidar 在 Node 打包环境里有依赖问题，直接用 node:fs watch（Node 22 稳定）
try {
  // 监听父目录（文件可能不存在时无法直接 watch 文件）
  const watcher = watch(PATHS.home, { persistent: false }, (event, filename) => {
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
  // 进程退出时关闭 watcher
  process.on("exit", () => watcher.close());
} catch {
  // proxy/ 目录不存在时 watch 会失败，忽略（安装器会确保目录存在）
}

const stop = async (sig: string) => {
  console.log(`[session-dashboard-proxy] received ${sig}, closing...`);
  await handle.close();
  process.exit(0);
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

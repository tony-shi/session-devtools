// proxy-v2 路径常量。两组：
//
// V2_PATHS  — 生命周期管理状态（~/.api-devtools/proxy/）
//   active.json   ← 当前会话标记，存在 = 已注入；同时保存还原源
//   history/      ← 每次 start 归档一份原 settings.json，意外删除时供人工兜底
//
// PROXY_SERVER_PATHS — proxy server 的数据目录（~/.api-dashboard/proxy/）
//   CA 证书、traffic.jsonl、mitm-hosts.json 等由 proxy server 进程写入。
//   这里集中声明，外部不再引用旧 proxy/config.ts 的 PATHS。
import { join } from "node:path";
import { homedir } from "node:os";

export const V2_HOME = join(homedir(), ".api-devtools", "proxy");

export const V2_PATHS = {
  home: V2_HOME,
  active: join(V2_HOME, "active.json"),
  history: join(V2_HOME, "history"),
};

const PROXY_SERVER_HOME = join(homedir(), ".api-dashboard", "proxy");
const BACKUPS_HOME = join(homedir(), ".api-dashboard", "backups");

export const PROXY_SERVER_PATHS = {
  home: PROXY_SERVER_HOME,
  caCert: join(PROXY_SERVER_HOME, "ca.pem"),
  caKey: join(PROXY_SERVER_HOME, "ca.key"),
  trafficLog: join(PROXY_SERVER_HOME, "traffic.jsonl"),
  pidFile: join(PROXY_SERVER_HOME, "proxy.pid"),
  portFile: join(PROXY_SERVER_HOME, "proxy.port"),
  desiredStateFile: join(PROXY_SERVER_HOME, "desired-state.json"),
  mitmHostsFile: join(PROXY_SERVER_HOME, "mitm-hosts.json"),
  targetCaDir: join(PROXY_SERVER_HOME, "target-ca"),
  backups: BACKUPS_HOME,
};

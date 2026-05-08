// proxy-v2 模块自有路径，与共享的 ~/.api-dashboard/proxy/（旧 proxy server 的数据目录）分开。
//
// 这里只放生命周期管理相关的状态文件：
//   active.json   ← 当前会话标记，存在 = 已注入；同时保存还原源
//   history/      ← 每次 start 归档一份原 settings.json，意外删除时供人工兜底
//
// CA / traffic.jsonl / mitm-hosts.json 等共享数据仍由 proxy server 写到 ~/.api-dashboard/proxy/。
// 等 proxy server 也搬到 v2 时再统一迁移。
import { join } from "node:path";
import { homedir } from "node:os";

export const V2_HOME = join(homedir(), ".api-devtools", "proxy");

export const V2_PATHS = {
  home: V2_HOME,
  active: join(V2_HOME, "active.json"),
  history: join(V2_HOME, "history"),
};

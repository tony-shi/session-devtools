// 把任意用户/外部输入规整成代理白名单可直接 lookup 的 host 字符串。
//
// 规则：
//   - 任何空白 / 空串 / 非字符串 → null（调用方负责丢弃或报错）
//   - 已含 `http://` / `https://`：直接 URL.parse，取 `host`
//   - 否则补 `http://` 再 parse，取 `host`
//   - host 大小写不敏感，统一小写返回
//   - 解析失败（含纯空 host、含空格、URL ctor 抛错）→ null
//
// 为什么放这里：proxy server 的 MITM 匹配是字符串相等比对（见
// server/src/proxy-v2/server/index.ts 的 CONNECT handler）—— 用户从浏览器
// 复制过来的 `https://my-gw.example.com` 永远不会等于 CONNECT 抽出的
// `my-gw.example.com`，会静默 miss。所有写入 / 读出白名单的路径都应该过
// 这个函数，保持单一规约。
export function normalizeHost(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (!raw) return null;

  const tryParse = (s: string): string | null => {
    try {
      const u = new URL(s);
      // URL ctor 会把 path/query/hash 拆离 host；u.host 保留 `:port`（若非默认）。
      return u.host ? u.host.toLowerCase() : null;
    } catch {
      return null;
    }
  };

  const host = /^https?:\/\//i.test(raw)
    ? tryParse(raw)
    : tryParse(`http://${raw}`);

  return host;
}

// 批量规范化 + 去重 + 剔除内置 `api.anthropic.com`（白名单默认就有）。
// 非法 / 空 / 重复 / 内置 host 都被静默丢弃。
export function normalizeHosts(inputs: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of inputs) {
    const n = normalizeHost(h);
    if (!n || n === "api.anthropic.com" || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

// Session 内导航主干 —— 纯函数，无 React。
//
// 单向数据流契约（硬资产，勿破坏）：点击 handler 一律 navigate(buildSessionPath(...))，
// URL 变化由一个 reconciliation useEffect 解析后写回 state。state 是 URL 的派生，
// 不存在双写，因此不会 URL↔state 互相触发死循环。
//
// session 内导航主干进 URL：path-style，type 编进 segment（turn / call / compact /
// inter-turn / subagent）。linkedPanel / inspector / 列表分页不进 URL（次要 / 对比状态）。
//
// 抽取自原 SessionDetailV2.tsx（行为 / URL 格式零变化）。

export type NavLevel =
  | "session" | "turn" | "inter-turn" | "call"
  | "subagent" | "compact-event" | "compact-call"
  | "background" | "side-call";

// Call 详情面板内部的 tab。不进 URL（tab 选择属于次要 / 对比状态），但属于
// session-detail 的导航词汇，所以和 SessionNav 放一起，供 context / 面板共享。
export type CallTab = "attribution" | "response" | "raw";

export type SessionNav =
  | { level: "session" }
  | { level: "turn"; turnId: number }
  | { level: "call"; turnId: number; callId: number }
  | { level: "inter-turn"; blockIdx: number }
  | { level: "compact-event"; compactIdx: number }
  | { level: "compact-call"; compactIdx: number }
  // sub-agent 镜像主 session 的 turn/call 嵌套（Phase 4）。bare subagent（无 turn）
  // 是 resolve-then-redirect 入口：加载后跳到首 turn，没有"默认 turn 0"魔法。
  | { level: "subagent"; agentFileId: string }
  | { level: "subagent-turn"; agentFileId: string; turnId: number }
  | { level: "subagent-call"; agentFileId: string; turnId: number; callId: number }
  // 后台 side call（标题生成 / quota 探测 / 提示建议 …）—— session 级旁路视图，
  // 不依赖 turns 加载。side-call 详情用 proxyRequestId 寻址（proxy-only）。
  | { level: "background" }
  | { level: "side-call"; proxyRequestId: number };

export function buildSessionPath(sessionId: string, nav: SessionNav): string {
  const base = `/sessions/${encodeURIComponent(sessionId)}`;
  switch (nav.level) {
    case "session":        return base;
    case "turn":           return `${base}/turn/${nav.turnId}`;
    case "call":           return `${base}/turn/${nav.turnId}/call/${nav.callId}`;
    case "inter-turn":     return `${base}/inter-turn/${nav.blockIdx}`;
    case "compact-event":  return `${base}/compact/${nav.compactIdx}`;
    case "compact-call":   return `${base}/compact/${nav.compactIdx}/call`;
    case "subagent":       return `${base}/subagent/${encodeURIComponent(nav.agentFileId)}`;
    case "subagent-turn":  return `${base}/subagent/${encodeURIComponent(nav.agentFileId)}/turn/${nav.turnId}`;
    case "subagent-call":  return `${base}/subagent/${encodeURIComponent(nav.agentFileId)}/turn/${nav.turnId}/call/${nav.callId}`;
    case "background":     return `${base}/background`;
    case "side-call":      return `${base}/side-call/${nav.proxyRequestId}`;
  }
}

// 解析 /sessions/:sessionId 之后的导航段。非法 / 无法识别 → 退到 session 总览。
export function parseSessionNav(pathname: string, sessionId: string): SessionNav {
  const base = `/sessions/${encodeURIComponent(sessionId)}`;
  if (!pathname.startsWith(base)) return { level: "session" };
  const seg = pathname.slice(base.length).split("/").filter(Boolean);
  if (seg.length === 0) return { level: "session" };
  const [a, b, c, d] = seg;
  if (a === "turn" && b != null) {
    const turnId = Number(b);
    if (!Number.isFinite(turnId)) return { level: "session" };
    if (c === "call" && d != null) {
      const callId = Number(d);
      if (Number.isFinite(callId)) return { level: "call", turnId, callId };
    }
    return { level: "turn", turnId };
  }
  if (a === "inter-turn" && b != null) {
    const blockIdx = Number(b);
    return Number.isFinite(blockIdx) ? { level: "inter-turn", blockIdx } : { level: "session" };
  }
  if (a === "compact" && b != null) {
    const compactIdx = Number(b);
    if (!Number.isFinite(compactIdx)) return { level: "session" };
    if (c === "call") return { level: "compact-call", compactIdx };
    return { level: "compact-event", compactIdx };
  }
  if (a === "subagent" && b != null) {
    const agentFileId = decodeURIComponent(b);
    // 后续段：turn/:turnId[/call/:callId]
    if (c === "turn" && d != null) {
      const turnId = Number(d);
      if (!Number.isFinite(turnId)) return { level: "subagent", agentFileId };
      const e = seg[4], f = seg[5];
      if (e === "call" && f != null) {
        const callId = Number(f);
        if (Number.isFinite(callId)) return { level: "subagent-call", agentFileId, turnId, callId };
      }
      return { level: "subagent-turn", agentFileId, turnId };
    }
    return { level: "subagent", agentFileId };
  }
  if (a === "background") return { level: "background" };
  if (a === "side-call" && b != null) {
    const proxyRequestId = Number(b);
    return Number.isFinite(proxyRequestId)
      ? { level: "side-call", proxyRequestId }
      : { level: "session" };
  }
  return { level: "session" };
}

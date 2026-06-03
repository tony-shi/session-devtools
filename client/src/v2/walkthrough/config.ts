import type { ActId } from "./types";

// 每一幕(stage)的 demo 目标 —— 录制时可逐幕固定到最合适的会话/轮/调用。
// 任意字段留空或省略 = 运行时自动推导:
//   sessionId 空 → 取本机第一条 ≥2 次 LLM 调用的会话
//   turnId  空 → 该会话第一个 ≥2 个 call 的 turn
//   callId  空 → 该 turn 的首个 call
export interface StageTarget {
  sessionId?: string;
  turnId?: number;   // turn-io / llm-call 用
  callId?: number;   // llm-call 用
}

// 按幕配置。想固定就填,例如:
//   conversation: { sessionId: "7740ee39-3c2b-..." },
//   "turn-io":    { sessionId: "b2c48fd5-...", turnId: 3 },
//   "llm-call":   { sessionId: "b2c48fd5-...", turnId: 3, callId: 18 },
export const STAGE_CONFIG: Record<ActId, StageTarget> = {
  // Story 1(agent-loop)第一幕的展示会话。换 session 改这里。
  // turn 2 才有工具调用(2 轮),turn-io / llm-call 指向它(与 Remotion fixture 的 --turn 2 一致)。
  conversation: { sessionId: "5e7476cd-c9cf-4029-9256-416a249c61a4" },
  "turn-io": { sessionId: "5e7476cd-c9cf-4029-9256-416a249c61a4", turnId: 2 },
  "llm-call": { sessionId: "5e7476cd-c9cf-4029-9256-416a249c61a4", turnId: 2, callId: 1 },
  recap: {}, // 回顾幕不依赖会话数据(静态结构图)
  // ep2(new):看见真实的 Context —— 复用真实 attribution 面板。
  // 固定到 Story 2 的取材:session 820f368b / turn 1 / call 1
  //   —— 用户一句"图片能不能渲染"的首个 call;实测 ~64.3k 字符,三段 Tools/Messages/System ≈ 64/24/12%。
  "rc-real": { sessionId: "820f368b-ec02-4c59-b0b1-4ec76f0a4439", turnId: 1, callId: 1 },
  // ep2(old):context window —— 复用同一条 demo 会话的某次 call(real 视图取其 attribution)
  "cw-stack": { sessionId: "ea0bc205-0a48-4e67-ad2c-84dec67ad72e", turnId: 1, callId: 1 },
  "cw-real": { sessionId: "ea0bc205-0a48-4e67-ad2c-84dec67ad72e", turnId: 1, callId: 1 },
  // ep3:context diff —— 用 callId 2(有上一条 call 1 可 diff;diffTree 自动取 prev)
  "cd-diff": { sessionId: "ea0bc205-0a48-4e67-ad2c-84dec67ad72e", turnId: 1, callId: 2 },
  "cd-real": { sessionId: "ea0bc205-0a48-4e67-ad2c-84dec67ad72e", turnId: 1, callId: 2 },
  // ep4:tools(context 的关键部分)—— real 步复用真实归因里的 tools 块
  "tools-concept": { sessionId: "ea0bc205-0a48-4e67-ad2c-84dec67ad72e" },
  "tools-real": { sessionId: "ea0bc205-0a48-4e67-ad2c-84dec67ad72e", turnId: 1, callId: 2 },
  // ep5:cache —— 用非首条 call(callId 2),才有 cache_read 命中可讲
  "cache-split": { sessionId: "ea0bc205-0a48-4e67-ad2c-84dec67ad72e", turnId: 1, callId: 2 },
  "cache-real": { sessionId: "ea0bc205-0a48-4e67-ad2c-84dec67ad72e", turnId: 1, callId: 2 },
  // ep6:compaction —— 会话级事件(compactEvents);最好指向一条真发生过 /compact 的会话
  "compact-concept": { sessionId: "ea0bc205-0a48-4e67-ad2c-84dec67ad72e" },
  "compact-real": { sessionId: "ea0bc205-0a48-4e67-ad2c-84dec67ad72e" },
  // ep7:skills / MCP / hooks —— real 步扫描会话里第一个 Skill 调用(无则兜底)
  "extend-concept": { sessionId: "ea0bc205-0a48-4e67-ad2c-84dec67ad72e" },
  "extend-real": { sessionId: "ea0bc205-0a48-4e67-ad2c-84dec67ad72e" },
  // ep8:subagent —— real 步读 dd.subAgents[0](无则兜底)。最好指向一条派过子 agent 的会话
  "subagent-concept": { sessionId: "ea0bc205-0a48-4e67-ad2c-84dec67ad72e" },
  "subagent-real": { sessionId: "ea0bc205-0a48-4e67-ad2c-84dec67ad72e" },
};

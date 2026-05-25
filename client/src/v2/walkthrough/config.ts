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
  conversation: { sessionId: "ea0bc205-0a48-4e67-ad2c-84dec67ad72e" },
  "turn-io": { sessionId: "ea0bc205-0a48-4e67-ad2c-84dec67ad72e", turnId: 1 },
  "llm-call": { sessionId: "ea0bc205-0a48-4e67-ad2c-84dec67ad72e", turnId: 1, callId: 1 },
};

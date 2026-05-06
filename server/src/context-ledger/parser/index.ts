// parser 模块入口
// parseQuery：根据 reqBody 推断 queryKind → 选 template → 切分 → 构建 snapshot

import type { ParsedQuerySnapshot } from "./types";
import type { MatchSlotsInput } from "./matcher";
import { matchSlots } from "./matcher";
import { buildSnapshot } from "./snapshot";
import { CLAUDE_CODE_MAIN_SESSION_TEMPLATE } from "../template/templates/main-session";
import { CLAUDE_CODE_SIDE_QUERY_TEMPLATE } from "../template/templates/side-query";

export type { ParsedQuerySnapshot, SegmentNode, SlotMatch } from "./types";

export interface ParseQueryInput {
  reqBody: MatchSlotsInput["reqBody"];
  proxyFile: string;
  reqHeaders?: Record<string, string>;
  ts?: string;
}

export function parseQuery(input: ParseQueryInput): ParsedQuerySnapshot {
  const { reqBody, proxyFile } = input;
  const ts = input.ts ?? new Date().toISOString();

  // ── 推断 queryKind ──────────────────────────────────────────────────────
  // 简单规则：
  //   tools.length === 0 && messages.length === 1 → side_query
  //   tools.length > 0                           → main_session
  //   其他                                        → unknown
  // WHY：阶段 1 不引入 reqHeaders / system 内容判断；这两条规则就能覆盖
  //      Claude Code 2.x 的绝大多数请求形态。
  const tools = reqBody.tools ?? [];
  const messages = reqBody.messages ?? [];
  let queryKind: ParsedQuerySnapshot["queryKind"];
  if (tools.length === 0 && messages.length === 1) {
    queryKind = "side_query";
  } else if (tools.length > 0) {
    queryKind = "main_session";
  } else {
    queryKind = "unknown";
  }

  // unknown 也需要一个 template 才能跑切分；按 main_session 形态兜底
  const template =
    queryKind === "side_query"
      ? CLAUDE_CODE_SIDE_QUERY_TEMPLATE
      : CLAUDE_CODE_MAIN_SESSION_TEMPLATE;

  const allSlotMatches = matchSlots({ reqBody, template });

  return buildSnapshot({
    allSlotMatches,
    queryKind,
    proxyFile,
    ts,
  });
}

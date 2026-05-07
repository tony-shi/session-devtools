// template/selector.ts
// 根据 wire 请求的先验特征，选择对应的 RequestTemplate 并推断 queryKind。
//
// 职责边界：
//   - 这里的三段规则是"选 template 的先验条件"，属于 template 模块的知识。
//   - parser/ 只负责按给定 template 切分，不做任何分类判断。
//
// 信号来源（均来自 sourcemap 验证）：
//   restored-src/src/utils/betas.ts getMergedBetas({ isAgenticQuery })
//   restored-src/src/services/api/claude.ts getCacheControl / should1hCacheTTL
//   restored-src/src/utils/sideQuery.ts sideQuery()

import type { RequestTemplate } from "./types";
import { CLAUDE_CODE_MAIN_SESSION_TEMPLATE } from "./templates/main-session";
import { CLAUDE_CODE_SIDE_QUERY_TEMPLATE } from "./templates/side-query";

export type QueryKind = "main_session" | "side_query" | "unknown";

export interface TemplateSelection {
  template: RequestTemplate;
  queryKind: QueryKind;
}

/**
 * 根据 wire 特征选择 template 并推断 queryKind。
 *
 * 判断优先级（任一正向信号命中即为 main_session）：
 *
 * 1. anthropic-beta 包含 "claude-code-20250219"
 *    getMergedBetas(isAgenticQuery=true) 强制注入此 beta；
 *    sideQuery() 不走 isAgenticQuery 路径，不含此 beta。
 *
 * 2. tools[] 非空
 *    主会话始终携带完整工具列表；side query 不注册工具。
 *
 * 3. system[].cache_control.ttl === "1h"
 *    should1hCacheTTL() 只对 repl_main_thread* / agent:* querySource 生效；
 *    side query 的 querySource（session_title / compact 等）不在 allowlist 中。
 *
 * 上述三个信号全部缺失 + messages.length === 1 → side_query。
 * 其余情况 → unknown（用 main_session template 兜底切分）。
 */
export function selectTemplate(
  reqBody: {
    system?: Array<{ type: string; text: string; cache_control?: unknown }>;
    tools?: unknown[];
    messages?: unknown[];
  },
  reqHeaders?: Record<string, string>,
): TemplateSelection {
  if (isMainSession(reqBody, reqHeaders)) {
    return { template: CLAUDE_CODE_MAIN_SESSION_TEMPLATE, queryKind: "main_session" };
  }

  const messages = reqBody.messages ?? [];
  if (messages.length === 1) {
    return { template: CLAUDE_CODE_SIDE_QUERY_TEMPLATE, queryKind: "side_query" };
  }

  // 多条 message 但无主会话信号 — 罕见，用 main_session template 兜底
  return { template: CLAUDE_CODE_MAIN_SESSION_TEMPLATE, queryKind: "unknown" };
}

// ─────────────────────────────────────────────────────────────────────────────
// 私有判断函数
// ─────────────────────────────────────────────────────────────────────────────

function isMainSession(
  reqBody: {
    system?: Array<{ type: string; text: string; cache_control?: unknown }>;
    tools?: unknown[];
  },
  reqHeaders?: Record<string, string>,
): boolean {
  return hasCCBeta(reqHeaders) || hasTools(reqBody) || has1hCacheTTL(reqBody);
}

/** anthropic-beta 包含 claude-code-20250219 */
function hasCCBeta(reqHeaders: Record<string, string> | undefined): boolean {
  const beta = reqHeaders?.["anthropic-beta"] ?? reqHeaders?.["Anthropic-Beta"] ?? "";
  return beta.includes("claude-code-20250219");
}

/** tools[] 非空 */
function hasTools(reqBody: { tools?: unknown[] }): boolean {
  return (reqBody.tools?.length ?? 0) > 0;
}

/** system blocks 中任一有 cache_control.ttl === "1h" */
function has1hCacheTTL(reqBody: { system?: Array<{ cache_control?: unknown }> }): boolean {
  return (reqBody.system ?? []).some(
    (blk) => (blk as { cache_control?: { ttl?: string } }).cache_control?.ttl === "1h",
  );
}

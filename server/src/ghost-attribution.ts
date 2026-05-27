// ghost-attribution.ts —— 残差 proxy 的指纹归因（旁路模块）
// =============================================================================
//
// 背景：transcript call 通过 assistant.requestId ↔ proxy_requests.request_id 做
// 1:1 精确匹配（call-detail.ts:findProxyRowForCall）。但 Claude Code 的若干后台
// 调用（生成标题 / quota 探针 / prompt suggestion / agent summary 等）在 JSONL
// 主线里没有 requestId —— 它们在 proxy 层被抓到（带正确 metadata.user_id.session_id），
// 却无法用精确键归属。
//
// 本模块对「残差 proxy」（= session 内未被任何 transcript call 精确认领的 proxy 行）
// 做惰性指纹识别：按 system / user prompt 前缀匹配已知后台调用，前缀（而非全串）
// 匹配以跨 cc_version 鲁棒 —— 与 local-scripts/audit.ts 的 FORK_PROMPT_DETECTORS 同思路。
//
// 惰性：只对残差行解压 reqBody/resBody（readProxyRecord），不改 proxy 入库 schema。

import type { Database } from "better-sqlite3";
import { readProxyRecord } from "./call-detail.ts";
import { parseSseText, reconstructAssistantMessage } from "./sse-response-reconstructor.ts";

export type GhostQueryKind =
  | "generate_session_title"
  | "quota"
  | "prompt_suggestion"
  | "agent_summary"
  | "auto_dream"
  | "extract_memories";

// 前缀检测表。systemPrefix 命中任一 system block 文本；userPrefix 命中末条 user
// 消息的首个 text 块。前缀来源 sourcemap（restored-src/src/...）。
interface GhostDetector {
  kind: GhostQueryKind;
  systemPrefix?: string;
  userPrefix?: string;
}

// classifier_version：检测表/抽取逻辑变更时 +1，触发已扫描 session 的重扫。
export const CLASSIFIER_VERSION = 1;

export const DETECTORS: GhostDetector[] = [
  // restored-src/src/utils/sessionTitle.ts SESSION_TITLE_PROMPT
  { kind: "generate_session_title", systemPrefix: "Generate a concise, sentence-case title" },
  // restored-src/src/services/PromptSuggestion/promptSuggestion.ts
  { kind: "prompt_suggestion", userPrefix: "[SUGGESTION MODE: Suggest what the user might naturally type" },
  // restored-src/src/services/AgentSummary/agentSummary.ts
  { kind: "agent_summary", userPrefix: "Describe your most recent action in 3-5 words using present tense" },
  // restored-src/src/services/autoDream/consolidationPrompt.ts
  { kind: "auto_dream", userPrefix: "# Dream: Memory Consolidation" },
  // restored-src/src/services/extractMemories/prompts.ts
  { kind: "extract_memories", userPrefix: "You are now acting as the memory extraction subagent" },
  // connectivity/quota probe: single user message with literal content "quota", max_tokens=1
  { kind: "quota", userPrefix: "quota" },
];

export interface ClassifiedGhost {
  proxyRequestId: number;
  /** proxy 行的 request_id（共享 Anthropic/synthetic id），供调用方按 request_id 建键。 */
  requestId: string | null;
  kind: GhostQueryKind;
  startedAt: string | null;
  model: string | null;
  /** proxy 行已 denormalize 的 token 计数（无需解压）。 */
  inputTokens: number | null;
  outputTokens: number | null;
  /** 仅 generate_session_title：模型返回的标题文本（已解 JSON 取 .title）。 */
  title?: string;
}

interface ProxyRow {
  id: number;
  request_id: string | null;
  jsonl_file: string;
  jsonl_byte_offset: number;
  started_at: string | null;
  is_stream: number;
  model: string | null;
  res_input_tokens: number | null;
  res_output_tokens: number | null;
}

function systemBlockTexts(reqBody: Record<string, unknown>): string[] {
  const sys = reqBody.system;
  if (typeof sys === "string") return [sys];
  if (Array.isArray(sys)) {
    return sys
      .map((b) =>
        b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
          ? (b as { text: string }).text
          : "",
      )
      .filter(Boolean);
  }
  return [];
}

function lastUserText(reqBody: Record<string, unknown>): string | null {
  const msgs = reqBody.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) return null;
  const last = msgs[msgs.length - 1] as { role?: unknown; content?: unknown };
  if (last?.role !== "user") return null;
  if (typeof last.content === "string") return last.content;
  if (Array.isArray(last.content)) {
    for (const b of last.content as Array<{ type?: unknown; text?: unknown }>) {
      if (b?.type === "text" && typeof b?.text === "string") return b.text;
    }
  }
  return null;
}

export function classifyReqBody(reqBody: Record<string, unknown>): GhostQueryKind | null {
  const sysTexts = systemBlockTexts(reqBody);
  const userText = lastUserText(reqBody);
  for (const d of DETECTORS) {
    if (d.systemPrefix && sysTexts.some((t) => t.startsWith(d.systemPrefix!))) return d.kind;
    if (d.userPrefix && userText != null && userText.startsWith(d.userPrefix)) return d.kind;
  }
  return null;
}

// 从 resBody 取出标题文本。响应是 {"title": "..."} 的 JSON（被模型当文本输出），
// 故先抽 assistant text，再 JSON.parse 取 .title；非 JSON 时退回 trim 后的原文。
export function extractTitle(rec: Record<string, unknown>, isStream: boolean): string | undefined {
  const resBody = typeof rec.resBody === "string" ? rec.resBody : "";
  if (!resBody) return undefined;
  let text = "";
  if (isStream) {
    const r = reconstructAssistantMessage(parseSseText(resBody));
    if (!r.message) return undefined;
    text = r.message.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");
  } else {
    try {
      const parsed = JSON.parse(resBody) as { content?: Array<{ type?: string; text?: string }> };
      text = (parsed.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
    } catch {
      return undefined;
    }
  }
  text = text.trim();
  if (!text) return undefined;
  try {
    const j = JSON.parse(text) as { title?: unknown };
    if (typeof j.title === "string") return j.title.trim();
  } catch {
    /* 非 JSON —— 用原文 */
  }
  return text;
}

// 对 session 内残差 proxy 做指纹分类。excludeRequestIds = 已被 transcript call
// 精确认领的 request_id 集（由 controller 从 drilldown 的 apiRequestId 提供）。
export async function classifyResidualProxies(
  db: Database,
  sessionId: string,
  excludeRequestIds: ReadonlySet<string>,
): Promise<ClassifiedGhost[]> {
  const rows = db
    .prepare(
      `SELECT id, request_id, jsonl_file, jsonl_byte_offset, started_at, is_stream,
              model, res_input_tokens, res_output_tokens
       FROM proxy_requests
       WHERE session_id = ?
       ORDER BY started_at`,
    )
    .all(sessionId) as ProxyRow[];

  // [perf] 本地开发打点：残差解压是这里唯一的重活（readProxyRecord 每次从 gz 头
  // 流式跳到 byte offset）。统计 残差数 / 解压次数 / 解压耗时 / 总耗时，定位瓶颈。
  const tStart = Date.now();
  let residualCount = 0;
  let readMs = 0;

  const out: ClassifiedGhost[] = [];
  for (const r of rows) {
    if (r.request_id && excludeRequestIds.has(r.request_id)) continue; // 已被精确认领
    residualCount++;
    const tRead = Date.now();
    const rec = await readProxyRecord(r.jsonl_file, r.jsonl_byte_offset);
    readMs += Date.now() - tRead;
    if (!rec) continue;
    let reqBody: Record<string, unknown>;
    try {
      reqBody = JSON.parse(typeof rec.reqBody === "string" ? rec.reqBody : "{}") as Record<string, unknown>;
    } catch {
      continue;
    }
    const kind = classifyReqBody(reqBody);
    if (!kind) continue;
    const ghost: ClassifiedGhost = {
      proxyRequestId: r.id,
      requestId: r.request_id,
      kind,
      startedAt: r.started_at,
      model: r.model,
      inputTokens: r.res_input_tokens,
      outputTokens: r.res_output_tokens,
    };
    if (kind === "generate_session_title") {
      const title = extractTitle(rec, r.is_stream === 1);
      if (title) ghost.title = title;
    }
    out.push(ghost);
  }

  console.log(
    `[ghost] session=${sessionId.slice(0, 8)} proxyRows=${rows.length} ` +
    `residual=${residualCount} reads=${residualCount} readMs=${readMs}ms ` +
    `total=${Date.now() - tStart}ms ghosts=${out.length}`,
  );
  return out;
}

export interface AiTitleProxyMatch {
  title: string;
  proxyRequestId: number;
  startedAt: string | null;
}

// 专给 ai-title 跳转用：从 side_call_facts 派生索引读出本 session 所有
// generate_session_title 的 (title → proxyRequestId)，按 started_at 升序（供同名重算时
// 按顺序兜底匹配）。不再解压 proxy body —— 索引由 cold-indexer enricher + 惰性回扫填充
// （见 server/src/side-call/enricher.ts）。
export function resolveAiTitleProxies(
  db: Database,
  sessionId: string,
): AiTitleProxyMatch[] {
  const rows = db
    .prepare(
      `SELECT p.id AS proxyRequestId, f.link_fact AS title, p.started_at AS startedAt
       FROM side_call_facts f
       JOIN proxy_requests p ON p.session_id = f.session_id AND p.request_id = f.request_id
       WHERE f.session_id = ?
         AND f.query_kind = 'generate_session_title'
         AND f.link_fact IS NOT NULL
       ORDER BY p.started_at`,
    )
    .all(sessionId) as { proxyRequestId: number; title: string; startedAt: string | null }[];
  return rows.map((r) => ({ title: r.title, proxyRequestId: r.proxyRequestId, startedAt: r.startedAt }));
}

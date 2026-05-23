// compact-proxy-matcher.ts
// ──────────────────────────────────────────────────────────────────────────────
// 把 JSONL 端的 compact_boundary 和 proxy_requests 表里那次 summarization LLM
// call 做"业务上不误判"级别的精确归因。
//
// 算法分三层（详见 docs/inner/claude-take.md 的机制说明）：
//
//   1. SQL pre-filter ——— 1 SQL/session（不是 1 SQL/boundary），用所有 boundary
//      合并出的"宽松时间 + 时长窗口"和 error_class IS NULL / output_tokens > 100
//      把候选缩小到几条到几十条。
//
//   2. Body fingerprint —— 读 proxy traffic.jsonl 的 reqBody，看 messages 最后
//      一条 user.text 是否以 NO_TOOLS_PREAMBLE 起头（claude-code 2.1.88 的 compact
//      路径硬编码常量，见 services/compact/prompt.ts:19-26）。这一步把候选过滤到
//      "肯定是一次 compact summarization call"的集合。读 body 按 jsonl_file 分桶 +
//      offset 升序流式读，每个 .gz 只 open 一次。
//
//   3. 跨校验对齐 ——— 用每条 boundary 的 ts + durationMs 在 compact 候选里找
//      tolerance 内的唯一 row。重复（多个候选都满足）或缺失（0 候选满足）一律
//      置 null，绝不静默选最近的一条 —— 满足"不静默误判"的契约。
//
// 输出是双向归因结构（forward + reverse + orphan），方便后续 reverse-attribution
// UI 直接消费（比如 proxy 流量视图想标注"这条是 compact"时不需要重新解析 body）。

import type { Database } from "better-sqlite3";

import { readProxyRecord } from "./call-detail.ts";
import type { CompactProxyInfo } from "./session-drilldown-types.ts";

// ─── Public types ────────────────────────────────────────────────────────────

/** caller 准备好的、每条 boundary 的关键证据。`index` 是 caller 自己的稳定 id，
 *  仅用于把结果对回去——这里不要求是 CompactEvent.index，可以是任意 unique number。 */
export interface CompactBoundaryEvidence {
  index: number;
  /** boundary.timestamp 解析成毫秒后的值（caller 算好传进来，省得 matcher 二次解析） */
  boundaryTsMs: number;
  /** boundary.compactMetadata.durationMs；缺失/无效时传 0，会被自动跳过匹配 */
  expectedDurMs: number;
}

export interface CompactProxyMatch {
  /** boundary.index → proxy 信息（确认匹配）或 null（候选不唯一 / 候选为空 / 体检不过） */
  byBoundaryIndex: Map<number, CompactProxyInfo | null>;
  /** proxy_requests.id → boundary.index（仅对成功匹配的对子建立反向索引） */
  byProxyRowId: Map<number, number>;
  /** body fingerprint 命中 compact 但没归属到任何 boundary 的 proxy 行 id。
   *  典型来源：失败/中断后重试（一条 boundary 对两条 proxy 行）、CLI 升级后
   *  没写 boundary 的版本等异常路径。caller 可以选择 log / 展示 / 忽略。 */
  orphanCompactRowIds: number[];
}

// ─── Body fingerprint ────────────────────────────────────────────────────────

// 来自 claude-code 2.1.88 services/compact/prompt.ts:19-26 —— compact / partialCompact
// 共用的 NO_TOOLS_PREAMBLE 前缀。三条 compact 路径（getCompactPrompt /
// getPartialCompactPrompt 的 from/up_to）都强制以这 4 行起头，且这段字面量
// 在普通用户输入 / tool result / sub-agent prompt 里**不会**自然出现 ——
// 见 docs/inner/claude-take.md 的误判风险分析。
const COMPACT_PROMPT_FINGERPRINT =
  "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.";

/** 纯函数：给定一条 proxy 行的 reqBody（已 JSON.parse 的对象），判定是不是
 *  claude-code 的 compact summarization call。reverse 归因（proxy 流量视图）
 *  也直接用这个判定，与本模块的批量匹配器共享同一份指纹定义。 */
export function isCompactRequestBody(reqBody: unknown): boolean {
  if (!reqBody || typeof reqBody !== "object") return false;
  const body = reqBody as { messages?: unknown };
  if (!Array.isArray(body.messages) || body.messages.length === 0) return false;
  const lastMsg = body.messages[body.messages.length - 1] as {
    role?: unknown;
    content?: unknown;
  };
  if (lastMsg?.role !== "user") return false;

  // content 可以是 string（早期格式）也可以是 block 数组。两种都要扫到。
  const text = extractLastUserText(lastMsg.content);
  if (!text) return false;
  // startsWith 比 includes 更严格 —— compact 路径用的是 prompt 起头，
  // 用户碰巧贴了这段进 tool_result 或对话中间不会触发。
  return text.startsWith(COMPACT_PROMPT_FINGERPRINT);
}

function extractLastUserText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text"
    ) {
      const t = (block as { text?: unknown }).text;
      if (typeof t === "string") return t;
    }
  }
  return "";
}

// ─── Tolerances ──────────────────────────────────────────────────────────────

// 跨校验放宽到 5s —— 实测同 session 内 boundary.ts 与 proxy.started_at + duration
// 误差 < 20ms（gzip 解码 + JSONL flush 顺延），5s 已远高于真实漂移上限，
// 同时还够小到不会跨过相邻 compact（最短间隔通常 > 60s）。
const MATCH_TOLERANCE_MS = 5_000;

// SQL pre-filter 用更宽的窗口（±30s / 时长 ±5s）—— 只是为了把候选缩小到
// 几十条以内，跨校验那一步会用更严的 tolerance 把假候选拒掉。
const SQL_TIME_WINDOW_MS = 30_000;
const SQL_DUR_WINDOW_MS = 5_000;

// ─── Batch matcher ───────────────────────────────────────────────────────────

interface CandidateRow {
  id: number;
  jsonl_file: string;
  jsonl_byte_offset: number;
  started_at: string;
  duration_ms: number;
  model: string | null;
  request_id: string | null;
  res_input_tokens: number | null;
  res_output_tokens: number | null;
  res_cache_read_tokens: number | null;
  // 解析后的 completion 时刻（started_at + duration_ms，毫秒）
  completedTsMs: number;
  // body fingerprint 结果（read pass 之后填）
  isCompact?: boolean;
}

/** 单 session 入口：把这个 session 内所有 compact_boundary 与 proxy_requests
 *  做精确匹配。0 boundary 时不发 SQL、不读 body。 */
export async function matchCompactCallsForSession(
  db: Database,
  sessionId: string,
  boundaries: CompactBoundaryEvidence[],
): Promise<CompactProxyMatch> {
  const empty: CompactProxyMatch = {
    byBoundaryIndex: new Map(),
    byProxyRowId: new Map(),
    orphanCompactRowIds: [],
  };
  if (boundaries.length === 0) return empty;

  // 计算所有 boundary 合并出的 SQL 窗口。无效 boundary（durationMs<=0 / ts NaN）
  // 不参与计算 ——它们会在最后 align 阶段被置 null，但不该污染候选窗口。
  const validBoundaries = boundaries.filter(
    (b) => b.expectedDurMs > 0 && Number.isFinite(b.boundaryTsMs),
  );
  if (validBoundaries.length === 0) {
    // 所有 boundary 都无效；占位返回 null 列表，保证 caller 拿到完整 map
    for (const b of boundaries) empty.byBoundaryIndex.set(b.index, null);
    return empty;
  }

  const minDur = Math.min(...validBoundaries.map((b) => b.expectedDurMs)) - SQL_DUR_WINDOW_MS;
  const maxDur = Math.max(...validBoundaries.map((b) => b.expectedDurMs)) + SQL_DUR_WINDOW_MS;
  const minTs = Math.min(...validBoundaries.map((b) => b.boundaryTsMs)) - SQL_TIME_WINDOW_MS;
  const maxTs = Math.max(...validBoundaries.map((b) => b.boundaryTsMs)) + SQL_TIME_WINDOW_MS;

  // ── 1. SQL pre-filter ──────────────────────────────────────────────────
  // strftime 的 ms 表达式跟 session-drilldown-parser.ts 旧实现一致 ——
  // SQLite 没有 epoch_ms 内置函数，要用 strftime('%s') * 1000 + ms 部分凑。
  let rows: CandidateRow[];
  try {
    const stmt = db.prepare(`
      SELECT id, jsonl_file, jsonl_byte_offset, started_at, duration_ms,
             model, request_id,
             res_input_tokens, res_output_tokens, res_cache_read_tokens
      FROM proxy_requests
      WHERE session_id = ?
        AND duration_ms IS NOT NULL
        AND duration_ms BETWEEN ? AND ?
        AND error_class IS NULL
        AND res_output_tokens > 100
        AND (strftime('%s', started_at) * 1000.0
             + (strftime('%f', started_at) * 1000 - strftime('%S', started_at) * 1000)
             + duration_ms) BETWEEN ? AND ?
      ORDER BY started_at ASC
    `);
    const raw = stmt.all(sessionId, minDur, maxDur, minTs, maxTs) as Array<
      Omit<CandidateRow, "completedTsMs" | "isCompact">
    >;
    rows = raw.map((r) => ({
      ...r,
      completedTsMs: Date.parse(r.started_at) + r.duration_ms,
    }));
  } catch {
    // SQL 失败兜底 —— 等价于无候选，所有 boundary 置 null
    for (const b of boundaries) empty.byBoundaryIndex.set(b.index, null);
    return empty;
  }

  if (rows.length === 0) {
    for (const b of boundaries) empty.byBoundaryIndex.set(b.index, null);
    return empty;
  }

  // ── 2. Body fingerprint ─────────────────────────────────────────────────
  // 按 jsonl_file 分桶，每桶内按 offset 升序读 —— readProxyRecord 内部
  // 对 .gz 每次都是 open + 解码到 offset 一次（O(offset)），不分桶顺序读
  // 会重复解码同一份压缩流。这里强制相同文件挨着读，让 OS page cache 起作用。
  rows.sort((a, b) => {
    if (a.jsonl_file !== b.jsonl_file) return a.jsonl_file < b.jsonl_file ? -1 : 1;
    return a.jsonl_byte_offset - b.jsonl_byte_offset;
  });

  await Promise.all(
    rows.map(async (row) => {
      const rec = await readProxyRecord(row.jsonl_file, row.jsonl_byte_offset);
      if (!rec) return;
      const reqBody = rec.reqBody;
      if (typeof reqBody !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(reqBody);
      } catch {
        return;
      }
      row.isCompact = isCompactRequestBody(parsed);
    }),
  );

  // restore order to started_at ASC for alignment
  rows.sort((a, b) => a.completedTsMs - b.completedTsMs);

  const compactRows = rows.filter((r) => r.isCompact === true);

  // ── 3. Align boundaries → compact rows ──────────────────────────────────
  const byBoundaryIndex = new Map<number, CompactProxyInfo | null>();
  const byProxyRowId = new Map<number, number>();
  const usedRowIds = new Set<number>();

  // 按 boundary ts 升序处理，让"k-th boundary ↔ k-th compact row"的自然
  // 顺序成立（同 session 内 compact 一定按时间发生）。多次 compact 之间
  // 间隔通常 > 60s，远大于 MATCH_TOLERANCE_MS，所以 tolerance 内的候选
  // 几乎总是唯一一条。
  const sortedBoundaries = [...boundaries].sort((a, b) => a.boundaryTsMs - b.boundaryTsMs);

  for (const b of sortedBoundaries) {
    if (b.expectedDurMs <= 0 || !Number.isFinite(b.boundaryTsMs)) {
      byBoundaryIndex.set(b.index, null);
      continue;
    }
    const eligible = compactRows.filter(
      (r) =>
        !usedRowIds.has(r.id) &&
        Math.abs(r.completedTsMs - b.boundaryTsMs) <= MATCH_TOLERANCE_MS &&
        Math.abs(r.duration_ms - b.expectedDurMs) <= MATCH_TOLERANCE_MS,
    );
    if (eligible.length !== 1) {
      // 0 candidates → 缺失；>1 candidates → 歧义。两种都按契约拒绝，置 null。
      byBoundaryIndex.set(b.index, null);
      continue;
    }
    const row = eligible[0];
    usedRowIds.add(row.id);
    byBoundaryIndex.set(b.index, toCompactProxyInfo(row));
    byProxyRowId.set(row.id, b.index);
  }

  // 没在结果里出现的 boundary（理论上不会，validBoundaries 已经覆盖）补 null
  for (const b of boundaries) {
    if (!byBoundaryIndex.has(b.index)) byBoundaryIndex.set(b.index, null);
  }

  const orphanCompactRowIds = compactRows
    .filter((r) => !usedRowIds.has(r.id))
    .map((r) => r.id);

  return { byBoundaryIndex, byProxyRowId, orphanCompactRowIds };
}

function toCompactProxyInfo(row: CandidateRow): CompactProxyInfo {
  return {
    proxyRequestId: row.id,
    requestId: row.request_id,
    model: row.model ?? "",
    inputTokens: row.res_input_tokens ?? 0,
    outputTokens: row.res_output_tokens ?? 0,
    cacheReadTokens: row.res_cache_read_tokens ?? 0,
    durationMs: row.duration_ms,
    startedAt: row.started_at,
  };
}

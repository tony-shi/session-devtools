// reconstruct2 / jsonl / event-types
//
// 第一层（Mutation View）独立类型集合。命名向 docs/draft/context/reconstruct-refine.md 看齐。
// 与旧 reconstruction 模块保持隔离：本文件不导出旧 ContextSegment / ExpectedQueryContext，
// 上层 audit 不应通过本文件回填旧 reconstructor。
//
// 设计前提：
//   - JSONL 是唯一事实源（不读 proxy dump）
//   - 每条 JSONL 行都要有 disposition 与 reasonCode，不允许"静默丢弃"
//   - sidechain（subagent）路由独立，不进父会话 frame
//
// 字段语义参考：
//   - restored-src/src/types/logs.ts                JSONL message shape
//   - restored-src/src/utils/messages.ts            isMeta / isApiErrorMessage / isCompactSummary
//   - restored-src/src/services/compact/compact.ts  compact summary 形状

import type {
  ContextMutation,
  HarnessRuntimeSnapshot,
  SegmentCategory,
} from "../../types";

// ─────────────────────────────────────────────────────────────────────────────
// JSONL line ledger
// ─────────────────────────────────────────────────────────────────────────────

/** 一条 JSONL 行经过第一层处理后的去向。
 *
 * 与旧 unknownLines 的区别：旧实现只把"无法识别"的行收集起来，正常行没有显式去向。
 * 新口径要求每行都有 disposition——不是"已处理"就行，而是要回答"它有没有进入下一次
 * LLM call 的上下文，以及为什么"。
 *
 * 取值表（与 docs/draft/context/reconstruct-refine.md 一致）：
 *   included_in_frame      该行生成的 mutation 至少进入了一个 ContextFrame
 *   parsed_not_materialized 已解析，但本层不直接决定是否 materialize（compact、部分 attachment）
 *   runtime_fact_only      只更新 runtime snapshot（permission-mode、cwd/version）
 *   filtered_noise         明确不进入 request context（billing noise、hook summary）
 *   sidechain_routed       已路由到 subagent，不进父 frame
 *   dropped_retry_preempted 因 retry 对齐被丢弃
 *   deferred_unimplemented 已识别语义但本期未实现（prior session、compaction replacement）
 *   unknown_schema         JSON 可解析但 schema 未识别
 *   parse_error            JSONL 行无法解析
 */
export type JsonlLineDisposition =
  | "included_in_frame"
  | "parsed_not_materialized"
  | "runtime_fact_only"
  | "filtered_noise"
  | "sidechain_routed"
  | "dropped_retry_preempted"
  | "deferred_unimplemented"
  | "unknown_schema"
  | "parse_error";

/** 一条 JSONL 行的 ledger 记录。
 *
 * 注意：mutationIds / frameIds 都是数组——同一条 mutation 可参与多个 frame（context
 * 累积），同一行也可能拆出多条 mutation（assistant 多 block、user content array）。
 */
export interface JsonlLineLedgerEntry {
  /** 1-based 行号 */
  line: number;
  /** JSONL record.uuid（如有） */
  uuid?: string;
  /** JSONL record.type（user / assistant / system / attachment / permission-mode 等） */
  type?: string;
  /** JSONL record.subtype（system 行才有） */
  subtype?: string;
  /** attachment.type（attachment 行才有，如 skill_listing / file / queued_command） */
  attachmentType?: string;
  /** 该行生成的 event id 列表 */
  eventIds: string[];
  /** 该行生成的 mutation id 列表 */
  mutationIds: string[];
  /** 该行 mutation 参与的 frame id 列表（累积上下文，可能多个） */
  frameIds: string[];
  disposition: JsonlLineDisposition;
  /** 稳定的去向理由，便于 audit 聚合（不是 UI 文本） */
  reasonCode: string;
  /** 若 mutation 已确定 category，写在这里方便 UI 列展示 */
  category?: SegmentCategory;
  /** JSONL 文件路径（多文件场景） */
  sourcePath?: string;
  /** 原始行的简短预览（前 240 字符），仅用于 audit UI 展示 */
  preview?: string;
  /** 路由元信息（subagentId、isMeta、isApiErrorMessage 等） */
  metadata?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// JSONL event
// ─────────────────────────────────────────────────────────────────────────────

/** JSONL 行解码后的中间事件。比 ContextMutation 更接近 raw schema：
 * 一条 user 行包含多个 content block 时也只产出一个 event；mutation 拆分发生在第二步。
 *
 * eventKind 命名严格对应 JSONL.type/subtype，不引入"语义化"前缀，避免 Claude Code
 * schema 演进时被迫重写。
 */
export type ClaudeJsonlEventKind =
  | "user"
  | "assistant"
  | "attachment"
  | "system"
  | "permission_mode"
  | "compact_summary"
  | "harness_state"     // worktree-state / file-history-snapshot / last-prompt 等
  | "unknown";

/** 从 JSONL 一条 record 解码出的事件，承载 raw record + 路由信息。 */
export interface ClaudeJsonlEvent {
  id: string;
  line: number;
  kind: ClaudeJsonlEventKind;
  /** 原始 type（保留 schema 漂移可见） */
  rawType?: string;
  rawSubtype?: string;
  uuid?: string;
  parentUuid?: string;
  timestamp?: string;
  promptId?: string;
  /** 是否 sidechain（subagent transcript） */
  isSidechain: boolean;
  /** subagent agentId（仅 sidechain=true 时有意义） */
  agentId?: string;
  /** harness 注入的 system-reminder / caveat user message */
  isMeta: boolean;
  /** harness 合成的"展示用" assistant 错误行；proxy 看不到 */
  isApiErrorMessage: boolean;
  /** Claude Code 2.x compact summary 标记 */
  isCompactSummary: boolean;
  /** 解析后但语义未触达 mutation 的字段（e.g. attachment.type、system.subtype） */
  metadata: Record<string, unknown>;
  /** 原始行字符串切片，限长 4096——用于 ledger preview 与未知 schema 调试 */
  rawPreview: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Frame
// ─────────────────────────────────────────────────────────────────────────────

/** ContextFrame：某次 LLM call 边界前已积累的上下文事实集合。
 *
 * 第一阶段 boundary 识别策略（仅依赖 JSONL，无 proxy 时间戳）：
 *   - 主会话 main_session：每条 assistant 行视作一次 LLM call 的"完成事件"，对应
 *     boundary = 该 assistant 行之前的所有相关 mutation（含 user 输入与 attachment）。
 *     这与 proxy 看到的"call → assistant response"语义对齐。
 *   - sidechain：单独建 frame 链，按 subagent agentId 分组，本期 frame builder 不
 *     深入 subagent 内部边界（仅记录路由）。
 *   - boundaryConfidence 显式标记：assistant 行触发 → confirmed；其他启发式 → inferred。
 */
export type ContextFrameQueryKind = "main_session" | "side_query" | "unknown";

export type ContextFrameBoundaryConfidence = "confirmed" | "inferred";

export interface ContextFrameBoundary {
  /** 触发 frame 切片的事件 id（通常是 assistant 行）。 */
  upToEventId: string;
  /** 触发 frame 切片的 mutation id；某些 frame 可能仅由 event 触发，无对应 mutation。 */
  upToMutationId?: string;
  /** boundary 时间戳（assistant timestamp） */
  timestamp?: string;
  confidence: ContextFrameBoundaryConfidence;
}

export interface ContextFrame {
  frameId: string;
  /** 触发该 frame 的 event id（通常是 assistant 行） */
  callEventId: string;
  sessionId: string;
  /** 在本会话主链中的顺序号（从 1 开始） */
  queryIndex: number;
  queryKind: ContextFrameQueryKind;
  /** 参与该 frame 的 mutation id（accumulative，与之前 frame 重叠） */
  mutationIds: string[];
  /** 参与该 frame 的 event id（accumulative） */
  eventIds: string[];
  /** 触发 frame 时的 runtime snapshot 切片（保守起见每次浅拷贝） */
  runtimeSnapshot: HarnessRuntimeSnapshot;
  boundary: ContextFrameBoundary;
  /** sidechain frame 时，subagent agentId */
  subagentId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mutation View
// ─────────────────────────────────────────────────────────────────────────────

/** 第一层的产物：把 JSONL 一次性解析成"事实账本"。
 *
 * mutations / sidechainMutations 与旧 jsonl-mutation-parser 输出兼容（直接复用类型）。
 * 新增 events、frames、lineLedger 是第一阶段的核心审计字段。
 */
export interface MutationView {
  sessionId: string;
  jsonlFile: string;
  events: ClaudeJsonlEvent[];
  mutations: ContextMutation[];
  sidechainMutations: ContextMutation[];
  frames: ContextFrame[];
  lineLedger: JsonlLineLedgerEntry[];
  runtimeSnapshot: HarnessRuntimeSnapshot;
  /** 推断模型名（与旧 parser 同口径） */
  inferredModel?: string;
  /** 第一层无法解释的"诊断点"（不进 frame、不进 ledger 的元信息） */
  diagnostics: MutationDiagnostic[];
}

/** 第一层的诊断点：用于审计层面回答"为什么我们的事实账本不完美"。
 * 注意：行级问题应该写进 lineLedger.disposition；diagnostics 留给"跨行"问题。
 */
export interface MutationDiagnostic {
  code: string;
  message: string;
  severity: "info" | "warning";
  metadata?: Record<string, unknown>;
}

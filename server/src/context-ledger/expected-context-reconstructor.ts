// Expected Context Reconstructor
// 输入：ContextMutation[] + query boundary metadata + harness rule config
// 输出：ExpectedQueryContext
//
// 设计原则（来自 docs/draft/context/context-reconstruction-harness.md 与
//          docs/contract/summary.md）：
//   1. 不读取 proxy-request.json；不依赖 ProxyQuerySnapshot。
//   2. 不把 unmatched proxy segment 反写回 expected。
//   3. 缺失规则（system_prompt / tools_schema 等）显式记录为
//      unimplementedRules，而不是静默忽略。
//
// 已实现规则（按优先级）：
//   R1 base_append              user/assistant/tool_use/tool_result append
//   R2 merge_assistant_tool_uses 同一 messageId 的多个 tool_use 标记为同一 logicalMessage
//   R3 merge_user_tool_results   连续 tool_result 标记为同一 logicalMessage
//   R4 inject_skill_listing     attachment.skill_listing 注入为 user 段
//   R5 inject_local_command     <local-command-* / <bash-* 注入为 user 段
//   R6 filter_known_noise       hook_event / billing_noise / type=noise 不进 expected segments
//   R7 api_error_retry_alignment 失败 attempt 的 user 输入组合在 retry 成功后被丢弃
//   R8 filter_synthetic_api_error harness 合成的 isApiErrorMessage assistant 行（proxy 里没有）
//
// 暂未实现（会在 metadata.unimplementedRules 显式标记）：
//   U1 system_prompt_injection      system[] 来自 harness identity / CLAUDE.md / memory_fs
//   U2 tools_schema_injection       tools[] 来自 harness 可用工具集合
//   U3 system_reminder_per_turn     每个 user turn 头部的 <system-reminder>
//   U4 prior_session_history        --resume / continue 时携带的历史会话片段
//   U5 compaction_replacement       compact 摘要替换早期 mutation 的语义
//
// 这些 U* 缺失意味着真实 proxy 中以下 segment 会成为 unmatched proxy segment：
//   - system[0..2] 全部 system_prompt / billing_noise
//   - tools[*] 全部 tools_schema
//   - messages[].content[*] 中的 <system-reminder> / prior_session_history 字符串
//   - compact 摘要替换前的旧 user/assistant 内容（在 boundary 之前的）
//
// ── 已知 TODO（codex review 2026-04-28，暂不阻塞，等 reconciliation engine 拿到
//    第一份 coverage 报告后统筹修复） ────────────────────────────────────────────
//
// TODO(retry-skill-listing): R7 当前只丢 user_message / local_command_history，
//   保留了失败 attempt 旁边的 skill_listing / attachment。实测 4 个 fixture 的
//   proxy messages[0] 都没有把 skill_listing 当成独立 text block 发出去（要么折
//   进 <system-reminder>，要么不发），所以保留它会产生 unmatched expected segment
//   假阳性。下一轮处理可选两条路：
//     (a) 收紧 R7：preempted 组连 skill_listing/attachment 一起丢。
//     (b) 把 R4 改造成"标记 skill_listing mutation 为 pending → harness_injection
//         折叠"，segment 在 U3 system_reminder_per_turn 实现后再产出。
//   目前先按 (a) 的反向（保留）实现，等 reconciliation engine 量化假阳性后再决定。
//
// TODO(rule-toggle-not-effective): HarnessRuleConfig 的
//   appendBaseMessages / injectSkillListing / injectLocalCommand 三个开关目前只
//   影响 sourceRefs / rulesApplied 的 ruleId 标签，没有真正 gate segment 生成。
//   修复方向：在 mapMutationsToSegments 入口按 category 加 gate（例如
//     if (m.category === "skill_listing" && !rules.injectSkillListing) continue;
//   ），并补 toggle-off 的零 segment 单测。当前因为 "首批 4 个 fixture 不依赖此
//   能力做回归调试"暂未实现；reconciliation engine 上线后会需要这个 gate 来做
//   "关掉 R4 看 coverage 变化" 的对比实验。

import { createHash } from "crypto";

import type {
  AppliedRule,
  ContentRef,
  ContextMutation,
  ContextSegment,
  ExpectedQueryContext,
  SegmentCategory,
  SegmentRole,
  SegmentSection,
  SourceRef,
} from "./types";

// 与 proxy-snapshot-parser 口径一致：16位短截 SHA-256
function sha256Short(text: string): string {
  return "sha256:" + createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// ─────────────────────────────────────────────────────────────────────────────
// 输入 / 输出 / 配置
// ─────────────────────────────────────────────────────────────────────────────

/** harness rule 开关；默认全部启用。每条规则可独立关闭，便于回归调试。 */
export interface HarnessRuleConfig {
  appendBaseMessages?: boolean; // R1
  mergeAssistantToolUses?: boolean; // R2
  mergeUserToolResults?: boolean; // R3
  injectSkillListing?: boolean; // R4
  injectLocalCommand?: boolean; // R5
  filterKnownNoise?: boolean; // R6
  apiErrorRetryAlignment?: boolean; // R7
  filterSyntheticApiError?: boolean; // R8
}

const DEFAULT_RULES: Required<HarnessRuleConfig> = {
  appendBaseMessages: true,
  mergeAssistantToolUses: true,
  mergeUserToolResults: true,
  injectSkillListing: true,
  injectLocalCommand: true,
  filterKnownNoise: true,
  apiErrorRetryAlignment: true,
  filterSyntheticApiError: true,
};

export interface QueryBoundary {
  queryId: string;
  sessionId?: string;
  /** 取所有 timestamp <= proxyTimestamp 的 mutation；无 timestamp 的视为前置环境（permission-mode 等），按出现顺序保留。 */
  proxyTimestamp?: string;
  /** 替代时间过滤的硬上界——包含此 mutationId 在内的全部前缀。 */
  upToMutationId?: string;
  /** 起点 query。第二个 query 之后可用 afterQueryId 推导起点。 */
  beforeQueryId?: string;
  agentId?: string;
  subagentId?: string;
  parentAgentId?: string;
}

export interface ReconstructInput {
  mutations: ContextMutation[];
  boundary: QueryBoundary;
  rules?: HarnessRuleConfig;
  fixtureName?: string;
  /** 来自 JsonlMutationParseResult.hasPreSessionActivity：--resume 时 JSONL 里存在活动前置信号。 */
  hasPreSessionActivity?: boolean;
}

/** 暂未实现规则的标识。结果中 metadata.unimplementedRules 会列出这些。 */
export const UNIMPLEMENTED_RULES = [
  "system_prompt_injection",
  "tools_schema_injection",
  "system_reminder_per_turn",
  "prior_session_history",
  "compaction_replacement",
] as const;

export type UnimplementedRuleId = (typeof UNIMPLEMENTED_RULES)[number];

// ─────────────────────────────────────────────────────────────────────────────
// 主入口
// ─────────────────────────────────────────────────────────────────────────────

export function reconstructExpectedClaudeContext(
  input: ReconstructInput,
): ExpectedQueryContext {
  const rules: Required<HarnessRuleConfig> = { ...DEFAULT_RULES, ...(input.rules ?? {}) };

  // 1. 取出本次 query boundary 内的 mutation 切片。
  const sliced = sliceByBoundary(input.mutations, input.boundary);

  // 2. R7：api_error retry 对齐——丢弃失败 attempt 的 user 输入组合。
  const afterRetry = rules.apiErrorRetryAlignment ? applyApiErrorRetryAlignment(sliced) : sliced;

  // 3. R6：过滤 hook_event / billing_noise / type=noise（不进 expected）。
  // R8：过滤 isApiErrorMessage=true 的合成 assistant 行（harness 展示用，proxy 里没有）。
  const afterNoise = rules.filterKnownNoise ? afterRetry.filter(isExpectedRelevant) : afterRetry;
  const surviving = rules.filterSyntheticApiError
    ? afterNoise.filter((m) => !m.metadata?.isApiErrorMessage)
    : afterNoise;

  // 4. R1–R5：把每条 mutation 映射为 ContextSegment；在 metadata.logicalMessage
  //    标记同一逻辑 message 的归并组（不物理合并，给后续 reconciliation 做 N:1 对齐）。
  const segments = mapMutationsToSegments(surviving, rules);

  // 5. 收集 rulesApplied / unimplementedRules。
  const rulesApplied = collectAppliedRules(rules, surviving);
  const unimplementedRules: UnimplementedRuleId[] = [...UNIMPLEMENTED_RULES];

  // 6. 检测 prefix incomplete：JSONL prefix 是否缺少 prior history turn。
  // 判断依据：parser 在第一条有时间戳的 user/assistant 行之前检测到 last-prompt，
  // 说明这个 session 在当前查询之前就有活动（--resume 场景）。
  // JSONL prefix 在这种情况下不包含历史 turn，对账时 prior_session_history 会无 expected 对应。
  const prefixIncomplete = input.hasPreSessionActivity === true;

  // 7. 组装 ExpectedQueryContext。
  const sessionId =
    input.boundary.sessionId ??
    sliced.find((m) => m.sessionId)?.sessionId ??
    "unknown";

  const syntheticDroppedCount = afterNoise.length - surviving.length;

  const expected: ExpectedQueryContext = {
    id: `expected-${input.boundary.queryId}`,
    agentKind: "claude-code",
    sessionId,
    queryId: input.boundary.queryId,
    mutationIds: surviving.map((m) => m.id),
    segments,
    rulesApplied,
    generatedAt: new Date().toISOString(),
    metadata: pruneMetadata({
      fixtureName: input.fixtureName,
      unimplementedRules,
      droppedMutationCount: input.mutations.length - sliced.length,
      retryDroppedMutationCount: sliced.length - afterRetry.length,
      noiseDroppedMutationCount: afterRetry.length - afterNoise.length,
      syntheticApiErrorDroppedCount: syntheticDroppedCount > 0 ? syntheticDroppedCount : undefined,
      prefixIncomplete: prefixIncomplete || undefined,
    }),
  };

  if (input.boundary.beforeQueryId) expected.beforeQueryId = input.boundary.beforeQueryId;
  if (input.boundary.agentId) expected.agentId = input.boundary.agentId;
  if (input.boundary.subagentId) expected.subagentId = input.boundary.subagentId;
  if (input.boundary.parentAgentId) expected.parentAgentId = input.boundary.parentAgentId;

  return expected;
}

// ─────────────────────────────────────────────────────────────────────────────
// boundary 切片
// ─────────────────────────────────────────────────────────────────────────────

function sliceByBoundary(
  mutations: ContextMutation[],
  boundary: QueryBoundary,
): ContextMutation[] {
  if (boundary.upToMutationId) {
    const idx = mutations.findIndex((m) => m.id === boundary.upToMutationId);
    if (idx < 0) return [];
    return mutations.slice(0, idx + 1);
  }
  if (boundary.proxyTimestamp) {
    const cutoff = Date.parse(boundary.proxyTimestamp);
    if (Number.isNaN(cutoff)) return mutations.slice();
    // 无 timestamp 的 mutation（permission-mode、worktree-state 等环境记录）
    // 保留——它们不参与时间过滤，由 R6 噪声过滤再决定是否进入 expected。
    return mutations.filter((m) => {
      if (!m.timestamp) return true;
      const t = Date.parse(m.timestamp);
      return Number.isNaN(t) ? true : t <= cutoff;
    });
  }
  return mutations.slice();
}

// ─────────────────────────────────────────────────────────────────────────────
// R7：api_error retry 对齐
// ─────────────────────────────────────────────────────────────────────────────
//
// Claude Code 在请求失败后会重试。失败 attempt 的 user 输入仍然写进 JSONL，
// 但真实 proxy 只对应最终成功的那一次。
//
// 实测语义（来自 fixture 观察）：
//   - user_message / local_command_history 是"本次请求的真实 user payload"，
//     失败后 harness 会用同样内容重新发起一次，JSONL 里出现两份；只保留后一份。
//   - skill_listing / attachment 是"session 级附加信息"，JSONL 只记一次（在第一
//     次 attempt 旁边），但 harness 在每次重试时都会重新 render 进 messages[0]。
//     所以 R7 不能丢弃它们——丢了会导致 expected 缺一段，proxy 反而真的有。
//
// 算法：
//   - 跟踪"当前 user-payload 组"（仅 user_message + local_command_history）。
//   - 当出现 api_error 时标记 preempted。
//   - 出现下一条 user-payload 时，丢弃 preempted 组里登记过的 user-payload mutation
//     索引。skill_listing / attachment 不参与丢弃。

function applyApiErrorRetryAlignment(mutations: ContextMutation[]): ContextMutation[] {
  const drop = new Set<number>();
  let active: { indices: number[]; preempted: boolean } | null = null;

  const isUserPayload = (m: ContextMutation): boolean =>
    m.category === "user_message" || m.category === "local_command_history";

  const isApiError = (m: ContextMutation): boolean =>
    m.type === "noise" &&
    m.category === "hook_event" &&
    m.metadata?.systemSubtype === "api_error";

  for (let i = 0; i < mutations.length; i++) {
    const m = mutations[i];

    if (isUserPayload(m)) {
      if (active?.preempted) {
        for (const k of active.indices) drop.add(k);
        active = null;
      }
      if (!active) active = { indices: [], preempted: false };
      active.indices.push(i);
      continue;
    }

    if (isApiError(m) && active) {
      active.preempted = true;
      continue;
    }

    // assistant 一旦出现，本次请求已经成功，当前组不会再被 preempt。
    if (m.category === "assistant_text" || m.category === "tool_use" || m.category === "thinking") {
      active = null;
    }
  }

  if (drop.size === 0) return mutations;
  return mutations.filter((_, i) => !drop.has(i));
}

// ─────────────────────────────────────────────────────────────────────────────
// R6：是否进入 expected（噪声过滤）
// ─────────────────────────────────────────────────────────────────────────────

function isExpectedRelevant(m: ContextMutation): boolean {
  if (m.type === "noise") return false;
  if (m.category === "billing_noise") return false;
  if (m.category === "hook_event") return false;
  if (m.category === "permission") return false;
  // compaction：暂未实现 replacement 语义；保留 mutation 但不生成 expected segment
  // → 标记成 hidden 在下层处理；这里先放行让下层根据 category 决定。
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// R1–R5：mutation → ContextSegment
// ─────────────────────────────────────────────────────────────────────────────

interface SegmentRoleMapEntry {
  role: SegmentRole;
  section: SegmentSection;
}

function roleAndSectionFor(category: SegmentCategory): SegmentRoleMapEntry | null {
  switch (category) {
    case "user_message":
    case "tool_result":
    case "skill_listing":
    case "local_command_history":
    case "attachment":
    case "harness_injection":
    case "memory_injection":
    case "slash_command":
    case "prior_session_history":
      return { role: "user", section: "messages" };
    case "assistant_text":
    case "tool_use":
    case "thinking":
      return { role: "assistant", section: "messages" };
    case "compaction":
      // 第一阶段把 compact 摘要按 user 段渲染（与 sourcemap 一致：createUserMessage）
      return { role: "user", section: "messages" };
    default:
      return null;
  }
}

function mapMutationsToSegments(
  mutations: ContextMutation[],
  rules: Required<HarnessRuleConfig>,
): ContextSegment[] {
  const segments: ContextSegment[] = [];
  let order = 0;

  // 计算 logicalMessageId：
  //   assistant 一侧（R2）：同一 messageId 的所有 block 归到一组，跨越中间穿插
  //     的 user tool_result 也仍是同一组。原因：Claude Code 把单次 API 响应的
  //     多个 tool_use block 拆成多行 JSONL 写出，user tool_result 会被插在
  //     这些行之间，但在真实 proxy 里它们仍是一条 assistant message。
  //   user 一侧（R3）：连续 tool_result 合并；最初的 user_message 与同一 turn 的
  //     skill_listing / local_command_history / attachment 合并；assistant
  //     一旦出现就强制切到新的 user 组。
  let lastSegmentRole: SegmentRole | null = null;
  let groupCounter = 0;
  // assistant messageId → groupId 映射（跨 user tool_result 仍能命中同一组）
  const assistantGroupByMsgId = new Map<string, string>();
  let currentUserGroupId: string | null = null;
  let currentUserCategory: SegmentCategory | null = null;

  const startNewGroup = (label: string): string => {
    groupCounter += 1;
    return `lm-${groupCounter}-${label}`;
  };

  for (let i = 0; i < mutations.length; i++) {
    const m = mutations[i];
    const map = roleAndSectionFor(m.category);
    if (!map) continue;

    const role = map.role;
    const messageId =
      typeof m.metadata?.messageId === "string" ? (m.metadata.messageId as string) : undefined;

    let groupId: string;

    if (role === "assistant") {
      if (rules.mergeAssistantToolUses && messageId && assistantGroupByMsgId.has(messageId)) {
        groupId = assistantGroupByMsgId.get(messageId)!;
      } else {
        groupId = startNewGroup("assistant");
        if (messageId) assistantGroupByMsgId.set(messageId, groupId);
      }
      // assistant 出现 → 当前 user 组失效（下一条 user 开新组）
      currentUserGroupId = null;
      currentUserCategory = null;
    } else {
      if (
        rules.mergeUserToolResults &&
        lastSegmentRole === "user" &&
        currentUserGroupId &&
        canMergeUserBlock(m.category, currentUserCategory)
      ) {
        groupId = currentUserGroupId;
      } else {
        groupId = startNewGroup("user");
      }
      currentUserGroupId = groupId;
      currentUserCategory = m.category;
    }

    lastSegmentRole = role;
    const seg = mutationToSegment(m, role, map.section, order++, groupId, rules);
    segments.push(seg);
  }

  return segments;
}

function canMergeUserBlock(curr: SegmentCategory, prev: SegmentCategory | null): boolean {
  if (!prev) return false;
  // 连续 tool_result 合并
  if (curr === "tool_result" && prev === "tool_result") return true;
  // user_message + skill_listing / local_command_history 在 messages[0] 同一 message 里
  const userMsgFamily: SegmentCategory[] = [
    "user_message",
    "skill_listing",
    "local_command_history",
    "attachment",
    "harness_injection",
  ];
  if (userMsgFamily.includes(curr) && userMsgFamily.includes(prev)) return true;
  return false;
}

function mutationToSegment(
  m: ContextMutation,
  role: SegmentRole,
  section: SegmentSection,
  order: number,
  logicalMessageId: string,
  rules: Required<HarnessRuleConfig>,
): ContextSegment {
  const charCount = m.contentRef?.charCount ?? m.charDeltaEstimate ?? 0;
  // tokenEstimate：4 chars/token 的粗估，与 proxy-attribution 同口径。
  const tokenEstimate = Math.round(charCount / 4);

  const sourceRefs: SourceRef[] = [m.sourceRef];
  // R4 / R5 / 标记规则 SourceRef：把规则也写进 sourceRefs 便于追溯。
  const ruleId = ruleIdForCategory(m.category, rules);
  if (ruleId) {
    sourceRefs.push({
      kind: "harness_rule",
      harness: { ruleId },
      label: `rule:${ruleId}`,
    });
  }

  const seg: ContextSegment = {
    id: `eseg-${m.id}`,
    section,
    category: m.category,
    label: labelFor(m, role),
    sourceRefs,
    role,
    order,
    metadata: pruneMetadata({
      sourceMutationId: m.id,
      logicalMessageId,
      messageId: m.metadata?.messageId,
      toolUseId: m.toolUseId,
      ruleId,
      preview:
        m.contentRef?.text && m.contentRef.text.length > 80
          ? m.contentRef.text.slice(0, 80)
          : m.contentRef?.text,
    }),
  };

  if (m.contentRef) seg.contentRef = m.contentRef as ContentRef;
  if (charCount > 0) seg.charCount = charCount;
  if (tokenEstimate > 0) seg.tokenEstimate = tokenEstimate;
  if (m.toolUseId) seg.toolUseId = m.toolUseId;

  // rawHash：用 contentRef.text 与 proxy-snapshot-parser 同口径的 sha256 短截，
  // 供 reconciliation engine M1 精确匹配（避免 M4 heuristic 跨 turn 错配）。
  // tool_use 的文本是 JSON.stringify(input)，tool_result 是原始结果字符串，
  // 与 proxy-snapshot-parser parseMessageSegments 里的 rawText 构造方式一致。
  if (m.contentRef?.text) {
    seg.rawHash = sha256Short(m.contentRef.text);
  }

  // lifecycle：与 proxy-attribution 同口径
  switch (m.category) {
    case "skill_listing":
    case "local_command_history":
    case "harness_injection":
      seg.lifecycle = "one_shot";
      seg.flags = ["injected"];
      break;
    case "compaction":
      seg.lifecycle = "session";
      seg.flags = ["approximate"];
      break;
    default:
      seg.lifecycle = "query";
  }

  return seg;
}

function labelFor(m: ContextMutation, role: SegmentRole): string {
  const tail =
    typeof m.metadata?.toolName === "string" ? ` (${m.metadata.toolName as string})` : "";
  return `${role}/${m.category}${tail}`;
}

function ruleIdForCategory(
  category: SegmentCategory,
  rules: Required<HarnessRuleConfig>,
): string | undefined {
  if (category === "skill_listing" && rules.injectSkillListing) return "R4_inject_skill_listing";
  if (category === "local_command_history" && rules.injectLocalCommand)
    return "R5_inject_local_command";
  if (category === "tool_use" && rules.mergeAssistantToolUses)
    return "R2_merge_assistant_tool_uses";
  if (category === "tool_result" && rules.mergeUserToolResults)
    return "R3_merge_user_tool_results";
  if (category === "user_message" || category === "assistant_text") return "R1_base_append";
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// AppliedRule / 工具函数
// ─────────────────────────────────────────────────────────────────────────────

function collectAppliedRules(
  rules: Required<HarnessRuleConfig>,
  mutations: ContextMutation[],
): AppliedRule[] {
  const out: AppliedRule[] = [];
  const push = (ruleId: string, source: AppliedRule["source"]): void => {
    out.push({ ruleId, source, confidence: "exact", version: "v1" });
  };
  if (rules.appendBaseMessages) push("R1_base_append", "harness_rule");
  if (rules.mergeAssistantToolUses && mutations.some((m) => m.category === "tool_use"))
    push("R2_merge_assistant_tool_uses", "harness_rule");
  if (rules.mergeUserToolResults && mutations.some((m) => m.category === "tool_result"))
    push("R3_merge_user_tool_results", "harness_rule");
  if (rules.injectSkillListing && mutations.some((m) => m.category === "skill_listing"))
    push("R4_inject_skill_listing", "harness_rule");
  if (rules.injectLocalCommand && mutations.some((m) => m.category === "local_command_history"))
    push("R5_inject_local_command", "harness_rule");
  if (rules.filterKnownNoise) push("R6_filter_known_noise", "harness_rule");
  if (rules.apiErrorRetryAlignment) push("R7_api_error_retry_alignment", "harness_rule");
  if (rules.filterSyntheticApiError) push("R8_filter_synthetic_api_error", "harness_rule");
  return out;
}

function pruneMetadata(meta: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(meta)) {
    const v = meta[k];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

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
// P1-5 已实现：HarnessRuleConfig 开关在 mapMutationsToSegments 入口按 category gate。

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
import { CONTEXT_LEDGER_RULES } from "./rule-registry";
import type { ContextLedgerRule } from "./rule-registry";

// 与 proxy-snapshot-parser 口径一致：16位短截 SHA-256
function sha256Short(text: string): string {
  return "sha256:" + createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// ─────────────────────────────────────────────────────────────────────────────
// 输入 / 输出 / 配置
// ─────────────────────────────────────────────────────────────────────────────

/** harness rule 开关；默认全部启用。每条规则可独立关闭，便于单元回归调试。 */
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
  "system_reminder_per_turn",
  "prior_session_history",
  "compaction_replacement",
  "system_prompt_injection",
  "tools_schema_injection",
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
  const unimplementedRules: string[] = [...UNIMPLEMENTED_RULES];

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
  // task_reminder：P1-2 加法重建——不在此过滤，在 mapMutationsToSegments 里
  // 识别并追加到 parentUuid 对应的 tool_result expected segment 尾部，不生成独立 segment。
  // compaction：暂未实现 replacement 语义，先放行让下层根据 category 决定。
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

  // P1-2：收集 task_reminder mutations（不生成独立 segment，在主循环后追加到对应 tool_result）
  // key: parentUuid（task_reminder 要 smoosh 进的 tool_result 所在 JSONL 记录的 uuid）
  interface PendingTaskReminder {
    mutationId: string;
    content: unknown;        // Task[]
    parentUuid: string;
  }
  const pendingTaskReminders: PendingTaskReminder[] = [];

  // sourceMutationId → segment 索引（用于找到 tool_result expected segment）
  const segByMutationId = new Map<string, number>();

  for (let i = 0; i < mutations.length; i++) {
    const m = mutations[i];

    // P1-2：task_reminder 不生成独立 segment，收集后 post-process
    if (m.category === "attachment" && m.metadata?.attachmentType === "task_reminder") {
      const parentUuid = typeof m.metadata?.parentUuid === "string" ? m.metadata.parentUuid : null;
      if (parentUuid) {
        pendingTaskReminders.push({
          mutationId: m.id,
          content: m.contentRef?.text !== undefined
            ? (() => { try { return JSON.parse(m.contentRef!.text!); } catch { return []; } })()
            : [],
          parentUuid,
        });
      }
      continue;
    }

    const map = roleAndSectionFor(m.category);
    if (!map) continue;

    // P1-5：按 HarnessRuleConfig 开关 gate segment 生成
    // R4/R5 关闭时，对应 category 的 mutation 直接跳过，不产生 expected segment。
    // R1 关闭时，基础 messages（user_message / assistant_text）也不产生 segment。
    if (m.category === "skill_listing" && !rules.injectSkillListing) continue;
    if (m.category === "local_command_history" && !rules.injectLocalCommand) continue;
    if (
      (m.category === "user_message" || m.category === "assistant_text") &&
      !rules.appendBaseMessages
    ) continue;

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
    segByMutationId.set(m.id, segments.length);
    segments.push(seg);
  }

  // P1-2 post-processing：把 task_reminder 渲染文本追加到对应 tool_result segment 尾部
  if (pendingTaskReminders.length > 0) {
    // 建立 parentUuid → 最后一个 tool_result segment 的映射
    // parentUuid 指向 JSONL 里的 user message record，该 record 可能对应多个 tool_result mutation。
    // sourceMutationId 在 metadata 里，用于定位 expected segment。
    // 策略：找 metadata.parentUuid 等于 task_reminder.parentUuid 的 tool_result segment，
    // 取最后一个（与 proxy smoosh 到最后一个 tool_result 的行为一致）。
    for (const pending of pendingTaskReminders) {
      // 找对应的 tool_result segment（通过 metadata.recordUuid 匹配）
      // task_reminder.parentUuid = 那条 user message JSONL record 的 uuid
      // tool_result mutation.metadata.recordUuid = 同一条 user message JSONL record 的 uuid
      let targetIdx = -1;
      for (let si = segments.length - 1; si >= 0; si--) {
        const seg = segments[si];
        if (
          seg.category === "tool_result" &&
          typeof seg.metadata?.["recordUuid"] === "string" &&
          seg.metadata["recordUuid"] === pending.parentUuid
        ) {
          targetIdx = si;
          break;
        }
      }

      if (targetIdx < 0) {
        // fallback：取 segments 里最后一个 tool_result（兼容 parentUuid 未传入的情况）
        for (let si = segments.length - 1; si >= 0; si--) {
          if (segments[si].category === "tool_result") {
            targetIdx = si;
            break;
          }
        }
      }

      if (targetIdx < 0) continue;

      const target = segments[targetIdx];
      const smooshText = renderTaskReminderSmoosh(pending.content);
      const originalText = target.contentRef?.text ?? "";
      const combinedText = originalText + smooshText;

      // 更新 contentRef.text 并重新计算 rawHash
      segments[targetIdx] = {
        ...target,
        contentRef: { kind: "inline", text: combinedText, charCount: combinedText.length },
        charCount: combinedText.length,
        tokenEstimate: Math.round(combinedText.length / 4),
        rawHash: sha256Short(proxyWrapTextForCategory(target.category, combinedText)),
        flags: [...(target.flags ?? []), "smooshed_reminder"],
      };
    }
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
      // P1-2：recordUuid = user message record 自身的 uuid（rec.uuid），供 task_reminder
      // post-processing 通过 pending.parentUuid === seg.metadata.recordUuid 定位目标 segment。
      // parentUuid = rec.parentUuid（assistant record 的 uuid），两者不同，不能混用。
      recordUuid: m.metadata?.recordUuid,
      parentUuid: m.metadata?.parentUuid,
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

  // rawHash / charCount：用 proxyWrapTextForCategory 把 JSONL mutation 的纯内容
  // 包装成与 proxy rawText 一致的格式，再算 rawHash 和 charCount。
  // 这样 M1 精确匹配命中后，reconcile 的 alignedTextDrift 也为 0（两侧字符数一致）。
  // tool_use / tool_result / user_message 无需包装，直接使用原始文本。
  if (m.contentRef?.text) {
    const wrappedText = proxyWrapTextForCategory(m.category, m.contentRef.text);
    seg.rawHash = sha256Short(wrappedText);
    // 包装后字符数与 proxy rawText.length 一致，覆盖 JSONL 原始长度
    if (wrappedText.length !== m.contentRef.text.length) {
      seg.charCount = wrappedText.length;
    }
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

// ─────────────────────────────────────────────────────────────────────────────
// proxyWrapTextForCategory：把 JSONL mutation 的纯内容包装成 proxy 发出的格式，
// 用于计算与 proxy rawText 一致的 rawHash（方案A）。
//
// 背景：harness 在 normalizeAttachmentForAPI（messages.ts）里对 attachment 类型
// 加了固定 header 和 <system-reminder> wrapper，proxy rawText 是包装后的完整文本。
// JSONL mutation 的 contentRef.text 是包装前的纯内容，两者 hash 不同，M1 无法命中。
//
// 各 category 的包装规则（参考 restored-src/src/utils/messages.ts）：
//   skill_listing     → wrapMessagesInSystemReminder([createUserMessage("The following skills...\n\n{content}")])
//                       proxy rawText = "<system-reminder>\nThe following skills are available for use with the Skill tool:\n\n{content}\n</system-reminder>\n"
//   local_command_history → proxy rawText = 原始 <local-command-*> / <bash-*> 标签文本，无额外包装
//   其他 category     → 直接返回原始文本（不包装）
//

// P1-2：把 task_reminder mutation 的内容渲染为 proxy 格式的 smoosh 文本。
//
// proxy 实际格式（从 188e479d session 观测）：
//   空 task list：
//     <system-reminder>\n{BASE_TEXT}\n\n</system-reminder>
//   有 tasks：
//     <system-reminder>\n{BASE_TEXT}\n\n\nHere are the existing tasks:\n\n#N. [{status}] {subject}\n...</system-reminder>
//
// BASE_TEXT 来自 rule-registry TASK_REMINDER_PREFIX 去掉 "<system-reminder>\n" 前缀：
//   "The task tools haven't been used recently. ..."
//
// attachment.content 是 Task[] 数组，每项含 { id, subject, status } 字段。
function renderTaskReminderSmoosh(content: unknown): string {
  const BASE =
    "The task tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, consider using TaskCreate to add new tasks and TaskUpdate to update task status (set to in_progress when starting, completed when done). Also consider cleaning up the task list if it has become stale. Only use these if relevant to the current work. This is just a gentle reminder - ignore if not applicable. Make sure that you NEVER mention this reminder to the user";

  const tasks = Array.isArray(content) ? content : [];
  if (tasks.length === 0) {
    return `<system-reminder>\n${BASE}\n\n</system-reminder>`;
  }

  const taskLines = tasks
    .map((t: unknown) => {
      if (!t || typeof t !== "object") return null;
      const task = t as Record<string, unknown>;
      const id = String(task["id"] ?? "?");
      const subject = String(task["subject"] ?? "");
      const status = String(task["status"] ?? "pending");
      return `#${id}. [${status}] ${subject}`;
    })
    .filter(Boolean)
    .join("\n");

  return `<system-reminder>\n${BASE}\n\n\nHere are the existing tasks:\n\n${taskLines}\n</system-reminder>`;
}

function proxyWrapTextForCategory(category: SegmentCategory, text: string): string {
  if (category === "skill_listing") {
    // 参考 messages.ts normalizeAttachmentForAPI case 'skill_listing'（sourcemap:3732）:
    //   content = "The following skills are available for use with the Skill tool:\n\n" + attachment.content
    //   然后 wrapMessagesInSystemReminder → "<system-reminder>\n{content}\n</system-reminder>"
    // proxy-snapshot-parser 存的 rawText 末尾还带一个额外 \n（string content 原样保留）
    const header = "The following skills are available for use with the Skill tool:\n\n";
    return `<system-reminder>\n${header}${text}\n</system-reminder>\n`;
  }
  if (category === "local_command_history") {
    // Claude Code 把每条 local-command string content 放入 array content text block 时，
    // 会在末尾追加 \n（proxy-snapshot-parser 按 blk.text 原样存为 rawText）。
    // JSONL mutation 里的 content 是未追加 \n 的原始字符串，需在此补齐。
    // 实证：所有 fixture 的 proxy text block 均以 \n 结尾，JSONL content 均无尾部 \n。
    // 参考 sourcemap: messages.ts createSyntheticUserCaveatMessage / formatCommandInputTags
    return text.endsWith("\n") ? text : text + "\n";
  }
  // tool_use / tool_result / user_message 等：原始文本，无需包装
  return text;
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

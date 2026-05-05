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
//   R4 inject_skill_listing     attachment.skill_listing 注入为 user 段
//   R5 inject_local_command     <local-command-* / <bash-* 注入为 user 段
//   R6 filter_known_noise       hook_event / billing_noise / type=noise 不进 expected segments
//   R7 api_error_retry_alignment 失败 attempt 的 user 输入组合在 retry 成功后被丢弃
//   R8 filter_synthetic_api_error harness 合成的 isApiErrorMessage assistant 行（proxy 里没有）
//
// 已通过 rule materializer 实现（P4/P5，不再是 unimplemented）：
//   system[] billing presence + identity exact → materializeHarnessRules()
//   tools[]  verified built-in tool exact schema → materializeHarnessRules()
//
// 暂未实现（会在 metadata.unimplementedRules 显式标记）：
//   U3 system_reminder_per_turn     每个 user turn 头部的 <system-reminder>
//   U4 prior_session_history        --resume / continue 时携带的历史会话片段
//   U5 compaction_replacement       compact 摘要替换早期 mutation 的语义
//
// 这些 U* 缺失意味着真实 proxy 中以下 segment 会成为 attribution_only：
//   - messages[].content[*] 中的 <system-reminder> / prior_session_history 字符串
//   - compact 摘要替换前的旧 user/assistant 内容（在 boundary 之前的）
//   - 未 verified 或 preCondition 未知的 system/tool rule（→ unmaterializedRules）
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
  HarnessRuntimeSnapshot,
  PreConditionResult,
  SegmentCategory,
  SegmentRole,
  SegmentSection,
  SourceRef,
} from "./types";
import { CONTEXT_LEDGER_RULES, SUPPORTED_CLAUDE_CODE_VERSION, isRuleVerified } from "./rule-registry";
import type { ContextLedgerRule, RulePreCondition } from "./rule-registry";
import { BUILTIN_TOOL_SCHEMA_JSON } from "./tool-schema-registry";

// 与 proxy-snapshot-parser 口径一致：16位短截 SHA-256
function sha256Short(text: string): string {
  return "sha256:" + createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// materializeHarnessRules 内部 order 段基址。
// tools section 段：5000+，与 mutation segment（0 起步，上限约数百）不冲突。
// system/messages rule 段：6000+，与 tools 段分离便于 reconciliation order 对比。
// buildTargetRequest 侧按 section 分组后按 order 重新索引，不依赖这里的绝对值。
const RULE_ORDER_TOOL_BASE = 5000;
const RULE_ORDER_NON_TOOL_BASE = 6000;

// ─────────────────────────────────────────────────────────────────────────────
// 输入 / 输出 / 配置
// ─────────────────────────────────────────────────────────────────────────────

/** harness rule 开关；默认全部启用。每条规则可独立关闭，便于单元回归调试。 */
export interface HarnessRuleConfig {
  appendBaseMessages?: boolean; // R1
  mergeAssistantToolUses?: boolean; // R2
  injectSkillListing?: boolean; // R4
  injectLocalCommand?: boolean; // R5
  filterKnownNoise?: boolean; // R6
  apiErrorRetryAlignment?: boolean; // R7
  filterSyntheticApiError?: boolean; // R8
}

const DEFAULT_RULES: Required<HarnessRuleConfig> = {
  appendBaseMessages: true,
  mergeAssistantToolUses: true,
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
  // 非 proxy 运行态快照；作为 RulePreCondition evaluator 的输入。
  // 省略时所有 preCondition 非 always 的 rule 均视为 unknown → skip。
  runtimeSnapshot?: HarnessRuntimeSnapshot;
}

// U3/U4/U5 对应的架构层缺口（system/tools 的 rule materializer 已在 P4/P5 实现）
/** 暂未实现规则的标识。结果中 metadata.unimplementedRules 会列出这些。 */
export const UNIMPLEMENTED_RULES = [
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

  // 4b. Rule Materializer：从 CONTEXT_LEDGER_RULES.reconstruction 正向生成 system/tools expected segments。
  //     仅消费 rule.reconstruction，不读取 proxy 结果。
  const materialized = materializeHarnessRules(
    CONTEXT_LEDGER_RULES,
    input.boundary,
    input.runtimeSnapshot,
  );
  segments.push(...materialized.segments);

  // 5. 收集 rulesApplied / unimplementedRules。
  const rulesApplied = collectAppliedRules(rules, surviving);
  // 把 materializer 产出的 AppliedRule 合并进来
  rulesApplied.push(...materialized.appliedRules);
  const unimplementedRules: string[] = [...UNIMPLEMENTED_RULES];
  // 把 materializer 跳过的 rule 记录到 unmaterializedRules
  const unmaterializedRules: string[] = [...materialized.unmaterializedRuleIds];

  // 6. 组装 ExpectedQueryContext。
  // TODO(prior-session-prefix): --resume 场景下若 JSONL prefix 缺少历史 turn，
  // 应在 metadata.prefixIncomplete=true，reconcile 层会将 order_mismatch 降级为 info。
  // 经全量扫描此场景从未出现，暂不传入。如未来需要，在 jsonl-mutation-parser.ts 恢复
  // hasPreSessionActivity 检测，并在此处恢复：const prefixIncomplete = input.hasPreSessionActivity。
  const sessionId =
    input.boundary.sessionId ??
    sliced.find((m) => m.sessionId)?.sessionId ??
    "unknown";

  const syntheticDroppedCount = afterNoise.length - surviving.length;

  // runtimeSnapshot 摘要（仅记录已有值的字段，不序列化完整对象）
  const runtimeSnapshotSummary = input.runtimeSnapshot
    ? {
        source: input.runtimeSnapshot.source,
        ...(input.runtimeSnapshot.inferredModel !== undefined
          ? { inferredModel: input.runtimeSnapshot.inferredModel }
          : {}),
        ...(input.runtimeSnapshot.permissionMode !== undefined
          ? { permissionMode: input.runtimeSnapshot.permissionMode }
          : {}),
        ...(input.runtimeSnapshot.userType !== undefined
          ? { userType: input.runtimeSnapshot.userType }
          : {}),
      }
    : undefined;

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
      unmaterializedRules: unmaterializedRules.length > 0 ? unmaterializedRules : undefined,
      droppedMutationCount: input.mutations.length - sliced.length,
      retryDroppedMutationCount: sliced.length - afterRetry.length,
      noiseDroppedMutationCount: afterRetry.length - afterNoise.length,
      syntheticApiErrorDroppedCount: syntheticDroppedCount > 0 ? syntheticDroppedCount : undefined,
      runtimeSnapshotSummary,
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
  //   user 一侧：连续 tool_result、user_message + skill_listing / local_command_history
  //     / attachment 归同一 logicalMessage（供 target-request-builder 重组 messages array）。
  //     assistant 一旦出现就强制切到新的 user 组。
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

  // P1-2：收集需要 smoosh 进 tool_result 的 mutations（不生成独立 segment，主循环后追加）
  // task_reminder：content = Task[]，渲染为固定前缀 + task list
  // queued_command：content = prompt string，渲染为 pd7("human") 格式的 mid-turn 消息
  // 两者的 parentUuid 均指向对应 tool_result 所在的 user message JSONL record 的 uuid。
  interface PendingSmoosh {
    mutationId: string;
    kind: "task_reminder" | "queued_command";
    content: unknown;        // task_reminder: Task[]；queued_command: prompt string
    parentUuid: string;
  }
  const pendingSmooshes: PendingSmoosh[] = [];

  // sourceMutationId → segment 索引（用于找到 tool_result expected segment）
  const segByMutationId = new Map<string, number>();

  for (let i = 0; i < mutations.length; i++) {
    const m = mutations[i];

    // P1-2：task_reminder / queued_command 不生成独立 segment，收集后 post-process smoosh
    if (m.category === "attachment") {
      const attType = m.metadata?.attachmentType as string | undefined;
      if (attType === "task_reminder" || attType === "queued_command") {
        const parentUuid = typeof m.metadata?.parentUuid === "string" ? m.metadata.parentUuid : null;
        if (parentUuid) {
          const content =
            attType === "task_reminder"
              ? (m.contentRef?.text !== undefined
                  ? (() => { try { return JSON.parse(m.contentRef!.text!); } catch { return []; } })()
                  : [])
              : (m.contentRef?.text ?? "");
          pendingSmooshes.push({ mutationId: m.id, kind: attType, content, parentUuid });
        }
        continue;
      }

      // file attachment：attachment.type=file 渲染为 2-3 个独立 segment。
      // sourcemap: messages.ts:3545 case 'file' → normalizeAttachmentForAPI。
      // already_read_file 在 normalizeAttachmentForAPI 直接 return []，此处不出现（parser 不会产生
      // attachmentType=file 的 mutation 来自 already_read_file；两者是不同的 attachment.type）。
      if (attType === "file") {
        const fileSegs = buildFileAttachmentSegments(m, order, lastSegmentRole, currentUserGroupId, startNewGroup);
        for (const fseg of fileSegs) {
          segByMutationId.set(m.id, segments.length);
          segments.push(fseg);
          order++;
        }
        if (fileSegs.length > 0) {
          lastSegmentRole = "user";
          currentUserGroupId = fileSegs[fileSegs.length - 1].metadata?.["logicalMessageId"] as string ?? currentUserGroupId;
          currentUserCategory = "attachment";
        }
        continue;
      }
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

  // P1-2 post-processing：把 task_reminder / queued_command 渲染文本追加到对应 tool_result segment 尾部
  // smoosh 规则（与 harness smooshSystemReminderSiblings 一致）：
  //   - 找 recordUuid === pending.parentUuid 的 tool_result segment，取最后一个
  //   - 将渲染文本以 "\n\n" 为分隔符追加到 contentRef.text 末尾，重新计算 rawHash
  if (pendingSmooshes.length > 0) {
    for (const pending of pendingSmooshes) {
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
        // fallback：取最后一个 tool_result（parentUuid 未传时的保守兜底）
        for (let si = segments.length - 1; si >= 0; si--) {
          if (segments[si].category === "tool_result") {
            targetIdx = si;
            break;
          }
        }
      }

      if (targetIdx < 0) continue;

      const target = segments[targetIdx];
      const smooshText =
        pending.kind === "task_reminder"
          ? renderTaskReminderSmoosh(pending.content)
          : renderQueuedCommandSmoosh(pending.content);
      const originalText = target.contentRef?.text ?? "";
      const combinedText = originalText + "\n\n" + smooshText;

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
// BASE_TEXT 是完整固定句（来自 sourcemap attachments.ts:3375），
// rule-registry 的 TASK_REMINDER_PREFIX 只是其前缀（用于 attribution pattern），两者粒度不同。
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

// renderQueuedCommandSmoosh：把 queued_command attachment 的 prompt 渲染为 proxy 格式。
//
// harness 处理路径（binary 逆向 pd7() 函数，case "human"）：
//   pd7(prompt, undefined) →
//     `The user sent a new message while you were working:\n${prompt}\n\nIMPORTANT: After completing your current task, you MUST address the user's message above. Do not ignore it.`
//   wrapMessagesInSystemReminder() →
//     `<system-reminder>\n${text}\n</system-reminder>`
//
// smoosh 前缀 "\n\n" 由调用处（pendingSmooshes post-processing）统一追加。
function renderQueuedCommandSmoosh(content: unknown): string {
  const prompt = typeof content === "string" ? content : String(content ?? "");
  const inner = `The user sent a new message while you were working:\n${prompt}\n\nIMPORTANT: After completing your current task, you MUST address the user's message above. Do not ignore it.`;
  return `<system-reminder>\n${inner}\n</system-reminder>`;
}

// ── file attachment segment 渲染 ─────────────────────────────────────────────
//
// sourcemap 还原路径：
//   attachments.ts:3020 generateFileAttachment → case 'file'（messages.ts:3545）
//   → wrapMessagesInSystemReminder([
//       createToolUseMessage("Read", {file_path}),   // messages.ts:4330
//       createToolResultMessage(FileReadTool, content), // messages.ts:4313
//       (truncated ? createUserMessage(truncation note) : []),  // messages.ts:3565
//     ])
//
// createToolUseMessage（messages.ts:4330）：
//   `Called the ${toolName} tool with the following input: ${jsonStringify(input)}`
//   → 外层 wrapMessagesInSystemReminder → `<system-reminder>\n{text}\n</system-reminder>`
//
// createToolResultMessage（messages.ts:4313）：
//   `Result of calling the ${tool.name} tool:\n${contentStr}`
//   contentStr = file text（string content 不经 jsonStringify，直接拼接）
//   行号格式来自 FileReadTool mapToolResultToToolResultBlockParam（FileReadTool.ts:652）：
//     `${lineNum}\t${lineText}`，整体拼接后每行以 \n 结尾。
//   → 外层 wrapMessagesInSystemReminder → `<system-reminder>\n{text}\n</system-reminder>`
//
// truncation note（messages.ts:3565，仅当 attachment.truncated=true）：
//   `Note: The file ${filename} was too large and has been truncated to the first 2000 lines. ...`
//   → 外层 wrapMessagesInSystemReminder → `<system-reminder>\n{text}\n</system-reminder>`
//
// MAX_LINES_TO_READ = 2000（FileReadTool/prompt.ts:10）
const FILE_READ_TOOL_NAME = "Read";
const MAX_LINES_TO_READ = 2000;

function renderFileReadCallWrapper(filename: string): string {
  // messages.ts:4330 createToolUseMessage + wrapMessagesInSystemReminder
  const inputJson = JSON.stringify({ file_path: filename });
  const inner = `Called the ${FILE_READ_TOOL_NAME} tool with the following input: ${inputJson}`;
  return `<system-reminder>\n${inner}\n</system-reminder>`;
}

function renderFileReadResultWrapper(fileText: string, startLine: number): string {
  // messages.ts:4313 createToolResultMessage + wrapMessagesInSystemReminder。
  // FileReadTool 把结果格式化为 `Result of calling the Read tool:\n{行号内容}`。
  //
  // JSONL 里 att.content.file.content 是纯文本（无行号），需在此添加行号前缀。
  // 行号格式（FileReadTool.ts:652）：每行输出为 `{lineNum}\t{lineText}`，
  // 整体通过 Array.join("\n") 拼接，因此行与行之间只有 \n，最后一行无尾部 \n。
  // createToolResultMessage（messages.ts:4313）把这段文本作为 string content 直接传入，
  // 不再额外处理，最终进入 wrapMessagesInSystemReminder。
  const lines = fileText.split("\n");
  const numbered = lines.map((line, i) => `${startLine + i}\t${line}`).join("\n");
  const inner = `Result of calling the ${FILE_READ_TOOL_NAME} tool:\n${numbered}`;
  return `<system-reminder>\n${inner}\n</system-reminder>`;
}

function renderFileTruncationNote(filename: string): string {
  // messages.ts:3565，仅当 attachment.truncated=true 时附加
  const inner = `Note: The file ${filename} was too large and has been truncated to the first ${MAX_LINES_TO_READ} lines. Don't tell the user about this truncation. Use ${FILE_READ_TOOL_NAME} to read more of the file if you need.`;
  return `<system-reminder>\n${inner}\n</system-reminder>`;
}

// buildFileAttachmentSegments：把一条 attachmentType=file 的 mutation 展开为 2-3 个 expected segment。
// rule 门控由调用方（mapMutationsToSegments）完成，此函数只做渲染。
function buildFileAttachmentSegments(
  m: ContextMutation,
  orderBase: number,
  lastSegmentRole: SegmentRole | null,
  currentUserGroupId: string | null,
  startNewGroup: (label: string) => string,
): ContextSegment[] {
  const filename = m.metadata?.fileAttachmentFilename as string | undefined;
  const truncated = m.metadata?.fileAttachmentTruncated === true;
  const fileText = m.contentRef?.text ?? "";
  const startLine = (m.metadata?.fileAttachmentStartLine as number | undefined) ?? 1;

  if (!filename) return []; // filename 缺失时无法渲染 call wrapper，保守跳过

  // 三段文本
  const callText    = renderFileReadCallWrapper(filename);
  const resultText  = renderFileReadResultWrapper(fileText, startLine);
  const truncNote   = truncated ? renderFileTruncationNote(filename) : null;

  // 所有 segment 归同一 logicalMessage 组（与原 skill_listing/attachment 的 canMergeUserBlock 逻辑一致）
  const groupId =
    lastSegmentRole === "user" && currentUserGroupId
      ? currentUserGroupId
      : startNewGroup("user");

  const ruleSourceRef: SourceRef = {
    kind: "harness_rule",
    harness: { ruleId: "claude-code.messages.file-attachment.v1" },
    label: "rule:claude-code.messages.file-attachment.v1",
  };

  const makeFileSeg = (
    suffix: string,
    text: string,
    order: number,
  ): ContextSegment => {
    const seg: ContextSegment = {
      id: `eseg-${m.id}-${suffix}`,
      section: "messages",
      category: "attachment",
      label: `user/attachment/file-${suffix}`,
      sourceRefs: [m.sourceRef, ruleSourceRef],
      role: "user",
      order,
      lifecycle: "session",
      flags: ["injected"],
      metadata: pruneMetadata({
        sourceMutationId: m.id,
        logicalMessageId: groupId,
        ruleId: "claude-code.messages.file-attachment.v1",
        fileAttachmentFilename: filename,
        fileAttachmentSegment: suffix,
        preview: text.slice(0, 80),
      }),
    };
    seg.contentRef = { kind: "inline", text, charCount: text.length };
    seg.charCount = text.length;
    seg.tokenEstimate = Math.round(text.length / 4);
    seg.rawHash = sha256Short(text);
    return seg;
  };

  const result: ContextSegment[] = [
    makeFileSeg("call", callText, orderBase),
    makeFileSeg("result", resultText, orderBase + 1),
  ];
  if (truncNote) {
    result.push(makeFileSeg("trunc", truncNote, orderBase + 2));
  }
  return result;
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

// ─────────────────────────────────────────────────────────────────────────────
// Rule Materializer
// ─────────────────────────────────────────────────────────────────────────────
//
// 输入：ContextLedgerRule[] + QueryBoundary + HarnessRuntimeSnapshot（占位）
// 输出：正向生成的 ContextSegment[] + AppliedRule[] + 跳过的 ruleId[]
//
// 支持的 materialization 类型：
//   exact_text   → 生成带 contentRef.text 和 rawHash 的 segment（可参与 template/raw_hash 对账）
//   normalized_text → 生成 presence 语义 segment（contentPattern=null 时不带 text），
//                     标注 materialization=normalized_text，target-request-builder 可识别
//   presence     → 生成 presence 占位 segment（无 text，不伪造内容）
//   shape        → system 段生成 shape 占位 segment（无 text），其他 section 暂时跳过
//   unavailable  → 跳过，写入 unmaterializedRuleIds（无输入来源）
//
// tools[] 专项逻辑（reconstruct-05-tool-rules）：
//   - section="tools" 的 exact_text rule：contentPattern 应为完整 tool JSON 字符串
//     ({name, description, input_schema})。若 rule 的 contentPattern 为空，
//     则从 BUILTIN_TOOL_SCHEMA_JSON 查找（key = tool name，来自 ruleId 解析）。
//   - MCP tool rule（ruleId 含 mcp__）：input_schema 由用户 MCP server 配置决定，
//     无法正向复现，保守 skip 写入 unmaterializedRuleIds。
//   - enabledToolNames 未知时：生成所有已注册内置 tool segment，
//     在 metadata 标注 enabledMode="all_verified_unfiltered"，
//     避免生成全量工具的假象但不阻塞 materialization。
//   - contentPattern 是 JSON 字符串但 JSON.parse 失败时：降级为 presence 并报告。
//
// preCondition 评估策略（保守）：
//   { type: "always" } 或省略 → 通过
//   其它所有条件（userType / harnessFlag / settingsField / harnessState / all）
//     → 暂时 skip，写入 unmaterializedRuleIds；等 reconstruct-03 引入完整 snapshot 后再实现
//
// 不从 proxy 读取任何数据。exact_text rule 若未重复填写 reconstruction.contentPattern，
// 可复用同一条 registry rule 的 attribution exact pattern 作为静态模板；这不是
// proxy attribution 反写，而是 rule registry 内部单源化。

export interface MaterializeResult {
  segments: ContextSegment[];
  appliedRules: AppliedRule[];
  /** 被跳过的 rule（preCondition 不支持 / materialization=shape|unavailable） */
  unmaterializedRuleIds: string[];
}

/**
 * 从 ruleId "claude-code.tool.{ToolName}.v1" 提取工具名。
 * 仅对 section="tools" 的 rule 调用。
 * 返回 null 表示无法提取（格式不符）。
 */
function extractToolNameFromRuleId(ruleId: string): string | null {
  // 格式：claude-code.tool.{ToolName}.v{N}
  // MCP tools：claude-code.tool.mcp__{service}__{method}.v1
  const m = ruleId.match(/^claude-code\.tool\.([^.]+)\.v\d+$/);
  return m ? (m[1] ?? null) : null;
}

/**
 * 判断 tool rule 是否是 MCP tool（input_schema 用户配置决定，不可正向复现）。
 * MCP tool 的 ruleId 里工具名含有双下划线（mcp__service__method）。
 */
function isMcpToolRule(ruleId: string): boolean {
  const toolName = extractToolNameFromRuleId(ruleId);
  return toolName !== null && toolName.startsWith("mcp__");
}

/**
 * 从 CONTEXT_LEDGER_RULES 的 reconstruction 字段正向生成 expected segments。
 * 仅读取 rule.reconstruction，不依赖 proxy 数据。
 */
export function materializeHarnessRules(
  rules: ContextLedgerRule[],
  _boundary: QueryBoundary,
  runtimeSnapshot?: HarnessRuntimeSnapshot,
): MaterializeResult {
  const segments: ContextSegment[] = [];
  const appliedRules: AppliedRule[] = [];
  const unmaterializedRuleIds: string[] = [];

  // enabledToolNames 是否已知：用于决定是否生成全量 tool segment
  const enabledToolNames = runtimeSnapshot?.enabledToolNames;
  const toolEnableMode: "explicit" | "all_verified_unfiltered" =
    Array.isArray(enabledToolNames) ? "explicit" : "all_verified_unfiltered";

  // ── tools[] 两阶段处理 ──────────────────────────────────────────────────────
  //
  // harness assembleToolPool()（sourcemap tools.ts:362）的顺序规则：
  //   内置工具先按 name.localeCompare() 字母序，MCP 工具紧随其后同样字母序。
  //   两段不混排（为 prompt cache 稳定性）。
  //
  // 因此 tool segment 必须独立于其他 section 单独收集，再按正确顺序插入。
  // 不能在主循环 order++ 流程中内联生成——那样顺序由 CONTEXT_LEDGER_RULES 声明顺序
  // 决定（Edit→Write→Read→...），与 harness 字母序（AskUserQuestion→Bash→CronCreate→...）
  // 不一致，会导致 sourceMap 路径 reqBody.tools[i] 错位及虚假 order_mismatch finding。
  //
  // 实现：先收集所有通过筛选的 tool rule，按 toolName localeCompare 排序，再统一分配 order。
  interface PendingToolEntry {
    rule: ContextLedgerRule;
    toolName: string;          // 用于排序
    isMcp: boolean;            // 内置工具先，MCP 工具后
    toolSchemaJson: string | null;
    isDynamicShape?: boolean;  // Agent/Bash/ScheduleWakeup 等动态 schema，无法 exact
  }
  const pendingToolEntries: PendingToolEntry[] = [];

  // tool segment order 从 RULE_ORDER_TOOL_BASE 起，与 mutation segment（0 起步，上限约数百）不冲突。
  // system/messages rule segment 从 RULE_ORDER_NON_TOOL_BASE 起，与 tools 段分离便于 reconciliation order 对比。
  // 两个范围均仅在 materializeHarnessRules 内部使用；buildTargetRequest 侧按 section 分组后重新索引。
  let order = RULE_ORDER_TOOL_BASE;
  let nonToolOrder = RULE_ORDER_NON_TOOL_BASE;

  for (const rule of rules) {
    const recon = rule.reconstruction;
    // 无 reconstruction 定义的 rule（attribution-only）直接跳过
    if (!recon) continue;

    // preCondition 评估：传入 runtimeSnapshot；snapshot 为 undefined 时非 always 条件保守 skip
    const condResult = evaluatePreConditionConservative(recon.preCondition, runtimeSnapshot);
    if (condResult === "skip") {
      unmaterializedRuleIds.push(rule.ruleId);
      continue;
    }

    // materialization 路由
    switch (recon.materialization) {
      case "exact_text": {
        // ── tools[] 专项处理（reconstruct-05）────────────────────────────
        if (recon.emits.section === "tools") {
          const toolName = extractToolNameFromRuleId(rule.ruleId);
          const isMcp = isMcpToolRule(rule.ruleId);

          // P2-2 修复：先做启用过滤（对所有 tool rules 统一处理，包括 MCP）。
          // 只有在 enabledToolNames 明确且不包含本工具时才静默跳过（不是错误）。
          // MCP tool 的 skip 判断在启用过滤之后——这样当 enabledToolNames 明确
          // 且不含任何 MCP 工具时，MCP rules 就不会错误地进入 unmaterializedRuleIds。
          if (toolEnableMode === "explicit") {
            const nameToCheck = toolName ?? rule.ruleId;
            if (!enabledToolNames!.includes(nameToCheck)) {
              // 工具未启用，静默跳过（不计入 unmaterializedRuleIds，不是重建缺口）
              continue;
            }
          }

          // MCP tool：input_schema 由用户 MCP server 配置决定，无法正向复现。
          // 此检查在启用过滤之后——已被过滤的 MCP tools 不会到达这里。
          if (isMcp) {
            unmaterializedRuleIds.push(rule.ruleId);
            continue;
          }

          // 查找 contentPattern：rule 自带优先，否则从 BUILTIN_TOOL_SCHEMA_JSON 查找
          let toolSchemaJson: string | null = recon.emits.contentPattern ?? null;
          if (!toolSchemaJson && toolName) {
            toolSchemaJson = BUILTIN_TOOL_SCHEMA_JSON[toolName] ?? null;
          }

          if (!toolSchemaJson) {
            // tool schema 未注册（既无 contentPattern 也不在 BUILTIN_TOOL_SCHEMA_JSON）
            unmaterializedRuleIds.push(rule.ruleId);
            continue;
          }

          // 收集到待排序列表，排序后统一分配 order（P2-1 修复）
          pendingToolEntries.push({ rule, toolName: toolName ?? rule.ruleId, isMcp, toolSchemaJson });
          continue;
        }
        // ── 非 tools section 的 exact_text（system / messages）────────────

        const exactText = recon.emits.contentPattern ?? exactTextFromAttributionPattern(rule);
        // 有 contentPattern 或 exact attribution pattern 才能生成 exact_text segment。
        if (!exactText) {
          // contentPattern=null 且 attribution 不是 exact：依赖运行时 snapshot 或源码函数填充，
          // 保守 skip，避免用 prefix/regex 伪造完整文本。
          unmaterializedRuleIds.push(rule.ruleId);
          continue;
        }
        const seg = buildRuleSegment({
          rule,
          order: nonToolOrder++,
          materialization: "exact_text",
          contentText: exactText,
        });
        segments.push(seg);
        appliedRules.push(ruleToAppliedRule(rule));
        break;
      }

      case "normalized_text": {
        // contentPattern 有模板文本时，生成 presence 语义 segment（带 text 占位）；
        // contentPattern=null 时同样生成 presence 占位（无 text）。
        // 重要：不伪造内容——normalized_text 的动态字段需 runtime snapshot 填充，
        // 占位符未全部解析时只确认"此 segment 应当存在"。
        const rendered = recon.emits.contentPattern
          ? renderRuleTemplate(recon.emits.contentPattern, runtimeSnapshot)
          : null;
        const seg = buildRuleSegment({
          rule,
          order: nonToolOrder++,
          materialization: "normalized_text",
          contentText: rendered ?? undefined,
        });
        segments.push(seg);
        appliedRules.push(ruleToAppliedRule(rule));
        break;
      }

      case "presence": {
        // 内容动态不可复现（如 billing header）→ 只生成存在性占位 segment，无 text
        const seg = buildRuleSegment({
          rule,
          order: nonToolOrder++,
          materialization: "presence",
          contentText: undefined,
        });
        segments.push(seg);
        appliedRules.push(ruleToAppliedRule(rule));
        break;
      }

      case "shape": {
        // system section 的 shape rule 进入 expected 作为"应存在"先验，不填 text。
        // tools section 的 shape rule（Agent/Bash/ScheduleWakeup）也必须进入
        // pendingToolEntries，否则 reqBody.tools[i] sourceMap 索引漂移。
        // messages section 的 shape 仍跳过（per-turn 注入，无法先验确定）。
        if (recon.emits.section === "tools") {
          const toolName = extractToolNameFromRuleId(rule.ruleId);
          const isMcp = isMcpToolRule(rule.ruleId);
          // 启用过滤：动态 tool 同样受 enabledToolNames 控制
          if (toolEnableMode === "explicit") {
            const nameToCheck = toolName ?? rule.ruleId;
            if (!enabledToolNames!.includes(nameToCheck)) {
              continue;
            }
          }
          // shape tool 以 toolSchemaJson=null + isDynamicShape=true 进入排序列表，
          // 最终 materialize 为 presence 占位 segment，保住 tools[] 索引正确。
          pendingToolEntries.push({
            rule,
            toolName: toolName ?? rule.ruleId,
            isMcp,
            toolSchemaJson: null,
            isDynamicShape: true,
          });
          continue;
        }
        if (recon.emits.section !== "system" || !runtimeSnapshot) {
          unmaterializedRuleIds.push(rule.ruleId);
          break;
        }
        const seg = buildRuleSegment({
          rule,
          order: nonToolOrder++,
          materialization: "shape",
          contentText: undefined,
        });
        segments.push(seg);
        appliedRules.push(ruleToAppliedRule(rule));
        break;
      }
      case "unavailable":
        // unavailable 无法产出可信文本，保守跳过
        unmaterializedRuleIds.push(rule.ruleId);
        break;
    }
  }

  // ── P2-1 修复：按 harness 字母序排序后统一分配 order ────────────────────────
  //
  // harness assembleToolPool()（sourcemap tools.ts:362）：
  //   内置工具按 name.localeCompare() 字母序 → MCP 工具按字母序（两段不混排）。
  // 此处用 localeCompare 排序，再按内置/MCP 分段，确保 segment order 与 proxy 索引一致。
  pendingToolEntries.sort((a, b) => {
    // 内置工具（!isMcp）在前，MCP 工具在后
    if (a.isMcp !== b.isMcp) return a.isMcp ? 1 : -1;
    return a.toolName.localeCompare(b.toolName);
  });

  for (const entry of pendingToolEntries) {
    const { rule, toolSchemaJson, isDynamicShape } = entry;

    // isDynamicShape=true：Agent/Bash/ScheduleWakeup 等动态 schema tool，直接 presence 占位。
    // toolSchemaJson=null（非 dynamic）：schema 未注册，视为 parse_failed，同样 presence 降级。
    // 两种 presence 用不同 toolJsonParseStatus 区分，避免误导排查。
    let toolSchemaValid = !isDynamicShape && toolSchemaJson !== null;
    if (toolSchemaValid) {
      try {
        const parsed = JSON.parse(toolSchemaJson!) as unknown;
        if (!parsed || typeof parsed !== "object") toolSchemaValid = false;
      } catch {
        toolSchemaValid = false;
      }
    }

    const parseStatus = isDynamicShape
      ? "dynamic_schema"     // 已知动态，无法 exact，comparePolicy=presence_only
      : toolSchemaValid
        ? "ok"
        : "parse_failed";

    const seg = buildRuleSegment({
      rule,
      order: order++,           // tools section 使用 5000 段序号，与 nonToolOrder(6000+) 分离
      materialization: toolSchemaValid ? "exact_text" : "presence",
      contentText: toolSchemaValid ? toolSchemaJson! : undefined,
      extraMetadata: { toolEnableMode, toolJsonParseStatus: parseStatus },
    });
    segments.push(seg);
    appliedRules.push(ruleToAppliedRule(rule));
  }

  return { segments, appliedRules, unmaterializedRuleIds };
}

function exactTextFromAttributionPattern(rule: ContextLedgerRule): string | null {
  const attr = rule.attribution;
  if (!attr || attr.matchMode !== "exact") return null;
  if (!attr.pattern) return null;
  return attr.pattern;
}

function renderRuleTemplate(
  pattern: string,
  runtimeSnapshot?: HarnessRuntimeSnapshot,
): string | null {
  const values: Record<string, string | undefined> = {
    memoryDir: runtimeSnapshot?.autoMemoryPath,
    cwd: runtimeSnapshot?.cwd,
  };

  let missing = false;
  const rendered = pattern.replace(/\{([A-Za-z0-9_]+)\}/g, (placeholder, key) => {
    const value = values[key];
    if (value === undefined) {
      missing = true;
      return placeholder;
    }
    return value;
  });

  return missing ? null : rendered;
}

// evaluatePreConditionConservative：materializer 内部使用的包装，
// 传入 snapshot=undefined，"unknown"/"fail" 均视为 skip。
// 当 pipeline 传入真实 runtimeSnapshot 时，改为直接调用 evaluatePreCondition。
function evaluatePreConditionConservative(
  cond: RulePreCondition | undefined,
  snapshot?: HarnessRuntimeSnapshot,
): "pass" | "skip" {
  if (!cond) return "pass";
  const result = evaluatePreCondition(cond, snapshot);
  return result === "pass" ? "pass" : "skip";
}

interface BuildRuleSegmentOpts {
  rule: ContextLedgerRule;
  order: number;
  materialization: "exact_text" | "normalized_text" | "presence" | "shape";
  contentText: string | undefined;
  // 额外 metadata（如 toolEnableMode），合并到 segment.metadata 中
  extraMetadata?: Record<string, unknown>;
}

function buildRuleSegment(opts: BuildRuleSegmentOpts): ContextSegment {
  const { rule, order, materialization, contentText, extraMetadata } = opts;
  const recon = rule.reconstruction!;
  const emits = recon.emits;

  const sourceRef: SourceRef = {
    kind: "harness_rule",
    harness: {
      ruleId: rule.ruleId,
      version: rule.verifiedFor ?? undefined,
    },
    label: `rule:${rule.ruleId}`,
  };

  // 是否已 verified（对照 SUPPORTED_CLAUDE_CODE_VERSION 校对通过）
  const verified = isRuleVerified(rule);

  const seg: ContextSegment = {
    id: `rseg-${rule.ruleId}`,
    section: emits.section,
    category: emits.category,
    label: `${emits.section}/${emits.category}/${rule.ruleId}`,
    sourceRefs: [sourceRef],
    lifecycle: emits.lifecycle,
    flags: emits.flags ? [...emits.flags] : undefined,
    order,
    metadata: pruneMetadata({
      ruleId: rule.ruleId,
      // 标注 materialization 类型，供 target-request-builder 分桶识别
      harness_rule_materialization: materialization,
      // 标注是否 verified；未 verified 的 segment 不应进入 evidence-backed exact 桶
      ruleVerified: verified,
      ruleVerifiedFor: rule.verifiedFor ?? undefined,
      // 触发器类型（always_per_query / from_jsonl / from_memory / from_harness_state）
      reconstructionTrigger: recon.trigger,
      // 额外 metadata（如 toolEnableMode、toolJsonParseStatus）
      ...(contentText === undefined && rule.attribution?.pattern
        ? {
            expectedPattern: rule.attribution.pattern,
            expectedPatternMode: rule.attribution.matchMode,
          }
        : {}),
      ...extraMetadata,
    }),
  };

  if (contentText !== undefined && contentText.length > 0) {
    seg.contentRef = { kind: "inline", text: contentText, charCount: contentText.length };
    seg.charCount = contentText.length;
    seg.tokenEstimate = Math.round(contentText.length / 4);
    // exact_text segment 计算 rawHash，供 reconciliation M1 精确匹配
    seg.rawHash = sha256Short(contentText);
  }

  return seg;
}

function ruleToAppliedRule(rule: ContextLedgerRule): AppliedRule {
  return {
    ruleId: rule.ruleId,
    source: "harness_rule",
    version: rule.verifiedFor ?? undefined,
    // verified rule 才算 exact confidence；未 verified 降为 inferred
    confidence: isRuleVerified(rule) ? "exact" : "inferred",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// RulePreCondition evaluator
//
// 设计约束（来自 reconstruct.md）：
//   - 未知值必须返回 "unknown"，不得默认 pass
//   - "unknown" → caller 应保守 skip rule，写入 unmaterializedRules
//   - runtimeSnapshot 为 undefined 时，非 always 条件全部返回 "unknown"
// ─────────────────────────────────────────────────────────────────────────────

export function evaluatePreCondition(
  cond: RulePreCondition,
  snapshot: HarnessRuntimeSnapshot | undefined,
): PreConditionResult {
  switch (cond.type) {
    case "always":
      return "pass";

    case "userType": {
      if (!snapshot) return "unknown";
      const ut = snapshot.userType;
      if (ut === undefined) return "unknown";
      if (ut === "unknown") return "unknown";
      return ut === cond.value ? "pass" : "fail";
    }

    case "harnessFlag": {
      if (!snapshot) return "unknown";
      const flags = snapshot.featureFlags;
      if (!flags) return "unknown";
      // 支持 "!xxx" 否定前缀（rule-registry 中用于 isForkSubagentEnabled 等取反条件）
      const negate = cond.flag.startsWith("!");
      const actualFlag = negate ? cond.flag.slice(1) : cond.flag;
      const val = flags[actualFlag];
      if (val === undefined) return "unknown";
      if (val === "unknown") return "unknown";
      const result = Boolean(val);
      return (negate ? !result : result) ? "pass" : "fail";
    }

    case "settingsField": {
      if (!snapshot) return "unknown";
      const settings = snapshot.settings;
      if (!settings) return "unknown";
      const fieldVal = settings[cond.field];

      switch (cond.op) {
        case "null":
          return fieldVal == null ? "pass" : "fail";
        case "notNull":
          return fieldVal != null ? "pass" : "fail";
        case "eq":
          if (fieldVal === undefined) return "unknown";
          return String(fieldVal) === cond.value ? "pass" : "fail";
        case "neq":
          if (fieldVal === undefined) return "unknown";
          return String(fieldVal) !== cond.value ? "pass" : "fail";
        default:
          return "unknown";
      }
    }

    case "harnessState":
      // 自由文本描述，无法机器评估——保守返回 unknown
      return "unknown";

    case "all": {
      let anyUnknown = false;
      for (const sub of cond.conditions) {
        const r = evaluatePreCondition(sub, snapshot);
        if (r === "fail") return "fail";
        if (r === "unknown") anyUnknown = true;
      }
      return anyUnknown ? "unknown" : "pass";
    }

    default:
      return "unknown";
  }
}

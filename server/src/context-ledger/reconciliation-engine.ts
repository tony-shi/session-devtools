// Reconciliation Engine
// 输入：ProxyQuerySnapshot + ProxySegmentAttribution[] + ExpectedQueryContext
// 输出：ReconciliationReport（含 AlignmentRef[]、ReconciliationFinding[]、CoverageSummary）
//
// 设计原则（docs/draft/context/context-core-background.md §核心数据原则）：
//   - proxy 是 ground truth；不用 proxy diff 生成 ContextMutation。
//   - 无法解释的 proxy segment 进入 proxy_only finding，不静默吞掉。
//   - attribution-only 和 expected-match 区别：
//       * attribution-only：proxy-first 反向归因已识别类别/机制，但没有对应 expected segment。
//         典型情况：system_prompt / tools_schema / system_reminder（U1-U3 规则未实现）。
//       * expected-match：expected segment 通过内容 hash / tool_use_id / heuristic 与
//         proxy segment 成功对齐。
//
// 匹配策略优先级（依次尝试，命中即停止）：
//   M1 rawHash exact match
//   M2 normalizedHash match
//   M3 tool_use_id match（tool_use ↔ tool_result 双向）
//   M4 category + role + order heuristic（same category、same role、order 差 ≤ 2）
//   M5 attribution-only fallback（proxy segment 有 attribution 但无 expected 对应）
//
// known_noise 优先处理：billing_noise category 的 proxy segment 直接归入
// server_side_attribution finding，不参与 expected 匹配流程。
//
// 未实现规则（U1-U5）导致的 unmatched proxy segments：
//   - system_prompt（3 blocks per fixture）
//   - tools_schema（34 / 40 tools per fixture）
//   - harness_injection / system_reminder（每个 user turn 头部）
//   - prior_session_history（multi-turn-human 首条 user message）
// 这些会产生 attribution_only finding，severity=warning，不计入 unexplained（因为
// attribution 层已识别类别）。真正 unknown（attribution.category === "unknown"）才计
// 入 unexplained，severity=critical。

import type {
  AgentKind,
  AlignmentBasis,
  AlignmentRef,
  ComparisonGrade,
  CoverageByCategory,
  CoverageSummary,
  ContextSegment,
  ExpectedQueryContext,
  FindingType,
  ProxyQuerySnapshot,
  ProxySegmentAttribution,
  ReconciliationFinding,
  ReconciliationReport,
  SegmentCategory,
  SourceRef,
  TargetRequest,
} from "./types";
import { getContextLedgerRule as getContextLedgerRuleById } from "./rule-registry";
import { computeRequestLevelExact } from "./target-request-builder";

// ─────────────────────────────────────────────────────────────────────────────
// 输入 / 输出
// ─────────────────────────────────────────────────────────────────────────────

export interface ReconcileInput {
  snapshot: ProxyQuerySnapshot;
  attributions: ProxySegmentAttribution[];
  expected?: ExpectedQueryContext;
  fixtureName?: string;
  targetRequest?: TargetRequest;
  proxyRequestBody?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 主入口
// ─────────────────────────────────────────────────────────────────────────────

export function reconcileClaudeContext(input: ReconcileInput): ReconciliationReport {
  const { snapshot, attributions, expected, fixtureName, targetRequest, proxyRequestBody } = input;

  const alignments: AlignmentRef[] = [];
  const findings: ReconciliationFinding[] = [];
  let alignCounter = 0;
  let findingCounter = 0;

  const nextAlignId = () => `align-${++alignCounter}`;
  const nextFindingId = () => `finding-${++findingCounter}`;

  // 建立快速查找索引（传入 parser 原始 segments 用于 jsonPath 反向映射）
  const attrBySegId = buildAttrBySegId(attributions, snapshot.segments);
  const expectedSegs = expected?.segments ?? [];
  // 追踪哪些 proxy segment / expected segment 已被匹配
  const matchedProxyIds = new Set<string>();
  const matchedExpectedIds = new Set<string>();

  // ── 第一步：server_side_attribution 直接处理 ─────────────────────────────
  // P1-3：attribution.category 为唯一权威，无 attribution 时落 unknown（不 fallback 到 parser）。
  // parser category 是 wire schema 的保守分类，不参与 reconcile 决策。
  for (const pseg of snapshot.segments) {
    const effectiveCategory = attrBySegId.get(pseg.id)?.category ?? "unknown";
    if (effectiveCategory !== "billing_noise") continue;
    matchedProxyIds.add(pseg.id);
    const align: AlignmentRef = {
      id: nextAlignId(),
      // P3-2：server_side_attribution 不构成内容对账，复现层级标 presence
      comparisonGrade: "presence",
      confidence: "exact",
      expectedSegmentIds: [],
      proxySegmentIds: [pseg.id],
      // P0-2：billing_noise 用 server_side_attribution basis，明确与 evidence-backed 分离
      basis: "server_side_attribution",
      note: "billing_noise: known server-side overhead, excluded from evidence-backed coverage",
    };
    alignments.push(align);
    findings.push({
      id: nextFindingId(),
      // P3-2：known_noise 重命名为 server_side_attribution
      type: "server_side_attribution",
      severity: "info",
      category: "billing_noise",
      proxySegmentIds: [pseg.id],
      alignmentIds: [align.id],
      message: `Known billing noise (${pseg.charCount ?? 0} chars) — harness overhead, not counted as unexplained.`,
    });
  }

  // ── 第二步：expected segment 逐一与 proxy 匹配（M1-M4）────────────────────
  if (expected) {
    // 构建 proxy 侧的各种索引
    const proxyByRawHash = new Map<string, ContextSegment[]>();
    const proxyByNormHash = new Map<string, ContextSegment[]>();
    const proxyByToolUseId = new Map<string, ContextSegment[]>();

    for (const pseg of snapshot.segments) {
      if (matchedProxyIds.has(pseg.id)) continue;
      if (pseg.rawHash) {
        const arr = proxyByRawHash.get(pseg.rawHash) ?? [];
        arr.push(pseg);
        proxyByRawHash.set(pseg.rawHash, arr);
      }
      if (pseg.normalizedHash) {
        const arr = proxyByNormHash.get(pseg.normalizedHash) ?? [];
        arr.push(pseg);
        proxyByNormHash.set(pseg.normalizedHash, arr);
      }
      if (pseg.toolUseId) {
        const arr = proxyByToolUseId.get(pseg.toolUseId) ?? [];
        arr.push(pseg);
        proxyByToolUseId.set(pseg.toolUseId, arr);
      }
    }

    // N:1 / 1:N merge 路径已移除（历史上曾设计为 R-MERGE-N1 / R-MERGE-1N）。
    // 经 Claude Code 2.1.x 全量本地扫描确认均不会触发：proxy parser 已将
    // multi-block tool_result 拼接为单 segment，两侧 rawHash 一致，M1 直接命中。
    for (const eseg of expectedSegs) {
      if (matchedExpectedIds.has(eseg.id)) continue;

      const matchResult = matchOneExpected(
          eseg,
          snapshot.segments,
          matchedProxyIds,
          matchedExpectedIds,
          proxyByRawHash,
          proxyByNormHash,
          proxyByToolUseId,
          attrBySegId,
        );

        if (matchResult) {
          for (const id of matchResult.matchedExpectedIds) matchedExpectedIds.add(id);
          for (const id of matchResult.matchedProxyIds) matchedProxyIds.add(id);
          const align: AlignmentRef = {
            id: nextAlignId(),
            ...matchResult.alignment,
          };
          alignments.push(align);

          const charDiff =
            (eseg.charCount ?? 0) -
            matchResult.matchedProxyIds
              .map((id) => snapshot.segments.find((s) => s.id === id)?.charCount ?? 0)
              .reduce((a, b) => a + b, 0);

          // token_mismatch finding（仅当 char 差异 > 5%）
          const proxyChars = matchResult.matchedProxyIds
            .map((id) => snapshot.segments.find((s) => s.id === id)?.charCount ?? 0)
            .reduce((a, b) => a + b, 0);
          const expectedChars = eseg.charCount ?? 0;

          // P1-2：tail_injection_chars 协议已删除，expected 侧加法重建已包含 smoosh 文本。
          // 直接比较 expectedChars vs proxyChars，token_mismatch 阈值 5%。
          const diff = expectedChars - proxyChars;
          const pct = proxyChars > 0 ? Math.abs(diff) / proxyChars : 0;

          if (pct > 0.05 && diff !== 0) {
            findings.push({
              id: nextFindingId(),
              type: "token_mismatch",
              severity: "warning",
              category: eseg.category,
              expectedSegmentIds: [eseg.id],
              proxySegmentIds: matchResult.matchedProxyIds,
              alignmentIds: [align.id],
              charDiff: Math.abs(diff),
              tokenDiffEstimate: Math.round(Math.abs(diff) / 4),
              message: `char mismatch: expected ${expectedChars}, proxy ${proxyChars} (${(pct * 100).toFixed(1)}% diff)`,
            });
          }

          // order_mismatch finding（仅当匹配是 M3 tool_use_id 或 M1/M2 hash 时才对比——
          // M4 heuristic 本身就按相对位置取第一个候选，绝对 order 差值必然很大（量纲不同），
          // 不应产生误报；只在有内容锚点的匹配下做 order 核对）。
          // TODO(prior-session-prefix): --resume 场景下 prefix 缺少历史 turn 时，
          // order 偏移是预期内的，应将 severity 降为 info。检测逻辑见 jsonl-mutation-parser.ts。
          const proxyOrder = matchResult.matchedProxyIds
            .map((id) => snapshot.segments.find((s) => s.id === id)?.order ?? -1)
            .reduce((a, b) => Math.min(a, b), Infinity);
          const expectedOrder = eseg.order ?? -1;
          // 只在有内容锚点（M1/M2/M3）的情况下做 order 核对；M4 heuristic 跳过。
          const isMeaningfulMatch =
            matchResult.alignment.basis === "raw_hash" ||
            matchResult.alignment.basis === "normalized_hash" ||
            matchResult.alignment.basis === "tool_use_id" ||
            matchResult.alignment.basis === "rule_id";
          // rule_id match 的 expected segment 来自 R9（system/tools section），
          // order 用负数起始，与 proxy 的绝对 order 差距极大，order_mismatch 无意义，跳过。
          const isR9Segment = matchResult.alignment.basis === "rule_id";
          if (
            isMeaningfulMatch &&
            !isR9Segment &&
            expectedOrder >= 0 &&
            proxyOrder !== Infinity &&
            Math.abs(expectedOrder - proxyOrder) > 3
          ) {
            findings.push({
              id: nextFindingId(),
              type: "order_mismatch",
              severity: "warning",
              category: eseg.category,
              expectedSegmentIds: [eseg.id],
              proxySegmentIds: matchResult.matchedProxyIds,
              alignmentIds: [align.id],
              message: `order mismatch: expected order ${expectedOrder}, proxy order ${proxyOrder}`,
            });
          }

          // heuristic（M4 category+role）无强证据时降级为 suspect_match，
          // 避免不同 turn 的同类 segment（如不同历史的 user_message）产生虚假 matched。
          // M1/M2/M3 有内容锚点，归为 matched 或 approximate_match。
          const findingType: FindingType =
            matchResult.alignment.basis === "category"
              ? "suspect_match"
              : matchResult.alignment.comparisonGrade === "exact" ||
                  matchResult.alignment.comparisonGrade === "normalized"
                ? "matched"
                : "approximate_match";

          findings.push({
            id: nextFindingId(),
            type: findingType,
            severity: findingType === "suspect_match" ? "warning" : "info",
            category: eseg.category,
            expectedSegmentIds: [eseg.id],
            proxySegmentIds: matchResult.matchedProxyIds,
            mutationIds: eseg.metadata?.sourceMutationId
              ? [eseg.metadata.sourceMutationId as string]
              : undefined,
            alignmentIds: [align.id],
            message: `${findingType}: ${eseg.category} via ${matchResult.alignment.basis}${findingType === "suspect_match" ? " — no content anchor, not evidence-backed" : ""}`,
          });
        }
    }

    // expected 侧未匹配的 segment
    for (const eseg of expectedSegs) {
      if (matchedExpectedIds.has(eseg.id)) continue;
      findings.push({
        id: nextFindingId(),
        // P3-2：unmatched_expected_segment 重命名为 expected_only
        type: "expected_only",
        severity: "warning",
        category: eseg.category,
        expectedSegmentIds: [eseg.id],
        charDiff: eseg.charCount,
        tokenDiffEstimate: eseg.tokenEstimate,
        message: `expected segment ${eseg.category} (${eseg.charCount ?? 0} chars) has no proxy counterpart — likely TODO(retry-skill-listing) or unimplemented harness rule`,
        evidence: eseg.sourceRefs,
      });
    }
  }

  // ── 第三步：attribution-only fallback（未被 expected 匹配的 proxy segments）──
  for (const pseg of snapshot.segments) {
    if (matchedProxyIds.has(pseg.id)) continue;

    const attr = attrBySegId.get(pseg.id);
    const isUnknown = !attr || attr.category === "unknown";
    const isAttributionOnly = attr && attr.category !== "unknown";

    if (isAttributionOnly && attr) {
      // attribution 已识别类别但 expected 没有对应 segment（U1-U5 未实现规则）
      matchedProxyIds.add(pseg.id);
      // P1-3：category 字段统一用 attribution.category（权威），不用 pseg.category（parser draft）
      const effectiveCat = attr.category;
      const align: AlignmentRef = {
        id: nextAlignId(),
        // P3-2：attribution_only 无 expected 内容锚点，复现层级标 presence
        comparisonGrade: "presence",
        // alignment confidence 沿用 attribution 的 materializationConfidence（能否复现）
        confidence: attr.materializationConfidence,
        expectedSegmentIds: [],
        proxySegmentIds: [pseg.id],
        // 用独立 basis 与 presence 预留路径分离，确保 coverage 桶正交
        basis: "attribution_only",
        note: `attribution-only: ${attr.mechanism} (no expected segment — unimplemented rule)`,
      };
      alignments.push(align);
      findings.push({
        id: nextFindingId(),
        // P3-2：attribution-only 缺口用专属 finding type，不再借用 expected_only
        type: "attribution_only",
        severity: "warning",
        category: effectiveCat,
        proxySegmentIds: [pseg.id],
        attributionIds: [attr.id],
        alignmentIds: [align.id],
        charDiff: pseg.charCount,
        tokenDiffEstimate: pseg.tokenEstimate,
        message: `attribution-only: ${effectiveCat} (${pseg.charCount ?? 0} chars) identified by ${attr.mechanism} but no expected segment — unimplemented rule covers this category`,
      });
    } else if (isUnknown) {
      // 完全无法解释（无 attribution，parser category 仅作 draft，finding category 用 "unknown"）
      findings.push({
        id: nextFindingId(),
        // P3-2：unmatched_proxy_segment 重命名为 proxy_only
        type: "proxy_only",
        severity: "critical",
        category: "unknown",
        proxySegmentIds: [pseg.id],
        attributionIds: attr ? [attr.id] : undefined,
        charDiff: pseg.charCount,
        tokenDiffEstimate: pseg.tokenEstimate,
        message: `unmatched proxy segment: ${pseg.charCount ?? 0} chars — no attribution and no expected segment`,
        evidence: pseg.sourceRefs,
      });
    }
  }

  // ── 第四步：coverage 计算 ────────────────────────────────────────────────
  const coverage = computeCoverage(snapshot, attributions, matchedProxyIds, matchedExpectedIds, expected, findings, alignments);
  const requestLevelExact = targetRequest
    ? computeRequestLevelExact({
        snapshot,
        targetRequest,
        proxyRequestBody,
        hasSegmentEvidence:
          coverage.wireExactChars + coverage.canonicalExactChars + coverage.templateChars > 0,
      })
    : undefined;
  if (requestLevelExact) coverage.requestLevelExact = requestLevelExact.level;

  // ── 第五步：P1-1 regex_too_loose finding（placeholderRatio > 60%）────────
  // 对每条 attribution，若 evidence.placeholderRatio > 0.6，说明该 rule pattern 过宽。
  for (const attr of attributions) {
    if (!attr.evidence || attr.evidence.placeholderRatio <= 0.6) continue;
    const segChars = attr.charCount ?? 0;
    findings.push({
      id: nextFindingId(),
      type: "regex_too_loose",
      severity: "warning",
      category: attr.category,
      proxySegmentIds: attr.proxySegmentIds,
      attributionIds: [attr.id],
      message: `rule ${attr.ruleId}: placeholderRatio=${(attr.evidence.placeholderRatio * 100).toFixed(0)}% (${attr.evidence.placeholderChars}/${segChars} chars) — pattern anchors too little literal text`,
    });
  }

  // ── 第六步：api_error_retry finding（从 expected metadata 读取）──────────
  if (expected?.metadata?.retryDroppedMutationCount && (expected.metadata.retryDroppedMutationCount as number) > 0) {
    findings.push({
      id: nextFindingId(),
      type: "api_error_retry",
      severity: "info",
      message: `api_error retry detected: ${expected.metadata.retryDroppedMutationCount} mutation(s) from failed attempt dropped by R7`,
    });
  }

  const report: ReconciliationReport = {
    schemaVersion: "context-ledger.report.v1",
    id: `recon-${snapshot.queryId}`,
    agentKind: snapshot.agentKind as AgentKind,
    sessionId: snapshot.sessionId,
    queryId: snapshot.queryId,
    snapshot,
    proxyAttributions: attributions,
    expected,
    alignments,
    findings,
    coverage,
    generatedAt: new Date().toISOString(),
  };

  if (snapshot.agentId) report.agentId = snapshot.agentId;
  if (snapshot.subagentId) report.subagentId = snapshot.subagentId;
  if (snapshot.parentAgentId) report.parentAgentId = snapshot.parentAgentId;
  if (fixtureName) report.fixtureName = fixtureName;
  if (targetRequest) report.targetRequest = targetRequest;
  if (requestLevelExact) report.requestLevelExact = requestLevelExact;

  return report;
}

// ─────────────────────────────────────────────────────────────────────────────
// 匹配逻辑
// ─────────────────────────────────────────────────────────────────────────────

interface MatchResult {
  alignment: Omit<AlignmentRef, "id">;
  matchedProxyIds: string[];
  matchedExpectedIds: string[];
}

function matchOneExpected(
  eseg: ContextSegment,
  proxySegs: ContextSegment[],
  matchedProxyIds: Set<string>,
  matchedExpectedIds: Set<string>,
  proxyByRawHash: Map<string, ContextSegment[]>,
  proxyByNormHash: Map<string, ContextSegment[]>,
  proxyByToolUseId: Map<string, ContextSegment[]>,
  attrBySegId: Map<string, ProxySegmentAttribution>,
): MatchResult | null {
  // M1: rawHash exact match
  if (eseg.rawHash) {
    const candidates = (proxyByRawHash.get(eseg.rawHash) ?? []).filter(
      (s) => !matchedProxyIds.has(s.id),
    );
    if (candidates.length > 0) {
      const pseg = candidates[0];
      return {
        alignment: {
          comparisonGrade: "exact",
          confidence: "exact",
          expectedSegmentIds: [eseg.id],
          proxySegmentIds: [pseg.id],
          basis: "raw_hash" as AlignmentBasis,
          attributionIds: attrBySegId.has(pseg.id) ? [attrBySegId.get(pseg.id)!.id] : undefined,
        },
        matchedProxyIds: [pseg.id],
        matchedExpectedIds: [eseg.id],
      };
    }
  }

  // M2: normalizedHash match
  if (eseg.normalizedHash) {
    const candidates = (proxyByNormHash.get(eseg.normalizedHash) ?? []).filter(
      (s) => !matchedProxyIds.has(s.id),
    );
    if (candidates.length > 0) {
      const pseg = candidates[0];
      return {
        alignment: {
          comparisonGrade: "normalized",
          confidence: "estimated",
          expectedSegmentIds: [eseg.id],
          proxySegmentIds: [pseg.id],
          basis: "normalized_hash" as AlignmentBasis,
          attributionIds: attrBySegId.has(pseg.id) ? [attrBySegId.get(pseg.id)!.id] : undefined,
        },
        matchedProxyIds: [pseg.id],
        matchedExpectedIds: [eseg.id],
      };
    }
  }

  // M3: tool_use_id match
  if (eseg.toolUseId) {
    const candidates = (proxyByToolUseId.get(eseg.toolUseId) ?? []).filter(
      (s) => !matchedProxyIds.has(s.id) && s.category === eseg.category,
    );
    if (candidates.length > 0) {
      const pseg = candidates[0];
      return {
        alignment: {
          comparisonGrade: "exact",
          confidence: "exact",
          expectedSegmentIds: [eseg.id],
          proxySegmentIds: [pseg.id],
          basis: "tool_use_id" as AlignmentBasis,
          mutationIds: eseg.metadata?.sourceMutationId
            ? [eseg.metadata.sourceMutationId as string]
            : undefined,
          attributionIds: attrBySegId.has(pseg.id) ? [attrBySegId.get(pseg.id)!.id] : undefined,
        },
        matchedProxyIds: [pseg.id],
        matchedExpectedIds: [eseg.id],
      };
    }
  }

  // M3.5: ruleId match（R9 attribution-generated segments 专用）
  // P2-3：命中后根据 rule.reconciliation.comparePolicy 决定 comparisonGrade/confidence。
  const esegRuleId = eseg.metadata?.ruleId as string | undefined;
  if (esegRuleId) {
    const candidates = proxySegs.filter((s) => {
      if (matchedProxyIds.has(s.id)) return false;
      const attr = attrBySegId.get(s.id);
      return attr?.ruleId === esegRuleId;
    });
    if (candidates.length > 0) {
      candidates.sort((a, b) =>
        Math.abs((a.charCount ?? 0) - (eseg.charCount ?? 0)) -
        Math.abs((b.charCount ?? 0) - (eseg.charCount ?? 0))
      );
      const pseg = candidates[0];
      const attr = attrBySegId.get(pseg.id);
      const rule = getContextLedgerRuleById(esegRuleId);
      const policy = rule?.reconciliation?.comparePolicy ?? "char_diff";
      const mat = rule?.reconstruction?.materialization;

      // P2-3 / P3-2：comparePolicy + materialization 决定 comparisonGrade
      //   policy=presence_only/structural → presence（仅验存在）
      //   policy=raw_hash/normalized_hash → presence（M1/M2 已先命中精确 hash，走到这里说明 hash 不等）
      //   policy=char_diff + materialization=exact_text → template（contentPattern 字面）
      //   policy=char_diff + 其他材质 → regex（normalized_text/shape，不能字面复现）
      let comparisonGrade: ComparisonGrade;
      let alignConfidence: AlignmentRef["confidence"];

      if (policy === "presence_only" || policy === "structural") {
        comparisonGrade = "presence";
        alignConfidence = "inferred";
      } else if (policy === "raw_hash" || policy === "normalized_hash") {
        comparisonGrade = "presence";
        alignConfidence = "inferred";
      } else if (mat === "exact_text") {
        comparisonGrade = "template";
        alignConfidence = "exact";
      } else {
        comparisonGrade = "regex";
        alignConfidence = "inferred";
      }

      return {
        alignment: {
          comparisonGrade,
          confidence: alignConfidence,
          expectedSegmentIds: [eseg.id],
          proxySegmentIds: [pseg.id],
          basis: "rule_id" as AlignmentBasis,
          attributionIds: attr ? [attr.id] : undefined,
          note: `ruleId match: ${esegRuleId} (${mat ?? "unknown"}, policy=${policy})`,
        },
        matchedProxyIds: [pseg.id],
        matchedExpectedIds: [eseg.id],
      };
    }
  }

  // M4: category + role heuristic（相对位置匹配）
  // 不用绝对 order 比较——expected 的 order 从 0 开始（messages 级），
  // proxy 的 order 是 system+tools+messages 的全局序号，两者差值可达 30+，
  // 绝对差值容差无法覆盖。改为：在同 category+role 的候选中，取 proxy 里
  // 未匹配的第 N 个（N = expected 里同 category+role 中 eseg 的相对位置）。
  //
  // P1-3：M4 category 匹配严格用 attribution.category（权威），不 OR parser category。
  // parser category 是 wire schema 保守分类，local_command_history 等语义类别只在 attribution 层可见。
  // 无 attribution 的 segment category 视为 "unknown"，不参与 M4 匹配（避免假阳性）。
  const heuristicCandidates = proxySegs.filter(
    (s) =>
      !matchedProxyIds.has(s.id) &&
      (attrBySegId.get(s.id)?.category ?? "unknown") === eseg.category &&
      s.role === eseg.role,
  );
  if (heuristicCandidates.length > 0) {
    // 按 proxy order 升序，取第一个（相对位置最靠前的未匹配 proxy segment）
    heuristicCandidates.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const pseg = heuristicCandidates[0];
    return {
      alignment: {
        // P3-2：M4 仅靠 category+role 启发式，无内容锚点，复现层级标 presence
        comparisonGrade: "presence",
        confidence: "inferred",
        expectedSegmentIds: [eseg.id],
        proxySegmentIds: [pseg.id],
        basis: "category" as AlignmentBasis,
        attributionIds: attrBySegId.has(pseg.id) ? [attrBySegId.get(pseg.id)!.id] : undefined,
        note: `heuristic: same category(${eseg.category}) + role(${eseg.role ?? "?"}) + order proximity`,
      },
      matchedProxyIds: [pseg.id],
      matchedExpectedIds: [eseg.id],
    };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 索引构建
// ─────────────────────────────────────────────────────────────────────────────

// inferClaudeProxyAttributions 是 mutating 的：它向传入的 snapshot.segments 追加
// 新 segment，且新 segment 的 ID 带 hash suffix（如 pseg-system-0-f599ede6d3871310），
// 与 parseClaudeProxyRequest 产生的原始 ID（pseg-system-0）不同。
//
// 为了让 attrBySegId 能用 parser 原始 ID 查找，建立两级索引：
//   1. 直接用 attribution.proxySegmentIds 中的 ID（可能是 attribution 自己生成的）
//   2. 用 attribution.sourceRefs 中的 jsonPath 匹配 parser segment 的 sourceRef jsonPath
//
// 优先级：直接 ID 匹配 > jsonPath 匹配。

function buildAttrBySegId(
  attributions: ProxySegmentAttribution[],
  parserSegments?: ContextSegment[],
): Map<string, ProxySegmentAttribution> {
  const m = new Map<string, ProxySegmentAttribution>();

  // 建立 jsonPath → parser segment ID 的反向索引
  const parserByJsonPath = new Map<string, string>();
  if (parserSegments) {
    for (const seg of parserSegments) {
      for (const ref of seg.sourceRefs) {
        if (ref.kind === "proxy" && ref.proxy.jsonPath) {
          parserByJsonPath.set(ref.proxy.jsonPath, seg.id);
        }
      }
    }
  }

  const set = (segId: string, attr: ProxySegmentAttribution) => {
    const existing = m.get(segId);
    // P3-2：用 materializationConfidence 排名（"能否复现"是 reconcile 关心的维度）
    if (
      !existing ||
      confidenceRank(attr.materializationConfidence) > confidenceRank(existing.materializationConfidence)
    ) {
      m.set(segId, attr);
    }
  };

  for (const attr of attributions) {
    // 直接 ID 映射（attribution 自己生成的 ID，可能与 parser ID 不同）
    for (const id of attr.proxySegmentIds) {
      set(id, attr);
    }

    // jsonPath 映射：把 attribution 的 sourceRef jsonPath 映射到 parser segment ID
    // 支持两种情况：
    //   (a) 精确匹配：attribution jsonPath === parser segment jsonPath
    //   (b) 前缀匹配：attribution jsonPath 是 parser segment jsonPath 的前缀
    //       例：attribution "reqBody.tools" 覆盖 parser "reqBody.tools[0]"..."reqBody.tools[33]"
    for (const ref of attr.sourceRefs) {
      if (ref.kind === "proxy" && ref.proxy.jsonPath) {
        const attrPath = ref.proxy.jsonPath;
        // (a) 精确匹配
        const parserId = parserByJsonPath.get(attrPath);
        if (parserId) {
          set(parserId, attr);
          continue;
        }
        // (b) 粒度不一致的两种已知情况：
        //
        // P2-5 分析：attribution 直接复用 parser segment 的 sourceRefs，
        // 因此精确匹配（上方 parserId = parserByJsonPath.get(attrPath)）已先命中，
        // 双向前缀 fallback 实际只处理以下已知遗留情况：
        //   string content 路径差异：极少数情况下 attribution 带 .content 后缀
        //   而 parser 没有（目前新的 local-command rule 已精确化，此情况基本不存在）。
        // 现有边界安全（只匹配 [ 或 . 分隔的子路径），保留 fallback 不做大重构。
        if (parserSegments) {
          for (const seg of parserSegments) {
            for (const segRef of seg.sourceRefs) {
              if (segRef.kind === "proxy" && segRef.proxy.jsonPath) {
                const segPath = segRef.proxy.jsonPath;
                const attrCoversParser =
                  segPath.startsWith(attrPath + "[") ||
                  segPath.startsWith(attrPath + ".");
                const parserCoversAttr =
                  attrPath.startsWith(segPath + "[") ||
                  attrPath.startsWith(segPath + ".");
                if (attrCoversParser || parserCoversAttr) {
                  set(seg.id, attr);
                }
              }
            }
          }
        }
      }
    }
  }

  return m;
}

function confidenceRank(c: string): number {
  if (c === "exact") return 3;
  if (c === "estimated") return 2;
  if (c === "inferred") return 1;
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Coverage 计算
// ─────────────────────────────────────────────────────────────────────────────

function computeCoverage(
  snapshot: ProxyQuerySnapshot,
  attributions: ProxySegmentAttribution[],
  matchedProxyIds: Set<string>,
  matchedExpectedIds: Set<string>,
  expected: ExpectedQueryContext | undefined,
  findings: ReconciliationFinding[],
  alignments: AlignmentRef[],
): CoverageSummary {
  const proxySegs = snapshot.segments;
  const attrBySegId = buildAttrBySegId(attributions, proxySegs);

  // 从 findings 中提取 evidence-backed 的 proxy segment ids（matched / approximate_match）
  // suspect_match 和 attribution-only 不计入 evidence-backed
  const evidenceBackedProxyIds = new Set<string>();
  for (const f of findings) {
    if (f.type === "matched" || f.type === "approximate_match") {
      for (const id of f.proxySegmentIds ?? []) evidenceBackedProxyIds.add(id);
    }
  }

  // 从 findings 收集 suspect_match proxy ids（category+role heuristic，无内容锚点）
  const suspectProxyIds = new Set<string>();
  for (const f of findings) {
    if (f.type === "suspect_match") {
      for (const id of f.proxySegmentIds ?? []) suspectProxyIds.add(id);
    }
  }

  // 从 alignments 计算 evidence-backed matched 的 char drift（|expectedChars - proxyChars|）
  const expectedById = new Map((expected?.segments ?? []).map((s) => [s.id, s]));
  let evidenceBackedCharDrift = 0;
  let evidenceBackedProxyCharsForDrift = 0;
  for (const align of alignments) {
    // 只统计 evidence-backed（raw_hash / normalized_hash / tool_use_id / rule_id 等）
    // category（M4 heuristic）和 attribution_only（无 expected）不参与 drift 计算
    if (align.basis === "category" || align.basis === "attribution_only") continue;
    const eChars = align.expectedSegmentIds
      .map((id) => expectedById.get(id)?.charCount ?? 0)
      .reduce((a, b) => a + b, 0);
    const pChars = align.proxySegmentIds
      .map((id) => proxySegs.find((s) => s.id === id)?.charCount ?? 0)
      .reduce((a, b) => a + b, 0);
    if (eChars > 0 && pChars > 0) {
      evidenceBackedCharDrift += Math.abs(eChars - pChars);
      evidenceBackedProxyCharsForDrift += pChars;
    }
  }

  let proxyChars = 0;
  let unexplainedProxyChars = 0;
  let serverSideChars = 0;       // billing_noise，basis=server_side_attribution
  let attributionOnlyChars = 0;  // 有归因但无 expected（U1-U5 缺口）
  // P3-3：suspect_match 字符数（category+role heuristic，无内容锚点），reconcile 层权威
  let suspectMatchChars = 0;

  const catMap = new Map<
    SegmentCategory,
    { proxyCount: number; matchedCount: number; proxyChars: number; matchedChars: number; proxyTokens: number; matchedTokens: number }
  >();

  for (const pseg of proxySegs) {
    const chars = pseg.charCount ?? 0;
    const tokens = pseg.tokenEstimate ?? Math.round(chars / 4);
    proxyChars += chars;

    // P1-3：attribution.category 为权威，无 attribution 时落 "unknown"（不 fallback 到 parser）
    const attr = attrBySegId.get(pseg.id);
    const cat = attr?.category ?? "unknown";
    if (!catMap.has(cat)) catMap.set(cat, { proxyCount: 0, matchedCount: 0, proxyChars: 0, matchedChars: 0, proxyTokens: 0, matchedTokens: 0 });
    const entry = catMap.get(cat)!;
    entry.proxyCount++;
    entry.proxyChars += chars;
    entry.proxyTokens += tokens;

    if (cat === "billing_noise") {
      serverSideChars += chars;
      entry.matchedCount++;
      entry.matchedChars += chars;
      entry.matchedTokens += tokens;
      continue;
    }

    const isAttributionKnown = attr && attr.category !== "unknown";
    const isEvidenceBacked = evidenceBackedProxyIds.has(pseg.id);
    const isSuspect = suspectProxyIds.has(pseg.id);
    const isAttrOnly = isAttributionKnown && !isEvidenceBacked && !isSuspect;

    if (isEvidenceBacked) {
      entry.matchedCount++;
      entry.matchedChars += chars;
      entry.matchedTokens += tokens;
    } else if (isAttrOnly) {
      attributionOnlyChars += chars;
      entry.matchedCount++;
      entry.matchedChars += chars;
      entry.matchedTokens += tokens;
    } else {
      unexplainedProxyChars += chars;
      // P3-3：suspect_match 是 unexplained 的子集（category heuristic，无内容锚点）
      if (isSuspect) suspectMatchChars += chars;
    }
  }

  const byCategory: CoverageByCategory[] = Array.from(catMap.entries())
    .sort((a, b) => b[1].proxyChars - a[1].proxyChars)
    .map(([category, v]) => ({
      category,
      proxySegmentCount: v.proxyCount,
      matchedProxySegmentCount: v.matchedCount,
      proxyChars: v.proxyChars,
      matchedProxyChars: v.matchedChars,
      proxyTokenEstimate: v.proxyTokens,
      matchedProxyTokenEstimate: v.matchedTokens,
    }));

  // P0-2：从 alignments 按 basis 推导各正交桶的字符数
  // 同一 proxy segment 取最强 basis（raw_hash > normalized_hash > tool_use_id > rule_id > ...）
  const BASIS_RANK: Record<string, number> = {
    raw_hash: 6, normalized_hash: 5, tool_use_id: 4, rule_id: 3,
    server_side_attribution: 2, harness_rule: 1, attribution_only: 1, category: 0,
  };
  const proxyBestBasis = new Map<string, { basis: string; ruleId?: string; comparisonGrade?: string }>();
  for (const align of alignments) {
    const rank = BASIS_RANK[align.basis] ?? 0;
    for (const pid of align.proxySegmentIds) {
      const cur = proxyBestBasis.get(pid);
      if (!cur || (BASIS_RANK[cur.basis] ?? 0) < rank) {
        const ruleId = align.note?.match(/^ruleId match: ([^\s]+)/)?.[1];
        // P2-3：保存 comparisonGrade，让 rule_id 分支能正确分桶
        // raw_hash/normalized_hash policy 失败后走 M3.5 时 comparisonGrade=presence，不应计入 template
        proxyBestBasis.set(pid, { basis: align.basis, ruleId, comparisonGrade: align.comparisonGrade });
      }
    }
  }

  let wireExactChars = 0;
  let canonicalExactChars = 0;
  let templateChars = 0;
  let regexChars = 0;
  let presenceChars = 0;

  for (const pseg of proxySegs) {
    const chars = pseg.charCount ?? 0;
    if (chars === 0) continue;
    const m = proxyBestBasis.get(pseg.id);
    if (!m) continue;
    switch (m.basis) {
      case "raw_hash":
      case "tool_use_id":
        wireExactChars += chars;
        break;
      case "normalized_hash":
        canonicalExactChars += chars;
        break;
      case "rule_id": {
        // P2-3：comparisonGrade=presence 表示 raw_hash/normalized_hash policy 失败后的降级
        // （M1/M2 hash 不等，M3.5 只靠 ruleId 识别存在），不应计入 template/regex 覆盖
        if (m.comparisonGrade === "presence") {
          presenceChars += chars;
        } else {
          const rule = m.ruleId ? getContextLedgerRuleById(m.ruleId) : undefined;
          if (rule?.reconstruction?.materialization === "exact_text") {
            templateChars += chars;
          } else {
            regexChars += chars;
          }
        }
        break;
      }
      case "harness_rule":
        // presence rule 正向预留路径（目前未实际触发）。
        // 注意：attribution-only fallback 已迁移到独立 basis "attribution_only"，
        // 不会再误进 presence 桶。
        presenceChars += chars;
        break;
      // server_side_attribution 已计入 serverSideChars，attribution_only 已计入 attributionOnlyChars，
      // 这两类不再重复进任何桶。
    }
  }

  const safeRatio = (c: number) => proxyChars > 0 ? round2(c / proxyChars) : 0;
  const alignedTextDrift = evidenceBackedProxyCharsForDrift > 0
    ? round2(evidenceBackedCharDrift / evidenceBackedProxyCharsForDrift)
    : 0;

  // P1-1：placeholderRatio = 所有 template/regex rule 命中字符中，captureGroup 字符占比
  // 只统计有 evidence 的 attribution（即 regex/template 命中）；presence/exact/unknown 不计入
  let evidenceTotalChars = 0;
  let evidencePlaceholderChars = 0;
  for (const attr of attributions) {
    if (!attr.evidence) continue;
    const segChars = attr.charCount ?? 0;
    evidenceTotalChars += segChars;
    // placeholderChars 占该 segment 的比例，再乘以 segment 字符数
    evidencePlaceholderChars += Math.round(attr.evidence.placeholderRatio * segChars);
  }
  const placeholderRatio = evidenceTotalChars > 0
    ? round2(evidencePlaceholderChars / evidenceTotalChars)
    : undefined;

  const summary: CoverageSummary = {
    proxySegmentCount: proxySegs.length,
    matchedProxySegmentCount: matchedProxyIds.size,
    unmatchedProxySegmentCount: proxySegs.length - matchedProxyIds.size,
    proxyChars,
    byCategory,
    // 正交分桶（字符数）
    wireExactChars,
    canonicalExactChars,
    templateChars,
    regexChars,
    presenceChars,
    serverSideChars,
    attributionOnlyChars,
    unexplainedChars: unexplainedProxyChars,
    // P3-3：suspect_match 是 unexplainedChars 的子集（category heuristic，无内容锚点）
    suspectMatchChars,
    suspectMatchCount: suspectProxyIds.size,
    // P3-3：evidence-backed drift 绝对字符数，供 scorecard 直接使用
    alignedTextDriftChars: evidenceBackedCharDrift,
    // 覆盖率比例
    wireExactCoverage: safeRatio(wireExactChars),
    canonicalExactCoverage: safeRatio(canonicalExactChars),
    templateCoverage: safeRatio(templateChars),
    regexCoverage: safeRatio(regexChars),
    presenceCoverage: safeRatio(presenceChars),
    serverSideCoverage: safeRatio(serverSideChars),
    attributionOnlyCoverage: safeRatio(attributionOnlyChars),
    unexplainedCoverage: safeRatio(unexplainedProxyChars),
    // 治理指标
    regexOverreachRisk: safeRatio(regexChars),
    ...(placeholderRatio !== undefined ? { placeholderRatio } : {}),
    alignedTextDrift,
  };

  if (expected) {
    summary.expectedSegmentCount = expected.segments.length;
    summary.unmatchedExpectedSegmentCount = expected.segments.filter(
      (s) => !matchedExpectedIds.has(s.id),
    ).length;
  }

  return summary;
}

function round2(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────────────────────

// suppress unused import warning
type _SourceRef = SourceRef;

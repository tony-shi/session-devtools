// Audit Pipeline
// 对每个 proxy+jsonl 匹配的 query 运行完整 reconciliation → scorecard → char diff
//
// 调用链（与 context-char-diff.ts 相同，不重复发明）：
//   parseClaudeProxyRequest → inferClaudeProxyAttributions
//   → parseClaudeJsonlMutations → reconstructExpectedClaudeContext
//   → reconcileClaudeContext → computeCharDiff → renderCharDiffHtml

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseClaudeProxyRequest } from "../proxy-snapshot-parser";
import type { ProxyRequestInput } from "../proxy-snapshot-parser";
import { inferClaudeProxyAttributions } from "../proxy-attribution";
import { parseClaudeJsonlMutations } from "../jsonl-mutation-parser";
import { reconstructExpectedClaudeContext } from "../expected-context-reconstructor";
import { reconcileClaudeContext } from "../reconciliation-engine";
import { computeCharDiff } from "../debug/char-diff";
import { renderCharDiffHtml } from "../debug/render-char-diff-html";
import type { ReconciliationReport } from "../types";
import type { CharDiffReport } from "../debug/char-diff";
import { computeScorecard } from "./scorecard";
import { getContextLedgerRule, SUPPORTED_CLAUDE_CODE_VERSION } from "../rule-registry";
import type {
  DiscoveredProxyRecord,
  PipelineResult,
  QueryKey,
} from "./types";
import { queryKeyHash } from "./paths";

// T0 --verified-only：过滤掉 verifiedFor===null 的 rule 的 attribution，不进入 R9 重建
function filterVerifiedAttributions(
  attributions: import("../types").ProxySegmentAttribution[],
): import("../types").ProxySegmentAttribution[] {
  return attributions.filter((attr) => {
    if (!attr.ruleId) return true;  // 无 ruleId 的 attribution（tool_use/tool_result wire）保留
    const rule = getContextLedgerRule(attr.ruleId);
    if (!rule) return true;  // 未知 rule 保留（不误杀）
    return rule.verifiedFor === SUPPORTED_CLAUDE_CODE_VERSION;
  });
}

export interface PipelineInput {
  proxy: DiscoveredProxyRecord;
  jsonlFile: string | null;  // null → proxy_without_jsonl
  /** T0 控制变量：禁用 R9（attribution 反写 system/tools expected segments）*/
  noR9?: boolean;
  /** T0 控制变量：verifiedFor===null 的 rule 不进入 evidenceBacked，仅 attribution-only */
  verifiedOnly?: boolean;
  /** E0-1：允许 jsonlFile=null 的 query 走 proxy-only attribution 路径（不解析 JSONL，reconcile 无 expected） */
  proxyOnly?: boolean;
}

export interface PipelineOutputData {
  report: ReconciliationReport;
  diff: CharDiffReport;
  diffHtml: string;
  attributions: import("../types").ProxySegmentAttribution[];
  reqBody: Record<string, unknown>;
}

// proxy text 反查（复用 context-char-diff.ts 的同逻辑）
function proxyTextForSeg(
  seg: import("../types").ContextSegment,
  reqBody: Record<string, unknown>,
): string | undefined {
  for (const ref of seg.sourceRefs) {
    if (ref.kind !== "proxy" || !ref.proxy.jsonPath) continue;
    const path = ref.proxy.jsonPath.startsWith("reqBody.")
      ? ref.proxy.jsonPath.slice("reqBody.".length)
      : ref.proxy.jsonPath;
    const value = walkPath(path, reqBody);
    if (value === undefined || value === null) return undefined;
    if (typeof value === "object" && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      if (typeof obj["text"] === "string") return obj["text"] as string;
      return JSON.stringify(obj, null, 2);
    }
    if (typeof value === "string") return value;
    return undefined;
  }
  return undefined;
}

function walkPath(path: string, root: unknown): unknown {
  const tokens = path.split(/\.|\[(\d+)\]/).filter((t) => t !== undefined && t !== "");
  let cur: unknown = root;
  for (const tok of tokens) {
    if (cur === null || cur === undefined) return undefined;
    const idx = parseInt(tok, 10);
    if (!isNaN(idx)) {
      cur = (cur as unknown[])[idx];
    } else {
      cur = (cur as Record<string, unknown>)[tok];
    }
  }
  return cur;
}

function injectProxyTexts(
  diff: CharDiffReport,
  report: ReconciliationReport,
  reqBody: Record<string, unknown>,
): CharDiffReport {
  const proxyById = new Map(report.snapshot.segments.map((s) => [s.id, s]));
  const entries = diff.entries.map((entry) => {
    if (!entry.proxyTexts?.length) return entry;
    const filled = entry.proxyTexts.map((pt) => {
      if (pt.text !== undefined) return pt;
      const seg = proxyById.get(pt.segmentId);
      if (!seg) return pt;
      const text = proxyTextForSeg(seg, reqBody);
      return text !== undefined ? { ...pt, text } : pt;
    });
    return { ...entry, proxyTexts: filled };
  });
  return { ...diff, entries };
}

// ─────────────────────────────────────────────────────────────────────────────
// 主函数
// ─────────────────────────────────────────────────────────────────────────────

export function runPipeline(input: PipelineInput): PipelineResult {
  const { proxy, jsonlFile, noR9, verifiedOnly } = input;
  const { queryKey, queryKeyHash: hash, timestamp, proxySourceFile, trafficLine } = proxy;

  // proxy_without_jsonl → skipped
  if (!jsonlFile || !existsSync(jsonlFile)) {
    return {
      queryKey,
      queryKeyHash: hash,
      status: "skipped",
      skipReason: "proxy_without_jsonl",
      proxySourceRef: `${proxySourceFile}:${trafficLine}`,
      timestamp,
    };
  }

  try {
    // 1. 解析 proxy
    const raw = proxy.raw;
    const reqBody = (raw["reqBody"] as Record<string, unknown>) ?? {};
    const proxyInput: ProxyRequestInput = {
      ts: raw["ts"] as string | undefined,
      startedAt: raw["startedAt"] as string | undefined,
      reqHeaders: raw["reqHeaders"] as Record<string, string> | undefined,
      reqBody: reqBody as ProxyRequestInput["reqBody"],
      _sse_events: raw["_sse_events"] as ProxyRequestInput["_sse_events"],
      _traffic_jsonl_line: trafficLine,
      // P0-3：传递原始字符串供 parser 计算 wire bytes hash
      _rawReqBodyText: (raw["_rawReqBodyText"] as string | null | undefined) ?? undefined,
    };

    const snapshot = parseClaudeProxyRequest(proxyInput, {
      proxyFile: proxySourceFile,
      queryId: queryKey.queryId,
    });

    // 2. 归因
    const snapForAttr = JSON.parse(
      JSON.stringify({ ...snapshot, metadata: { ...snapshot.metadata, rawBody: reqBody } }),
    ) as typeof snapshot;
    const allAttributions = inferClaudeProxyAttributions(snapForAttr);
    // T0 --verified-only：仅用于 R9 expected 生成，reconcile/scorecard 仍使用全量 attribution，
    // 保证 attributionOnlyCoverage / unexplainedCoverage / serverSideCoverage 等正交桶统计不失真。
    const r9Attributions = verifiedOnly ? filterVerifiedAttributions(allAttributions) : allAttributions;

    // 3. 解析 JSONL
    const jsonlRaw = readFileSync(jsonlFile, "utf-8");
    const parsed = parseClaudeJsonlMutations(jsonlRaw, { jsonlFile });

    // 4. 重建 expected（P0-1：R9 严格正向，不再需要 proxySegmentsById）
    const expected = reconstructExpectedClaudeContext({
      mutations: parsed.mutations,
      boundary: {
        queryId: queryKey.queryId,
        proxyTimestamp: snapshot.timestamp,
        sessionId: parsed.sessionId,
      },
      hasPreSessionActivity: parsed.hasPreSessionActivity,
      attributions: r9Attributions,
      rules: noR9 ? { injectFromAttributions: false } : undefined,
    });

    // 5. reconcile：始终用全量 attribution，保证归因覆盖率统计正确
    const report = reconcileClaudeContext({ snapshot, attributions: allAttributions, expected });

    // 6. char diff
    const baseDiff = computeCharDiff(report);
    const diff = injectProxyTexts(baseDiff, report, reqBody);
    const diffHtml = renderCharDiffHtml(diff);

    // 7. scorecard
    const scorecard = computeScorecard(queryKey, report, diff, allAttributions);

    return {
      queryKey,
      queryKeyHash: hash,
      status: "success",
      proxySourceRef: `${proxySourceFile}:${trafficLine}`,
      jsonlSourceRef: jsonlFile,
      timestamp,
      scorecard,
      // artifact 路径由 artifact-writer 填入，此处留空
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    return {
      queryKey,
      queryKeyHash: hash,
      status: "failed",
      error: message,
      proxySourceRef: `${proxySourceFile}:${trafficLine}`,
      jsonlSourceRef: jsonlFile,
      timestamp,
    };
  }
}

// 带产出数据的版本（用于 artifact 写入）
export function runPipelineWithData(input: PipelineInput): {
  result: PipelineResult;
  data?: PipelineOutputData;
} {
  const { proxy, jsonlFile, noR9, proxyOnly } = input;
  const { queryKey, queryKeyHash: hash, timestamp, proxySourceFile, trafficLine } = proxy;

  // proxy_without_jsonl：--proxy-only 时走 attribution-only 路径，否则 skip
  if (!jsonlFile || !existsSync(jsonlFile)) {
    if (!proxyOnly) {
      return {
        result: {
          queryKey,
          queryKeyHash: hash,
          status: "skipped",
          skipReason: "proxy_without_jsonl",
          proxySourceRef: `${proxySourceFile}:${trafficLine}`,
          timestamp,
        },
      };
    }
    // E0-1 proxy-only 路径：proxy → snapshot → attribution → reconcile(expected=undefined)
    try {
      const raw = proxy.raw;
      const reqBody = (raw["reqBody"] as Record<string, unknown>) ?? {};
      const proxyInput: ProxyRequestInput = {
        ts: raw["ts"] as string | undefined,
        startedAt: raw["startedAt"] as string | undefined,
        reqHeaders: raw["reqHeaders"] as Record<string, string> | undefined,
        reqBody: reqBody as ProxyRequestInput["reqBody"],
        _sse_events: raw["_sse_events"] as ProxyRequestInput["_sse_events"],
        _traffic_jsonl_line: trafficLine,
      };
      const snapshot = parseClaudeProxyRequest(proxyInput, {
        proxyFile: proxySourceFile,
        queryId: queryKey.queryId,
      });
      const snapForAttr = JSON.parse(
        JSON.stringify({ ...snapshot, metadata: { ...snapshot.metadata, rawBody: reqBody } }),
      ) as typeof snapshot;
      const allAttributions = inferClaudeProxyAttributions(snapForAttr);
      // reconcile 无 expected：仅产出 server_side_attribution + attribution-only 覆盖率
      const report = reconcileClaudeContext({ snapshot, attributions: allAttributions, expected: undefined });
      const baseDiff = computeCharDiff(report);
      const diff = injectProxyTexts(baseDiff, report, reqBody);
      const diffHtml = renderCharDiffHtml(diff);
      const scorecard = computeScorecard(queryKey, report, diff, allAttributions);
      return {
        result: {
          queryKey,
          queryKeyHash: hash,
          status: "success",
          proxySourceRef: `${proxySourceFile}:${trafficLine}`,
          timestamp,
          scorecard,
          queryKind: snapshot.request?.queryKind ?? "unknown",
        },
        data: { report, diff, diffHtml, attributions: allAttributions, reqBody },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        result: {
          queryKey,
          queryKeyHash: hash,
          status: "failed",
          error: message,
          proxySourceRef: `${proxySourceFile}:${trafficLine}`,
          timestamp,
        },
      };
    }
  }

  try {
    const raw = proxy.raw;
    const reqBody = (raw["reqBody"] as Record<string, unknown>) ?? {};
    const proxyInput: ProxyRequestInput = {
      ts: raw["ts"] as string | undefined,
      startedAt: raw["startedAt"] as string | undefined,
      reqHeaders: raw["reqHeaders"] as Record<string, string> | undefined,
      reqBody: reqBody as ProxyRequestInput["reqBody"],
      _sse_events: raw["_sse_events"] as ProxyRequestInput["_sse_events"],
      _traffic_jsonl_line: trafficLine,
      // P0-3：传递原始字符串供 parser 计算 wire bytes hash
      _rawReqBodyText: (raw["_rawReqBodyText"] as string | null | undefined) ?? undefined,
    };

    const snapshot = parseClaudeProxyRequest(proxyInput, {
      proxyFile: proxySourceFile,
      queryId: queryKey.queryId,
    });

    const snapForAttr = JSON.parse(
      JSON.stringify({ ...snapshot, metadata: { ...snapshot.metadata, rawBody: reqBody } }),
    ) as typeof snapshot;
    const allAttributions = inferClaudeProxyAttributions(snapForAttr);
    // T0 --verified-only：仅用于 R9 expected 生成，reconcile/scorecard/side-query 分类仍使用全量
    const { verifiedOnly } = input;
    const r9Attributions = verifiedOnly ? filterVerifiedAttributions(allAttributions) : allAttributions;

    const jsonlRaw = readFileSync(jsonlFile, "utf-8");
    const parsed = parseClaudeJsonlMutations(jsonlRaw, { jsonlFile });

    // P0-1：R9 严格正向，不再需要 proxySegmentsById
    const expected = reconstructExpectedClaudeContext({
      mutations: parsed.mutations,
      boundary: {
        queryId: queryKey.queryId,
        proxyTimestamp: snapshot.timestamp,
        sessionId: parsed.sessionId,
      },
      hasPreSessionActivity: parsed.hasPreSessionActivity,
      attributions: r9Attributions,
      rules: noR9 ? { injectFromAttributions: false } : undefined,
    });

    // reconcile/scorecard/side-query 分类始终使用全量 attribution
    const report = reconcileClaudeContext({ snapshot, attributions: allAttributions, expected });
    const baseDiff = computeCharDiff(report);
    const diff = injectProxyTexts(baseDiff, report, reqBody);
    const diffHtml = renderCharDiffHtml(diff);
    const scorecard = computeScorecard(queryKey, report, diff, allAttributions);

    // queryKind 细化：side_query 中命中 session-title rule 的标注为 session_title_side_query
    const baseQueryKind = snapshot.request?.queryKind ?? "unknown";
    const queryKind = (() => {
      if (baseQueryKind !== "side_query") return baseQueryKind;
      const hasSessionTitleRule = allAttributions.some(
        (a) => a.ruleId === "claude-code.side-query.session-title.v1",
      );
      return hasSessionTitleRule ? "session_title_side_query" : "side_query";
    })();

    return {
      result: {
        queryKey,
        queryKeyHash: hash,
        status: "success",
        proxySourceRef: `${proxySourceFile}:${trafficLine}`,
        jsonlSourceRef: jsonlFile,
        timestamp,
        scorecard,
        queryKind,
      },
      data: { report, diff, diffHtml, attributions: allAttributions, reqBody },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      result: {
        queryKey,
        queryKeyHash: hash,
        status: "failed",
        error: message,
        proxySourceRef: `${proxySourceFile}:${trafficLine}`,
        jsonlSourceRef: jsonlFile,
        timestamp,
      },
    };
  }
}

// Audit Pipeline
// 对每个 proxy+jsonl 匹配的 query 运行完整 reconciliation → scorecard → char diff
//
// 调用链：
//   parseClaudeProxyRequest → inferClaudeProxyAttributions
//   → parseClaudeJsonlMutations → reconstructExpectedClaudeContext
//   → reconcileClaudeContext → computeCharDiff → renderCharDiffHtml

import { readFileSync, existsSync } from "node:fs";
import { parseClaudeProxyRequest } from "../proxy-snapshot-parser";
import type { ProxyRequestInput } from "../proxy-snapshot-parser";
import { inferClaudeProxyAttributions } from "../proxy-attribution";
import { parseClaudeJsonlMutations } from "../jsonl-mutation-parser";
import { reconstructExpectedClaudeContext } from "../expected-context-reconstructor";
import { reconcileClaudeContext } from "../reconciliation-engine";
import { buildTargetRequest } from "../target-request-builder";
import { computeCharDiff } from "../debug/char-diff";
import { renderCharDiffHtml } from "../debug/render-char-diff-html";
import type { ReconciliationReport } from "../types";
import type { CharDiffReport } from "../debug/char-diff";
import { computeScorecard } from "./scorecard";
import type {
  DiscoveredProxyRecord,
  PipelineResult,
} from "./types";

export interface PipelineInput {
  proxy: DiscoveredProxyRecord;
  jsonlFile: string | null;  // null → proxy_without_jsonl，直接 skip
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

function buildProxyInput(proxy: DiscoveredProxyRecord): {
  reqBody: Record<string, unknown>;
  proxyInput: ProxyRequestInput;
} {
  const raw = proxy.raw;
  const reqBody = (raw["reqBody"] as Record<string, unknown>) ?? {};
  const proxyInput: ProxyRequestInput = {
    ts: raw["ts"] as string | undefined,
    startedAt: raw["startedAt"] as string | undefined,
    reqHeaders: raw["reqHeaders"] as Record<string, string> | undefined,
    reqBody: reqBody as ProxyRequestInput["reqBody"],
    _sse_events: raw["_sse_events"] as ProxyRequestInput["_sse_events"],
    _traffic_jsonl_line: proxy.trafficLine,
    _rawReqBodyText: (raw["_rawReqBodyText"] as string | null | undefined) ?? undefined,
  };
  return { reqBody, proxyInput };
}

// ─────────────────────────────────────────────────────────────────────────────
// 主函数
// ─────────────────────────────────────────────────────────────────────────────

// 轻量版：只需要 scorecard（用于测试和 compare-modes 内部循环）
export function runPipeline(input: PipelineInput): PipelineResult {
  const { proxy, jsonlFile } = input;
  const { queryKey, queryKeyHash: hash, timestamp, proxySourceFile, trafficLine } = proxy;

  if (!jsonlFile || !existsSync(jsonlFile)) {
    // TODO(P3-4): 当前无 JSONL 时直接 skip。后续可改为 attribution-only 模式：
    //   proxy → snapshot → attribution → reconcile(expected=undefined)，
    //   输出"哪些 proxy query 没有 JSONL 对应"的分布与原因。
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
    const { reqBody, proxyInput } = buildProxyInput(proxy);
    const snapshot = parseClaudeProxyRequest(proxyInput, {
      proxyFile: proxySourceFile,
      queryId: queryKey.queryId,
    });
    const snapForAttr = JSON.parse(
      JSON.stringify({ ...snapshot, metadata: { ...snapshot.metadata, rawBody: reqBody } }),
    ) as typeof snapshot;
    const attributions = inferClaudeProxyAttributions(snapForAttr);
    const jsonlRaw = readFileSync(jsonlFile, "utf-8");
    const parsed = parseClaudeJsonlMutations(jsonlRaw, { jsonlFile });
    const expected = reconstructExpectedClaudeContext({
      mutations: parsed.mutations,
      boundary: {
        queryId: queryKey.queryId,
        proxyTimestamp: snapshot.timestamp,
        sessionId: parsed.sessionId,
      },
      hasPreSessionActivity: parsed.hasPreSessionActivity,
    });
    const report = reconcileClaudeContext({ snapshot, attributions, expected });
    const baseDiff = computeCharDiff(report);
    const diff = injectProxyTexts(baseDiff, report, reqBody);
    const scorecard = computeScorecard(queryKey, report, diff, attributions);
    return {
      queryKey,
      queryKeyHash: hash,
      status: "success",
      proxySourceRef: `${proxySourceFile}:${trafficLine}`,
      jsonlSourceRef: jsonlFile,
      timestamp,
      scorecard,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
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

// 带产出数据的完整版（用于 artifact 写入）
export function runPipelineWithData(input: PipelineInput): {
  result: PipelineResult;
  data?: PipelineOutputData;
} {
  const { proxy, jsonlFile } = input;
  const { queryKey, queryKeyHash: hash, timestamp, proxySourceFile, trafficLine } = proxy;

  if (!jsonlFile || !existsSync(jsonlFile)) {
    // TODO(P3-4): 同上，attribution-only 模式待实现。
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

  try {
    const { reqBody, proxyInput } = buildProxyInput(proxy);
    const snapshot = parseClaudeProxyRequest(proxyInput, {
      proxyFile: proxySourceFile,
      queryId: queryKey.queryId,
    });
    const snapForAttr = JSON.parse(
      JSON.stringify({ ...snapshot, metadata: { ...snapshot.metadata, rawBody: reqBody } }),
    ) as typeof snapshot;
    const attributions = inferClaudeProxyAttributions(snapForAttr);

    const jsonlRaw = readFileSync(jsonlFile, "utf-8");
    const parsed = parseClaudeJsonlMutations(jsonlRaw, { jsonlFile });

    // rule 驱动重建，不注入 proxy attribution
    const expected = reconstructExpectedClaudeContext({
      mutations: parsed.mutations,
      boundary: {
        queryId: queryKey.queryId,
        proxyTimestamp: snapshot.timestamp,
        sessionId: parsed.sessionId,
      },
      hasPreSessionActivity: parsed.hasPreSessionActivity,
    });

    // model 优先从 JSONL assistant 行推断，fallback 到 proxy snapshot
    const targetRequest = buildTargetRequest({ expected, snapshot, inferredModel: parsed.inferredModel });

    const report = reconcileClaudeContext({
      snapshot,
      attributions,
      expected,
      targetRequest,
      proxyRequestBody: reqBody,
    });
    const baseDiff = computeCharDiff(report);
    const diff = injectProxyTexts(baseDiff, report, reqBody);
    const diffHtml = renderCharDiffHtml(diff);
    const scorecard = computeScorecard(queryKey, report, diff, attributions);

    // queryKind 细化：side_query 中命中 session-title rule 的标注为 session_title_side_query
    const baseQueryKind = snapshot.request?.queryKind ?? "unknown";
    const queryKind = (() => {
      if (baseQueryKind !== "side_query") return baseQueryKind;
      const hasSessionTitleRule = attributions.some(
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
      data: { report, diff, diffHtml, attributions, reqBody },
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

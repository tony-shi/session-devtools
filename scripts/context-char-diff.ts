#!/usr/bin/env bun
// context-char-diff.ts — Gate 3.5 CLI driver
//
// 用法：
//   bun run scripts/context-char-diff.ts --fixture single-tool-call   # 用真实 src fixture
//   bun run scripts/context-char-diff.ts --fixture large-tool-output
//   bun run scripts/context-char-diff.ts --mock                        # 用内置 mock
//   bun run scripts/context-char-diff.ts <report.json>                 # 用已有 JSON 报告

import { readFileSync, writeFileSync } from "fs";
import { resolve, basename, dirname } from "path";
import { computeCharDiff } from "../server/src/context-ledger/debug/char-diff";
import type { CharDiffReport, SegmentText } from "../server/src/context-ledger/debug/char-diff";
import { renderCharDiffHtml } from "../server/src/context-ledger/debug/render-char-diff-html";
import { MOCK_RECONCILIATION_REPORT } from "../server/src/context-ledger/report";
import { reconcileClaudeContext } from "../server/src/context-ledger/reconciliation-engine";
import { parseClaudeProxyRequest } from "../server/src/context-ledger/proxy-snapshot-parser";
import { inferClaudeProxyAttributions } from "../server/src/context-ledger/proxy-attribution";
import { parseClaudeJsonlMutations } from "../server/src/context-ledger/jsonl-mutation-parser";
import { reconstructExpectedClaudeContext } from "../server/src/context-ledger/expected-context-reconstructor";
import type { ContextSegment, ReconciliationReport } from "../server/src/context-ledger/types";

// ─────────────────────────────────────────────────────────────────────────────
// 方案一：按 jsonPath 从原始 proxy JSON 反查文本，注入进 diff 的 proxyTexts
// 不修改 proxy-snapshot-parser 或任何核心路径。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 按 segment 的 sourceRef.proxy.jsonPath 从原始请求体里提取文本。
 * 支持 parser 里实际产生的三种 path 格式：
 *   reqBody.system[i]              → system[i].text
 *   reqBody.tools[i]               → JSON.stringify(tools[i])
 *   reqBody.messages[mi]           → string content
 *   reqBody.messages[mi].content[bi] → block 级文本
 */
function extractProxyText(jsonPath: string, reqBody: Record<string, unknown>): string | undefined {
  // 去掉 "reqBody." 前缀
  const path = jsonPath.startsWith("reqBody.") ? jsonPath.slice("reqBody.".length) : jsonPath;

  // 简单的 dotted-bracket path walker
  const value = walkPath(path, reqBody);
  if (value === undefined || value === null) return undefined;

  // system block → .text
  if (typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    // system block
    if (typeof obj["text"] === "string") return obj["text"] as string;
    // tool schema
    return JSON.stringify(obj, null, 2);
  }
  // string message content
  if (typeof value === "string") return value;

  return undefined;
}

function walkPath(path: string, root: unknown): unknown {
  // tokenise: split on "." and "[n]"
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

/**
 * 从 segment 的 sourceRefs 里取第一个 proxy ref 的 jsonPath，
 * 然后从 reqBody 里提取文本。
 */
function proxyTextForSeg(seg: ContextSegment, reqBody: Record<string, unknown>): string | undefined {
  for (const ref of seg.sourceRefs) {
    if (ref.kind === "proxy" && ref.proxy.jsonPath) {
      return extractProxyText(ref.proxy.jsonPath, reqBody);
    }
  }
  return undefined;
}

/**
 * 在 computeCharDiff 产出的 diff 上做一次 pass，
 * 把 proxyTexts 里没有 text 的条目用 reqBody 反查填充。
 * 返回新的 CharDiffReport（浅拷贝 entries，不 mutate 原对象）。
 */
function injectProxyTexts(
  diff: CharDiffReport,
  report: ReconciliationReport,
  reqBody: Record<string, unknown>,
): CharDiffReport {
  const proxyById = new Map<string, ContextSegment>(
    report.snapshot.segments.map((s) => [s.id, s]),
  );

  const entries = diff.entries.map((entry) => {
    if (!entry.proxyTexts || entry.proxyTexts.length === 0) return entry;

    const filled: SegmentText[] = entry.proxyTexts.map((pt) => {
      if (pt.text !== undefined) return pt; // already has text
      const seg = proxyById.get(pt.segmentId);
      if (!seg) return pt;
      const text = proxyTextForSeg(seg, reqBody);
      return text !== undefined ? { ...pt, text } : pt;
    });

    return { ...entry, proxyTexts: filled };
  });

  return { ...diff, entries };
}

const FIXTURE_DIR = resolve("server/test/fixtures/context-reconstruction");
const VALID_FIXTURES = ["single-tool-call", "large-tool-output", "multi-turn-human", "system-tools-overhead"];

const HELP = `
用法：
  bun run scripts/context-char-diff.ts --fixture <name>
      用 server/test/fixtures/context-reconstruction/<name> 中的真实数据运行完整调用链。
      可用 fixture：${VALID_FIXTURES.join(" | ")}

  bun run scripts/context-char-diff.ts --mock
      用内置 mock fixture（MOCK_RECONCILIATION_REPORT）运行。

  bun run scripts/context-char-diff.ts <report.json>
      读取已有的 ReconciliationReport JSON 文件。

选项：
  --out <path>    指定输出 HTML 路径（默认输出到 /tmp/context-char-diff-<name>.html）

示例：
  bun run scripts/context-char-diff.ts --fixture single-tool-call
  bun run scripts/context-char-diff.ts --fixture large-tool-output --out /tmp/audit.html
  bun run scripts/context-char-diff.ts --mock
`.trim();

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  console.log(HELP);
  process.exit(0);
}

const outIdx = args.indexOf("--out");
const explicitOut = outIdx !== -1 && args[outIdx + 1] ? resolve(args[outIdx + 1]) : null;

let report: ReconciliationReport;
let outPath: string;

if (args[0] === "--fixture") {
  const caseName = args[1];
  if (!caseName || !VALID_FIXTURES.includes(caseName)) {
    console.error(`未知 fixture "${caseName}"。可用：${VALID_FIXTURES.join(", ")}`);
    process.exit(1);
  }

  // 与 reconciliation-engine.test.ts 的 runFixture() 完全相同的调用链
  const proxyRaw = JSON.parse(readFileSync(`${FIXTURE_DIR}/${caseName}/proxy-request.json`, "utf8"));
  const jsonlRaw = readFileSync(`${FIXTURE_DIR}/${caseName}/session.jsonl`, "utf8");

  const snapshot = parseClaudeProxyRequest(proxyRaw, {
    proxyFile: `server/test/fixtures/context-reconstruction/${caseName}/proxy-request.json`,
  });

  const snapForAttr = JSON.parse(JSON.stringify({
    ...snapshot,
    metadata: { ...snapshot.metadata, rawBody: proxyRaw.reqBody },
  })) as typeof snapshot;
  const attributions = inferClaudeProxyAttributions(snapForAttr);

  const parsed = parseClaudeJsonlMutations(jsonlRaw, {
    jsonlFile: `server/test/fixtures/context-reconstruction/${caseName}/session.jsonl`,
  });

  const expected = reconstructExpectedClaudeContext({
    mutations: parsed.mutations,
    boundary: { queryId: `q-${caseName}`, proxyTimestamp: proxyRaw.ts, sessionId: parsed.sessionId },
    fixtureName: caseName,
  });

  report = reconcileClaudeContext({ snapshot, attributions, expected, fixtureName: caseName });
  outPath = explicitOut ?? resolve(`/tmp/context-char-diff-${caseName}.html`);

  // 方案一：用原始 reqBody 反查 proxy segment 文本，不改核心路径
  const baseDiff = computeCharDiff(report);
  const diff = injectProxyTexts(baseDiff, report, proxyRaw.reqBody ?? {});
  const html = renderCharDiffHtml(diff);
  writeFileSync(outPath, html, "utf-8");
  printSummary(report.queryId, diff.summary, outPath);
  process.exit(0);

} else if (args[0] === "--mock") {
  const mock = MOCK_RECONCILIATION_REPORT;
  report = reconcileClaudeContext({
    snapshot: mock.snapshot,
    attributions: mock.proxyAttributions,
    expected: mock.expected,
    fixtureName: "mock",
  });
  outPath = explicitOut ?? resolve("/tmp/context-char-diff-mock.html");

} else {
  const reportPath = resolve(args[0]);
  outPath = explicitOut ?? resolve(dirname(reportPath), `${basename(reportPath, ".json")}-char-diff.html`);

  try {
    const raw = readFileSync(reportPath, "utf-8");
    report = JSON.parse(raw) as ReconciliationReport;
  } catch (err) {
    console.error(`读取 report 失败：${reportPath}\n${err}`);
    process.exit(1);
  }

  if (report.schemaVersion !== "context-ledger.report.v1") {
    console.warn(`警告：schemaVersion 为 "${report.schemaVersion}"，预期为 "context-ledger.report.v1"`);
  }
}

// --mock / JSON file 分支的公共出口
{
  if (report.schemaVersion !== "context-ledger.report.v1") {
    console.warn(`警告：schemaVersion 为 "${report.schemaVersion}"，预期为 "context-ledger.report.v1"`);
  }
  const diff = computeCharDiff(report);
  const html = renderCharDiffHtml(diff);
  writeFileSync(outPath, html, "utf-8");
  printSummary(report.queryId, diff.summary, outPath);
}

function printSummary(queryId: string, s: CharDiffReport["summary"], outPath: string): void {
  console.log(`
Context Char Diff — ${queryId}
  entries:         ${s.totalEntries}
  matched exact:   ${s.matchedExact}
  char diff:       ${s.matchedWithCharDiff}  (drift ${(s.charDriftPct * 100).toFixed(2)}%)
  expected only:   ${s.expectedOnly}
  proxy only:      ${s.proxyOnly}
  attribution only:${s.attributionOnly}
  known noise:     ${s.knownNoise}
  proxy chars:     ${s.totalProxyChars.toLocaleString()}
  unexplained:     ${s.unexplainedProxyChars.toLocaleString()} chars

HTML written to: ${outPath}
`.trim());
}

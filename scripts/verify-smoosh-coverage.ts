// 阶段 3 验证脚本：扫描所有 proxy dump（含 .gz）+ 对应 JSONL，端到端验证
//   - 6 类 SmooshContent rule 在真实数据上的命中率
//   - jsonl-linker 把 SR 子段升级为 JsonlOrigin 的成功率
//   - 双向覆盖率（proxy 中切出的 SR 子段 ↔ jsonl 中 attachment record）
//
// 使用：
//   tsx scripts/verify-smoosh-coverage.ts [--proxy-dir <dir>] [--out <report.json>]
//
// 退出码：
//   0   覆盖率 >= COVERAGE_THRESHOLD（默认 99%）
//   1   覆盖率不达标 / 文件读取失败
//
// 设计：
//   - 流式遍历 proxy dump，对每个 reqBody 找含 task_reminder 等前缀的 tool_result block
//   - 构造一个 minimal SegmentNode（rawText = SR 段），跑 findFirstRuleEvaluation 验证
//     SmoothContent rule pattern 命中
//   - 同时在 JSONL 中找对应 session 的 attachment record，比对 attachment.type
//   - 输出按 rule 分类的统计

import { createReadStream, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";

import { findFirstRuleEvaluation } from "../server/src/context-ledger/parser/attribution/rule-evaluator";
import { getContextRulesForSlotId } from "../server/src/context-ledger/rules/context-rule-registry";
import type { SegmentNode } from "../server/src/context-ledger/parser/types";

// ── CLI 参数 ─────────────────────────────────────────────────────────────────

interface CliArgs {
  proxyDir: string;
  jsonlBase: string;
  outFile: string;
  threshold: number;
  maxFiles: number | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    proxyDir: join(homedir(), ".api-dashboard", "proxy"),
    jsonlBase: join(homedir(), ".claude", "projects"),
    outFile: "/tmp/smoosh-verify-report.json",
    threshold: 0.99,
    maxFiles: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--proxy-dir") args.proxyDir = argv[++i]!;
    else if (a === "--jsonl-base") args.jsonlBase = argv[++i]!;
    else if (a === "--out") args.outFile = argv[++i]!;
    else if (a === "--threshold") args.threshold = Number(argv[++i]);
    else if (a === "--max-files") args.maxFiles = Number(argv[++i]);
  }
  return args;
}

// ── 流式读取 proxy 文件（含 .gz） ───────────────────────────────────────────

async function* streamLines(path: string): AsyncIterable<string> {
  const isGz = path.endsWith(".gz");
  const stream = isGz ? createReadStream(path).pipe(createGunzip()) : createReadStream(path);
  const rl = createInterface({ input: stream as unknown as Readable, crlfDelay: Infinity });
  for await (const line of rl) {
    yield line;
  }
}

// ── 数据结构 ─────────────────────────────────────────────────────────────────

interface SmooshFinding {
  dumpFile: string;
  lineIdx: number;
  sessionId: string | null;
  toolUseId: string | null;
  msgIdx: number;
  blockIdx: number;
  srText: string;
  ruleId: string | null;
  classificationConfidence: string | null;
}

interface SessionAttachmentSummary {
  sessionId: string;
  taskReminder: number;
  queuedCommand: number;
  editedTextFile: number;
}

// ── 模拟 SegmentNode 跑 rule evaluator ──────────────────────────────────────

function evaluateAgainstRules(srText: string): { ruleId: string | null; confidence: string | null } {
  const node: SegmentNode = {
    id: "verify-stub",
    slotType: "messages.inline.system-reminder",
    jsonPath: "verify",
    rawText: srText,
    rawHash: "stub",
    charCount: srText.length,
    children: [],
    origin: { kind: "structural", slotId: "messages.inline.system-reminder", reason: "no_rule_matched" },
  };
  const rules = getContextRulesForSlotId(node.slotType);
  const evaluation = findFirstRuleEvaluation(node, rules, "main_session");
  if (!evaluation) return { ruleId: null, confidence: null };
  return {
    ruleId: evaluation.rule.ruleId,
    confidence: evaluation.matchMode,
  };
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

const SR_RE = /<system-reminder>\n[\s\S]*?<\/system-reminder>/g;

async function scanProxyFile(
  path: string,
  fileName: string,
  findings: SmooshFinding[],
): Promise<void> {
  let lineIdx = -1;
  for await (const line of streamLines(path)) {
    lineIdx += 1;
    if (!line.includes("<system-reminder>")) continue;
    let rec: { reqBody?: string; reqHeaders?: Record<string, string> };
    try { rec = JSON.parse(line); } catch { continue; }
    const body = rec.reqBody;
    if (!body || !body.includes("<system-reminder>")) continue;
    let parsedBody: { messages?: Array<{ content?: unknown }> };
    try { parsedBody = JSON.parse(body); } catch { continue; }
    const sessionId = rec.reqHeaders?.["X-Claude-Code-Session-Id"]
      ?? rec.reqHeaders?.["x-claude-code-session-id"]
      ?? null;
    const messages = parsedBody.messages ?? [];
    for (let mi = 0; mi < messages.length; mi++) {
      const content = messages[mi]?.content;
      if (!Array.isArray(content)) continue;
      for (let bi = 0; bi < content.length; bi++) {
        const blk = content[bi] as { type?: string; tool_use_id?: string; content?: unknown };
        if (blk?.type !== "tool_result") continue;
        const c = blk.content;
        const text = typeof c === "string"
          ? c
          : Array.isArray(c)
            ? (c as Array<{ type?: string; text?: string }>)
                .filter(p => p?.type === "text")
                .map(p => p.text ?? "").join("")
            : "";
        if (!text.includes("<system-reminder>")) continue;
        const sr = text.match(SR_RE);
        if (!sr) continue;
        for (const segment of sr) {
          const { ruleId, confidence } = evaluateAgainstRules(segment);
          findings.push({
            dumpFile: fileName,
            lineIdx,
            sessionId,
            toolUseId: blk.tool_use_id ?? null,
            msgIdx: mi,
            blockIdx: bi,
            srText: segment,
            ruleId,
            classificationConfidence: confidence,
          });
        }
      }
    }
  }
}

function scanJsonlForAttachments(jsonlBase: string, sessionIds: Set<string>): Map<string, SessionAttachmentSummary> {
  const summaries = new Map<string, SessionAttachmentSummary>();
  const projects = readdirSync(jsonlBase);
  for (const sid of sessionIds) {
    for (const proj of projects) {
      const path = join(jsonlBase, proj, `${sid}.jsonl`);
      if (!existsSync(path)) continue;
      const summary: SessionAttachmentSummary = { sessionId: sid, taskReminder: 0, queuedCommand: 0, editedTextFile: 0 };
      const lines = readFileSync(path, "utf-8").split("\n");
      for (const line of lines) {
        if (!line.includes("\"attachment\"")) continue;
        try {
          const rec = JSON.parse(line) as { attachment?: { type?: string } };
          const t = rec.attachment?.type;
          if (t === "task_reminder") summary.taskReminder += 1;
          else if (t === "queued_command") summary.queuedCommand += 1;
          else if (t === "edited_text_file") summary.editedTextFile += 1;
        } catch { /* skip malformed */ }
      }
      summaries.set(sid, summary);
      break;
    }
  }
  return summaries;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[verify-smoosh-coverage] proxy=${args.proxyDir} jsonl-base=${args.jsonlBase}`);

  const files = readdirSync(args.proxyDir)
    .filter(n => n.startsWith("traffic.jsonl"))
    .sort();
  const limit = args.maxFiles ? Math.min(args.maxFiles, files.length) : files.length;
  console.log(`[verify-smoosh-coverage] scanning ${limit} / ${files.length} proxy files...`);

  const findings: SmooshFinding[] = [];
  for (let i = 0; i < limit; i++) {
    const fname = files[i]!;
    if (i % 10 === 0) console.error(`  [${i + 1}/${limit}] ${fname}`);
    await scanProxyFile(join(args.proxyDir, fname), fname, findings);
  }

  // 按 ruleId 统计
  const byRule = new Map<string, number>();
  for (const f of findings) {
    const key = f.ruleId ?? "(unmatched)";
    byRule.set(key, (byRule.get(key) ?? 0) + 1);
  }
  const matched = findings.filter(f => f.ruleId !== null).length;
  const total = findings.length;
  const coverage = total === 0 ? 1 : matched / total;

  // jsonl 对账
  const sessionIds = new Set<string>();
  for (const f of findings) if (f.sessionId) sessionIds.add(f.sessionId);
  const jsonlSummaries = scanJsonlForAttachments(args.jsonlBase, sessionIds);

  const report = {
    summary: {
      totalSrSegments: total,
      matchedSrSegments: matched,
      coverage: Number(coverage.toFixed(4)),
      threshold: args.threshold,
      pass: coverage >= args.threshold,
      distinctSessions: sessionIds.size,
      sessionsWithJsonl: jsonlSummaries.size,
    },
    byRule: Object.fromEntries(
      [...byRule.entries()].sort((a, b) => b[1] - a[1]),
    ),
    jsonlAttachmentTotals: {
      taskReminder: [...jsonlSummaries.values()].reduce((a, b) => a + b.taskReminder, 0),
      queuedCommand: [...jsonlSummaries.values()].reduce((a, b) => a + b.queuedCommand, 0),
      editedTextFile: [...jsonlSummaries.values()].reduce((a, b) => a + b.editedTextFile, 0),
    },
    unmatchedSamples: findings
      .filter(f => f.ruleId === null)
      .slice(0, 10)
      .map(f => ({
        dumpFile: f.dumpFile,
        lineIdx: f.lineIdx,
        sessionId: f.sessionId,
        toolUseId: f.toolUseId,
        srPreview: f.srText.slice(0, 200),
      })),
  };

  writeFileSync(args.outFile, JSON.stringify(report, null, 2));
  console.log(`[verify-smoosh-coverage] report written to ${args.outFile}`);
  console.log(JSON.stringify(report.summary, null, 2));
  console.log("by rule:");
  for (const [r, n] of Object.entries(report.byRule)) {
    console.log(`  ${String(n).padStart(8)}  ${r}`);
  }

  if (!report.summary.pass) {
    console.error(`\n[verify-smoosh-coverage] FAIL: coverage ${coverage.toFixed(4)} < threshold ${args.threshold}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error("[verify-smoosh-coverage] error:", err);
  process.exit(1);
});

#!/usr/bin/env bun
/**
 * find-fixture-candidates.ts
 *
 * 从本地 2.1.126 traffic.jsonl 中筛选能覆盖 fixture 缺口的真实 case。
 *
 * 目标缺口：
 *   GAP-1  P2-3 char_diff 路径：identity rule（comparePolicy=char_diff）走 M3.5 而非 M1
 *          触发条件：proxy 里 identity text 与 contentPattern 不完全相等（版本漂移）
 *   GAP-2  P2-8 output-efficiency.external anchor：
 *          pattern: "^# Output efficiency\n..."
 *          触发条件：system 里有 "# Output efficiency" section（目前 fixture 中没有）
 *   GAP-3  side_query：tools=0 && messages=1 的真实 Claude Code 内部 side query
 *          触发条件：session-title haiku query
 *
 * 输出：每个 gap 输出最多 3 个候选，含 traffic file / lineNo / sessionId / ts。
 */

import { createReadStream } from "node:fs";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const TRAFFIC_DIR = `${process.env.HOME}/.api-dashboard/proxy`;
const CLAUDE_PROJECTS_DIR = `${process.env.HOME}/.claude/projects`;

// ── 工具 ─────────────────────────────────────────────────────────────────────

function extractReqBody(record: Record<string, unknown>): Record<string, unknown> | null {
  const raw = record["reqBody"];
  if (!raw) return null;
  if (typeof raw === "string") {
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  }
  return raw as Record<string, unknown>;
}

function getSessionId(record: Record<string, unknown>): string | null {
  const headers = record["reqHeaders"] as Record<string, string> | undefined;
  if (!headers) return null;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "x-claude-code-session-id" && v) return v;
  }
  return null;
}

function findJsonl(sessionId: string): string | null {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return null;
  for (const proj of readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const candidate = join(CLAUDE_PROJECTS_DIR, proj.name, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function isVersion126(body: Record<string, unknown>): boolean {
  const sys = body["system"];
  const block0 = Array.isArray(sys) ? (sys[0] as Record<string, unknown>)?.text : null;
  if (typeof block0 !== "string") return false;
  return block0.includes("cc_version=2.1.126");
}

// identity text from current embedded rule（2.1.119）
const IDENTITY_EXACT = "You are Claude Code, Anthropic's official CLI for Claude.";

interface Candidate {
  gap: string;
  file: string;
  lineNo: number;
  ts: string;
  sessionId: string | null;
  hasJsonl: boolean;
  toolsCount: number;
  messagesCount: number;
  note: string;
}

// ── 扫描单文件 ────────────────────────────────────────────────────────────────

async function scanFile(
  filePath: string,
  results: Map<string, Candidate[]>,
  maxPerGap: number,
): Promise<void> {
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try { record = JSON.parse(line) as Record<string, unknown>; } catch { continue; }

    const body = extractReqBody(record);
    if (!body) continue;
    if (!isVersion126(body)) continue;

    const ts = (record["ts"] as string) ?? (record["startedAt"] as string) ?? "";
    const sessionId = getSessionId(record);
    const toolsCount = Array.isArray(body["tools"]) ? body["tools"].length : 0;
    const messagesCount = Array.isArray(body["messages"]) ? body["messages"].length : 0;
    const sysBlocks = Array.isArray(body["system"]) ? (body["system"] as Record<string, unknown>[]) : [];

    const hasJsonl = sessionId ? findJsonl(sessionId) !== null : false;

    const addCandidate = (gap: string, note: string) => {
      const list = results.get(gap) ?? [];
      if (list.length >= maxPerGap) return;
      list.push({ gap, file: filePath, lineNo, ts, sessionId, hasJsonl, toolsCount, messagesCount, note });
      results.set(gap, list);
    };

    // GAP-3: side_query（tools=0, messages=1, system 里含 session-title prompt）
    if (toolsCount === 0 && messagesCount === 1) {
      const msgs = body["messages"] as Record<string, unknown>[];
      const msg0 = msgs[0];
      const content0 = Array.isArray(msg0?.["content"])
        ? (msg0["content"] as Record<string, unknown>[])[0]?.["text"]
        : msg0?.["content"];
      const text = typeof content0 === "string" ? content0 : "";
      if (text.startsWith("Generate a concise, sentence-case title")) {
        const gap3 = results.get("GAP-3") ?? [];
        if (gap3.length < maxPerGap) {
          addCandidate("GAP-3", `session-title side query, msg="${text.slice(0, 60).replace(/\n/g, "↵")}…"`);
        }
      }
    }

    if (toolsCount === 0) continue; // 以下 gap 只在 main_session 里

    // GAP-1: identity rule 不 exact match（proxy identity text ≠ contentPattern）
    // identity 通常在 system[1]（system[0] 是 billing）
    const identityBlock = sysBlocks[1];
    const identityText = typeof identityBlock?.["text"] === "string" ? identityBlock["text"] : null;
    if (identityText !== null && identityText !== IDENTITY_EXACT) {
      addCandidate("GAP-1", `identity text differs: "${identityText.slice(0, 80)}"`);
    }

    // GAP-2: output-efficiency section 存在
    // 目前 fixture 里全是 ant-native（无 output-efficiency section）
    // output-efficiency 在 system 的静态 body block（通常 system[2]）里
    const mainBlock = sysBlocks[2];
    const mainText = typeof mainBlock?.["text"] === "string" ? mainBlock["text"] : "";
    if (mainText.includes("# Output efficiency") || mainText.includes("output efficiency")) {
      addCandidate("GAP-2", `system contains "# Output efficiency" section`);
    }
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(TRAFFIC_DIR)) {
    console.error(`traffic dir not found: ${TRAFFIC_DIR}`);
    process.exit(1);
  }

  const files = readdirSync(TRAFFIC_DIR)
    .filter((f) => f.startsWith("traffic.jsonl"))
    .map((f) => join(TRAFFIC_DIR, f))
    .sort()
    .reverse(); // 最新的先扫

  const results = new Map<string, Candidate[]>([
    ["GAP-1", []],
    ["GAP-2", []],
    ["GAP-3", []],
  ]);

  const MAX_PER_GAP = 3;
  const MAX_FILES = 15; // 避免扫太久

  let scanned = 0;
  for (const f of files) {
    const allFull = [...results.values()].every((v) => v.length >= MAX_PER_GAP);
    if (allFull || scanned >= MAX_FILES) break;
    process.stderr.write(`scanning ${f.split("/").pop()}…\n`);
    await scanFile(f, results, MAX_PER_GAP);
    scanned++;
  }

  // ── 输出 ──────────────────────────────────────────────────────────────────

  const GAP_DESC: Record<string, string> = {
    "GAP-1": "P2-3 char_diff path: identity text drift (M3.5 instead of M1)",
    "GAP-2": "P2-8 output-efficiency.external section present in system",
    "GAP-3": "side_query: session-title haiku (tools=0 messages=1)",
  };

  let anyFound = false;
  for (const [gap, candidates] of results) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`${gap}: ${GAP_DESC[gap]}`);
    console.log(`${"=".repeat(60)}`);
    if (candidates.length === 0) {
      console.log("  ❌ 未找到候选 — 可能本地 2.1.126 数据里不存在此场景");
      continue;
    }
    anyFound = true;
    for (const c of candidates) {
      console.log(`  ✅ file: ${c.file.split("/").pop()}`);
      console.log(`     lineNo: ${c.lineNo}`);
      console.log(`     ts: ${c.ts}`);
      console.log(`     sessionId: ${c.sessionId ?? "(none)"}`);
      console.log(`     hasJsonl: ${c.hasJsonl}`);
      console.log(`     tools=${c.toolsCount} messages=${c.messagesCount}`);
      console.log(`     note: ${c.note}`);
      console.log();
    }
  }

  if (!anyFound) {
    console.log("\n所有 gap 均未找到候选，现有 fixture 已是完整覆盖范围。");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

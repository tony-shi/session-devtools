// 旁路脚本：把 rule-registry 里 exact pattern 在本地 Claude Code 可执行文件中对账。
//
// 用法：
//   bun run scripts/verify-rules-against-cli.ts
//   bun run scripts/verify-rules-against-cli.ts --target /path/to/claude-binary
//   bun run scripts/verify-rules-against-cli.ts --pattern "literal text" --target /path/to/binary
//
// 默认 target：
//   ~/.local/share/claude/versions/<SUPPORTED_CLAUDE_CODE_VERSION>
// 找不到则降级到：
//   /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js
//   ~/.npm/_npx/*/node_modules/@anthropic-ai/claude-code/cli.js
//
// 设计要点（B1.4）：
// - target 文件按 latin1 解码成字符串：每个字节 1:1 映射到 char，substring 搜索 = 字节精确匹配。
//   Bun 编译的 Mach-O 二进制里 JS 字面量是连续字节流，这个方法对二进制和明文 cli.js 都奏效。
// - 只输出找/找不到 + offset + 短上下文，不做 regex 拟合：
//   "exact" rule 的语义就是字面相等，rule 通过 = pattern 在 binary 中存在 ≥1 次。
// - 不做自动写回 rule-registry，仅产出表格供人工逐条决定 verifiedFor 是否升级到当前版本。
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  CONTEXT_LEDGER_RULES,
  SUPPORTED_CLAUDE_CODE_VERSION,
  type ContextLedgerRule,
} from "../server/src/context-ledger/rules/rule-registry";

// ── 目标文件定位 ────────────────────────────────────────────────────────────────

function resolveTarget(explicit?: string): string {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`target 文件不存在：${explicit}`);
    return explicit;
  }
  // 1. ~/.local/share/claude/versions/<SUPPORTED_CLAUDE_CODE_VERSION>
  const versioned = join(homedir(), ".local/share/claude/versions", SUPPORTED_CLAUDE_CODE_VERSION);
  if (existsSync(versioned)) return versioned;
  // 2. 全局 npm 安装
  const global = "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js";
  if (existsSync(global)) return global;
  // 3. npx 缓存（取最新一个）
  const npxRoot = join(homedir(), ".npm/_npx");
  if (existsSync(npxRoot)) {
    const candidates = readdirSync(npxRoot)
      .map((d) => join(npxRoot, d, "node_modules/@anthropic-ai/claude-code/cli.js"))
      .filter(existsSync)
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (candidates.length > 0) return candidates[0]!;
  }
  throw new Error(
    `未找到 Claude Code 可执行：试过 ${versioned} / ${global} / ${npxRoot}/*。\n` +
    "请用 --target /path/to/binary 显式指定。",
  );
}

// ── 核心：在 latin1 字符串里数 pattern 出现次数并取首个上下文 ──────────────────────

interface MatchResult {
  pattern: string;
  patternBytes: number;
  found: number;
  firstOffset: number; // -1 表示没找到
  contextBefore: string;
  contextAfter: string;
}

function findPatternInTarget(targetText: string, pattern: string, ctxRadius = 60): MatchResult {
  // pattern 也按 latin1（utf8 → bytes → latin1 字符）以保持字节对齐
  const patBytes = Buffer.from(pattern, "utf8");
  const patStr = patBytes.toString("latin1");

  let found = 0;
  let firstOffset = -1;
  let from = 0;
  while (true) {
    const idx = targetText.indexOf(patStr, from);
    if (idx === -1) break;
    if (firstOffset === -1) firstOffset = idx;
    found++;
    from = idx + 1; // overlap-tolerant 计数
    if (found > 100) break; // 安全栅栏
  }

  let contextBefore = "";
  let contextAfter = "";
  if (firstOffset >= 0) {
    const before = targetText.slice(Math.max(0, firstOffset - ctxRadius), firstOffset);
    const after = targetText.slice(firstOffset + patStr.length, firstOffset + patStr.length + ctxRadius);
    // 转回 utf8 以便阅读；不可打印字节用 · 替代
    contextBefore = sanitizeForDisplay(before);
    contextAfter = sanitizeForDisplay(after);
  }

  return {
    pattern,
    patternBytes: patBytes.length,
    found,
    firstOffset,
    contextBefore,
    contextAfter,
  };
}

function sanitizeForDisplay(s: string): string {
  // latin1 chunk → utf8。先 encode 回 bytes 再 utf8 解码（fatal=false 容错）。
  const bytes = Buffer.from(s, "latin1");
  let text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  // 控制字符可视化
  text = text.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "·");
  return text;
}

// ── 分歧点定位 ────────────────────────────────────────────────────────────────
//
// 对找不到完整 pattern 的 rule：二分搜索 pattern 的最长能匹配的前缀，
// 定位 binary 与 expected 在哪个字节开始分歧。
// 这能区分两类失败：
//   a) 整段缺失（最长前缀很短，几乎从一开始就匹配不上）→ 真漂移
//   b) 中间一处微调（最长前缀几百字节，只是某行改了一两个字）→ 局部 patch
function locateDivergence(targetText: string, pattern: string): {
  longestPrefixBytes: number;
  expectedNext: string;
  actualNext: string;
  anchorOffset: number;
} {
  const patBytes = Buffer.from(pattern, "utf8").toString("latin1");
  // 二分：find max k such that patBytes[0..k] is in targetText
  let lo = 0, hi = patBytes.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (targetText.indexOf(patBytes.slice(0, mid)) !== -1) lo = mid;
    else hi = mid - 1;
  }
  const longestPrefixBytes = lo;
  const anchorOffset = longestPrefixBytes > 0 ? targetText.indexOf(patBytes.slice(0, longestPrefixBytes)) : -1;

  const peek = 60;
  const expectedNext = sanitizeForDisplay(patBytes.slice(longestPrefixBytes, longestPrefixBytes + peek));
  const actualNext = anchorOffset >= 0
    ? sanitizeForDisplay(targetText.slice(anchorOffset + longestPrefixBytes, anchorOffset + longestPrefixBytes + peek))
    : "(no anchor — pattern doesn't share even a single byte prefix)";

  return { longestPrefixBytes, expectedNext, actualNext, anchorOffset };
}

// ── 主流程：遍历 exact rule 出表 ─────────────────────────────────────────────────

interface Row {
  ruleId: string;
  matchMode: string;
  patternBytes: number;
  found: number;
  status: "✅" | "❌" | "⚠";
  preview: string;
}

function statusOf(found: number): "✅" | "❌" | "⚠" {
  if (found === 0) return "❌";
  if (found === 1) return "✅";
  return "⚠"; // 多次出现：可能 false positive 或有同名定义点
}

function previewOf(pattern: string): string {
  const head = pattern.slice(0, 70).replace(/\n/g, "↵").replace(/\s+/g, " ");
  return pattern.length > 70 ? head + "…" : head;
}

function fmtTable(rows: Row[]): string {
  const header = ["RuleId", "Mode", "Bytes", "Hits", "Status", "Pattern preview"];
  const widths = header.map((h, i) => {
    const colVals = rows.map((r) => [r.ruleId, r.matchMode, String(r.patternBytes), String(r.found), r.status, r.preview][i]!);
    return Math.max(h.length, ...colVals.map((v) => [...v].length));
  });
  const sep = widths.map((w) => "─".repeat(w));
  const renderRow = (cols: string[]) => "│ " + cols.map((c, i) => c.padEnd(widths[i]!)).join(" │ ") + " │";
  const lines = [
    "┌" + sep.map((s) => "─" + s + "─").join("┬") + "┐",
    renderRow(header),
    "├" + sep.map((s) => "─" + s + "─").join("┼") + "┤",
    ...rows.map((r) => renderRow([r.ruleId, r.matchMode, String(r.patternBytes), String(r.found), r.status, r.preview])),
    "└" + sep.map((s) => "─" + s + "─").join("┴") + "┘",
  ];
  return lines.join("\n");
}

function isExactRule(rule: ContextLedgerRule): boolean {
  return rule.attribution?.matchMode === "exact" && typeof rule.attribution?.pattern === "string";
}

function main(): void {
  const args = process.argv.slice(2);
  const targetIdx = args.indexOf("--target");
  const explicitTarget = targetIdx >= 0 ? args[targetIdx + 1] : undefined;
  const patternIdx = args.indexOf("--pattern");
  const adhocPattern = patternIdx >= 0 ? args[patternIdx + 1] : undefined;
  const verbose = args.includes("--verbose") || args.includes("-v");

  const target = resolveTarget(explicitTarget);
  const targetSize = statSync(target).size;
  console.log(`Target:  ${target} (${(targetSize / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`Version: SUPPORTED_CLAUDE_CODE_VERSION = ${SUPPORTED_CLAUDE_CODE_VERSION}`);
  console.log();

  // 整文件读到 latin1 字符串，避免 utf8 解码失败
  const buf = readFileSync(target);
  const targetText = buf.toString("latin1");

  // ── 单 pattern 模式 ──
  if (adhocPattern !== undefined) {
    const r = findPatternInTarget(targetText, adhocPattern);
    console.log(`Pattern bytes: ${r.patternBytes}`);
    console.log(`Found:         ${r.found} occurrence(s)`);
    if (r.found > 0) {
      console.log(`First offset:  ${r.firstOffset} (0x${r.firstOffset.toString(16)})`);
      console.log(`Context before: …${r.contextBefore}`);
      console.log(`Context after:  ${r.contextAfter}…`);
    }
    process.exit(r.found > 0 ? 0 : 1);
  }

  // ── 全量 exact rule 扫描 ──
  const exactRules = CONTEXT_LEDGER_RULES.filter(isExactRule);
  const skipped = CONTEXT_LEDGER_RULES.filter((r) => !isExactRule(r));

  const rows: Row[] = [];
  const failures: { rule: ContextLedgerRule; result: MatchResult }[] = [];
  const multis: { rule: ContextLedgerRule; result: MatchResult }[] = [];

  for (const rule of exactRules) {
    const pattern = rule.attribution!.pattern as string;
    const r = findPatternInTarget(targetText, pattern);
    rows.push({
      ruleId: rule.ruleId,
      matchMode: rule.attribution!.matchMode,
      patternBytes: r.patternBytes,
      found: r.found,
      status: statusOf(r.found),
      preview: previewOf(pattern),
    });
    if (r.found === 0) failures.push({ rule, result: r });
    if (r.found > 1) multis.push({ rule, result: r });
  }

  console.log(`Exact rules scanned: ${exactRules.length}`);
  console.log(`Skipped (non-exact): ${skipped.length} → ${skipped.map((r) => `${r.ruleId} [${r.attribution?.matchMode ?? "no-attribution"}]`).join(", ") || "(none)"}`);
  console.log();
  console.log(fmtTable(rows));
  console.log();

  const okCount = rows.filter((r) => r.status === "✅").length;
  const missCount = rows.filter((r) => r.status === "❌").length;
  const multiCount = rows.filter((r) => r.status === "⚠").length;
  console.log(`Summary: ✅ ${okCount} unique match · ⚠ ${multiCount} multi · ❌ ${missCount} missing`);

  if (failures.length > 0) {
    console.log();
    console.log("── ❌ Missing patterns（找最长可匹配前缀以定位分歧点）──");
    for (const { rule } of failures) {
      const pattern = rule.attribution!.pattern as string;
      const div = locateDivergence(targetText, pattern);
      const totalBytes = Buffer.byteLength(pattern, "utf8");
      const matchPct = ((div.longestPrefixBytes / totalBytes) * 100).toFixed(1);
      console.log(`  ${rule.ruleId}`);
      console.log(`    sourcemapRef: ${rule.sourcemapRef ?? "(none)"}`);
      console.log(`    longest匹配前缀: ${div.longestPrefixBytes} / ${totalBytes} bytes (${matchPct}%) @ binary offset ${div.anchorOffset}`);
      console.log(`    expected next 60B: ${div.expectedNext}`);
      console.log(`    actual   next 60B: ${div.actualNext}`);
    }
  }

  if (verbose && multis.length > 0) {
    console.log();
    console.log("── ⚠ Multi-occurrence patterns（首个 match 的上下文）──");
    for (const { rule, result } of multis) {
      console.log(`  ${rule.ruleId}  ×${result.found}  @ offset ${result.firstOffset}`);
      console.log(`    …${result.contextBefore}⟦MATCH⟧${result.contextAfter}…`);
    }
  }

  process.exit(missCount > 0 ? 1 : 0);
}

main();

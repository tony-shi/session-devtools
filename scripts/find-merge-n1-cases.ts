#!/usr/bin/env bun
/**
 * 搜索本地所有 2.1.126 版本的 JSONL 会话，寻找 N:1 merge 场景。
 *
 * N:1 merge 场景定义：
 *   同一个 tool_use_id 的 tool_result，其 content 是数组（多个 block），
 *   这些 block 在 proxy 侧会被 split 成多个 proxy segments，
 *   而 expected 侧可能只有一个 expected segment（合并态）。
 *
 * 实际上更准确的定义来自 reconciliation-engine 的 logicalMessageId 机制：
 *   同一 JSONL 中，一条 user message 包含多个 tool_result content block，
 *   这些 block 在 expected 层被打上同一 logicalMessageId，
 *   需要 N:1 对账（多个 expected segment → 一个 proxy segment）。
 *
 * 本脚本检查两类场景：
 * 1. tool_result content 是数组且长度 > 1（多 block tool_result）
 * 2. 一条 user message 包含多个 tool_result items（同消息多 tool_result）
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const CLAUDE_PROJECTS_DIR = join(process.env.HOME!, ".claude", "projects");
const TARGET_VERSION = "2.1.126";

interface FoundCase {
  jsonlFile: string;
  sessionId: string;
  queryId: string;
  kind: "multi_block_tool_result" | "multi_tool_result_in_message";
  detail: string;
  messageIndex: number;
  toolUseId?: string;
  blockCount?: number;
}

function scanJsonlFile(jsonlFile: string): FoundCase[] {
  const cases: FoundCase[] = [];
  const sessionId = jsonlFile.split("/").pop()!.replace(".jsonl", "");

  let lines: string[];
  try {
    lines = readFileSync(jsonlFile, "utf-8").split("\n").filter(Boolean);
  } catch {
    return [];
  }

  // 检查版本：找到第一个 assistant message，看其 model 字段
  let isTargetVersion = false;
  let currentQueryId: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    const type = record.type as string;

    // 追踪 queryId（summary 记录里有 sessionId）
    if (type === "summary") {
      const sessionData = record as { sessionId?: string };
      currentQueryId = null;
    }

    // assistant 消息里能看到 model 版本
    if (type === "assistant") {
      const msg = record.message as { model?: string; usage?: unknown } | undefined;
      if (msg?.model?.includes(TARGET_VERSION) || msg?.model?.includes("claude-opus-4-7")) {
        isTargetVersion = true;
      }
      // 从 uuid 提取 queryId
      if (record.uuid && record.parentUuid) {
        currentQueryId = record.uuid as string;
      }
    }

    // 检查 user message（含 tool_result 的消息）
    if (type === "user") {
      const msg = record.message as {
        role?: string;
        content?: unknown;
      } | undefined;

      if (!msg || msg.role !== "user") continue;

      const content = msg.content;
      if (!Array.isArray(content)) continue;

      const queryId = (record.uuid as string) ?? currentQueryId ?? "unknown";

      // 场景1：单个 tool_result 但 content 是多个 block 的数组
      for (let j = 0; j < content.length; j++) {
        const item = content[j] as Record<string, unknown>;
        if (item.type !== "tool_result") continue;

        const toolContent = item.content;
        if (Array.isArray(toolContent) && toolContent.length > 1) {
          cases.push({
            jsonlFile,
            sessionId,
            queryId,
            kind: "multi_block_tool_result",
            detail: `tool_result[${j}] content 有 ${toolContent.length} 个 block，tool_use_id=${item.tool_use_id}`,
            messageIndex: i,
            toolUseId: item.tool_use_id as string,
            blockCount: toolContent.length,
          });
        }
      }

      // 场景2：一条 user message 中有多个 tool_result items
      const toolResults = content.filter(
        (item: unknown) => (item as Record<string, unknown>).type === "tool_result",
      );
      if (toolResults.length > 1) {
        // 这是正常的多 tool_result（每次 tool call 对应一个 result），不算 merge 场景
        // 但检查是否有同一 tool_use_id 出现多次（真正的 N:1 场景）
        const toolUseIds = toolResults.map(
          (r: unknown) => (r as Record<string, unknown>).tool_use_id as string,
        );
        const dup = toolUseIds.find((id, idx) => toolUseIds.indexOf(id) !== idx);
        if (dup) {
          cases.push({
            jsonlFile,
            sessionId,
            queryId,
            kind: "multi_tool_result_in_message",
            detail: `同一 tool_use_id "${dup}" 在同一 user message 中出现多次`,
            messageIndex: i,
            toolUseId: dup,
            blockCount: toolUseIds.filter((id) => id === dup).length,
          });
        }
      }
    }
  }

  return cases;
}

function getAllJsonlFiles(): string[] {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) {
    console.error(`CLAUDE_PROJECTS_DIR 不存在: ${CLAUDE_PROJECTS_DIR}`);
    return [];
  }

  const files: string[] = [];
  const projectDirs = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(CLAUDE_PROJECTS_DIR, e.name));

  for (const dir of projectDirs) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(join(dir, entry.name));
      }
    }
  }

  return files;
}

// ─────────────────────────────────────────────────────────────────────────────
// 主逻辑
// ─────────────────────────────────────────────────────────────────────────────

const allJsonls = getAllJsonlFiles();
console.log(`扫描 ${allJsonls.length} 个 JSONL 文件...`);

const allCases: FoundCase[] = [];
let scanned = 0;

for (const f of allJsonls) {
  const found = scanJsonlFile(f);
  if (found.length > 0) {
    allCases.push(...found);
  }
  scanned++;
  if (scanned % 50 === 0) {
    process.stdout.write(`\r  ${scanned}/${allJsonls.length} 已扫描，发现 ${allCases.length} 个 case`);
  }
}

console.log(`\r  ${scanned}/${allJsonls.length} 已扫描，发现 ${allCases.length} 个 case`);

if (allCases.length === 0) {
  console.log("\n结论：未找到任何 N:1 merge 场景（multi_block_tool_result 或重复 tool_use_id）。");
  process.exit(0);
}

console.log(`\n发现 ${allCases.length} 个 case：\n`);

for (const c of allCases) {
  console.log(`[${c.kind}]`);
  console.log(`  文件: ${c.jsonlFile}`);
  console.log(`  session: ${c.sessionId}`);
  console.log(`  queryId: ${c.queryId}`);
  console.log(`  行号: ${c.messageIndex}`);
  console.log(`  详情: ${c.detail}`);
  console.log();
}

// 按类型统计
const byKind = new Map<string, number>();
for (const c of allCases) {
  byKind.set(c.kind, (byKind.get(c.kind) ?? 0) + 1);
}
console.log("统计：");
for (const [kind, count] of byKind) {
  console.log(`  ${kind}: ${count} 个`);
}

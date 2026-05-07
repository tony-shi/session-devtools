// matcher：顶层刚性切割引擎
// ─────────────────────────────────────────────────────────────────────────────
// 设计原则（与 phase1 prompt 对齐）：
//   1. 只做 wire 顶层位置切割，不做语义判断。
//   2. 路由判断只用 startsWith / indexOf / 字符串相等，不用 regex。
//      WHY：regex 在 anchor 阶段容易误吃 / 漏吃；matcher 只决定大块归槽。
//   3. H1 section / inline tag 等子结构由 snapshot(AST builder) 依据 template
//      继续展开，matcher 不递归建树。
//   4. parser/ 不 import proxy/ 或 rules/ 下任何文件。
//
// ─────────────────────────────────────────────────────────────────────────────
// TODO：架构优化（低优先级，待 ContextRule 层稳定后再推进）
//
//   现状：matcher 只承担顶层路由，snapshot 承接递归建树 + 装饰（id / hash / nodeKind）。
//
//   目标架构（两层）：
//     Layer 1  JSON → 顶层 SlotMatch → ParsedQuerySnapshot(AST)
//     Layer 2  AST + ContextRule → 语义分析
//       - pattern 命中（哪些 slot 满足哪条规则）
//       - 动态字段提取（从 rawText 抠出变量值）
//       - 归因（每个字符属于哪个 slot / rule）
//       - coverage（已归因字符 / 总字符）
//
//   当前契约边界：ParsedQuerySnapshot 是 Layer 1/2 的稳定接口，保持不变。

import type { RequestTemplate, TemplateSlot } from "../template/types";
import type { SlotMatch } from "./types";
import { UNKNOWN_SLOT } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// 输入类型
// ─────────────────────────────────────────────────────────────────────────────

export interface MatchSlotsInput {
  reqBody: {
    system?: Array<{ type: string; text: string; cache_control?: unknown }>;
    tools?: Array<{ name: string; description?: string; input_schema?: unknown }>;
    messages?: Array<{
      role: string;
      content:
        | string
        | Array<{
            type: string;
            text?: string;
            id?: string;
            name?: string;
            input?: unknown;
            tool_use_id?: string;
            content?: string | Array<{ type: string; text?: string }>;
            cache_control?: unknown;
          }>;
    }>;
  };
  template: RequestTemplate;
}

// ─────────────────────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────────────────────

export function matchSlots(input: MatchSlotsInput): SlotMatch[] {
  const out: SlotMatch[] = [];
  const { reqBody, template } = input;

  // ── system blocks ────────────────────────────────────────────────────────
  const systemBlocks = reqBody.system ?? [];
  for (let i = 0; i < systemBlocks.length; i++) {
    const blk = systemBlocks[i]!;
    const text = blk.text ?? "";
    const routedSlot = routeSystemSlot(text, template.slots.system);
    const jsonPath = `reqBody.system[${i}]`;
    const slotId = routedSlot?.id ?? UNKNOWN_SLOT.SYSTEM_BLOCK;
    const match: SlotMatch = {
      slotId,
      jsonPath,
      rawText: text,
      anchorEvidence: routedSlot ? anchorEvidenceOf(routedSlot, text) : "",
      children: [],
      // system block 完全无法路由时（template 缺少 fallback slot），产出 unknown
      ...(routedSlot === null && {
        unknownMeta: {
          originalType: "system_block",
          reason: "no matching anchor or fallback in template",
        },
      }),
    };
    out.push(match);
  }

  // ── tools ────────────────────────────────────────────────────────────────
  const tools = reqBody.tools ?? [];
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i]!;
    const rawText = tool.description ?? JSON.stringify(tool);
    out.push({
      // 动态 slotId：tools.builtin.{name}
      slotId: `tools.builtin.${tool.name}`,
      jsonPath: `reqBody.tools[${i}]`,
      rawText,
      anchorEvidence: tool.name,
      children: [],
    });
  }

  // ── messages ─────────────────────────────────────────────────────────────
  const messages = reqBody.messages ?? [];
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi]!;
    const content = msg.content;

    // string content：整条作为 messages.text 段
    if (typeof content === "string") {
      out.push({
        slotId: "messages.text",
        jsonPath: `reqBody.messages[${mi}]`,
        rawText: content,
        anchorEvidence: "",
        children: [],
      });
      continue;
    }

    // array content：按 block.type 分流
    if (!Array.isArray(content)) continue;
    for (let bi = 0; bi < content.length; bi++) {
      const blk = content[bi]!;
      const jsonPath = `reqBody.messages[${mi}].content[${bi}]`;

      if (blk.type === "text") {
        const rawText = blk.text ?? "";
        out.push({
          slotId: "messages.text",
          jsonPath,
          rawText,
          anchorEvidence: "",
          children: [],
        });
      } else if (blk.type === "tool_use") {
        const rawText = JSON.stringify({
          id: blk.id,
          name: blk.name,
          input: blk.input,
        });
        out.push({
          slotId: "messages.tool_use",
          jsonPath,
          rawText,
          anchorEvidence: blk.name ?? "",
          children: [],
        });
      } else if (blk.type === "tool_result") {
        out.push({
          slotId: "messages.tool_result",
          jsonPath,
          rawText: extractToolResultText(blk.content),
          anchorEvidence: blk.tool_use_id ?? "",
          children: [],
        });
      } else {
        // 未知 block type（image、document 等）：保留原始内容，不丢字符。
        // 阶段 2 按需补 slot；这里先产出 messages.block.unknown 供 audit 识别 gap。
        out.push({
          slotId: UNKNOWN_SLOT.MESSAGES_BLOCK,
          jsonPath,
          rawText: JSON.stringify(blk),
          anchorEvidence: blk.type ?? "",
          children: [],
          unknownMeta: {
            originalType: blk.type ?? "unknown",
            reason: "unrecognized content block type",
          },
        });
      }
    }
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// system 路由
// ─────────────────────────────────────────────────────────────────────────────

/** 按 anchor 顺序逐一匹配，命中则返回；都不命中则 fallback 到 main-prompt-block。
 *  routing 顺序与 splitSysPromptPrefix 对应：
 *    billing  → startsWith("x-anthropic-billing-header")
 *    identity → CLI_SYSPROMPT_PREFIXES（"You are Claude Code" 等）
 *    rest     → 兜底，即 main-prompt-block（含 gitStatus 拼尾）
 *  WHY 不用 regex：只比 trimStart() 后的前缀，避免被前导空白干扰。
 */
// 返回 null 表示完全无法路由（template 里没有无 anchor 的兜底 slot）。
// 正常情况下 main-prompt-block 作为 fallback 保证不会 null；
// 如果 template 定义不完整，返回 null → matcher 产出 system.block.unknown。
function routeSystemSlot(text: string, slots: TemplateSlot[]): TemplateSlot | null {
  const trimmed = text.trimStart();
  let fallback: TemplateSlot | undefined;

  for (const slot of slots) {
    if (!slot.anchor) {
      fallback = slot;
      continue;
    }
    const a = slot.anchor;
    if (a.kind === "literal" && trimmed.startsWith(a.text)) {
      return slot;
    }
  }
  return fallback ?? null;
}

function anchorEvidenceOf(slot: TemplateSlot, text: string): string {
  if (!slot.anchor) return "";
  const a = slot.anchor;
  if (a.kind === "literal") return a.text;
  if (a.kind === "h1_header") return `# ${a.header}`;
  if (a.kind === "tag_prefix") return a.prefix;
  // 兜底：取首行
  const idx = text.indexOf("\n");
  return idx === -1 ? text : text.slice(0, idx);
}

// ─────────────────────────────────────────────────────────────────────────────
// tool_result 文本提取
// ─────────────────────────────────────────────────────────────────────────────

function extractToolResultText(
  content: string | Array<{ type: string; text?: string }> | undefined,
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  // 拼接所有 type==="text" 的 text 字段；其他 type（image 等）暂忽略
  return content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text!)
    .join("");
}

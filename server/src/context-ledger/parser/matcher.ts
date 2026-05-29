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
import type { CachePolicy, SlotMatch } from "./types";
import { UNKNOWN_SLOT } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// 输入类型
// ─────────────────────────────────────────────────────────────────────────────

export interface MatchSlotsInput {
  reqBody: {
    system?: Array<{ type: string; text: string; cache_control?: unknown }>;
    tools?: Array<{ name: string; description?: string; input_schema?: unknown; cache_control?: unknown }>;
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
    const slotType = routedSlot?.id ?? UNKNOWN_SLOT.SYSTEM_BLOCK;
    const match: SlotMatch = {
      slotType,
      jsonPath,
      rawText: text,
      anchorEvidence: routedSlot ? anchorEvidenceOf(routedSlot, text) : "",
      children: [],
      cachePolicy: parseCachePolicy(blk.cache_control as Record<string, unknown> | undefined),
      // system block 完全无法路由时（template 缺少 fallback slot），产出 unknown
      ...(routedSlot === null && {
        unknownMeta: { originalType: "system_block", reason: "no matching anchor or fallback in template" },
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
      // 动态 slotType：tools.builtin.{name}
      slotType: `tools.builtin.${tool.name}`,
      jsonPath: `reqBody.tools[${i}]`,
      rawText,
      anchorEvidence: tool.name,
      children: [],
      cachePolicy: parseCachePolicy(tool.cache_control as Record<string, unknown> | undefined),
    });
  }

  // ── messages ─────────────────────────────────────────────────────────────
  const messages = reqBody.messages ?? [];
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi]!;
    const content = msg.content;
    const roleNorm = msg.role === "assistant" || msg.role === "user" || msg.role === "system"
      ? msg.role
      : undefined;

    // string content：整条作为 messages.text 段（role=system 走 mid-conversation
    // system message slot，见上方 text block 注释）
    if (typeof content === "string") {
      out.push({
        slotType: roleNorm === "system" ? "messages.system-message" : "messages.text",
        jsonPath: `reqBody.messages[${mi}]`,
        rawText: content,
        anchorEvidence: "",
        children: [],
        wireMeta: { messageIdx: mi, ...(roleNorm && { messageRole: roleNorm }) },
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
        // 2.1.154+ beta：Opus 4.8 等 supported model 上，部分 harness 注入从
        // <system-reminder> 迁移到 mid-conversation role:"system" message（裸文本，
        // 无 <system-reminder> 包裹）。整段是一个注入单元（deferred-tools / agent-types
        // 等），路由到独立 slot messages.system-message，不走 messages.text 的 inline
        // 切分。role=user/assistant 的 text 仍走 messages.text。
        out.push({
          slotType: roleNorm === "system" ? "messages.system-message" : "messages.text",
          jsonPath,
          rawText,
          anchorEvidence: "",
          children: [],
          cachePolicy: parseCachePolicy(blk.cache_control as Record<string, unknown> | undefined),
          wireMeta: { messageIdx: mi, ...(roleNorm && { messageRole: roleNorm }) },
        });
      } else if (blk.type === "tool_use") {
        const rawText = JSON.stringify({
          id: blk.id,
          name: blk.name,
          input: blk.input,
        });
        out.push({
          slotType: "messages.tool_use",
          jsonPath,
          rawText,
          anchorEvidence: blk.name ?? "",
          children: [],
          cachePolicy: parseCachePolicy(blk.cache_control as Record<string, unknown> | undefined),
          wireMeta: {
            messageIdx: mi,
            ...(roleNorm && { messageRole: roleNorm }),
            ...(blk.id && { toolUseId: blk.id }),
            ...(blk.name && { toolName: blk.name }),
          },
        });
      } else if (blk.type === "thinking" || blk.type === "redacted_thinking") {
        // extended thinking 块：
        //   { type: "thinking",          thinking: "...", signature: "<base64>" }
        //   { type: "redacted_thinking", data: "<base64-encrypted>" }
        // signature/data 是 Anthropic 服务端按 thinking 内容算出的唯一 token，
        // 跨 turn 1:1 稳定 —— 用作 jsonl-linker 的 deterministic join key。
        const sig = (blk as { signature?: string; data?: string }).signature
          ?? (blk as { signature?: string; data?: string }).data;
        // Opus 4.7 thinking 在 wire 上是 `{ thinking: "", signature: "<base64>" }`：
        // 思考正文服务端 redacted，但 signature 是真实占 prompt input token 的 wire 字节。
        // 用 thinking || signature 作 rawText 是为了：
        //   1) charCount 反映该块在 request body 真实占的字节数（不再误报 0）；
        //   2) detail panel 仍能看到完整 signature 字符串（保留 raw 能力）。
        // 老 Sonnet 风格（thinking 字段非空）走前支，行为不变。
        // jsonl-linker 用 wireMeta.thinkingSignature 做 join，不依赖 rawText —— 安全。
        const text = blk.type === "thinking"
          ? ((blk as { thinking?: string }).thinking
              || (blk as { signature?: string }).signature
              || "")
          : ((blk as { data?: string }).data ?? "");
        out.push({
          slotType: "messages.thinking",
          jsonPath,
          rawText: text,
          anchorEvidence: blk.type,
          children: [],
          cachePolicy: parseCachePolicy(blk.cache_control as Record<string, unknown> | undefined),
          wireMeta: {
            messageIdx: mi,
            ...(roleNorm && { messageRole: roleNorm }),
            ...(sig && { thinkingSignature: sig }),
          },
        });
      } else if (blk.type === "tool_result") {
        out.push({
          slotType: "messages.tool_result",
          jsonPath,
          rawText: extractToolResultText(blk.content),
          anchorEvidence: blk.tool_use_id ?? "",
          children: [],
          cachePolicy: parseCachePolicy(blk.cache_control as Record<string, unknown> | undefined),
          wireMeta: {
            messageIdx: mi,
            ...(roleNorm && { messageRole: roleNorm }),
            ...(blk.tool_use_id && { toolUseId: blk.tool_use_id }),
          },
        });
      } else if (blk.type === "image") {
        // image content block：Anthropic 协议固定类型，含 source.{type,media_type,data|url}。
        // rawText 保留完整 JSON 字面量（含 base64 data），便于后续 rule 命中 +
        // jsonl-linker 用 source.data 指纹做 deterministic 匹配。
        out.push({
          slotType: "messages.block.image",
          jsonPath,
          rawText: JSON.stringify(blk),
          anchorEvidence: "image",
          children: [],
          cachePolicy: parseCachePolicy(blk.cache_control as Record<string, unknown> | undefined),
          wireMeta: { messageIdx: mi, ...(roleNorm && { messageRole: roleNorm }) },
        });
      } else {
        // 其他未识别 block type（document 等）：保留原始内容，不丢字符。
        // 待新增协议类型时按需补 slot；当前产出 messages.block.unknown 供 audit 识别 gap。
        out.push({
          slotType: UNKNOWN_SLOT.MESSAGES_BLOCK,
          jsonPath,
          rawText: JSON.stringify(blk),
          anchorEvidence: blk.type ?? "",
          children: [],
          unknownMeta: {
            originalType: blk.type ?? "unknown",
            reason: "unrecognized content block type",
          },
          wireMeta: { messageIdx: mi, ...(roleNorm && { messageRole: roleNorm }) },
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
  content: string | Array<{ type: string; text?: string; tool_name?: string }> | undefined,
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      if (c.type === "text" && typeof c.text === "string") return c.text;
      // tool_reference: ToolSearchTool 的 deferred-load 占位块，没有文本内容
      // 但需要有可读的 rawText 让归因视图知道这个 slot 存在。
      if (c.type === "tool_reference" && typeof c.tool_name === "string")
        return `[tool_reference: ${c.tool_name}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// cache_control → CachePolicy
// ─────────────────────────────────────────────────────────────────────────────

/** wire 层 cache_control 对象 → 结构化 CachePolicy；无 cache_control 时返回 undefined */
function parseCachePolicy(cc: Record<string, unknown> | undefined): CachePolicy | undefined {
  if (!cc || cc["type"] !== "ephemeral") return undefined;
  const ttl: CachePolicy["ttl"] = cc["ttl"] === "1h" ? "1h" : "5m";
  const scope: CachePolicy["scope"] = cc["scope"] === "global" ? "global" : "org";
  return { ttl, scope };
}

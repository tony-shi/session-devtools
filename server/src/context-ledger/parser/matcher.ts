// matcher：核心切分引擎
// ─────────────────────────────────────────────────────────────────────────────
// 设计原则（与 phase1 prompt 对齐）：
//   1. 只做"位置切分"，不做语义判断（语义识别留给阶段 2 的 SubRule）。
//   2. 路由判断只用 startsWith / indexOf / 字符串相等，不用 regex。
//      WHY：regex 在 anchor 阶段容易误吃 / 漏吃，先用最朴素的字符串匹配把
//      边界确定下来，后续如果要做内容识别，再在 slot 内部用 SubRule 处理。
//   3. parser/ 不 import proxy/ 或 rules/ 下任何文件。
//
// ─────────────────────────────────────────────────────────────────────────────
// TODO：架构优化（低优先级，待 SubRule 层稳定后再推进）
//
//   现状：matcher 承担了"顶层路由"和"递归建树"两个职责（H1 切分、inline 切分
//         都在此完成），导致 snapshot 只做 SlotMatch → SegmentNode 的格式转换。
//
//   目标架构（两层）：
//     Layer 1  parser → AST（ParsedQuerySnapshot）
//       - matcher 只做顶层路由，产出 flat SlotMatch[]
//       - snapshot 承接递归建树 + 装饰（id / hash / nodeKind）
//       - SlotMatch 降级为 parser 内部类型，不对外 export
//
//     Layer 2  AST + SubRule → 语义分析
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
    // 命中 fallback 主块时，再做 H1 切分
    if (slotId === "system.main-prompt-block" && routedSlot?.children) {
      match.children = splitByH1Headers(text, routedSlot.children, jsonPath);
    }
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
        children: splitInlineTags(content, `reqBody.messages[${mi}]`),
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
          children: splitInlineTags(rawText, jsonPath),
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
// H1 切分（system.main-prompt-block 内部）
// ─────────────────────────────────────────────────────────────────────────────

/** 按行扫描，遇到 "# Header" 就切一段；H1 之前的内容归入 prelude。
 *  WHY：用最朴素的 line.startsWith("# ") + slice(2).trim()，
 *  不用 regex——避免误吃缩进里的 "#"、代码块里的 "#" 等情况。
 */
function splitByH1Headers(
  text: string,
  childSlots: TemplateSlot[],
  parentJsonPath: string,
): SlotMatch[] {
  // 找出所有 H1 行的偏移（line start 的 char index）
  type H1 = { lineStart: number; lineEnd: number; header: string };
  const h1s: H1[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const lineEnd = text.indexOf("\n", cursor);
    const lineEndExclusive = lineEnd === -1 ? text.length : lineEnd;
    const line = text.slice(cursor, lineEndExclusive);
    if (line.startsWith("# ")) {
      h1s.push({
        lineStart: cursor,
        lineEnd: lineEndExclusive,
        header: line.slice(2).trim(),
      });
    }
    if (lineEnd === -1) break;
    cursor = lineEnd + 1;
  }

  // 找各子 slot 的 anchor → 映射；prelude 是无 anchor 的兜底
  const headerToSlot = new Map<string, TemplateSlot>();   // h1_header anchor
  const literalSlots: TemplateSlot[] = [];                // literal anchor（如 system.section.context）
  let preludeSlot: TemplateSlot | undefined;
  let unknownSlot: TemplateSlot | undefined;
  for (const cs of childSlots) {
    if (!cs.anchor) {
      if (!preludeSlot) preludeSlot = cs;
      else unknownSlot = cs;
      continue;
    }
    if (cs.anchor.kind === "h1_header") {
      headerToSlot.set(cs.anchor.header, cs);
    } else if (cs.anchor.kind === "literal") {
      // literal anchor 的子 slot（如 system.section.context / gitStatus:）
      // 在 H1 切分完成后，对最后一段做尾部剥离
      literalSlots.push(cs);
    }
  }

  const out: SlotMatch[] = [];

  // prelude：第一个 H1 之前
  const firstH1Start = h1s.length > 0 ? h1s[0]!.lineStart : text.length;
  if (firstH1Start > 0 && preludeSlot) {
    const rawText = text.slice(0, firstH1Start);
    if (rawText.length > 0) {
      out.push({
        slotId: preludeSlot.id,
        jsonPath: parentJsonPath,
        charRange: { start: 0, end: firstH1Start },
        rawText,
        anchorEvidence: "",
        children: [],
      });
    }
  }

  // 各 H1 段：从本 H1 lineStart 到下一个 H1 lineStart（或文末）
  for (let i = 0; i < h1s.length; i++) {
    const h1 = h1s[i]!;
    const nextStart = i + 1 < h1s.length ? h1s[i + 1]!.lineStart : text.length;
    const rawText = text.slice(h1.lineStart, nextStart);
    const slot = headerToSlot.get(h1.header) ?? unknownSlot ?? preludeSlot;
    // 路由规则：只有 headerToSlot 里明确定义的 header 才能命中 known slot；
    // 未命中时一律走 system.section.unknown，不归入 prelude。
    // WHY：prelude 语义是"H1 之前的前导段"，不是"未知 H1 兜底"；
    //      把未知 H1 塞进 prelude 会在 audit 时混淆覆盖率统计。
    const knownSlot = headerToSlot.get(h1.header) ?? unknownSlot;
    if (knownSlot) {
      out.push({
        slotId: knownSlot.id,
        jsonPath: parentJsonPath,
        charRange: { start: h1.lineStart, end: nextStart },
        rawText,
        anchorEvidence: `# ${h1.header}`,
        children: [],
      });
    } else {
      out.push({
        slotId: UNKNOWN_SLOT.SYSTEM_SECTION,
        jsonPath: parentJsonPath,
        charRange: { start: h1.lineStart, end: nextStart },
        rawText,
        anchorEvidence: `# ${h1.header}`,
        children: [],
        unknownMeta: {
          sectionHeader: h1.header,
          reason: "H1 header not in template slot map",
        },
      });
    }
  }

  // literal anchor 子 slot 的尾部剥离
  // WHY：appendSystemContext 把 gitStatus 等以 "key: value\n" 格式 push 到 systemPrompt
  // 数组末尾，最终被 rest.join('\n\n') 合并进 block[2] 末尾，不是独立 block。
  // 这里把最后一段里的 literal 前缀位置找出来，把尾部切成独立 child。
  for (const litSlot of literalSlots) {
    const anchor = litSlot.anchor as { kind: "literal"; text: string };
    if (out.length === 0) continue;

    // 在整个 text 里找该 literal 的起始位置（只找第一次出现）
    const litIdx = text.indexOf(anchor.text);
    if (litIdx === -1) continue;

    // 找包含 litIdx 的那个 out segment，把它从 litIdx 处截断
    const parentIdx = out.findIndex(
      (m) => m.charRange && m.charRange.start <= litIdx && litIdx < m.charRange.end,
    );
    if (parentIdx === -1) continue;

    const parent = out[parentIdx]!;
    const parentEnd = parent.charRange!.end;

    // 把 parent 截到 litIdx，尾部独立成 litSlot
    // 若 parent 截断后为空（litIdx === parent 起始），直接替换
    if (litIdx > parent.charRange!.start) {
      out[parentIdx] = {
        ...parent,
        rawText: text.slice(parent.charRange!.start, litIdx),
        charRange: { start: parent.charRange!.start, end: litIdx },
      };
    } else {
      out.splice(parentIdx, 1);
    }

    out.push({
      slotId: litSlot.id,
      jsonPath: parentJsonPath,
      charRange: { start: litIdx, end: parentEnd },
      rawText: text.slice(litIdx, parentEnd),
      anchorEvidence: anchor.text,
      children: [],
    });
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// inline 切分（messages.text 内部）
// ─────────────────────────────────────────────────────────────────────────────

/** 从头到尾线性扫描 rawText，切出 system-reminder / local-command / free-text 三类段。
 *  charRange 是相对于父 SlotMatch rawText 的起始偏移。
 *  WHY：tag 边界用 startsWith 探测，闭合标签用 indexOf 找——简单直接，
 *  不用栈式 parser，因为目前只关心顶层 tag，嵌套很罕见且阶段 2 才处理。
 */
function splitInlineTags(text: string, parentJsonPath: string): SlotMatch[] {
  const out: SlotMatch[] = [];
  if (!text) return out;

  let cursor = 0;
  let freeTextStart = 0;

  // 在指定起点尝试匹配 tag；命中返回 tag 名，未命中返回 null
  function tagAt(pos: number): { kind: "system-reminder" | "local-command"; openLen: number } | null {
    if (text.startsWith("<system-reminder>", pos)) {
      return { kind: "system-reminder", openLen: "<system-reminder>".length };
    }
    if (text.startsWith("<local-command-", pos)) {
      // 不强求 open tag 立刻闭合，openLen 用前缀长度作启发式即可
      return { kind: "local-command", openLen: "<local-command-".length };
    }
    return null;
  }

  function flushFreeText(end: number): void {
    if (end <= freeTextStart) return;
    const rawText = text.slice(freeTextStart, end);
    if (rawText.length === 0) return;
    out.push({
      slotId: "messages.inline.free-text",
      jsonPath: parentJsonPath,
      charRange: { start: freeTextStart, end },
      rawText,
      anchorEvidence: "",
      children: [],
    });
  }

  while (cursor < text.length) {
    const tag = tagAt(cursor);
    if (!tag) {
      cursor++;
      continue;
    }

    // 先把前面攒的 free-text 吐掉
    flushFreeText(cursor);

    // 找闭合标签
    let closeTag: string;
    let anchorPrefix: string;
    let slotId: string;
    if (tag.kind === "system-reminder") {
      closeTag = "</system-reminder>";
      anchorPrefix = "<system-reminder>";
      slotId = "messages.inline.system-reminder";
    } else {
      closeTag = "</local-command-stdout>";
      anchorPrefix = "<local-command-";
      slotId = "messages.inline.local-command";
    }

    // 闭合标签搜索：local-command 闭合形式可能多样（stdout/stderr/...），用通用 "</local-command-" 起首再找 ">"
    let segEnd: number;
    if (tag.kind === "local-command") {
      const closeStart = text.indexOf("</local-command-", cursor + tag.openLen);
      if (closeStart === -1) {
        segEnd = text.length;
      } else {
        const closeGT = text.indexOf(">", closeStart);
        segEnd = closeGT === -1 ? text.length : closeGT + 1;
      }
    } else {
      const closeStart = text.indexOf(closeTag, cursor + tag.openLen);
      segEnd = closeStart === -1 ? text.length : closeStart + closeTag.length;
    }

    // 闭合标签后紧跟的换行符归入本 segment，不切成独立 free-text。
    // WHY：Claude Code 生成这类 tag 时闭合标签后会跟 \n 或 \n\n（段间空行），
    // 把它们留在 tag segment 里能保持字节总数与 wire 一致，
    // 也避免产生 rawText="\n" 的噪声 free-text segment。
    while (segEnd < text.length) {
      if (text[segEnd] === "\r" && text[segEnd + 1] === "\n") {
        segEnd += 2;
      } else if (text[segEnd] === "\n") {
        segEnd += 1;
      } else {
        break;
      }
    }

    const rawText = text.slice(cursor, segEnd);
    out.push({
      slotId,
      jsonPath: parentJsonPath,
      charRange: { start: cursor, end: segEnd },
      rawText,
      anchorEvidence: anchorPrefix,
      children: [],
    });

    cursor = segEnd;
    freeTextStart = segEnd;
  }

  // 收尾 free-text
  flushFreeText(text.length);

  return out;
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

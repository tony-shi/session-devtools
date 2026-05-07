// ast-builder：把 matcher 产出的顶层 SlotMatch 转成 ParsedQuerySnapshot（AST 结构）
// 主要职责：
//   1. 给每个节点分配稳定 id（按 section + 出现顺序，规则与重构前 segments 数组一致）
//   2. 计算 rawHash（sha256 前 16 位）和 charCount
//   3. 基于 template 展开 H1 section / inline tag 等二级结构
//   4. 递归构建 SegmentNode 树，同时填充 index（所有节点平铺，O(1) 查找）

import { createHash } from "crypto";
import type { SlotMatch, SegmentNode, ParsedQuerySnapshot } from "./types";
import { UNKNOWN_SLOT } from "./types";
import type { RequestTemplate, TemplateSlot } from "../template/types";

// ─────────────────────────────────────────────────────────────────────────────
// id 命名规则（与重构前 segments 数组严格一致，保证 index 里 id 不变）
//   系统 block，无 H1 切分         seg-system-{i}
//   系统 block，H1 切分子 section  seg-system-{i}-s{si}
//   tool                           seg-tool-{i}
//   message block                  seg-msg-{mi}-{bi}
//   message inline 切分            seg-msg-{mi}-{bi}-inline-{ii}
// ─────────────────────────────────────────────────────────────────────────────

export function buildParsedQuerySnapshot(params: {
  allSlotMatches: SlotMatch[];
  template: RequestTemplate;
  queryKind: "main_session" | "side_query" | "unknown";
  proxyFile: string;
  ts: string;
}): ParsedQuerySnapshot {
  const { allSlotMatches, template, queryKind, proxyFile, ts } = params;

  const roots: SegmentNode[] = [];
  const index: Record<string, SegmentNode> = {};

  // 各 section 的递增 index（与重构前逻辑相同）
  let systemIdx = 0;
  let toolIdx = 0;

  // ── 递归构建节点 ────────────────────────────────────────────────────────────
  // childIdOf：根据父节点的 slotType 决定子节点 id 后缀规则
  //   system.main-prompt-block 的子节点 → -s{ci}（H1 section）
  //   messages.text 的子节点            → -inline-{ci}
  //   其他                               → -c{ci}（兜底，目前不触发）
  function childIdOf(parentId: string, parentSlotType: string, ci: number): string {
    if (parentSlotType === "system.main-prompt-block") return `${parentId}-s${ci}`;
    if (parentSlotType === "messages.text") return `${parentId}-inline-${ci}`;
    return `${parentId}-c${ci}`;
  }

  function toNode(id: string, match: SlotMatch, parentId?: string): SegmentNode {
    const node: SegmentNode = {
      id,
      slotType: match.slotType,
      jsonPath: match.jsonPath,
      charRange: match.charRange,
      rawText: match.rawText,
      rawHash: hashOf(match.rawText),
      charCount: match.rawText.length,
      children: [],
      parentId,
      ...(match.unknownMeta && { unknownMeta: match.unknownMeta }),
    };
    // matcher 只产出顶层大块；这里根据 template 展开 H1/inline 子节点。
    // 若调用方未来传入了已有 children，优先使用它们，保证旧中间结构仍能被消费。
    const childMatches = match.children.length > 0
      ? match.children
      : expandChildren(match, template);

    node.children = childMatches.map((child, ci) =>
      toNode(childIdOf(id, match.slotType, ci), child, id),
    );
    index[node.id] = node;
    return node;
  }

  // ── 主循环：与重构前 segment id 分配逻辑完全一致 ───────────────────────────
  for (const match of allSlotMatches) {
    const section = sectionOf(match.slotType);

    if (section === "system" || section === "side-query-system") {
      const node = toNode(`seg-system-${systemIdx}`, match);
      roots.push(node);
      systemIdx++;
      continue;
    }

    if (section === "tools") {
      const node = toNode(`seg-tool-${toolIdx}`, match);
      roots.push(node);
      toolIdx++;
      continue;
    }

    if (section === "messages" || section === "side-query-user") {
      const { mi, bi } = parseMessagePath(match.jsonPath);
      const node = toNode(`seg-msg-${mi}-${bi}`, match);
      roots.push(node);
      continue;
    }

    // unknown section：fallback id
    const node = toNode(`seg-unknown-${roots.length}`, match);
    roots.push(node);
  }

  return { queryKind, proxyFile, ts, roots, index };
}

// ─────────────────────────────────────────────────────────────────────────────
// AST 子结构展开
// ─────────────────────────────────────────────────────────────────────────────

function expandChildren(match: SlotMatch, template: RequestTemplate): SlotMatch[] {
  const slot = findTemplateSlot(template, match.slotType);
  if (!slot?.children) return [];

  if (match.slotType === "system.main-prompt-block") {
    return splitByH1Headers(match.rawText, slot.children, match.jsonPath);
  }

  if (match.slotType === "messages.text") {
    return splitInlineTags(match.rawText, match.jsonPath, slot.children);
  }

  return [];
}

function findTemplateSlot(template: RequestTemplate, slotType: string): TemplateSlot | undefined {
  const roots = [
    ...template.slots.system,
    ...template.slots.tools,
    ...template.slots.messages,
  ];

  const stack = [...roots];
  while (stack.length > 0) {
    const slot = stack.shift()!;
    if (slot.id === slotType) return slot;
    if (slot.id === "tools.builtin" && slotType.startsWith("tools.builtin.")) return slot;
    if (slot.children) stack.push(...slot.children);
  }
  return undefined;
}

/** 按行扫描 system.main-prompt-block，遇到 "# Header" 切出 H1 section。
 *  这里属于 AST builder 而非 matcher：matcher 只做 system[] 顶层大块路由；
 *  H1 是块内结构事实，需要 template.children 才能判定 known/unknown slot。
 */
function splitByH1Headers(
  text: string,
  childSlots: TemplateSlot[],
  parentJsonPath: string,
): SlotMatch[] {
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

  const headerToSlot = new Map<string, TemplateSlot>();
  const literalSlots: TemplateSlot[] = [];
  let preludeSlot: TemplateSlot | undefined;
  let unknownSlot: TemplateSlot | undefined;
  for (const childSlot of childSlots) {
    if (!childSlot.anchor) {
      if (!preludeSlot) preludeSlot = childSlot;
      else unknownSlot = childSlot;
      continue;
    }
    if (childSlot.anchor.kind === "h1_header") {
      headerToSlot.set(childSlot.anchor.header, childSlot);
    } else if (childSlot.anchor.kind === "literal") {
      literalSlots.push(childSlot);
    }
  }

  const out: SlotMatch[] = [];

  const firstH1Start = h1s.length > 0 ? h1s[0]!.lineStart : text.length;
  if (firstH1Start > 0 && preludeSlot) {
    const rawText = text.slice(0, firstH1Start);
    if (rawText.length > 0) {
      out.push({
        slotType: preludeSlot.id,
        jsonPath: parentJsonPath,
        charRange: { start: 0, end: firstH1Start },
        rawText,
        anchorEvidence: "",
        children: [],
      });
    }
  }

  for (let i = 0; i < h1s.length; i++) {
    const h1 = h1s[i]!;
    const nextStart = i + 1 < h1s.length ? h1s[i + 1]!.lineStart : text.length;
    const rawText = text.slice(h1.lineStart, nextStart);
    const knownSlot = headerToSlot.get(h1.header) ?? unknownSlot;
    if (knownSlot) {
      out.push({
        slotType: knownSlot.id,
        jsonPath: parentJsonPath,
        charRange: { start: h1.lineStart, end: nextStart },
        rawText,
        anchorEvidence: `# ${h1.header}`,
        children: [],
      });
    } else {
      out.push({
        slotType: UNKNOWN_SLOT.SYSTEM_SECTION,
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

  // literal anchor 子 slot 的尾部剥离。
  // 注意：它只处理 wire 中确实没有独立 H1 的追加尾段，例如早期 gitStatus 形态。
  for (const litSlot of literalSlots) {
    const anchor = litSlot.anchor as { kind: "literal"; text: string };
    if (out.length === 0) continue;

    const litIdx = text.indexOf(anchor.text);
    if (litIdx === -1) continue;

    const parentIdx = out.findIndex(
      (m) => m.charRange && m.charRange.start <= litIdx && litIdx < m.charRange.end,
    );
    if (parentIdx === -1) continue;

    const parent = out[parentIdx]!;
    const parentEnd = parent.charRange!.end;

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
      slotType: litSlot.id,
      jsonPath: parentJsonPath,
      charRange: { start: litIdx, end: parentEnd },
      rawText: text.slice(litIdx, parentEnd),
      anchorEvidence: anchor.text,
      children: [],
    });
  }

  return out;
}

/** 从 messages.text 内扫描已知顶层 tag。未知文本保留为 free-text residual，
 *  不在 AST builder 里做语义判定；具体来源由 attribution 的 ContextRule 解释。
 */
function splitInlineTags(
  text: string,
  parentJsonPath: string,
  childSlots: TemplateSlot[],
): SlotMatch[] {
  const out: SlotMatch[] = [];
  if (!text) return out;

  const systemReminderSlot = childSlots.find((s) => s.id === "messages.inline.system-reminder");
  const localCommandSlot = childSlots.find((s) => s.id === "messages.inline.local-command");
  const freeTextSlot = childSlots.find((s) => s.id === "messages.inline.free-text");

  let cursor = 0;
  let freeTextStart = 0;

  function tagAt(pos: number): { slot: TemplateSlot; kind: "system-reminder" | "local-command"; openLen: number } | null {
    if (systemReminderSlot && text.startsWith("<system-reminder>", pos)) {
      return { slot: systemReminderSlot, kind: "system-reminder", openLen: "<system-reminder>".length };
    }
    if (localCommandSlot && text.startsWith("<local-command-", pos)) {
      return { slot: localCommandSlot, kind: "local-command", openLen: "<local-command-".length };
    }
    return null;
  }

  function flushFreeText(end: number): void {
    if (!freeTextSlot || end <= freeTextStart) return;
    const rawText = text.slice(freeTextStart, end);
    if (rawText.length === 0) return;
    out.push({
      slotType: freeTextSlot.id,
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

    flushFreeText(cursor);

    const anchorPrefix = tag.kind === "system-reminder" ? "<system-reminder>" : "<local-command-";
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
      const closeTag = "</system-reminder>";
      const closeStart = text.indexOf(closeTag, cursor + tag.openLen);
      segEnd = closeStart === -1 ? text.length : closeStart + closeTag.length;
    }

    while (segEnd < text.length) {
      if (text[segEnd] === "\r" && text[segEnd + 1] === "\n") {
        segEnd += 2;
      } else if (text[segEnd] === "\n") {
        segEnd += 1;
      } else {
        break;
      }
    }

    out.push({
      slotType: tag.slot.id,
      jsonPath: parentJsonPath,
      charRange: { start: cursor, end: segEnd },
      rawText: text.slice(cursor, segEnd),
      anchorEvidence: anchorPrefix,
      children: [],
    });

    cursor = segEnd;
    freeTextStart = segEnd;
  }

  flushFreeText(text.length);

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

type Section =
  | "system"
  | "side-query-system"
  | "tools"
  | "messages"
  | "side-query-user"
  | "unknown";

function sectionOf(slotType: string): Section {
  if (slotType.startsWith("system.")) return "system";
  if (slotType === "side-query.system") return "side-query-system";
  if (slotType === "side-query.user") return "side-query-user";
  if (slotType.startsWith("tools.")) return "tools";
  if (slotType.startsWith("messages.")) return "messages";
  return "unknown";
}

/** 从 "reqBody.messages[3].content[2]" 提取 mi=3, bi=2 */
function parseMessagePath(jsonPath: string): { mi: number; bi: number } {
  const miMatch = /messages\[(\d+)\]/.exec(jsonPath);
  const biMatch = /content\[(\d+)\]/.exec(jsonPath);
  return {
    mi: miMatch ? Number(miMatch[1]) : 0,
    bi: biMatch ? Number(biMatch[1]) : 0,
  };
}

function hashOf(text: string): string {
  return "sha256:" + createHash("sha256").update(text).digest("hex").slice(0, 16);
}

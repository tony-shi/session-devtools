// snapshot：把 matcher 产出的 SlotMatch 树转成 ParsedQuerySnapshot（AST 结构）
// 主要职责：
//   1. 给每个节点分配稳定 id（按 section + 出现顺序，规则与重构前 segments 数组一致）
//   2. 计算 rawHash（sha256 前 16 位）和 charCount
//   3. 递归构建 SegmentNode 树，同时填充 index（所有节点平铺，O(1) 查找）

import { createHash } from "crypto";
import type { SlotMatch, SegmentNode, ParsedQuerySnapshot, NodeKind } from "./types";
import { isUnknownSlotId } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// id 命名规则（与重构前 segments 数组严格一致，保证 index 里 id 不变）
//   系统 block，无 H1 切分         seg-system-{i}
//   系统 block，H1 切分子 section  seg-system-{i}-s{si}
//   tool                           seg-tool-{i}
//   message block                  seg-msg-{mi}-{bi}
//   message inline 切分            seg-msg-{mi}-{bi}-inline-{ii}
// ─────────────────────────────────────────────────────────────────────────────

export function buildSnapshot(params: {
  allSlotMatches: SlotMatch[];
  queryKind: "main_session" | "side_query" | "unknown";
  proxyFile: string;
  ts: string;
}): ParsedQuerySnapshot {
  const { allSlotMatches, queryKind, proxyFile, ts } = params;

  const roots: SegmentNode[] = [];
  const index: Record<string, SegmentNode> = {};

  // 各 section 的递增 index（与重构前逻辑相同）
  let systemIdx = 0;
  let toolIdx = 0;

  // ── 递归构建节点 ────────────────────────────────────────────────────────────
  // childIdOf：根据父节点的 slotId 决定子节点 id 后缀规则
  //   system.main-prompt-block 的子节点 → -s{ci}（H1 section）
  //   messages.text 的子节点            → -inline-{ci}
  //   其他                               → -c{ci}（兜底，目前不触发）
  function childIdOf(parentId: string, parentSlotId: string, ci: number): string {
    if (parentSlotId === "system.main-prompt-block") return `${parentId}-s${ci}`;
    if (parentSlotId === "messages.text") return `${parentId}-inline-${ci}`;
    return `${parentId}-c${ci}`;
  }

  function toNode(id: string, match: SlotMatch, parentId?: string): SegmentNode {
    // nodeKind 判断规则：
    //   unknown  — slotId 是 *.unknown fallback，或 matcher 显式标了 unknownMeta
    //   residual — slotId 是 messages.inline.free-text（inline 扫描剩余文本）
    //   known    — 其他
    let nodeKind: NodeKind = "known";
    if (isUnknownSlotId(match.slotId) || match.unknownMeta) {
      nodeKind = "unknown";
    } else if (match.slotId === "messages.inline.free-text") {
      nodeKind = "residual";
    }

    const node: SegmentNode = {
      id,
      slotId: match.slotId,
      nodeKind,
      jsonPath: match.jsonPath,
      charRange: match.charRange,
      rawText: match.rawText,
      rawHash: hashOf(match.rawText),
      charCount: match.rawText.length,
      children: [],
      parentId,
      // 把 matcher 的 unknownMeta 搬运到 metadata 字段
      ...(match.unknownMeta && { metadata: match.unknownMeta }),
    };
    // 递归处理 children
    node.children = match.children.map((child, ci) =>
      toNode(childIdOf(id, match.slotId, ci), child, id),
    );
    index[node.id] = node;
    return node;
  }

  // ── 主循环：与重构前 buildSnapshot 的 id 分配逻辑完全一致 ─────────────────
  for (const match of allSlotMatches) {
    const section = sectionOf(match.slotId);

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
// helpers
// ─────────────────────────────────────────────────────────────────────────────

type Section =
  | "system"
  | "side-query-system"
  | "tools"
  | "messages"
  | "side-query-user"
  | "unknown";

function sectionOf(slotId: string): Section {
  if (slotId.startsWith("system.")) return "system";
  if (slotId === "side-query.system") return "side-query-system";
  if (slotId === "side-query.user") return "side-query-user";
  if (slotId.startsWith("tools.")) return "tools";
  if (slotId.startsWith("messages.")) return "messages";
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

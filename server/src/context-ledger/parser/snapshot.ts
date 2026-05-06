// snapshot：把 matcher 产出的 SlotMatch 树拍平成 ParsedQuerySnapshot
// 主要职责：
//   1. 给每个 segment 分配稳定 id（按 section + 出现顺序）
//   2. 计算 rawHash（sha256 前 16 位）和 charCount
//   3. 保留父子顺序：先父 segment 再 children（children 用 -inline-{ii} 后缀）

import { createHash } from "crypto";
import type { SlotMatch, ParsedSegment, ParsedQuerySnapshot } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// id 命名规则（与 phase1 prompt 严格对齐）
//   - system block，无 H1 切分      seg-system-{i}
//   - system block，H1 切分子 section seg-system-{i}-s{si}
//   - tool                           seg-tool-{i}
//   - message block                  seg-msg-{mi}-{bi}
//   - message inline 切分            seg-msg-{mi}-{bi}-inline-{ii}
// ─────────────────────────────────────────────────────────────────────────────

export function buildSnapshot(params: {
  allSlotMatches: SlotMatch[];
  queryKind: "main_session" | "side_query" | "unknown";
  proxyFile: string;
  ts: string;
}): ParsedQuerySnapshot {
  const { allSlotMatches, queryKind, proxyFile, ts } = params;
  const segments: ParsedSegment[] = [];

  // 各 section 的递增 index
  let systemIdx = 0;
  let toolIdx = 0;
  // messages：用 jsonPath 解析出 (mi, bi)
  // side-query.* 共用 system index 计数（兼容简单形态）

  for (const match of allSlotMatches) {
    const section = sectionOf(match.slotId);

    if (section === "system" || section === "side-query-system") {
      const baseId = `seg-system-${systemIdx}`;
      // 父 segment
      segments.push(toSegment(baseId, match));
      // children：H1 切分的子 section，用 -s{si} 后缀
      for (let si = 0; si < match.children.length; si++) {
        const child = match.children[si]!;
        segments.push(toSegment(`${baseId}-s${si}`, child));
      }
      systemIdx++;
      continue;
    }

    if (section === "tools") {
      segments.push(toSegment(`seg-tool-${toolIdx}`, match));
      toolIdx++;
      continue;
    }

    if (section === "messages" || section === "side-query-user") {
      // 从 jsonPath 解析 (mi, bi)，无法解析时 fallback 0
      const { mi, bi } = parseMessagePath(match.jsonPath);
      const baseId = `seg-msg-${mi}-${bi}`;
      segments.push(toSegment(baseId, match));
      // inline children
      for (let ii = 0; ii < match.children.length; ii++) {
        const child = match.children[ii]!;
        segments.push(toSegment(`${baseId}-inline-${ii}`, child));
      }
      continue;
    }

    // unknown section：用 fallback id，不拦着
    segments.push(toSegment(`seg-unknown-${segments.length}`, match));
  }

  return {
    queryKind,
    proxyFile,
    ts,
    segments,
  };
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

/** 从 "reqBody.messages[3].content[2]" 提取 mi=3, bi=2。
 *  string content 的形式 "reqBody.messages[3]" → mi=3, bi=0
 *  side-query.user "reqBody.messages[0]" 同理。
 */
function parseMessagePath(jsonPath: string): { mi: number; bi: number } {
  const miMatch = /messages\[(\d+)\]/.exec(jsonPath);
  const biMatch = /content\[(\d+)\]/.exec(jsonPath);
  return {
    mi: miMatch ? Number(miMatch[1]) : 0,
    bi: biMatch ? Number(biMatch[1]) : 0,
  };
}

function toSegment(id: string, match: SlotMatch): ParsedSegment {
  return {
    id,
    slotId: match.slotId,
    jsonPath: match.jsonPath,
    charRange: match.charRange,
    rawText: match.rawText,
    rawHash: hashOf(match.rawText),
    charCount: match.rawText.length,
  };
}

function hashOf(text: string): string {
  // sha256 前 16 位足以区分 segment，用全长会让 HTML 变得很长
  return "sha256:" + createHash("sha256").update(text).digest("hex").slice(0, 16);
}

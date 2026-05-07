// parser 输出类型定义
// SlotMatch       = matcher 切分得到的顶层中间结构；children 保留给旧调用和 AST builder 内部递归
// SegmentNode     = snapshot 产出的 AST 节点（树形，带 parentId 反向链接）
// ParsedQuerySnapshot = 一个 query 的完整 parser 产出
//   roots = 顶层节点（system blocks、tools、messages）
//   index = id → node 平铺索引，O(1) 查找
//
// 容错设计：template 描述已知结构，不是合法结构全集。
//   未知结构必须进入 AST，不能被丢弃（否则丢字符，downstream 无法计算 unexplained coverage）。
//   每层都有对应的 unknown fallback slotId：
//     system.block.unknown    — system[] 里无法路由的 block
//     system.section.unknown  — main-prompt-block 内无法路由的 H1 section
//     messages.block.unknown  — messages content[] 里无法识别 type 的 block
//     messages.inline.unknown — inline 切分里的未知段（目前不触发，保留备用）
//     tools.unknown           — tools[] 里无法路由的条目（目前不触发，保留备用）

/** 一个 slot 在 wire body 里的实际匹配结果（matcher 内部中间结构） */
export interface SlotMatch {
  slotId: string;
  jsonPath: string;
  charRange?: { start: number; end: number };
  rawText: string;
  /** 触发本次切分的锚字符串，调试用 */
  anchorEvidence: string;
  children: SlotMatch[];
  /** 容错元数据：matcher 在产出 unknown 节点时填写 */
  unknownMeta?: {
    /** 触发 unknown 的原始 block type（如 "image"）或 H1 header 文本 */
    originalType?: string;
    /** H1 节点：实际 header 文本 */
    sectionHeader?: string;
    /** 产出 unknown 节点的原因说明 */
    reason?: string;
  };
}

/**
 * nodeKind 语义：
 *   known    — slotId 在 template 里有明确定义，切分逻辑已覆盖
 *   unknown  — 结构层级可识别（知道是 system block / H1 section / message block），
 *              但 slotId 没有对应规则，进入 *.unknown fallback
 *   residual — inline 扫描后的剩余文本（free-text），没有明确 tag 触发
 */
export type NodeKind = "known" | "unknown" | "residual";

/** AST 节点：一个 segment 在树里的表示 */
export interface SegmentNode {
  id: string;
  /** known slot 名（如 "system.section.doing-tasks"）或 unknown fallback 名 */
  slotId: string;
  nodeKind: NodeKind;
  jsonPath: string;
  charRange?: { start: number; end: number };
  rawText: string;
  /** sha256 前 16 位，格式 "sha256:xxxxxxxxxxxxxxxx" */
  rawHash: string;
  charCount: number;
  children: SegmentNode[];
  /** 父节点 id；根节点为 undefined */
  parentId?: string;
  /** 容错 / 调试元数据，unknown / residual 节点填写 */
  metadata?: {
    originalType?: string;
    sectionHeader?: string;
    reason?: string;
  };
}

export interface ParsedQuerySnapshot {
  queryKind: "main_session" | "side_query" | "unknown";
  proxyFile: string;
  ts: string;
  /** 顶层节点（system blocks / tools / messages），不含子节点的平铺 */
  roots: SegmentNode[];
  /** id → node 平铺索引，包含所有层级节点，O(1) 查找 */
  index: Record<string, SegmentNode>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Unknown slotId 常量（供 matcher / snapshot / audit 统一引用）
// ─────────────────────────────────────────────────────────────────────────────

export const UNKNOWN_SLOT = {
  SYSTEM_BLOCK:    "system.block.unknown",
  SYSTEM_SECTION:  "system.section.unknown",
  MESSAGES_BLOCK:  "messages.block.unknown",
  MESSAGES_INLINE: "messages.inline.unknown",
  TOOLS:           "tools.unknown",
} as const;

/** 判断一个 slotId 是否为 unknown fallback */
export function isUnknownSlotId(slotId: string): boolean {
  return Object.values(UNKNOWN_SLOT).includes(slotId as never);
}

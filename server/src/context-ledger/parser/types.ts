// parser 输出类型定义
// SlotMatch       = matcher 切分得到的中间结构（保留 children 嵌套）
// SegmentNode     = snapshot 产出的 AST 节点（树形，带 parentId 反向链接）
// ParsedQuerySnapshot = 一个 query 的完整 parser 产出
//   roots = 顶层节点（system blocks、tools、messages）
//   index = id → node 平铺索引，O(1) 查找

/** 一个 slot 在 wire body 里的实际匹配结果（matcher 内部中间结构） */
export interface SlotMatch {
  slotId: string;
  jsonPath: string;
  charRange?: { start: number; end: number };
  rawText: string;
  /** 触发本次切分的锚字符串，调试用 */
  anchorEvidence: string;
  children: SlotMatch[];
}

/** AST 节点：一个 segment 在树里的表示 */
export interface SegmentNode {
  id: string;
  slotId: string;
  jsonPath: string;
  charRange?: { start: number; end: number };
  rawText: string;
  /** sha256 前 16 位，格式 "sha256:xxxxxxxxxxxxxxxx" */
  rawHash: string;
  charCount: number;
  children: SegmentNode[];
  /** 父节点 id；根节点为 undefined */
  parentId?: string;
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

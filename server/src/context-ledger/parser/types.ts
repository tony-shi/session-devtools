// parser 输出类型定义
// SlotMatch  = matcher 切分得到的中间结构（保留 children 嵌套）
// ParsedSegment = snapshot 拍平后的对外结构（每个 segment 一个稳定 id + hash）
// ParsedQuerySnapshot = 一个 query 的完整 parser 产出

/** 一个 slot 在 wire body 里的实际匹配结果 */
export interface SlotMatch {
  slotId: string;
  jsonPath: string;
  charRange?: { start: number; end: number };
  rawText: string;
  /** 触发本次切分的锚字符串，调试用 */
  anchorEvidence: string;
  children: SlotMatch[];
}

export interface ParsedSegment {
  id: string;
  slotId: string;
  jsonPath: string;
  charRange?: { start: number; end: number };
  rawText: string;
  /** sha256 前 16 位，格式 "sha256:xxxxxxxxxxxxxxxx" */
  rawHash: string;
  charCount: number;
}

export interface ParsedQuerySnapshot {
  queryKind: "main_session" | "side_query" | "unknown";
  proxyFile: string;
  ts: string;
  segments: ParsedSegment[];
}

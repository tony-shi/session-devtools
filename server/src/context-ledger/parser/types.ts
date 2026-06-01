// parser 输出类型定义
// SlotMatch       = matcher 切分得到的顶层中间结构；children 保留给旧调用和 AST builder 内部递归
// SegmentNode     = snapshot 产出的 AST 节点（树形，带 parentId 反向链接）
// ParsedQuerySnapshot = 一个 query 的完整 parser 产出
//   roots = 顶层节点（system blocks、tools、messages）
//   index = id → node 平铺索引，O(1) 查找
//
// 容错设计：template 描述已知结构，不是合法结构全集。
//   未知结构必须进入 AST，不能被丢弃（否则丢字符，downstream 无法计算 unexplained coverage）。
//   每层都有对应的 unknown fallback slotType：
//     system.block.unknown    — system[] 里无法路由的 block
//     system.main-prompt.section.unknown  — main-prompt-block 内无法路由的 H1 section
//     messages.block.unknown  — messages content[] 里无法识别 type 的 block
//     messages.inline.unknown — inline 切分里的未知段（目前不触发，保留备用）
//     tools.unknown           — tools[] 里无法路由的条目（目前不触发，保留备用）

/** wire 层 cache_control 的结构化表示，来自 reqBody.system[i].cache_control 或 messages block */
export interface CachePolicy {
  /** 缓存 TTL："5m" 为 Anthropic 默认（无 ttl 字段时）；"1h" 需服务端支持 */
  ttl: "5m" | "1h";
  /** 缓存 scope："org" 为默认（无 scope 字段时）；"global" 跨 org */
  scope: "org" | "global";
}

/** 一个 slot 在 wire body 里的实际匹配结果（matcher 内部中间结构） */
export interface SlotMatch {
  /** slot 类型标签（同一类型可出现多次，如多个 system.main-prompt.section.* 子节点） */
  slotType: string;
  jsonPath: string;
  /** 相对父节点 rawText 的字符偏移（左闭右开）；顶层节点无父节点故为 undefined */
  charRange?: { start: number; end: number };
  rawText: string;
  /** 展示可见性。rawOnly 节点保留在树和审计中，但默认列表不展示。 */
  visibility?: "default" | "rawOnly";
  /** 触发本次切分的锚字符串，调试用 */
  anchorEvidence: string;
  children: SlotMatch[];
  /** wire 层 cache_control 的结构化表示；无 cache_control 时为 undefined */
  cachePolicy?: CachePolicy;
  /** 容错元数据：matcher 在产出 unknown 节点时填写 */
  unknownMeta?: {
    /** 触发 unknown 的原始 block type（如 "image"）或 H1 header 文本 */
    originalType?: string;
    /** H1 节点：实际 header 文本 */
    sectionHeader?: string;
    /** 产出 unknown 节点的原因说明 */
    reason?: string;
  };
  /** wire 层结构化字段：仅 tool_use / tool_result / messages.text 节点携带。
   *  PR 3 (jsonl-linker) 用 toolUseId / messageRole / messageIdx 做 deterministic 匹配。 */
  wireMeta?: WireMeta;
}

export interface WireMeta {
  /** tool_use 节点的 tool_use.id；tool_result 节点的 tool_use_id（指向其配对 tool_use）。 */
  toolUseId?: string;
  /** tool_use 节点的 tool name；tool_result 节点为 undefined。 */
  toolName?: string;
  /** message 角色：user / assistant；tools / system block 为 undefined。 */
  messageRole?: "user" | "assistant" | "system";
  /** message 在 messages[] 数组中的索引（0-based）。 */
  messageIdx?: number;
  /**
   * thinking / redacted_thinking 块的唯一标识：
   *   - type="thinking"          → block.signature (Anthropic 服务端 hash)
   *   - type="redacted_thinking" → block.data (encrypted payload，本身即唯一)
   * jsonl-linker 用它在 assistant event 的 thinkingBlocks 上 O(1) deterministic 匹配。
   */
  thinkingSignature?: string;
}

/** AST 节点：一个 segment 在树里的表示 */
export interface SegmentNode {
  id: string;
  /** slot 类型标签（如 "system.main-prompt.section.doing-tasks"）或 unknown fallback 名；同一类型可出现多次 */
  slotType: string;
  jsonPath: string;
  /** 相对父节点 rawText 的字符偏移（左闭右开）；顶层节点无父节点故为 undefined */
  charRange?: { start: number; end: number };
  rawText: string;
  /** 展示可见性。rawOnly 节点保留在树和审计中，但默认列表不展示。 */
  visibility?: "default" | "rawOnly";
  /** sha256 前 16 位，格式 "sha256:xxxxxxxxxxxxxxxx" */
  rawHash: string;
  charCount: number;
  children: SegmentNode[];
  /** 父节点 id；根节点为 undefined */
  parentId?: string;
  /** wire 层 cache_control 的结构化表示；无 cache_control 时为 undefined。
   *  顶层 system block 由 matcher 直接填入；H1 section 等子节点由 ast-builder 从父节点继承。 */
  cachePolicy?: CachePolicy;
  /** 容错 / 调试元数据，unknown 节点填写 */
  unknownMeta?: {
    originalType?: string;
    sectionHeader?: string;
    reason?: string;
  };
  /** wire 层结构化字段；与 SlotMatch.wireMeta 同义。 */
  wireMeta?: WireMeta;
  /**
   * Origin：该节点的"形态 / 出处"。
   *
   * 由 ast-builder 出口处填入默认值（container/structural/unknown），
   * 后续可由 attributeSnapshot 用 rule 命中覆盖为 RuleOrigin，
   * 由 jsonl-linker 用 id / 内容匹配覆盖为 JsonlOrigin。
   *
   * 不变量：构造完毕的 ParsedQuerySnapshot 中每个节点 origin 必为非空。
   */
  origin: import("./attribution/origin").SegmentOrigin;
}

export interface ParsedQuerySnapshot {
  queryKind: "main_session" | "side_query" | "unknown";
  proxyFile: string;
  ts: string;
  /** 顶层节点（system blocks / tools / messages），不含子节点的平铺 */
  roots: SegmentNode[];
  /** id → node 平铺索引，包含所有层级节点，O(1) 查找 */
  index: Record<string, SegmentNode>;
  /**
   * 归因先验上下文：parser 入口 pre-pass 从 system[0] 抽取 cc_version 等元数据。
   *
   *   - ok=true  → ctx 含 ccVersion，attribution 据此版本过滤 rule / template 候选。
   *   - ok=false → 归因失败的硬错误（billing-noise 未命中 system[0]，Anthropic 协议变了）。
   *               attributeSnapshot 收到此状态会跳过 rule 评估，所有叶子保持 structural 默认。
   *
   * 见 parser/attribution/context.ts 抽取细节。
   */
  attributionContext: import("./attribution/context").AttributionContextResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Unknown slotType 常量（供 matcher / snapshot / audit 统一引用）
// ─────────────────────────────────────────────────────────────────────────────

export const UNKNOWN_SLOT = {
  SYSTEM_BLOCK:    "system.block.unknown",
  SYSTEM_SECTION:  "system.main-prompt.section.unknown",
  MESSAGES_BLOCK:  "messages.block.unknown",
  MESSAGES_INLINE: "messages.inline.unknown",
  TOOLS:           "tools.unknown",
} as const;

/** 判断一个 slotType 是否为 unknown fallback */
export function isUnknownSlotId(slotType: string): boolean {
  return Object.values(UNKNOWN_SLOT).includes(slotType as never);
}

// Lens framework —— 把"按某个维度分桶 + 上色 + 过滤 attribution leaves"抽象成
// 一个统一接口。每个 Lens 定义：
//
//   - 它的桶集合（buckets）：UI 上以 pill 行呈现
//   - 给一个 leaf 分桶（bucketOf）：用来过滤 / 上色 / 统计
//
// 同一棵 attribution 树，切换不同 Lens 就能从不同角度审视：
//   • Provenance（来源）—— 这段内容是 harness 写死的、动态注入的、用户输入的、
//     还是 tool_use / tool_result / assistant 文本回灌的？
//   • Cache —— 这段是 5m / 1h 缓存，还是每次都重算？
//   • Audit —— parser 自己对它的覆盖度如何（full / partial / none）？
//
// 当前实现单选：同一时刻只激活一个 Lens、最多选一个桶。多选 / Lens 叠加留作
// 后续迭代。

import type { LeafLite } from "./AttributionTreePanel";
import { coverageStateOf } from "./attribution-tree-types";

// ─── 类型定义 ────────────────────────────────────────────────────────────────

export interface LensBucket {
  /** 桶的稳定 id。filter state 存的就是这个值。 */
  id: string;
  /** Pill 上显示的短文案（中文优先）。 */
  label: string;
  /** Pill 上的小色方块 / leaf 着色 / SectionBar 角标用色。 */
  color: string;
  /** Pill 悬停提示 —— 解释这桶是什么。 */
  description?: string;
}

export interface Lens {
  /** Lens 稳定 id（写入 URL / 持久化时用）。 */
  id: string;
  /** Lens 切换器上的展示名。 */
  label: string;
  /** 切换器悬停提示。 */
  description?: string;
  /** 桶集合 —— 顺序决定 pill 行的左→右顺序。 */
  buckets: LensBucket[];
  /** 把一个 leaf 映射到桶 id。返回 null 表示"本 Lens 不分类该 leaf"
   *  （桶过滤时也不会被任何 pill 选中）。一般每个 leaf 都应该能落到桶里。 */
  bucketOf(leaf: LeafLite): string | null;
}

// ─── Provenance Lens（来源）──────────────────────────────────────────────────
//
// 把每个 leaf 归类到「这段内容从哪儿来」：
//   harness 写死  /  harness 动态注入  /  用户输入  /  tool_use  /  tool_result
//   /  assistant 文本（含 thinking）  /  附件 / 系统注入事件  /  未识别
//
// 取数：
//   - origin.kind === "rule" 且 dynamicFields 空 → harness-static
//   - origin.kind === "rule" 且 dynamicFields 非空 → harness-dynamic
//   - origin.kind === "jsonl" → 看 eventKind（兼容 server 端两种序列化形态：
//       * string 字面量 "tool_result"
//       * 对象 { source: "tool_result", contentType?: "text" }
//     ）
//   - origin.kind === "structural" / "unknown" → unknown

const PROV_HARNESS_STATIC  = "harness-static";
const PROV_HARNESS_DYNAMIC = "harness-dynamic";
const PROV_USER_INPUT      = "user-input";
const PROV_TOOL_USE        = "tool-use";
const PROV_TOOL_RESULT     = "tool-result";
const PROV_ASSISTANT_TEXT  = "assistant-text";
const PROV_ATTACHMENT      = "attachment";
const PROV_UNKNOWN         = "unknown";

const PROVENANCE_BUCKETS: LensBucket[] = [
  { id: PROV_HARNESS_STATIC,  label: "Harness 静态",  color: "#3b82f6",
    description: "硬编码的 system prompt 文本（rule 命中且无动态字段注入）" },
  { id: PROV_HARNESS_DYNAMIC, label: "Harness 动态",  color: "#8b5cf6",
    description: "模板规则命中，但包含来自 env / runtime / memory / user 的动态字段注入" },
  { id: PROV_USER_INPUT,      label: "用户输入",      color: "#10b981",
    description: "原始用户输入消息（jsonl user_input 事件）" },
  { id: PROV_TOOL_USE,        label: "工具调用",      color: "#f59e0b",
    description: "Agent 发起的 tool_use block（assistant 响应中的工具调用请求）" },
  { id: PROV_TOOL_RESULT,     label: "工具结果",      color: "#ec4899",
    description: "工具执行结果回灌（jsonl tool_result 事件）" },
  { id: PROV_ASSISTANT_TEXT,  label: "Agent 文本",    color: "#06b6d4",
    description: "Assistant 文本响应、thinking 等" },
  { id: PROV_ATTACHMENT,      label: "附件 / 系统",   color: "#a78bfa",
    description: "附件 / 本地命令 / stop hook / away summary 等系统注入事件" },
  { id: PROV_UNKNOWN,         label: "未识别",        color: "#9ca3af",
    description: "structural 占位 / 未匹配规则 / 未知 origin" },
];

function jsonlEventSource(eventKind: unknown): string | null {
  if (!eventKind) return null;
  if (typeof eventKind === "string") return eventKind;
  if (typeof eventKind === "object" && "source" in (eventKind as object)) {
    return (eventKind as { source?: string }).source ?? null;
  }
  return null;
}

export const provenanceLens: Lens = {
  id: "provenance",
  label: "来源",
  description: "按内容来源分类：harness 静态 / 动态、用户、tool_use、tool_result、Agent 文本、附件、未识别",
  buckets: PROVENANCE_BUCKETS,
  bucketOf(leaf) {
    const o = leaf.origin;
    if (o.kind === "rule") {
      const hasDynamic = !!(o.dynamicFields && o.dynamicFields.length > 0);
      return hasDynamic ? PROV_HARNESS_DYNAMIC : PROV_HARNESS_STATIC;
    }
    if (o.kind === "jsonl") {
      const src = jsonlEventSource(o.eventKind);
      switch (src) {
        case "user_input":             return PROV_USER_INPUT;
        case "tool_use":               return PROV_TOOL_USE;
        case "tool_result":            return PROV_TOOL_RESULT;
        case "assistant_text":
        case "thinking":               return PROV_ASSISTANT_TEXT;
        case "attachment":
        case "system_local_command":
        case "stop_hook":
        case "away_summary":           return PROV_ATTACHMENT;
        default:                       return PROV_UNKNOWN;
      }
    }
    return PROV_UNKNOWN;
  },
};

// ─── Cache Lens ──────────────────────────────────────────────────────────────
//
// 按 cache policy 分桶：5m TTL / 1h TTL / 未缓存。
// 数据来自 SerializedNode.cachePolicy（已经在 flattenLeaves 中拷贝到 LeafLite）。

const CACHE_5M   = "cached-5m";
const CACHE_1H   = "cached-1h";
const CACHE_NONE = "not-cached";

const CACHE_BUCKETS: LensBucket[] = [
  { id: CACHE_5M,   label: "5min 缓存", color: "#10b981",
    description: "短期缓存（5 分钟 TTL）—— 同一会话内快速复用" },
  { id: CACHE_1H,   label: "1h 缓存",   color: "#14b8a6",
    description: "长期缓存（1 小时 TTL）—— 跨会话稳定复用" },
  { id: CACHE_NONE, label: "未缓存",     color: "#9ca3af",
    description: "未被打缓存的内容（每次请求都重新计费）" },
];

export const cacheLens: Lens = {
  id: "cache",
  label: "缓存",
  description: "按缓存策略分类：5min / 1h / 未缓存",
  buckets: CACHE_BUCKETS,
  bucketOf(leaf) {
    const p = leaf.cachePolicy;
    if (!p) return CACHE_NONE;
    if (p.ttl === "5m") return CACHE_5M;
    if (p.ttl === "1h") return CACHE_1H;
    return CACHE_NONE;
  },
};

// ─── Audit Lens（兼容现有 Audit 视角） ────────────────────────────────────────
//
// 把现有 AttributionTreePanel 里的 Audit 三桶（full / partial / none）也包装成
// Lens，让 Lens 切换器里能选到。`coverageStateOf` 复用现有判断逻辑。

const AUDIT_FULL    = "full";
const AUDIT_PARTIAL = "partial";
const AUDIT_NONE    = "none";

const AUDIT_BUCKETS: LensBucket[] = [
  { id: AUDIT_FULL,    label: "Full",    color: "#10b981",
    description: "叶子被规则或 jsonl 完整覆盖" },
  { id: AUDIT_PARTIAL, label: "Partial", color: "#f59e0b",
    description: "rule/jsonl 命中但 fullyCovered=false（动态注入未覆盖、内容近似）" },
  { id: AUDIT_NONE,    label: "None",    color: "#9ca3af",
    description: "structural（slot 已知但无规则）或 unknown（template 未识别）" },
];

export const auditLens: Lens = {
  id: "audit",
  label: "Audit",
  description: "parser 自身的归因覆盖度（诊断用）—— 哪些 leaf 命中了规则、哪些没归上",
  buckets: AUDIT_BUCKETS,
  bucketOf(leaf) {
    return coverageStateOf(leaf.origin);
  },
};

// ─── Registry ────────────────────────────────────────────────────────────────

/** 默认 Lens 顺序。审计性 lens 放最后；内容性 lens（用户更关心）放前面。 */
export const LENSES: Lens[] = [provenanceLens, cacheLens, auditLens];

/** 工具：根据 id 取 lens。 */
export function getLens(id: string): Lens {
  return LENSES.find((l) => l.id === id) ?? LENSES[0];
}

/** 工具：根据 lens + bucketId 取 bucket meta。返回 null 如果 bucketId 不在
 *  当前 lens 的桶集合里（一般是 stale state，UI 应回退到 "all"）。 */
export function getBucket(lens: Lens, bucketId: string | null): LensBucket | null {
  if (!bucketId) return null;
  return lens.buckets.find((b) => b.id === bucketId) ?? null;
}

/** 工具：统计每个桶包含的 leaf 数 + 字符数。 */
export interface BucketStat {
  bucket: LensBucket;
  leafCount: number;
  totalChars: number;
}

export function bucketStatsOf(lens: Lens, leaves: LeafLite[]): BucketStat[] {
  const counts = new Map<string, { leafCount: number; totalChars: number }>();
  for (const l of leaves) {
    const bid = lens.bucketOf(l);
    if (!bid) continue;
    const cur = counts.get(bid) ?? { leafCount: 0, totalChars: 0 };
    cur.leafCount += 1;
    cur.totalChars += l.charCount;
    counts.set(bid, cur);
  }
  // 按 lens.buckets 的声明顺序输出（保证 pill 行稳定排列）
  return lens.buckets.map((b) => ({
    bucket: b,
    leafCount: counts.get(b.id)?.leafCount ?? 0,
    totalChars: counts.get(b.id)?.totalChars ?? 0,
  }));
}

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
import {
  provenancePalette,
  diffPalette,
  cachePalette,
  auditPalette,
} from "./lens-palette";

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
// 把每个 leaf 归类到「这段内容从哪儿来」，按原子 source 一一对应：
//
//   rule origin（任意 dynamicFields）→ 系统提示词
//   jsonl user_input                 → 用户输入
//   jsonl tool_use                   → 工具调用
//   jsonl tool_result                → 工具结果
//   jsonl thinking                   → Claude 思考
//   jsonl assistant_text             → Claude 回复
//   jsonl attachment                 → 文件附件
//   jsonl system_local_command       → 命令输出
//   jsonl harness_injection          → Skill / 摘要注入
//   structural / unknown / 其他      → 未识别
//
// 设计原则：每个桶对应 JsonlEventSource 中的一个实际产出值，互斥且完全覆盖。
// rule origin 不再按 dynamicFields 拆分——那是 parser 实现细节，不是内容来源。
// harness_injection 单独成桶（原先遗漏→落入"未识别"，现已修正）。

const PROV_SYSTEM_PROMPT   = "system-prompt";
const PROV_USER_INPUT      = "user-input";
const PROV_TOOL_USE        = "tool-use";
const PROV_TOOL_RESULT     = "tool-result";
const PROV_CLAUDE_THINKING = "claude-thinking";
const PROV_CLAUDE_TEXT     = "claude-text";
const PROV_FILE_ATTACHMENT = "file-attachment";
const PROV_COMMAND_OUTPUT  = "command-output";
const PROV_HARNESS_INJECT  = "harness-injection";
const PROV_UNKNOWN         = "unknown";

const PROVENANCE_BUCKETS: LensBucket[] = [
  { id: PROV_SYSTEM_PROMPT,   label: "系统提示词",   color: provenancePalette.systemPrompt,
    description: "Claude Code 内置系统 prompt（规则匹配段，含静态模板与动态字段注入）" },
  { id: PROV_USER_INPUT,      label: "用户输入",     color: provenancePalette.userInput,
    description: "原始用户输入消息（jsonl user_input 事件）" },
  { id: PROV_TOOL_USE,        label: "工具调用",     color: provenancePalette.toolUse,
    description: "Agent 发起的 tool_use block（assistant 响应中的工具调用请求）" },
  { id: PROV_TOOL_RESULT,     label: "工具结果",     color: provenancePalette.toolResult,
    description: "工具执行结果回灌（jsonl tool_result 事件）" },
  { id: PROV_CLAUDE_THINKING, label: "AI 思考",      color: provenancePalette.claudeThinking,
    description: "Extended thinking 块（AI 内部推理过程，不直接输出给用户）" },
  { id: PROV_CLAUDE_TEXT,     label: "AI 回复",      color: provenancePalette.claudeText,
    description: "Assistant 文本响应（直接输出给用户的回复内容）" },
  { id: PROV_FILE_ATTACHMENT, label: "文件附件",     color: provenancePalette.fileAttachment,
    description: "用户上传的文件或 attachment 事件（task_reminder / queued_command / edited_text_file 等）" },
  { id: PROV_COMMAND_OUTPUT,  label: "命令输出",     color: provenancePalette.commandOutput,
    description: "Bash / 本地命令输出（<bash-stdout> / <local-command-*> 等）" },
  { id: PROV_HARNESS_INJECT,  label: "Skill / 摘要", color: provenancePalette.harnessInject,
    description: "Skill 工具加载的 SKILL.md 内容，或 compaction 压缩后注入的对话摘要" },
  { id: PROV_UNKNOWN,         label: "未识别",       color: provenancePalette.unknown,
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
  description: "按内容来源分类：系统提示词、用户输入、工具调用/结果、Claude 思考/回复、文件附件、命令输出、Skill/摘要注入、未识别",
  buckets: PROVENANCE_BUCKETS,
  bucketOf(leaf) {
    const o = leaf.origin;
    // rule origin 统一归入系统提示词，不再按 dynamicFields 区分静/动态
    if (o.kind === "rule") return PROV_SYSTEM_PROMPT;
    if (o.kind === "jsonl") {
      const src = jsonlEventSource(o.eventKind);
      switch (src) {
        case "user_input":           return PROV_USER_INPUT;
        case "tool_use":             return PROV_TOOL_USE;
        case "tool_result":          return PROV_TOOL_RESULT;
        case "thinking":             return PROV_CLAUDE_THINKING;
        case "assistant_text":       return PROV_CLAUDE_TEXT;
        case "attachment":           return PROV_FILE_ATTACHMENT;
        case "system_local_command": return PROV_COMMAND_OUTPUT;
        case "harness_injection":    return PROV_HARNESS_INJECT;
        default:                     return PROV_UNKNOWN;
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
  { id: CACHE_5M,   label: "5min 缓存", color: cachePalette.ttl5m,
    description: "短期缓存（5 分钟 TTL）—— 同一会话内快速复用" },
  { id: CACHE_1H,   label: "1h 缓存",   color: cachePalette.ttl1h,
    description: "长期缓存（1 小时 TTL）—— 跨会话稳定复用" },
  { id: CACHE_NONE, label: "未缓存",     color: cachePalette.notCached,
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

// TODO(cache-lens · bp-dot 叠加层): 在 Cache lens 激活时，给 SectionBar
// 叠加 cache_control breakpoint 标记，帮助用户一眼看出"钉死/移动"的边界。
// 设计要点（来自 claude-visual dark 范式）：
//   - anchor dot (蓝 #38bdf8 / 静) ：标"钉死"的 bp（一般固定在 sys[2] 末尾，
//     跨轮不动），表示"以下内容会被复用缓存"。
//   - cursor dot (橙 #ff8a3d / 动) ：标"跟着最新 user 移动"的 bp，表示
//     "上一轮 cache_creation 写入到这里为止"。
//   - dot 圆头位于 bar 上方 8px，label 在 dot 上方约 40px；末端 dot 用
//     lblLeft 反向偏移避免被 view 边界裁切。
//   - 数据源：SerializedNode.cachePolicy 上需要带 bpKind（anchor / cursor）
//     + bpIndex；目前 cachePolicy 只到 ttl 粒度，需要 parser 侧补字段。
// 实施时机：等 OriginCall lens（见下方 TODO）一起做，二者都依赖前后 call
// 维度的"prefix 滚雪球"语义，可以共享同一组 prefix-history 数据结构。

// ─── Audit Lens（兼容现有 Audit 视角） ────────────────────────────────────────
//
// 把现有 AttributionTreePanel 里的 Audit 三桶（full / partial / none）也包装成
// Lens，让 Lens 切换器里能选到。`coverageStateOf` 复用现有判断逻辑。

const AUDIT_FULL    = "full";
const AUDIT_PARTIAL = "partial";
const AUDIT_NONE    = "none";

const AUDIT_BUCKETS: LensBucket[] = [
  { id: AUDIT_FULL,    label: "Full",    color: auditPalette.full,
    description: "叶子被规则或 jsonl 完整覆盖" },
  { id: AUDIT_PARTIAL, label: "Partial", color: auditPalette.partial,
    description: "rule/jsonl 命中但 fullyCovered=false（动态注入未覆盖、内容近似）" },
  { id: AUDIT_NONE,    label: "None",    color: auditPalette.none,
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

// ─── Diff Lens ───────────────────────────────────────────────────────────────
//
// 按 leaf.diffKind（来自 diff-tree 合并）分桶：added / modified / removed / kept。
// removed 的 leaf 严格来说不在 attribution-tree 的 current snapshot 里，由外层
// 单独处理（双层 bar 的 Prev bar 渲染 + Removed footer 卡），所以 lens 本身
// 把它当成一个 bucket（数量为 0 也保留，便于切换时显示"−2 removed"）。

const DIFF_ADDED    = "added";
const DIFF_MODIFIED = "modified";
const DIFF_REMOVED  = "removed";
const DIFF_KEPT     = "kept";

const DIFF_BUCKETS: LensBucket[] = [
  { id: DIFF_ADDED,    label: "新增", color: diffPalette.added,
    description: "本轮请求新增的 leaf（上一轮没有）" },
  { id: DIFF_MODIFIED, label: "修改", color: diffPalette.modified,
    description: "上一轮同 slot 存在但内容改了" },
  { id: DIFF_REMOVED,  label: "删除", color: diffPalette.removed,
    description: "上一轮存在、本轮已删除（在 Prev bar 和底部 footer 列出）" },
  { id: DIFF_KEPT,     label: "未变", color: diffPalette.kept,
    description: "未变化的 leaf" },
];

export const diffLens: Lens = {
  id: "diff",
  label: "Diff",
  description: "相对上一次 call 的 leaf 级变化（依赖 diff-tree 数据合并）",
  buckets: DIFF_BUCKETS,
  bucketOf(leaf) {
    return leaf.diffKind ?? DIFF_KEPT;
  },
};

// ─── Registry ────────────────────────────────────────────────────────────────

// TODO(lens · OriginCall / 来源累积): 这是一个独立的归因维度，值得作为一个
// 单独的 Lens 接入（不是塞进 Provenance / Cache 任何一个）。
//
// 桶定义（按"贡献到当前 call prefix 的 token 数"排名）：
//   - originCall:topN  (N=1..3) ：贡献最多的前 3 次历史 call，每个一桶
//   - originCall:others           ：其余历史 call 折叠成 1 桶（仿 DiffPanel 的
//     unchanged bin idiom，可点开展开完整列表）
//   - originCall:this             ：本 call 新增的 cache_creation 内容
//
// 用途：让用户在一次 call 的 SectionBar 上看到"这一段 token 是哪一轮历史
// call 第一次生成、后续被沿用复用过来的"，传达 prefix 滚雪球的累积叙事。
// 跟 demo 里的「消息1 / 消息2 / 消息3」横向累积条同源，但通过 lens 着色复用
// 现有 SectionBar，不引入新组件。
//
// 数据依赖：每个 leaf 需要知道"首次出现于哪个 call_id / call_index"。当前
// SerializedNode 不带这个字段，需要 parser / reconciliation 在 session 维度
// 给每个稳定 leaf 打一个 firstSeenCallIndex 标签（hashing 或 stable id 路径
// 都可以）。
//
// 粒度：Call，不是 Turn。一个 turn 内的多次 tool_use 来回，每次 call 的
// prefix 都不同，叙事最小单元是 call。
//
// 与 bp-dot TODO 的关系：二者都依赖 prefix-history 视角；可以共用同一份
// firstSeenCallIndex / bpKind 数据。

/** Audit lens 是诊断用视角，对最终用户没价值；仅在 dev 环境暴露。
 *  判定：Vite DEV 构建 (npm run dev) 或浏览器里手动开后门
 *        (localStorage.devLens === '1')。
 *  prod build (npm run build, npx 发布的产物) 下，integer-tree-shaking 会把
 *  auditLens 整段消除，bundle 里不会出现 "Audit" 字样。 */
function isDevLensEnabled(): boolean {
  if (import.meta.env.DEV) return true;
  if (typeof localStorage !== "undefined") {
    try { return localStorage.getItem("devLens") === "1"; } catch { /* SSR/blocked */ }
  }
  return false;
}

/** 默认 Lens 顺序。来源在最左（默认开启基底）；Diff 次之；Cache 紧随；
 *  Audit 仅 dev 下挂出来。 */
export const LENSES: Lens[] = isDevLensEnabled()
  ? [provenanceLens, diffLens, cacheLens, auditLens]
  : [provenanceLens, diffLens, cacheLens];

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

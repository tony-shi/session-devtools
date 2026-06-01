// AttributionTreePanel：极简钻取风格的归因视图。
//
// 视觉模型（无边框，靠 gap 间隔）：
//   Layer 1  顶部 stacked bar（root sections — system / tools / messages 三段；按字符比例宽度）
//   Layer 2  极简 table（默认状态）— 每段一行：色点 + 名称 + 大小 + % + 段数
//
// 点击 == 选中 == 钻取，不展开下拉。
//   - 点击 top bar 段 / table 行 → 进入对应 section，顶部 bar 仍在（其他段被 dim），
//     下方多出一根二级 bar（= 顶部 bar 等宽，按 section 内 leaves 比例分块），再加一张 leaves table。
//   - 点击 leaf bar / leaf 行 → 高亮该 leaf，并显示叶子详情。
//   - 「← back」回到上一级。

import { Fragment, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FisheyeStrip } from "./fisheye-strip";
import type { FisheyeStatus } from "./fisheye-strip";
import type {
  AttributionTreeResult,
  SerializedNode,
  SegmentOrigin,
  JsonlEventKindObject,
  DynamicField,
} from "./attribution-tree-types";
import { SegmentedToggle } from "./shared/SegmentedToggle";
import { LinkIcon, SegmentView } from "./shared/EventUnitCard";
import { RenderRawCopyActions } from "./shared/RenderRawCopyActions";
import { EVENT_PALETTES } from "./shared/eventPalette";
import type { IntervalEventKind } from "./drilldown-types";
import { useAttributionGraph } from "./attribution-graph-context";
import { sectionPalette, rolePalette, UNKNOWN_FILL as PALETTE_UNKNOWN_FILL, type RoleId } from "./lens-palette";
import { Check, Copy, Info } from "lucide-react";
import { BRAND } from "./shared/brand";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import JsonView from "@uiw/react-json-view";

// ─── 类型与配色 ─────────────────────────────────────────────────────────────

// NOTE: 这些类型 / 颜色 / 工具函数 / 子组件原本是 module-private 的；现在导出供
// 旁路的 AttributionTreeLensPanel 复用。本 AttributionTreePanel 的行为完全不变。

export type SectionId = "system" | "tools" | "messages" | "other";

export interface SectionMeta {
  label: string;
  barBg: string;
  barText: string;
  rowBg: string;
  marker: string;
  textColor: string;
}

// 配色集中在 lens-palette.ts；本处仅 re-export 以保持向后兼容。
// SECTION_META 仍按 L1 region（4 键）供 diff/cache/walkthrough；ROLE_META 按 L2 role
// 供 attribution 面板的 section bar / table。
export const SECTION_META: Record<SectionId, SectionMeta> = sectionPalette;
export const ROLE_META: Record<RoleId, SectionMeta> = rolePalette;

// Leaf 颜色：解析清楚的（rule / jsonl / structural）按 L2 role 上色（颜色族标 L1）；
// unknown 统一用「加重一号」的灰，与可解释段落明显区分。
const UNKNOWN_FILL = PALETTE_UNKNOWN_FILL;

export function leafFill(leaf: {
  origin: SegmentOrigin;
  classSlot: string;
  rootSlotType: string;
  messageRole?: "user" | "assistant" | "system";
}): string {
  if (leaf.origin.kind === "unknown") return UNKNOWN_FILL;
  return ROLE_META[roleOf(leaf)].barBg;
}

// ─── 工具函数 ────────────────────────────────────────────────────────────────

export function sectionOf(slotType: string): SectionId {
  if (slotType.startsWith("system.") || slotType === "side-query.system") return "system";
  if (slotType.startsWith("tools.")) return "tools";
  if (slotType.startsWith("messages.") || slotType === "side-query.user") return "messages";
  return "other";
}

// ─── 三级模型 L2：RoleId 分类（区内颜色维度；几何仍按 L1 物理区）────────────────

/** 系统 section 级 slot：flattenLeaves 用它把 section 信息从顶层 root 下沉到 classSlot。 */
function isSystemSectionSlot(slotType: string): boolean {
  return (
    slotType.startsWith("system.main-prompt.section.") ||
    slotType === "system.main-prompt-block" ||
    slotType === "system.identity" ||
    slotType === "system.billing"
  );
}

// system-reminder 子类 ruleId → role 映射。把 messages.inline.system-reminder 这个
// 大杂烩按内容本质拆开（依据:Claude Code restored-src attachment.type 分类法 +
// 跨 fixture 实证「会话内逐字稳定 = 能力声明，非每-call 动态」）:
//   messages.context   → 注入的上下文/能力声明（environment group）
//   messages.directive → 注入的行为指令（instructions group）
//   未列出的 reminder（token-usage / diagnostics / file-* / catch-all）→ 默认 messages.injection（runtime）
const REMINDER_RULE_TO_ROLE: Record<string, RoleId> = {
  // 注入的上下文/能力声明 → messages.context
  "claude-code.messages.memory-contents.v1":        "messages.context", // CLAUDE.md 内容
  "claude-code.messages.nested-memory-contents.v1": "messages.context", // 嵌套 memory 文件内容
  "claude-code.messages.user-context.v1":           "messages.context", // userEmail / currentDate 等事实
  "claude-code.messages.deferred-tools-listing.v1": "messages.context", // ToolSearch 可用工具声明（<system-reminder> 版）
  "claude-code.messages.agent-types-listing.v1":    "messages.context", // 可用 sub-agent 类型声明（<system-reminder> 版）
  // 2.1.154+ role:"system" mid-conversation message 版（slot=messages.system-message，见 roleOf）
  "claude-code.messages.deferred-tools-listing.v2": "messages.context",
  "claude-code.messages.agent-types-listing.v2":    "messages.context",
  // 注入的行为指令 → messages.directive
  "claude-code.messages.thinking-frequency.v1":     "messages.directive", // thinking 频率指引
};

/**
 * L2 语义角色判定。输入用 classSlot（system 取 section 级 / messages 取叶子自身）
 * + rootSlotType（区分 tool_result 上下文）+ messageRole + origin（识别 skills）。
 * 注入（messages.inline.system-reminder，含 smoosh 进 tool_result 的 reminder——
 * ast-builder 给它们同一 slotType）优先判定，跨 tool_result / text。
 */
export function roleOf(leaf: {
  classSlot: string;
  rootSlotType: string;
  messageRole?: "user" | "assistant" | "system";
  origin?: SegmentOrigin;
}): RoleId {
  const { classSlot, rootSlotType, messageRole, origin } = leaf;
  // system-reminder 通道注入的内容共用同一个 slot（messages.inline.system-reminder），
  // 只能靠 origin.ruleId 区分语义。分流:
  //   - skill_listing → messages.skills（有专门解析 SkillListingDetail，单列）
  //   - REMINDER_RULE_TO_ROLE 命中 → messages.context（注入的上下文/能力）
  //     或 messages.directive（注入的行为指令）
  //   - 其余 → messages.injection（真·运行时临时通知，默认）
  // 各 role 经 ROLE_TO_GROUP 静态映射到正确 group（不再有 groupOf override 旁路）。
  if (origin?.kind === "rule" && origin.ruleId === "claude-code.messages.skill-listing.v1")
    return "messages.skills";
  if (classSlot === "messages.inline.system-reminder") {
    if (origin?.kind === "rule") {
      const sub = REMINDER_RULE_TO_ROLE[origin.ruleId];
      if (sub) return sub;
    }
    return "messages.injection";
  }
  // 2.1.154+ beta:role:"system" mid-conversation message（slot=messages.system-message）。
  // 同 system-reminder 按 ruleId 分流;默认归 messages.context（这类注入大多是上下文/能力声明）。
  if (classSlot === "messages.system-message") {
    if (origin?.kind === "rule") {
      const sub = REMINDER_RULE_TO_ROLE[origin.ruleId];
      if (sub) return sub;
    }
    return "messages.context";
  }
  if (classSlot.startsWith("system.") || classSlot === "side-query.system") {
    if (classSlot === "system.billing") return "system.billing";
    if (classSlot === "system.main-prompt.section.using-tools") return "system.tool-policy";
    if (
      classSlot === "system.main-prompt.section.environment" ||
      classSlot === "system.main-prompt.section.context"
    )
      return "system.env";
    return "system.core";
  }
  if (classSlot.startsWith("tools.") || rootSlotType.startsWith("tools.")) return "tools.builtin";
  // 思考块单列（先于 tool/role 判定）——对齐 provenance 的「AI 思考」。
  if (classSlot === "messages.thinking" || rootSlotType === "messages.thinking")
    return "messages.thinking";
  // 工具调用 / 工具结果分列——对齐 provenance 的「工具调用 / 工具结果」。
  // 注:tool_result 内的 image（截图工具等）在此被归 tool-result，先于下面的 image 判定。
  if (rootSlotType === "messages.tool_use") return "messages.tool-use";
  if (rootSlotType === "messages.tool_result") return "messages.tool-result";
  // image 单列（多模态输入）：走到这里的 image 都不在 tool_result 内 = 用户贴的图，
  // 本质是用户视觉输入 → messages.image（group=conversation）。image-placeholder 是
  // 图被替换成的文本占位（[Image #2]），同源同类。
  if (
    classSlot === "messages.block.image" ||
    classSlot === "messages.inline.image-placeholder"
  )
    return "messages.image";
  if (classSlot === "messages.inline.local-command")
    return "messages.misc";
  if (messageRole === "assistant") return "messages.assistant";
  if (messageRole === "user") return "messages.human";
  if (rootSlotType.startsWith("messages.") || rootSlotType === "side-query.user")
    return "messages.misc";
  return "other.unknown";
}

export function fmtK(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1) + "k";
  return Math.round(n / 1000) + "k";
}

// Best-effort JSON parse for the "原始 JSON" segment toggle. Returns
// `undefined` when the content isn't valid JSON so the toggle stays
// hidden instead of showing an error.
function tryParseSegmentJson(s: string): unknown {
  if (!s) return undefined;
  const trimmed = s.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return undefined;
  try { return JSON.parse(trimmed); } catch { return undefined; }
}

export function shortSlot(slotType: string): string {
  return slotType
    .replace("system.main-prompt.section.", "sys.")
    .replace("system.main-prompt-block", "sys.main")
    .replace("messages.", "msg.")
    .replace("tools.builtin.", "tool.");
}

// 对外展示用 label：所有 UI 位置（主 bar 块 / 鱼眼 hover / 二级 strip / 表格行）统一走它,
// 保证同一段在各处显示同一个对外名,不再混用内部 slug。优先 ruleMeta.displayName（对外
// 中文名,如"会话守则"）;未填 displayName 的段（messages/tools 多数）退回 shortSlot slug。
export function leafLabel(leaf: { slotType: string; ruleMeta?: { displayName?: string }; messageRole?: "user" | "assistant" | "system" }): string {
  if (leaf.ruleMeta?.displayName) {
    return leaf.ruleMeta.displayName;
  }
  const slotType = leaf.slotType;
  if (slotType === "messages.tool-use" || slotType === "messages.tool_use") {
    return "tool use";
  }
  if (slotType === "messages.tool-result" || slotType === "messages.tool_result") {
    return "tool result";
  }
  if (slotType === "messages.thinking") {
    return i18n.t("attribution.slots.messages.thinking", { defaultValue: "AI思考" });
  }
  if (slotType === "messages.inline.free-text" || slotType === "messages.text") {
    if (leaf.messageRole === "user") {
      return i18n.t("attribution.slots.messages.human", { defaultValue: "用户输入" });
    }
    if (leaf.messageRole === "assistant") {
      return i18n.t("attribution.slots.messages.aiOutput", { defaultValue: "AI输出" });
    }
  }
  const i18nKey = `attribution.slots.${slotType}`;
  if (i18n.exists(i18nKey)) {
    return i18n.t(i18nKey);
  }
  return shortSlot(slotType);
}

export function originLabel(origin: SegmentOrigin): string {
  if (origin.kind === "rule") {
    return origin.ruleId.startsWith("wire.") ? `wire · ${origin.ruleId.slice(5)}` : origin.ruleId;
  }
  if (origin.kind === "jsonl") {
    const ek: JsonlEventKindObject = typeof origin.eventKind === "string"
      ? { source: origin.eventKind as JsonlEventKindObject["source"] }
      : origin.eventKind;
    const kindStr = ek.contentType && ek.contentType !== "text"
      ? `${ek.source}:${ek.contentType}`
      : ek.source;
    return `${kindStr} @L${origin.jsonlLineIdx}` +
      (origin.sourceCallId !== undefined ? ` · call #${origin.sourceCallId}` : "");
  }
  if (origin.kind === "structural") return `slot · ${origin.reason}`;
  return `unknown · ${origin.reason}`;
}

// ─── 派生数据：current snapshot → leaves（按 section 分组）────────────────────

export interface LeafLite {
  nodeId: string;
  slotType: string;
  rootSlotType: string;
  /**
   * 三级模型 L2 分类用的「最有意义 slot」：system 取最近的 section 级祖先
   * （system.main-prompt.section.* / identity / billing / block），messages·tools
   * 取叶子自身 slotType。由 flattenLeaves 下沉填充，供 roleOf 使用。
   */
  classSlot: string;
  charCount: number;
  preview: string;
  origin: SegmentOrigin;
  rawText?: string;
  /**
   * Position of this leaf inside the raw LLM request JSON
   * (e.g. `reqBody.system[0]`, `reqBody.messages[0].content[1]`). Carried
   * from `SerializedNode.jsonPath` so the leaf detail can surface where in
   * the wire payload the content came from.
   */
  jsonPath: string;
  messageRole?: "user" | "assistant" | "system";
  /**
   * The wire tool_use_id for `messages.tool_use@N` leaves. Carried into
   * LeafLite so the back-link in `SelectedDetail` can land on the exact
   * `ToolCallRow` in the Turn view (`flashToolUse`) rather than just the
   * enclosing call card. Absent for non-tool_use leaves.
   */
  toolUseId?: string;
  toolName?: string;
  thinkingSignature?: string;
  // Cache 视角需要：节点缓存策略。来自 SerializedNode.cachePolicy（可选）。
  cachePolicy?: { ttl: "5m" | "1h"; scope: "org" | "global" };
  // Diff 视角需要：本 leaf 相对前一次 call 的变化状态。由父组件从 diff-tree
  // 按 leafId 合并而来；attribution-tree 自身不带 diff 信息，所以是可选。
  diffKind?: "added" | "removed" | "modified" | "kept";
  // 用户向展示元数据（命中 corpus rule 的 leaf 有）。来自 SerializedNode.ruleMeta。
  // 供 LeafTable 做"导览"展示:displayName 替代晦涩 slotType / stability badge / summary。
  ruleMeta?: {
    displayName?: string;
    summary?: string;
    stability?: string;
    dynamicSource?: string;
  };
  // 正交分类轴 v2（来自 SerializedNode.axes）。bucketOf 用 axes.semantic 修复注入区分组;
  // 详情面板用 source/sourceBucket 作"点开属性"。
  axes?: {
    semantic: string;
    semanticDetail?: string;
    source: string;
    sourceBucket: string;
  };
}

export function flattenLeaves(result: AttributionTreeResult): LeafLite[] {
  if (!result.snapshot) return [];
  const out: LeafLite[] = [];
  function visit(node: SerializedNode, rootSlot: string, sectionSlot: string | undefined) {
    // 经过 system section 级 slot 时，把它记下来下沉给后代叶子（classSlot）。
    const nextSection = isSystemSectionSlot(node.slotType) ? node.slotType : sectionSlot;
    if (node.children.length === 0) {
      out.push({
        nodeId: node.id,
        slotType: node.slotType,
        rootSlotType: rootSlot,
        classSlot: nextSection ?? node.slotType,
        charCount: node.charCount,
        preview: node.preview,
        origin: node.origin,
        rawText: node.rawText,
        jsonPath: node.jsonPath,
        ...(node.wireMeta?.messageRole && { messageRole: node.wireMeta.messageRole }),
        ...(node.wireMeta?.toolUseId && { toolUseId: node.wireMeta.toolUseId }),
        ...(node.wireMeta?.toolName && { toolName: node.wireMeta.toolName }),
        ...(node.wireMeta?.thinkingSignature && { thinkingSignature: node.wireMeta.thinkingSignature }),
        ...(node.cachePolicy && { cachePolicy: node.cachePolicy }),
        ...(node.ruleMeta && { ruleMeta: node.ruleMeta }),
        ...(node.axes && { axes: node.axes }),
      });
      return;
    }
    for (const c of node.children) visit(c, rootSlot, nextSection);
  }
  for (const root of result.snapshot.roots) visit(root, root.slotType, undefined);
  return out;
}

export interface SectionStat {
  // 三级模型：bar 顶层段 = L1 物理区（不可重排）；role 仅作区内颜色（roleSegments）。
  id: SectionId;
  totalChars: number;
  leafCount: number;
  leaves: LeafLite[];
  byRole?: { user: number; assistant: number; system: number };
  toolCount?: number;
}

// 物理区展示顺序：tools → system → messages → other，对齐 Anthropic cache prefix
// 拼接顺序（≠ JSON key 序，JSON key 序是 SDK 任意序列化，无语义）。
const REGION_ORDER: SectionId[] = ["tools", "system", "messages", "other"];

export function computeSectionStats(leaves: LeafLite[]): SectionStat[] {
  // leaves 已是 flattenLeaves 的 DFS 文档顺序 = 物理序；分组到各区时按出现顺序 push，
  // 天然保序。不要按 jsonPath 字符串重排（"messages[10]" < "messages[2]" 会乱序）。
  const map = new Map<SectionId, LeafLite[]>();
  for (const l of leaves) {
    const id = sectionOf(l.rootSlotType);
    if (!map.has(id)) map.set(id, []);
    map.get(id)!.push(l);
  }
  const out: SectionStat[] = [];
  for (const id of REGION_ORDER) {
    const ls = map.get(id);
    if (!ls || ls.length === 0) continue;
    const stat: SectionStat = {
      id, leaves: ls,
      totalChars: ls.reduce((s, l) => s + l.charCount, 0),
      leafCount: ls.length,
    };
    if (id === "messages") {
      stat.byRole = { user: 0, assistant: 0, system: 0 };
      for (const l of ls) {
        const r = l.messageRole;
        if (r === "user") stat.byRole.user += 1;
        else if (r === "assistant") stat.byRole.assistant += 1;
        else if (r === "system") stat.byRole.system += 1;
      }
    } else if (id === "tools") {
      const tools = new Set<string>();
      for (const l of ls) tools.add(l.rootSlotType);
      stat.toolCount = tools.size;
    }
    out.push(stat);
  }
  return out;
}

const SUB_BAR_HEIGHT = 36;

// ─── 二级 strip：leaves（消费 fisheye-strip 模块） ────────────────────────────
//
// 简化后只剩一条 strip + 顶部 toggle：
//   - 名称放置完全由 FisheyeStrip 内部按段宽决定（放得下就 inside，否则 hidden），
//     不再用上下 callout 巷道兜底（避免上下波动）。
//   - hover / select 反馈走 FisheyeStrip 内部三档强度（颜色/字重），不再外挂顶部 readout 行。

/** Leaf item — 适配 FisheyeStrip 接口（id + size），保留原 leaf 引用便于回调取数据 */
export interface LeafItem {
  id: string;
  size: number;
  leaf: LeafLite;
}

type LayoutMode = "proportional" | "equal";

/** 过载阈值：最窄段 < 此像素值时认为「太密」，提示用户改用 table */
const OVERLOAD_MIN_BAR_PX = 1.5;

export function LeafStrip({
  leaves, selectedId, onSelect, getColor, getUnderlineColor,
  getBorderStyle, getIndicatorLine, getIndicatorColor, getTextureType,
}: {
  leaves: LeafLite[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Optional override — Lens panel passes lens-based color; default uses
   *  leafFill (section-based). */
  getColor?: (leaf: LeafLite) => string;
  /** Optional — return underline color for the leaf bar (Diff lens uses this:
   *  add 绿 / modify 黄). null = no underline. Bar 本身不变。 */
  getUnderlineColor?: (leaf: LeafLite) => string | null;
  getBorderStyle?: (leaf: LeafLite) => string | null;
  getIndicatorLine?: (leaf: LeafLite) => "top" | "left" | null;
  getIndicatorColor?: (leaf: LeafLite) => string | null;
  getTextureType?: (leaf: LeafLite) => "stripes" | "dots" | "none" | null;
}) {
  const { t } = useTranslation();
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("proportional");
  const [stripStatus, setStripStatus] = useState<FisheyeStatus | null>(null);
  const isOverloaded = (stripStatus?.minBarPx ?? Infinity) < OVERLOAD_MIN_BAR_PX;

  // 业务层把 leaves 转为 FisheyeItem
  // 等宽模式：所有 size 设为 1（模块仍按线性 size 分配空间 → 每段等宽）
  const items: LeafItem[] = useMemo(
    () => leaves.map((l) => ({
      id: l.nodeId,
      size: layoutMode === "equal" ? 1 : Math.max(l.charCount, 0.001),
      leaf: l,
    })),
    [leaves, layoutMode],
  );

  if (leaves.length === 0) return null;

  return (
    <div
      style={{
        display: "flex", flexDirection: "column", gap: 4,
        minWidth: 0, maxWidth: "100%", overflowX: "hidden",
        // 过载时整条 bar 吸顶，让用户滚 table 时仍能看见分布索引
        position: isOverloaded ? "sticky" : "static",
        top: isOverloaded ? 0 : "auto",
        zIndex: isOverloaded ? 5 : "auto",
        background: isOverloaded ? "#fff" : "transparent",
        paddingTop: isOverloaded ? 6 : 0,
        paddingBottom: isOverloaded ? 6 : 0,
        boxShadow: isOverloaded ? "0 2px 4px -2px rgba(17,24,39,0.06)" : "none",
      }}
    >
      {/* 内联布局切换（右对齐） */}
      <SegmentedToggle<"proportional" | "equal">
        value={layoutMode}
        onChange={setLayoutMode}
        options={[
          { id: "proportional", label: t("attribution.layoutProportional"), title: t("attribution.layoutProportionalTitle") },
          { id: "equal",        label: t("attribution.layoutEqual"),        title: t("attribution.layoutEqualTitle") },
        ]}
      />

      {/* Strip — getLabel 统一走 leafLabel(对外名,优先 displayName);命中 skill_listing
          的 leaf 显示 "Skills 注册" 友好标签。模块按段宽决定 inside / 隐藏。
          minCount=5 让 attribution leaves 天然开启鱼眼。hover 用对外名 + 字符数,
          不带 ruleId(技术信息归选中后的 ⓘ)。 */}
      <FisheyeStrip<LeafItem>
        items={items}
        getColor={(it) => getColor ? getColor(it.leaf) : leafFill(it.leaf)}
        getUnderlineColor={getUnderlineColor ? (it) => getUnderlineColor(it.leaf) : undefined}
        getBorderStyle={(it) => getBorderStyle ? getBorderStyle(it.leaf) : (rolePalette[roleOf(it.leaf)]?.borderStyle ?? null)}
        getIndicatorLine={(it) => getIndicatorLine ? getIndicatorLine(it.leaf) : (rolePalette[roleOf(it.leaf)]?.indicatorLine ?? null)}
        getIndicatorColor={(it) => getIndicatorColor ? getIndicatorColor(it.leaf) : (rolePalette[roleOf(it.leaf)]?.marker ?? null)}
        getTextureType={(it) => getTextureType ? getTextureType(it.leaf) : (rolePalette[roleOf(it.leaf)]?.texture ?? null)}
        getLabel={(it) => {
          const sl = it.leaf.origin.kind === "rule" ? it.leaf.origin.payload?.skillListing : undefined;
          return sl ? t("skillListing.title") : leafLabel(it.leaf);
        }}
        getTitle={(it) => {
          const sl = it.leaf.origin.kind === "rule" ? it.leaf.origin.payload?.skillListing : undefined;
          if (sl) {
            return `${t("skillListing.title")} · ${t("skillListing.rowSuffix", { count: sl.entries.length })} · ${fmtK(it.leaf.charCount)} chars`;
          }
          return `${leafLabel(it.leaf)} · ${fmtK(it.leaf.charCount)} chars`;
        }}
        height={SUB_BAR_HEIGHT}
        background="transparent"
        autoConfig={{ minCount: 5, clickableThresholdPx: 16 }}
        selectedId={selectedId}
        onSelect={(it) => onSelect(it.id)}
        onStatusChange={setStripStatus}
      />
    </div>
  );
}

export function LeafTable({
  leaves, selectedId, onSelect, getColor, getBadges, totalContextChars,
}: {
  leaves: LeafLite[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Optional override — Lens panel passes lens-based color; default uses
   *  leafFill (section-based). */
  getColor?: (leaf: LeafLite) => string;
  /** 每个 leaf 行末尾的额外 badge 列表，按 active lens 维度提供
   *  （Lens panel 用来表达 diff state / cache layer / audit 等附加属性）。 */
  getBadges?: (leaf: LeafLite) => Array<{ key: string; label: string; color: string; bg: string; border: string; title?: string }>;
  /** 总 context 字节数。用于：skill_listing 行的 % 列显示"占 context X%"
   *  而非 section-相对 %（这样既有的 LeafTable 行就充当了 meta header，
   *  不需要在 SelectedDetail 里再叠一条额外的 bar）。 */
  totalContextChars?: number;
}) {
  const { t } = useTranslation();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // 百分比口径恒定为「占整个 context」(全局分母),不随下钻/筛选变。分母优先用
  // totalContextChars(全局),仅在未传时退回 leaves 之和(理论上不发生)。这样任何
  // 视图下的 "X%" 都是"占整个 prompt 多少",消除"占筛选子集"的误读（旧逻辑 33.7%+66.3%=100%）。
  const denom = (totalContextChars && totalContextChars > 0)
    ? totalContextChars
    : leaves.reduce((s, l) => s + l.charCount, 0);
  // 选中后只显示该 leaf 行，其他兄弟不再列出（避免与 SelectedDetail 重复信息）
  const visibleLeaves = selectedId ? leaves.filter((l) => l.nodeId === selectedId) : leaves;
  // 汇总条：当前这批 leaves 的合计 + 占上下文比例。回答"我筛/钻的这批一共多大"
  // ——取代会误导的"每行占子集%"。选中单行时不显示（单行自己那行就是答案）。
  const groupChars = leaves.reduce((s, l) => s + l.charCount, 0);
  const groupPct = denom > 0 ? (groupChars / denom) * 100 : 0;
  const showSummary = !selectedId && leaves.length > 1;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      {showSummary && (
        <div style={{
          display: "flex", alignItems: "baseline", gap: 8,
          padding: "4px 8px", marginBottom: 2,
          fontSize: 10, color: "#6b7280",
          borderBottom: "1px solid #f3f4f6",
        }}>
          <span style={{ fontWeight: 600, color: "#374151" }}>{leaves.length} {t("attribution.detail.segments", { defaultValue: "段" })}</span>
          <span style={{ color: "#d1d5db" }}>·</span>
          <span>{t("attribution.detail.subtotal", { defaultValue: "合计" })} {fmtK(groupChars)}</span>
          <span style={{ color: "#d1d5db" }}>·</span>
          <span>{t("attribution.detail.ofContext", { defaultValue: "占上下文" })} {groupPct.toFixed(1)}%</span>
        </div>
      )}
      {visibleLeaves.map((l) => {
        const isSel = selectedId === l.nodeId;
        const fill = getColor ? getColor(l) : leafFill(l);
        // 当 leaf 命中 skill_listing rule 时：
        //   - 行标签换成"Skills 注册 · N 个"
        //   - preview 清空（普通用户不关心 <system-reminder> 原文）
        //   - % 列改为"占 context X%"（如果上游传了 totalContextChars），
        //     与 SelectedDetail 想表达的"占 context 多少"对齐
        //   - hover 这一行弹出 tooltip card（rule / 来源 / 解析状态）
        const skillListing = l.origin.kind === "rule" ? l.origin.payload?.skillListing : undefined;
        // ruleMeta（命中 corpus rule 的 leaf）：用 displayName 替代晦涩 slotType，
        // 用 summary（一句话解读）替代原文 preview。无 ruleMeta 的 leaf 保持原样。
        const rm = l.ruleMeta;
        const rowLabel = skillListing
          ? `${t("skillListing.rowLabel")} · ${t("skillListing.rowSuffix", { count: skillListing.entries.length })}`
          : leafLabel(l);
        const rowPreview = skillListing ? "" : (rm?.summary ?? l.preview);
        // 动态来源后缀（仅 dynamic 段）："summary ← 变的是 X"
        const previewSuffix = rm?.stability === "dynamic" && rm.dynamicSource ? ` ${rm.dynamicSource}` : "";
        // 恒用全局分母：每行 % = 占整个 context（语义恒定,与汇总条同口径）。
        const pct = denom > 0 ? (l.charCount / denom) * 100 : 0;
        const showTooltip = !!skillListing && hoveredId === l.nodeId;
        return (
          <div key={l.nodeId} style={{ position: "relative" }}>
          <button
            onClick={() => onSelect(l.nodeId)}
            onMouseEnter={() => { if (skillListing) setHoveredId(l.nodeId); }}
            onMouseLeave={() => { if (skillListing) setHoveredId(null); }}
            className={!isSel ? "hover:bg-gray-50" : ""}
            style={{
              display: "flex", alignItems: "center", gap: 12,
              padding: "6px 8px",
              // 动态段（stability=dynamic）原位浅黄高亮,不重排——一眼看出"每轮/每次变"的段。
              background: isSel ? BRAND.indigo50 : (rm?.stability === "dynamic" ? "#fffbeb" : "transparent"),
              border: "none", borderRadius: 4,
              cursor: "pointer", textAlign: "left",
              width: "100%",
              transition: "background 0.1s",
            }}
          >
            <span style={{ width: 8, height: 8, borderRadius: 2, background: fill, flexShrink: 0 }} />
            <span style={{
              // displayName（中文导览名）用普通字体;晦涩 slotType slug 保持 mono。
              fontFamily: (skillListing || rm?.displayName) ? undefined : "ui-monospace, SFMono-Regular, monospace",
              fontSize: 11,
              color: skillListing ? "#312e81" : "#111827",
              fontWeight: (skillListing || rm?.displayName) ? 600 : undefined,
              minWidth: 150, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            }}>
              {rowLabel}
            </span>
            {rm?.stability && (() => {
              // 明确二元:动态(琥珀,醒目)/ 静态(中性灰)。
              const sc = rm.stability === "dynamic"
                ? { c: "#b45309", bg: "#fef3c7", bd: "#fde68a" }
                : { c: "#475569", bg: "#f1f5f9", bd: "#e2e8f0" };
              return (
                <span style={{
                  display: "inline-flex", alignItems: "center",
                  padding: "1px 6px", borderRadius: 3,
                  fontSize: 9, fontWeight: 700, whiteSpace: "nowrap",
                  color: sc.c, background: sc.bg, border: `1px solid ${sc.bd}`,
                  flexShrink: 0,
                }}>
                  {t(`attribution.stability.${rm.stability}`)}
                </span>
              );
            })()}
            <span style={{ fontSize: 11, color: "#374151", minWidth: 50 }}>{fmtK(l.charCount)}</span>
            <span
              title={t("attribution.detail.ofContextTip", { defaultValue: "占整个请求上下文的比例（分母恒定 = 全部 context，不随筛选/下钻变化）" })}
              style={{ fontSize: 10, color: "#9ca3af", minWidth: 84, whiteSpace: "nowrap" }}
            >
              {t("attribution.detail.ofContext", { defaultValue: "占上下文" })} {pct.toFixed(1)}%
            </span>
            <span style={{ fontSize: 10, color: "#6b7280", flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {rowPreview}
              {previewSuffix && <span style={{ color: "#b45309" }}>{previewSuffix}</span>}
            </span>
            {getBadges && getBadges(l).map((b) => (
              <span
                key={b.key}
                title={b.title}
                style={{
                  display: "inline-flex", alignItems: "center",
                  padding: "1px 5px", borderRadius: 3,
                  fontSize: 9, fontWeight: 700, letterSpacing: "0.02em",
                  fontFamily: "ui-monospace, SFMono-Regular, monospace",
                  color: b.color, background: b.bg, border: `1px solid ${b.border}`,
                  flexShrink: 0,
                }}
              >
                {b.label}
              </span>
            ))}
          </button>
          {showTooltip && (
            <SkillListingTooltipCard leaf={l} totalContextChars={totalContextChars} />
          )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Skill listing 专属 leaf 详情 ──────────────────────────────────────────────
//
// 当 leaf.origin.kind==='rule' 且 origin.payload.skillListing 存在时，SelectedDetail
// 走这个分支。完全取代通用 leaf 详情布局：不再展示 ruleId / jsonPath / confidence /
// 字节数等技术 header；普通用户看到的只有"Skills 注册 · N 个"标题、解析后的 skill
// 列表，以及一个右上角的 "原文 / 格式化" 切换按钮。技术元信息通过 hover meta 条触
// 发的 tooltip card 提供（参考 token ledger 风格）。
function SkillListingTooltipCard({
  leaf,
  totalContextChars,
}: {
  leaf: LeafLite;
  totalContextChars?: number;
}) {
  const { t } = useTranslation();
  if (leaf.origin.kind !== "rule" || !leaf.origin.payload?.skillListing) return null;
  const sl = leaf.origin.payload.skillListing;
  const path = leaf.jsonPath ? leaf.jsonPath.replace(/^reqBody\./, "") : leaf.slotType;
  const size = fmtK(leaf.charCount);
  const pct =
    totalContextChars && totalContextChars > 0
      ? ((leaf.charCount / totalContextChars) * 100).toFixed(1)
      : null;
  const parseStatusText =
    sl.errorCount === 0
      ? t("skillListing.tooltipAllParsed", { count: sl.entries.length })
      : t("skillListing.tooltipPartialParsed", { ok: sl.successCount, err: sl.errorCount });

  const sectionTitleStyle: React.CSSProperties = {
    fontSize: 10,
    color: "#6b7280",
    fontWeight: 600,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    marginBottom: 4,
  };
  const valueStyle: React.CSSProperties = { fontSize: 12, color: "#1f2937", lineHeight: 1.55 };
  const kvRowStyle: React.CSSProperties = { display: "flex", gap: 8, alignItems: "baseline" };
  const kStyle: React.CSSProperties = { fontSize: 11, color: "#6b7280", minWidth: 64 };
  const vStyle: React.CSSProperties = {
    fontSize: 12,
    color: "#1f2937",
    fontFamily: "ui-monospace, SFMono-Regular, monospace",
  };

  return (
    <div
      role="tooltip"
      style={{
        position: "absolute",
        top: "calc(100% + 6px)",
        left: 0,
        zIndex: 50,
        width: 380,
        background: "#fff",
        border: "1px solid #e5e7eb",
        borderRadius: 6,
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.08), 0 2px 6px rgba(0, 0, 0, 0.04)",
        padding: 14,
        pointerEvents: "none",
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 700, color: "#312e81", marginBottom: 10 }}>
        {t("skillListing.tooltipTitle")}
      </div>

      <div style={{ marginBottom: 10 }}>
        <div style={sectionTitleStyle}>{t("skillListing.tooltipParsedFrom")}</div>
        <div style={valueStyle}>{t("skillListing.tooltipParsedFromValue")}</div>
        <div style={{ ...kvRowStyle, marginTop: 4 }}>
          <span style={kStyle}>{t("skillListing.tooltipPosition")}</span>
          <span style={vStyle}>{path}</span>
        </div>
        <div style={kvRowStyle}>
          <span style={kStyle}>{t("skillListing.tooltipSize")}</span>
          <span style={vStyle}>
            {t("skillListing.tooltipSizeValue", { size, count: sl.entries.length })}
            {pct ? ` · ${pct}%` : ""}
          </span>
        </div>
      </div>

      <div style={{ marginBottom: 10 }}>
        <div style={sectionTitleStyle}>{t("skillListing.tooltipDataSource")}</div>
        <div style={{ ...valueStyle, fontSize: 11.5, color: "#374151" }}>
          {t("skillListing.tooltipDataSourceValue")}
        </div>
      </div>

      <div style={{ marginBottom: 10 }}>
        <div style={sectionTitleStyle}>{t("skillListing.tooltipMatchedRule")}</div>
        <div style={vStyle}>{leaf.origin.ruleId}</div>
        <div style={kvRowStyle}>
          <span style={kStyle}>{t("skillListing.tooltipConfidence")}</span>
          <span style={vStyle}>{leaf.origin.confidence}</span>
        </div>
      </div>

      <div>
        <div style={sectionTitleStyle}>{t("skillListing.tooltipParseStatus")}</div>
        <div
          style={{
            ...valueStyle,
            color: sl.errorCount === 0 ? "#15803d" : "#b45309",
            fontWeight: 500,
          }}
        >
          {sl.errorCount === 0 ? "✓ " : "⚠ "}
          {parseStatusText}
        </div>
      </div>
    </div>
  );
}

function SkillListingDetail({
  leaf,
  totalContextChars,
}: {
  leaf: LeafLite;
  totalContextChars?: number;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"parsed" | "raw">("parsed");

  if (leaf.origin.kind !== "rule" || !leaf.origin.payload?.skillListing) return null;
  const sl = leaf.origin.payload.skillListing;
  const fullText = leaf.rawText ?? leaf.preview;

  const sizeStr = fmtK(leaf.charCount);
  const pct =
    totalContextChars && totalContextChars > 0
      ? ((leaf.charCount / totalContextChars) * 100).toFixed(1)
      : null;
  const metaText = pct
    ? t("skillListing.detailMeta", {
        title: t("skillListing.title"),
        count: sl.entries.length,
        size: sizeStr,
        pct,
      })
    : t("skillListing.detailMetaNoCtx", {
        title: t("skillListing.title"),
        count: sl.entries.length,
        size: sizeStr,
      });

  return (
    <div style={{ paddingTop: 6, display: "flex", flexDirection: "column", gap: 8 }}>
      {/* 不再新增 meta 条 —— 直接复用上方 LeafTable 行作为标题 + 状态展示。
          metaText 仍用于 a11y / 调试，不渲染。 */}
      <span style={{ display: "none" }}>{metaText}</span>

      {/* Toggle 行：sub bar 下面，content 右上角；与 SelectedDetail 的风格完全一致的单按钮切换与复制按钮 */}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
        <RenderRawCopyActions
          rawMode={mode === "raw"}
          onToggleRawMode={() => setMode(m => m === "parsed" ? "raw" : "parsed")}
          textToCopy={fullText}
        />
      </div>

      {/* Content */}
      {mode === "parsed" ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "max-content 1fr",
            columnGap: 16,
            rowGap: 6,
            padding: "10px 12px",
            background: "#fafafa",
            border: "1px solid #e5e7eb",
            borderRadius: 4,
          }}
        >
          {sl.entries.map((e, i) => (
            <Fragment key={i}>
              {e.parseError ? (
                <>
                  <span
                    style={{
                      fontFamily: "ui-monospace, SFMono-Regular, monospace",
                      fontSize: 12,
                      color: "#9ca3af",
                      fontStyle: "italic",
                      whiteSpace: "nowrap",
                    }}
                  >
                    ⚠ unparsed
                  </span>
                  <span
                    style={{
                      fontSize: 12,
                      color: "#9ca3af",
                      fontStyle: "italic",
                      lineHeight: 1.5,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                    }}
                    title={e.rawLine}
                  >
                    {e.rawLine}
                  </span>
                </>
              ) : (
                <>
                  <span
                    style={{
                      fontFamily: "ui-monospace, SFMono-Regular, monospace",
                      fontSize: 12.5,
                      color: BRAND.indigo700,
                      fontWeight: 500,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {e.name}
                  </span>
                  <span
                    style={{
                      fontSize: 12.5,
                      color: e.description ? "#374151" : "#9ca3af",
                      lineHeight: 1.5,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                    }}
                    title={e.description ?? "(no description)"}
                  >
                    {e.description ?? "—"}
                  </span>
                </>
              )}
            </Fragment>
          ))}
        </div>
      ) : (
        <pre
          style={{
            margin: 0,
            padding: "10px 12px",
            background: "#fafafa",
            border: "1px solid #e5e7eb",
            borderRadius: 4,
            fontSize: 11.5,
            fontFamily: "ui-monospace, SFMono-Regular, monospace",
            color: "#1f2937",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            lineHeight: 1.55,
          }}
        >
          {fullText}
        </pre>
      )}
    </div>
  );
}


function injectDynamicPlaceholders(text: string, fields: DynamicField[]): string {
  if (!fields || fields.length === 0) return text;

  const validFields = fields
    .map((f, index) => ({ ...f, originalIndex: index }))
    .filter((f) => f.charStart >= 0 && f.charEnd <= text.length && f.charStart < f.charEnd)
    .sort((a, b) => b.charStart - a.charStart);

  let result = text;
  validFields.forEach((f) => {
    const before = result.substring(0, f.charStart);
    const value = result.substring(f.charStart, f.charEnd);
    const after = result.substring(f.charEnd);
    result = `${before}DYNSTARTa${f.originalIndex}a${value}DYNEND${after}`;
  });

  return result;
}

interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

function rehypeHighlightDynamicFields(fields: DynamicField[]) {
  return () => {
    return (tree: HastNode) => {
      function visit(node: HastNode) {
        if (node.type === "text" && typeof node.value === "string") {
          const text = node.value;
          const regex = /DYNSTARTa(\d+)a([\s\S]*?)DYNEND/g;
          
          if (regex.test(text)) {
            regex.lastIndex = 0;
            const children: HastNode[] = [];
            let lastIndex = 0;
            let match;
            while ((match = regex.exec(text)) !== null) {
              const matchIndex = match.index;
              if (matchIndex > lastIndex) {
                children.push({ type: "text", value: text.substring(lastIndex, matchIndex) });
              }
              const fieldIdx = parseInt(match[1], 10);
              const val = match[2];
              const field = fields[fieldIdx];
              
              children.push({
                type: "element",
                tagName: "span",
                properties: {
                  style: {
                    background: "#fef3c7",
                    color: "#92400e",
                    borderRadius: 2,
                    padding: "0 2px",
                    boxShadow: "inset 0 -1px 0 #fcd34d",
                  },
                  title: field ? `${field.name} · ${field.source} · ${i18n.t("attribution.stability.runtimeDynamicValue")}` : i18n.t("attribution.stability.runtimeDynamicValue"),
                },
                children: [{ type: "text", value: val }]
              });
              lastIndex = regex.lastIndex;
            }
            if (lastIndex < text.length) {
              children.push({ type: "text", value: text.substring(lastIndex) });
            }
            
            node.type = "element";
            node.tagName = "span";
            node.properties = {};
            node.children = children;
          }
        } else if (node.children) {
          node.children.forEach(visit);
        }
      }
      visit(tree);
    };
  };
}

function renderMarkdownWithHighlights(
  text: string,
  fields: DynamicField[] | undefined,
): React.ReactNode {
  if (!fields || fields.length === 0) {
    return <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>;
  }

  const textWithPlaceholders = injectDynamicPlaceholders(text, fields);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlightDynamicFields(fields)]}
    >
      {textWithPlaceholders}
    </ReactMarkdown>
  );
}

function renderThinkingBlock(content: string): React.ReactNode {
  return (
    <pre style={{
      margin: 0, padding: "10px 12px",
      background: "#fff", border: "1px solid #e5e7eb", borderRadius: 6,
      fontFamily: "ui-monospace, SFMono-Regular, monospace",
      fontSize: 11.5, lineHeight: 1.6,
      whiteSpace: "pre-wrap", wordBreak: "break-word",
      color: "#374151",
    }}>
      {content}
    </pre>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderBashToolCall(input: any): React.ReactNode {
  const command = typeof input === "object" && typeof input.command === "string" ? input.command : "";
  const runInBackground = typeof input === "object" && !!input.run_in_background;
  
  return (
    <div style={{
      fontFamily: "ui-monospace, SFMono-Regular, monospace",
      backgroundColor: "#f9fafb", color: "#1f2937",
      padding: "10px 12px", borderRadius: 6,
      border: "1px solid #e5e7eb",
      fontSize: 11.5, lineHeight: 1.5,
      overflowX: "auto",
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <span style={{ color: BRAND.indigo600, userSelect: "none", fontWeight: 700 }}>$</span>
        <span style={{ color: "#1f2937", whiteSpace: "pre-wrap", wordBreak: "break-all", flex: 1 }}>{command}</span>
        {runInBackground && (
          <span style={{ background: "#fef3c7", color: "#b45309", border: "1px solid #fde68a", padding: "1px 4px", borderRadius: 3, fontSize: 8.5, flexShrink: 0 }}>
            bg
          </span>
        )}
      </div>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderGenericToolCall(name: string, input: any): React.ReactNode {
  const params = typeof input === "object" && input !== null ? Object.entries(input) : [];
  
  return (
    <div style={{
      border: "1px solid #e5e7eb", borderRadius: 6, overflow: "hidden",
      backgroundColor: "#fff", boxShadow: "0 1px 3px 0 rgba(0,0,0,0.05)",
    }}>
      <div style={{
        backgroundColor: "#f3f4f6", padding: "8px 12px",
        borderBottom: "1px solid #e5e7eb", display: "flex", alignItems: "center", gap: 8
      }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: "#6b7280", letterSpacing: "0.05em", textTransform: "uppercase" }}>Tool Call</span>
        <span style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12, fontWeight: 700, color: "#111827" }}>{name}</span>
      </div>
      <div style={{ padding: "12px", display: "flex", flexDirection: "column", gap: 8 }}>
        {params.length > 0 ? (
          params.map(([key, value]) => (
            <div key={key} style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: 12, fontSize: 12, borderBottom: "1px solid #f3f4f6", paddingBottom: 6 }}>
              <span style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", color: "#6b7280", fontWeight: 600 }}>{key}</span>
              <span style={{
                fontFamily: typeof value === "object" ? "ui-monospace, SFMono-Regular, monospace" : "inherit",
                color: "#1f2937", whiteSpace: "pre-wrap", wordBreak: "break-word"
              }}>
                {typeof value === "object" ? JSON.stringify(value, null, 2) : String(value)}
              </span>
            </div>
          ))
        ) : (
          <div style={{ fontSize: 11, color: "#9ca3af", fontStyle: "italic" }}>No parameters</div>
        )}
      </div>
    </div>
  );
}

function getThinkingRawJson(content: string, signature?: string): string {
  const isRedacted = !content || (signature && content === signature);
  const block = isRedacted
    ? { type: "redacted_thinking", data: signature || content }
    : { type: "thinking", thinking: content, signature: signature || "" };
  return JSON.stringify(block, null, 2);
}

function getToolResultRawJson(content: string, toolUseId?: string): string {
  const block = {
    type: "tool_result",
    tool_use_id: toolUseId || "",
    content: content,
  };
  return JSON.stringify(block, null, 2);
}

// ─── 叶子详情 ───────────────────────────────────────────────────────────────

export function SelectedDetail({ leaf, onLinkSource, totalContextChars }: {
  leaf: LeafLite;
  onLinkSource?: (sourceCallId: number, sourceTurnId?: number) => void;
  /** 总 context 字节数，用于在 skill_listing 等富展示中显示"占 context X%"。
   *  缺省时富展示只显示绝对字符数，不显示百分比。 */
  totalContextChars?: number;
}) {
  const { t } = useTranslation();
  const { flashEvent, flashCall, flashToolUse } = useAttributionGraph();
  const [rawMode, setRawMode] = useState(false);
  const isSystemLeaf = sectionOf(leaf.rootSlotType) === "system";
  const isToolLeaf = sectionOf(leaf.rootSlotType) === "tools";
  const isThinkingLeaf = leaf.slotType === "messages.thinking";
  const isToolUseLeaf = leaf.slotType === "messages.tool_use";
  const isToolResultLeaf = leaf.slotType === "messages.tool_result";
  const isAssistantTextLeaf = leaf.messageRole === "assistant" && !isThinkingLeaf && !isToolUseLeaf;
  const isImageLeaf = leaf.slotType === "messages.block.image";
  const isInjectionLeaf = leaf.slotType === "messages.inline.system-reminder" || leaf.slotType === "messages.system-message";
  const hasRawToggle = isSystemLeaf || isToolLeaf || isAssistantTextLeaf || isThinkingLeaf || isToolUseLeaf || isToolResultLeaf || isImageLeaf || isInjectionLeaf;

  const rawTextContent = useMemo(() => {
    if (isAssistantTextLeaf) {
      return JSON.stringify({
        type: "text",
        text: leaf.rawText ?? leaf.preview,
      }, null, 2);
    }
    if (isThinkingLeaf) {
      return getThinkingRawJson(leaf.rawText || "", leaf.thinkingSignature);
    }
    if (isToolUseLeaf) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parsed = tryParseSegmentJson(leaf.rawText ?? leaf.preview) as any;
      return JSON.stringify({
        type: "tool_use",
        id: parsed?.id || leaf.toolUseId || "",
        name: parsed?.name || leaf.toolName || "",
        input: parsed?.input || {},
      }, null, 2);
    }
    if (isToolResultLeaf) {
      return getToolResultRawJson(leaf.rawText || "", leaf.toolUseId);
    }
    return leaf.rawText ?? leaf.preview;
  }, [leaf, isAssistantTextLeaf, isThinkingLeaf, isToolUseLeaf, isToolResultLeaf]);

  // 命中 skill_listing rule 时，走专属富展示，完全替换通用 leaf 详情布局。
  if (leaf.origin.kind === "rule" && leaf.origin.payload?.skillListing) {
    return <SkillListingDetail leaf={leaf} totalContextChars={totalContextChars} />;
  }

  const sourceTurnId = leaf.origin.kind === "jsonl" ? leaf.origin.sourceTurnId : undefined;
  const sourceCallId = leaf.origin.kind === "jsonl" ? leaf.origin.sourceCallId : undefined;
  const firstSeenInCall = leaf.origin.kind === "jsonl" ? leaf.origin.firstSeenInCall : undefined;
  const jsonlLineIdx = leaf.origin.kind === "jsonl" ? leaf.origin.jsonlLineIdx : undefined;
  const isToolUseLeafType = leaf.origin.kind === "jsonl" && (() => {
    const ek = leaf.origin.eventKind;
    if (typeof ek === "string") return ek === "tool_use";
    return ek?.source === "tool_use";
  })();
  const jumpTarget = firstSeenInCall ?? sourceCallId;
  const handleJumpSource = (jumpTarget !== undefined && onLinkSource)
    ? () => {
        onLinkSource(jumpTarget, sourceTurnId);
        if (isToolUseLeafType) {
          if (leaf.toolUseId) {
            requestAnimationFrame(() => flashToolUse(leaf.toolUseId!));
          } else {
            requestAnimationFrame(() => flashCall(jumpTarget));
          }
        } else if (jsonlLineIdx != null) {
          requestAnimationFrame(() => flashEvent(jsonlLineIdx));
        }
      }
    : undefined;

  const { kindLabel, title } = leafOriginToCardHeader(leaf);
  const requestPath = leaf.jsonPath ? leaf.jsonPath.replace(/^reqBody\./, "") : undefined;
  const confidence =
    leaf.origin.kind === "rule" || leaf.origin.kind === "jsonl"
      ? leaf.origin.confidence
      : undefined;
  const originSuffixParts: string[] = [kindLabel.toLowerCase()];
  if (leaf.origin.kind === "jsonl") {
    originSuffixParts.push(`L${leaf.origin.jsonlLineIdx + 1}`);
  }
  if (confidence) originSuffixParts.push(confidence);
  originSuffixParts.push(`${leaf.charCount}b`);
  const originSuffix = originSuffixParts.join(" · ");

  const parsedRawJson = tryParseSegmentJson(leaf.rawText ?? leaf.preview);
  const hasJsonContent = parsedRawJson !== undefined;

  const jumpLabel = jumpTarget !== undefined
    ? t("terms.viewSourceCall", { callId: jumpTarget })
    : undefined;
  const jumpTooltip = jumpTarget !== undefined
    ? (isToolUseLeafType
        ? t("terms.jumpToCallCardTooltip", { callId: jumpTarget })
        : t("terms.jumpToCallLineTooltip", { callId: jumpTarget }))
    : undefined;

  const dynamicFields = leaf.origin.kind === "rule" ? leaf.origin.dynamicFields : undefined;
  const contentText = leaf.rawText ?? leaf.preview;

  const textToCopy = () => {
    if (rawMode) {
      return rawTextContent;
    }
    return leaf.rawText ?? leaf.preview;
  };

  const btnBaseStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    height: 24,
    padding: "0 8px",
    fontSize: 10,
    fontWeight: 600,
    borderRadius: 4,
    cursor: "pointer",
    whiteSpace: "nowrap",
    boxSizing: "border-box",
    lineHeight: 1,
    transition: "all 0.12s ease",
  };

  const infoBtnStyle: React.CSSProperties = {
    ...btnBaseStyle,
    border: "1px solid #e5e7eb",
    background: "#fff",
    color: "#9ca3af",
    cursor: "help",
    padding: "0 6px",
  };

  const jumpBtnStyle: React.CSSProperties = {
    ...btnBaseStyle,
    border: "1px solid #c7d2fe",
    background: "#e0e7ff",
    color: BRAND.indigo600,
  };

  return (
    <div style={{ paddingTop: 6, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end" }}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t("attribution.detail.techInfo", { defaultValue: "原始信息" })}
              style={infoBtnStyle}
            >
              <Info size={11} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6} className="max-w-sm">
            <div style={{ display: "flex", flexDirection: "column", gap: 3, fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 11 }}>
              {requestPath && <div>{requestPath}</div>}
              <div>{title ?? "—"}</div>
              <div style={{ opacity: 0.7 }}>{originSuffix}</div>
            </div>
          </TooltipContent>
        </Tooltip>
        <RenderRawCopyActions
          rawMode={rawMode}
          showToggle={hasRawToggle}
          onToggleRawMode={() => setRawMode(v => !v)}
          textToCopy={textToCopy}
        />
        {handleJumpSource && (
          <button
            type="button"
            title={jumpTooltip}
            onClick={(e) => { e.stopPropagation(); handleJumpSource(); }}
            className="hover:bg-indigo-100 transition-colors"
            style={jumpBtnStyle}
          >
            <LinkIcon />
            {jumpLabel ?? t("terms.jump")}
          </button>
        )}
      </div>



      {/* 内容主体 */}
      {rawMode ? (() => {
        const isRawJson = (() => {
          const trimmed = rawTextContent.trim();
          return trimmed.startsWith("{") || trimmed.startsWith("[");
        })();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let parsedRawJsonObj: any = null;
        if (isRawJson) {
          try { parsedRawJsonObj = JSON.parse(rawTextContent); }
          catch { /* ignored */ }
        }
        if (isRawJson && parsedRawJsonObj) {
          return (
            <div style={{
              padding: "10px 12px",
              background: "#fafafa", border: "1px solid #e5e7eb", borderRadius: 6,
            }}>
              <JsonView
                value={parsedRawJsonObj}
                collapsed={false}
                displayDataTypes={false}
                displayObjectSize={false}
                enableClipboard
                style={{
                  backgroundColor: "transparent",
                  fontFamily: "ui-monospace, SFMono-Regular, monospace",
                  fontSize: 11,
                  lineHeight: 1.5,
                }}
              />
            </div>
          );
        }
        return (
          <pre style={{
            margin: 0, padding: "10px 12px",
            background: "#fafafa", border: "1px solid #e5e7eb", borderRadius: 6,
            fontFamily: "ui-monospace, SFMono-Regular, monospace",
            fontSize: 11.5, lineHeight: 1.55,
            whiteSpace: "pre-wrap", wordBreak: "break-word",
            color: "#1f2937",
          }}>
            {rawTextContent}
          </pre>
        );
      })() : isSystemLeaf || isToolLeaf || isInjectionLeaf ? (
        <div className="md-prose" style={{
          fontSize: 12, color: "#1f2937",
          border: "1px solid #e5e7eb", borderRadius: 6, background: "#fff",
          padding: "8px 12px",
        }}>
          {renderMarkdownWithHighlights(contentText, dynamicFields)}
        </div>
      ) : isAssistantTextLeaf ? (
        <div className="md-prose" style={{
          fontSize: 12, color: "#1f2937",
          border: "1px solid #e5e7eb", borderRadius: 6, background: "#fff",
          padding: "8px 12px",
        }}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{contentText}</ReactMarkdown>
        </div>
      ) : isThinkingLeaf ? (
        renderThinkingBlock(contentText)
      ) : isToolUseLeaf ? (() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const parsed = tryParseSegmentJson(leaf.rawText ?? leaf.preview) as any;
        const isBash = leaf.toolName?.toLowerCase() === "bash";
        if (isBash) {
          return renderBashToolCall(parsed?.input);
        }
        return renderGenericToolCall(leaf.toolName || "Unknown Tool", parsed?.input);
      })() : isImageLeaf ? (
        <div style={{
          padding: "16px",
          background: "#f9fafb",
          border: "1px dashed #d1d5db",
          borderRadius: 6,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
          color: "#4b5563"
        }}>
          <span style={{ fontSize: 24 }}>🖼️</span>
          <span style={{ fontSize: 12, fontWeight: 600 }}>{t("messages.block.image", { defaultValue: "图片输入" })}</span>
          <span style={{ fontSize: 11, fontFamily: "ui-monospace, SFMono-Regular, monospace", color: "#6b7280" }}>{leaf.jsonPath}</span>
        </div>
      ) : (
        <SegmentView
          seg={{
            content: contentText,
            monospace: leaf.origin.kind === "jsonl" || hasJsonContent,
            rawJson: parsedRawJson,
            defaultRaw: hasJsonContent,
          }}
        />
      )}
    </div>
  );
}

// Map a leaf's SegmentOrigin onto EventUnitCard's header slots so that the
// Attribution leaf-detail view reads with the same visual vocabulary as the
// JSONL event rows in Turn cards. The color comes from `EVENT_PALETTES` when
// the origin is a jsonl event (so the dot matches the corresponding
// IntervalEventRow exactly), and from a small rule/structural/unknown
// fallback palette otherwise.
function leafOriginToCardHeader(leaf: LeafLite): {
  color: string;
  kindLabel: string;
  title?: string;
  shortId?: string;
} {
  const o = leaf.origin;
  if (o.kind === "rule") {
    return {
      color: BRAND.blue500,
      kindLabel: "Rule",
      title: o.ruleId.startsWith("wire.") ? `wire · ${o.ruleId.slice(5)}` : o.ruleId,
    };
  }
  if (o.kind === "jsonl") {
    const ek: JsonlEventKindObject = typeof o.eventKind === "string"
      ? { source: o.eventKind as JsonlEventKindObject["source"] }
      : o.eventKind;
    const src = ek.source;
    const ct = ek.contentType;
    // Three assistant-side sources (`tool_use` / `assistant_text` /
    // `thinking`) don't correspond to any `IntervalEventKind` — they
    // aren't free-floating jsonl events in the Turn view, they're blocks
    // inside an assistant message. Color them to match the Response tab's
    // `SLOT_META` palette so the same concept reads with the same color
    // wherever it appears.
    const responseSideColor: Record<string, string> = {
      tool_use:       "#f59e0b",  // response.tool_use marker
      assistant_text: "#22c55e",  // response.text marker
      thinking:       BRAND.violet400,  // response.thinking marker
    };
    const color = responseSideColor[src]
      ?? EVENT_PALETTES[jsonlSourceToIntervalKind(src)]?.fg
      ?? "#64748b";
    const titleParts: string[] = [src];
    if (ct && ct !== "text") titleParts.push(`:${ct}`);
    return {
      color,
      kindLabel: "JSONL",
      title: titleParts.join(""),
      shortId: o.sourceCallId !== undefined ? `call #${o.sourceCallId}` : undefined,
    };
  }
  if (o.kind === "structural") {
    return { color: "#9ca3af", kindLabel: "Structural", title: o.reason };
  }
  return { color: "#9ca3af", kindLabel: "Unknown", title: o.reason };
}

function jsonlSourceToIntervalKind(source: string): IntervalEventKind {
  switch (source) {
    case "user_input":         return "user:human";
    case "tool_result":        return "user:tool_result";
    case "system_local_command": return "user:command";
    case "attachment":         return "attachment:file";
    case "system_api_error":   return "system:api_error";
    case "stop_hook":          return "system:stop_hook_summary";
    case "away_summary":       return "system:away_summary";
    default:                   return "unknown";
  }
}


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
import { FisheyeStrip } from "./fisheye-strip";
import type { FisheyeStatus } from "./fisheye-strip";
import type {
  AttributionTreeResult,
  SerializedNode,
  SegmentOrigin,
  JsonlEventKindObject,
} from "./attribution-tree-types";
import { SegmentedToggle } from "./shared/SegmentedToggle";
import { LinkIcon, SegmentView } from "./shared/EventUnitCard";
import { EVENT_PALETTES } from "./shared/eventPalette";
import type { IntervalEventKind } from "./drilldown-types";
import { useAttributionGraph } from "./attribution-graph-context";
import { sectionPalette, rolePalette, UNKNOWN_FILL as PALETTE_UNKNOWN_FILL, type RoleId } from "./lens-palette";
import { Check, Copy } from "lucide-react";
import { BRAND } from "./shared/brand";

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
        ...(node.cachePolicy && { cachePolicy: node.cachePolicy }),
        ...(node.ruleMeta && { ruleMeta: node.ruleMeta }),
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

      {/* Strip — getLabel 返回 shortSlot；命中 skill_listing 的 leaf 显示
          "Skills 注册" 友好标签。模块按段宽决定 inside / 隐藏。
          minCount=5 让 attribution leaves 天然开启鱼眼。 */}
      <FisheyeStrip<LeafItem>
        items={items}
        getColor={(it) => getColor ? getColor(it.leaf) : leafFill(it.leaf)}
        getUnderlineColor={getUnderlineColor ? (it) => getUnderlineColor(it.leaf) : undefined}
        getLabel={(it) => {
          const sl = it.leaf.origin.kind === "rule" ? it.leaf.origin.payload?.skillListing : undefined;
          return sl ? t("skillListing.title") : shortSlot(it.leaf.slotType);
        }}
        getTitle={(it) => {
          const sl = it.leaf.origin.kind === "rule" ? it.leaf.origin.payload?.skillListing : undefined;
          if (sl) {
            return `${t("skillListing.title")} · ${t("skillListing.rowSuffix", { count: sl.entries.length })} · ${fmtK(it.leaf.charCount)} chars`;
          }
          return `${shortSlot(it.leaf.slotType)} · ${fmtK(it.leaf.charCount)} chars · ${originLabel(it.leaf.origin)}`;
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
  const total = leaves.reduce((s, l) => s + l.charCount, 0);
  // 选中后只显示该 leaf 行，其他兄弟不再列出（避免与 SelectedDetail 重复信息）
  const visibleLeaves = selectedId ? leaves.filter((l) => l.nodeId === selectedId) : leaves;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
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
          : (rm?.displayName ?? shortSlot(l.slotType));
        const rowPreview = skillListing ? "" : (rm?.summary ?? l.preview);
        // 动态来源后缀（仅 dynamic 段）："summary ← 变的是 X"
        const previewSuffix = rm?.stability === "dynamic" && rm.dynamicSource ? ` ← ${rm.dynamicSource}` : "";
        const pct = skillListing && totalContextChars && totalContextChars > 0
          ? (l.charCount / totalContextChars) * 100
          : (total > 0 ? (l.charCount / total) * 100 : 0);
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
            <span style={{ fontSize: 10, color: "#9ca3af", minWidth: 60 }}>
              {skillListing && totalContextChars
                ? `占 context ${pct.toFixed(1)}%`
                : `${pct.toFixed(1)}%`}
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
  const [copied, setCopied] = useState(false);

  if (leaf.origin.kind !== "rule" || !leaf.origin.payload?.skillListing) return null;
  const sl = leaf.origin.payload.skillListing;
  const fullText = leaf.rawText ?? leaf.preview;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(fullText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

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

  const toggleBtnStyle = (active: boolean): React.CSSProperties => ({
    border: "1px solid #d1d5db",
    background: active ? BRAND.indigo700 : "#fff",
    color: active ? "#fff" : "#374151",
    padding: "1px 8px",
    fontSize: 11,
    fontWeight: 600,
    cursor: "pointer",
    lineHeight: 1.4,
    transition: "background 0.12s, color 0.12s",
  });

  return (
    <div style={{ paddingTop: 6, display: "flex", flexDirection: "column", gap: 8 }}>
      {/* 不再新增 meta 条 —— 直接复用上方 LeafTable 行作为标题 + 状态展示。
          metaText 仍用于 a11y / 调试，不渲染。 */}
      <span style={{ display: "none" }}>{metaText}</span>

      {/* Toggle 行：sub bar 下面，content 右上角；按钮收紧 padding/height */}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
        <div style={{ display: "inline-flex", borderRadius: 4, overflow: "hidden" }}>
          <button
            type="button"
            onClick={() => setMode("parsed")}
            style={{
              ...toggleBtnStyle(mode === "parsed"),
              borderRadius: "4px 0 0 4px",
            }}
          >
            {t("skillListing.toggleParsed")}
          </button>
          <button
            type="button"
            onClick={() => setMode("raw")}
            style={{
              ...toggleBtnStyle(mode === "raw"),
              borderLeft: "none",
              borderRadius: "0 4px 4px 0",
            }}
          >
            {t("skillListing.toggleRaw")}
          </button>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          style={{
            border: "1px solid",
            borderColor: copied ? "#16a34a" : "#d1d5db",
            background: copied ? "#dcfce7" : "#fff",
            color: copied ? "#15803d" : "#374151",
            padding: "1px 8px",
            fontSize: 11,
            fontWeight: 600,
            borderRadius: 4,
            cursor: "pointer",
            lineHeight: 1.4,
          }}
        >
          {copied ? t("skillListing.copied") : t("skillListing.copyRaw")}
        </button>
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
            maxHeight: 480,
            overflow: "auto",
            lineHeight: 1.55,
          }}
        >
          {fullText}
        </pre>
      )}
    </div>
  );
}

// ─── 叶子详情 ───────────────────────────────────────────────────────────────

export function SelectedDetail({ leaf, onLinkSource, totalContextChars }: {
  leaf: LeafLite;
  onLinkSource?: (sourceCallId: number, sourceTurnId?: number) => void;
  /** 总 context 字节数，用于在 skill_listing 等富展示中显示"占 context X%"。
   *  缺省时富展示只显示绝对字符数，不显示百分比。 */
  totalContextChars?: number;
}) {
  // Hooks 必须无条件调用——放在下面 skill_listing early-return 之前。
  // 否则 skillListing 分支会跳过这些 hook，违反 rules-of-hooks。
  const { t } = useTranslation();
  const { flashEvent, flashCall, flashToolUse } = useAttributionGraph();
  // copy 按钮的"已复制"短暂反馈状态。复制的内容是 rawText（完整原文）；
  // 仅当后端未带 rawText 时 fallback 到 preview（截断版）。
  const [copiedAt, setCopiedAt] = useState<number>(0);

  // 命中 skill_listing rule 时，走专属富展示，完全替换通用 leaf 详情布局。
  if (leaf.origin.kind === "rule" && leaf.origin.payload?.skillListing) {
    return <SkillListingDetail leaf={leaf} totalContextChars={totalContextChars} />;
  }

  // Back-link target: open the Turn view (onLinkSource), then scroll to a
  // landing point that depends on the leaf's underlying event kind:
  //
  //   • tool_use leaf — the "source" is the Call that *emitted* this
  //     tool_use. Landing = the Call card anchor (`#turn-N-call-K`), not
  //     a specific jsonl row. Multiple tool_uses can share the same jsonl
  //     line (assistant message), so a row-level scroll wouldn't pick
  //     this one out anyway.
  //
  //   • other jsonl leaves (tool_result / user_input / harness) — landing
  //     = the IntervalEventRow at `data-jsonl-line="${jsonlLineIdx}"`.
  //
  // jumpTarget prefers `firstSeenInCall` (the graph's "first-prompt" call)
  // over `sourceCallId` (the parser's call ownership) — for tool_result
  // these differ; for tool_use they coincide.
  const isCopied = copiedAt > 0 && Date.now() - copiedAt < 1500;
  const fullContent = leaf.rawText ?? leaf.preview;
  const isFullRaw = !!leaf.rawText;
  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(fullContent).then(
      () => {
        setCopiedAt(Date.now());
        setTimeout(() => setCopiedAt(0), 1500);
      },
      () => { /* clipboard API 不可用时静默 */ },
    );
  };
  const sourceTurnId = leaf.origin.kind === "jsonl" ? leaf.origin.sourceTurnId : undefined;
  const sourceCallId = leaf.origin.kind === "jsonl" ? leaf.origin.sourceCallId : undefined;
  const firstSeenInCall = leaf.origin.kind === "jsonl" ? leaf.origin.firstSeenInCall : undefined;
  const jsonlLineIdx = leaf.origin.kind === "jsonl" ? leaf.origin.jsonlLineIdx : undefined;
  // eventKind comes from server as `{ source, contentType }` but older
  // serializations / tests may carry just a string — handle both.
  const isToolUseLeaf = leaf.origin.kind === "jsonl" && (() => {
    const ek = leaf.origin.eventKind;
    if (typeof ek === "string") return ek === "tool_use";
    return ek?.source === "tool_use";
  })();
  const jumpTarget = firstSeenInCall ?? sourceCallId;
  const handleJumpSource = (jumpTarget !== undefined && onLinkSource)
    ? () => {
        onLinkSource(jumpTarget, sourceTurnId);
        // Defer past panel mount so the target node exists in the DOM
        // when we try to scroll to it.
        if (isToolUseLeaf) {
          // Prefer landing on the specific `ToolCallRow` keyed by
          // `data-tool-use-id` (more precise than just the call card).
          // Fall back to `flashCall` when wireMeta didn't carry a
          // toolUseId (e.g. older snapshots, structural rendering).
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

  // Flat detail: top one-line metadata row + content + dynamic fields.
  // Identity bits (color / kindLabel / title / shortId) come from the
  // shared mapper so this stays in sync with Turn/Response renderings.
  const { color, kindLabel, title, shortId } = leafOriginToCardHeader(leaf);
  const requestPath = leaf.jsonPath ? leaf.jsonPath.replace(/^reqBody\./, "") : undefined;
  const confidence =
    leaf.origin.kind === "rule" || leaf.origin.kind === "jsonl"
      ? leaf.origin.confidence
      : undefined;
  // `originSuffix` collects the secondary facts that follow the primary
  // identifier (kindLabel + the call/line coordinate, then confidence,
  // then size). Joined with " · " so the row stays a single inline strip.
  const originSuffixParts: string[] = [kindLabel.toLowerCase()];
  if (leaf.origin.kind === "jsonl") {
    originSuffixParts.push(`L${leaf.origin.jsonlLineIdx + 1}`);
  }
  if (confidence) originSuffixParts.push(confidence);
  originSuffixParts.push(`${leaf.charCount}b`);
  const originSuffix = originSuffixParts.join(" · ");

  // Always attempt to parse — `tryParseSegmentJson` gates on the first
  // non-whitespace char being `{` or `[`, so prose leaves return undefined
  // and stay text-only. This catches both the jsonl wire payloads (where
  // `origin.kind === "jsonl"`) AND rule-origin leaves whose rawText is a
  // JSON schema/blob (tools.* especially — its rawText is a serialized
  // tool definition that previously had no toggle because we only gated
  // on `origin.kind === "jsonl"`).
  const parsedRawJson = tryParseSegmentJson(leaf.rawText ?? leaf.preview);
  const hasJsonContent = parsedRawJson !== undefined;

  const jumpLabel = jumpTarget !== undefined
    ? t("terms.viewSourceCall", { callId: jumpTarget })
    : undefined;
  const jumpTooltip = jumpTarget !== undefined
    ? (isToolUseLeaf
        ? t("terms.jumpToCallCardTooltip", { callId: jumpTarget })
        : t("terms.jumpToCallLineTooltip", { callId: jumpTarget }))
    : undefined;

  return (
    <div style={{ paddingTop: 6, display: "flex", flexDirection: "column", gap: 8 }}>
      {/* Inline metadata strip — replaces the EventUnitCard shell so the
          info reads as a single header line, not a labeled META footer
          duplicated under a card with the same title in its header. */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        fontSize: 11, color: "#374151",
        paddingBottom: 6, borderBottom: "1px solid #e5e7eb",
        flexWrap: "wrap",
      }}>
        <span style={{
          width: 8, height: 8, borderRadius: 2,
          background: color, flexShrink: 0,
        }} />
        {requestPath && (
          <>
            <code style={{
              fontFamily: "ui-monospace, SFMono-Regular, monospace",
              fontSize: 11, color: "#111827", fontWeight: 600,
            }}>
              {requestPath}
            </code>
            <span style={{ color: "#d1d5db" }}>·</span>
          </>
        )}
        <span style={{
          fontFamily: "ui-monospace, SFMono-Regular, monospace",
          fontSize: 11, color: "#1f2937",
        }}>
          {title ?? "—"}
        </span>
        {shortId && (
          <>
            <span style={{ color: "#d1d5db" }}>·</span>
            <span style={{ color: "#6b7280", fontSize: 10 }}>{shortId}</span>
          </>
        )}
        <span style={{ color: "#d1d5db" }}>·</span>
        <span style={{ color: "#6b7280", fontSize: 10 }}>{originSuffix}</span>
        {/* copy 按钮：复制 leaf 的完整原文（rawText）。靠 marginLeft:auto 推到
            右端；如果还有 jump 按钮，jump 紧跟其后排在更右。 */}
        <button
          type="button"
          title={isFullRaw
            ? `复制原文（${fullContent.length.toLocaleString()} 字符）`
            : `复制（${fullContent.length.toLocaleString()} 字符 · 预览版，原文未提供）`}
          onClick={handleCopy}
          style={{
            marginLeft: "auto",
            display: "inline-flex", alignItems: "center", gap: 4,
            border: "1px solid",
            borderColor: isCopied ? "#16a34a" : "#d1d5db",
            background: isCopied ? "#dcfce7" : "#fff",
            color: isCopied ? "#15803d" : "#374151",
            borderRadius: 4, fontSize: 10, fontWeight: 600,
            padding: "2px 7px", cursor: "pointer", lineHeight: 1.3,
            flexShrink: 0, whiteSpace: "nowrap",
            transition: "background 0.12s, border-color 0.12s, color 0.12s",
          }}
        >
          {isCopied ? (
            <><Check size={10} strokeWidth={3} /> 已复制</>
          ) : (
            <><Copy size={10} /> 复制原文</>
          )}
        </button>
        {handleJumpSource && (
          <button
            type="button"
            title={jumpTooltip}
            onClick={(e) => { e.stopPropagation(); handleJumpSource(); }}
            className="hover:bg-indigo-700 transition-colors"
            style={{
              display: "inline-flex", alignItems: "center", gap: 5,
              border: "none", background: BRAND.indigo600, color: "#fff",
              borderRadius: 4, fontSize: 10, fontWeight: 700,
              padding: "3px 9px", cursor: "pointer", lineHeight: 1.3,
              flexShrink: 0, whiteSpace: "nowrap",
              transition: "background 0.12s",
              letterSpacing: "0.02em",
            }}
          >
            <LinkIcon />
            {jumpLabel ?? t("terms.jump", { defaultValue: "跳转" })}
          </button>
        )}
      </div>

      {/* Skill listing 专属渲染已由 SelectedDetail 顶部的 SkillListingDetail
          分支接管（命中 claude-code.messages.skill-listing.v1 时早 return），
          此处通用布局只处理其他 leaf 类型。 */}

      {/* Content — sole focus of the rest of the panel. JSON-parseable
          payloads start in tree mode (toggle to raw available); prose
          stays as a plain block. */}
      <SegmentView
        seg={{
          content: leaf.rawText ?? leaf.preview,
          monospace: leaf.origin.kind === "jsonl" || hasJsonContent,
          rawJson: parsedRawJson,
          defaultRaw: hasJsonContent,
        }}
      />

      {/* Rule origin's dynamic field injection trail — collapsible aside
          below the content. Orthogonal information, not part of the leaf
          identity, so it stays out of the header. */}
      {leaf.origin.kind === "rule" && leaf.origin.dynamicFields && leaf.origin.dynamicFields.length > 0 && (
        <details style={{ fontSize: 10 }}>
          <summary style={{ cursor: "pointer", color: BRAND.indigo500 }}>
            {leaf.origin.dynamicFields.length} dynamic field{leaf.origin.dynamicFields.length > 1 ? "s" : ""}
          </summary>
          <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 4, paddingLeft: 8 }}>
            {leaf.origin.dynamicFields.map((f, i) => (
              <div key={i} style={{ display: "flex", gap: 6, fontSize: 10 }}>
                <span style={{ fontFamily: "ui-monospace, monospace", color: BRAND.indigo700, minWidth: 100 }}>{f.name}</span>
                <span style={{ color: "#6b7280" }}>{f.source}</span>
                <span style={{ color: "#374151", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {f.valuePreview}
                </span>
              </div>
            ))}
          </div>
        </details>
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


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

import { useMemo, useState } from "react";
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
import { ImageLeafContent } from "./ImageLeafContent";
import { renderMarkdownWithHighlights } from "./leaf-detail/MarkdownHighlightCard";
import { DeferredToolsBody } from "./leaf-detail/DeferredToolsBody";
import { AgentTypesBody } from "./leaf-detail/AgentTypesBody";
import { SkillListingBody } from "./leaf-detail/SkillListingBody";
import { ToolDefinitionBody } from "./leaf-detail/ToolDefinitionBody";
import { tryParseSegmentJson } from "./leaf-detail/tool-format";
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
  category?: string;
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

// 展示分类单源：后端 deriveCategory 派生(server context-ledger/lens/derive-category)，前端只读。
// 旧本地 roleOf 全家(roleOf/ruleRoleOf/REMINDER_RULE_TO_ROLE/jsonlEventSource 等)已下沉后端删除。
// category 为 18 个有效 RoleId 之一；缺失(旧数据)兜底 other.unknown。
export function roleOf(leaf: { category?: string }): RoleId {
  return (leaf.category as RoleId) ?? "other.unknown";
}

export function fmtK(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1) + "k";
  return Math.round(n / 1000) + "k";
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
// tools 段叶子的 rawText 是完整 tool JSON；列表/标签里要展示其 description（直接展示
// JSON 不可读）。parse 失败回退 undefined（调用方再退回 preview）。
function toolDescriptionOf(leaf: LeafLite): string | undefined {
  const obj = tryParseSegmentJson(leaf.rawText ?? leaf.preview);
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    const d = (obj as Record<string, unknown>).description;
    if (typeof d === "string" && d.trim()) return d.trim();
  }
  return undefined;
}

// tools 段导览：行内用我们写的中文一句话(toolGuide.<ToolName>)替代晦涩英文原文,
// 与 rule 的 displayName/summary 同思路——导览层，不动真值。原文(wire description)一字
// 不动,仍在选中详情 + 行内 hover title。en 等未配该 key 的语言 fallbackLng:false → 回退原文。
export function toolGuideOf(leaf: { slotType?: string }): string | undefined {
  const slot = leaf.slotType ?? "";
  if (!slot.startsWith("tools.builtin.")) return undefined;
  const k = `toolGuide.${slot.slice("tools.builtin.".length)}`;
  return i18n.exists(k, { fallbackLng: false }) ? i18n.t(k) : undefined;
}

export function leafLabel(leaf: { slotType: string; rootSlotType?: string; ruleMeta?: { displayName?: string }; messageRole?: "user" | "assistant" | "system"; labelKey?: string; labelKeyBase?: string }): string {
  // 后端单源优先：rule.<labelKey> i18n(带版本，回退去版本 base)；中英切换在此生效。
  if (leaf.labelKey) {
    const k = `rule.${leaf.labelKey}.displayName`;
    if (i18n.exists(k)) return i18n.t(k);
    if (leaf.labelKeyBase) {
      const kb = `rule.${leaf.labelKeyBase}.displayName`;
      if (i18n.exists(kb)) return i18n.t(kb);
    }
  }
  const slotType = leaf.slotType;
  const rootSlotType = leaf.rootSlotType;
  if (slotType === "messages.tool-use" || slotType === "messages.tool_use") {
    return i18n.t("attribution.slots.messages.tool-use", { defaultValue: "工具调用" });
  }
  if (slotType === "messages.tool-result" || slotType === "messages.tool_result") {
    return i18n.t("attribution.slots.messages.tool-result", { defaultValue: "工具结果" });
  }
  if (slotType === "messages.thinking") {
    return i18n.t("attribution.slots.messages.thinking", { defaultValue: "AI思考" });
  }
  if (slotType === "messages.inline.free-text" || slotType === "messages.text") {
    if (rootSlotType === "messages.tool_result" || rootSlotType === "messages.tool-result") {
      return i18n.t("attribution.slots.messages.tool-result", { defaultValue: "工具结果" });
    }
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

// 段说明(description)，与 leafLabel 同源：rule.<labelKey>.summary i18n(带版本，回退去版本 base)。
// 标题(leafLabel.displayName) + 说明(leafSummary.summary) 都在 locales rule.<labelKeyBase> 一处，
// 改一处即双语生效。未命中 i18n 时回退后端 ruleMeta.summary，再回退 preview。
export function leafSummary(leaf: { labelKey?: string; labelKeyBase?: string; ruleMeta?: { summary?: string }; preview?: string }): string {
  if (leaf.labelKey) {
    const k = `rule.${leaf.labelKey}.summary`;
    if (i18n.exists(k)) return i18n.t(k);
    if (leaf.labelKeyBase) {
      const kb = `rule.${leaf.labelKeyBase}.summary`;
      if (i18n.exists(kb)) return i18n.t(kb);
    }
  }
  return leaf.ruleMeta?.summary ?? leaf.preview ?? "";
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
  charRange?: { start: number; end: number };
  visibility?: "default" | "rawOnly";
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
  // 单源展示分类/身份（来自 SerializedNode，后端 derive-category）。category→配色+分组；labelKey→i18n 文案。
  category?: string;
  group?: string;
  labelKey?: string;
  labelKeyBase?: string;
}

export function flattenLeaves(result: AttributionTreeResult): LeafLite[] {
  if (!result.snapshot) return [];
  const out: LeafLite[] = [];
  function visit(node: SerializedNode, rootSlot: string, sectionSlot: string | undefined) {
    // 经过 system section 级 slot 时，把它记下来下沉给后代叶子（classSlot）。
    const nextSection = isSystemSectionSlot(node.slotType) ? node.slotType : sectionSlot;
    if (node.children.length === 0) {
      if (node.visibility === "rawOnly") return;
      out.push({
        nodeId: node.id,
        slotType: node.slotType,
        rootSlotType: rootSlot,
        classSlot: nextSection ?? node.slotType,
        charCount: node.charCount,
        preview: node.preview,
        origin: node.origin,
        rawText: node.rawText,
        charRange: node.charRange,
        visibility: node.visibility,
        jsonPath: node.jsonPath,
        ...(node.wireMeta?.messageRole && { messageRole: node.wireMeta.messageRole }),
        ...(node.wireMeta?.toolUseId && { toolUseId: node.wireMeta.toolUseId }),
        ...(node.wireMeta?.toolName && { toolName: node.wireMeta.toolName }),
        ...(node.wireMeta?.thinkingSignature && { thinkingSignature: node.wireMeta.thinkingSignature }),
        ...(node.cachePolicy && { cachePolicy: node.cachePolicy }),
        ...(node.ruleMeta && { ruleMeta: node.ruleMeta }),
        ...(node.category && { category: node.category }),
        ...(node.group && { group: node.group }),
        ...(node.labelKey && { labelKey: node.labelKey }),
        ...(node.labelKeyBase && { labelKeyBase: node.labelKeyBase }),
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
  leafGroupId,
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
  /** 把连续叶子归入同一 envelope 分组（system-reminder 包裹）。返回 group id 或 null。
   *  用于在表内给同属一个 <system-reminder> 的连续行（壳+内容+壳，壳已是普通 leaf）画一道
   *  画在 padding 槽里的主题 rail——纯样式分组，不影响这些 leaf 进桶/筛选/点击。 */
  leafGroupId?: (leaf: LeafLite) => string | null;
}) {
  const { t } = useTranslation();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // hover envelope 组内任意行 → 点亮该组括号栏；壳默认是全屏最低强度的一根线。
  const [hoveredGroupId, setHoveredGroupId] = useState<string | null>(null);
  // 选中态下不再渲染孤立的选中行 bar —— meta 已由 SelectedDetailHeader 统一接管（更简洁，
  // 顺带去掉了"点选中行反选"的隐藏交互；反选仍可在上方 strip 再点同一段触发）。
  if (selectedId) return null;
  // 百分比口径恒定为「占整个 context」(全局分母),不随下钻/筛选变。分母优先用
  // totalContextChars(全局),仅在未传时退回 leaves 之和(理论上不发生)。这样任何
  // 视图下的 "X%" 都是"占整个 prompt 多少",消除"占筛选子集"的误读（旧逻辑 33.7%+66.3%=100%）。
  const denom = (totalContextChars && totalContextChars > 0)
    ? totalContextChars
    : leaves.reduce((s, l) => s + l.charCount, 0);
  // 未选中时列出该 section 下所有并列段；选中态已在上方 early-return，不会走到这里。
  const visibleLeaves = leaves;
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
      {(() => {
        const renderRow = (l: LeafLite) => {
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
        const isToolRow = sectionOf(l.rootSlotType) === "tools";
        // tools 段：行内一句话导览（toolGuideOf：我们写的中文解读;缺则回退英文原文 description）。
        // rawText 完整 JSON 不可读;完整原文保留在 hover title + 选中后下方 SelectedDetail。
        const toolDesc = isToolRow ? toolDescriptionOf(l) : undefined;
        const rowPreview = skillListing
          ? ""
          : isToolRow
            ? (isSel ? "" : (toolGuideOf(l) ?? toolDesc ?? l.preview))
            : leafSummary(l);
        // 动态段不再用文本后缀表征，改为整行浅黄高亮（见下方 background）一种表征即可。
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
              fontFamily: (skillListing || l.labelKey) ? undefined : "ui-monospace, SFMono-Regular, monospace",
              fontSize: 11,
              color: skillListing ? "#312e81" : "#111827",
              fontWeight: (skillListing || l.labelKey) ? 600 : undefined,
              minWidth: 150, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            }}>
              {rowLabel}
            </span>

            <span style={{ fontSize: 11, color: "#374151", minWidth: 50 }}>{fmtK(l.charCount)}</span>
            <span
              title={t("attribution.detail.ofContextTip", { defaultValue: "占整个请求上下文的比例（分母恒定 = 全部 context，不随筛选/下钻变化）" })}
              style={{ fontSize: 10, color: "#9ca3af", minWidth: 84, whiteSpace: "nowrap" }}
            >
              {t("attribution.detail.ofContext", { defaultValue: "占上下文" })} {pct.toFixed(1)}%
            </span>
            <span title={toolDesc} style={{ fontSize: 10, color: "#6b7280", flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {rowPreview}
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
        };
        // 把连续、同属一个 system-reminder envelope 的叶子合并成 run；run 顺序 = 原物理序，不重排。
        // 壳（<system-reminder>/</system-reminder>）现在是普通 leaf，跟内容一样在 run 里、由 renderRow
        // 渲染（进桶/可筛/可点，无特化）。
        const runs: Array<{ groupId: string | null; rows: LeafLite[] }> = [];
        for (const l of visibleLeaves) {
          const gid = leafGroupId ? leafGroupId(l) : null;
          const last = runs[runs.length - 1];
          if (last && last.groupId === gid) last.rows.push(l);
          else runs.push({ groupId: gid, rows: [l] });
        }
        return runs.map((run, ri) => {
          if (run.groupId === null) return run.rows.map(renderRow);
          const lit = hoveredGroupId === run.groupId;
          const railColor = lit ? "#cbd5e1" : "#e5e7eb";
          // 纯样式优化：把整组 <system-reminder>（壳+内容+壳，都是普通 leaf）用一道竖 rail 框在一起。
          // rail 绝对定位画在行左侧 padding 槽里（dot 之前的留白），不占布局、不推内容——组内行与
          // 未分组行严格左对齐。pointerEvents:none 不挡点选；hover 组内点亮 rail。
          return (
            <div
              key={`env-${run.groupId}-${ri}`}
              onMouseEnter={() => setHoveredGroupId(run.groupId)}
              onMouseLeave={() => setHoveredGroupId((cur) => (cur === run.groupId ? null : cur))}
              style={{ position: "relative", display: "flex", flexDirection: "column", gap: 1 }}
            >
              {run.rows.map(renderRow)}
              <div aria-hidden style={{
                position: "absolute", left: 2, top: 3, bottom: 3, width: 2,
                borderRadius: 2, background: railColor, pointerEvents: "none",
                transition: "background 0.1s",
              }} />
            </div>
          );
        });
      })()}
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


// MD 渲染 + 动态字段高亮已抽离为基础组件：./leaf-detail/MarkdownHighlightCard.tsx
// （renderMarkdownWithHighlights 函数 + MarkdownHighlightCard 组件，供内容型 leaf 复用）。

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

// 通用详情头（基建）：色点 + 段名 + 字节 + 占比 + i(归因元信息 tooltip) + 原文切换/复制 + 跳源。
// 全局复用：SelectedDetail dispatcher 对所有 leaf（含 leaf-detail/*Body 特化体）统一在顶部渲染它，
// 结构一致，下面各自接特化 body。取代了选中态下 LeafTable 那条孤立 meta bar（更紧凑）。
// 每个 leaf 的差异（是否可切原文、复制什么、能否跳源、色点色）通过 props 注入，组件本身通用。
export function SelectedDetailHeader({
  leaf, color, totalContextChars,
  rawMode, hasRawToggle, onToggleRawMode, textToCopy,
  onJumpSource, jumpLabel, jumpTooltip,
}: {
  leaf: LeafLite;
  color?: string;
  totalContextChars?: number;
  rawMode: boolean;
  hasRawToggle: boolean;
  onToggleRawMode: () => void;
  textToCopy: string | (() => string);
  onJumpSource?: () => void;
  jumpLabel?: string;
  jumpTooltip?: string;
}) {
  const { t } = useTranslation();
  const { kindLabel, title } = leafOriginToCardHeader(leaf);
  const requestPath = leaf.jsonPath ? leaf.jsonPath.replace(/^reqBody\./, "") : undefined;
  const confidence =
    leaf.origin.kind === "rule" || leaf.origin.kind === "jsonl"
      ? leaf.origin.confidence
      : undefined;
  const originSuffixParts: string[] = [kindLabel.toLowerCase()];
  if (leaf.origin.kind === "jsonl") originSuffixParts.push(`L${leaf.origin.jsonlLineIdx + 1}`);
  if (confidence) originSuffixParts.push(confidence);
  originSuffixParts.push(`${leaf.charCount}b`);
  const originSuffix = originSuffixParts.join(" · ");

  const pct = totalContextChars && totalContextChars > 0
    ? ((leaf.charCount / totalContextChars) * 100).toFixed(1)
    : null;
  const hasDisplayName = !!leaf.labelKey; // 命中 corpus 段身份=有导览名(走 rule i18n)，与 leafLabel 同源

  const btnBase: React.CSSProperties = {
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 4,
    height: 24, padding: "0 8px", fontSize: 10, fontWeight: 600, borderRadius: 4,
    whiteSpace: "nowrap", boxSizing: "border-box", lineHeight: 1, transition: "all 0.12s ease",
  };
  const infoBtnStyle: React.CSSProperties = {
    ...btnBase, padding: "0 6px", border: "1px solid #e5e7eb",
    background: "#fff", color: "#9ca3af", cursor: "help",
  };
  const jumpBtnStyle: React.CSSProperties = {
    ...btnBase, cursor: "pointer", border: "1px solid #c7d2fe",
    background: "#e0e7ff", color: BRAND.indigo600,
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {/* 左：色点 + 段名 + 字节 + 占比 */}
      <span style={{ width: 8, height: 8, borderRadius: 2, background: color ?? leafFill(leaf), flexShrink: 0 }} />
      <span style={{
        fontFamily: hasDisplayName ? undefined : "ui-monospace, SFMono-Regular, monospace",
        fontSize: 12.5, fontWeight: 600, color: "#111827",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0,
      }}>
        {leafLabel(leaf)}
      </span>
      <span style={{ fontSize: 11.5, color: "#374151", flexShrink: 0 }}>{fmtK(leaf.charCount)}</span>
      {pct && (
        <span
          title={t("attribution.detail.ofContextTip", { defaultValue: "占整个请求上下文的比例" })}
          style={{ fontSize: 10.5, color: "#9ca3af", whiteSpace: "nowrap", flexShrink: 0 }}
        >
          {t("attribution.detail.ofContext", { defaultValue: "占上下文" })} {pct}%
        </span>
      )}
      {/* 撑开，把操作推到最右 */}
      <span style={{ flex: 1 }} />
      {/* 右：i(归因元信息) + 原文切换/复制 + 跳源 */}
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
        onToggleRawMode={onToggleRawMode}
        textToCopy={textToCopy}
      />
      {onJumpSource && (
        <button
          type="button"
          title={jumpTooltip}
          onClick={(e) => { e.stopPropagation(); onJumpSource(); }}
          className="hover:bg-indigo-100 transition-colors"
          style={jumpBtnStyle}
        >
          <LinkIcon />
          {jumpLabel ?? t("terms.jump")}
        </button>
      )}
    </div>
  );
}

// ─── 叶子详情 ───────────────────────────────────────────────────────────────

export function SelectedDetail({ leaf, onLinkSource, totalContextChars, color }: {
  leaf: LeafLite;
  onLinkSource?: (sourceCallId: number, sourceTurnId?: number) => void;
  /** 总 context 字节数，用于在 header / 富展示中显示"占 context X%"。 */
  totalContextChars?: number;
  /** 选中段色点颜色（lens 模式由上游传 lens 色；缺省回退 section 色 leafFill）。 */
  color?: string;
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
  // 用户输入正文（leafLabel 同一判定 → "用户输入"）。排除 tool_result 根下拆出的
  // free-text（那是工具结果）。不加这条会落到 <SegmentView> fallback：mono 灰底
  // + 自带第二个复制按钮，与本面板其它文本卡（AI输出/注入）不一致。
  const isUserTextLeaf =
    (leaf.slotType === "messages.text" || leaf.slotType === "messages.inline.free-text") &&
    leaf.messageRole === "user" &&
    leaf.rootSlotType !== "messages.tool_result" && leaf.rootSlotType !== "messages.tool-result";
  const isImageLeaf = leaf.slotType === "messages.block.image";
  // 特化富展示判定（skill listing / 延迟工具 / agent 类型 / tool 定义）：命中则走"统一头 + 各自 body"。
  const skillListing = leaf.origin.kind === "rule" ? leaf.origin.payload?.skillListing : undefined;
  const isDeferredListing = leaf.origin.kind === "rule" && /deferred-tools-listing\.v[12]$/.test(leaf.origin.ruleId);
  const isAgentListing = leaf.origin.kind === "rule" && /agent-types-listing\.v[12]$/.test(leaf.origin.ruleId);
  // 注意 startsWith：覆盖 userContext reminder 拆出的所有子段（.wrapper.prefix/.suffix /
  // .project-instructions / .global-instructions / .memory / .account），让它们统一走
  // SelectedDetailHeader + 高亮 MD 卡，而不是落到 <SegmentView> fallback（那条自带重复复制按钮）。
  const isInjectionLeaf = leaf.slotType.startsWith("messages.inline.system-reminder") || leaf.slotType === "messages.system-message";
  const hasRawToggle = isSystemLeaf || isToolLeaf || isAssistantTextLeaf || isUserTextLeaf || isThinkingLeaf || isToolUseLeaf || isToolResultLeaf || isImageLeaf || isInjectionLeaf || !!skillListing || isDeferredListing || isAgentListing;

  const rawTextContent = useMemo(() => {
    if (isAssistantTextLeaf || isUserTextLeaf) {
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
  }, [leaf, isAssistantTextLeaf, isUserTextLeaf, isThinkingLeaf, isToolUseLeaf, isToolResultLeaf]);

  // 特化富展示：统一头（下方 SelectedDetailHeader）+ 各自 body。body 只渲染内容、接 rawMode
  // 决定 parsed/raw，不渲染头（避免 body 反向 import SelectedDetailHeader 成循环依赖）。
  //   skillListing → 技能名/描述网格；延迟工具 → CC defer / MCP(按 server) 分组；
  //   agent 类型 → 表格（类型/用途/工具）；tools 段（rawText=完整 tool JSON）→ tool 定义。
  const specialBody = skillListing
    ? <SkillListingBody leaf={leaf} rawMode={rawMode} />
    : isDeferredListing
    ? <DeferredToolsBody leaf={leaf} rawMode={rawMode} />
    : isAgentListing
    ? <AgentTypesBody leaf={leaf} rawMode={rawMode} />
    : isToolLeaf
    ? <ToolDefinitionBody leaf={leaf} rawMode={rawMode} />
    : null;

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
    // tool 叶子（ToolDefinitionBody）：始终复制美化后的 tool JSON，与抽离前一致。
    if (isToolLeaf) {
      const obj = tryParseSegmentJson(leaf.rawText ?? leaf.preview);
      if (obj && typeof obj === "object") return JSON.stringify(obj, null, 2);
      return leaf.rawText ?? leaf.preview;
    }
    if (rawMode) {
      return rawTextContent;
    }
    return leaf.rawText ?? leaf.preview;
  };

  return (
    <div style={{ paddingTop: 6, display: "flex", flexDirection: "column", gap: 8 }}>
      <SelectedDetailHeader
        leaf={leaf}
        color={color}
        totalContextChars={totalContextChars}
        rawMode={rawMode}
        hasRawToggle={hasRawToggle}
        onToggleRawMode={() => setRawMode(v => !v)}
        textToCopy={textToCopy}
        onJumpSource={handleJumpSource}
        jumpLabel={jumpLabel}
        jumpTooltip={jumpTooltip}
      />



      {/* 内容主体：特化类型走 specialBody（自带 parsed/raw 切换）；否则按 rawMode / leaf 类型渲染 */}
      {specialBody ? specialBody : rawMode ? (() => {
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
      })() : isSystemLeaf || isInjectionLeaf ? (
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
      ) : isUserTextLeaf ? (
        // 用户输入：同壳不同体 —— 外壳与 AI输出/注入卡一致，正文逐字 pre-wrap 而非
        // markdown（与 TurnCard 用户气泡同惯例）。用户文本未授权 markdown 重排：粘贴的
        // JSON/代码/缩进会被并段折行；compaction summary 可达 10-30k，限高滚动。
        <div style={{
          fontSize: 12, color: "#1f2937", lineHeight: 1.6,
          border: "1px solid #e5e7eb", borderRadius: 6, background: "#fff",
          padding: "8px 12px",
          whiteSpace: "pre-wrap", wordBreak: "break-word",
          maxHeight: 480, overflow: "auto",
        }}>
          {contentText}
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
        <ImageLeafContent leaf={leaf} />
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

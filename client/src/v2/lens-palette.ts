// Lens 配色 / 纹理统一表 —— 所有 lens、SectionBar、FisheyeStrip 共用的颜色
// 都从这里取，不要在组件里写裸 hex。
//
// 设计契约（用户最终采用的方案 A）：
//   - 类别底色（provenance）是唯一染色源。leaf 的底色永远来自 provenance 分桶。
//   - Diff 不染色，只叠加"对比形状"纹理（黑斜纹 + 不同密度/角度）。在任意
//     底色上都能读出。
//   - Cache 不改 bar 底色（已经在拓扑条 / hover 覆盖里表达）。
//   - Audit 仍有桶色，但 Audit lens 仅 DEV 下启用，prod 用户看不到。
//
// 任何 lens 加桶、改色，都改这一个文件。

// ─── Provenance：按内容来源分类的类别色 ───────────────────────────────────────
export const provenancePalette = {
  systemPrompt:    "#475569", // 灰蓝/石板灰 — 系统提示词
  userInput:       "#6d28d9", // 紫色     — 用户输入
  toolUse:         "#8b5cf6", // 紫色     — 工具调用
  toolResult:      "#c4b5fd", // 浅紫     — 工具结果
  claudeThinking:  "#7c3aed", // 紫罗兰   — AI 思考
  claudeText:      "#a78bfa", // 淡紫     — AI 回复
  fileAttachment:  "#c026d3", // 洋红     — 文件附件
  commandOutput:   "#6b7280", // 灰色     — 命令输出
  harnessInject:   "#ea580c", // 橙色     — Skill / 事件/注入
  unknown:         "#9ca3af", // 灰       — 未识别
} as const;

// ─── Diff：仅 badge / pill 用；不再用于 bar 染色（bar 上叠纹理表达） ────────
export const diffPalette = {
  added:    "#16a34a", // 新增（pill 小色点用绿，便于一眼分辨）
  modified: "#f59e0b", // 修改（pill 小色点用黄）
  removed:  "#dc2626", // 删除（pill 小色点 + Prev bar 红块）
  kept:     "#9ca3af", // 未变
} as const;

// ─── Diff underline 色（方案 C：bar 下方 3px 色条） ─────────────────────────
export const diffUnderlineColors = {
  added:    "#16a34a", // 绿
  modified: "#eab308", // 黄
  removed:  "#dc2626", // 红
} as const;

/** 给定 diffKind 返回 underline 色条颜色；kept / 无 diff → null。 */
export function diffUnderlineFor(
  kind: "added" | "modified" | "removed" | "kept" | undefined | null,
): string | null {
  if (kind === "added")    return diffUnderlineColors.added;
  if (kind === "modified") return diffUnderlineColors.modified;
  if (kind === "removed")  return diffUnderlineColors.removed;
  return null;
}

// ─── Cache：lens pill 用色，不参与 bar 染色 ────────────────────────────────
export const cachePalette = {
  ttl5m:    "#10b981",
  ttl1h:    "#14b8a6",
  notCached:"#9ca3af",
} as const;

// ─── Audit：dev-only lens 的色 ─────────────────────────────────────────────
export const auditPalette = {
  full:    "#10b981",
  partial: "#f59e0b",
  none:    "#9ca3af",
} as const;

// ─── Section 框（主 bar 三段容器的边框 / 选中态边框） ───────────────────────
export const sectionFrame = {
  border: "#e5e7eb",
  borderSelected: "#6b7280",
} as const;

// ─── SectionBar（System / Tools / Messages / Other 的容器条样式） ────────────
export interface SectionStyle {
  label: string;
  barBg: string;
  barText: string;
  rowBg: string;
  marker: string;
  textColor: string;
  // Options for advanced visual encoding (Option C)
  borderStyle?: string;
  indicatorLine?: "top" | "left" | null;
  texture?: "stripes" | "dots" | "none" | null;
}

export const sectionPalette: Record<"system" | "tools" | "messages" | "other", SectionStyle> = {
  system:   { label: "System",   barBg: "#475569", barText: "#fff",    rowBg: "#f8fafc", marker: "#475569", textColor: "#334155" },
  tools:    { label: "Tools",    barBg: "#2563eb", barText: "#fff",    rowBg: "#eff6ff", marker: "#2563eb", textColor: "#1e40af" },
  messages: { label: "Messages", barBg: "#7c3aed", barText: "#fff",    rowBg: "#f5f3ff", marker: "#7c3aed", textColor: "#5b21b6" },
  other:    { label: "Other",    barBg: "#6b7280", barText: "#374151", rowBg: "#fafafa", marker: "#9ca3af", textColor: "#374151" },
};

export const rolePalette: Record<RoleId, SectionStyle> = {
  "system.core":        { label: "身份·框架", barBg: "#334155", barText: "#fff", rowBg: "#f1f5f9", marker: "#334155", textColor: "#334155" },
  "system.guidance":    { label: "行为准则", barBg: "#475569", barText: "#fff", rowBg: "#f1f5f9", marker: "#475569", textColor: "#475569" },
  "system.tool-policy": { label: "工具策略", barBg: "#64748b", barText: "#fff", rowBg: "#f1f5f9", marker: "#64748b", textColor: "#64748b" },
  "system.memory":      { label: "记忆指令", barBg: "#115e59", barText: "#fff", rowBg: "#f0fdfa", marker: "#115e59", textColor: "#115e59" },
  "system.env":         { label: "环境事实", barBg: "#0d9488", barText: "#fff", rowBg: "#f0fdfa", marker: "#0d9488", textColor: "#0d9488" },
  "system.billing":     { label: "计费头",   barBg: "#94a3b8", barText: "#fff", rowBg: "#f8fafc", marker: "#94a3b8", textColor: "#94a3b8" },
  "tools.builtin":      { label: "内置工具", barBg: "#1d4ed8", barText: "#fff", rowBg: "#eff6ff", marker: "#1d4ed8", textColor: "#1d4ed8" },
  "messages.context":    { label: "注入·上下文", barBg: "#2dd4bf", barText: "#fff", rowBg: "#f0fdfa", marker: "#0d9488", textColor: "#0f766e" },
  "messages.skills":     { label: "注入·能力", barBg: "#3b82f6", barText: "#fff", rowBg: "#eff6ff", marker: "#2563eb", textColor: "#1d4ed8" },
  "messages.directive":  { label: "注入·指令", barBg: "#94a3b8", barText: "#fff", rowBg: "#f8fafc", marker: "#94a3b8", textColor: "#475569" },
  "messages.injection":  { label: "注入·事件", barBg: "#ea580c", barText: "#fff", rowBg: "#fff7ed", marker: "#ea580c", textColor: "#c2410c" },
  "messages.human":      { label: "用户输入", barBg: "#6d28d9", barText: "#fff", rowBg: "#f5f3ff", marker: "#6d28d9", textColor: "#6d28d9" },
  "messages.image":      { label: "图片输入", barBg: "#6d28d9", barText: "#fff", rowBg: "#f5f3ff", marker: "#6d28d9", textColor: "#6d28d9" },
  "messages.thinking":   { label: "思考",     barBg: "#7c3aed", barText: "#fff", rowBg: "#f5f3ff", marker: "#7c3aed", textColor: "#7c3aed", indicatorLine: "top" },
  "messages.assistant":  { label: "AI 回复",   barBg: "#a78bfa", barText: "#fff", rowBg: "#f5f3ff", marker: "#a78bfa", textColor: "#a78bfa" },
  "messages.tool-use":   { label: "工具调用", barBg: "#8b5cf6", barText: "#fff", rowBg: "#f5f3ff", marker: "#8b5cf6", textColor: "#7c3aed", indicatorLine: "left" },
  "messages.tool-result":{ label: "工具结果", barBg: "#f3e8ff", barText: "#1f2937", rowBg: "#f5f3ff", marker: "#c4b5fd", textColor: "#7c3aed", borderStyle: "1px solid #c4b5fd", texture: "stripes" },
  "messages.misc":       { label: "其他",     barBg: "#6b7280", barText: "#374151", rowBg: "#fafafa", marker: "#6b7280", textColor: "#6b7280" },
  "other.unknown":      { label: "未识别",   barBg: "#9ca3af", barText: "#374151", rowBg: "#fafafa", marker: "#9ca3af", textColor: "#9ca3af" },
};

/** 未识别 leaf 的 fallback 填充。 */
export const UNKNOWN_FILL = provenancePalette.unknown;

// ─── L2 语义角色（RoleId）：attribution 面板三级模型的中间层 ──────────────────
export type RoleId =
  | "system.core"
  | "system.guidance"
  | "system.tool-policy"
  | "system.memory"
  | "system.env"
  | "system.billing"
  | "tools.builtin"
  | "messages.context"
  | "messages.skills"
  | "messages.directive"
  | "messages.injection"
  | "messages.human"
  | "messages.thinking"
  | "messages.assistant"
  | "messages.tool-use"
  | "messages.tool-result"
  | "messages.image"
  | "messages.misc"
  | "other.unknown";

// ─── L0 意图分组（IntentGroupId）：把 19 个 RoleId 聚合到 5 个本质类别 ──────────
export type IntentGroupId =
  | "instructions"
  | "environment"
  | "capabilities"
  | "events"
  | "interaction";

export const intentGroupPalette: Record<IntentGroupId, { color: string }> = {
  instructions:         { color: "#475569" }, // 灰蓝/石板灰
  environment:          { color: "#0d9488" }, // 松石绿
  capabilities:         { color: "#2563eb" }, // 皇家蓝
  events:               { color: "#ea580c" }, // 警告橙
  interaction:          { color: "#7c3aed" }, // 紫罗兰
};

/** i18n key 前缀 —— 配合 useTranslation().t() 取 label / description。
 *  例:t(`${intentGroupI18nKey(g)}.label`) → "系统指令" / "System Prompts" */
export function intentGroupI18nKey(g: IntentGroupId): string {
  return `attribution.lensGroup.${g}`;
}

// 静态 role→group 映射。
export const ROLE_TO_GROUP: Record<RoleId, IntentGroupId> = {
  // ── instructions
  "system.core":         "instructions",
  "system.guidance":     "instructions",
  "system.tool-policy":  "instructions",
  "messages.directive":  "instructions",

  // ── environment
  "system.memory":       "environment",
  "system.env":          "environment",
  "system.billing":      "environment",
  "messages.context":    "environment",

  // ── capabilities
  "tools.builtin":       "capabilities",
  "messages.skills":     "capabilities",

  // ── events
  "messages.injection":  "events",

  // ── interaction
  "messages.human":      "interaction",
  "messages.thinking":   "interaction",
  "messages.assistant":  "interaction",
  "messages.image":      "interaction",
  "messages.tool-use":   "interaction",
  "messages.tool-result":"interaction",
  "messages.misc":       "interaction",
  "other.unknown":       "interaction",
};

// 模块加载期自检：保证未来加新 RoleId 时编译报错；以及 ROLE_TO_GROUP 不遗漏。
{
  const allRoles: RoleId[] = [
    "system.core", "system.guidance", "system.tool-policy", "system.memory",
    "system.env", "system.billing", "tools.builtin", "messages.context",
    "messages.skills", "messages.directive", "messages.injection",
    "messages.human", "messages.thinking", "messages.assistant",
    "messages.tool-use", "messages.tool-result", "messages.image",
    "messages.misc", "other.unknown",
  ];
  for (const r of allRoles) {
    if (!(r in ROLE_TO_GROUP)) {
      throw new Error(`[lens-palette] ROLE_TO_GROUP 漏映射 RoleId="${r}"`);
    }
  }
}

// group 在 pill 行中的视觉顺序（左 → 右）。冷色轨在前，暖色轨在后。
export const INTENT_GROUP_ORDER: IntentGroupId[] = [
  "instructions",
  "environment",
  "capabilities",
  "events",
  "interaction",
];

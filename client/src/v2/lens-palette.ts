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
  systemPrompt:    "#9a9a95", // 中性灰 — 系统提示词
  userInput:       "#5fad6b", // 绿     — 用户输入
  toolUse:         "#2f9db7", // 青蓝   — 工具调用
  toolResult:      "#d99a2b", // 琥珀   — 工具结果
  claudeThinking:  "#9a67e8", // 紫     — AI 思考
  claudeText:      "#e88472", // 珊瑚   — AI 回复
  fileAttachment:  "#49a7a2", // 青绿   — 文件附件
  commandOutput:   "#8f98a6", // 灰蓝   — 命令输出
  harnessInject:   "#c4b18c", // 暖灰   — 动态注入
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
  system:   { label: "System",   barBg: "#9a9a95", barText: "#1f2937", rowBg: "#f8f8f5", marker: "#9a9a95", textColor: "#5f5f5a" },
  tools:    { label: "Tools",    barBg: "#5f84e7", barText: "#1f2937", rowBg: "#eef4ff", marker: "#5f84e7", textColor: "#3158b3" },
  messages: { label: "Messages", barBg: "#9a67e8", barText: "#1f2937", rowBg: "#f5efff", marker: "#9a67e8", textColor: "#6942b8" },
  other:    { label: "Other",    barBg: "#c4b18c", barText: "#374151", rowBg: "#fbf7ee", marker: "#c4b18c", textColor: "#76684d" },
};

// rolePalette：三层显著度（图底分离）。色相=类别，饱和/明度="该不该扫"：
//   前景·会话流（饱和抢眼）：AI思考/工具调用/工具结果/AI回复/用户输入/图片 —— 随会话增长、你真正在扫的。
//   中景·上下文内容（柔和）：系统提示词/CLAUDE.md/记忆/账号 —— 一次性但是"内容"。
//   背景·脚手架（柔和有色，不洗成灰）：内置Tool/工具发现/Agent/Skills/动态注入·system-reminder壳 ——
//   都比会话弱，但保持有色有辨识度，绝不压到像未选中/dimmed 的灰（marker 略深以便淡条下仍见圆点）。
export const rolePalette: Record<RoleId, SectionStyle> = {
  // ── 中景·柔和：系统提示词
  "system.core":        { label: "系统提示词", barBg: "#8b94a3", barText: "#1f2937", rowBg: "#f1f3f6", marker: "#8b94a3", textColor: "#515a68" },
  "system.guidance":    { label: "系统提示词", barBg: "#8b94a3", barText: "#1f2937", rowBg: "#f1f3f6", marker: "#8b94a3", textColor: "#515a68" },
  "system.tool-policy": { label: "系统提示词", barBg: "#8b94a3", barText: "#1f2937", rowBg: "#f1f3f6", marker: "#8b94a3", textColor: "#515a68" },
  "system.memory":      { label: "系统提示词", barBg: "#8b94a3", barText: "#1f2937", rowBg: "#f1f3f6", marker: "#8b94a3", textColor: "#515a68" },
  "system.env":         { label: "系统提示词", barBg: "#8b94a3", barText: "#1f2937", rowBg: "#f1f3f6", marker: "#8b94a3", textColor: "#515a68" },
  "system.billing":     { label: "系统提示词", barBg: "#8b94a3", barText: "#1f2937", rowBg: "#f1f3f6", marker: "#8b94a3", textColor: "#515a68" },
  // ── 背景·脚手架：内置 Tool 定义
  "tools.builtin":      { label: "内置 Tool", barBg: "#a6bfe4", barText: "#1f2937", rowBg: "#eef3fc", marker: "#a6bfe4", textColor: "#3d5a8a" },
  // ── 中景·柔和：上下文内容（CLAUDE.md / 记忆 / 账号）
  "messages.context":            { label: "用户上下文", barBg: "#cda867", barText: "#1f2937", rowBg: "#fbf4e6", marker: "#cda867", textColor: "#856326" },
  "messages.context.claude-md":  { label: "CLAUDE.md", barBg: "#8fb3da", barText: "#1f2937", rowBg: "#eff4fb", marker: "#8fb3da", textColor: "#3f6ea3" },
  "messages.context.memory":     { label: "记忆", barBg: "#d3ab63", barText: "#1f2937", rowBg: "#fbf4e4", marker: "#d3ab63", textColor: "#8a6526" },
  "messages.context.account":    { label: "账号与日期", barBg: "#a9b0bd", barText: "#1f2937", rowBg: "#f2f3f6", marker: "#a9b0bd", textColor: "#5f6573" },
  // ── 背景·脚手架：工具发现 / Agent 类型 / Skills（不再亮黄）
  "messages.capability.discovery": { label: "工具发现", barBg: "#bcb0dd", barText: "#1f2937", rowBg: "#f3effa", marker: "#bcb0dd", textColor: "#5d4f86" },
  "messages.capability.agent":   { label: "Agent 类型", barBg: "#aebce8", barText: "#1f2937", rowBg: "#eff2fc", marker: "#aebce8", textColor: "#45578f" },
  "messages.skills":             { label: "Skills", barBg: "#d4c189", barText: "#1f2937", rowBg: "#fbf5e6", marker: "#d4c189", textColor: "#8a6e2a" },
  // ── 背景·脚手架：动态注入 / system-reminder 壳（弱化但仍有辨识度，不能淡到像未选中/dimmed 的灰）
  "messages.directive":          { label: "动态注入", barBg: "#d3c197", barText: "#1f2937", rowBg: "#faf6ec", marker: "#c0ad7f", textColor: "#7c6e4a" },
  "messages.injection":          { label: "动态注入", barBg: "#d3c197", barText: "#1f2937", rowBg: "#faf6ec", marker: "#c0ad7f", textColor: "#7c6e4a" },
  // ── 前景·会话流（饱和、抢眼；白字）
  "messages.human":      { label: "用户输入", barBg: "#16a34a", barText: "#ffffff", rowBg: "#e9f7ee", marker: "#16a34a", textColor: "#15803d" },
  "messages.image":      { label: "图片输入", barBg: "#db2777", barText: "#ffffff", rowBg: "#fceef4", marker: "#db2777", textColor: "#a21555" },
  "messages.thinking":   { label: "AI 思考", barBg: "#7c3aed", barText: "#ffffff", rowBg: "#f3effe", marker: "#7c3aed", textColor: "#5b21b6", indicatorLine: "top" },
  "messages.assistant":  { label: "AI 回复", barBg: "#e85d4a", barText: "#ffffff", rowBg: "#fdeeeb", marker: "#e85d4a", textColor: "#b93d2c" },
  "messages.tool-use":   { label: "工具调用", barBg: "#2563eb", barText: "#ffffff", rowBg: "#eef2fe", marker: "#2563eb", textColor: "#1d4ed8", indicatorLine: "left" },
  "messages.tool-result":{ label: "工具结果", barBg: "#0d9488", barText: "#ffffff", rowBg: "#e7f7f4", marker: "#0d9488", textColor: "#0f766e", borderStyle: "1px solid #0d9488", texture: "stripes" },
  // ── 背景·脚手架：其他 / 未识别
  "messages.misc":       { label: "其他消息", barBg: "#cfc9ba", barText: "#374151", rowBg: "#f8f6f1", marker: "#b3ac9b", textColor: "#6f6a59" },
  "other.unknown":       { label: "未识别", barBg: "#d6d6d2", barText: "#6b7280", rowBg: "#fafafa", marker: "#bdbdb8", textColor: "#6f6f6b" },
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
  | "messages.context.claude-md"
  | "messages.context.memory"
  | "messages.context.account"
  | "messages.capability.discovery"
  | "messages.capability.agent"
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
  instructions:         { color: "#6b7280" }, // 顶部筛选 chip 只做导航，不承载语义配色
  environment:          { color: "#6b7280" },
  capabilities:         { color: "#6b7280" },
  events:               { color: "#6b7280" },
  interaction:          { color: "#6b7280" },
};

/** i18n key 前缀 —— 配合 useTranslation().t() 取 label / description。
 *  例:t(`${intentGroupI18nKey(g)}.label`) → "系统提示词" / "System Prompt" */
export function intentGroupI18nKey(g: IntentGroupId): string {
  return `attribution.lensGroup.${g}`;
}

// 静态 role→group 映射。
export const ROLE_TO_GROUP: Record<RoleId, IntentGroupId> = {
  // ── instructions
  "system.core":         "instructions",
  "system.guidance":     "instructions",
  "system.tool-policy":  "instructions",
  "system.memory":       "instructions",
  "system.env":          "instructions",
  "system.billing":      "instructions",

  // ── environment
  "messages.context":    "environment",
  "messages.context.claude-md": "environment",
  "messages.context.memory":    "environment",
  "messages.context.account":   "environment",

  // ── capabilities
  "tools.builtin":       "capabilities",
  "messages.capability.discovery": "capabilities",
  "messages.capability.agent":     "capabilities",
  "messages.skills":     "capabilities",

  // ── interaction
  "messages.directive":  "interaction",
  "messages.injection":  "interaction",
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
    "messages.context.claude-md", "messages.context.memory", "messages.context.account",
    "messages.capability.discovery", "messages.capability.agent",
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

// group 在 pill 行中的视觉顺序（左 → 右）。大类只承担筛选导航，语义颜色下沉到 role/segment。
export const INTENT_GROUP_ORDER: IntentGroupId[] = [
  "capabilities",
  "instructions",
  "environment",
  "interaction",
  "events",
];

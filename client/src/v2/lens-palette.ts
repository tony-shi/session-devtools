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
//
// 调色板约束（来自 diff lens 共存设计）：
//   - 严格回避 绿 / 黄 / 橙 / 红 四个色相，让出给 diff 纹理（add 绿 / modify 黄 /
//     remove 红）使用，避免 diff 纹理叠在同色底色上读不出。
//   - 仅使用 蓝 / 青 / 靛 / 紫 / 淡紫 / 粉 / 洋红 / 灰 这几个色相。
//   - 高频类别（工具调用 / 工具结果 / AI 回复 / 系统提示词）相互拉开色相距离。
//
// 旧值（含绿/黄/橙的版本）保留在 git history 里。

export const provenancePalette = {
  systemPrompt:    "#3b82f6", // 蓝       — 系统提示词
  userInput:       "#0891b2", // 深青     — 用户输入（原绿色 #10b981）
  toolUse:         "#6366f1", // 靛蓝     — 工具调用（原黄色 #f59e0b）
  toolResult:      "#ec4899", // 粉红     — 工具结果
  claudeThinking:  "#8b5cf6", // 紫       — AI 思考
  claudeText:      "#a78bfa", // 淡紫     — AI 回复（原青色，避免和深青用户输入打架）
  fileAttachment:  "#c026d3", // 洋红     — 文件附件
  commandOutput:   "#0ea5e9", // 天蓝     — 命令输出（原橙色 #f97316）
  harnessInject:   "#64748b", // 灰蓝     — Skill / 摘要
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
//
// 当前主用方案。bar 本体完全不动 / 不污染 provenance 底色；diff kind 通过
// bar 下方 3px 实色色条表达。
//
// 颜色饱和度足够高（实色 alpha=1），3px 厚度在窄段下仍能识别。

export const diffUnderlineColors = {
  added:    "#16a34a", // 绿
  modified: "#eab308", // 黄（用更纯的黄，避免和橙色 commandOutput-天蓝邻近混淆）
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
//
// 故意用中性灰，避免和 (1) provenance 类别色 (2) diff underline 色 (3) cache
// 桶色 任何一个撞色 —— 框只是"分组容器"的语义提示，不该和"内容色"竞争注意力。

export const sectionFrame = {
  /** 默认 section 框边线（细，弱对比）。 */
  border: "#e5e7eb",
  /** 选中态 section 框边线（明显但仍中性）。 */
  borderSelected: "#6b7280",
} as const;

// ─── SectionBar（System / Tools / Messages / Other 的容器条样式） ────────────
//
// 不是 lens 配色，但同样集中管理在这里，避免散落到多个组件里写裸 hex。

export interface SectionStyle {
  label: string;
  barBg: string;
  barText: string;
  rowBg: string;
  marker: string;
  textColor: string;
}

export const sectionPalette: Record<"system" | "tools" | "messages" | "other", SectionStyle> = {
  // system 改靛蓝族（原浅蓝 #bfdbfe 与 tools 蓝撞色）；diff/cache/walkthrough 一并受益。
  system:   { label: "System",   barBg: "#6366f1", barText: "#fff",    rowBg: "#eef2ff", marker: "#4f46e5", textColor: "#3730a3" },
  tools:    { label: "Tools",    barBg: "#3b82f6", barText: "#fff",    rowBg: "#eff6ff", marker: "#2563eb", textColor: "#1e40af" },
  messages: { label: "Messages", barBg: "#a78bfa", barText: "#fff",    rowBg: "#f5f3ff", marker: "#8b5cf6", textColor: "#5b21b6" },
  other:    { label: "Other",    barBg: "#d1d5db", barText: "#374151", rowBg: "#fafafa", marker: "#9ca3af", textColor: "#374151" },
};

// ─── rolePalette（L2 语义角色配色）：attribution 面板三级模型用 ─────────────────
//
// 颜色族标 L1（regionOf）：system=冷色(靛/青/teal/灰)、messages=暖色(紫/粉/洋红/暖灰)、
// tools=蓝、other=灰。严格落在允许色相(蓝/青/靛/紫/淡紫/粉/洋红/灰)内，回避绿/黄/橙/红
// （让给 diff 纹理）。injection 用洋红 #c026d3（醒目且不撞 diff 黄下划线）。
export const rolePalette: Record<RoleId, SectionStyle> = {
  "system.core":        { label: "Core",       barBg: "#6366f1", barText: "#fff", rowBg: "#eef2ff", marker: "#4f46e5", textColor: "#3730a3" },
  "system.tool-policy": { label: "Tool policy", barBg: "#06b6d4", barText: "#fff", rowBg: "#ecfeff", marker: "#0891b2", textColor: "#155e75" },
  "system.env":         { label: "Env·git",    barBg: "#14b8a6", barText: "#fff", rowBg: "#f0fdfa", marker: "#0d9488", textColor: "#115e59" },
  "system.billing":     { label: "Billing",    barBg: "#94a3b8", barText: "#fff", rowBg: "#f8fafc", marker: "#64748b", textColor: "#334155" },
  // 对话族（紫）：human / thinking / assistant —— 按明度区分。
  "messages.human":      { label: "Human",       barBg: "#a78bfa", barText: "#fff", rowBg: "#f5f3ff", marker: "#8b5cf6", textColor: "#5b21b6" },
  "messages.thinking":   { label: "Thinking",    barBg: "#7c3aed", barText: "#fff", rowBg: "#f5f3ff", marker: "#6d28d9", textColor: "#5b21b6" },
  "messages.assistant":  { label: "Assistant",   barBg: "#8b5cf6", barText: "#fff", rowBg: "#f5f3ff", marker: "#7c3aed", textColor: "#5b21b6" },
  // 工具 I/O 族（粉）：tool-use / tool-result —— 对齐 provenance 的 工具调用/工具结果。
  "messages.tool-use":   { label: "Tool call",   barBg: "#f472b6", barText: "#fff", rowBg: "#fdf2f8", marker: "#ec4899", textColor: "#9d174d" },
  "messages.tool-result":{ label: "Tool result", barBg: "#ec4899", barText: "#fff", rowBg: "#fdf2f8", marker: "#db2777", textColor: "#9d174d" },
  // Image（多模态用户输入）单列：group=conversation，用靛紫与对话文本族（human/assistant）拉开。
  "messages.image":      { label: "Image",       barBg: "#818cf8", barText: "#fff", rowBg: "#eef2ff", marker: "#6366f1", textColor: "#3730a3" },
  // Harness 族（品红/洋红）：injection / skills。
  "messages.injection":  { label: "Injection",   barBg: "#c026d3", barText: "#fff", rowBg: "#fdf4ff", marker: "#a21caf", textColor: "#86198f" },
  // Skills 机制:专门识别的 skill_listing 注入,单列一类（与通用 injection 区分）。
  "messages.skills":     { label: "Skills",      barBg: "#e879f9", barText: "#fff", rowBg: "#fdf4ff", marker: "#d946ef", textColor: "#86198f" },
  // reminder 子类（harness 注入的元内容，非对话本体）。色跟 group 走而非 messages 暖色族：
  //   messages.context  → environment（青，= 注入的上下文/能力声明：memory / user-context / deferred-tools / agent-types）
  //   messages.directive→ instructions（靛蓝，= 注入的行为指令：thinking-frequency）
  "messages.context":    { label: "Context inj", barBg: "#0891b2", barText: "#fff", rowBg: "#ecfeff", marker: "#0e7490", textColor: "#155e75" },
  "messages.directive":  { label: "Directive",   barBg: "#4f46e5", barText: "#fff", rowBg: "#eef2ff", marker: "#4338ca", textColor: "#3730a3" },
  "messages.misc":       { label: "Msg misc",    barBg: "#a8a29e", barText: "#fff", rowBg: "#fafaf9", marker: "#78716c", textColor: "#44403c" },
  "tools.builtin":      { label: "Tools",      barBg: "#3b82f6", barText: "#fff", rowBg: "#eff6ff", marker: "#2563eb", textColor: "#1e40af" },
  "other.unknown":      { label: "Other",      barBg: "#d1d5db", barText: "#374151", rowBg: "#fafafa", marker: "#9ca3af", textColor: "#374151" },
};

/** 未识别 leaf 的 fallback 填充。 */
export const UNKNOWN_FILL = provenancePalette.unknown;

// ─── L2 语义角色（RoleId）：attribution 面板三级模型的中间层 ──────────────────
//
// 三级模型：L1 物理区(RegionId == sectionPalette 的 4 键) / L2 语义角色(RoleId) /
// L3 明细(slotType / origin.ruleId)。RoleId 前缀编码 L1（regionOf = 取 "." 前缀），
// 故 region 不另立类型，复用 SectionId。rolePalette（每个 role 的色）在 Step5 加。
export type RoleId =
  | "system.core"
  | "system.tool-policy"
  | "system.env"
  | "system.billing"
  | "messages.human"
  | "messages.thinking"
  | "messages.assistant"
  | "messages.tool-use"
  | "messages.tool-result"
  | "messages.image"
  | "messages.injection"
  | "messages.skills"
  | "messages.context"
  | "messages.directive"
  | "messages.misc"
  | "tools.builtin"
  | "other.unknown";

// ─── L0 意图分组（IntentGroupId）：把 17 个 RoleId 聚合到 5 个本质类别 ──────────
//
// 设计原则（本质维度，无歧义）：每个 group 有一句客观的判定准则，不依赖动机解释。
//   - instructions  「系统提示词」                      — 静态行为规则
//   - environment   「系统提醒与环境」                   — 动态系统环境状态与运行时框架提醒
//   - agent-loop    「代理与工具执行」                   — 动态的 Agent 内部思考与外部工具调用循环
//   - user-input    「用户输入与文件」                   — 用户显式输入的内容与执行命令
//   - capabilities  「能力与拓展」                      — 拓展链路上关于“工具/技能”的静态定义

export type IntentGroupId =
  | "instructions"
  | "environment"
  | "agent-loop"
  | "user-input"
  | "capabilities";

// group 颜色与 rolePalette 同族色相协调，但比每个 role 的精确色更深/浓一档，
// 作为 pill 行"分组标签"显示时与 pill 本身的细分色区分。
// 文案不在这里——走 i18n（attribution.lensGroup.<id>.{label,description}）。
export const intentGroupPalette: Record<IntentGroupId, { color: string }> = {
  instructions: { color: "#4f46e5" }, // 靛蓝
  environment:  { color: "#0891b2" }, // 青色
  "agent-loop":  { color: "#7c3aed" }, // 紫色
  "user-input": { color: "#0284c7" }, // 天蓝
  capabilities: { color: "#c026d3" }, // 洋红
};

/** i18n key 前缀 —— 配合 useTranslation().t() 取 label / description。
 *  例:t(`${intentGroupI18nKey(g)}.label`) → "行为指令" / "Instructions" */
export function intentGroupI18nKey(g: IntentGroupId): string {
  return `attribution.lensGroup.${g}`;
}

// 静态 role→group 映射。
export const ROLE_TO_GROUP: Record<RoleId, IntentGroupId> = {
  // ── Instructions（系统提示词）
  "system.core":         "instructions",  // identity / intro / # Doing tasks / # Tone & style / 各种行为段
  "system.tool-policy":  "instructions",  // # Using your tools
  "messages.directive":  "instructions",  // thinking-frequency 等"注入的行为指引"

  // ── Environment（系统环境与提醒）
  "system.env":          "environment",   // # Environment / gitStatus
  "system.billing":      "environment",   // billing header
  "messages.context":    "environment",   // reminder 注入的上下文/能力：memory / user-context / deferred-tools / agent-types
  "messages.injection":  "environment",   // injection 临时通知
  "other.unknown":       "environment",   // 未识别的 slot

  // ── Agent Loop（代理与工具执行）
  "messages.thinking":   "agent-loop",
  "messages.assistant":  "agent-loop",
  "messages.tool-use":   "agent-loop",
  "messages.tool-result":"agent-loop",

  // ── User Input（用户输入与文件）
  "messages.human":      "user-input",
  "messages.image":      "user-input",
  "messages.misc":       "user-input",    // 命令输出等

  // ── Capabilities（能力与拓展）
  "tools.builtin":       "capabilities",  // 工具 schema 是"模型可用的能力"
  "messages.skills":     "capabilities",  // skill_listing 是"可用 skill"声明
};

// 模块加载期自检：保证未来加新 RoleId 时编译报错；以及 ROLE_TO_GROUP 不遗漏。
// (TypeScript 的 Record 强制要求所有 RoleId 键存在，这一行作为运行时双保险。)
{
  const allRoles: RoleId[] = [
    "system.core", "system.tool-policy", "system.env", "system.billing",
    "messages.human", "messages.thinking", "messages.assistant",
    "messages.tool-use", "messages.tool-result", "messages.image",
    "messages.injection", "messages.skills", "messages.context", "messages.directive", "messages.misc",
    "tools.builtin", "other.unknown",
  ];
  for (const r of allRoles) {
    if (!(r in ROLE_TO_GROUP)) {
      throw new Error(`[lens-palette] ROLE_TO_GROUP 漏映射 RoleId="${r}"`);
    }
  }
}

// group 在 pill 行中的视觉顺序（左 → 右）。同 group 内的 pills 紧贴，不同 group 间留间隔。
export const INTENT_GROUP_ORDER: IntentGroupId[] = [
  "instructions",
  "environment",
  "agent-loop",
  "user-input",
  "capabilities",
];

// 单源展示分类（后端单点 derive，前端只读 —— 同 authorship/coverageState 的定位）。
//
// 移植自前端 client/src/v2/AttributionTreePanel.tsx 的 roleOf 全家 + lens-palette.ts 的
// RoleId/ROLE_TO_GROUP。两处历史分类逻辑收敛到后端单源（见 tmp/single-source-design.md）。
// 与前端的差异（已决策）：
//   1. 删 6 个死值 RoleId（roleOf/ruleRoleOf 从不产出）：
//      system.{guidance,tool-policy,memory,env,billing} + messages.directive。
//   2. REMINDER_RULE_TO_ROLE 的 key 从完整 ruleId 改为 labelKeyBase（去版本），
//      根治 v1/v2 漏映射（修复 user-context.v2 等被误归 injection）。
import type { SegmentNode } from "../parser/types";

type SegmentOrigin = SegmentNode["origin"];
type RuleOrigin = Extract<SegmentOrigin, { kind: "rule" }>;
type DynField = NonNullable<RuleOrigin["dynamicFields"]>[number];

// ── L2 语义角色（18 个有效值；已删 6 死值）──────────────────────────────────────
export type RoleId =
  | "system.core"
  | "tools.builtin"
  | "messages.context"
  | "messages.context.claude-md"
  | "messages.context.memory"
  | "messages.context.account"
  | "messages.capability.discovery"
  | "messages.capability.agent"
  | "messages.skills"
  | "messages.injection"
  | "messages.human"
  | "messages.thinking"
  | "messages.assistant"
  | "messages.tool-use"
  | "messages.tool-result"
  | "messages.image"
  | "messages.misc"
  | "other.unknown";

// ── L0 意图分组（与前端 lens-palette 一致；events 当前无 role 映射，保留供未来）──
export type IntentGroupId = "instructions" | "environment" | "capabilities" | "events" | "interaction";

// ── labelKey 派生（身份轴）──────────────────────────────────────────────────────
const stripVersion = (k: string) => k.replace(/[.\-]v\d+$/, "");
const shortKey = (ruleId: string) => ruleId.replace(/^claude-code\./, "");
const labelKeyBaseOf = (ruleId: string) => stripVersion(shortKey(ruleId));

/** 段身份：仅命中 corpus rule 的节点有。labelKey 带版本（i18n 文案锚），base 去版本（回退锚）。 */
export function deriveLabelKeys(origin: SegmentOrigin): { labelKey?: string; labelKeyBase?: string } {
  if (origin.kind !== "rule" || !origin.ruleId.startsWith("claude-code.")) return {};
  const labelKey = shortKey(origin.ruleId);
  return { labelKey, labelKeyBase: stripVersion(labelKey) };
}

// ── category 派生（移植 roleOf 全家）────────────────────────────────────────────
/** 系统 section 级 slot：把 section 信息从顶层 root 下沉给后代叶子（classSlot）。 */
export function isSystemSectionSlot(slotType: string): boolean {
  return (
    slotType.startsWith("system.main-prompt.section.") ||
    slotType === "system.main-prompt-block" ||
    slotType === "system.identity" ||
    slotType === "system.billing"
  );
}

const dynamicFieldValue = (o: RuleOrigin, name: string) => o.dynamicFields?.find((f: DynField) => f.name === name)?.valuePreview ?? "";
function legacyMemoryContentsRole(o: RuleOrigin): RoleId {
  const hint = `${dynamicFieldValue(o, "memoryPath")} ${dynamicFieldValue(o, "path")}`.toLowerCase();
  if (hint.includes("claude.md") || hint.includes("agents.md")) return "messages.context.claude-md";
  if (hint.includes("memory.md") || hint.includes("auto-memory") || hint.includes("memory")) return "messages.context.memory";
  return "messages.context";
}

// system-reminder / role:"system" message 的注入内容 → 展示 role。
// key = labelKeyBase（去版本），v1/v2 自动共享，避免版本漏映射。
type RuleRoleResolver = RoleId | ((o: RuleOrigin) => RoleId);
const REMINDER_RULE_TO_ROLE: Record<string, RuleRoleResolver> = {
  "messages.memory-contents": legacyMemoryContentsRole,
  "messages.nested-memory-contents": legacyMemoryContentsRole,
  "messages.reminder.project-instructions": "messages.context.claude-md",
  "messages.reminder.global-instructions": "messages.context.claude-md",
  "messages.reminder.memory": "messages.context.memory",
  "messages.user-context": "messages.context", // v1+v2 共享（修复 v2 此前落 injection）
  "messages.reminder.account": "messages.context.account",
  "messages.deferred-tools-listing": "messages.capability.discovery",
  "messages.agent-types-listing": "messages.capability.agent",
  "messages.skill-listing": "messages.skills",
  "messages.reminder.wrapper-prefix": "messages.injection",
  "messages.reminder.wrapper-suffix": "messages.injection",
  "messages.thinking-frequency": "messages.injection",
};
function ruleRoleOf(origin: RuleOrigin): RoleId | undefined {
  const r = REMINDER_RULE_TO_ROLE[labelKeyBaseOf(origin.ruleId)];
  return r === undefined ? undefined : typeof r === "function" ? r(origin) : r;
}
const jsonlEventSource = (o?: SegmentOrigin): string | undefined =>
  o?.kind !== "jsonl" ? undefined : typeof o.eventKind === "string" ? o.eventKind : o.eventKind.source;

export interface CategoryInput {
  /** system 取 section 级祖先（已下沉）/ messages·tools 取叶子自身 slotType。 */
  classSlot: string;
  rootSlotType: string;
  messageRole?: "user" | "assistant" | "system";
  origin: SegmentOrigin;
}

export function deriveCategory(leaf: CategoryInput): RoleId {
  const { classSlot, rootSlotType, messageRole, origin } = leaf;
  if (origin.kind === "rule" && labelKeyBaseOf(origin.ruleId) === "messages.skill-listing") return "messages.skills";
  if (classSlot.startsWith("messages.inline.system-reminder")) {
    if (origin.kind === "rule") { const s = ruleRoleOf(origin); if (s) return s; }
    return "messages.injection";
  }
  if (classSlot === "messages.system-message") {
    if (origin.kind === "rule") { const s = ruleRoleOf(origin); if (s) return s; }
    return "messages.injection";
  }
  if (classSlot.startsWith("system.") || classSlot === "side-query.system") return "system.core";
  if (classSlot.startsWith("tools.") || rootSlotType.startsWith("tools.")) return "tools.builtin";
  if (classSlot === "messages.thinking" || rootSlotType === "messages.thinking") return "messages.thinking";
  if (rootSlotType === "messages.tool_use") return "messages.tool-use";
  if (rootSlotType === "messages.tool_result") return "messages.tool-result";
  if (classSlot === "messages.block.image" || classSlot === "messages.inline.image-placeholder") return "messages.image";
  if (classSlot === "messages.inline.local-command") return "messages.misc";
  const src = jsonlEventSource(origin);
  if (src === "user_input") return "messages.human";
  if (src === "assistant_text") return "messages.assistant";
  if (src === "thinking") return "messages.thinking";
  if (src === "tool_use") return "messages.tool-use";
  if (src === "tool_result") return "messages.tool-result";
  if (src === "attachment") return "messages.image";
  if (src === "system_local_command") return "messages.misc";
  if (src === "harness_injection") return "messages.injection";
  if (messageRole === "assistant") return "messages.assistant";
  if (messageRole === "user") return "messages.human";
  if (rootSlotType.startsWith("messages.") || rootSlotType === "side-query.user") return "messages.misc";
  return "other.unknown";
}

// ── group 派生（静态 role→group；18 项，无死值；events 当前无映射）──────────────
const ROLE_TO_GROUP: Record<RoleId, IntentGroupId> = {
  "system.core": "instructions",
  "messages.context": "environment",
  "messages.context.claude-md": "environment",
  "messages.context.memory": "environment",
  "messages.context.account": "environment",
  "tools.builtin": "capabilities",
  "messages.capability.discovery": "capabilities",
  "messages.capability.agent": "capabilities",
  "messages.skills": "capabilities",
  "messages.injection": "interaction",
  "messages.human": "interaction",
  "messages.thinking": "interaction",
  "messages.assistant": "interaction",
  "messages.tool-use": "interaction",
  "messages.tool-result": "interaction",
  "messages.image": "interaction",
  "messages.misc": "interaction",
  "other.unknown": "interaction",
};
export function deriveGroup(category: RoleId): IntentGroupId {
  return ROLE_TO_GROUP[category];
}

/** serializeNode 一次性派生全部单源展示字段。容器节点也算（前端按需用）。 */
export function deriveLensFields(node: SegmentNode, rootSlotType: string, classSlot: string): {
  category: RoleId;
  group: IntentGroupId;
  labelKey?: string;
  labelKeyBase?: string;
} {
  const category = deriveCategory({ classSlot, rootSlotType, messageRole: node.wireMeta?.messageRole, origin: node.origin });
  return { category, group: deriveGroup(category), ...deriveLabelKeys(node.origin) };
}

// rule-corpus/axes.ts
//
// 正交分类轴 v2 的派生兜底。未在 .md frontmatter 声明 semantic/source 的 rule,
// 由 slotId(+ ruleId 多路)自动推出轴值。声明值优先,本模块仅兜底。
//
// 设计:旁路模块,不被现有链路 import 时无副作用。迁移期与 category/mechanism 并存;
// 待全部 rule 显式声明 semantic/source 后,本派生表可逐步退役。
//
// 轴:
//   semantic = { kind: 6 大类, detail?: 细分 }   —— 取代 category(语义部分)
//   source   = 作者归属(7 值)                    —— 统一 DynamicFieldSource
//   sourceBucket(source) = 3 个用户向桶(harness/user/session)

import type { SemanticKind, SourceValue } from "./schema";

export interface Axes {
  kind: SemanticKind;
  detail?: string;
  source: SourceValue;
}

export type SourceBucket = "harness" | "user" | "session";

/** 7 值 source → 3 个用户向桶(CC自带 / 你配置 / 会话产生)。 */
export function sourceBucket(s: SourceValue): SourceBucket {
  if (s === "user-config") return "user";
  if (s === "user-input" || s === "model" || s === "tool" || s === "protocol") return "session";
  return "harness"; // cc-static / cc-runtime
}

// system.main-prompt.section.<slug> → 轴
const SECTION_AXES: Record<string, Axes> = {
  prelude:             { kind: "directive", detail: "style",        source: "cc-static" },
  harness:             { kind: "directive", detail: "harness",      source: "cc-static" },
  "using-tools":       { kind: "directive", detail: "tool-policy",  source: "cc-static" },
  "tone-style":        { kind: "directive", detail: "style",        source: "cc-static" },
  "text-output":       { kind: "directive", detail: "style",        source: "cc-static" },
  "output-efficiency": { kind: "directive", detail: "style",        source: "cc-static" },
  "doing-tasks":       { kind: "directive", detail: "style",        source: "cc-static" },
  actions:             { kind: "directive", detail: "safety",       source: "cc-static" },
  language:            { kind: "directive", detail: "style",        source: "cc-static" },
  system:              { kind: "directive", detail: "system",       source: "cc-static" },
  "session-guidance":  { kind: "directive", detail: "session",      source: "cc-static" },
  "context-management":{ kind: "directive", detail: "context-mgmt", source: "cc-static" },
  memory:              { kind: "directive", detail: "memory-guide", source: "cc-static" }, // # Memory = 写法指南
  "auto-memory":       { kind: "directive", detail: "memory-guide", source: "cc-static" },
  environment:         { kind: "context",   detail: "environment",  source: "cc-runtime" },
  context:             { kind: "context",   detail: "git",          source: "cc-runtime" }, // gitStatus
};

// messages.inline.system-reminder / messages.system-message:按 ruleId 关键词多路
function reminderAxes(ruleId: string): Axes {
  if (ruleId.includes("user-context"))       return { kind: "context",    detail: "project+memory", source: "user-config" };
  if (ruleId.includes("memory-contents"))    return { kind: "context",    detail: "memory",         source: "user-config" };
  if (ruleId.includes("deferred-tools"))     return { kind: "capability", detail: "deferred-tool",  source: "cc-runtime" };
  if (ruleId.includes("agent-types"))        return { kind: "capability", detail: "agent-type",     source: "cc-runtime" };
  if (ruleId.includes("skill-listing"))      return { kind: "capability", detail: "skill",          source: "cc-runtime" };
  if (ruleId.includes("thinking-frequency")) return { kind: "directive",  detail: "thinking",       source: "cc-static" };
  return { kind: "meta", detail: "reminder", source: "cc-runtime" }; // token-usage / file-* / diagnostics / catch-all
}

/**
 * deriveAxes:由 slotId(+ ruleId)派生轴值兜底。声明值优先,调用方负责"声明 ?? derive"。
 */
export function deriveAxes(slotId: string, ruleId: string): Axes {
  // tools
  if (slotId === "tools.builtin" || slotId.startsWith("tools.")) {
    const isMcp = ruleId.toLowerCase().includes("mcp");
    return {
      kind: "capability",
      detail: isMcp ? "mcp-tool" : "builtin-tool",
      source: isMcp ? "user-config" : "cc-static",
    };
  }
  // system
  if (slotId === "system.billing") return { kind: "meta", detail: "billing", source: "cc-runtime" };
  if (slotId === "system.identity") return { kind: "identity", source: "cc-static" };
  if (slotId.startsWith("system.main-prompt.section.")) {
    const slug = slotId.slice("system.main-prompt.section.".length);
    return SECTION_AXES[slug] ?? { kind: "directive", source: "cc-static" };
  }
  if (slotId.startsWith("system.") || slotId.startsWith("side-query.system")) {
    return { kind: "directive", source: "cc-static" };
  }
  // messages: userContext reminder 的来源子段(splitUserContextReminder 产出)
  if (slotId === "messages.inline.system-reminder.wrapper.prefix" || slotId === "messages.inline.system-reminder.wrapper.suffix")
    return { kind: "meta", detail: "system-reminder-wrapper", source: "cc-static" };
  if (slotId === "messages.inline.system-reminder.preamble")
    return { kind: "directive", detail: "claudemd-preamble", source: "cc-static" };
  if (slotId === "messages.inline.system-reminder.project-instructions")
    return { kind: "context", detail: "project-instructions", source: "user-config" };
  if (slotId === "messages.inline.system-reminder.memory")
    return { kind: "context", detail: "memory", source: "user-config" };
  if (slotId === "messages.inline.system-reminder.account")
    return { kind: "meta", detail: "account", source: "cc-runtime" };
  // messages
  if (slotId === "messages.inline.system-reminder" || slotId === "messages.system-message") {
    return reminderAxes(ruleId);
  }
  if (slotId === "messages.inline.local-command") return { kind: "dialogue", detail: "command-echo", source: "user-input" };
  if (slotId === "messages.inline.free-text" || slotId === "messages.user_input" || slotId === "messages.text") {
    return { kind: "dialogue", detail: "user-input", source: "user-input" };
  }
  if (slotId === "messages.tool_use")    return { kind: "dialogue", detail: "tool-call",   source: "model" };
  if (slotId === "messages.tool_result") return { kind: "dialogue", detail: "tool-result", source: "tool" };
  if (slotId === "messages.thinking")    return { kind: "dialogue", detail: "thinking",    source: "model" };
  if (slotId.startsWith("messages.block.image") || slotId.includes("image-placeholder")) {
    return { kind: "dialogue", detail: "image", source: "user-input" };
  }
  if (slotId.startsWith("messages.")) return { kind: "dialogue", source: "model" };
  if (slotId.startsWith("side-query")) return { kind: "meta", detail: "side-query", source: "cc-runtime" };
  return { kind: "meta", source: "cc-runtime" }; // 最终兜底
}

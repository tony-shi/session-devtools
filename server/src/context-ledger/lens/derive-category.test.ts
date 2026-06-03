import { describe, it, expect } from "vitest";
import { deriveCategory, deriveLabelKeys, deriveGroup } from "./derive-category.ts";
import { GENERATED_RULES } from "../rule-corpus/_generated.ts";

const rule = (ruleId: string) => ({ kind: "rule", ruleId, matchMode: "regex", confidence: "definitive", fullyCovered: true }) as never;
const jsonl = (source: string) => ({ kind: "jsonl", eventKind: { source }, jsonlLineIdx: 0, confidence: "definitive", fullyCovered: true }) as never;
const structural = () => ({ kind: "structural", slotId: "x", reason: "no_rule_matched" }) as never;
const SR = "messages.inline.system-reminder";

describe("deriveCategory — 结构/对话映射", () => {
  it("system.* → system.core（system 内部细分已折叠）", () => {
    expect(deriveCategory({ classSlot: "system.main-prompt.section.environment", rootSlotType: "system.main-prompt-block", origin: rule("claude-code.system-prompt-environment.v1") })).toBe("system.core");
    expect(deriveCategory({ classSlot: "system.identity", rootSlotType: "system.identity", origin: rule("claude-code.system-prompt-identity.v1") })).toBe("system.core");
  });
  it("tools.* → tools.builtin", () => {
    expect(deriveCategory({ classSlot: "tools.builtin.Read", rootSlotType: "tools.builtin.Read", origin: structural() })).toBe("tools.builtin");
  });
  it("jsonl 对话源 → 对应 role", () => {
    expect(deriveCategory({ classSlot: "messages.text", rootSlotType: "messages.user", origin: jsonl("user_input") })).toBe("messages.human");
    expect(deriveCategory({ classSlot: "messages.text", rootSlotType: "messages.assistant", origin: jsonl("assistant_text") })).toBe("messages.assistant");
    expect(deriveCategory({ classSlot: "messages.tool_use", rootSlotType: "messages.tool_use", origin: jsonl("tool_use") })).toBe("messages.tool-use");
    expect(deriveCategory({ classSlot: "messages.tool_result", rootSlotType: "messages.tool_result", origin: jsonl("tool_result") })).toBe("messages.tool-result");
  });
});

describe("deriveCategory — labelKeyBase 改造（版本无关，修复 v2 漏映射）", () => {
  it("user-context v1 与 v2 都归 messages.context（此前 v2 错落 injection）", () => {
    for (const v of ["v1", "v2"]) {
      expect(deriveCategory({ classSlot: SR, rootSlotType: SR, origin: rule(`claude-code.messages.user-context.${v}`) })).toBe("messages.context");
    }
  });
  it("skill-listing / deferred-tools / agent-types 的 v1 与 v2 分类一致", () => {
    const pairs: Array<[string, string]> = [
      ["messages.skill-listing", "messages.skills"],
      ["messages.deferred-tools-listing", "messages.capability.discovery"],
      ["messages.agent-types-listing", "messages.capability.agent"],
    ];
    for (const [base, expected] of pairs) {
      for (const v of ["v1", "v2"]) {
        expect(deriveCategory({ classSlot: SR, rootSlotType: SR, origin: rule(`claude-code.${base}.${v}`) })).toBe(expected);
      }
    }
  });
});

describe("deriveLabelKeys", () => {
  it("corpus rule → labelKey(带版本) + base(去版本)", () => {
    expect(deriveLabelKeys(rule("claude-code.system-prompt-session-guidance.v2"))).toEqual({ labelKey: "system-prompt-session-guidance.v2", labelKeyBase: "system-prompt-session-guidance" });
  });
  it("wire rule / jsonl / 非 corpus → 空（无身份）", () => {
    expect(deriveLabelKeys(rule("wire.tools.builtin"))).toEqual({});
    expect(deriveLabelKeys(jsonl("user_input"))).toEqual({});
  });
});

describe("deriveGroup", () => {
  it("category → group", () => {
    expect(deriveGroup("system.core")).toBe("instructions");
    expect(deriveGroup("messages.context")).toBe("environment");
    expect(deriveGroup("tools.builtin")).toBe("capabilities");
    expect(deriveGroup("messages.human")).toBe("interaction");
  });
});

describe("corpus 契约（防回归）", () => {
  const shortKey = (id: string) => id.replace(/^claude-code\./, "");
  const stripV = (s: string) => s.replace(/[.\-]v\d+$/, "");
  const slotsOf = (r: { slotId: string | string[] }) => (Array.isArray(r.slotId) ? r.slotId : [r.slotId]);

  it("同 family(去版本) displayName 零冲突（保护 labelKey 体系）", () => {
    const byBase = new Map<string, Set<string>>();
    for (const r of GENERATED_RULES) {
      if (!r.displayName) continue;
      const b = stripV(shortKey(r.ruleId));
      (byBase.get(b) ?? byBase.set(b, new Set()).get(b)!).add(r.displayName);
    }
    const conflicts = [...byBase.entries()].filter(([, s]) => s.size > 1).map(([b]) => b);
    expect(conflicts, `displayName 冲突的 family: ${conflicts.join(", ")}`).toEqual([]);
  });

  it("注入类 corpus rule 都被分类，不掉 other.unknown（防新版本漏映射）", () => {
    const inj = GENERATED_RULES.filter((r) => slotsOf(r).some((s) => s.startsWith("messages.inline.system-reminder") || s === "messages.system-message"));
    const fellThrough = inj
      .filter((r) => deriveCategory({ classSlot: slotsOf(r)[0], rootSlotType: slotsOf(r)[0], origin: rule(r.ruleId) }) === "other.unknown")
      .map((r) => r.ruleId);
    expect(fellThrough, "落 other.unknown 的注入 rule").toEqual([]);
  });
});

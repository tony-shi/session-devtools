// rule-corpus/generator.test.ts
//
// Phase 1 不变式:空 corpus → 空数组(绝对安全的"骨架")。
// Phase 2 起,本测试将扩展为"corpus → 与现有 CONTEXT_LEDGER_RULES 部分逐项相等"的
// 恒等性测试(每迁一条规则,增加一个相等性断言)。
//
// 测试本身不读 corpus 文件,而是用内存中的最小 corpus 输入做端到端校验,
// 避免与 corpus 文件实际内容耦合(corpus 文件的健康度由 schema 校验保证,不在这里测)。

import { describe, expect, it } from "vitest";
import {
  generateLedgerRules,
  generateContextRules,
  generateSlotBindings,
  toContextLedgerRule,
  toContextRule,
} from "./generator";
import { loadCorpus } from "./index";
import type { Rule } from "./schema";

describe("rule-corpus generator", () => {
  it("loadCorpus() 不抛错;返回的对象有 rules 数组键", () => {
    // Piebald exclusions/manifests 已脱钩,corpus 只含 rules。
    // 具体迁移内容的恒等性由 *-migration.test.ts 各自负责。
    const snap = loadCorpus();
    expect(Array.isArray(snap.rules)).toBe(true);
  });

  it("generateLedgerRules({rules:[]}) === []", () => {
    expect(generateLedgerRules({ rules: [] })).toEqual([]);
  });

  it("generateContextRules({rules:[]}) === []", () => {
    expect(generateContextRules({ rules: [] })).toEqual([]);
  });

  it("generateSlotBindings({rules:[]}) === {}", () => {
    expect(generateSlotBindings({ rules: [] })).toEqual({});
  });

  it("toContextLedgerRule 对最小 rule 字段对齐(无 optional 时不漏字段)", () => {
    const minimal: Rule = {
      ruleId: "test.minimal.v1",
      slotId: "system.test",
      verifiedFor: null,
      sourceUnits: [],
      description: "minimal",
      stability: "static",
      attribution: {
        patternFromBody: true,
        matchMode: "exact",
        mechanism: "system_prompt_pattern",
        category: "system_prompt",
      },
      pattern: "hello",
      filePath: "<inline-test>",
    };

    const ledger = toContextLedgerRule(minimal);
    expect(ledger).toEqual({
      ruleId: "test.minimal.v1",
      verifiedFor: null,
      description: "minimal",
      stability: "static",
      attribution: {
        pattern: "hello",
        matchMode: "exact",
        mechanism: "system_prompt_pattern",
        category: "system_prompt",
      },
    });
  });

  it("toContextRule 对最小 rule 携带 slotId,attribution 子集对齐", () => {
    const minimal: Rule = {
      ruleId: "test.minimal.v1",
      slotId: "system.test",
      verifiedFor: null,
      sourceUnits: [],
      description: "minimal",
      stability: "static",
      attribution: {
        patternFromBody: true,
        matchMode: "exact",
        mechanism: "system_prompt_pattern",
        category: "system_prompt",
      },
      pattern: "hello",
      filePath: "<inline-test>",
    };

    const ctx = toContextRule(minimal);
    expect(ctx).toEqual({
      ruleId: "test.minimal.v1",
      slotId: "system.test",
      verifiedFor: null,
      attribution: {
        pattern: "hello",
        matchMode: "exact",
        mechanism: "system_prompt_pattern",
        category: "system_prompt",
      },
    });
  });

  it("可选字段(appliesTo/materialization/queryScope/captureGroups)正确透传", () => {
    const full: Rule = {
      ruleId: "test.full.v1",
      slotId: "system.test",
      verifiedFor: "2.1.150",
      appliesTo: { minCcVersion: "2.1.150" },
      sourceUnits: [{ unitId: "system-prompt-test", relation: "partial" }],
      description: "full",
      stability: "dynamic",
      sourcemapRef: "ref/x.ts",
      queryScope: "main_session",
      materialization: "normalized_text",
      attribution: {
        patternFromBody: true,
        matchMode: "regex",
        mechanism: "system_prompt_pattern",
        category: "system_prompt",
        captureGroups: { name: "the name" },
      },
      pattern: "^# Test (?<name>[^\\n]+)",
      filePath: "<inline-test>",
    };

    const ledger = toContextLedgerRule(full);
    expect(ledger.appliesTo).toEqual({ minCcVersion: "2.1.150" });
    expect(ledger.materialization).toBe("normalized_text");
    expect(ledger.queryScope).toBe("main_session");
    expect(ledger.sourcemapRef).toBe("ref/x.ts");
    expect(ledger.attribution?.captureGroups).toEqual({ name: "the name" });

    const ctx = toContextRule(full);
    expect(ctx.appliesTo).toEqual({ minCcVersion: "2.1.150" });
    expect(ctx.materialization).toBe("normalized_text");
    expect(ctx.attribution.captureGroups).toEqual({ name: "the name" });
    // ContextRule 不带 sourceUnits / description / stability / sourcemapRef
    expect("description" in ctx).toBe(false);
  });

  it("patternFromBody=false 时,pattern=null 透传到运行时 attribution.pattern", () => {
    const noPattern: Rule = {
      ruleId: "test.no-pattern.v1",
      slotId: "system.test",
      verifiedFor: null,
      sourceUnits: [],
      description: "no pattern",
      stability: "static",
      attribution: {
        patternFromBody: false,
        matchMode: "exact",
        mechanism: "system_prompt_pattern",
        category: "system_prompt",
      },
      pattern: null,
      filePath: "<inline-test>",
    };

    expect(toContextLedgerRule(noPattern).attribution?.pattern).toBeNull();
    expect(toContextRule(noPattern).attribution.pattern).toBeNull();
  });

  it("generateSlotBindings 输出 ruleId → [slotId]", () => {
    const rules: Rule[] = [
      {
        ruleId: "a", slotId: "s.a", verifiedFor: null, sourceUnits: [],
        description: "", stability: "static",
        attribution: { patternFromBody: true, matchMode: "exact", mechanism: "m", category: "system_prompt" },
        pattern: "x", filePath: "x",
      },
      {
        ruleId: "b", slotId: "s.b", verifiedFor: null, sourceUnits: [],
        description: "", stability: "static",
        attribution: { patternFromBody: true, matchMode: "exact", mechanism: "m", category: "system_prompt" },
        pattern: "y", filePath: "y",
      },
    ];
    expect(generateSlotBindings({ rules })).toEqual({
      a: ["s.a"],
      b: ["s.b"],
    });
  });
});

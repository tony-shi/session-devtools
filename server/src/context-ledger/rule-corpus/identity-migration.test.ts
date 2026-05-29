// rule-corpus/identity-migration.test.ts
//
// Phase 2 migration 护栏:确保 corpus 生成的 identity ContextLedgerRule 与原
// 手写常量 deep-equal。任何字段差异都会让测试失败——这是迁移"行为不变"的
// 硬验收。
//
// 注:本测试在 identity rule 已从 rule-registry.ts 移除之后会改成"从历史 git
// 或 fixture 比对"——MVP 阶段我们直接拿仓库当前的 const 比对即可。

import { describe, expect, it } from "vitest";
import { CORPUS_LEDGER_RULES_BY_ID, CORPUS_CONTEXT_RULES } from "./runtime";

describe("Phase 2 identity migration: corpus generated rule 与原手写常量 deep-equal", () => {
  it("CORPUS_LEDGER_RULES_BY_ID 包含 identity v1", () => {
    expect(CORPUS_LEDGER_RULES_BY_ID["claude-code.system-prompt-identity.v1"]).toBeDefined();
  });

  it("identity ContextLedgerRule 与历史手写常量逐字段相等", () => {
    const corpusVersion = CORPUS_LEDGER_RULES_BY_ID["claude-code.system-prompt-identity.v1"];
    // 期望值 = 历史 const 的字面快照(直到 Phase 2 删除前)。
    // 删除时这个 fixture 不再由 rule-registry.ts 提供,改由本测试直接定义。
    const expected = {
      ruleId: "claude-code.system-prompt-identity.v1",
      // Phase 3 升 2.1.150(2.1.126 上的内容一字不差,在 2.1.150 真实数据上也已验证 RULE 命中)
      verifiedFor: "2.1.150",
      description:
        "Claude Code system prompt 的固定身份标识行(57 chars)。" +
        "仅用于 attribution 识别锚点与 reconstruction 注入,不归因整段 system prompt 内容来源。",
      stability: "static",
      // 用户向展示元数据(后端透出供 attribution 面板"导览"展示)
      displayName: "身份",
      summary: "固定身份标识行,标记这是 Claude Code 会话(归因锚点)",
      sourcemapRef: "restored-src/src/constants/system.ts",
      materialization: "exact_text",
      attribution: {
        pattern: "You are Claude Code, Anthropic's official CLI for Claude.",
        matchMode: "exact",
        mechanism: "system_prompt_pattern",
        category: "system_prompt",
      },
    };
    expect(corpusVersion).toEqual(expected);
  });

  it("identity ContextRule 与 SLOT_BINDINGS 一致(slot=system.identity)", () => {
    const ctxRule = CORPUS_CONTEXT_RULES.find(
      (r) => r.ruleId === "claude-code.system-prompt-identity.v1",
    );
    expect(ctxRule).toBeDefined();
    expect(ctxRule!.slotId).toBe("system.identity");
    expect(ctxRule!.attribution.matchMode).toBe("exact");
    expect(ctxRule!.attribution.pattern).toBe(
      "You are Claude Code, Anthropic's official CLI for Claude.",
    );
  });
});

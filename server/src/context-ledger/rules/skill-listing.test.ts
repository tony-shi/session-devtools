import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { CLAUDE_CODE_MESSAGES_SKILL_LISTING_V1_RULE } from "./rule-registry";
import { parseSkillListingBody } from "./skill-listing-parser";
import { CONTEXT_RULE_BY_ID } from "./context-rule-registry";
import { evaluateRuleForNode } from "../parser/attribution/rule-evaluator";
import { resolveFromEvaluation } from "../parser/attribution/resolver";
import type { SegmentNode } from "../parser/types";

describe("skill_listing rule regex", () => {
  const rule = CLAUDE_CODE_MESSAGES_SKILL_LISTING_V1_RULE;
  const re = new RegExp(rule.attribution.pattern!, "sd");

  it("matches the real 91d4 proxy block", () => {
    const real = `<system-reminder>
The following skills are available for use with the Skill tool:

- found-ground-info: Extract ground-truth artifacts (Claude Code JSONL slice + proxy request/response dump) for a specific session / turn / LLM call.
- find-skills: Helps users discover and install agent skills when they ask questions like "how do I do X".
- claude-hud:setup: Configure claude-hud as your statusline
- review: Review a pull request
- security-review: Complete a security review of the pending changes on the current branch
</system-reminder>`;
    const m = re.exec(real);
    expect(m).not.toBeNull();
    expect(m!.groups!.skillsBlock.split("\n").length).toBe(5);
    expect(m!.groups!.skillsBlock.startsWith("- found-ground-info:")).toBe(true);
    expect(m!.groups!.skillsBlock.endsWith("on the current branch")).toBe(true);
  });

  it("handles plugin namespace (colon in name)", () => {
    const withNamespace = `<system-reminder>
The following skills are available for use with the Skill tool:

- claude-hud:setup: Configure claude-hud
- codex:gpt-5-4-prompting: Internal guidance
</system-reminder>`;
    const m = re.exec(withNamespace);
    expect(m).not.toBeNull();
    expect(m!.groups!.skillsBlock).toContain("claude-hud:setup");
    expect(m!.groups!.skillsBlock).toContain("codex:gpt-5-4-prompting");
  });

  it("handles names-only mode (budget pressure)", () => {
    const namesOnly = `<system-reminder>
The following skills are available for use with the Skill tool:

- find-skills
- review
- security-review
</system-reminder>`;
    const m = re.exec(namesOnly);
    expect(m).not.toBeNull();
    expect(m!.groups!.skillsBlock.split("\n")).toEqual(["- find-skills", "- review", "- security-review"]);
  });

  it("handles ellipsis truncation", () => {
    const truncated = `<system-reminder>
The following skills are available for use with the Skill tool:

- find-skills: Helps users…
</system-reminder>`;
    const m = re.exec(truncated);
    expect(m).not.toBeNull();
    expect(m!.groups!.skillsBlock).toContain("…");
  });

  it("matches a block with trailing newlines after </system-reminder>", () => {
    // 真实 case 来自 a1038b1d turn1 call1 messages[0].content[2]：
    // ast-builder 切出来的 SR 段末尾带一个 \n。早期 pattern 用严格 `$` 锚定，
    // 漏掉了这种形态导致命中通用 SR 兜底 rule。
    const withTrail = `<system-reminder>
The following skills are available for use with the Skill tool:

- find-skills: Helps users
</system-reminder>
`;
    const m = re.exec(withTrail);
    expect(m).not.toBeNull();
    expect(m!.groups!.skillsBlock).toBe("- find-skills: Helps users");
  });

  it("does NOT match a generic system-reminder", () => {
    const generic = `<system-reminder>
The task tools haven't been used recently.
</system-reminder>`;
    const m = re.exec(generic);
    expect(m).toBeNull();
  });
});

describe("parseSkillListingBody", () => {
  it("parses normal '- name: description' lines", () => {
    const body = `- find-skills: Helps users discover and install agent skills
- review: Review a pull request`;
    const result = parseSkillListingBody(body, 0);

    expect(result.entries).toHaveLength(2);
    expect(result.successCount).toBe(2);
    expect(result.errorCount).toBe(0);

    expect(result.entries[0]).toMatchObject({
      name: "find-skills",
      description: "Helps users discover and install agent skills",
      parseError: false,
    });
    expect(result.entries[1]).toMatchObject({
      name: "review",
      description: "Review a pull request",
      parseError: false,
    });
  });

  it("preserves plugin namespace as part of name", () => {
    const body = `- claude-hud:setup: Configure claude-hud
- codex:gpt-5-4-prompting: Internal guidance`;
    const result = parseSkillListingBody(body, 0);

    expect(result.entries[0].name).toBe("claude-hud:setup");
    expect(result.entries[0].description).toBe("Configure claude-hud");
    expect(result.entries[1].name).toBe("codex:gpt-5-4-prompting");
    expect(result.entries[1].description).toBe("Internal guidance");
  });

  it("handles names-only mode (no description)", () => {
    const body = `- find-skills
- review
- security-review`;
    const result = parseSkillListingBody(body, 0);

    expect(result.entries).toHaveLength(3);
    expect(result.successCount).toBe(3);
    for (const e of result.entries) {
      expect(e.parseError).toBe(false);
      expect(e.description).toBeNull();
    }
    expect(result.entries.map(e => e.name)).toEqual(["find-skills", "review", "security-review"]);
  });

  it("preserves ellipsis-truncated descriptions verbatim", () => {
    const body = `- find-skills: Helps users discover…`;
    const result = parseSkillListingBody(body, 0);

    expect(result.entries[0].name).toBe("find-skills");
    expect(result.entries[0].description).toBe("Helps users discover…");
    expect(result.entries[0].parseError).toBe(false);
  });

  it("handles description containing colons (description with ':' inside)", () => {
    // 描述里可能有冒号，但首个 ': ' 必须正确分隔 name 与 desc
    const body = `- claude-api: Build, debug, and optimize Claude API / Anthropic SDK apps. TRIGGER when: code imports anthropic.`;
    const result = parseSkillListingBody(body, 0);

    expect(result.entries[0].name).toBe("claude-api");
    expect(result.entries[0].description).toBe(
      "Build, debug, and optimize Claude API / Anthropic SDK apps. TRIGGER when: code imports anthropic.",
    );
    expect(result.entries[0].parseError).toBe(false);
  });

  it("appends continuation lines (no leading '- ') to previous skill's description", () => {
    // 真实 case 来自 a1038b1d turn1 call1：claude-api 的 SKILL.md 在 description
    // 里塞了 "TRIGGER when:" / "SKIP:" 两段独立段落，cli.js 直接连同 \n 塞进 listing。
    const body = `- claude-api: Build, debug, and optimize Claude API.
TRIGGER when: code imports anthropic SDK.
SKIP: file imports openai.
- next-skill: another one`;
    const result = parseSkillListingBody(body, 0);

    expect(result.entries).toHaveLength(2);
    expect(result.successCount).toBe(2);
    expect(result.errorCount).toBe(0);

    expect(result.entries[0].name).toBe("claude-api");
    expect(result.entries[0].description).toBe(
      "Build, debug, and optimize Claude API.\nTRIGGER when: code imports anthropic SDK.\nSKIP: file imports openai.",
    );
    expect(result.entries[0].rawLine).toContain("TRIGGER when:");
    expect(result.entries[0].rawLine).toContain("SKIP:");

    expect(result.entries[1].name).toBe("next-skill");
    expect(result.entries[1].description).toBe("another one");
  });

  it("marks orphan lines (no preceding valid skill) with parseError=true", () => {
    const body = `weird-line-without-dash
- proper-skill: ok`;
    const result = parseSkillListingBody(body, 0);

    expect(result.entries).toHaveLength(2);
    expect(result.successCount).toBe(1);
    expect(result.errorCount).toBe(1);
    expect(result.entries[0].parseError).toBe(true);
    expect(result.entries[0].rawLine).toBe("weird-line-without-dash");
    expect(result.entries[1].parseError).toBe(false);
    expect(result.entries[1].name).toBe("proper-skill");
  });

  it("computes lineStart/lineEnd relative to bodyOffsetInSegment", () => {
    const body = `- a: x
- b: y`;
    const offset = 100;
    const result = parseSkillListingBody(body, offset);

    // 第一行 "- a: x" 长度 6，从 100 开始
    expect(result.entries[0].lineStart).toBe(100);
    expect(result.entries[0].lineEnd).toBe(106);
    // 第二行 "- b: y" 从 107（跨过 \n）开始，长度 6
    expect(result.entries[1].lineStart).toBe(107);
    expect(result.entries[1].lineEnd).toBe(113);
  });

  it("skips empty lines silently (cli.js shouldn't emit them, but defensive)", () => {
    const body = `- a: x

- b: y`;
    const result = parseSkillListingBody(body, 0);

    expect(result.entries).toHaveLength(2);
    expect(result.entries.map(e => e.name)).toEqual(["a", "b"]);
  });

  it("never throws on malformed input", () => {
    expect(() => parseSkillListingBody("", 0)).not.toThrow();
    expect(() => parseSkillListingBody("\n\n\n", 0)).not.toThrow();
    expect(() => parseSkillListingBody("garbage", 0)).not.toThrow();
    expect(parseSkillListingBody("", 0).entries).toEqual([]);
  });
});

describe("resolver pipeline → SegmentAttribution.payload.skillListing", () => {
  // 端到端：跑 evaluator + resolver，确认 payload 真正流到 SegmentAttribution。
  // 这是用户提的关键诉求：parser 必须在后端落地，前端只 consume，绝不重 parse。

  function makeNode(rawText: string): SegmentNode {
    return {
      id: "test-node",
      slotType: "messages.inline.system-reminder",
      jsonPath: "$.messages[0].content[0]",
      rawText,
      rawHash:
        "sha256:" + createHash("sha256").update(rawText).digest("hex").slice(0, 16),
      charCount: rawText.length,
      children: [],
    };
  }

  it("populates payload.skillListing.entries with parsed name + description", () => {
    const rawText = `<system-reminder>
The following skills are available for use with the Skill tool:

- find-skills: Helps users discover and install agent skills
- review: Review a pull request
- claude-hud:setup: Configure claude-hud as your statusline
</system-reminder>`;

    const node = makeNode(rawText);
    const rule = CONTEXT_RULE_BY_ID.get(
      "claude-code.messages.skill-listing.v1",
    );
    expect(rule).toBeDefined();

    const evaluation = evaluateRuleForNode(node, rule!, "main_session");
    expect(evaluation).not.toBeNull();

    const attribution = resolveFromEvaluation(node, evaluation!);
    expect(attribution.category).toBe("skill_listing");
    expect(attribution.payload?.skillListing).toBeDefined();

    // 关键：node.origin 也必须带 payload（前端实际消费的是这里，attribution-service
    // 直接序列化 node.origin 到 wire）。
    expect(node.origin?.kind).toBe("rule");
    if (node.origin?.kind === "rule") {
      expect(node.origin.payload?.skillListing).toBeDefined();
      expect(node.origin.payload?.skillListing?.entries).toHaveLength(3);
    }

    const skills = attribution.payload!.skillListing!;
    expect(skills.successCount).toBe(3);
    expect(skills.errorCount).toBe(0);
    expect(skills.entries.map(e => e.name)).toEqual([
      "find-skills",
      "review",
      "claude-hud:setup",
    ]);
    expect(skills.entries[0].description).toBe(
      "Helps users discover and install agent skills",
    );

    // 偏移应相对原始 segment rawText
    const first = skills.entries[0];
    expect(rawText.slice(first.lineStart, first.lineEnd)).toBe(first.rawLine);
  });

  it("returns payload only for skill-listing rule, not for generic system-reminder", () => {
    // 通用 SR 兜底 rule 不应触发 skill_listing parser
    const rawText = `<system-reminder>
The task tools haven't been used recently.
</system-reminder>`;
    const node = makeNode(rawText);

    const skillRule = CONTEXT_RULE_BY_ID.get(
      "claude-code.messages.skill-listing.v1",
    );
    const evaluation = evaluateRuleForNode(node, skillRule!, "main_session");
    expect(evaluation).toBeNull(); // 不该命中 skill-listing rule
  });
});

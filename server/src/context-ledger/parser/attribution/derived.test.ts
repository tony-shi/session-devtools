import { describe, it, expect } from "vitest";
import { authorshipOf } from "./derived";
import type { SegmentOrigin } from "./origin";

// 单元测试：仅验证 origin → authorship 投影规则。
// coverageStateOf 已有独立测试（audit/forward.test.ts），此处不重复。

const ruleOrigin = (matchMode: "exact"): SegmentOrigin => ({
  kind: "rule",
  ruleId: "test.rule",
  matchMode,
  confidence: "definitive",
  fullyCovered: true,
});

const jsonlOrigin = (source: import("./origin").JsonlEventSource): SegmentOrigin => ({
  kind: "jsonl",
  eventKind: { source },
  jsonlLineIdx: 0,
  confidence: "definitive",
  fullyCovered: true,
});

describe("authorshipOf — origin → 5 值投影", () => {
  it("jsonl.user_input → human", () => {
    expect(authorshipOf(jsonlOrigin("user_input"))).toBe("human");
  });

  it("jsonl.assistant_text / thinking / tool_use → assistant", () => {
    expect(authorshipOf(jsonlOrigin("assistant_text"))).toBe("assistant");
    expect(authorshipOf(jsonlOrigin("thinking"))).toBe("assistant");
    expect(authorshipOf(jsonlOrigin("tool_use"))).toBe("assistant");
  });

  it("jsonl.tool_result → tool_protocol（区别于 tool_use 的 assistant）", () => {
    expect(authorshipOf(jsonlOrigin("tool_result"))).toBe("tool_protocol");
  });

  it("jsonl.harness_injection / system_local_command / stop_hook / away_summary / attachment → harness", () => {
    expect(authorshipOf(jsonlOrigin("harness_injection"))).toBe("harness");
    expect(authorshipOf(jsonlOrigin("system_local_command"))).toBe("harness");
    expect(authorshipOf(jsonlOrigin("stop_hook"))).toBe("harness");
    expect(authorshipOf(jsonlOrigin("away_summary"))).toBe("harness");
    expect(authorshipOf(jsonlOrigin("attachment"))).toBe("harness");
  });

  it("rule origin → harness（CLI 拼装的 prompt 段）", () => {
    expect(authorshipOf(ruleOrigin("exact"))).toBe("harness");
  });

  it("structural / unknown → unattributed", () => {
    expect(authorshipOf({ kind: "structural", slotId: "s", reason: "container_node" })).toBe("unattributed");
    expect(authorshipOf({ kind: "structural", slotId: "s", reason: "no_rule_matched" })).toBe("unattributed");
    expect(authorshipOf({ kind: "unknown", reason: "template_did_not_match" })).toBe("unattributed");
  });

  it("jsonl.unknown 兜底 → unattributed", () => {
    expect(authorshipOf(jsonlOrigin("unknown"))).toBe("unattributed");
  });
});

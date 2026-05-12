import { describe, it, expect } from "vitest";
import { parseQuery } from "../index";
import {
  assertAllInvariants,
  assertContainerNodesAreStructural,
  assertLeafConcatEqualsParent,
  collectLeaves,
  AttributionInvariantError,
} from "./invariants";

// 极简 wire body：触发 main_session template（tools 非空），从而带出 H1 切分容器。
// 不依赖外部 fixture，保证此测试只验证 PR 1 的不变量本身。
function minimalReqBody() {
  return {
    system: [
      {
        type: "text" as const,
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
      },
      {
        type: "text" as const,
        // 至少包含一个被 main-session template 识别的 H1 头，保证产出 container
        text: "Prelude content.\n# Doing tasks\nDo the task carefully.\n# Tone and style\nBe concise.\n",
      },
    ],
    tools: [
      { name: "Read", description: "Read a file", input_schema: {} },
    ],
    messages: [
      {
        role: "user",
        content: "hello world",
      },
    ],
  };
}

describe("attribution invariants — PR 1 默认填充与不变量", () => {
  it("parseQuery 出口的 snapshot 满足全部不变量", () => {
    const snap = parseQuery({
      reqBody: minimalReqBody(),
      proxyFile: "test.json",
      ts: "2026-01-01T00:00:00Z",
    });
    expect(() => assertAllInvariants(snap)).not.toThrow();
  });

  it("每个节点都有 origin (非空、kind ∈ {rule,jsonl,structural,unknown})", () => {
    const snap = parseQuery({
      reqBody: minimalReqBody(),
      proxyFile: "test.json",
    });
    const validKinds = new Set(["rule", "jsonl", "structural", "unknown"]);
    for (const node of Object.values(snap.index)) {
      expect(node.origin).toBeDefined();
      expect(validKinds.has(node.origin.kind)).toBe(true);
    }
  });

  it("container 节点的 origin = structural/container_node", () => {
    const snap = parseQuery({
      reqBody: minimalReqBody(),
      proxyFile: "test.json",
    });
    const containers = Object.values(snap.index).filter((n) => n.children.length > 0);
    expect(containers.length).toBeGreaterThan(0); // 至少 main-prompt-block 是个 container
    for (const c of containers) {
      expect(c.origin.kind).toBe("structural");
      if (c.origin.kind === "structural") {
        expect(c.origin.reason).toBe("container_node");
      }
    }
  });

  it("叶子节点 origin 默认是 structural/no_rule_matched 或 unknown (尚未被 rule 覆盖)", () => {
    const snap = parseQuery({
      reqBody: minimalReqBody(),
      proxyFile: "test.json",
    });
    const leaves = Object.values(snap.index).filter((n) => n.children.length === 0);
    expect(leaves.length).toBeGreaterThan(0);
    for (const l of leaves) {
      // PR 1 不引入任何 rule/jsonl 覆盖，所以所有叶子都应该停留在默认状态
      expect(["structural", "unknown"]).toContain(l.origin.kind);
      if (l.origin.kind === "structural") {
        expect(l.origin.reason).toBe("no_rule_matched");
      }
    }
  });

  it("叶子拼接 ≡ 父节点 rawText (每个 container 都满足)", () => {
    const snap = parseQuery({
      reqBody: minimalReqBody(),
      proxyFile: "test.json",
    });
    for (const node of Object.values(snap.index)) {
      if (node.children.length === 0) continue;
      const leafConcat = collectLeaves(node.children).map((l) => l.rawText).join("");
      expect(leafConcat).toBe(node.rawText);
    }
  });

  it("人为破坏不变量时 assertAllInvariants 抛 AttributionInvariantError", () => {
    const snap = parseQuery({
      reqBody: minimalReqBody(),
      proxyFile: "test.json",
    });
    // 取一个 container 把它的 origin 改成 rule，应触发 container-not-structural
    const container = Object.values(snap.index).find((n) => n.children.length > 0);
    expect(container).toBeDefined();
    if (!container) return;
    container.origin = {
      kind: "rule",
      ruleId: "test.fake.v1",
      matchMode: "exact",
      confidence: "definitive",
    };
    expect(() => assertContainerNodesAreStructural(snap)).toThrow(AttributionInvariantError);
  });

  it("人为篡改叶子 rawText 时 assertLeafConcatEqualsParent 抛错", () => {
    const snap = parseQuery({
      reqBody: minimalReqBody(),
      proxyFile: "test.json",
    });
    // 把某个叶子的 rawText 截断，破坏拼接等于父节点的不变量
    const leaf = Object.values(snap.index).find(
      (n) => n.children.length === 0 && n.rawText.length > 5 && n.parentId,
    );
    expect(leaf).toBeDefined();
    if (!leaf) return;
    leaf.rawText = leaf.rawText.slice(0, -1);
    expect(() => assertLeafConcatEqualsParent(snap)).toThrow(AttributionInvariantError);
  });
});

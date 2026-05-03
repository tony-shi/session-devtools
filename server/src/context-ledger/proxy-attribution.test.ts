// proxy-attribution 验收测试
// 新 contract：inferClaudeProxyAttributions 消费 snapshot.segments（由 parseClaudeProxyRequest 产出），
// 不再依赖 rawBody，不再 mutate snapshot。
import { describe, expect, test } from "bun:test";
import type { ProxyQuerySnapshot } from "./types";
import {
  buildAttributionBreakdown,
  inferClaudeProxyAttributions,
} from "./proxy-attribution";
import { parseClaudeProxyRequest } from "./proxy-snapshot-parser";
import type { ProxyRequestInput } from "./proxy-snapshot-parser";

const FIXTURES_DIR = new URL("../../test/fixtures/context-reconstruction/", import.meta.url);

// 从 fixture 目录 parse 出真实 snapshot（含完整 segments）
async function loadSnapshot(fixtureName: string): Promise<ProxyQuerySnapshot> {
  const url = new URL(`${fixtureName}/proxy-request.json`, FIXTURES_DIR);
  const raw = await Bun.file(url).json() as ProxyRequestInput;
  return parseClaudeProxyRequest(raw, {
    proxyFile: `server/test/fixtures/context-reconstruction/${fixtureName}/proxy-request.json`,
  });
}

// ---- 单 fixture 测试工厂 -----------------------------------------------

function fixtureTests(fixtureName: string) {
  describe(`fixture: ${fixtureName}`, () => {
    test("输出 attribution 列表，且每条都有 category 和 mechanism", async () => {
      const snapshot = await loadSnapshot(fixtureName);
      const attributions = inferClaudeProxyAttributions(snapshot);

      expect(attributions.length).toBeGreaterThan(0);
      // attribution 数量应与 segment 数量一致（1:1 映射）
      expect(attributions.length).toBe(snapshot.segments.length);

      for (const attr of attributions) {
        expect(attr.category).toBeDefined();
        expect(attr.mechanism).toBeDefined();
        expect(attr.confidence).toBeDefined();
        const hasProxyRef = attr.sourceRefs.some((r) => r.kind === "proxy");
        expect(hasProxyRef).toBe(true);
      }
    });

    test("inferClaudeProxyAttributions 不 mutate snapshot.segments", async () => {
      const snapshot = await loadSnapshot(fixtureName);
      const countBefore = snapshot.segments.length;
      inferClaudeProxyAttributions(snapshot);
      expect(snapshot.segments.length).toBe(countBefore);
    });

    test("unknown segment 不被静默吞掉（有 note 说明）", async () => {
      const snapshot = await loadSnapshot(fixtureName);
      const attributions = inferClaudeProxyAttributions(snapshot);

      const unknowns = attributions.filter((a) => a.category === "unknown");
      for (const u of unknowns) {
        expect(u.notes?.length ?? 0).toBeGreaterThan(0);
        expect(u.confidence).toBe("unknown");
      }
    });

    test("confidence 不全为 exact（至少有一条 inferred 或 unknown）", async () => {
      const snapshot = await loadSnapshot(fixtureName);
      const attributions = inferClaudeProxyAttributions(snapshot);
      if (fixtureName !== "system-tools-overhead") {
        const nonExact = attributions.filter((a) => a.confidence !== "exact");
        expect(nonExact.length).toBeGreaterThan(0);
      }
    });

    test("能输出 byCategory breakdown（至少覆盖 system_prompt 或 tools_schema）", async () => {
      const snapshot = await loadSnapshot(fixtureName);
      const attributions = inferClaudeProxyAttributions(snapshot);
      const breakdown = buildAttributionBreakdown(fixtureName, attributions);

      expect(breakdown.fixture).toBe(fixtureName);
      expect(breakdown.totalSegments).toBeGreaterThan(0);
      expect(breakdown.byCategory.length).toBeGreaterThan(0);

      const categories = breakdown.byCategory.map((b) => b.category);
      const hasSystemOrTools =
        categories.includes("system_prompt") || categories.includes("tools_schema");
      expect(hasSystemOrTools).toBe(true);
    });

    test("topBloatSources 返回最大 charCount 的 segment", async () => {
      const snapshot = await loadSnapshot(fixtureName);
      const attributions = inferClaudeProxyAttributions(snapshot);
      const breakdown = buildAttributionBreakdown(fixtureName, attributions);

      if (breakdown.topBloatSources.length > 1) {
        for (let i = 0; i < breakdown.topBloatSources.length - 1; i++) {
          expect(breakdown.topBloatSources[i]!.charCount).toBeGreaterThanOrEqual(
            breakdown.topBloatSources[i + 1]!.charCount,
          );
        }
      }
    });
  });
}

// ---- 四个 fixture -------------------------------------------------------

fixtureTests("system-tools-overhead");
fixtureTests("single-tool-call");
fixtureTests("large-tool-output");
fixtureTests("multi-turn-human");

// ---- 跨 fixture 验证 ----------------------------------------------------

describe("cross-fixture: large-tool-output 的大 tool_result 被标记为 large_segment", () => {
  test("large-tool-output fixture 中存在 large_segment 的 tool_result attribution", async () => {
    const snapshot = await loadSnapshot("large-tool-output");
    const attributions = inferClaudeProxyAttributions(snapshot);

    const largeToolResult = attributions.find(
      (a) => a.category === "tool_result" && (a.charCount ?? 0) > 10_000,
    );
    expect(largeToolResult).toBeDefined();
    expect(largeToolResult?.notes?.some((n) => n.includes("large_segment_detector"))).toBe(true);
  });
});

describe("cross-fixture: system-tools-overhead 的 tools 被识别为 tools_schema", () => {
  test("tools_schema attribution 存在且 charCount > 0", async () => {
    const snapshot = await loadSnapshot("system-tools-overhead");
    const attributions = inferClaudeProxyAttributions(snapshot);

    const toolsAttr = attributions.find((a) => a.category === "tools_schema");
    expect(toolsAttr).toBeDefined();
    if (!toolsAttr) return; // 类型 narrow，下面可放心访问字段
    expect(toolsAttr.mechanism).toBe("tools_schema_pattern");
    // exact = tool rule 精确命中（Edit/Write/Read 等静态 rule）
    // inferred = regex rule 头尾锚定（Agent/Bash 等动态 rule）
    // 两者都是合法结果，取决于具体 tool
    expect(["exact", "inferred"]).toContain(toolsAttr.confidence);
    expect(toolsAttr.charCount ?? 0).toBeGreaterThan(0);
  });
});

describe("cross-fixture: multi-turn-human 的 system-reminder 被识别为 harness_injection", () => {
  test("至少一条 harness_injection attribution 使用 system_reminder_pattern", async () => {
    const snapshot = await loadSnapshot("multi-turn-human");
    const attributions = inferClaudeProxyAttributions(snapshot);

    const reminderAttr = attributions.find(
      (a) => a.category === "harness_injection" && a.mechanism === "system_reminder_pattern",
    );
    expect(reminderAttr).toBeDefined();
  });
});

describe("cross-fixture: single-tool-call 的 tool_use/tool_result 通过 tool_use_id_match 识别", () => {
  test("tool_use 和 tool_result 都使用 tool_use_id_match 机制", async () => {
    const snapshot = await loadSnapshot("single-tool-call");
    const attributions = inferClaudeProxyAttributions(snapshot);

    const toolUseAttr = attributions.find(
      (a) => a.category === "tool_use" && a.mechanism === "tool_use_id_match",
    );
    const toolResultAttr = attributions.find(
      (a) => a.category === "tool_result" && a.mechanism === "tool_use_id_match",
    );
    expect(toolUseAttr).toBeDefined();
    expect(toolResultAttr).toBeDefined();
  });
});

// P2-4 后：prior_session_guess 已从 attribution 层删除。
// attribution 只输出 wire schema 类别（user_message），不主动猜测历史性。
// prior_session_history 归因由 reconcile 层的 prefixIncomplete 信号决定。
describe("P2-4 prior_session_guess 已删除", () => {
  test("multi-turn-human: 所有 user messages 归为 user_message，attribution 不产出 prior_session_history", async () => {
    const snapshot = await loadSnapshot("multi-turn-human");
    const attributions = inferClaudeProxyAttributions(snapshot);

    // P2-4 后：attribution 不再猜测 prior_session_history
    const priorHistory = attributions.filter((a) => a.category === "prior_session_history");
    expect(priorHistory).toHaveLength(0);

    // user message attributions 应有 user_message 类别
    const userMsgAttrs = attributions.filter((a) => a.category === "user_message");
    expect(userMsgAttrs.length).toBeGreaterThan(0);
  });
});

describe("tool_result 的 tool_use_id 不在本次请求时降级为 inferred", () => {
  test("篡改 segment.toolUseId 使其不匹配，confidence 降级为 inferred", async () => {
    const snapshot = await loadSnapshot("single-tool-call");
    // 找到 tool_result segment，篡改其 toolUseId
    const toolResultSeg = snapshot.segments.find((s) => s.category === "tool_result");
    expect(toolResultSeg).toBeDefined();
    const originalId = toolResultSeg!.toolUseId;
    toolResultSeg!.toolUseId = "toolu_nonexistent";

    const attributions = inferClaudeProxyAttributions(snapshot);
    const degraded = attributions.find(
      (a) => a.category === "tool_result" && a.confidence === "inferred",
    );
    expect(degraded).toBeDefined();
    expect(degraded?.mechanism).toBe("unknown");
    expect(degraded?.notes?.some((n) => n.includes("not found"))).toBe(true);

    // 恢复
    toolResultSeg!.toolUseId = originalId;
  });
});

describe("空 snapshot（无 segments）返回空列表，不 throw", () => {
  test("segments=[] 时返回 []", () => {
    const snapshot: ProxyQuerySnapshot = {
      id: "test-empty",
      agentKind: "claude-code",
      sessionId: "s",
      queryId: "q",
      timestamp: new Date().toISOString(),
      sourceRef: { kind: "proxy", proxy: { file: "test.json" } },
      segments: [],
      rawRequestHash: "sha256:test",
    };
    const attributions = inferClaudeProxyAttributions(snapshot);
    expect(attributions).toHaveLength(0);
  });
});

describe("rule registry 集成：identity rule 驱动 attribution", () => {
  test("identity block（57 chars）命中 identity rule，ruleId 写入 attribution", async () => {
    const snapshot = await loadSnapshot("system-tools-overhead");
    const attributions = inferClaudeProxyAttributions(snapshot);

    const identityAttr = attributions.find(
      (a) => a.ruleId === "claude-code.system-prompt-identity.v1",
    );
    expect(identityAttr).toBeDefined();
    expect(identityAttr!.category).toBe("system_prompt");
    expect(identityAttr!.mechanism).toBe("system_prompt_pattern");
  });

  test("system[2] 的 Environment section 命中 environment rule", async () => {
    const snapshot = await loadSnapshot("system-tools-overhead");
    const attributions = inferClaudeProxyAttributions(snapshot);

    const envAttr = attributions.find(
      (a) => a.ruleId === "claude-code.system-prompt-environment.v1",
    );
    expect(envAttr).toBeDefined();
    expect(envAttr!.category).toBe("harness_injection");
    // P2-6 修正：regex allGroupsFilled → estimated（识别确信，复现仍 estimated）
    expect(["exact", "estimated", "inferred"]).toContain(envAttr!.confidence);
    // cwd, platform 등 동적 필드가 notes 에 추출됐는지 확인
    expect(envAttr!.notes?.some(n => n.startsWith("cwd="))).toBe(true);
  });

  test("system[2] 的 static section（sectionHeader='System'）归为 system_prompt", async () => {
    const snapshot = await loadSnapshot("system-tools-overhead");
    const attributions = inferClaudeProxyAttributions(snapshot);

    // system section 里 category=system_prompt 且无 ruleId 的是 static sections
    const staticAttrs = attributions.filter(
      (a) =>
        a.category === "system_prompt" &&
        a.ruleId !== "claude-code.system-prompt-identity.v1",
    );
    expect(staticAttrs.length).toBeGreaterThan(0);
  });
});

describe("rule registry 集成：dynamic section rules 驱动 attribution", () => {
  test("session-specific guidance / auto memory / environment 各命中独立 rule", async () => {
    const snapshot = await loadSnapshot("system-tools-overhead");
    const attributions = inferClaudeProxyAttributions(snapshot);

    // 各 section 有独立 ruleId
    const sessionAttr = attributions.find(
      // fixture 版本命中 embedded 变体（exact）；non-embedded 变体 ruleId 作为兜底
      (a) => a.ruleId === "claude-code.system-prompt-session-guidance.embedded.v1" ||
             a.ruleId === "claude-code.system-prompt-session-guidance.v1",
    );
    const envAttr = attributions.find(
      (a) => a.ruleId === "claude-code.system-prompt-environment.v1",
    );
    const memAttr = attributions.find(
      (a) => a.ruleId === "claude-code.system-prompt-auto-memory.v1",
    );

    expect(sessionAttr).toBeDefined();
    expect(envAttr).toBeDefined();
    expect(memAttr).toBeDefined();

    for (const a of [sessionAttr!, envAttr!, memAttr!]) {
      expect(a.category).toBe("harness_injection");
    }
  });
});

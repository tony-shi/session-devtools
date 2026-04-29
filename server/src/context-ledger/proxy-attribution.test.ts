// proxy-attribution 验收测试：对四个真实 fixture 执行 inferClaudeProxyAttributions，
// 验证每个 fixture 都能输出 category breakdown，且 unknown segment 不被静默吞掉。
import { describe, expect, test } from "bun:test";
import type { ProxyQuerySnapshot } from "./types";
import {
  buildAttributionBreakdown,
  inferClaudeProxyAttributions,
} from "./proxy-attribution";

// import.meta.url → .../server/src/context-ledger/
// fixtures は .../server/test/fixtures/context-reconstruction/
const FIXTURES_DIR = new URL("../../test/fixtures/context-reconstruction/", import.meta.url);

// 从 fixture 目录读取 proxy-request.json，构造最小 ProxyQuerySnapshot
async function loadSnapshot(fixtureName: string): Promise<ProxyQuerySnapshot> {
  const proxyFile = new URL(`${fixtureName}/proxy-request.json`, FIXTURES_DIR);
  const raw = await Bun.file(proxyFile).json();

  const reqBody = raw.reqBody ?? {};
  const sessionId =
    (raw.reqHeaders as Record<string, string>)?.["X-Claude-Code-Session-Id"] ??
    "unknown-session";

  return {
    id: `snapshot-${fixtureName}`,
    agentKind: "claude-code",
    sessionId,
    queryId: `query-${fixtureName}`,
    timestamp: raw.ts ?? new Date().toISOString(),
    sourceRef: {
      kind: "proxy",
      proxy: {
        file: `server/test/fixtures/context-reconstruction/${fixtureName}/proxy-request.json`,
      },
    },
    segments: [], // inferClaudeProxyAttributions 会 push 进来
    rawRequestHash: "sha256:test",
    request: {
      model: reqBody.model,
      stream: true,
    },
    metadata: {
      rawBody: reqBody,
    },
  };
}

// ---- 单 fixture 测试工厂 -----------------------------------------------

function fixtureTests(fixtureName: string) {
  describe(`fixture: ${fixtureName}`, () => {
    test("输出 attribution 列表，且每条都有 category 和 mechanism", async () => {
      const snapshot = await loadSnapshot(fixtureName);
      const attributions = inferClaudeProxyAttributions(snapshot);

      expect(attributions.length).toBeGreaterThan(0);

      for (const attr of attributions) {
        expect(attr.category).toBeDefined();
        expect(attr.mechanism).toBeDefined();
        expect(attr.confidence).toBeDefined();
        // 每条 attribution 必须有至少一个 sourceRef 包含 proxy jsonPath
        const hasProxyRef = attr.sourceRefs.some((r) => r.kind === "proxy");
        expect(hasProxyRef).toBe(true);
      }
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

    test("confidence 不全为 high（不允许全部 exact）", async () => {
      const snapshot = await loadSnapshot(fixtureName);
      const attributions = inferClaudeProxyAttributions(snapshot);

      // 至少有一条 inferred 或 unknown，除非 fixture 极其简单
      // system-tools-overhead 只有 system+tools，可能全 exact，跳过此断言
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
        // 验证降序排列
        for (let i = 0; i < breakdown.topBloatSources.length - 1; i++) {
          expect(breakdown.topBloatSources[i].charCount).toBeGreaterThanOrEqual(
            breakdown.topBloatSources[i + 1].charCount,
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
  test("large-tool-output fixture 中存在 large_segment_detector attribution", async () => {
    const snapshot = await loadSnapshot("large-tool-output");
    const attributions = inferClaudeProxyAttributions(snapshot);

    const largeToolResult = attributions.find(
      (a) =>
        a.category === "tool_result" &&
        (a.charCount ?? 0) > 10_000,
    );
    expect(largeToolResult).toBeDefined();
    expect(largeToolResult?.notes?.some((n) => n.includes("large_segment_detector"))).toBe(true);
  });
});

describe("cross-fixture: system-tools-overhead 的 tools[] 被识别为 tools_schema", () => {
  test("tools_schema attribution 存在且 charCount > 0", async () => {
    const snapshot = await loadSnapshot("system-tools-overhead");
    const attributions = inferClaudeProxyAttributions(snapshot);

    const toolsAttr = attributions.find((a) => a.category === "tools_schema");
    expect(toolsAttr).toBeDefined();
    expect(toolsAttr?.mechanism).toBe("tools_schema_pattern");
    expect(toolsAttr?.confidence).toBe("exact");
    expect((toolsAttr?.charCount ?? 0)).toBeGreaterThan(0);
  });
});

describe("cross-fixture: multi-turn-human 的 system-reminder 被识别为 harness_injection", () => {
  test("至少一条 harness_injection attribution 使用 system_reminder_pattern", async () => {
    const snapshot = await loadSnapshot("multi-turn-human");
    const attributions = inferClaudeProxyAttributions(snapshot);

    const reminderAttr = attributions.find(
      (a) =>
        a.category === "harness_injection" &&
        a.mechanism === "system_reminder_pattern",
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

describe("P1 fix: prior_session_history 只出现在 messages[0]", () => {
  test("multi-turn-human: messages[4] 的中文任务描述归为 user_message，不归为 prior_session_history", async () => {
    const snapshot = await loadSnapshot("multi-turn-human");
    const attributions = inferClaudeProxyAttributions(snapshot);

    // messages[4].content[3] 是中文任务描述，jsonPath 包含 "messages[4]"
    const chineseTask = attributions.find(
      (a) =>
        a.category === "user_message" &&
        (a.sourceRefs[0] as { kind: string; proxy?: { jsonPath?: string } })?.proxy?.jsonPath?.includes("messages[4]"),
    );
    expect(chineseTask).toBeDefined();

    // prior_session_history 的 note 必须说明来自 messages[0]
    const priorHistory = attributions.filter((a) => a.category === "prior_session_history");
    for (const p of priorHistory) {
      expect(p.notes?.some((n) => n.includes("messages[0]"))).toBe(true);
    }
  });
});

describe("P2a fix: 缺少 metadata.rawBody 时抛出明确错误", () => {
  test("snapshot 没有 rawBody 时 throw，不静默返回空列表", () => {
    const snapshot: ProxyQuerySnapshot = {
      id: "test-no-rawbody",
      agentKind: "claude-code",
      sessionId: "s",
      queryId: "q",
      timestamp: new Date().toISOString(),
      sourceRef: { kind: "proxy", proxy: { file: "test.json" } },
      segments: [],
      rawRequestHash: "sha256:test",
    };
    expect(() => inferClaudeProxyAttributions(snapshot)).toThrow(
      /missing metadata\.rawBody/,
    );
  });
});

describe("P2b fix: tool_result 的 tool_use_id 不在本次请求时降级为 inferred", () => {
  test("伪造一个 tool_use_id 不匹配的 tool_result，confidence 应为 inferred", async () => {
    const snapshot = await loadSnapshot("single-tool-call");
    // 篡改 rawBody：给 tool_result 一个不存在的 tool_use_id
    const rawBody = snapshot.metadata!.rawBody as Record<string, unknown>;
    const messages = rawBody.messages as Array<{ role: string; content: unknown[] }>;
    // messages[2] 是 tool_result turn
    const toolResultMsg = messages.find((m) => m.role === "user" &&
      (m.content as Array<{type:string}>).some(b => b.type === "tool_result"));
    if (toolResultMsg) {
      for (const block of toolResultMsg.content as Array<{type:string; tool_use_id?: string}>) {
        if (block.type === "tool_result") block.tool_use_id = "toolu_nonexistent";
      }
    }
    const attributions = inferClaudeProxyAttributions(snapshot);
    const degraded = attributions.find(
      (a) => a.category === "tool_result" && a.confidence === "inferred",
    );
    expect(degraded).toBeDefined();
    expect(degraded?.mechanism).toBe("unknown");
    expect(degraded?.notes?.some((n) => n.includes("not found"))).toBe(true);
  });
});

describe("rule registry 集成：identity rule 驱动 attribution", () => {
  test("带句号的完整 identity pattern 命中 system[0]，ruleId 写入 attribution", async () => {
    const snapshot = await loadSnapshot("system-tools-overhead");
    const attributions = inferClaudeProxyAttributions(snapshot);
    const identityAttr = attributions.find(
      (a) => a.category === "system_prompt" && a.confidence === "exact",
    );
    expect(identityAttr).toBeDefined();
    expect(identityAttr!.ruleId).toBe("claude-code.system-prompt-identity.v1");
    expect(identityAttr!.mechanism).toBe("system_prompt_pattern");
  });

  test("少句号版本不命中 identity rule（no match → heuristic fallback）", async () => {
    const snapshot = await loadSnapshot("system-tools-overhead");
    // system[1] 才是 identity block（system[0] 是 billing noise）
    const rawBody = snapshot.metadata!.rawBody as Record<string, unknown>;
    const systemBlocks = rawBody.system as Array<{ text: string }>;
    const identityIdx = systemBlocks.findIndex((b) =>
      b.text?.startsWith("You are Claude Code, Anthropic's official CLI for Claude."),
    );
    expect(identityIdx).toBeGreaterThanOrEqual(0);
    systemBlocks[identityIdx].text = "You are Claude Code, Anthropic's official CLI for Claude";
    const attributions = inferClaudeProxyAttributions(snapshot);
    const identityAttr = attributions.find((a) => a.ruleId === "claude-code.system-prompt-identity.v1");
    // 少句号版本不应命中 identity rule
    expect(identityAttr).toBeUndefined();
  });

  // location.order=0 指"首个非 billing system block"，不是原始索引 0。
  // billing noise 之后的 system[1] 仍然是 nonBillingOrder=0，应命中 identity rule。
  test("billing noise 之后的 system[1] 是首个非 billing block，仍然命中 identity rule", async () => {
    const snapshot = await loadSnapshot("system-tools-overhead");
    const rawBody = snapshot.metadata!.rawBody as Record<string, unknown>;
    const systemBlocks = rawBody.system as Array<{ text: string }>;
    systemBlocks[0] = { text: "x-anthropic-billing-header: billing data" };
    if (systemBlocks.length > 1) {
      systemBlocks[1] = { text: "You are Claude Code, Anthropic's official CLI for Claude." };
    }
    const attributions = inferClaudeProxyAttributions(snapshot);
    const identityAttr = attributions.find((a) => a.ruleId === "claude-code.system-prompt-identity.v1");
    expect(identityAttr).toBeDefined();
  });

  // 只有 identity pattern 出现在第二个非 billing block（nonBillingOrder=1）才不命中
  // 新设计：location 约束只用 section=system + segmentPosition=segment_start，
  // 不依赖绝对/相对索引。identity pattern 在 system[] 任意位置出现均命中。
  // （sourcemap 保证 harness 把它放在 billing 之后；但 attribution 不靠位置区分，靠 pattern。）
  test("identity pattern 在 system[] 任意索引均命中（不依赖绝对位置）", async () => {
    const snapshot = await loadSnapshot("system-tools-overhead");
    const rawBody = snapshot.metadata!.rawBody as Record<string, unknown>;
    const systemBlocks = rawBody.system as Array<{ text: string }>;
    systemBlocks[0] = { text: "x-anthropic-billing-header: billing data" };
    systemBlocks[1] = { text: "Some other system content, not identity." };
    if (systemBlocks.length > 2) {
      systemBlocks[2] = { text: "You are Claude Code, Anthropic's official CLI for Claude." };
    }
    const attributions = inferClaudeProxyAttributions(snapshot);
    const identityAttr = attributions.find((a) => a.ruleId === "claude-code.system-prompt-identity.v1");
    // 应当命中：pattern 正确，section=system 满足
    expect(identityAttr).toBeDefined();
    expect(identityAttr!.confidence).toBe("exact");
  });
});

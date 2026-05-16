import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { attributeWithJsonl } from "./index";
import type { LinkableJsonlEvent } from "./attribution/jsonl-linker";
import { withBillingHeader } from "./attribution/test-fixtures";

function digest16(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

// Step 2：matcher 给 image content block 分配命名 slot "messages.block.image"。
// 验证：blk.type === "image" 不再落入 UNKNOWN_SLOT.MESSAGES_BLOCK 兜底，
// 且 rawText 保留完整 JSON 字面量（含 base64 data，供后续 rule + jsonl-linker 使用）。

function makeImageBlock(): { type: "image"; source: { type: "base64"; media_type: string; data: string } } {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: "image/png",
      // 用最短合法 base64 占位（实际不解码，仅作为 rawText 字面）
      data: "iVBORw0KGgoAAAANSUhEUg",
    },
  };
}

function makeReqBodyWithImage() {
  return withBillingHeader({
    system: [
      { type: "text" as const, text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: "text" as const, text: "Prelude.\n# Doing tasks\nDo stuff.\n" },
    ],
    tools: [{ name: "Read", description: "Read a file", input_schema: {} }],
    messages: [
      // user message 同时含 text 和 image，对齐 JSONL 真实形态（content_types: ['text','image']）
      {
        role: "user",
        content: [
          { type: "text", text: "看一下这张图" },
          makeImageBlock(),
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "好的。" }] },
    ],
  });
}

describe("matcher — image content block slot 分配", () => {
  it("user message 里的 image block 应被分配到 messages.block.image slot", () => {
    const { snapshot } = attributeWithJsonl({
      reqBody: makeReqBodyWithImage(),
      proxyFile: "t.json",
      jsonl: [],
      call: { callId: 1, turnId: 2 },
    });

    const imageNodes = Object.values(snapshot.index).filter((n) => n.slotType === "messages.block.image");
    expect(imageNodes).toHaveLength(1);

    const node = imageNodes[0]!;
    expect(node.wireMeta?.messageRole).toBe("user");
    expect(node.wireMeta?.messageIdx).toBe(0);

    // rawText 应保留完整 JSON 字面量（含 source.data）。
    const parsed = JSON.parse(node.rawText);
    expect(parsed.type).toBe("image");
    expect(parsed.source.type).toBe("base64");
    expect(parsed.source.media_type).toBe("image/png");
    expect(parsed.source.data).toBe("iVBORw0KGgoAAAANSUhEUg");
  });

  it("不再有任何 messages.block.unknown 节点（image 不再走兜底）", () => {
    const { snapshot } = attributeWithJsonl({
      reqBody: makeReqBodyWithImage(),
      proxyFile: "t.json",
      jsonl: [],
      call: { callId: 1, turnId: 2 },
    });

    const unknownBlocks = Object.values(snapshot.index).filter((n) => n.slotType === "messages.block.unknown");
    expect(unknownBlocks).toHaveLength(0);
  });
});

describe("Step 3 — image rule 识别", () => {
  it("image node 应被 claude-code.messages.image.v1 命中，captureGroups 提取 sourceType + mediaType", () => {
    const { snapshot } = attributeWithJsonl({
      reqBody: makeReqBodyWithImage(),
      proxyFile: "t.json",
      jsonl: [],
      call: { callId: 1, turnId: 2 },
    });

    const node = Object.values(snapshot.index).find((n) => n.slotType === "messages.block.image");
    expect(node).toBeDefined();
    expect(node!.origin.kind).toBe("rule");

    if (node!.origin.kind === "rule") {
      expect(node!.origin.ruleId).toBe("claude-code.messages.image.v1");
      expect(node!.origin.matchMode).toBe("regex");

      const fields = node!.origin.dynamicFields ?? [];
      const byName = new Map(fields.map((f) => [f.name, f.valuePreview]));
      expect(byName.get("sourceType")).toBe("base64");
      expect(byName.get("mediaType")).toBe("image/png");
    }
  });
});

describe("Step 4 — image jsonl-linker", () => {
  it("image digest 匹配 JSONL user event → JsonlOrigin definitive", () => {
    const imageBlock = makeImageBlock();
    const expectedDigest = digest16(imageBlock.source.data);

    const jsonl: LinkableJsonlEvent[] = [
      {
        lineIdx: 5,
        type: "user",
        userText: "看一下这张图",
        userImages: [
          { digest: expectedDigest, mediaType: imageBlock.source.media_type, sourceType: "base64" },
        ],
        callId: 1,
        turnId: 2,
      },
    ];

    const { snapshot, linkReport } = attributeWithJsonl({
      reqBody: makeReqBodyWithImage(),
      proxyFile: "t.json",
      jsonl,
      call: { callId: 1, turnId: 2 },
    });

    expect(linkReport.matched.userImage).toBe(1);

    const node = Object.values(snapshot.index).find((n) => n.slotType === "messages.block.image");
    expect(node).toBeDefined();
    expect(node!.origin.kind).toBe("jsonl");

    if (node!.origin.kind === "jsonl") {
      expect(node!.origin.eventKind.source).toBe("user_input");
      expect(node!.origin.eventKind.contentType).toBe("image");
      expect(node!.origin.confidence).toBe("definitive");
      expect(node!.origin.fullyCovered).toBe(true);
      expect(node!.origin.jsonlLineIdx).toBe(5);
    }
  });

  it("digest 不匹配（不同图片）→ image node 保留 RuleOrigin，未 link", () => {
    const jsonl: LinkableJsonlEvent[] = [
      {
        lineIdx: 5,
        type: "user",
        userText: "另一张图",
        userImages: [
          { digest: "0000000000000000", mediaType: "image/jpeg", sourceType: "base64" },
        ],
        callId: 1,
        turnId: 2,
      },
    ];

    const { snapshot, linkReport } = attributeWithJsonl({
      reqBody: makeReqBodyWithImage(),
      proxyFile: "t.json",
      jsonl,
      call: { callId: 1, turnId: 2 },
    });

    expect(linkReport.matched.userImage).toBe(0);

    const node = Object.values(snapshot.index).find((n) => n.slotType === "messages.block.image");
    expect(node).toBeDefined();
    // 未命中 jsonl，应保留 Step 3 写入的 RuleOrigin
    expect(node!.origin.kind).toBe("rule");
    if (node!.origin.kind === "rule") {
      expect(node!.origin.ruleId).toBe("claude-code.messages.image.v1");
    }
  });
});

// Opus 4.7 风格的 redacted thinking：thinking 字段空串、signature 携带密文。
// 这种块在 wire 上确实占字节、确实计 prompt input token，不应在 attribution 里
// 显示为 0 chars。matcher 把 signature 落进 rawText，让 charCount 反映真实占用，
// 同时通过 wireMeta.thinkingSignature 保留 join key。
describe("matcher — redacted thinking (Opus 4.7 风格)", () => {
  function makeReqBodyWithRedactedThinking(signature: string) {
    return withBillingHeader({
      tools: [{ name: "Read", description: "Read a file", input_schema: {} }],
      messages: [
        { role: "user", content: [{ type: "text", text: "继续" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "", signature },
            { type: "text", text: "ok" },
          ],
        },
      ],
    });
  }

  it("thinking 字段为空、signature 非空时 → rawText = signature，charCount = signature.length", () => {
    const sig = "EskCClkIDRgC" + "x".repeat(436);
    const { snapshot } = attributeWithJsonl({
      reqBody: makeReqBodyWithRedactedThinking(sig),
      proxyFile: "t.json",
      jsonl: [],
      call: { callId: 1, turnId: 2 },
    });

    const node = Object.values(snapshot.index).find((n) => n.slotType === "messages.thinking");
    expect(node).toBeDefined();
    expect(node!.rawText).toBe(sig);
    expect(node!.charCount).toBe(sig.length);
    expect(node!.wireMeta?.thinkingSignature).toBe(sig);
  });

  it("老 Sonnet 风格（thinking 非空）→ rawText 仍是思考正文，行为不变", () => {
    const reqBody = {
      tools: [{ name: "Read", description: "Read a file", input_schema: {} }],
      messages: [
        { role: "user", content: [{ type: "text", text: "继续" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "let me think about this", signature: "sig-xyz" },
            { type: "text", text: "ok" },
          ],
        },
      ],
    };
    const { snapshot } = attributeWithJsonl({
      reqBody,
      proxyFile: "t.json",
      jsonl: [],
      call: { callId: 1, turnId: 2 },
    });

    const node = Object.values(snapshot.index).find((n) => n.slotType === "messages.thinking");
    expect(node).toBeDefined();
    expect(node!.rawText).toBe("let me think about this");
    expect(node!.wireMeta?.thinkingSignature).toBe("sig-xyz");
  });
});

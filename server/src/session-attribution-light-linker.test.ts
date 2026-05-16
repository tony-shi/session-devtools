import { describe, it, expect } from "vitest";
import {
  buildEventIndex,
  computeImageDigest,
  linkMessage,
  linkMessages,
  messageFingerprint,
  sharedPrefixLength,
} from "./session-attribution-light-linker";
import type { LinkableJsonlEvent } from "./context-ledger/parser";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const sampleEvents: LinkableJsonlEvent[] = [
  { lineIdx: 0, type: "user", userText: "hello, what's in this repo?" },
  {
    lineIdx: 1, type: "assistant",
    assistantText: "Let me check.",
    toolUses: [{ id: "toolu_A", name: "Bash" }],
  },
  {
    lineIdx: 2, type: "user",
    toolResults: [{ toolUseId: "toolu_A", contentText: "package.json\nREADME.md" }],
  },
  {
    lineIdx: 3, type: "assistant",
    assistantText: "It's a TypeScript repo.",
    thinkingBlocks: [{ signature: "sig_T1", content: "thinking..." }],
  },
  {
    lineIdx: 4, type: "user",
    commandText: "/clear",
  },
];

// ─── buildEventIndex ─────────────────────────────────────────────────────────

describe("buildEventIndex", () => {
  it("indexes all match channels", () => {
    const idx = buildEventIndex(sampleEvents);
    expect(idx.byToolUseId.get("toolu_A")).toBe(1);
    expect(idx.byToolResultId.get("toolu_A")).toBe(2);
    expect(idx.byThinkingSignature.get("sig_T1")).toBe(3);
    // Text hashes — same input string must always hash the same; check via
    // round-trip rather than asserting the hash value itself.
    expect(idx.byUserTextHash.size).toBeGreaterThanOrEqual(1);
    expect(idx.byAssistantTextHash.size).toBeGreaterThanOrEqual(2);
    expect(idx.byCommandTextHash.size).toBe(1);
  });

  it("on duplicate keys keeps the EARLIEST lineIdx (first-seen semantics)", () => {
    const dup: LinkableJsonlEvent[] = [
      { lineIdx: 5, type: "user", userText: "ping" },
      { lineIdx: 10, type: "user", userText: "ping" },
    ];
    const idx = buildEventIndex(dup);
    // Same text → same hash; should map to lineIdx 5 (earlier), not 10.
    const hashSize = idx.byUserTextHash.size;
    expect(hashSize).toBe(1);
    const firstAndOnlyValue = [...idx.byUserTextHash.values()][0];
    expect(firstAndOnlyValue).toBe(5);
  });
});

// ─── linkMessage / linkMessages ───────────────────────────────────────────

describe("linkMessage", () => {
  const idx = buildEventIndex(sampleEvents);

  it("matches tool_use.id → jsonl.toolUses", () => {
    const m = { role: "assistant", content: [{ type: "tool_use", id: "toolu_A", name: "Bash", input: {} }] };
    expect([...linkMessage(m, idx)]).toEqual([1]);
  });

  it("matches tool_result.tool_use_id → jsonl.toolResults", () => {
    const m = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_A", content: "..." }],
    };
    expect([...linkMessage(m, idx)]).toEqual([2]);
  });

  it("matches assistant text by content hash", () => {
    const m = {
      role: "assistant",
      content: [{ type: "text", text: "It's a TypeScript repo." }],
    };
    expect([...linkMessage(m, idx)]).toEqual([3]);
  });

  it("matches user text by content hash", () => {
    const m = {
      role: "user",
      content: [{ type: "text", text: "hello, what's in this repo?" }],
    };
    expect([...linkMessage(m, idx)]).toEqual([0]);
  });

  it("matches user command text (slash command)", () => {
    const m = {
      role: "user",
      content: [{ type: "text", text: "/clear" }],
    };
    expect([...linkMessage(m, idx)]).toEqual([4]);
  });

  it("matches thinking signature", () => {
    const m = {
      role: "assistant",
      content: [{ type: "thinking", signature: "sig_T1", thinking: "..." }],
    };
    expect([...linkMessage(m, idx)]).toEqual([3]);
  });

  it("returns empty for messages with no matching content", () => {
    const m = {
      role: "user",
      content: [{ type: "text", text: "this string never appeared in jsonl" }],
    };
    expect(linkMessage(m, idx).size).toBe(0);
  });

  it("handles string content (legacy single-text shape)", () => {
    const m = { role: "user", content: "hello, what's in this repo?" };
    expect([...linkMessage(m, idx)]).toEqual([0]);
  });

  it("matches image block by base64 sha256-16 digest", () => {
    // Build an index that contains the *same* digest the linker will compute
    // for the API block below, so we know we go through the digest path.
    // (Digest is deterministic; helper exported for testability.)
    const base64Data = "AAAAFakeImageDataAAAA";
    const dig = computeImageDigest({ type: "base64", data: base64Data })!;
    const idxImg = buildEventIndex([
      ...sampleEvents,
      {
        lineIdx: 8, type: "user",
        userImages: [{ digest: dig, mediaType: "image/png", sourceType: "base64" }],
      },
    ]);
    const m = {
      role: "user",
      content: [{
        type: "image",
        source: { type: "base64", media_type: "image/png", data: base64Data },
      }],
    };
    expect([...linkMessage(m, idxImg)]).toEqual([8]);
  });

  it("matches image block by url digest", () => {
    const url = "https://example.com/img.png";
    const dig = computeImageDigest({ type: "url", url })!;
    const idxImg = buildEventIndex([
      { lineIdx: 0, type: "user",
        userImages: [{ digest: dig, sourceType: "url" }] },
    ]);
    const m = {
      role: "user",
      content: [{ type: "image", source: { type: "url", url } }],
    };
    expect([...linkMessage(m, idxImg)]).toEqual([0]);
  });
});

describe("linkMessages", () => {
  const idx = buildEventIndex(sampleEvents);

  it("unions matched lineIdxs across multiple messages", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hello, what's in this repo?" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_A" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_A", content: "..." }] },
    ];
    expect([...linkMessages(messages as never[], idx)].sort()).toEqual([0, 1, 2]);
  });
});

// ─── Fingerprint / prefix detection ──────────────────────────────────────

describe("messageFingerprint", () => {
  it("is deterministic", () => {
    const m = { role: "assistant", content: [{ type: "text", text: "hello" }] };
    expect(messageFingerprint(m as never)).toBe(messageFingerprint(m as never));
  });

  it("distinguishes messages by role", () => {
    const a = { role: "user", content: [{ type: "text", text: "x" }] };
    const b = { role: "assistant", content: [{ type: "text", text: "x" }] };
    expect(messageFingerprint(a as never)).not.toBe(messageFingerprint(b as never));
  });

  it("distinguishes messages by text", () => {
    const a = { role: "user", content: [{ type: "text", text: "alpha" }] };
    const b = { role: "user", content: [{ type: "text", text: "beta" }] };
    expect(messageFingerprint(a as never)).not.toBe(messageFingerprint(b as never));
  });

  it("uses tool_use.id, not name, for fingerprint", () => {
    const a = { role: "assistant", content: [{ type: "tool_use", id: "toolu_X", name: "Bash" }] };
    const b = { role: "assistant", content: [{ type: "tool_use", id: "toolu_Y", name: "Bash" }] };
    expect(messageFingerprint(a as never)).not.toBe(messageFingerprint(b as never));
  });

  it("ignores image base64 payloads (only structural slot)", () => {
    const a = { role: "user", content: [{ type: "image", source: { data: "AAAAAAAA..." } }] };
    const b = { role: "user", content: [{ type: "image", source: { data: "BBBBBBBB..." } }] };
    // Same structural shape; fingerprints equal. This is intentional —
    // we don't waste cycles hashing megabyte image payloads when the
    // prefix-detection consumer only needs structural match.
    expect(messageFingerprint(a as never)).toBe(messageFingerprint(b as never));
  });
});

describe("sharedPrefixLength", () => {
  it("returns 0 for completely different arrays", () => {
    expect(sharedPrefixLength(["a", "b"], ["x", "y"])).toBe(0);
  });

  it("returns full length when one is a prefix of the other", () => {
    expect(sharedPrefixLength(["a", "b"], ["a", "b", "c"])).toBe(2);
  });

  it("returns 0 for empty arrays", () => {
    expect(sharedPrefixLength([], ["a"])).toBe(0);
    expect(sharedPrefixLength(["a"], [])).toBe(0);
  });

  it("stops at first divergence", () => {
    expect(sharedPrefixLength(["a", "b", "c"], ["a", "b", "X"])).toBe(2);
  });
});

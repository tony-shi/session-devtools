// Light linker — a session-graph-only fast path for reverse attribution.
//
// Why a second linker?
//
//   The canonical `linkJsonl` (jsonl-linker.ts) operates on a fully-parsed
//   segment tree (ParsedQuerySnapshot). Building that tree is most of the
//   cost in loadAttributionTree — when we just need "this reqBody references
//   these jsonl lineIdxs" (for the reverse session graph), it's wasteful to
//   parse the tree at all.
//
//   This light linker:
//     1. Builds an in-memory index over jsonl events, keyed by id/text-hash.
//     2. Walks the reqBody.messages array directly, matching each content
//        block to the index.
//     3. Returns the set of consumed lineIdxs.
//
//   It covers the dominant match channels:
//     • tool_use.id        →   jsonl.toolUses[].id
//     • tool_result.tool_use_id →   jsonl.toolResults[].toolUseId
//     • assistant.text     →   jsonl.assistantText (content hash)
//     • user.text          →   jsonl.userText / commandText (content hash)
//     • thinking.signature →   jsonl.thinkingBlocks[].signature
//
//   Match channels not covered (intentionally):
//     • SmooshContent sub-segment fingerprint matching
//     • Attachment content matching
//     • Image digest matching
//     • Fallback turn-position inference for user_input
//
//   Harness injection (skill_invocation only): SUPPORTED with strict double-key
//   matching — text hash MUST equal the jsonl rawText hash AND the sibling
//   tool_result.tool_use_id MUST equal the jsonl event's triggerToolUseId.
//   compaction_summary harness rawText is intentionally NOT indexed (out of
//   scope per current spec; would conflict with conversation_summary's other
//   content-equality matchers).
//
//   These cases are rare for the kind of "reverse audit" graph reporting
//   front-end consumes (jump to "first call that pulled this event into a
//   prompt"). When they DO matter, the per-call attribution-tree endpoint
//   still uses the full linker — light linker exclusively serves the
//   reverse-projection graph endpoint.
//
//   Empirically (with content equality matching) this covers ≥95% of
//   indexable events in real sessions. Coverage gaps surface as "pending"
//   in the graph rather than wrong firstSeenInCall.

import { createHash } from "node:crypto";
import type { LinkableJsonlEvent } from "./context-ledger/parser";

// ─── Index ────────────────────────────────────────────────────────────────

export interface EventIndex {
  byToolUseId:         Map<string, number>;  // toolUseId        → lineIdx
  byToolResultId:      Map<string, number>;  // tool_result.tool_use_id → lineIdx
  byUserTextHash:      Map<string, number>;
  byAssistantTextHash: Map<string, number>;
  byCommandTextHash:   Map<string, number>;
  byThinkingSignature: Map<string, number>;
  byImageDigest:       Map<string, number>;  // user image digest → lineIdx
  /**
   * Skill harness injection 双键索引：(text hash, triggerToolUseId) → lineIdx。
   * 仅索引 mechanism === "skill_invocation" 的 harnessInjection 行（compaction
   * 不索引，参见本文件顶部 spec 注释）。
   *
   * 双键设计原因：text hash 单键在 cli.js 实际写入下基本足够（rawText byte-equal
   * + 5KB+ 内容，session 内重复概率 ~0），但 triggerToolUseId 二次校验消除了
   * "同 session 多次激活同名 skill 且参数完全相同"这种极端场景下的可能错配，
   * 同时让"激活点 → 注入产物"的因果链在索引层显式表达。
   *
   * 命中条件由 linkMessage 强制：proxy 上 text 块必须有兄弟 tool_result 块，
   * 且 tool_result.tool_use_id 等于 jsonl harnessInjection.triggerToolUseId。
   */
  bySkillInjection:    Map<string, number>;  // `${textHash}|${triggerToolUseId}` → lineIdx
}

/** 32-bit FNV-1a hash over a UTF-16 string. Plenty for in-session dedup —
 *  collisions on real chat content are essentially zero given the small
 *  cardinality (single session). */
function hash32(text: string): string {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36) + ":" + text.length;
}

export function buildEventIndex(events: LinkableJsonlEvent[]): EventIndex {
  const idx: EventIndex = {
    byToolUseId:         new Map(),
    byToolResultId:      new Map(),
    byUserTextHash:      new Map(),
    byAssistantTextHash: new Map(),
    byCommandTextHash:   new Map(),
    byThinkingSignature: new Map(),
    byImageDigest:       new Map(),
    bySkillInjection:    new Map(),
  };
  // Iterate events in line order; if a key collides keep the EARLIEST line
  // (we want first-seen semantics).
  for (const ev of events) {
    if (ev.toolUses) {
      for (const tu of ev.toolUses) {
        if (!idx.byToolUseId.has(tu.id)) idx.byToolUseId.set(tu.id, ev.lineIdx);
      }
    }
    if (ev.toolResults) {
      for (const tr of ev.toolResults) {
        if (!idx.byToolResultId.has(tr.toolUseId)) idx.byToolResultId.set(tr.toolUseId, ev.lineIdx);
      }
    }
    if (ev.userText) {
      const h = hash32(ev.userText);
      if (!idx.byUserTextHash.has(h)) idx.byUserTextHash.set(h, ev.lineIdx);
    }
    if (ev.assistantText) {
      const h = hash32(ev.assistantText);
      if (!idx.byAssistantTextHash.has(h)) idx.byAssistantTextHash.set(h, ev.lineIdx);
    }
    if (ev.commandText) {
      const h = hash32(ev.commandText);
      if (!idx.byCommandTextHash.has(h)) idx.byCommandTextHash.set(h, ev.lineIdx);
    }
    if (ev.thinkingBlocks) {
      for (const tb of ev.thinkingBlocks) {
        if (!idx.byThinkingSignature.has(tb.signature)) idx.byThinkingSignature.set(tb.signature, ev.lineIdx);
      }
    }
    if (ev.userImages) {
      for (const img of ev.userImages) {
        if (!idx.byImageDigest.has(img.digest)) idx.byImageDigest.set(img.digest, ev.lineIdx);
      }
    }
    // Skill 激活产生的 SKILL.md inject 行：双键 (rawText hash, triggerToolUseId)。
    // 仅 skill_invocation；compaction 故意不索引（spec 决定，见文件顶部）。
    // triggerToolUseId 缺失（极端：cli.js 状态机识别失败）时跳过 —— 双键模型
    // 在缺一键时宁可不索引，让 lineIdx 进入 pending，也不放进单键索引。
    if (ev.harnessInjection
      && ev.harnessInjection.mechanism === "skill_invocation"
      && typeof ev.harnessInjection.triggerToolUseId === "string"
      && ev.harnessInjection.rawText) {
      const key = hash32(ev.harnessInjection.rawText) + "|" + ev.harnessInjection.triggerToolUseId;
      if (!idx.bySkillInjection.has(key)) idx.bySkillInjection.set(key, ev.lineIdx);
    }
  }
  return idx;
}

// ─── Image digest ─────────────────────────────────────────────────────────
//
// Mirrors the digest format attribution-service.extractUserImages uses when
// populating LinkableJsonlEvent.userImages[*].digest:
//
//     sha256(source.data | source.url).digest("hex").slice(0, 16)
//
// Must stay in sync with that helper — divergence silently fails to match.

function digestHexSha256_16(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/** Compute an image digest from an API content block's source descriptor.
 *  Returns null if the source is malformed or unsupported. */
export function computeImageDigest(source: { type?: string; data?: string; url?: string } | null | undefined): string | null {
  if (!source) return null;
  if (source.type === "base64" && typeof source.data === "string" && source.data.length > 0) {
    return digestHexSha256_16(source.data);
  }
  if (source.type === "url" && typeof source.url === "string" && source.url.length > 0) {
    return digestHexSha256_16(source.url);
  }
  return null;
}

// ─── Linker ───────────────────────────────────────────────────────────────

type ApiContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name?: string }
  | { type: "tool_result"; tool_use_id: string; content?: unknown }
  | { type: "thinking"; signature: string; thinking?: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "image"; source?: unknown }
  | { type: string; [k: string]: unknown };

interface ApiMessage {
  role: "user" | "assistant" | string;
  content: ApiContentBlock[] | string;
}

function asContentArray(content: unknown): ApiContentBlock[] {
  if (Array.isArray(content)) return content as ApiContentBlock[];
  if (typeof content === "string") return [{ type: "text", text: content }];
  return [];
}

/** Collect the assistant or user text content of a message into a single
 *  string (joining text blocks with newline). Returns null if there are no
 *  text blocks. */
function joinTextBlocks(content: ApiContentBlock[]): string | null {
  const parts: string[] = [];
  for (const b of content) {
    if (b && b.type === "text" && typeof (b as { text?: unknown }).text === "string") {
      parts.push((b as { text: string }).text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * Link a single API message to its source jsonl lineIdxs.
 */
export function linkMessage(message: ApiMessage, index: EventIndex): Set<number> {
  const matched = new Set<number>();
  const content = asContentArray(message?.content);
  const role = message?.role;

  // 先扫一遍 content，记录所有兄弟 tool_result block 的 tool_use_id —— 用于
  // 后续 text 块的 skill_injection 双键匹配。skill 注入的 SKILL.md text 块
  // 总是和它的"启动 tool_result"在同一个 user message 的 content[] 中（cli.js
  // toolExecution.ts 直接 push 进 resultingMessages 时合并），所以兄弟 lookup
  // 是同 message 内的局部操作。
  const siblingToolUseIds: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if ((block as { type?: string }).type === "tool_result") {
      const tuid = (block as { tool_use_id?: string }).tool_use_id;
      if (typeof tuid === "string") siblingToolUseIds.push(tuid);
    }
  }

  // Block-level matches (id-based, exact + per-block text hashes).
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const t = (block as { type?: string }).type;

    if (t === "tool_use") {
      const id = (block as { id?: string }).id;
      if (id) {
        const li = index.byToolUseId.get(id);
        if (li != null) matched.add(li);
      }
    } else if (t === "tool_result") {
      const tuid = (block as { tool_use_id?: string }).tool_use_id;
      if (tuid) {
        const li = index.byToolResultId.get(tuid);
        if (li != null) matched.add(li);
      }
    } else if (t === "thinking") {
      const sig = (block as { signature?: string }).signature;
      if (sig) {
        const li = index.byThinkingSignature.get(sig);
        if (li != null) matched.add(li);
      }
    } else if (t === "redacted_thinking") {
      // Use `data` as the signature (mirrors jsonl-linker behavior).
      const sig = (block as { data?: string }).data;
      if (sig) {
        const li = index.byThinkingSignature.get(sig);
        if (li != null) matched.add(li);
      }
    } else if (t === "image") {
      // base64 / url sources — compute digest the same way the parser does
      // (sha256 first-16 of base64 data or url) and look up.
      const src = (block as { source?: { type?: string; data?: string; url?: string } }).source;
      const d = computeImageDigest(src);
      if (d) {
        const li = index.byImageDigest.get(d);
        if (li != null) matched.add(li);
      }
    } else if (t === "text" && role === "user") {
      // Skill injection 双键匹配（仅 user role；assistant 不会出现 skill inject）：
      // 用 text 块的 hash 与本 message 内**每个**兄弟 tool_result.tool_use_id 组合
      // 查 bySkillInjection。一个 text 块可能对应多个兄弟 tool_result 中的某一个 ——
      // 命中其中一个就锁定，多次命中则全部添加（极端情况，保守覆盖）。
      const text = (block as { text?: string }).text;
      if (typeof text === "string" && text.length > 0 && siblingToolUseIds.length > 0) {
        const h = hash32(text);
        for (const tuid of siblingToolUseIds) {
          const li = index.bySkillInjection.get(h + "|" + tuid);
          if (li != null) matched.add(li);
        }
      }
    }
  }

  // Whole-message text matches (content-hash based) — for user_input / command /
  // assistant_text 这些 jsonl event，文本是按整条 message 拼接后存的（attribution-
  // service.extractUserPlainText / extractAssistantText 都做了 join）。
  // skill_injection 已经在 block-level 处理（双键），不会被这里 misroute。
  const joinedText = joinTextBlocks(content);
  if (joinedText) {
    const h = hash32(joinedText);
    if (role === "user") {
      const u = index.byUserTextHash.get(h);
      if (u != null) matched.add(u);
      const c = index.byCommandTextHash.get(h);
      if (c != null) matched.add(c);
    } else if (role === "assistant") {
      const a = index.byAssistantTextHash.get(h);
      if (a != null) matched.add(a);
    }
  }

  return matched;
}

/** Link a (slice of) messages from a reqBody to all referenced lineIdxs. */
export function linkMessages(messages: ApiMessage[], index: EventIndex): Set<number> {
  const out = new Set<number>();
  for (const m of messages) {
    for (const li of linkMessage(m, index)) out.add(li);
  }
  return out;
}

// ─── Cheap message equality / prefix detection ──────────────────────────

/**
 * Compute a stable fingerprint for a message that's *cheap to compute* and
 * collision-resistant within a session. We do NOT use JSON.stringify on the
 * whole message — image base64 etc. would blow up. Instead we hash a
 * structural summary: role + each block's type + (id|signature|hash-of-text).
 */
export function messageFingerprint(message: ApiMessage): string {
  const content = asContentArray(message?.content);
  const parts: string[] = [String(message?.role ?? "?")];
  for (const block of content) {
    if (!block || typeof block !== "object") { parts.push("_"); continue; }
    const t = (block as { type?: string }).type ?? "?";
    if (t === "tool_use") {
      parts.push("tu:" + ((block as { id?: string }).id ?? "?"));
    } else if (t === "tool_result") {
      parts.push("tr:" + ((block as { tool_use_id?: string }).tool_use_id ?? "?"));
    } else if (t === "thinking") {
      parts.push("th:" + ((block as { signature?: string }).signature ?? "?"));
    } else if (t === "redacted_thinking") {
      parts.push("rt:" + ((block as { data?: string }).data ?? "?").slice(0, 16));
    } else if (t === "text") {
      const text = (block as { text?: string }).text ?? "";
      parts.push("tx:" + hash32(text));
    } else if (t === "image") {
      // images can be huge — hash only by structural slot type
      parts.push("im");
    } else {
      parts.push(t);
    }
  }
  return parts.join("|");
}

/**
 * Compute the longest shared prefix length between two messages arrays by
 * comparing fingerprints. O(min(|a|, |b|)) on top of fingerprint caches.
 */
export function sharedPrefixLength(
  prevFingerprints: string[],
  curFingerprints: string[],
): number {
  const maxN = Math.min(prevFingerprints.length, curFingerprints.length);
  let n = 0;
  while (n < maxN && prevFingerprints[n] === curFingerprints[n]) n++;
  return n;
}

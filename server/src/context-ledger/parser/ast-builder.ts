// ast-builder：把 matcher 产出的顶层 SlotMatch 转成 ParsedQuerySnapshot（AST 结构）
// 主要职责：
//   1. 给每个节点分配稳定 id（按 section + 出现顺序，规则与重构前 segments 数组一致）
//   2. 计算 rawHash（sha256 前 16 位）和 charCount
//   3. 基于 template 展开 H1 section / inline tag 等二级结构
//   4. 递归构建 SegmentNode 树，同时填充 index（所有节点平铺，O(1) 查找）

import { createHash } from "crypto";
import type { SlotMatch, SegmentNode, ParsedQuerySnapshot } from "./types";
import { UNKNOWN_SLOT, isUnknownSlotId } from "./types";
import type { RequestTemplate, TemplateSlot } from "../template/types";
import { originContainer, originStructural, originUnknown } from "./attribution/origin";

// ─────────────────────────────────────────────────────────────────────────────
// id 命名规则（与重构前 segments 数组严格一致，保证 index 里 id 不变）
//   系统 block，无 H1 切分         seg-system-{i}
//   系统 block，H1 切分子 section  seg-system-{i}-s{si}
//   tool                           seg-tool-{i}
//   message block                  seg-msg-{mi}-{bi}
//   message inline 切分            seg-msg-{mi}-{bi}-inline-{ii}
// ─────────────────────────────────────────────────────────────────────────────

export function buildParsedQuerySnapshot(params: {
  allSlotMatches: SlotMatch[];
  template: RequestTemplate;
  queryKind: "main_session" | "side_query" | "unknown";
  proxyFile: string;
  ts: string;
  attributionContext: import("./attribution/context").AttributionContextResult;
}): ParsedQuerySnapshot {
  const { allSlotMatches, template, queryKind, proxyFile, ts, attributionContext } = params;

  const roots: SegmentNode[] = [];
  const index: Record<string, SegmentNode> = {};

  // 各 section 的递增 index（与重构前逻辑相同）
  let systemIdx = 0;
  let toolIdx = 0;

  // ── 递归构建节点 ────────────────────────────────────────────────────────────
  // childIdOf：根据父节点的 slotType 决定子节点 id 后缀规则
  //   system.main-prompt-block 的子节点 → -s{ci}（H1 section）
  //   messages.text 的子节点            → -inline-{ci}
  //   messages.tool_result 的子节点     → -inline-{ci}（与 messages.text 同规则；
  //                                       SmooshContent v2 切分尾部 SR 段）
  //   其他                               → -c{ci}（兜底，目前不触发）
  function childIdOf(parentId: string, parentSlotType: string, ci: number): string {
    if (parentSlotType === "system.main-prompt-block") return `${parentId}-s${ci}`;
    if (parentSlotType === "messages.text") return `${parentId}-inline-${ci}`;
    if (parentSlotType === "messages.tool_result") return `${parentId}-inline-${ci}`;
    return `${parentId}-c${ci}`;
  }

  function toNode(
    id: string,
    match: SlotMatch,
    parentId?: string,
    inheritedCachePolicy?: import("./types").CachePolicy,
    inheritedWireMeta?: import("./types").WireMeta,
  ): SegmentNode {
    // cachePolicy 优先使用 match 自身携带的值（顶层 block 由 matcher 填入）；
    // 子节点（H1 section 等 wire 内部切分）自身无 cache_control，继承父节点的值。
    const cachePolicy = match.cachePolicy ?? inheritedCachePolicy;
    // wireMeta 同理：message 顶层节点由 matcher 填入 (messageIdx/role/toolUseId)；
    // inline 切分等子节点不丢失消息坐标，从父节点继承。
    const wireMeta = match.wireMeta ?? inheritedWireMeta;
    const node: SegmentNode = {
      id,
      slotType: match.slotType,
      jsonPath: match.jsonPath,
      charRange: match.charRange,
      rawText: match.rawText,
      ...(match.visibility && { visibility: match.visibility }),
      rawHash: hashOf(match.rawText),
      charCount: match.rawText.length,
      children: [],
      parentId,
      ...(cachePolicy && { cachePolicy }),
      ...(match.unknownMeta && { unknownMeta: match.unknownMeta }),
      ...(wireMeta && { wireMeta }),
      // origin 占位：先按"叶子且无 rule"填 structural，下面递归完 children 后若发现是
      // container 再升级。最终 attributeSnapshot / jsonl-linker 可覆盖。
      origin: isUnknownSlotId(match.slotType)
        ? originUnknown(match.unknownMeta?.reason ?? "unknown slot")
        : originStructural(match.slotType),
    };
    // matcher 只产出顶层大块；这里根据 template 展开 H1/inline 子节点。
    // 若调用方未来传入了已有 children，优先使用它们，保证旧中间结构仍能被消费。
    const childMatches = match.children.length > 0
      ? match.children
      : expandChildren(match, template);

    node.children = childMatches.map((child, ci) =>
      toNode(childIdOf(id, match.slotType, ci), child, id, cachePolicy, wireMeta),
    );
    // 有 children 的节点是 container — 其 origin 不解释内容，由叶子负责。
    if (node.children.length > 0) {
      node.origin = originContainer(match.slotType);
    }
    index[node.id] = node;
    return node;
  }

  // ── 主循环：与重构前 segment id 分配逻辑完全一致 ───────────────────────────
  for (const match of allSlotMatches) {
    const section = sectionOf(match.slotType);

    if (section === "system" || section === "side-query-system") {
      const node = toNode(`seg-system-${systemIdx}`, match);
      roots.push(node);
      systemIdx++;
      continue;
    }

    if (section === "tools") {
      const node = toNode(`seg-tool-${toolIdx}`, match);
      roots.push(node);
      toolIdx++;
      continue;
    }

    if (section === "messages" || section === "side-query-user") {
      const { mi, bi } = parseMessagePath(match.jsonPath);
      const node = toNode(`seg-msg-${mi}-${bi}`, match);
      roots.push(node);
      continue;
    }

    // unknown section：fallback id
    const node = toNode(`seg-unknown-${roots.length}`, match);
    roots.push(node);
  }

  return { queryKind, proxyFile, ts, roots, index, attributionContext };
}

// ─────────────────────────────────────────────────────────────────────────────
// AST 子结构展开
// ─────────────────────────────────────────────────────────────────────────────

function expandChildren(match: SlotMatch, template: RequestTemplate): SlotMatch[] {
  // 2.1.154+ role:"system" mid-conversation message 常把多个 harness 注入(deferred-tools /
  // agent-types / skills)拼进同一个 block。按 anchor 句切成独立段,各自命中对应 v2 rule。
  // 无 template slot,故在 findTemplateSlot 之前处理。
  if (match.slotType === "messages.system-message") {
    return splitSystemMessage(match.rawText, match.jsonPath);
  }

  // 首条 user message 的 userContext <system-reminder>:按来源拆成 前言 / 项目指令(0..N 文件) /
  // 记忆(MEMORY.md) / 账号(email+date)。非 userContext reminder(token-usage / file-* 等)
  // → splitUserContextReminder 返回 []，保持单 leaf，行为不变(安全)。无 template slot,故在
  // findTemplateSlot 之前处理(同 messages.system-message)。
  if (match.slotType === "messages.inline.system-reminder") {
    return splitUserContextReminder(match.rawText, match.jsonPath);
  }

  const slot = findTemplateSlot(template, match.slotType);
  if (!slot?.children) return [];

  if (match.slotType === "system.main-prompt-block") {
    return splitByH1Headers(match.rawText, slot.children, match.jsonPath);
  }

  if (match.slotType === "messages.text") {
    return splitInlineTags(match.rawText, match.jsonPath, slot.children);
  }

  // SmooshContent v2：tool_result.content 字符串尾部（罕见中段）可能含
  // <system-reminder>...</system-reminder> 段。复用 splitInlineTags 同套切分逻辑
  // —— 该函数从头到尾扫描 anchor tag，命中即切独立子段，未命中区域归 free-text。
  // tool_result 中切出的 SR 子段 slotType 仍为 "messages.inline.system-reminder"，
  // 由 attribution 的 SmooshContent rule（task-reminder.v2 等 6 个）按 regex pattern
  // 命中。父节点 wireMeta.messageRole 标识上下文（user message + tool_result）。
  //
  // 预筛：tool_result 大多数情况无 SR 段（普通工具输出），此时返回空 children 让
  // tool_result 保持叶节点不变；只有真正含 SR 才进切分。这样既保持现有测试 fixture
  // 的叶节点假设不破坏，又能在 smoosh 场景切出子段。
  if (match.slotType === "messages.tool_result") {
    if (!match.rawText.includes("<system-reminder>")) return [];
    return splitInlineTags(match.rawText, match.jsonPath, slot.children);
  }

  return [];
}

function findTemplateSlot(template: RequestTemplate, slotType: string): TemplateSlot | undefined {
  const roots = [
    ...template.slots.system,
    ...template.slots.tools,
    ...template.slots.messages,
  ];

  const stack = [...roots];
  while (stack.length > 0) {
    const slot = stack.shift()!;
    if (slot.id === slotType) return slot;
    if (slot.id === "tools.builtin" && slotType.startsWith("tools.builtin.")) return slot;
    if (slot.children) stack.push(...slot.children);
  }
  return undefined;
}

/** 按行扫描 system.main-prompt-block，遇到 "# Header" 切出 H1 section。
 *  这里属于 AST builder 而非 matcher：matcher 只做 system[] 顶层大块路由；
 *  H1 是块内结构事实，需要 template.children 才能判定 known/unknown slot。
 */
/**
 * 把 H1 header 文本规范化为 slot id 末段 slug。规则:
 *   - lowercase
 *   - 非 [a-z0-9] 替换为 `-`
 *   - 合并连续 `-`,去首尾 `-`
 * 例:
 *   "Memory"               → "memory"
 *   "Harness"              → "harness"
 *   "auto memory"          → "auto-memory"
 *   "Tone and style"       → "tone-and-style"   ← 注意:与历史 "tone-style" 别名不同;
 *                                                  历史别名走 template 枚举(headerToSlot),
 *                                                  slug fallback 仅处理 template 未枚举的新 H1。
 */
export function slugifyHeader(header: string): string {
  return header
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function splitByH1Headers(
  text: string,
  childSlots: TemplateSlot[],
  parentJsonPath: string,
): SlotMatch[] {
  type H1 = { lineStart: number; lineEnd: number; header: string };
  const h1s: H1[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const lineEnd = text.indexOf("\n", cursor);
    const lineEndExclusive = lineEnd === -1 ? text.length : lineEnd;
    const line = text.slice(cursor, lineEndExclusive);
    if (line.startsWith("# ")) {
      h1s.push({
        lineStart: cursor,
        lineEnd: lineEndExclusive,
        header: line.slice(2).trim(),
      });
    }
    if (lineEnd === -1) break;
    cursor = lineEnd + 1;
  }

  const headerToSlot = new Map<string, TemplateSlot>();
  const literalSlots: TemplateSlot[] = [];
  let preludeSlot: TemplateSlot | undefined;
  let unknownSlot: TemplateSlot | undefined;
  for (const childSlot of childSlots) {
    if (!childSlot.anchor) {
      if (!preludeSlot) preludeSlot = childSlot;
      else unknownSlot = childSlot;
      continue;
    }
    if (childSlot.anchor.kind === "h1_header") {
      headerToSlot.set(childSlot.anchor.header, childSlot);
    } else if (childSlot.anchor.kind === "literal") {
      literalSlots.push(childSlot);
    }
  }

  const out: SlotMatch[] = [];

  const firstH1Start = h1s.length > 0 ? h1s[0]!.lineStart : text.length;
  if (firstH1Start > 0 && preludeSlot) {
    const rawText = text.slice(0, firstH1Start);
    if (rawText.length > 0) {
      out.push({
        slotType: preludeSlot.id,
        jsonPath: parentJsonPath,
        charRange: { start: 0, end: firstH1Start },
        rawText,
        anchorEvidence: "",
        children: [],
      });
    }
  }

  for (let i = 0; i < h1s.length; i++) {
    const h1 = h1s[i]!;
    const nextStart = i + 1 < h1s.length ? h1s[i + 1]!.lineStart : text.length;
    const rawText = text.slice(h1.lineStart, nextStart);
    // 优先用 template 枚举的 slot(显式 header → slotId 映射,处理"Tone and style"→"tone-style"
    // 这类简化别名);若未枚举(新版本新增 H1,如 # Harness/# Memory)→ slugify fallback
    // → "system.main-prompt.section.<slug>"。corpus rule 的 slotId 与 slug 派生一致时即命中。
    const enumeratedSlot = headerToSlot.get(h1.header);
    const slug = slugifyHeader(h1.header);
    const slotType = enumeratedSlot
      ? enumeratedSlot.id
      : `system.main-prompt.section.${slug}`;
    out.push({
      slotType,
      jsonPath: parentJsonPath,
      charRange: { start: h1.lineStart, end: nextStart },
      rawText,
      anchorEvidence: `# ${h1.header}`,
      children: [],
      ...(enumeratedSlot ? {} : {
        unknownMeta: {
          sectionHeader: h1.header,
          reason: `H1 派生 slug=${slug}(无 template 枚举)`,
        },
      }),
    });
  }
  // 兼容:unknownSlot 字段保留(template 仍可声明 fallback 槽);未来移除后可删
  void unknownSlot;

  // literal anchor 子 slot 的尾部剥离。
  // 注意：它只处理 wire 中确实没有独立 H1 的追加尾段，例如早期 gitStatus 形态。
  for (const litSlot of literalSlots) {
    const anchor = litSlot.anchor as { kind: "literal"; text: string };
    if (out.length === 0) continue;

    const litIdx = text.indexOf(anchor.text);
    if (litIdx === -1) continue;

    const parentIdx = out.findIndex(
      (m) => m.charRange && m.charRange.start <= litIdx && litIdx < m.charRange.end,
    );
    if (parentIdx === -1) continue;

    const parent = out[parentIdx]!;
    const parentEnd = parent.charRange!.end;

    if (litIdx > parent.charRange!.start) {
      out[parentIdx] = {
        ...parent,
        rawText: text.slice(parent.charRange!.start, litIdx),
        charRange: { start: parent.charRange!.start, end: litIdx },
      };
    } else {
      out.splice(parentIdx, 1);
    }

    out.push({
      slotType: litSlot.id,
      jsonPath: parentJsonPath,
      charRange: { start: litIdx, end: parentEnd },
      rawText: text.slice(litIdx, parentEnd),
      anchorEvidence: anchor.text,
      children: [],
    });
  }

  return out;
}

// role:"system" mid-conversation message 的 anchor 句(每个 = 一个独立 harness 注入)。
// 顺序无关(按在 text 中的实际位置排序切分)。
const SYSTEM_MESSAGE_ANCHORS = [
  "The following deferred tools are now available via ToolSearch.",
  "Available agent types for the Agent tool:",
  "The following skills are available for use with the Skill tool:",
] as const;

/**
 * 把一个 role:"system" message block 按 anchor 句切成独立段(deferred-tools / agent-types /
 * skills 常被 CC 拼进同一 block)。各段 slotType 仍是 messages.system-message,由 attribution
 * 按 prefix first-match 命中各自 v2 rule(deferred-tools.v2 / agent-types.v2 / skill-listing.v2)。
 * 只含 0 或 1 个 anchor 时不切(return [] 保持单 leaf,行为不变)。
 */
function splitSystemMessage(text: string, parentJsonPath: string): SlotMatch[] {
  const found = SYSTEM_MESSAGE_ANCHORS
    .map((a) => ({ a, pos: text.indexOf(a) }))
    .filter((x) => x.pos >= 0)
    .sort((x, y) => x.pos - y.pos);
  if (found.length <= 1) return []; // 单注入(或无)→ 不切,保持单 leaf

  const out: SlotMatch[] = [];
  // 第一个 anchor 之前的残留(通常为空——deferred 一般在最前)
  if (found[0]!.pos > 0) {
    out.push({
      slotType: "messages.system-message",
      jsonPath: parentJsonPath,
      charRange: { start: 0, end: found[0]!.pos },
      rawText: text.slice(0, found[0]!.pos),
      anchorEvidence: "",
      children: [],
    });
  }
  for (let i = 0; i < found.length; i++) {
    const start = found[i]!.pos;
    const end = i + 1 < found.length ? found[i + 1]!.pos : text.length;
    out.push({
      slotType: "messages.system-message",
      jsonPath: parentJsonPath,
      charRange: { start, end },
      rawText: text.slice(start, end),
      anchorEvidence: found[i]!.a.slice(0, 48),
      children: [],
    });
  }
  return out;
}

/**
 * 把首条 user message 的 userContext <system-reminder> 按来源拆成子段:
 *   .wrapper.prefix          — <system-reminder> 开头 + "As you answer..." 固定外壳
 *   .preamble                — "# claudeMd" + 固定前言(CC 框架语)
 *   .project-instructions ×N — 每个 "Contents of <path> (project instructions…)" 文件(你的 CLAUDE.md/AGENTS.md)
 *   .memory                  — "Contents of <path>MEMORY.md (auto-memory…)"(CC 生成的持久化记忆)
 *   .account                 — "# userEmail … # currentDate …"
 *   .wrapper.suffix          — 结尾 IMPORTANT + </system-reminder>
 * 子段 tile 满 0..length 无空隙。仅当含 "# claudeMd" / "# userEmail" / "# currentDate" 时拆
 * (= userContext reminder);否则返回 []，保持单 leaf —— 其它 reminder(token-usage / file-attachment /
 * diagnostics)不受影响。
 */
function splitUserContextReminder(text: string, parentJsonPath: string): SlotMatch[] {
  const claudeMdPos = text.indexOf("# claudeMd");
  const userEmailPos = text.indexOf("# userEmail");
  const currentDatePos = text.indexOf("# currentDate", userEmailPos);
  if (claudeMdPos < 0 || userEmailPos < 0 || currentDatePos < 0 || userEmailPos <= claudeMdPos) return [];

  const out: SlotMatch[] = [];
  const push = (slot: string, start: number, end: number, ev: string, visibility?: "default" | "rawOnly") => {
    if (end <= start) return;
    out.push({
      slotType: slot,
      jsonPath: parentJsonPath,
      charRange: { start, end },
      rawText: text.slice(start, end),
      anchorEvidence: ev,
      ...(visibility && { visibility }),
      children: [],
    });
  };

  // 所有 "Contents of <path> (<desc>):"(只取 # userEmail 之前的)
  const re = /Contents of ([^\n]+?) \(([^)]*)\):/g;
  const files: { at: number; path: string; desc: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index >= userEmailPos) break;
    files.push({ at: m.index, path: m[1]!, desc: m[2]! });
  }

  const firstFileAt = files.length > 0 ? files[0]!.at : userEmailPos;
  // 外壳前缀:<system-reminder> + As you answer...。# claudeMd 是载荷 header,不归入 envelope。
  push("messages.inline.system-reminder.wrapper.prefix", 0, claudeMdPos, "<system-reminder>", "rawOnly");
  // 固定前言:# claudeMd + CC 优先级说明。不是项目 CLAUDE.md 文件正文,默认 raw-only。
  push("messages.inline.system-reminder.preamble", claudeMdPos, firstFileAt, "# claudeMd", "rawOnly");
  // 各 "Contents of" 文件:MEMORY.md(auto-memory)→ .memory;其余(project instructions)→ .project-instructions
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    const end = i + 1 < files.length ? files[i + 1]!.at : userEmailPos;
    const isMemory = /auto-memory/.test(f.desc) || /MEMORY\.md\s*$/.test(f.path);
    const slot = isMemory
      ? "messages.inline.system-reminder.memory"
      : "messages.inline.system-reminder.project-instructions";
    push(slot, f.at, end, "Contents of");
  }
  // 账号:# userEmail … # currentDate …。只保留事实字段,不吞 closing wrapper。
  const suffixStart = text.indexOf("\n\n      IMPORTANT:", userEmailPos);
  const currentDateLineEnd = (() => {
    const firstNewline = text.indexOf("\n", currentDatePos);
    if (firstNewline < 0) return text.length;
    const secondNewline = text.indexOf("\n", firstNewline + 1);
    return secondNewline < 0 ? text.length : secondNewline;
  })();
  const accountEnd = suffixStart >= 0 ? suffixStart : currentDateLineEnd;
  push("messages.inline.system-reminder.account", userEmailPos, accountEnd, "# userEmail");
  // 外壳后缀:IMPORTANT + </system-reminder>。文案可能随版本变,作为 raw-only 尾部保留。
  push("messages.inline.system-reminder.wrapper.suffix", accountEnd, text.length, "</system-reminder>", "rawOnly");

  return out.length >= 2 ? out : [];
}

/** 从 messages.text 内扫描已知顶层 tag。未知文本保留为 free-text residual，
 *  不在 AST builder 里做语义判定；具体来源由 attribution 的 ContextRule 解释。
 */
function splitInlineTags(
  text: string,
  parentJsonPath: string,
  childSlots: TemplateSlot[],
): SlotMatch[] {
  const out: SlotMatch[] = [];
  if (!text) return out;

  const systemReminderSlot = childSlots.find((s) => s.id === "messages.inline.system-reminder");
  const localCommandSlot = childSlots.find((s) => s.id === "messages.inline.local-command");
  const imagePlaceholderSlot = childSlots.find((s) => s.id === "messages.inline.image-placeholder");
  const freeTextSlot = childSlots.find((s) => s.id === "messages.inline.free-text");

  /**
   * CLI 注入的图片占位文本固定形态：
   *   [Image: source: <path>]
   *   [Image #<N>: source: <path>]
   *   [Image #<N>]
   * 不允许跨行，path 内不含 `]` —— 这是 CLI 端生成时的硬约束。
   */
  const IMAGE_PLACEHOLDER_RE = /^\[Image(?:\s*#\d+)?(?:\s*:\s*source:\s*[^\]\n]+)?\]$/;

  // ── 整块快路径：CLI 自动注入的图片占位 ───────────────────────────────────────
  // 命中条件严格：text 经 trim 后整段与 IMAGE_PLACEHOLDER_RE 等值匹配。
  // 这样保证只切"独立成块"的占位（CLI 上传图片时自动注入），不会切到用户 prose
  // 里的 `[Image #N]` 回引文本 —— 那些和用户输入一起组成完整 jsonl userText，
  // 切碎会让 user_input 的 hash 等值匹配失败。
  if (imagePlaceholderSlot) {
    const trimmed = text.trim();
    if (trimmed.length > 0 && IMAGE_PLACEHOLDER_RE.test(trimmed)) {
      out.push({
        slotType: imagePlaceholderSlot.id,
        jsonPath: parentJsonPath,
        charRange: { start: 0, end: text.length },
        rawText: text,
        anchorEvidence: "[Image",
        children: [],
      });
      return out;
    }
  }

  let cursor = 0;
  let freeTextStart = 0;

  /**
   * 落到 messages.inline.local-command 槽的"前缀家族"。
   *
   * 命名按 Claude Code CLI 在 user turn 里注入的 tag 形态分三组：
   *   - <local-command-*>  : caveat / stdout / stderr —— slash command / 外部命令的输出
   *   - <bash-*>           : input / stdout / stderr —— "! ..." 触发的 bash 转录
   *   - <command-*>        : name / message / args —— slash command 调用头
   *
   * 每组用一个 open 前缀（前缀终止于第一个 `-` 后的任意名称）做识别，关闭 tag
   * 用相同前缀的 `</open` 形式，这样能稳定捕获家族内任意命名后续（避免每个具体
   * 名字都硬编码进 splitInlineTags 与 rule 正则两边）。
   */
  const LOCAL_COMMAND_TAG_FAMILIES = [
    { open: "<local-command-", close: "</local-command-" },
    { open: "<bash-",          close: "</bash-" },
    { open: "<command-",       close: "</command-" },
  ] as const;
  type LocalCommandFamily = (typeof LOCAL_COMMAND_TAG_FAMILIES)[number];

  function tagAt(pos: number):
    | { slot: TemplateSlot; kind: "system-reminder"; openLen: number; family: null }
    | { slot: TemplateSlot; kind: "local-command";   openLen: number; family: LocalCommandFamily }
    | null
  {
    if (systemReminderSlot && text.startsWith("<system-reminder>", pos)) {
      return { slot: systemReminderSlot, kind: "system-reminder", openLen: "<system-reminder>".length, family: null };
    }
    if (localCommandSlot) {
      for (const fam of LOCAL_COMMAND_TAG_FAMILIES) {
        if (text.startsWith(fam.open, pos)) {
          return { slot: localCommandSlot, kind: "local-command", openLen: fam.open.length, family: fam };
        }
      }
    }
    return null;
  }

  function flushFreeText(end: number): void {
    if (!freeTextSlot || end <= freeTextStart) return;
    const rawText = text.slice(freeTextStart, end);
    if (rawText.length === 0) return;
    out.push({
      slotType: freeTextSlot.id,
      jsonPath: parentJsonPath,
      charRange: { start: freeTextStart, end },
      rawText,
      anchorEvidence: "",
      children: [],
    });
  }

  while (cursor < text.length) {
    const tag = tagAt(cursor);
    if (!tag) {
      cursor++;
      continue;
    }

    flushFreeText(cursor);

    const anchorPrefix = tag.kind === "system-reminder" ? "<system-reminder>" : tag.family.open;
    let segEnd: number;
    if (tag.kind === "local-command") {
      const closeStart = text.indexOf(tag.family.close, cursor + tag.openLen);
      if (closeStart === -1) {
        segEnd = text.length;
      } else {
        const closeGT = text.indexOf(">", closeStart);
        segEnd = closeGT === -1 ? text.length : closeGT + 1;
      }
    } else {
      const closeTag = "</system-reminder>";
      const closeStart = text.indexOf(closeTag, cursor + tag.openLen);
      segEnd = closeStart === -1 ? text.length : closeStart + closeTag.length;
    }

    while (segEnd < text.length) {
      if (text[segEnd] === "\r" && text[segEnd + 1] === "\n") {
        segEnd += 2;
      } else if (text[segEnd] === "\n") {
        segEnd += 1;
      } else {
        break;
      }
    }

    // 合并相邻 local-command 家族 tag：slash command 的转录块在 CLI 端是
    //   <command-name>...</command-name>\s+<command-message>...</command-message>\s+<command-args>...</command-args>
    // 这种紧挨着的三段。每段单独成 leaf 会让中间的纯空白也成为 inline.free-text
    // 噪声 leaf。这里把"仅由空白分隔的同家族 tag 串"折叠成一个 local-command leaf，
    // 与"格式固定"的 CLI 输出形态对齐。system-reminder 不参与合并（独立块语义）。
    if (tag.kind === "local-command") {
      let probe = segEnd;
      while (probe < text.length) {
        let ws = probe;
        while (ws < text.length && /\s/.test(text[ws]!)) ws++;
        if (ws >= text.length) break;
        const next = tagAt(ws);
        if (!next || next.kind !== "local-command") break;
        let nextEnd: number;
        const closeStart = text.indexOf(next.family.close, ws + next.openLen);
        if (closeStart === -1) {
          nextEnd = text.length;
        } else {
          const closeGT = text.indexOf(">", closeStart);
          nextEnd = closeGT === -1 ? text.length : closeGT + 1;
        }
        while (nextEnd < text.length) {
          if (text[nextEnd] === "\r" && text[nextEnd + 1] === "\n") nextEnd += 2;
          else if (text[nextEnd] === "\n") nextEnd += 1;
          else break;
        }
        segEnd = nextEnd;
        probe = nextEnd;
      }
    }

    out.push({
      slotType: tag.slot.id,
      jsonPath: parentJsonPath,
      charRange: { start: cursor, end: segEnd },
      rawText: text.slice(cursor, segEnd),
      anchorEvidence: anchorPrefix,
      children: [],
    });

    cursor = segEnd;
    freeTextStart = segEnd;
  }

  flushFreeText(text.length);

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

type Section =
  | "system"
  | "side-query-system"
  | "tools"
  | "messages"
  | "side-query-user"
  | "unknown";

function sectionOf(slotType: string): Section {
  if (slotType.startsWith("system.")) return "system";
  if (slotType === "side-query.system") return "side-query-system";
  if (slotType === "side-query.user") return "side-query-user";
  if (slotType.startsWith("tools.")) return "tools";
  if (slotType.startsWith("messages.")) return "messages";
  return "unknown";
}

/** 从 "reqBody.messages[3].content[2]" 提取 mi=3, bi=2 */
function parseMessagePath(jsonPath: string): { mi: number; bi: number } {
  const miMatch = /messages\[(\d+)\]/.exec(jsonPath);
  const biMatch = /content\[(\d+)\]/.exec(jsonPath);
  return {
    mi: miMatch ? Number(miMatch[1]) : 0,
    bi: biMatch ? Number(biMatch[1]) : 0,
  };
}

function hashOf(text: string): string {
  return "sha256:" + createHash("sha256").update(text).digest("hex").slice(0, 16);
}

import { createHash } from "crypto";
import { splitProxyBlockSections } from "./proxy-block-splitter";
import type {
  CacheHint,
  ContextSegment,
  ProxyQuerySnapshot,
  QueryUsage,
  SegmentFlag,
  SegmentRole,
  SegmentSection,
  SourceRef,
} from "./types";

// ── 输入类型 ──────────────────────────────────────────────────────────────────

export interface ProxyRequestInput {
  ts?: string;
  startedAt?: string;
  reqHeaders?: Record<string, string>;
  reqBody?: {
    model?: string;
    stream?: boolean;
    max_tokens?: number;
    context_management?: unknown;
    output_config?: unknown;
    metadata?: { user_id?: string | Record<string, unknown> };
    system?: Array<{ type: string; text: string; cache_control?: { type: string; ttl?: string } }>;
    tools?: Array<{ name: string; description?: string; input_schema?: unknown }>;
    messages?: Array<{
      role: string;
      content:
        | string
        | Array<{
            type: string;
            text?: string;
            id?: string;
            name?: string;
            input?: unknown;
            tool_use_id?: string;
            content?: string | Array<{ type: string; text?: string }>;
            cache_control?: { type: string; ttl?: string };
          }>;
    }>;
  };
  // 代理记录的 SSE 事件切片（非完整流，仅采样）
  _sse_events?: Array<{
    sseEventType?: string;
    sseData?: string;
  }>;
  _traffic_jsonl_line?: number;
}

// ── 哈希工具 ──────────────────────────────────────────────────────────────────

function sha256(text: string): string {
  return "sha256:" + createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function sha256Full(text: string): string {
  return "sha256:" + createHash("sha256").update(text).digest("hex");
}

// ── 内容字符数计算 ─────────────────────────────────────────────────────────────

function blockCharCount(
  blk: NonNullable<NonNullable<ProxyRequestInput["reqBody"]>["messages"]>[number]["content"] extends
    | string
    | Array<infer B>
    ? B
    : never,
): number {
  if (!blk || typeof blk !== "object") return 0;
  const b = blk as Record<string, unknown>;
  if (b["type"] === "text") return String(b["text"] ?? "").length;
  if (b["type"] === "tool_use") return JSON.stringify(b["input"] ?? "").length;
  if (b["type"] === "tool_result") {
    const c = b["content"];
    if (typeof c === "string") return c.length;
    if (Array.isArray(c)) return (c as Array<{ text?: string }>).reduce((s, x) => s + String(x?.text ?? "").length, 0);
    return 0;
  }
  return 0;
}

// ── cache_control → CacheHint ─────────────────────────────────────────────────

function cacheHintFrom(cc: { type: string; ttl?: string } | undefined): CacheHint {
  if (!cc) return "none";
  // ephemeral with ttl → write（首次命中写入缓存）
  // 实际是否 read 取决于 SSE usage，这里只从请求结构推断
  return "write";
}

// ── 从 SSE 事件提取 usage ─────────────────────────────────────────────────────
// TODO(unsupported): 非流式响应（stream=false）时 usage 在 resBody JSON 对象里，
//   当前 fixture 全是流式，非流式路径暂未实现。
// TODO(unsupported): _sse_events 是代理的采样切片，非完整流。若 message_delta
//   事件不在采样窗口内，usage 会返回 undefined。

function extractUsageFromSse(
  events: Array<{ sseEventType?: string; sseData?: string }> | undefined,
): QueryUsage | undefined {
  if (!events?.length) return undefined;

  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cacheReadInputTokens: number | undefined;
  let cacheCreationInputTokens: number | undefined;

  for (const ev of events) {
    if (!ev.sseData) continue;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(ev.sseData) as Record<string, unknown>;
    } catch {
      continue;
    }

    // message_start 携带初始 input_tokens
    if (ev.sseEventType === "message_start") {
      const msg = data["message"] as Record<string, unknown> | undefined;
      const u = (msg?.["usage"] ?? data["usage"]) as Record<string, number> | undefined;
      if (u) {
        if (u["input_tokens"] !== undefined) inputTokens = u["input_tokens"];
        if (u["cache_read_input_tokens"] !== undefined) cacheReadInputTokens = u["cache_read_input_tokens"];
        if (u["cache_creation_input_tokens"] !== undefined)
          cacheCreationInputTokens = u["cache_creation_input_tokens"];
      }
    }

    // message_delta 携带 output_tokens 和最终 cache 统计（覆盖 message_start 的值）
    if (ev.sseEventType === "message_delta") {
      const u = data["usage"] as Record<string, number> | undefined;
      if (u) {
        if (u["output_tokens"] !== undefined) outputTokens = u["output_tokens"];
        if (u["input_tokens"] !== undefined) inputTokens = u["input_tokens"];
        if (u["cache_read_input_tokens"] !== undefined) cacheReadInputTokens = u["cache_read_input_tokens"];
        if (u["cache_creation_input_tokens"] !== undefined)
          cacheCreationInputTokens = u["cache_creation_input_tokens"];
      }
    }
  }

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadInputTokens === undefined &&
    cacheCreationInputTokens === undefined
  ) {
    return undefined;
  }

  const usage: QueryUsage = {};
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  if (cacheReadInputTokens !== undefined) usage.cacheReadInputTokens = cacheReadInputTokens;
  if (cacheCreationInputTokens !== undefined) usage.cacheCreationInputTokens = cacheCreationInputTokens;

  // Anthropic API 的三个 token 桶是并列关系，不是加法：
  //   input_tokens            = 本次未命中缓存的 fresh tokens（已是最终值，不需要再减）
  //   cache_read_input_tokens = 从缓存读取的 tokens（按 0.1x 计费）
  //   cache_creation_input_tokens = 写入缓存的 tokens（按 1.25x 计费）
  // freshInputTokens 直接等于 input_tokens，不需要减 cache_read。
  if (inputTokens !== undefined) {
    usage.freshInputTokens = inputTokens;
  }
  // measuredInputTokens = 完整上下文窗口大小（三桶之和），用于 context 占用分析。
  if (inputTokens !== undefined || cacheReadInputTokens !== undefined || cacheCreationInputTokens !== undefined) {
    usage.measuredInputTokens =
      (inputTokens ?? 0) + (cacheReadInputTokens ?? 0) + (cacheCreationInputTokens ?? 0);
  }

  return usage;
}

// ── session ID 提取 ───────────────────────────────────────────────────────────

// proxy 用 req.rawHeaders 记录 header，保留原始大小写。
// HTTP header 名称大小写不敏感，归一化后再查找以防 SDK 版本或网关改变拼写。
function normalizeHeaders(raw: Record<string, string> | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const k of Object.keys(raw)) out[k.toLowerCase()] = raw[k]!;
  return out;
}

function extractSessionId(input: ProxyRequestInput): string {
  // X-Claude-Code-Session-Id 是 Claude Code SDK 在每次请求时显式写入的 header，
  // 直接来自运行时状态，是唯一的 ground truth 来源。
  // reqBody.metadata.user_id.session_id 是同一个值的副本，不用作回退。
  const headers = normalizeHeaders(input.reqHeaders);
  return headers["x-claude-code-session-id"] ?? "unknown";
}

// ── beta headers 提取 ─────────────────────────────────────────────────────────

function extractBetaHeaders(input: ProxyRequestInput): string[] {
  const headers = normalizeHeaders(input.reqHeaders);
  const raw = headers["anthropic-beta"] ?? "";
  return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

// ── LARGE_SEGMENT 阈值（chars）───────────────────────────────────────────────

const LARGE_SEGMENT_THRESHOLD = 10_000;

// ── system[] 切分 ─────────────────────────────────────────────────────────────
//
// parser 只做 wire schema 读取和中性结构发现：
//   - 每个 system block → 按 h1 标题切 section，每个 section 产出一个 segment
//   - category 统一为 system_prompt（parser 不做语义归因）
//   - rawText 存入 segment，供 attribution 做 pattern match
//   - metadata 只存中性结构事实：sectionHeader（section 标题字符串）、
//     sectionIndex、blockIndex
//   - 不存 stabilityHint（是 rule 层知识）、不存 textPreview（rawText 已够）
//   - 不识别 billing_noise（迁到 attribution）

function parseSystemSegments(
  system: NonNullable<NonNullable<ProxyRequestInput["reqBody"]>["system"]>,
  proxyFile: string,
  orderStart: number,
): ContextSegment[] {
  const segments: ContextSegment[] = [];
  let order = orderStart;

  for (let i = 0; i < system.length; i++) {
    const blk = system[i];
    const text = blk.text ?? "";
    const jsonPath = `reqBody.system[${i}]`;
    const cacheHint = cacheHintFrom(blk.cache_control);

    const sections = splitProxyBlockSections(text);
    const multiSection = sections.length > 1;

    for (let si = 0; si < sections.length; si++) {
      const section = sections[si]!;
      const sectionText = section.text;
      const charCount = sectionText.length;
      const rawHash = sha256(sectionText);
      const flags: SegmentFlag[] = [];
      if (charCount >= LARGE_SEGMENT_THRESHOLD) flags.push("large_segment");

      const segId = multiSection ? `pseg-system-${i}-s${si}` : `pseg-system-${i}`;

      const headerLabel = section.header ?? "(prelude)";
      const label = multiSection
        ? `System prompt block [${i}] §${headerLabel}`
        : `System prompt block [${i}]`;

      const proxyLoc = multiSection
        ? { file: proxyFile, jsonPath, charRange: { start: section.startChar, end: section.endChar } }
        : { file: proxyFile, jsonPath };

      const seg: ContextSegment = {
        id: segId,
        section: "system" as SegmentSection,
        category: "system_prompt",
        label,
        rawText: sectionText,
        sourceRefs: [
          { kind: "proxy", proxy: proxyLoc } as Extract<SourceRef, { kind: "proxy" }>,
        ],
        rawHash,
        charCount,
        cacheHint,
        order: order++,
        ...(multiSection
          ? {
              metadata: {
                sectionHeader: section.header,
                sectionIndex: si,
                blockIndex: i,
              },
            }
          : {}),
      };
      if (flags.length) seg.flags = flags;
      segments.push(seg);
    }
  }

  return segments;
}

// ── tools[] 切分 ──────────────────────────────────────────────────────────────

function parseToolsSegments(
  tools: NonNullable<NonNullable<ProxyRequestInput["reqBody"]>["tools"]>,
  proxyFile: string,
  orderStart: number,
): ContextSegment[] {
  const segments: ContextSegment[] = [];

  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i];
    const raw = JSON.stringify(tool);
    const charCount = raw.length;
    const jsonPath = `reqBody.tools[${i}]`;
    const rawHash = sha256(raw);

    const flags: SegmentFlag[] = [];
    if (charCount >= LARGE_SEGMENT_THRESHOLD) flags.push("large_segment");

    const seg: ContextSegment = {
      id: `pseg-tool-${i}`,
      section: "tools" as SegmentSection,
      category: "tools_schema",
      label: `Tool schema: ${tool.name}`,
      sourceRefs: [
        {
          kind: "proxy",
          proxy: { file: proxyFile, jsonPath },
        } as Extract<SourceRef, { kind: "proxy" }>,
      ],
      rawHash,
      charCount,
      cacheHint: "none",
      order: orderStart + i,
      metadata: { toolName: tool.name },
    };
    if (flags.length) seg.flags = flags;
    segments.push(seg);
  }

  return segments;
}

// ── messages[] 切分 ───────────────────────────────────────────────────────────
//
// parser 只做 wire schema 读取：
//   - text block → user_message（role=user）或 assistant_text（role=assistant）
//     不检查内容，rawText 存入供 attribution 做 pattern match
//   - tool_use / tool_result → 由 blk.type 字段直接确定（wire schema）
//   - toolUseId 直接读 blk.id / blk.tool_use_id（wire schema）
//   - 所有语义分类（billing_noise、harness_injection、local_command_history、
//     prior_session_history）都留给 attribution

function parseMessagesSegments(
  messages: NonNullable<NonNullable<ProxyRequestInput["reqBody"]>["messages"]>,
  proxyFile: string,
  orderStart: number,
): ContextSegment[] {
  const segments: ContextSegment[] = [];
  let order = orderStart;

  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    const role = msg.role as SegmentRole;
    const content = msg.content;

    // string content → 单 segment（保守分类）
    if (typeof content === "string") {
      const rawText = content;
      const charCount = rawText.length;
      const jsonPath = `reqBody.messages[${mi}]`;
      const rawHash = sha256(rawText);
      const flags: SegmentFlag[] = [];
      if (charCount >= LARGE_SEGMENT_THRESHOLD) flags.push("large_segment");

      const seg: ContextSegment = {
        id: `pseg-msg-${mi}`,
        section: "messages",
        category: role === "user" ? "user_message" : "assistant_text",
        label: `Message [${mi}] ${role} (string)`,
        rawText,
        sourceRefs: [{ kind: "proxy", proxy: { file: proxyFile, jsonPath } } as Extract<SourceRef, { kind: "proxy" }>],
        role,
        rawHash,
        charCount,
        cacheHint: "none",
        order: order++,
      };
      if (flags.length) seg.flags = flags;
      segments.push(seg);
      continue;
    }

    // array content → block 级切分
    for (let bi = 0; bi < content.length; bi++) {
      const blk = content[bi];
      const jsonPath = `reqBody.messages[${mi}].content[${bi}]`;
      const blkType = blk.type;

      let rawText = "";
      let toolUseId: string | undefined;
      let charCount = 0;
      let cacheHint: CacheHint = "none";
      let category: ContextSegment["category"] = "unknown";
      let label = "";

      if (blkType === "text") {
        rawText = blk.text ?? "";
        charCount = rawText.length;
        cacheHint = cacheHintFrom(blk.cache_control);
        // 保守分类：不检查内容，attribution 根据 rawText 决定真实 category
        category = role === "user" ? "user_message" : "assistant_text";
        label = `Message [${mi}] ${role} text [${bi}]`;
      } else if (blkType === "tool_use") {
        // wire schema：blk.type 直接确定 category
        rawText = JSON.stringify({ id: blk.id, name: blk.name, input: blk.input });
        charCount = JSON.stringify(blk.input ?? "").length;
        toolUseId = blk.id;
        category = "tool_use";
        label = `tool_use: ${blk.name} [${mi}][${bi}]`;
      } else if (blkType === "tool_result") {
        // wire schema：blk.type 直接确定 category
        const c = blk.content;
        if (typeof c === "string") {
          rawText = c;
          charCount = c.length;
        } else if (Array.isArray(c)) {
          rawText = (c as Array<{ text?: string }>).map((x) => x?.text ?? "").join("\n");
          charCount = rawText.length;
        }
        toolUseId = blk.tool_use_id;
        category = "tool_result";
        label = `tool_result [${mi}][${bi}]`;
        cacheHint = cacheHintFrom(blk.cache_control);
      }
      // TODO(unsupported): thinking / redacted_thinking / image / document — category=unknown

      const rawHash = sha256(rawText);
      const flags: SegmentFlag[] = [];
      if (charCount >= LARGE_SEGMENT_THRESHOLD) flags.push("large_segment");

      const seg: ContextSegment = {
        id: `pseg-msg-${mi}-${bi}`,
        section: "messages",
        category,
        label,
        rawText: rawText || undefined,
        sourceRefs: [{ kind: "proxy", proxy: { file: proxyFile, jsonPath } } as Extract<SourceRef, { kind: "proxy" }>],
        role,
        rawHash,
        charCount,
        cacheHint,
        order: order++,
      };
      if (toolUseId) seg.toolUseId = toolUseId;
      if (flags.length) seg.flags = flags;
      segments.push(seg);
    }
  }

  return segments;
}

// ── 主入口 ────────────────────────────────────────────────────────────────────

export function parseClaudeProxyRequest(
  input: ProxyRequestInput,
  opts?: {
    proxyFile?: string;
    queryId?: string;
    queryIndex?: number;
  },
): ProxyQuerySnapshot {
  const proxyFile = opts?.proxyFile ?? "proxy-request.json";
  const body = input.reqBody ?? {};
  const timestamp = input.ts ?? input.startedAt ?? new Date().toISOString();

  // session ID
  const sessionId = extractSessionId(input);

  // query ID：优先 opts 传入；fallback 加入毫秒 + traffic line 防止同秒碰撞。
  // 时间戳保留完整数字（含毫秒共 17 位），再附加 traffic line 作为 discriminator。
  const tsDigits = timestamp.replace(/[^0-9]/g, "");
  const trafficSuffix = input._traffic_jsonl_line !== undefined ? `-${input._traffic_jsonl_line}` : "";
  const queryId = opts?.queryId ?? `query-${tsDigits}${trafficSuffix}`;

  // rawRequestHash：对整个 reqBody JSON 做哈希
  const rawRequestHash = sha256Full(JSON.stringify(body));

  // request metadata
  const betaHeaders = extractBetaHeaders(input);

  // queryKind 推断：
  //   side_query   — tools=0 + messages=1（queryHaiku/queryWithModel 模式，claude.ts:3274）
  //   main_session — tools>0（主对话）
  //   unknown      — 其他
  const toolCount = Array.isArray(body.tools) ? body.tools.length : 0;
  const messageCount = Array.isArray(body.messages) ? body.messages.length : 0;
  const queryKind: NonNullable<ProxyQuerySnapshot["request"]>["queryKind"] =
    toolCount === 0 && messageCount === 1
      ? "side_query"
      : toolCount > 0
      ? "main_session"
      : "unknown";

  // output_config.format.type (structured output 사용 여부)
  const outputConfigRaw = body.output_config as Record<string, unknown> | undefined;
  const outputFormat = (outputConfigRaw?.["format"] as Record<string, unknown> | undefined)?.["type"] as string | undefined;

  const request: ProxyQuerySnapshot["request"] = {
    model: body.model,
    stream: body.stream,
    maxTokens: body.max_tokens,
    contextManagement: body.context_management,
    betaHeaders: betaHeaders.length ? betaHeaders : undefined,
    queryKind,
    ...(outputFormat ? { outputFormat } : {}),
  };

  // segments
  const segments: ContextSegment[] = [];
  let order = 0;

  // 1. system[]
  if (Array.isArray(body.system) && body.system.length > 0) {
    const sysSeg = parseSystemSegments(body.system, proxyFile, order);
    order += sysSeg.length;
    segments.push(...sysSeg);
  }

  // 2. tools[]
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const toolSeg = parseToolsSegments(body.tools, proxyFile, order);
    order += toolSeg.length;
    segments.push(...toolSeg);
  }

  // 3. messages[]
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    const msgSeg = parseMessagesSegments(body.messages, proxyFile, order);
    segments.push(...msgSeg);
  }

  // usage from SSE
  const usage = extractUsageFromSse(input._sse_events);

  // snapshot id
  const snapshotId = `snapshot-${queryId}`;

  const snapshot: ProxyQuerySnapshot = {
    id: snapshotId,
    agentKind: "claude-code",
    sessionId,
    queryId,
    timestamp,
    sourceRef: {
      kind: "proxy",
      proxy: { file: proxyFile, jsonPath: "reqBody" },
    },
    segments,
    rawRequestHash,
    request,
  };

  if (opts?.queryIndex !== undefined) snapshot.queryIndex = opts.queryIndex;
  if (usage) snapshot.usage = usage;
  // TODO(unsupported): agentId / subagentId / parentAgentId — proxy 请求本身不携带
  //   子 agent 身份信息，需调用方通过 opts 传入后再赋值。

  // traffic line → metadata
  if (input._traffic_jsonl_line !== undefined) {
    snapshot.metadata = { trafficJsonlLine: input._traffic_jsonl_line };
  }

  return snapshot;
}

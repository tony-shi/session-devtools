import { createHash } from "crypto";
import type {
  CacheHint,
  ContextSegment,
  ProxyQuerySnapshot,
  QueryUsage,
  SegmentCategory,
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

function parseSystemSegments(
  system: NonNullable<NonNullable<ProxyRequestInput["reqBody"]>["system"]>,
  proxyFile: string,
  orderStart: number,
): ContextSegment[] {
  const segments: ContextSegment[] = [];

  for (let i = 0; i < system.length; i++) {
    const blk = system[i];
    const text = blk.text ?? "";
    const charCount = text.length;
    const jsonPath = `reqBody.system[${i}]`;
    const rawHash = sha256(text);
    const cacheHint = cacheHintFrom(blk.cache_control);

    // billing_noise：Claude Code 在 system[0] 注入账单 header
    // 参考 restored-src/src/services/systemPrompt.ts: billing header pattern
    const isBillingNoise = /^x-anthropic-billing-header:/.test(text.trim());

    const flags: SegmentFlag[] = [];
    if (charCount >= LARGE_SEGMENT_THRESHOLD) flags.push("large_segment");

    const seg: ContextSegment = {
      id: `pseg-system-${i}`,
      section: "system" as SegmentSection,
      category: isBillingNoise ? ("billing_noise" as SegmentCategory) : ("system_prompt" as SegmentCategory),
      label: isBillingNoise ? "Billing noise header" : `System prompt block [${i}]`,
      sourceRefs: [
        {
          kind: "proxy",
          proxy: { file: proxyFile, jsonPath },
        } as Extract<SourceRef, { kind: "proxy" }>,
      ],
      rawHash,
      charCount,
      cacheHint,
      order: orderStart + i,
    };
    if (flags.length) seg.flags = flags;
    segments.push(seg);
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
      category: "tools_schema" as SegmentCategory,
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

    // string content → 单 segment
    if (typeof content === "string") {
      const charCount = content.length;
      const jsonPath = `reqBody.messages[${mi}]`;
      const rawHash = sha256(content);
      const flags: SegmentFlag[] = [];
      if (charCount >= LARGE_SEGMENT_THRESHOLD) flags.push("large_segment");

      const seg: ContextSegment = {
        id: `pseg-msg-${mi}`,
        section: "messages" as SegmentSection,
        category: role === "user" ? ("user_message" as SegmentCategory) : ("assistant_text" as SegmentCategory),
        label: `Message [${mi}] ${role} (string)`,
        sourceRefs: [
          {
            kind: "proxy",
            proxy: { file: proxyFile, jsonPath },
          } as Extract<SourceRef, { kind: "proxy" }>,
        ],
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

      let category: SegmentCategory = "unknown";
      let label = "";
      let rawText = "";
      let toolUseId: string | undefined;
      let charCount = 0;
      let cacheHint: CacheHint = "none";

      if (blkType === "text") {
        rawText = blk.text ?? "";
        charCount = rawText.length;
        cacheHint = cacheHintFrom(blk.cache_control);
        category = classifyTextBlock(rawText, role);
        label = `Message [${mi}] ${role} text [${bi}]`;
      } else if (blkType === "tool_use") {
        rawText = JSON.stringify({ id: blk.id, name: blk.name, input: blk.input });
        charCount = JSON.stringify(blk.input ?? "").length;
        toolUseId = blk.id;
        category = "tool_use";
        label = `tool_use: ${blk.name} [${mi}][${bi}]`;
        cacheHint = "none";
      } else if (blkType === "tool_result") {
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
      // TODO(unsupported): thinking / redacted_thinking block — category 保持 "unknown"，
      //   charCount 为 0，等有对应 fixture 后在此处补充分支。
      // TODO(unsupported): image / document block（附件）— charCount 为 0，
      //   category 保持 "unknown"。

      const rawHash = sha256(rawText);
      const flags: SegmentFlag[] = [];
      if (charCount >= LARGE_SEGMENT_THRESHOLD) flags.push("large_segment");

      const seg: ContextSegment = {
        id: `pseg-msg-${mi}-${bi}`,
        section: "messages" as SegmentSection,
        category,
        label,
        sourceRefs: [
          {
            kind: "proxy",
            proxy: { file: proxyFile, jsonPath },
          } as Extract<SourceRef, { kind: "proxy" }>,
        ],
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

// ── text block 分类 ───────────────────────────────────────────────────────────
// Claude Code harness 在 user message 的 content 数组里注入结构化 XML 标签。
// 分类依据是这些标签的固定前缀，不是启发式文本匹配：
//   <system-reminder>   → harness_injection（每个 user turn 头部注入的 meta 信息）
//   <local-command-caveat> / <bash-input> / <bash-stdout> / <bash-stderr>
//                       → local_command_history（终端输出注入）
// 参考 restored-src/src/utils/systemPrompt.ts 中的注入逻辑。
//
// TODO(unsupported): thinking / redacted_thinking block — blk.type 为这两种时
//   category 会落入 "unknown"，等有对应 fixture 后补充分类。
// TODO(unsupported): image / document block（附件）— charCount 会为 0，
//   category 同样落入 "unknown"。

function classifyTextBlock(text: string, role: SegmentRole): SegmentCategory {
  const trimmed = text.trimStart();

  // billing noise（system[0] 已处理，messages 里也可能出现）
  if (/^x-anthropic-billing-header:/.test(trimmed)) return "billing_noise";

  // system-reminder 注入
  if (trimmed.startsWith("<system-reminder>")) return "harness_injection";

  // local command 注入
  if (
    trimmed.startsWith("<local-command-caveat>") ||
    trimmed.startsWith("<bash-input>") ||
    trimmed.startsWith("<bash-stdout>") ||
    trimmed.startsWith("<bash-stderr>")
  ) {
    return "local_command_history";
  }

  if (role === "assistant") return "assistant_text";
  return "user_message";
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
  const request: ProxyQuerySnapshot["request"] = {
    model: body.model,
    stream: body.stream,
    maxTokens: body.max_tokens,
    contextManagement: body.context_management,
    betaHeaders: betaHeaders.length ? betaHeaders : undefined,
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

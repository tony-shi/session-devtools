// SSE → assistant message 重组器。
//
// Anthropic Messages API 的流式响应协议：
//   message_start          → 整条消息的开头，给出 id/model/role/初始 usage
//   content_block_start    → 第 i 个 content block 的元数据（type + 初始字段）
//   content_block_delta×N  → 累积该 block 的内容
//                            · text_delta        → text 累加
//                            · thinking_delta    → thinking 累加
//                            · signature_delta   → thinking.signature 累加
//                            · input_json_delta  → tool_use.input 的 partial_json 拼接，
//                                                  在 content_block_stop 时整体 JSON.parse
//   content_block_stop     → 第 i 个 content block 结束
//   message_delta          → stop_reason / stop_sequence / output_tokens 更新
//   message_stop           → 整条消息结束（流正常完成）
//   ping                   → keepalive，忽略
//   error                  → 流错误，记录到 errors[] 但不阻断
//
// 设计目标：把 SSE 事件流忠实地重建成与 Anthropic 非流式 response 等价的
// assistant message 对象（id/role/model/content/stop_reason/usage）。
//
// 不做的事：
//   - 不做内容截断 / 加工 / 脱敏；input 字段如何 JSON 化由原 partial_json 决定
//   - 不做 stop_reason 推断 —— 流中断时 stop_reason 保持为 null，由 truncated 标识

export interface SseEvent {
  eventType: string;
  data: string;
}

/**
 * 把完整的 SSE 文本（多事件，`event:` + `data:` 行，`\n\n` 分隔）解析为事件数组。
 * 与 proxy-v2/log/jsonl.ts::parseSseChunk 的输出形态一致；二者差异：
 *   - parseSseChunk: 增量喂入，逐事件回调（写盘场景）
 *   - parseSseText:  一次性解析整段 resBody（读盘 / 重组场景）
 */
export function parseSseText(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  let eventType = "message";
  const dataLines: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("event:")) {
      eventType = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    } else if (line === "" && dataLines.length > 0) {
      events.push({ eventType, data: dataLines.join("\n") });
      eventType = "message";
      dataLines.length = 0;
    }
  }
  // 文件末尾没有空行结尾时，flush 残留缓冲
  if (dataLines.length > 0) {
    events.push({ eventType, data: dataLines.join("\n") });
  }
  return events;
}

export interface ReconstructedUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
}

export type ReconstructedContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export interface ReconstructedMessage {
  id: string | null;
  role: "assistant";
  model: string | null;
  content: ReconstructedContentBlock[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: ReconstructedUsage;
}

export interface ReconstructionResult {
  /** 重组得到的消息；message_start 缺失则为 null */
  message: ReconstructedMessage | null;
  /** true 表示流未正常结束（没有 message_stop）；上游可据此判断是否可信 */
  truncated: boolean;
  /** 解析过程中的非致命问题（出现时不阻断重组），便于诊断 */
  errors: string[];
}

interface ToolUseAccumulator {
  type: "tool_use";
  id: string;
  name: string;
  /** 累积的 partial_json 片段，在 content_block_stop 时 join + JSON.parse */
  partialJsonChunks: string[];
  /** 初始 input（content_block_start 携带，通常是 {}） */
  initialInput: unknown;
}

interface TextAccumulator {
  type: "text";
  text: string;
}

interface ThinkingAccumulator {
  type: "thinking";
  thinking: string;
  signature: string;
}

type BlockAccumulator = ToolUseAccumulator | TextAccumulator | ThinkingAccumulator;

function safeParseJson(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function nullableInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function finalizeBlock(acc: BlockAccumulator, errors: string[], index: number): ReconstructedContentBlock {
  if (acc.type === "text") {
    return { type: "text", text: acc.text };
  }
  if (acc.type === "thinking") {
    const out: ReconstructedContentBlock = { type: "thinking", thinking: acc.thinking };
    if (acc.signature) out.signature = acc.signature;
    return out;
  }
  // tool_use：把 partial_json 片段拼起来 parse；空片段时回落 initialInput
  const joined = acc.partialJsonChunks.join("");
  let input: unknown = acc.initialInput;
  if (joined.length > 0) {
    try {
      input = JSON.parse(joined);
    } catch {
      // 流中断 / JSON 残缺 —— 保留 raw partial 串便于排查，不丢字段
      errors.push(`content_block[${index}].input partial_json parse failed; kept raw string`);
      input = joined;
    }
  }
  return { type: "tool_use", id: acc.id, name: acc.name, input };
}

export function reconstructAssistantMessage(events: SseEvent[]): ReconstructionResult {
  const errors: string[] = [];
  let message: ReconstructedMessage | null = null;
  const blocks: Map<number, BlockAccumulator> = new Map();
  let sawMessageStop = false;

  for (const ev of events) {
    const data = safeParseJson(ev.data);
    if (!data) {
      // 空行 / keepalive / 非 JSON — 跳过，不报错（ping 也走这里）
      continue;
    }
    const type = typeof data.type === "string" ? data.type : null;

    if (type === "ping") continue;

    if (type === "error") {
      const err = (data.error as Record<string, unknown>) ?? {};
      const errType = typeof err.type === "string" ? err.type : "unknown";
      const errMsg  = typeof err.message === "string" ? err.message : "";
      errors.push(`SSE error event: ${errType}${errMsg ? ` — ${errMsg}` : ""}`);
      continue;
    }

    if (type === "message_start") {
      const msg = (data.message as Record<string, unknown>) ?? {};
      const usage = (msg.usage as Record<string, unknown>) ?? {};
      message = {
        id: typeof msg.id === "string" ? msg.id : null,
        role: "assistant",
        model: typeof msg.model === "string" ? msg.model : null,
        content: [],
        stop_reason: typeof msg.stop_reason === "string" ? msg.stop_reason : null,
        stop_sequence: typeof msg.stop_sequence === "string" ? msg.stop_sequence : null,
        usage: {
          input_tokens: nullableInt(usage.input_tokens),
          output_tokens: nullableInt(usage.output_tokens),
          cache_creation_input_tokens: nullableInt(usage.cache_creation_input_tokens),
          cache_read_input_tokens: nullableInt(usage.cache_read_input_tokens),
        },
      };
      continue;
    }

    if (type === "content_block_start") {
      const index = nullableInt(data.index);
      const cb = (data.content_block as Record<string, unknown>) ?? {};
      const cbType = typeof cb.type === "string" ? cb.type : null;
      if (index === null || cbType === null) {
        errors.push(`malformed content_block_start: index=${data.index}, type=${cb.type}`);
        continue;
      }
      if (cbType === "text") {
        const initialText = typeof cb.text === "string" ? cb.text : "";
        blocks.set(index, { type: "text", text: initialText });
      } else if (cbType === "thinking") {
        const initialThinking = typeof cb.thinking === "string" ? cb.thinking : "";
        const initialSig = typeof cb.signature === "string" ? cb.signature : "";
        blocks.set(index, { type: "thinking", thinking: initialThinking, signature: initialSig });
      } else if (cbType === "tool_use") {
        blocks.set(index, {
          type: "tool_use",
          id: typeof cb.id === "string" ? cb.id : "",
          name: typeof cb.name === "string" ? cb.name : "",
          partialJsonChunks: [],
          initialInput: cb.input ?? {},
        });
      } else {
        errors.push(`unsupported content_block.type=${cbType} at index ${index}`);
      }
      continue;
    }

    if (type === "content_block_delta") {
      const index = nullableInt(data.index);
      const delta = (data.delta as Record<string, unknown>) ?? {};
      const deltaType = typeof delta.type === "string" ? delta.type : null;
      if (index === null || deltaType === null) {
        errors.push(`malformed content_block_delta: index=${data.index}, delta.type=${delta.type}`);
        continue;
      }
      const acc = blocks.get(index);
      if (!acc) {
        errors.push(`content_block_delta for unknown index ${index} (no preceding content_block_start)`);
        continue;
      }
      if (deltaType === "text_delta" && acc.type === "text") {
        const t = typeof delta.text === "string" ? delta.text : "";
        acc.text += t;
      } else if (deltaType === "thinking_delta" && acc.type === "thinking") {
        const t = typeof delta.thinking === "string" ? delta.thinking : "";
        acc.thinking += t;
      } else if (deltaType === "signature_delta" && acc.type === "thinking") {
        const s = typeof delta.signature === "string" ? delta.signature : "";
        acc.signature += s;
      } else if (deltaType === "input_json_delta" && acc.type === "tool_use") {
        const j = typeof delta.partial_json === "string" ? delta.partial_json : "";
        acc.partialJsonChunks.push(j);
      } else {
        errors.push(`mismatched delta.type=${deltaType} for block index ${index} (block type=${acc.type})`);
      }
      continue;
    }

    if (type === "content_block_stop") {
      // 不立刻 finalize —— 留到最后按 index 顺序统一输出，避免乱序
      continue;
    }

    if (type === "message_delta") {
      if (!message) {
        errors.push("message_delta before message_start; ignored");
        continue;
      }
      const delta = (data.delta as Record<string, unknown>) ?? {};
      const usage = (data.usage as Record<string, unknown>) ?? {};
      if (typeof delta.stop_reason === "string") message.stop_reason = delta.stop_reason;
      if (typeof delta.stop_sequence === "string") message.stop_sequence = delta.stop_sequence;
      const out = nullableInt(usage.output_tokens);
      if (out !== null) message.usage.output_tokens = out;
      continue;
    }

    if (type === "message_stop") {
      sawMessageStop = true;
      continue;
    }
  }

  if (message) {
    const sortedIndices = Array.from(blocks.keys()).sort((a, b) => a - b);
    for (const idx of sortedIndices) {
      const acc = blocks.get(idx);
      if (!acc) continue;
      message.content.push(finalizeBlock(acc, errors, idx));
    }
  }

  return {
    message,
    truncated: !sawMessageStop,
    errors,
  };
}

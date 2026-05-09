import type { ExtractInput, ProxyMeta } from "./types.ts";

export function detectClaude(input: ExtractInput): boolean {
  // reqHeaders are normalized to lowercase by parseTrafficLine before reaching here
  return !!input.reqHeaders["x-claude-code-session-id"];
}

function safeParseJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return null; }
}

function nullableInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function classifyError(status: number, isStream: boolean, hasMsgStop: boolean): string | null {
  if (status === 401 || status === 403) return "4xx_auth";
  if (status === 429) return "4xx_ratelimit";
  if (status >= 400 && status < 500) return "4xx_other";
  if (status >= 500) return "5xx";
  if (isStream && !hasMsgStop) return "sse_aborted";
  return null;
}

export function extractClaude(input: ExtractInput): Partial<ProxyMeta> {
  const result: Partial<ProxyMeta> = { cli_tool: "claude" };

  result.session_id = input.reqHeaders["x-claude-code-session-id"] ?? null;

  // Request body: Anthropic Messages API shape
  const reqJson = safeParseJson(input.reqBody);
  if (reqJson) {
    result.model = typeof reqJson.model === "string" ? reqJson.model : null;
    result.req_message_count = Array.isArray(reqJson.messages) ? reqJson.messages.length : null;
    result.req_has_tools = Array.isArray(reqJson.tools) && (reqJson.tools as unknown[]).length > 0;
  }

  // Response: stream vs non-stream
  let hasMsgStop = false;
  if (input.isStream && input.sseEvents) {
    // Accumulate usage from message_delta; pick stop_reason from message_delta or message_stop
    let inTok: number | null = null, outTok: number | null = null;
    let ccTok: number | null = null, crTok: number | null = null;
    for (const ev of input.sseEvents) {
      if (ev.eventType !== "content_block_delta" && ev.eventType !== "message_delta" && ev.eventType !== "message_stop") {
        // parse data regardless — Anthropic doesn't always set eventType
      }
      let data: Record<string, unknown> | null = null;
      try { data = JSON.parse(ev.data) as Record<string, unknown>; } catch { continue; }
      if (!data) continue;

      const t = data.type as string | undefined;
      if (t === "message_delta") {
        const usage = (data.usage as Record<string, unknown>) ?? {};
        outTok = nullableInt(usage.output_tokens) ?? outTok;
        if (!result.res_stop_reason && typeof (data.delta as any)?.stop_reason === "string") {
          result.res_stop_reason = (data.delta as any).stop_reason;
        }
      }
      if (t === "message_start") {
        const msg = (data.message as Record<string, unknown>) ?? {};
        const usage = (msg.usage as Record<string, unknown>) ?? {};
        inTok = nullableInt(usage.input_tokens) ?? inTok;
        ccTok = nullableInt(usage.cache_creation_input_tokens) ?? ccTok;
        crTok = nullableInt(usage.cache_read_input_tokens) ?? crTok;
      }
      if (t === "message_stop") hasMsgStop = true;
    }
    result.res_input_tokens = inTok;
    result.res_output_tokens = outTok;
    result.res_cache_creation_tokens = ccTok;
    result.res_cache_read_tokens = crTok;
  } else {
    const resJson = safeParseJson(input.resBody);
    if (resJson) {
      const usage = (resJson.usage as Record<string, unknown>) ?? {};
      result.res_input_tokens          = nullableInt(usage.input_tokens);
      result.res_output_tokens         = nullableInt(usage.output_tokens);
      result.res_cache_creation_tokens = nullableInt(usage.cache_creation_input_tokens);
      result.res_cache_read_tokens     = nullableInt(usage.cache_read_input_tokens);
      result.res_stop_reason           = typeof resJson.stop_reason === "string" ? resJson.stop_reason : null;
      hasMsgStop = result.res_stop_reason !== null;
    }
  }

  result.error_class = classifyError(input.status, input.isStream, hasMsgStop);
  return result;
}

import type { ExtractInput, ProxyMeta } from "./types.ts";
import { detectClaude, extractClaude } from "./claude.ts";

const EMPTY_META: ProxyMeta = {
  cli_tool: null, session_id: null, model: null,
  req_message_count: null, req_has_tools: null,
  res_input_tokens: null, res_output_tokens: null,
  res_cache_creation_tokens: null, res_cache_read_tokens: null,
  res_stop_reason: null, error_class: null,
};

function classifyHttpError(status: number): string | null {
  if (status === 401 || status === 403) return "4xx_auth";
  if (status === 429) return "4xx_ratelimit";
  if (status >= 400 && status < 500) return "4xx_other";
  if (status >= 500) return "5xx";
  return null;
}

export function extractProxyMeta(input: ExtractInput): ProxyMeta {
  try {
    // First match wins — add new CLI detectors here
    if (detectClaude(input)) return { ...EMPTY_META, ...extractClaude(input) };
    // if (detectCodex(input))  return { ...EMPTY_META, ...extractCodex(input) };
    // if (detectGemini(input)) return { ...EMPTY_META, ...extractGemini(input) };

    // Unknown CLI — still classify HTTP errors
    return { ...EMPTY_META, error_class: classifyHttpError(input.status) };
  } catch {
    return { ...EMPTY_META };
  }
}

export type { ProxyMeta, ExtractInput } from "./types.ts";

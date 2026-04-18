import type { AgentSpan } from "../types";
import { parseClaudeJsonl } from "./claude";

export type AgentTool = "claude" | "codex" | "gemini";

export interface ParserOptions {
  tool: AgentTool;
}

/**
 * Parse a raw JSONL string into AgentSpan[].
 * The tool option selects the correct parser; codex/gemini are stubs for now.
 */
export function parseJsonl(raw: string, opts: ParserOptions): AgentSpan[] {
  switch (opts.tool) {
    case "claude":
      return parseClaudeJsonl(raw);
    case "codex":
    case "gemini":
      // TODO: implement codex/gemini parsers
      return [];
  }
}

export { parseClaudeJsonl };

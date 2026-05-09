import { createReadStream } from "fs";
import { createInterface } from "readline";

export interface DaySliceValue {
  events: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  tool_call_count: number;
  human_input_count: number;
}

const _cache = new Map<string, DaySliceValue>();

async function computeDaySlice(sourceFile: string, date: string): Promise<DaySliceValue> {
  const dayStart = `${date}T00:00:00`;
  const dayEnd = `${date}T23:59:59`;

  const result: DaySliceValue = {
    events: 0, input_tokens: 0, output_tokens: 0,
    cache_creation_tokens: 0, cache_read_tokens: 0,
    tool_call_count: 0, human_input_count: 0,
  };

  const rl = createInterface({ input: createReadStream(sourceFile, { encoding: "utf-8" }), crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }

    const ts: string = rec.timestamp ?? rec.ts ?? "";
    if (!ts || ts < dayStart) continue;
    if (ts > dayEnd) break; // timestamps are monotonically increasing

    result.events++;
    const t: string = rec.type ?? "";

    if (t === "assistant" && !rec.isSidechain) {
      const msg = rec.message;
      if (msg) {
        const usage = msg.usage ?? {};
        result.input_tokens += usage.input_tokens ?? 0;
        result.output_tokens += usage.output_tokens ?? 0;
        result.cache_creation_tokens += usage.cache_creation_input_tokens ?? 0;
        result.cache_read_tokens += usage.cache_read_input_tokens ?? 0;
        if (Array.isArray(msg.content)) {
          for (const b of msg.content) {
            if (b?.type === "tool_use") result.tool_call_count++;
          }
        }
      }
    }

    if (t === "user" && !rec.isMeta && !rec.isSidechain) { // Claude Code wrapper fields — best-effort; may drift silently
      const content = rec.message?.content;
      const hasToolResult = Array.isArray(content) && content.some((b: any) => b?.type === "tool_result");
      if (!hasToolResult) result.human_input_count++;
    }
  }

  return result;
}

export async function getDaySlice(
  date: string,
  sessionId: string,
  sourceFile: string,
  fileMtime: number,
): Promise<DaySliceValue> {
  const key = `${date}|${sessionId}|${fileMtime}`;
  const cached = _cache.get(key);
  if (cached) return cached;
  const value = await computeDaySlice(sourceFile, date);
  _cache.set(key, value);
  return value;
}

export function clearDaySliceCache(): void {
  _cache.clear();
}

// parser 模块入口
// parseQuery：调用 template/selector 选定 template → matchSlots → buildSnapshot

import type { ParsedQuerySnapshot } from "./types";
import type { MatchSlotsInput } from "./matcher";
import { matchSlots } from "./matcher";
import { buildSnapshot } from "./snapshot";
import { selectTemplate } from "../template/selector";

export type { ParsedQuerySnapshot, SegmentNode, SlotMatch } from "./types";

export interface ParseQueryInput {
  reqBody: MatchSlotsInput["reqBody"];
  proxyFile: string;
  reqHeaders?: Record<string, string>;
  ts?: string;
}

export function parseQuery(input: ParseQueryInput): ParsedQuerySnapshot {
  const { reqBody, proxyFile, reqHeaders } = input;
  const ts = input.ts ?? new Date().toISOString();

  const { template, queryKind } = selectTemplate(reqBody, reqHeaders);
  const allSlotMatches = matchSlots({ reqBody, template });

  return buildSnapshot({ allSlotMatches, queryKind, proxyFile, ts });
}

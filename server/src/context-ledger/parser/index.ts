// parser 模块入口
// parseQuery：调用 template/selector 选定 template → matchSlots → buildParsedQuerySnapshot

import type { ParsedQuerySnapshot } from "./types";
import type { MatchSlotsInput } from "./matcher";
import { matchSlots } from "./matcher";
import { buildParsedQuerySnapshot } from "./ast-builder";
import { selectTemplate } from "../template/selector";

export type { ParsedQuerySnapshot, SegmentNode, SlotMatch } from "./types";
export {
  attributeSnapshot,
  computeCoverage,
} from "./attribution";
export type {
  AttributionCoverage,
  SegmentAttribution,
} from "./attribution";

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

  return buildParsedQuerySnapshot({ allSlotMatches, template, queryKind, proxyFile, ts });
}

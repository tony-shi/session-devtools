// parser 模块入口
// parseQuery：调用 template/selector 选定 template → matchSlots → buildParsedQuerySnapshot

import type { ParsedQuerySnapshot } from "./types";
import type { MatchSlotsInput } from "./matcher";
import { matchSlots } from "./matcher";
import { buildParsedQuerySnapshot } from "./ast-builder";
import { selectTemplate } from "../template/selector";
import { attributeSnapshot as _attributeSnapshot } from "./attribution";
import { linkJsonl as _linkJsonl } from "./attribution/jsonl-linker";
import type { LinkableJsonlEvent, CallContext, LinkJsonlReport } from "./attribution/jsonl-linker";
import { assertAllInvariants } from "./attribution/invariants";

export type { ParsedQuerySnapshot, SegmentNode, SlotMatch } from "./types";
export {
  attributeSnapshot,
  computeCoverage,
} from "./attribution";
export type {
  AttributionCoverage,
  AttributionMatchMode,
  CharCoverage,
  CharRange,
  DynamicField,
  DynamicFieldSource,
  SegmentAttribution,
} from "./attribution";
export type {
  SegmentOrigin,
  RuleOrigin,
  JsonlOrigin,
  JsonlEventKind,
  StructuralOrigin,
  UnknownOrigin,
  Evidence,
  DynamicFieldWithEvidence,
} from "./attribution/origin";
export {
  originContainer,
  originStructural,
  originUnknown,
} from "./attribution/origin";
export {
  assertAllInvariants,
  assertEveryNodeHasOrigin,
  assertContainerNodesAreStructural,
  assertLeafConcatEqualsParent,
  collectLeaves,
  AttributionInvariantError,
} from "./attribution/invariants";
export {
  linkJsonl,
} from "./attribution/jsonl-linker";
export type {
  LinkableJsonlEvent,
  CallContext,
  LinkJsonlReport,
} from "./attribution/jsonl-linker";

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

/**
 * attributeWithJsonl：完整的归因管线 — parser + rule attribution + jsonl link + invariants。
 *
 * 这是归因系统对外的"终态产物"入口：传 proxy reqBody + jsonl events + callContext，
 * 返回每个节点 origin 都已填好的 ParsedQuerySnapshot。
 */
export function attributeWithJsonl(input: {
  reqBody: MatchSlotsInput["reqBody"];
  proxyFile: string;
  reqHeaders?: Record<string, string>;
  ts?: string;
  jsonl: LinkableJsonlEvent[];
  call: CallContext;
}): { snapshot: ParsedQuerySnapshot; linkReport: LinkJsonlReport } {
  const snapshot = parseQuery({
    reqBody: input.reqBody,
    proxyFile: input.proxyFile,
    reqHeaders: input.reqHeaders,
    ts: input.ts,
  });
  _attributeSnapshot(snapshot);                   // PR 2：写 rule origin
  const linkReport = _linkJsonl(snapshot, input.jsonl, input.call);  // PR 3：写 jsonl origin
  assertAllInvariants(snapshot);
  return { snapshot, linkReport };
}

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
import { computeForwardAudit, type ForwardAudit } from "./audit/forward";
import { computeReverseAudit, type ReverseAudit } from "./audit/reverse";

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
  isCommandLikeText,
  COMMAND_TEXT_PREFIX_RE,
} from "./attribution/jsonl-linker";
export type {
  LinkableJsonlEvent,
  CallContext,
  LinkJsonlReport,
} from "./attribution/jsonl-linker";
export {
  computeTreeDiff,
} from "./attribution/tree-diff";
export type {
  AttributionTreeDiff,
  LeafDiffStatus,
  RemovedLeaf,
} from "./attribution/tree-diff";
export {
  coverageStateOf,
} from "./attribution/origin";
export type {
  CoverageState,
} from "./attribution/origin";
export { computeForwardAudit } from "./audit/forward";
export type { ForwardAudit, PartialReason } from "./audit/forward";
export { computeReverseAudit } from "./audit/reverse";
export type { ReverseAudit, ReverseAuditBucket, ReverseEventKind, MissingJsonlUnit } from "./audit/reverse";

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
}): {
  snapshot: ParsedQuerySnapshot;
  linkReport: LinkJsonlReport;
  audit: { forward: ForwardAudit; reverse: ReverseAudit };
} {
  const snapshot = parseQuery({
    reqBody: input.reqBody,
    proxyFile: input.proxyFile,
    reqHeaders: input.reqHeaders,
    ts: input.ts,
  });
  _attributeSnapshot(snapshot);                   // PR 2：写 rule origin
  const linkReport = _linkJsonl(snapshot, input.jsonl, input.call);  // PR 3：写 jsonl origin
  assertAllInvariants(snapshot);
  // Reverse audit 只看"此 call 时刻已写入 jsonl 的事件"。未做截断时，未来 turn 的
  // events 会被全部记为 missing（伪 missing），让 call 视图的"missing jsonl=N"数字
  // 严重失真（早期 call 越靠前越夸张）。截断依据：ev.ts <= proxy.startedAt。
  // ts 缺失的 event 保守保留 —— 它可能是 metadata，少报比误漏更安全。
  const reverseEvents = input.ts
    ? input.jsonl.filter((ev) => !ev.ts || ev.ts <= input.ts!)
    : input.jsonl;
  const audit = {
    forward: computeForwardAudit(snapshot),
    reverse: computeReverseAudit(snapshot, reverseEvents),
  };
  return { snapshot, linkReport, audit };
}

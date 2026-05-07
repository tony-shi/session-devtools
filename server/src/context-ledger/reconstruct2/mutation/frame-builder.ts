// reconstruct2 / mutation / frame-builder
//
// 输入：events（已 decode）+ mutations（已 normalize）+ ledger
// 输出：ContextFrame[]，并回填 ledger.frameIds + 最终 disposition
//
// 第一阶段 boundary 识别策略（仅依赖 JSONL，无 proxy 时间戳）：
//
//   - 主会话 main_session：把每条非 sidechain、非 isApiErrorMessage 的 assistant 行
//     视作一次 LLM call 的 *响应事件*。frame 的 mutationIds 是该 assistant 行 *之前*
//     已经积累的所有 main mutation（含 user / attachment / tool_result / 之前的 assistant）
//     ——即 LLM 在生成该 assistant 响应时看到的上下文。boundaryConfidence=confirmed。
//
//   - sidechain：subagent 路由到独立 frame 链（按 agentId 分组）。本期 frame builder
//     不深入 subagent 内部 boundary——subagent 内部仍可能存在多次 LLM call，留待
//     后续阶段实现。第一阶段 sidechain frame 仅记录"该 subagent 收到的累积 mutation
//     直到出现下一条 sidechain assistant 行"。boundaryConfidence=inferred。
//
// 关键不变量：
//   - frame.mutationIds 是累积的——frame N 包含 frame 1..N-1 的全部 mutationIds。
//   - assistant 行触发 frame 时，本行自身的 mutation *不* 进入该 frame；
//     它会在下一条 frame 里出现（作为"之前的助手响应"）。
//   - permission-mode 不进 frame.mutationIds（disposition=runtime_fact_only）。
//   - 无对应 assistant 响应的尾部 mutation（用户最近一条输入还没等到响应）会被汇总为
//     一个虚拟"pending" frame，标 boundaryConfidence=inferred、queryKind=unknown，
//     方便审计 UI 看到"截止当前 JSONL，下一次 LLM call 应该看到的上下文"。

import type {
  ClaudeJsonlEvent,
  ContextFrame,
  JsonlLineLedgerEntry,
} from "../jsonl/event-types";
import type { ContextMutation, HarnessRuntimeSnapshot } from "../../types";

export interface BuildFramesInput {
  events: ClaudeJsonlEvent[];
  mutations: ContextMutation[];
  sidechainMutations: ContextMutation[];
  eventToMutations: Map<string, string[]>;
  ledger: JsonlLineLedgerEntry[];
  sessionId: string;
  runtimeSnapshot: HarnessRuntimeSnapshot;
}

export interface BuildFramesResult {
  frames: ContextFrame[];
}

const MAIN_NOISE_CATEGORIES = new Set(["billing_noise", "permission"]);

/** 哪些 mutation 不进入 main session 的 frame（runtime_fact_only / 噪声）。
 * 注意：assistant_text / tool_use / tool_result / user_message 等都会进入 frame。
 */
function shouldExcludeFromFrame(m: ContextMutation): boolean {
  if (m.type === "noise") return true;
  if (MAIN_NOISE_CATEGORIES.has(m.category)) return true;
  return false;
}

export function buildFrames(input: BuildFramesInput): BuildFramesResult {
  const { events, mutations, sidechainMutations, eventToMutations, ledger, sessionId, runtimeSnapshot } = input;

  const ledgerByLine = new Map<number, JsonlLineLedgerEntry>();
  for (const entry of ledger) ledgerByLine.set(entry.line, entry);

  const frames: ContextFrame[] = [];
  let frameCounter = 0;
  const newFrameId = (suffix: string): string => {
    frameCounter += 1;
    return `frame-${frameCounter}-${suffix}`;
  };

  const mainMutationById = new Map<string, ContextMutation>();
  for (const m of mutations) mainMutationById.set(m.id, m);
  const sidechainMutationById = new Map<string, ContextMutation>();
  for (const m of sidechainMutations) sidechainMutationById.set(m.id, m);

  // ── 主会话 frame 切片 ──────────────────────────────────────────────────────
  const mainAccumulatedMutations: string[] = [];
  const mainAccumulatedEvents: string[] = [];
  let queryIndex = 0;

  // sidechain 暂存：按 agentId 分组累积
  const sidechainBuckets = new Map<string, { mutations: string[]; events: string[] }>();

  for (const event of events) {
    const ledgerEntry = ledgerByLine.get(event.line);
    const evtMutations = eventToMutations.get(event.id) ?? [];

    if (event.isSidechain) {
      const key = event.agentId ?? "anon";
      const bucket = sidechainBuckets.get(key) ?? { mutations: [], events: [] };
      bucket.events.push(event.id);
      for (const mid of evtMutations) {
        if (sidechainMutationById.has(mid)) bucket.mutations.push(mid);
      }
      sidechainBuckets.set(key, bucket);

      // sidechain assistant 触发 sidechain frame（boundaryConfidence=inferred）
      if (
        event.kind === "assistant" &&
        !event.isApiErrorMessage &&
        bucket.mutations.length > 0
      ) {
        queryIndex += 1;
        const frameId = newFrameId("side");
        const frame: ContextFrame = {
          frameId,
          callEventId: event.id,
          sessionId,
          queryIndex,
          queryKind: "side_query",
          mutationIds: bucket.mutations.slice(),
          eventIds: bucket.events.slice(),
          runtimeSnapshot: { ...runtimeSnapshot },
          boundary: {
            upToEventId: event.id,
            upToMutationId: bucket.mutations[bucket.mutations.length - 1],
            timestamp: event.timestamp,
            confidence: "inferred",
          },
          subagentId: event.agentId,
        };
        frames.push(frame);
        // 把 frameId 回填到该 frame 涉及的所有 mutation 对应的 line ledger
        annotateLedgerFrames(frame, sidechainMutationById, ledger, ledgerByLine);
      }

      // 不论是否触发 frame，sidechain 行都标 sidechain_routed
      if (ledgerEntry) {
        ledgerEntry.disposition = "sidechain_routed";
        ledgerEntry.reasonCode = "sidechain";
        ledgerEntry.metadata = {
          ...(ledgerEntry.metadata ?? {}),
          subagentId: event.agentId,
        };
      }
      continue;
    }

    // ── main 主链 ──
    const isCallBoundary =
      event.kind === "assistant" && !event.isApiErrorMessage;

    if (isCallBoundary) {
      queryIndex += 1;
      const main = filterMainMutationIds(mainAccumulatedMutations, mainMutationById);
      const frameId = newFrameId("main");
      const lastMutationId = main.length > 0 ? main[main.length - 1] : undefined;
      const frame: ContextFrame = {
        frameId,
        callEventId: event.id,
        sessionId,
        queryIndex,
        queryKind: "main_session",
        mutationIds: main,
        eventIds: mainAccumulatedEvents.slice(),
        runtimeSnapshot: { ...runtimeSnapshot },
        boundary: {
          upToEventId: event.id,
          upToMutationId: lastMutationId,
          timestamp: event.timestamp,
          confidence: "confirmed",
        },
      };
      frames.push(frame);
      annotateLedgerFrames(frame, mainMutationById, ledger, ledgerByLine);
    }

    // 把 event 的 mutation 加入 accumulator（包括 assistant，本身在下一帧才会被引用）
    mainAccumulatedEvents.push(event.id);
    for (const mid of evtMutations) {
      if (mainMutationById.has(mid)) mainAccumulatedMutations.push(mid);
    }
  }

  // ── pending frame：JSONL 末尾仍有 user 输入但还没等到 assistant 响应 ──
  if (mainAccumulatedMutations.length > 0) {
    const lastMain = mainAccumulatedMutations[mainAccumulatedMutations.length - 1];
    const lastFrame = frames[frames.length - 1];
    const lastFrameLast = lastFrame?.mutationIds[lastFrame.mutationIds.length - 1];
    if (lastMain !== lastFrameLast) {
      queryIndex += 1;
      const main = filterMainMutationIds(mainAccumulatedMutations, mainMutationById);
      const frameId = newFrameId("pending");
      const frame: ContextFrame = {
        frameId,
        callEventId: "pending",
        sessionId,
        queryIndex,
        queryKind: "unknown",
        mutationIds: main,
        eventIds: mainAccumulatedEvents.slice(),
        runtimeSnapshot: { ...runtimeSnapshot },
        boundary: {
          upToEventId: "pending",
          upToMutationId: main[main.length - 1],
          confidence: "inferred",
        },
      };
      frames.push(frame);
      annotateLedgerFrames(frame, mainMutationById, ledger, ledgerByLine);
    }
  }

  // ── ledger 收尾：包含 mutation 且进入过 frame 的行标 included_in_frame ──
  for (const entry of ledger) {
    if (entry.frameIds.length > 0) {
      entry.disposition = "included_in_frame";
      entry.reasonCode = entry.reasonCode || "in_frame";
    }
  }

  return { frames };
}

function filterMainMutationIds(
  ids: string[],
  byId: Map<string, ContextMutation>,
): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const m = byId.get(id);
    if (!m) continue;
    if (shouldExcludeFromFrame(m)) continue;
    out.push(id);
  }
  return out;
}

function annotateLedgerFrames(
  frame: ContextFrame,
  byId: Map<string, ContextMutation>,
  ledger: JsonlLineLedgerEntry[],
  ledgerByLine: Map<number, JsonlLineLedgerEntry>,
): void {
  // mutationId → line（通过 sourceRef.jsonl.line）
  for (const mid of frame.mutationIds) {
    const m = byId.get(mid);
    if (!m) continue;
    const line =
      m.sourceRef.kind === "jsonl" ? m.sourceRef.jsonl.line : undefined;
    if (line === undefined) continue;
    const entry = ledgerByLine.get(line);
    if (!entry) continue;
    if (!entry.frameIds.includes(frame.frameId)) {
      entry.frameIds.push(frame.frameId);
    }
  }
  // 触发 frame 的 callEventId 行也记上（assistant 行）
  // event 没有直接的 line 反查，但 ledger entry 含 eventIds，扫描即可
  for (const entry of ledger) {
    if (entry.eventIds.includes(frame.callEventId)) {
      if (!entry.frameIds.includes(frame.frameId)) {
        entry.frameIds.push(frame.frameId);
      }
    }
  }
}

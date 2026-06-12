// 左导航 gutter 的 run-lane 计算 —— 纯函数，无 React（A 案，05 文档 §3）。
//
// git graph 隐喻的最终落位：turn 列表 = commit list，run = branch。
// fork 点 = launch 所在 turn（●），join 点 = 回执 turn（◇，openerToolUseId
// 回指 launch）。lane 从首个 fork 延伸到最后一个已知点；多 run 时间重叠时
// 各占一列，span 结束后列位释放给后续 run 复用。
//
// 数据边界（如实，不猜）：
//   - launch 锚 resolve 失败（旧格式/截断 JSONL）→ 该 launch 不产 fork 点；
//     一个 run 的全部 launch 都失锚 → 整条 lane 不画。
//   - join 检测只覆盖 turn-opener 形态的回执（openerToolUseId 是 v15 的
//     turn 级字段）；mid-turn 批量回执没有结构化锚 → 不画 join，lane 止于
//     最后一个已知点。
//   - fork 与 join 同 turn（回执 turn 内立即 re-launch）时 fork 优先 —— gutter
//     是导航辅助不是审计视图，复合节点不值得引入。

import type { UserTurn, WorkflowRunSummary } from "../../drilldown-types";
import { resolveLaunchAnchor } from "./runJoin";

export interface GutterSpan {
  runId: string;
  workflowName: string;
  /** 0 起的列号。 */
  lane: number;
  forkTurnIds: number[];
  joinTurnIds: number[];
  startTurn: number;
  endTurn: number;
}

export type GutterLaneState = "none" | "pass" | "fork" | "join";

export interface GutterModel {
  spans: GutterSpan[];
  laneCount: number;
}

export function computeGutterLanes(runs: WorkflowRunSummary[], turns: UserTurn[]): GutterModel {
  const raw: Omit<GutterSpan, "lane">[] = [];
  for (const run of runs) {
    const forkTurnIds: number[] = [];
    const joinTurnIds: number[] = [];
    for (const l of run.launches) {
      const anchor = resolveLaunchAnchor(l.toolUseId, turns);
      if (anchor) forkTurnIds.push(anchor.turnId);
      for (const t of turns) {
        if (t.openerToolUseId === l.toolUseId) joinTurnIds.push(t.id);
      }
    }
    if (forkTurnIds.length === 0) continue; // 全部失锚 → 不画
    raw.push({
      runId: run.runId,
      workflowName: run.workflowName,
      forkTurnIds,
      joinTurnIds,
      startTurn: Math.min(...forkTurnIds),
      endTurn: Math.max(...forkTurnIds, ...joinTurnIds),
    });
  }

  // 贪心列分配：按 startTurn 升序，取首个"上一占用已在本 span 开始前结束"的列。
  // 严格小于 —— 同 turn 边界（前一 run 的 join 与后一 run 的 fork 同 turn）
  // 不复用，避免节点叠画。
  raw.sort((a, b) => a.startTurn - b.startTurn || a.endTurn - b.endTurn);
  const laneEnds: number[] = [];
  const spans: GutterSpan[] = raw.map((s) => {
    let lane = laneEnds.findIndex((e) => e < s.startTurn);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(s.endTurn);
    } else {
      laneEnds[lane] = s.endTurn;
    }
    return { ...s, lane };
  });

  return { spans, laneCount: laneEnds.length };
}

/** turn 行自身的 lane 状态（fork/join 节点只画在 turn 行）。 */
export function laneStateAtTurn(span: GutterSpan, turnId: number): GutterLaneState {
  if (turnId < span.startTurn || turnId > span.endTurn) return "none";
  if (span.forkTurnIds.includes(turnId)) return "fork"; // fork 优先于 join（见头注释）
  if (span.joinTurnIds.includes(turnId)) return "join";
  return "pass";
}

/**
 * turn 的附属行（call 子行 / compact 行，渲染在 turn 行下方）的 lane 状态：
 * fork turn 的子行在节点之后 → 画线；join/end turn 的子行在 lane 结束后 → 不画。
 */
export function laneStateAtSubRow(span: GutterSpan, turnId: number): GutterLaneState {
  return turnId >= span.startTurn && turnId < span.endTurn ? "pass" : "none";
}

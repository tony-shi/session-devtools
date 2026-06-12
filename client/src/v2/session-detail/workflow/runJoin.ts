// Workflow run 数据装配 —— 纯函数，无 React。
//
// 两个数据源在 SessionDrilldown 里各管一半：
//   run.agents[]（来自 wf json workflowProgress）= 身份/phase/cached/state
//   drilldown.subAgents[]（agentSource="workflow"，来自转录解析）= tokens/时长/result
// 这里按 agentFileId join。两边都来自同一份 drilldown 响应，无异步竞争。
//
// 正确性约定（与后端一致）：
//   - transcript 为 null = 转录缺失（hasTranscript=false 的防御场景）→ UI 显式
//     "无转录"禁用态，不编造数字。
//   - launch 锚 resolve 只走 toolUseId 精确匹配；找不到返回 null，UI 显式
//     "锚点未找到"，不按时间猜。

import type { SessionDrilldown, SubAgentSummary, UserTurn, WorkflowRunSummary, WorkflowRunAgent } from "../../drilldown-types";

export interface JoinedRunAgent {
  progress: WorkflowRunAgent;
  /** 转录侧统计（tokens/时长/result）。null = 无转录，禁下钻。 */
  transcript: SubAgentSummary | null;
}

export function joinRunAgents(run: WorkflowRunSummary, subAgents: SubAgentSummary[]): JoinedRunAgent[] {
  const byFileId = new Map<string, SubAgentSummary>();
  for (const sa of subAgents) {
    if (sa.agentSource === "workflow" && sa.workflowRunId === run.runId) {
      byFileId.set(sa.agentFileId, sa);
    }
  }
  return run.agents.map((pa) => ({
    progress: pa,
    transcript: byFileId.get(pa.agentFileId) ?? null,
  }));
}

export interface LaunchAnchor {
  turnId: number;
  callId: number;
}

/**
 * launch 的 tool_use → 主时间线 (turn, call) 的确定性反查：在所有 call 的
 * toolCalls 槽位里精确匹配 toolUseId。匹配不到返回 null（旧格式/截断 JSONL），
 * 由调用方显式渲染"锚点未找到"。
 */
export function resolveLaunchAnchor(toolUseId: string, turns: UserTurn[]): LaunchAnchor | null {
  if (!toolUseId) return null;
  for (const turn of turns) {
    for (const call of turn.calls) {
      if (call.toolCalls.some((tc) => tc.toolUseId === toolUseId)) {
        return { turnId: turn.id, callId: call.id };
      }
    }
  }
  return null;
}

export interface LaunchOrigin extends LaunchAnchor {
  /**
   * launch tool_use input 的第一个 key，从 toolCalls 槽位 inputPreview 的前缀
   * 确定性判别（JSON.stringify 截断到 300 字符，但首 key 必在开头）：
   *   "script"     → 脚本是该 call 的 LLM 输出（inline 调用，本机 14/19）
   *   "scriptPath" → 脚本来自文件（用户自有脚本或 resume 调用）
   *   null         → 前缀不匹配（截断异常/未来新形态），不猜
   */
  firstInputKey: "script" | "scriptPath" | null;
}

/**
 * launch 的脚本诞生处定位：anchor + input 首 key。脚本 provenance 的语义
 * 由调用方按 firstInputKey + 是否 resume 组合给出（见 ScriptTab）。
 */
export function resolveLaunchOrigin(toolUseId: string, turns: UserTurn[]): LaunchOrigin | null {
  if (!toolUseId) return null;
  for (const turn of turns) {
    for (const call of turn.calls) {
      const tc = call.toolCalls.find((s) => s.toolUseId === toolUseId);
      if (!tc) continue;
      // scriptPath 在前：交替虽有回溯，显式排序消除对引擎行为的依赖
      const m = /^\{"(scriptPath|script)"/.exec(tc.inputPreview);
      return {
        turnId: turn.id,
        callId: call.id,
        firstInputKey: (m?.[1] as "script" | "scriptPath" | undefined) ?? null,
      };
    }
  }
  return null;
}

/** launch tool_use id → 所属 run（M3 的 launch 特化卡 / 回执节点反查用）。 */
export function findRunByLaunchToolUseId(
  drilldown: SessionDrilldown,
  toolUseId: string,
): WorkflowRunSummary | null {
  if (!toolUseId) return null;
  for (const run of drilldown.workflowRuns ?? []) {
    if (run.launches.some((l) => l.toolUseId === toolUseId)) return run;
  }
  return null;
}

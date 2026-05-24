// SessionDetailContext —— 把"全局于这次 session 视图"的东西收进 context，让
// 子面板用 useSessionDetail() 取，而不是层层透传一堆回调。
//
// 核心：暴露唯一导航漏斗 navigate(nav)（= 编排器既有的 goNav，零新逻辑），
// 以及 linkedPanel / inspector 这两个不进 URL 的本地动作。这样一个今天要 8 个
// prop 的 panel，以后只收它真正渲染的 turn/call，其余从 context 拿。
//
// Phase 2：纯加法。provider 挂上、暴露编排器已经算好的值，但不强制任何组件迁移
// （旧 prop 路径照常工作）。Phase 3 起各域面板再逐步改成读 context。

import { createContext, useContext } from "react";
import type { SessionDrilldown, UserTurn } from "../drilldown-types";
import type { MockLlmCall, MockUserTurn, MockDiffEntry } from "../lib/mock-data";
import type { SessionNav, CallTab } from "./session-nav";

// ─── 右栏对比 / inspector 的本地 state 形状（不进 URL） ──────────────────────
// 由编排器持有，但 LinkedContextPanel 等也要消费 LinkedPanelState，故定义在此共享。

export type InspectorState =
  | { type: "hotspots" }
  | { type: "turn-rollup"; turn: MockUserTurn }
  | { type: "call-diff"; call: MockLlmCall }
  | { type: "evidence"; entry: MockDiffEntry };

export type LinkedPanelState =
  | {
      type: "call";
      call: MockLlmCall;
      turn: MockUserTurn;
      /** Tab the panel should land on when this jump is applied. Combined
       *  with `jumpVersion` to force-override the user's prior manual tab
       *  selection on every fresh jump (not just on call id change). */
      requestedTab?: CallTab;
      /** Bumps on every dispatched jump so panels useEffect can detect
       *  "another jump fired even if the call/tab look identical" and
       *  reset to the requested tab. */
      jumpVersion?: number;
    }
  | { type: "turn-excerpt"; turn: MockUserTurn; focusCall: MockLlmCall | null };

export interface SessionDetailContextValue {
  /** 当前 session id —— 下游 panel 的 proxy / attribution / drilldown fetch 都用它。 */
  sessionId: string;
  /** 编排器拉到的 drilldown（loading / error 时为 null，turns 会退到 fallback）。 */
  drilldown: SessionDrilldown | null;
  /** 已就绪的 turns（drilldown.turns 或 fallback）。 */
  turns: UserTurn[];
  /** mock 数据态（drilldown===null）—— 控制是否注入 mock sub-agents 等。 */
  isMockSession: boolean;

  /** 唯一导航漏斗：handler 只调它，navigate(buildSessionPath(...)); URL 变化由
   *  reconciliation effect 写回 state。= 编排器既有的 goNav，零新逻辑。 */
  navigate: (nav: SessionNav) => void;

  /** linkedPanel（右栏对比视图）动作 —— 不进 URL（对比 / 次要状态）。 */
  linkTo: {
    call: (call: MockLlmCall, turnHint?: MockUserTurn | null, requestedTab?: CallTab) => void;
    turnExcerpt: (turn: MockUserTurn, focusCall: MockLlmCall | null) => void;
    close: () => void;
  };

  /** inspector（右栏 evidence 详情）选中某条 diff entry —— 不进 URL。 */
  selectEntry: (entry: MockDiffEntry) => void;
}

const SessionDetailContext = createContext<SessionDetailContextValue | null>(null);

export const SessionDetailProvider = SessionDetailContext.Provider;

export function useSessionDetail(): SessionDetailContextValue {
  const ctx = useContext(SessionDetailContext);
  if (!ctx) {
    throw new Error("useSessionDetail must be used within a SessionDetailProvider");
  }
  return ctx;
}

// Turn opener 层 —— 按 openerSource 分发到 per-source 渲染（与 tool-adapters 同构）。
//
// parser 建模 3 种 opener（UserTurn.openerSource）：
//   human            —— 真实人类输入（含 [Request interrupted by user] 打断标记，
//                        它是 user-role 非 meta、过 isHumanInput，归 human）
//   task-notification —— 后台任务完成回执
//   teammate-message —— agent teams 入站消息
// 其余"注入的 user 消息"（command / skill_injection / compact / 海量 isMeta
// system-reminder）都不开 turn，由 IntervalEventRow / CompactEvent 处理。

import { useTranslation } from "react-i18next";
import type { UserTurn } from "../../../drilldown-types";
import { ChainNarrativeNode } from "../rows/ChainNarrativeNode";
import { AsyncReceiptNode } from "./AsyncReceiptNode";
import { TeammateMessageNode } from "./TeammateMessageNode";

export function TurnOpener({ turn }: { turn: UserTurn }) {
  const { t } = useTranslation();
  if (turn.openerSource === "task-notification") return <AsyncReceiptNode turn={turn} />;
  if (turn.openerSource === "teammate-message") return <TeammateMessageNode turn={turn} />;
  // human（默认，含打断标记）
  return (
    <ChainNarrativeNode
      kind="user"
      label={t("terms.userInput")}
      text={turn.userInput}
      meta={turn.startedAt ? turn.startedAt.slice(11, 19) : undefined}
      lineIdx={turn.userInputLineIdx}
    />
  );
}

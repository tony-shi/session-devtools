// GutterCell —— 左导航行内嵌的 run-lane 段（git graph 列的 React 标准做法：
// 每行渲染自己的 lane 片段，竖线 height:100%，行高可变也不断线）。
//
// 视觉词汇（workflow 紫域）：
//   pass  全高竖线        run 跨越此行
//   fork  ● + 下半竖线    launch 发生在此 turn
//   join  上半竖线 + ◇    回执到达此 turn（lane 终点）
//
// 点击 fork/join 节点 → run 面板。pass 段不可点（避免误触 turn 行点击）。

import React from "react";
import type { GutterLaneState } from "./gutterLanes";

const LANE_W = 10;
const COLOR = "#7e22ce";
const LINE_W = 2;

export interface GutterLaneCell {
  state: GutterLaneState;
  runId: string;
  workflowName: string;
}

export function GutterCell({ lanes, onSelectRun }: {
  lanes: GutterLaneCell[];
  onSelectRun: (runId: string) => void;
}) {
  return (
    <div style={{ display: "flex", flexShrink: 0, alignSelf: "stretch" }}>
      {lanes.map((l, i) => (
        <div key={i} style={{ width: LANE_W, position: "relative" }}>
          {(l.state === "pass" || l.state === "fork" || l.state === "join") && (
            <div style={{
              position: "absolute",
              left: (LANE_W - LINE_W) / 2,
              width: LINE_W,
              background: COLOR,
              opacity: 0.45,
              // fork：节点以下；join：节点以上；pass：全高
              top: l.state === "fork" ? "50%" : 0,
              bottom: l.state === "join" ? "50%" : 0,
            }} />
          )}
          {l.state === "fork" && (
            <div
              title={`${l.workflowName || l.runId} · launch`}
              onClick={(e) => { e.stopPropagation(); onSelectRun(l.runId); }}
              style={{
                position: "absolute", top: "50%", left: "50%",
                transform: "translate(-50%, -50%)",
                width: 7, height: 7, borderRadius: "50%",
                background: COLOR, cursor: "pointer",
                boxShadow: "0 0 0 1.5px #fff",
              }}
            />
          )}
          {l.state === "join" && (
            <div
              title={`${l.workflowName || l.runId} · 回执`}
              onClick={(e) => { e.stopPropagation(); onSelectRun(l.runId); }}
              style={{
                position: "absolute", top: "50%", left: "50%",
                transform: "translate(-50%, -50%) rotate(45deg)",
                width: 6, height: 6,
                background: "#fff", border: `1.5px solid ${COLOR}`,
                cursor: "pointer",
              }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

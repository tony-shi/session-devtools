// Turn-level ECharts visualization.
//
// Design intent:
//   Grid 0: context step line, x = call index C1..Cn.
//   Grid 1: observed tool response heatmap, x = "before call i", y = tool family.
//
// The heatmap is intentionally factual. It uses JSONL-derived toolCalls:
//   call[i - 1].toolCalls -> tool responses observed before call[i].
// It does not claim full context attribution or reuse.

import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { HeatmapChart, LineChart } from "echarts/charts";
import {
  AxisPointerComponent,
  DataZoomComponent,
  GridComponent,
  MarkPointComponent,
  TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { LlmCall, UserTurn } from "./drilldown-types";

echarts.use([
  LineChart,
  HeatmapChart,
  GridComponent,
  TooltipComponent,
  AxisPointerComponent,
  DataZoomComponent,
  VisualMapComponent,
  MarkPointComponent,
  CanvasRenderer,
]);

// Formatting

function fmtK(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (abs >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(Math.round(n));
}

// Tool taxonomy

const TOOL_ROWS = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Grep",
  "Agent",
  "Web",
  "Other",
] as const;
type ToolRow = typeof TOOL_ROWS[number];

const TOOL_ACCENT: Record<ToolRow, string> = {
  Read: "#4f46e5",
  Write: "#d97706",
  Edit: "#ea580c",
  Bash: "#16a34a",
  Grep: "#2563eb",
  Agent: "#7c3aed",
  Web: "#0891b2",
  Other: "#64748b",
};

function classifyTool(name: string): ToolRow {
  const raw = name.trim();
  const base = raw.match(/^([A-Za-z_]+)/)?.[1] ?? raw.split(/\s|\(/)[0] ?? raw;
  if (base === "Read") return "Read";
  if (base === "Write" || base === "NotebookWrite") return "Write";
  if (base === "Edit" || base === "MultiEdit") return "Edit";
  if (base === "Bash") return "Bash";
  if (base === "Grep" || base === "Glob" || base === "grep") return "Grep";
  if (base === "Agent" || base === "Task") return "Agent";
  if (base === "WebFetch" || base === "WebSearch") return "Web";
  return "Other";
}

// Data model

interface CallPoint {
  idx: number;
  label: string;
  contextSize: number;
  isCompaction: boolean;
}

interface ToolEvent {
  toolUseId: string;
  name: string;
  inputPreview: string;
  inputSize: number;
  outputPreview: string;
  outputSize: number;
  isError: boolean;
}

interface ToolCell {
  callIdx: number; // Target call column: observed before this call.
  sourceCall: LlmCall;
  targetCall: LlmCall;
  toolRow: ToolRow;
  outputSize: number;
  inputSize: number;
  count: number;
  errorCount: number;
  events: ToolEvent[];
}

// One sub-agent invocation absorbed into a parent call.
// `peakContext` is the sub-agent's own peak context — what main context would
// have peaked at had this exploration happened inline.
// `returnedSize` is the size of the tool_result actually folded back into main.
// `savings = max(0, peakContext - returnedSize)` is the compressed-away amount.
interface SubAgentAgent {
  agentType: string;
  description: string;
  toolUseId: string;
  llmCallCount: number;
  durationMs: number;
  peakContext: number;
  lastContext: number;
  returnedSize: number;
  savings: number;
}

// A sub-agent "compression event" anchored at a single parent call.
// `terminateIdx` is the call index (inclusive) where the savings stop being
// visualized — either the call just before the next compaction, or the last
// call of the turn.
interface SubAgentEvent {
  triggerIdx: number;
  terminateIdx: number;
  totalSavings: number;
  agents: SubAgentAgent[];
}

interface MinimapData {
  calls: CallPoint[];
  cells: ToolCell[];
  activeRows: ToolRow[];
  maxCtx: number;
  maxOutput: number;
  totalToolEvents: number;
  totalOutputSize: number;
  subAgentEvents: SubAgentEvent[];
  // Per-call counterfactual context. Same length as calls. null where no
  // active sub-agent savings are in effect (or value equals actual).
  counterfactual: Array<number | null>;
  totalSubAgentSavings: number;
}

// Compression below this threshold is hidden to reduce visual noise on
// trivial Agent calls (e.g. a 200-char status-check sub-agent).
const SUB_AGENT_MIN_SAVINGS = 2_000;

function buildData(turn: UserTurn): MinimapData {
  const calls = turn.calls.map((c, i) => ({
    idx: i,
    label: `C${c.indexInTurn}`,
    contextSize: c.contextSize,
    isCompaction: c.isCompaction,
  }));

  const cellMap = new Map<string, ToolCell>();

  // Column C_i represents tool responses produced after C_(i-1) and observed
  // before C_i. C1 is usually empty because no prior tool result exists in turn.
  for (let targetIdx = 1; targetIdx < turn.calls.length; targetIdx++) {
    const sourceCall = turn.calls[targetIdx - 1];
    const targetCall = turn.calls[targetIdx];
    const toolCalls = sourceCall.toolCalls ?? [];

    for (const tc of toolCalls) {
      const row = classifyTool(tc.name);
      const key = `${targetIdx}:${row}`;
      const existing = cellMap.get(key);
      const event: ToolEvent = {
        toolUseId: tc.toolUseId,
        name: tc.name,
        inputPreview: tc.inputPreview,
        inputSize: tc.inputSize,
        outputPreview: tc.outputPreview,
        outputSize: tc.outputSize,
        isError: tc.isError,
      };

      if (existing) {
        existing.outputSize += tc.outputSize;
        existing.inputSize += tc.inputSize;
        existing.count += 1;
        existing.errorCount += tc.isError ? 1 : 0;
        existing.events.push(event);
      } else {
        cellMap.set(key, {
          callIdx: targetIdx,
          sourceCall,
          targetCall,
          toolRow: row,
          outputSize: tc.outputSize,
          inputSize: tc.inputSize,
          count: 1,
          errorCount: tc.isError ? 1 : 0,
          events: [event],
        });
      }
    }
  }

  const cells = Array.from(cellMap.values());
  const usedRows = new Set(cells.map(c => c.toolRow));
  const activeRows = TOOL_ROWS.filter(r => usedRows.has(r));

  // Sub-agent compression events: identify trigger calls, compute per-agent
  // returnedSize via toolUseId lookup, and pick a terminateIdx at the next
  // compaction (or end of turn) — savings are persistent until reset.
  const subAgentEvents: SubAgentEvent[] = [];
  for (let i = 0; i < turn.calls.length; i++) {
    const call = turn.calls[i];
    const subAgents = call.subAgents ?? [];
    if (!subAgents.length) continue;

    const agents: SubAgentAgent[] = [];
    let totalSavings = 0;
    for (const sa of subAgents) {
      const slot = call.toolCalls.find(tc => tc.toolUseId === sa.toolUseId);
      const returnedSize = slot?.outputSize ?? 0;
      const savings = Math.max(0, sa.peakContext - returnedSize);
      if (savings < SUB_AGENT_MIN_SAVINGS) continue;
      agents.push({
        agentType: sa.agentType,
        description: sa.description,
        toolUseId: sa.toolUseId,
        llmCallCount: sa.llmCallCount,
        durationMs: sa.durationMs,
        peakContext: sa.peakContext,
        lastContext: sa.lastContext,
        returnedSize,
        savings,
      });
      totalSavings += savings;
    }
    if (!agents.length) continue;

    // Terminate at the call BEFORE the next compaction (compaction itself
    // resets both lines to a much lower value, so the gap is meaningless
    // afterwards). If no compaction follows, run to end of turn.
    let terminateIdx = turn.calls.length - 1;
    for (let j = i + 1; j < turn.calls.length; j++) {
      if (turn.calls[j].isCompaction) { terminateIdx = j - 1; break; }
    }
    if (terminateIdx < i) terminateIdx = i;

    subAgentEvents.push({ triggerIdx: i, terminateIdx, totalSavings, agents });
  }

  // Per-call cumulative active savings: at any call k, sum savings of all
  // sub-agent events whose [triggerIdx, terminateIdx] window contains k.
  // The counterfactual line equals actual + active savings (or null when 0).
  const counterfactual: Array<number | null> = calls.map((c, k) => {
    let active = 0;
    let anyTouches = false;
    for (const ev of subAgentEvents) {
      // The trigger call C_t itself is anchored to the actual line (the agent
      // hasn't run yet at C_t) — savings start showing at C_(t+1).
      if (k > ev.triggerIdx && k <= ev.terminateIdx) {
        active += ev.totalSavings;
        anyTouches = true;
      } else if (k === ev.triggerIdx) {
        anyTouches = true; // anchor point — counterfactual touches actual here
      }
    }
    if (!anyTouches) return null;
    return c.contextSize + active;
  });

  const maxCounterfactual = counterfactual.reduce<number>(
    (m, v) => (v != null && v > m ? v : m), 0,
  );
  const maxCtx = Math.max(...calls.map(c => c.contextSize), maxCounterfactual, 50_000);
  const maxOutput = Math.max(...cells.map(c => c.outputSize), 1);
  const totalToolEvents = cells.reduce((sum, c) => sum + c.count, 0);
  const totalOutputSize = cells.reduce((sum, c) => sum + c.outputSize, 0);
  const totalSubAgentSavings = subAgentEvents.reduce((s, e) => s + e.totalSavings, 0);

  return {
    calls,
    cells,
    activeRows,
    maxCtx,
    maxOutput,
    totalToolEvents,
    totalOutputSize,
    subAgentEvents,
    counterfactual,
    totalSubAgentSavings,
  };
}

// ECharts option

const PAD_L = 64;
const PAD_R = 18;
const CTX_H = 104;
const ROW_H = 34;
const GAP = 18;
const X_LABEL_H = 24;
const ZOOM_THRESHOLD = 36;
const ZOOM_WINDOW = 34;
const ZOOM_H = 28;

type HeatmapValue = [number, number, number, number, number, number, number];
type TooltipParam = { seriesName?: string; dataIndex?: number; value?: unknown; axisValue?: string | number };

function buildOption(data: MinimapData): echarts.EChartsCoreOption {
  const { calls, cells, activeRows, maxCtx, maxOutput, subAgentEvents, counterfactual } = data;
  if (!calls.length) return {};

  // Lookup: trigger index → SubAgentEvent (for tooltip / markPoint annotation).
  const subAgentByTrigger = new Map<number, SubAgentEvent>();
  for (const ev of subAgentEvents) subAgentByTrigger.set(ev.triggerIdx, ev);

  // Lookup: any call → list of sub-agent events whose window covers it
  // (used to expose "active savings" in the tooltip on downstream calls).
  const activeSubAgentByCall = new Map<number, SubAgentEvent[]>();
  for (const ev of subAgentEvents) {
    for (let k = ev.triggerIdx; k <= ev.terminateIdx; k++) {
      const list = activeSubAgentByCall.get(k) ?? [];
      list.push(ev);
      activeSubAgentByCall.set(k, list);
    }
  }

  const visibleRows: string[] = activeRows.length ? [...activeRows] : ["No tools"];
  const callCats = calls.map(c => c.label);
  const rowCats = visibleRows;
  const matrixH = Math.max(visibleRows.length, 1) * ROW_H;
  const labelMode = calls.length <= 20 ? "full" : calls.length <= 36 ? "compact" : "sparse";
  const showZoom = calls.length > ZOOM_THRESHOLD;
  const zoomEndValue = Math.min(calls.length - 1, ZOOM_WINDOW - 1);
  const xLabelInterval = calls.length > 54 ? 2 : calls.length > 32 ? 1 : 0;

  const heatmapData = cells.map((cell): HeatmapValue => [
    cell.callIdx,
    visibleRows.indexOf(cell.toolRow),
    cell.outputSize,
    cell.count,
    cell.inputSize,
    cell.errorCount,
    cell.sourceCall.indexInTurn,
  ]);

  const cellsByCall = new Map<number, ToolCell[]>();
  for (const cell of cells) {
    const list = cellsByCall.get(cell.callIdx) ?? [];
    list.push(cell);
    cellsByCall.set(cell.callIdx, list);
  }

  function heatmapLabelFormatter(params: { value?: unknown }): string {
    const value = params.value as HeatmapValue | undefined;
    if (!value) return "";
    const outputSize = value[2];
    const count = value[3];
    if (outputSize <= 0) return "";
    if (labelMode === "full") return `${count}x\n${fmtK(outputSize)}`;
    if (labelMode === "compact") return outputSize >= maxOutput * 0.16 ? `${count}x` : "";
    return outputSize >= maxOutput * 0.32 ? fmtK(outputSize) : "";
  }

  function tooltipFormatter(params: unknown): string {
    const arr = (Array.isArray(params) ? params : [params]) as TooltipParam[];
    if (!arr.length) return "";
    let callIdx = -1;

    for (const p of arr) {
      const value = p.value as HeatmapValue | number | undefined;
      if (Array.isArray(value) && typeof value[0] === "number") {
        callIdx = value[0];
        break;
      }
      if (p.seriesName === "Context" && typeof p.dataIndex === "number") {
        callIdx = p.dataIndex;
        break;
      }
      if (typeof p.axisValue === "string") {
        const idx = callCats.indexOf(p.axisValue);
        if (idx >= 0) callIdx = idx;
      }
    }

    if (callIdx < 0) return "";
    const call = calls[callIdx];
    if (!call) return "";

    const prev = calls[callIdx - 1];
    const delta = prev ? call.contextSize - prev.contextSize : 0;
    const deltaColor = delta >= 0 ? "#d97706" : "#16a34a";
    const toolCells = [...(cellsByCall.get(callIdx) ?? [])].sort((a, b) => b.outputSize - a.outputSize);
    const toolOutput = toolCells.reduce((sum, c) => sum + c.outputSize, 0);
    const toolCount = toolCells.reduce((sum, c) => sum + c.count, 0);
    const toolLines = toolCells.slice(0, 5).map(cell => (
      `<br/><span style="color:${TOOL_ACCENT[cell.toolRow]};font-weight:700">${cell.toolRow}</span>` +
      ` ${cell.count}x · <strong>${fmtK(cell.outputSize)}</strong>`
    )).join("");
    const more = toolCells.length > 5 ? `<br/><span style="color:#9ca3af">+${toolCells.length - 5} tool rows</span>` : "";

    // Sub-agent compression block. Two states:
    //   1. callIdx is a trigger — show each agent's peak/returned/saved breakdown.
    //   2. callIdx is downstream of a still-active trigger — show "carried savings".
    let subAgentBlock = "";
    const triggerEvent = subAgentByTrigger.get(callIdx);
    const activeEvents = activeSubAgentByCall.get(callIdx) ?? [];
    if (triggerEvent) {
      const lines = triggerEvent.agents.map(a => (
        `<br/><span style="color:#a855f7;font-weight:700">${a.agentType}</span> ` +
        `· ${a.llmCallCount} calls · peak <strong>${fmtK(a.peakContext)}</strong> ` +
        `→ returned <strong>${fmtK(a.returnedSize)}</strong> ` +
        `<span style="color:#a855f7">(saved ${fmtK(a.savings)})</span>`
      )).join("");
      subAgentBlock = (
        `<br/><span style="color:#a855f7;font-weight:700">Sub-agent compression</span> ` +
        `<span style="color:#d8b4fe">total saved ${fmtK(triggerEvent.totalSavings)}</span>` +
        lines
      );
    } else if (activeEvents.length) {
      const total = activeEvents.reduce((s, e) => s + e.totalSavings, 0);
      const triggers = activeEvents.map(e => calls[e.triggerIdx]?.label ?? "?").join(", ");
      subAgentBlock = (
        `<br/><span style="color:#a855f7;font-weight:700">Carrying sub-agent savings</span> ` +
        `<span style="color:#d8b4fe">${fmtK(total)} ` +
        `(from ${triggers})</span>`
      );
    }

    return [
      `<strong>${call.label}</strong>`,
      `<br/>Context: <strong>${fmtK(call.contextSize)}</strong>`,
      callIdx > 0 ? `<br/>Delta: <span style="color:${deltaColor}">${delta >= 0 ? "+" : ""}${fmtK(delta)}</span>` : "",
      `<br/>Tool responses before call: <strong>${toolCount}x</strong> · <strong>${fmtK(toolOutput)}</strong>`,
      toolLines || `<br/><span style="color:#9ca3af">No tool response observed</span>`,
      more,
      subAgentBlock,
      `<br/><span style="color:#9ca3af">Click to open call detail</span>`,
    ].join("");
  }

  return {
    animation: false,
    backgroundColor: "transparent",
    axisPointer: {
      type: "line",
      snap: true,
      link: [{ xAxisIndex: [0, 1] }],
      label: { backgroundColor: "#111827" },
    },
    grid: [
      { id: "ctx", left: PAD_L, right: PAD_R, top: 10, height: CTX_H },
      {
        id: "matrix",
        left: PAD_L,
        right: PAD_R,
        top: 10 + CTX_H + GAP + X_LABEL_H,
        height: matrixH,
      },
    ],
    visualMap: {
      show: false,
      min: 0,
      max: maxOutput,
      dimension: 2,
      // series order: 0=ctx-line, 1=ctx-counterfactual, 2=tool-heatmap.
      // visualMap targets ONLY the heatmap.
      seriesIndex: 2,
      inRange: {
        color: ["#fff1f2", "#fecdd3", "#fb7185", "#e11d48", "#7f1d1d"],
      },
      outOfRange: {
        color: ["#fff7f7"],
      },
    },
    dataZoom: [
      {
        type: "inside",
        xAxisIndex: [0, 1],
        filterMode: "none",
        startValue: 0,
        endValue: showZoom ? zoomEndValue : calls.length - 1,
        moveOnMouseWheel: true,
        zoomOnMouseWheel: "ctrl",
      },
      ...(showZoom ? [{
        type: "slider",
        xAxisIndex: [0, 1],
        filterMode: "none",
        height: 18,
        bottom: 4,
        showDetail: false,
        brushSelect: false,
        borderColor: "#fecdd3",
        fillerColor: "rgba(254, 202, 202, 0.45)",
        handleSize: 12,
        handleStyle: { color: "#e11d48" },
        dataBackground: {
          lineStyle: { color: "#fecdd3" },
          areaStyle: { color: "#fff1f2" },
        },
      }] : []),
    ],
    xAxis: [
      {
        id: "xCtx",
        gridId: "ctx",
        gridIndex: 0,
        type: "category",
        data: callCats,
        boundaryGap: true,
        axisLine: { lineStyle: { color: "#e5e7eb" } },
        axisTick: { show: false },
        axisLabel: { show: false },
        splitLine: { show: true, lineStyle: { color: "#f3f4f6" } },
      },
      {
        id: "xMatrix",
        gridId: "matrix",
        gridIndex: 1,
        type: "category",
        data: callCats,
        boundaryGap: true,
        position: "top",
        axisLine: { lineStyle: { color: "#e5e7eb" } },
        axisTick: { show: false },
        axisLabel: {
          interval: xLabelInterval,
          hideOverlap: true,
          fontSize: 9,
          color: "#94a3b8",
        },
        splitLine: { show: true, lineStyle: { color: "#f1f5f9" } },
        splitArea: { show: true, areaStyle: { color: ["#ffffff", "#fafafa"] } },
      },
    ],
    yAxis: [
      {
        id: "yCtx",
        gridId: "ctx",
        gridIndex: 0,
        type: "value",
        min: 0,
        max: maxCtx,
        axisLabel: {
          fontSize: 8,
          color: "#cbd5e1",
          formatter: (v: number) => fmtK(v),
          width: 54,
          overflow: "truncate",
        },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { show: true, lineStyle: { color: "#f1f5f9" } },
      },
      {
        id: "yMatrix",
        gridId: "matrix",
        gridIndex: 1,
        type: "category",
        data: rowCats,
        inverse: false,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          fontSize: 10,
          color: "#374151",
          fontWeight: 700,
        },
        splitLine: { show: true, lineStyle: { color: "#f1f5f9" } },
        splitArea: { show: true, areaStyle: { color: ["#ffffff", "#fbfdff"] } },
      },
    ],
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "line" },
      backgroundColor: "#111827",
      borderColor: "#374151",
      borderWidth: 1,
      textStyle: { color: "#f9fafb", fontSize: 11 },
      extraCssText: "max-width: 520px; white-space: normal;",
      formatter: tooltipFormatter,
    },
    series: [
      {
        id: "ctx-line",
        name: "Context",
        type: "line",
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: calls.map(c => c.contextSize),
        lineStyle: { color: "#6366f1", width: 2.5 },
        symbol: "circle",
        showSymbol: calls.length <= ZOOM_THRESHOLD,
        symbolSize: 4,
        itemStyle: { color: "#6366f1" },
        areaStyle: {
          color: {
            type: "linear",
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: "#6366f11f" },
              { offset: 1, color: "#6366f103" },
            ],
          },
        },
        markPoint: {
          symbol: "diamond",
          symbolSize: 11,
          data: [
            // Compaction markers (red diamonds) — context-resetting events.
            ...calls
              .filter(c => c.isCompaction)
              .map(c => ({
                coord: [c.idx, c.contextSize],
                itemStyle: { color: "#dc2626" },
                label: { show: false },
              })),
            // Sub-agent trigger markers (purple triangles). Annotated with
            // total savings so the compression value is visible at a glance.
            ...subAgentEvents.map(ev => {
              const call = calls[ev.triggerIdx];
              return {
                coord: [ev.triggerIdx, call?.contextSize ?? 0],
                symbol: "triangle",
                symbolSize: 12,
                itemStyle: { color: "#a855f7", borderColor: "#ffffff", borderWidth: 1 },
                label: {
                  show: true,
                  position: "top" as const,
                  formatter: `-${fmtK(ev.totalSavings)}`,
                  color: "#7e22ce",
                  fontSize: 9,
                  fontWeight: 700,
                  backgroundColor: "#faf5ff",
                  borderColor: "#d8b4fe",
                  borderWidth: 1,
                  borderRadius: 3,
                  padding: [1, 4],
                },
              };
            }),
          ],
        },
        z: 3,
      },
      // Counterfactual line: where main context WOULD have peaked had each
      // sub-agent exploration happened inline. Drawn dashed in purple, with a
      // translucent purple area down to 0 — the actual line's own (more
      // opaque) area fill covers everything below it, so the purple shows
      // visually only in the strip BETWEEN the two lines = the "saved" band.
      {
        id: "ctx-counterfactual",
        name: "If inline (no sub-agent)",
        type: "line",
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: counterfactual,
        connectNulls: false,
        showSymbol: false,
        symbol: "none",
        lineStyle: { color: "#a855f7", width: 1.5, type: "dashed" },
        itemStyle: { color: "#a855f7" },
        areaStyle: {
          color: "#a855f714",
          origin: "start",
        },
        emphasis: { focus: "none" },
        z: 2,
        silent: false,
      },
      {
        id: "tool-heatmap",
        name: "Tool responses",
        type: "heatmap",
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: heatmapData,
        encode: { x: 0, y: 1, value: 2 },
        label: {
          show: true,
          formatter: heatmapLabelFormatter,
          color: "#111827",
          fontSize: 9,
          lineHeight: 11,
          textBorderColor: "#ffffff",
          textBorderWidth: 2,
        },
        itemStyle: {
          borderColor: "#ffffff",
          borderWidth: 2,
          borderRadius: 3,
        },
        emphasis: {
          itemStyle: {
            borderColor: "#111827",
            borderWidth: 1,
            shadowBlur: 8,
            shadowColor: "rgba(17, 24, 39, 0.18)",
          },
        },
        z: 2,
      },
    ],
  };
}

// React component

export interface TurnMinimapProps {
  turn: UserTurn;
  onSelectCall?: (callId: number) => void;
}

export function TurnMinimap({ turn, onSelectCall }: TurnMinimapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = echarts.init(el, undefined, { renderer: "canvas" });
    chartRef.current = chart;

    chart.on("click", (params) => {
      if (!onSelectCall) return;
      if (params.seriesName === "Context") {
        const idx = params.dataIndex as number;
        const call = turn.calls[idx];
        if (call) onSelectCall(call.id);
      }
      if (params.seriesName === "Tool responses") {
        const value = params.value as HeatmapValue | undefined;
        const targetIdx = value?.[0];
        const call = typeof targetIdx === "number" ? turn.calls[targetIdx] : undefined;
        if (call) onSelectCall(call.id);
      }
    });

    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, [onSelectCall, turn.calls]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const data = buildData(turn);

    const rowCount = Math.max(data.activeRows.length, 1);
    const showZoom = turn.calls.length > ZOOM_THRESHOLD;
    const totalH = 10 + CTX_H + GAP + X_LABEL_H + rowCount * ROW_H + (showZoom ? ZOOM_H : 10);
    if (containerRef.current) {
      containerRef.current.style.height = `${totalH}px`;
    }

    chart.resize();
    chart.setOption(buildOption(data), true);
  }, [turn]);

  if (!turn.calls.length) return null;

  const data = buildData(turn);

  return (
    <div style={{ background: "#ffffff", overflow: "hidden" }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "7px 10px",
        borderBottom: "1px solid #f1f5f9",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <div style={{ width: 16, height: 0, borderTop: "2px solid #6366f1" }} />
          <span style={{ fontSize: 10, color: "#64748b", fontWeight: 600 }}>context</span>
        </div>
        {data.subAgentEvents.length > 0 && (
          <>
            <div style={{ width: 1, height: 14, background: "#e5e7eb" }} />
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <div style={{ width: 16, height: 0, borderTop: "1.5px dashed #a855f7" }} />
              <span style={{ fontSize: 10, color: "#7e22ce", fontWeight: 600 }}>if inline</span>
              <span style={{ fontSize: 10, color: "#a855f7" }}>
                saved {fmtK(data.totalSubAgentSavings)} via {data.subAgentEvents.length} sub-agent{data.subAgentEvents.length > 1 ? "s" : ""}
              </span>
            </div>
          </>
        )}
        <div style={{ width: 1, height: 14, background: "#e5e7eb" }} />
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <div style={{
            width: 44,
            height: 9,
            borderRadius: 2,
            background: "linear-gradient(90deg, #fff1f2, #fb7185, #7f1d1d)",
            border: "1px solid #fecdd3",
          }} />
          <span style={{ fontSize: 10, color: "#64748b", fontWeight: 600 }}>response size</span>
          <span style={{ fontSize: 10, color: "#94a3b8" }}>max {fmtK(data.maxOutput)}</span>
        </div>
        <span style={{ fontSize: 10, color: "#94a3b8" }}>label = count x size</span>
        {turn.calls.length > ZOOM_THRESHOLD && (
          <span style={{ fontSize: 10, color: "#be123c", background: "#fff1f2", border: "1px solid #fecdd3", borderRadius: 4, padding: "1px 6px" }}>
            drag window
          </span>
        )}
        <span style={{ marginLeft: "auto", fontSize: 10, color: "#cbd5e1" }}>
          {turn.calls.length} calls / {data.totalToolEvents} tool responses / {fmtK(data.totalOutputSize)} chars
        </span>
      </div>

      <div ref={containerRef} style={{ width: "100%", height: 220 }} />

      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "5px 10px",
        borderTop: "1px solid #f1f5f9",
        fontSize: 10,
        color: "#94a3b8",
      }}>
        <span style={{ fontWeight: 700, color: "#64748b" }}>cell:</span>
        <span>color = total tool_result output size</span>
        <span>text = response count x output size</span>
        <span>hover = call summary</span>
        <span>click = call detail</span>
      </div>
    </div>
  );
}

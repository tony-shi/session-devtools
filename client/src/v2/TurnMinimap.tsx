// Turn-level ECharts visualization.
//
// Grid 0: context step line, x = call index C1..Cn.
// Grid 1: dual-channel tool heatmap (custom series).
//   Each cell is split vertically:
//     Top half  = tool REQUEST input size  (what LLM wrote to invoke the tool)
//     Bottom half = tool RESPONSE output size (what the tool returned)
//   Both channels use red palette; top = brighter red, bottom = darker red.
//   This correctly attributes context growth to Write/Edit (whose request is
//   large but response is tiny) vs Read/Bash (whose response dominates).

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import * as echarts from "echarts/core";
import { CustomChart, LineChart } from "echarts/charts";
import {
  AxisPointerComponent,
  DataZoomComponent,
  GridComponent,
  MarkPointComponent,
  TooltipComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { LlmCall, UserTurn } from "./drilldown-types";

echarts.use([
  LineChart,
  CustomChart,
  GridComponent,
  TooltipComponent,
  AxisPointerComponent,
  DataZoomComponent,
  MarkPointComponent,
  CanvasRenderer,
]);

function fmtK(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (abs >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(Math.round(n));
}

const TOOL_ROWS = ["Read", "Write", "Edit", "Bash", "Grep", "Agent", "Web", "Other"] as const;
type ToolRow = typeof TOOL_ROWS[number];

const TOOL_ACCENT: Record<ToolRow, string> = {
  Read: "#4f46e5", Write: "#d97706", Edit: "#ea580c", Bash: "#16a34a",
  Grep: "#2563eb", Agent: "#7c3aed", Web: "#0891b2", Other: "#64748b",
};

function classifyTool(name: string): ToolRow {
  const base = name.trim().match(/^([A-Za-z_]+)/)?.[1] ?? name.split(/\s|\(/)[0] ?? name;
  if (base === "Read") return "Read";
  if (base === "Write" || base === "NotebookWrite") return "Write";
  if (base === "Edit" || base === "MultiEdit") return "Edit";
  if (base === "Bash") return "Bash";
  if (base === "Grep" || base === "Glob" || base === "grep") return "Grep";
  if (base === "Agent" || base === "Task") return "Agent";
  if (base === "WebFetch" || base === "WebSearch") return "Web";
  return "Other";
}

// Color interpolation for red palette
function redColor(value: number, max: number, dark: boolean): string {
  if (max === 0 || value === 0) return dark ? "#fff1f2" : "#fff7f7";
  const t = Math.min(value / max, 1);
  if (dark) {
    // Darker palette: light pink → deep crimson
    const r = Math.round(255 - t * (255 - 127));
    const g = Math.round(241 - t * 241);
    const b = Math.round(242 - t * 242);
    return `rgb(${r},${g},${b})`;
  } else {
    // Brighter palette: very light → rose red
    const r = Math.round(255 - t * (255 - 220));
    const g = Math.round(247 - t * (247 - 38));
    const b = Math.round(247 - t * (247 - 38));
    return `rgb(${r},${g},${b})`;
  }
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
  callIdx: number;
  sourceCall: LlmCall;
  targetCall: LlmCall;
  toolRow: ToolRow;
  outputSize: number;
  inputSize: number;
  count: number;
  errorCount: number;
  events: ToolEvent[];
}

interface SubAgentAgent {
  agentType: string; description: string; toolUseId: string;
  llmCallCount: number; durationMs: number;
  peakContext: number; lastContext: number; returnedSize: number; savings: number;
}
interface SubAgentEvent {
  triggerIdx: number; terminateIdx: number; totalSavings: number; agents: SubAgentAgent[];
}

interface MinimapData {
  calls: Array<{ idx: number; label: string; contextSize: number; isCompaction: boolean }>;
  cells: ToolCell[];
  activeRows: ToolRow[];
  maxCtx: number;
  maxInput: number;
  maxOutput: number;
  totalToolEvents: number;
  totalInputSize: number;
  totalOutputSize: number;
  subAgentEvents: SubAgentEvent[];
  counterfactual: Array<number | null>;
  totalSubAgentSavings: number;
}

const SUB_AGENT_MIN_SAVINGS = 2_000;

function buildData(turn: UserTurn): MinimapData {
  const calls = turn.calls.map((c, i) => ({
    idx: i, label: `C${c.indexInTurn}`,
    contextSize: c.contextSize, isCompaction: c.isCompaction,
  }));

  const cellMap = new Map<string, ToolCell>();
  for (let targetIdx = 1; targetIdx < turn.calls.length; targetIdx++) {
    const sourceCall = turn.calls[targetIdx - 1];
    const targetCall = turn.calls[targetIdx];
    for (const tc of (sourceCall.toolCalls ?? [])) {
      const row = classifyTool(tc.name);
      const key = `${targetIdx}:${row}`;
      const ev: ToolEvent = {
        toolUseId: tc.toolUseId, name: tc.name,
        inputPreview: tc.inputPreview, inputSize: tc.inputSize,
        outputPreview: tc.outputPreview, outputSize: tc.outputSize, isError: tc.isError,
      };
      const ex = cellMap.get(key);
      if (ex) {
        ex.outputSize += tc.outputSize; ex.inputSize += tc.inputSize;
        ex.count++; ex.errorCount += tc.isError ? 1 : 0; ex.events.push(ev);
      } else {
        cellMap.set(key, { callIdx: targetIdx, sourceCall, targetCall, toolRow: row,
          outputSize: tc.outputSize, inputSize: tc.inputSize, count: 1,
          errorCount: tc.isError ? 1 : 0, events: [ev] });
      }
    }
  }

  const cells = Array.from(cellMap.values());
  const usedRows = new Set(cells.map(c => c.toolRow));
  const activeRows = TOOL_ROWS.filter(r => usedRows.has(r));

  const subAgentEvents: SubAgentEvent[] = [];
  for (let i = 0; i < turn.calls.length; i++) {
    const call = turn.calls[i];
    const agents: SubAgentAgent[] = [];
    let totalSavings = 0;
    for (const sa of (call.subAgents ?? [])) {
      const slot = call.toolCalls.find(tc => tc.toolUseId === sa.toolUseId);
      const returnedSize = slot?.outputSize ?? 0;
      const savings = Math.max(0, sa.peakContext - returnedSize);
      if (savings < SUB_AGENT_MIN_SAVINGS) continue;
      agents.push({ agentType: sa.agentType, description: sa.description, toolUseId: sa.toolUseId,
        llmCallCount: sa.llmCallCount, durationMs: sa.durationMs,
        peakContext: sa.peakContext, lastContext: sa.lastContext, returnedSize, savings });
      totalSavings += savings;
    }
    if (!agents.length) continue;
    let terminateIdx = turn.calls.length - 1;
    for (let j = i + 1; j < turn.calls.length; j++) {
      if (turn.calls[j].isCompaction) { terminateIdx = j - 1; break; }
    }
    if (terminateIdx < i) terminateIdx = i;
    subAgentEvents.push({ triggerIdx: i, terminateIdx, totalSavings, agents });
  }

  const counterfactual: Array<number | null> = calls.map((c, k) => {
    let active = 0; let anyTouches = false;
    for (const ev of subAgentEvents) {
      if (k > ev.triggerIdx && k <= ev.terminateIdx) { active += ev.totalSavings; anyTouches = true; }
      else if (k === ev.triggerIdx) anyTouches = true;
    }
    if (!anyTouches) return null;
    return c.contextSize + active;
  });

  const maxCounterfactual = counterfactual.reduce<number>((m, v) => (v != null && v > m ? v : m), 0);
  const maxCtx = Math.max(...calls.map(c => c.contextSize), maxCounterfactual, 50_000);
  const maxInput  = Math.max(...cells.map(c => c.inputSize), 1);
  const maxOutput = Math.max(...cells.map(c => c.outputSize), 1);
  const totalToolEvents  = cells.reduce((s, c) => s + c.count, 0);
  const totalInputSize   = cells.reduce((s, c) => s + c.inputSize, 0);
  const totalOutputSize  = cells.reduce((s, c) => s + c.outputSize, 0);
  const totalSubAgentSavings = subAgentEvents.reduce((s, e) => s + e.totalSavings, 0);

  return { calls, cells, activeRows, maxCtx, maxInput, maxOutput,
    totalToolEvents, totalInputSize, totalOutputSize,
    subAgentEvents, counterfactual, totalSubAgentSavings };
}

const PAD_L = 64;
const PAD_R = 18;
const CTX_H = 104;
const ROW_H = 34;
const GAP = 18;
const X_LABEL_H = 24;
const ZOOM_THRESHOLD = 36;
const ZOOM_WINDOW = 34;
const ZOOM_H = 28;

type TooltipParam = { seriesName?: string; dataIndex?: number; value?: unknown; axisValue?: string | number };

function buildOption(data: MinimapData, tFn: (key: string, fallback?: string) => string): echarts.EChartsCoreOption {
  const t = tFn;
  const { calls, cells, activeRows, maxCtx, maxInput, maxOutput, subAgentEvents, counterfactual } = data;
  if (!calls.length) return {};

  const subAgentByTrigger = new Map<number, SubAgentEvent>();
  const activeSubAgentByCall = new Map<number, SubAgentEvent[]>();
  for (const ev of subAgentEvents) {
    subAgentByTrigger.set(ev.triggerIdx, ev);
    for (let k = ev.triggerIdx; k <= ev.terminateIdx; k++) {
      const list = activeSubAgentByCall.get(k) ?? [];
      list.push(ev);
      activeSubAgentByCall.set(k, list);
    }
  }

  const visibleRows: string[] = activeRows.length ? [...activeRows] : ["No tools"];
  const callCats = calls.map(c => c.label);
  const matrixH = Math.max(visibleRows.length, 1) * ROW_H;
  const showZoom = calls.length > ZOOM_THRESHOLD;
  const zoomEndValue = Math.min(calls.length - 1, ZOOM_WINDOW - 1);
  const xLabelInterval = calls.length > 54 ? 2 : calls.length > 32 ? 1 : 0;

  const cellsByCall = new Map<number, ToolCell[]>();
  for (const cell of cells) {
    const list = cellsByCall.get(cell.callIdx) ?? [];
    list.push(cell);
    cellsByCall.set(cell.callIdx, list);
  }

  // Custom renderer: split each cell vertically into top (input) + bottom (output).
  // ECharts passes (params, api) where api.value(dim) reads the data dimensions
  // and api.coord([x, y]) converts data coords to pixel coords.
  // api.size([1, 1]) gives the pixel size of one data unit in each axis.
  function renderDualCell(
    params: Record<string, unknown>,
    api: { value: (dim: number) => number; coord: (pt: number[]) => number[]; size: (s: number[]) => number[] },
  ) {
    const callIdx   = api.value(0);
    const rowIdx    = api.value(1);
    const inputSize  = api.value(2);
    const outputSize = api.value(3);

    const [px, py] = api.coord([callIdx, rowIdx]);
    const [cellW, cellH] = api.size([1, 1]);

    const BORDER = 2;
    const x = px - cellW / 2 + BORDER / 2;
    const y = py - cellH / 2 + BORDER / 2;
    const w = cellW - BORDER;
    const h = cellH - BORDER;
    const topH = Math.max(1, Math.floor(h / 2));
    const botH = h - topH;

    // Both channels share the same max so colors are directly comparable:
    // same shade = same size, regardless of which half it's in.
    const sharedMax = Math.max(maxInput, maxOutput);
    const topColor = redColor(inputSize,  sharedMax, false); // bright red = request
    const botColor = redColor(outputSize, sharedMax, true);  // dark red = response

    const children: object[] = [
      { type: "rect", shape: { x, y, width: w, height: topH },
        style: { fill: topColor, lineWidth: 0 }, z2: 1 },
      { type: "rect", shape: { x, y: y + topH, width: w, height: botH },
        style: { fill: botColor, lineWidth: 0 }, z2: 1 },
      { type: "line", shape: { x1: x, y1: y + topH, x2: x + w, y2: y + topH },
        style: { stroke: "rgba(255,255,255,0.5)", lineWidth: 0.5 }, z2: 2 },
    ];

    const showLabel = w > 22 && h > 18;
    // Both labels use black — consistent across all intensity levels
    if (showLabel && inputSize > 0) {
      children.push({ type: "text", style: {
        x: x + w / 2, y: y + topH / 2, text: fmtK(inputSize),
        textAlign: "center", textVerticalAlign: "middle",
        fill: "#111827", fontSize: 8, fontWeight: "bold",
        textShadowBlur: 3, textShadowColor: "rgba(255,255,255,0.8)",
      }, z2: 3 });
    }
    if (showLabel && outputSize > 0) {
      children.push({ type: "text", style: {
        x: x + w / 2, y: y + topH + botH / 2, text: fmtK(outputSize),
        textAlign: "center", textVerticalAlign: "middle",
        fill: "#111827", fontSize: 8, fontWeight: "bold",
        textShadowBlur: 3, textShadowColor: "rgba(255,255,255,0.8)",
      }, z2: 3 });
    }

    return { type: "group", children };
  }

  // Custom data: [callIdx, rowIdx, inputSize, outputSize, count]
  const customData = cells.map(cell => [
    cell.callIdx,
    visibleRows.indexOf(cell.toolRow),
    cell.inputSize,
    cell.outputSize,
    cell.count,
  ]);

  function tooltipFormatter(params: unknown): string {
    const arr = (Array.isArray(params) ? params : [params]) as TooltipParam[];
    let callIdx = -1;
    for (const p of arr) {
      const value = p.value as unknown[] | number | undefined;
      if (Array.isArray(value) && typeof value[0] === "number") { callIdx = value[0]; break; }
      if (p.seriesName === "Context" && typeof p.dataIndex === "number") { callIdx = p.dataIndex; break; }
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
    const toolCells = [...(cellsByCall.get(callIdx) ?? [])].sort((a, b) => (b.inputSize + b.outputSize) - (a.inputSize + a.outputSize));
    const toolLines = toolCells.slice(0, 5).map(cell => (
      `<br/><span style="color:${TOOL_ACCENT[cell.toolRow]};font-weight:700">${cell.toolRow}</span>` +
      ` ${cell.count}x` +
      ` · req <strong>${fmtK(cell.inputSize)}</strong>` +
      ` · resp <strong>${fmtK(cell.outputSize)}</strong>`
    )).join("");
    const more = toolCells.length > 5 ? `<br/><span style="color:#9ca3af">+${toolCells.length - 5} more</span>` : "";

    let subAgentBlock = "";
    const triggerEvent = subAgentByTrigger.get(callIdx);
    const activeEvents = activeSubAgentByCall.get(callIdx) ?? [];
    if (triggerEvent) {
      const lines = triggerEvent.agents.map(a => (
        `<br/><span style="color:#a855f7;font-weight:700">${a.agentType}</span> ` +
        `· ${a.llmCallCount} calls · peak <strong>${fmtK(a.peakContext)}</strong>` +
        ` → returned <strong>${fmtK(a.returnedSize)}</strong>` +
        ` <span style="color:#a855f7">(saved ${fmtK(a.savings)})</span>`
      )).join("");
      subAgentBlock = `<br/><span style="color:#a855f7;font-weight:700">Sub-agent compression</span> ` +
        `<span style="color:#d8b4fe">total saved ${fmtK(triggerEvent.totalSavings)}</span>` + lines;
    } else if (activeEvents.length) {
      const total = activeEvents.reduce((s, e) => s + e.totalSavings, 0);
      const triggers = activeEvents.map(e => calls[e.triggerIdx]?.label ?? "?").join(", ");
      subAgentBlock = `<br/><span style="color:#a855f7;font-weight:700">Carrying sub-agent savings</span> ` +
        `<span style="color:#d8b4fe">${fmtK(total)} (from ${triggers})</span>`;
    }

    const toolCount = toolCells.reduce((s, c) => s + c.count, 0);
    const totalInput = toolCells.reduce((s, c) => s + c.inputSize, 0);
    const totalOutput = toolCells.reduce((s, c) => s + c.outputSize, 0);

    return [
      `<strong>${call.label}</strong>`,
      `<span style="color:#9ca3af"> · Context: </span><strong>${fmtK(call.contextSize)}</strong>`,
      callIdx > 0 ? `<span style="color:${deltaColor}"> ${delta >= 0 ? "+" : ""}${fmtK(delta)}</span>` : "",
      toolCount > 0
        ? `<br/>Tools ${toolCount}x · req <strong>${fmtK(totalInput)}</strong> · resp <strong>${fmtK(totalOutput)}</strong>`
        : `<br/><span style="color:#9ca3af">No tools</span>`,
      toolLines,
      more,
      subAgentBlock,
      `<br/><span style="color:#6366f1">↑ ${t("sessionOverview.minimap.clickHint", "click to expand")}</span>`,
    ].join("");
  }

  return {
    animation: false,
    backgroundColor: "transparent",
    axisPointer: {
      type: "line", snap: true, link: [{ xAxisIndex: [0, 1] }],
      label: { backgroundColor: "#111827" },
    },
    grid: [
      { id: "ctx",    left: PAD_L, right: PAD_R, top: 10, height: CTX_H },
      { id: "matrix", left: PAD_L, right: PAD_R, top: 10 + CTX_H + GAP + X_LABEL_H, height: matrixH },
    ],
    dataZoom: [
      {
        type: "inside", xAxisIndex: [0, 1], filterMode: "none",
        startValue: 0, endValue: showZoom ? zoomEndValue : calls.length - 1,
        moveOnMouseWheel: true, zoomOnMouseWheel: "ctrl",
      },
      ...(showZoom ? [{
        type: "slider", xAxisIndex: [0, 1], filterMode: "none",
        height: 18, bottom: 4, showDetail: false, brushSelect: false,
        borderColor: "#fecdd3", fillerColor: "rgba(254, 202, 202, 0.45)",
        handleSize: 12, handleStyle: { color: "#e11d48" },
        dataBackground: { lineStyle: { color: "#fecdd3" }, areaStyle: { color: "#fff1f2" } },
      }] : []),
    ],
    xAxis: [
      {
        id: "xCtx", gridId: "ctx", gridIndex: 0, type: "category", data: callCats,
        boundaryGap: true, axisLine: { lineStyle: { color: "#e5e7eb" } },
        axisTick: { show: false }, axisLabel: { show: false },
        splitLine: { show: true, lineStyle: { color: "#f3f4f6" } },
      },
      {
        id: "xMatrix", gridId: "matrix", gridIndex: 1, type: "category", data: callCats,
        boundaryGap: true, position: "top",
        axisLine: { lineStyle: { color: "#e5e7eb" } }, axisTick: { show: false },
        axisLabel: { interval: xLabelInterval, hideOverlap: true, fontSize: 9, color: "#94a3b8" },
        splitLine: { show: true, lineStyle: { color: "#f1f5f9" } },
        splitArea: { show: true, areaStyle: { color: ["#ffffff", "#fafafa"] } },
      },
    ],
    yAxis: [
      {
        id: "yCtx", gridId: "ctx", gridIndex: 0, type: "value", min: 0, max: maxCtx,
        axisLabel: { fontSize: 8, color: "#cbd5e1", formatter: (v: number) => fmtK(v), width: 54, overflow: "truncate" },
        axisLine: { show: false }, axisTick: { show: false },
        splitLine: { show: true, lineStyle: { color: "#f1f5f9" } },
      },
      {
        id: "yMatrix", gridId: "matrix", gridIndex: 1, type: "category", data: visibleRows,
        inverse: false, axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { fontSize: 10, color: "#374151", fontWeight: 700 },
        splitLine: { show: true, lineStyle: { color: "#f1f5f9" } },
        splitArea: { show: true, areaStyle: { color: ["#ffffff", "#fbfdff"] } },
      },
    ],
    tooltip: {
      trigger: "axis", axisPointer: { type: "line" },
      backgroundColor: "#111827", borderColor: "#374151", borderWidth: 1,
      textStyle: { color: "#f9fafb", fontSize: 11 },
      extraCssText: "max-width: 520px; white-space: normal;",
      formatter: tooltipFormatter,
    },
    series: [
      {
        id: "ctx-line", name: "Context", type: "line",
        xAxisIndex: 0, yAxisIndex: 0, data: calls.map(c => c.contextSize),
        lineStyle: { color: "#6366f1", width: 2.5 },
        symbol: "circle", showSymbol: calls.length <= ZOOM_THRESHOLD, symbolSize: 4,
        itemStyle: { color: "#6366f1" },
        areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [{ offset: 0, color: "#6366f11f" }, { offset: 1, color: "#6366f103" }] } },
        markPoint: {
          symbol: "diamond", symbolSize: 11,
          data: [
            ...calls.filter(c => c.isCompaction).map(c => ({
              coord: [c.idx, c.contextSize],
              itemStyle: { color: "#dc2626" }, label: { show: false },
            })),
            ...subAgentEvents.map(ev => {
              const call = calls[ev.triggerIdx];
              return {
                coord: [ev.triggerIdx, call?.contextSize ?? 0],
                symbol: "triangle", symbolSize: 12,
                itemStyle: { color: "#a855f7", borderColor: "#ffffff", borderWidth: 1 },
                label: { show: true, position: "top" as const,
                  formatter: `-${fmtK(ev.totalSavings)}`, color: "#7e22ce",
                  fontSize: 9, fontWeight: 700, backgroundColor: "#faf5ff",
                  borderColor: "#d8b4fe", borderWidth: 1, borderRadius: 3, padding: [1, 4] },
              };
            }),
          ],
        },
        z: 3,
      },
      {
        id: "ctx-counterfactual", name: "If inline (no sub-agent)", type: "line",
        xAxisIndex: 0, yAxisIndex: 0, data: counterfactual,
        connectNulls: false, showSymbol: false, symbol: "none",
        lineStyle: { color: "#a855f7", width: 1.5, type: "dashed" },
        itemStyle: { color: "#a855f7" },
        areaStyle: { color: "#a855f714", origin: "start" },
        emphasis: { focus: "none" }, z: 2, silent: false,
      },
      {
        id: "tool-dual",
        name: "Tool calls",
        type: "custom",
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: customData,
        renderItem: renderDualCell as unknown as echarts.CustomSeriesOption["renderItem"],
        encode: { x: 0, y: 1 },
        z: 2,
      },
    ],
  };
}

export interface TurnMinimapProps {
  turn: UserTurn;
  onSelectCall?: (callId: number) => void;
}

export function TurnMinimap({ turn, onSelectCall }: TurnMinimapProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = echarts.init(el, undefined, { renderer: "canvas" });
    chartRef.current = chart;

    chart.on("click", (params) => {
      if (!onSelectCall) return;
      // Context line: dataIndex = call array index
      if (params.seriesName === "Context") {
        const call = turn.calls[params.dataIndex as number];
        if (call) onSelectCall(call.id);
        return;
      }
      // Custom dual-cell: value[0] = callIdx (array index into turn.calls)
      if (params.seriesName === "Tool calls") {
        const value = params.value as number[] | undefined;
        if (typeof value?.[0] === "number") {
          const call = turn.calls[value[0]];
          if (call) onSelectCall(call.id);
        }
      }
    });

    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);
    return () => { ro.disconnect(); chart.dispose(); chartRef.current = null; };
  }, [onSelectCall, turn.calls]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const data = buildData(turn);
    const rowCount = Math.max(data.activeRows.length, 1);
    const showZoom = turn.calls.length > ZOOM_THRESHOLD;
    const totalH = 10 + CTX_H + GAP + X_LABEL_H + rowCount * ROW_H + (showZoom ? ZOOM_H : 10);
    if (containerRef.current) containerRef.current.style.height = `${totalH}px`;
    chart.resize();
    chart.setOption(buildOption(data, t), true);
  }, [turn, t]);

  if (!turn.calls.length) return null;

  const data = buildData(turn);

  return (
    <div style={{ background: "#ffffff", overflow: "hidden" }}>
      {/* Legend */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "7px 10px", borderBottom: "1px solid #f1f5f9", flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <div style={{ width: 16, height: 0, borderTop: "2px solid #6366f1" }} />
          <span style={{ fontSize: 10, color: "#64748b", fontWeight: 600 }}>Context</span>
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
        {/* Dual cell legend */}
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <div style={{ width: 22, height: 18, borderRadius: 3, overflow: "hidden", display: "flex", flexDirection: "column", border: "1px solid #fecdd3" }}>
            <div style={{ flex: 1, background: "#fca5a5" }} />
            <div style={{ height: "0.5px", background: "#ffffff80" }} />
            <div style={{ flex: 1, background: "#dc2626" }} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            <span style={{ fontSize: 9, color: "#f87171", fontWeight: 600, lineHeight: 1.3 }}>↑ req</span>
            <span style={{ fontSize: 9, color: "#9f1239", fontWeight: 600, lineHeight: 1.3 }}>↓ resp</span>
          </div>
          <span style={{ fontSize: 10, color: "#94a3b8" }}>
            max {fmtK(Math.max(data.maxInput, data.maxOutput))}
          </span>
        </div>
        {turn.calls.length > ZOOM_THRESHOLD && (
          <span style={{ fontSize: 10, color: "#be123c", background: "#fff1f2", border: "1px solid #fecdd3", borderRadius: 4, padding: "1px 6px" }}>
            {t("sessionOverview.minimap.dragWindow")}
          </span>
        )}
        <span style={{ marginLeft: "auto", fontSize: 10, color: "#cbd5e1" }}>
          {turn.calls.length} {t("sessionOverview.minimap.llmCalls", "LLM calls")} · {data.totalToolEvents} {t("sessionOverview.activity.toolCalls").toLowerCase()} · req {fmtK(data.totalInputSize)} · resp {fmtK(data.totalOutputSize)}
        </span>
      </div>

      <div ref={containerRef} style={{ width: "100%", height: 220 }} />

      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 10px", borderTop: "1px solid #f1f5f9", fontSize: 10, color: "#94a3b8" }}>
        <span style={{ fontWeight: 700, color: "#64748b" }}>cell:</span>
        <span>{t("sessionOverview.minimap.reqSize")}</span>
        <span>·</span>
        <span>{t("sessionOverview.minimap.respSize")}</span>
        <span>·</span>
        <span>{t("sessionOverview.minimap.sharedScale")}</span>
        <span>·</span>
        <span>{t("sessionOverview.minimap.hoverHint")}</span>
        <span>·</span>
        <span>{t("sessionOverview.minimap.clickHint")}</span>
      </div>
    </div>
  );
}

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
import { getToolPalette } from "./shared/toolRegistry";
import { CHART_COLORS, TOOLTIP_PRESET, brandAreaGradient } from "./shared/chart-theme";
import { Badge } from "@/components/ui/badge";

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

// Accents come from the shared tool registry so they stay aligned with chip
// colors elsewhere in the app. "Web" row aliases to WebFetch, "Other" falls back.
const TOOL_ACCENT: Record<ToolRow, string> = {
  Read:  getToolPalette("Read").accent,
  Write: getToolPalette("Write").accent,
  Edit:  getToolPalette("Edit").accent,
  Bash:  getToolPalette("Bash").accent,
  Grep:  getToolPalette("Grep").accent,
  Agent: getToolPalette("Agent").accent,
  Web:   getToolPalette("WebFetch").accent,
  Other: getToolPalette("__unknown__").accent,
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

// Color interpolation for brand Indigo/Violet palette
function brandColor(value: number, max: number, dark: boolean): string {
  if (max === 0 || value === 0) return "#f8fafc";
  const t = Math.min(value / max, 1);
  if (dark) {
    // Darker channel (response): light indigo/violet (#c7d2fe) -> deep violet/indigo (#312e81)
    const r = Math.round(199 - t * (199 - 49));
    const g = Math.round(210 - t * (210 - 46));
    const b = Math.round(254 - t * (254 - 129));
    return `rgb(${r},${g},${b})`;
  } else {
    // Brighter channel (request): very light indigo (#eef2ff) -> brand indigo (#818cf8)
    const r = Math.round(238 - t * (238 - 129));
    const g = Math.round(242 - t * (242 - 140));
    const b = Math.round(255 - t * (255 - 248));
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
    idx: i, label: `#${c.id}`,
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
    const topColor = brandColor(inputSize,  sharedMax, false); // bright indigo = request
    const botColor = brandColor(outputSize, sharedMax, true);  // deep violet = response

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
    title: {
      text: t("terms.callMinimap", "CALL 概览"),
      subtext: `${calls.length} calls · ${data.totalToolEvents} tools · req ${fmtK(data.totalInputSize)} · resp ${fmtK(data.totalOutputSize)}`,
      left: 12,
      top: 8,
      textStyle: {
        fontSize: 11,
        fontWeight: "bold",
        color: "#6b7280",
        fontFamily: "var(--font-sans)",
      },
      subtextStyle: {
        fontSize: 9,
        color: "#9ca3af",
        fontFamily: "var(--font-sans)",
      }
    },
    axisPointer: {
      type: "line", snap: true, link: [{ xAxisIndex: [0, 1] }],
      label: { backgroundColor: "#111827" },
    },
    grid: [
      { id: "ctx",    left: PAD_L, right: PAD_R, top: 48, height: CTX_H },
      { id: "matrix", left: PAD_L, right: PAD_R, top: 48 + CTX_H + GAP + X_LABEL_H, height: matrixH },
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
        boundaryGap: true, axisLine: { lineStyle: { color: CHART_COLORS.borderLine } },
        axisTick: { show: false }, axisLabel: { show: false },
        splitLine: { show: true, lineStyle: { color: CHART_COLORS.splitLine } },
      },
      {
        id: "xMatrix", gridId: "matrix", gridIndex: 1, type: "category", data: callCats,
        boundaryGap: true, position: "top",
        axisLine: { lineStyle: { color: CHART_COLORS.borderLine } }, axisTick: { show: false },
        axisLabel: { interval: xLabelInterval, hideOverlap: true, fontSize: 9, color: CHART_COLORS.axisLabel },
        splitLine: { show: true, lineStyle: { color: CHART_COLORS.splitLine } },
        splitArea: { show: true, areaStyle: { color: ["#ffffff", "#fafafa"] } },
      },
    ],
    yAxis: [
      {
        id: "yCtx", gridId: "ctx", gridIndex: 0, type: "value", min: 0, max: maxCtx,
        axisLabel: { fontSize: 9, color: CHART_COLORS.axisLabel, formatter: (v: number) => fmtK(v), width: 54, overflow: "truncate" },
        axisLine: { show: false }, axisTick: { show: false },
        splitLine: { show: true, lineStyle: { color: CHART_COLORS.splitLine } },
      },
      {
        id: "yMatrix", gridId: "matrix", gridIndex: 1, type: "category", data: visibleRows,
        inverse: false, axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { fontSize: 10, color: "#374151", fontWeight: 700 },
        splitLine: { show: true, lineStyle: { color: CHART_COLORS.splitLine } },
        splitArea: { show: true, areaStyle: { color: ["#ffffff", "#fbfdff"] } },
      },
    ],
    tooltip: {
      ...TOOLTIP_PRESET,
      trigger: "axis", axisPointer: { type: "line" },
      formatter: tooltipFormatter,
    },
    series: [
      {
        id: "ctx-line", name: "Context", type: "line",
        xAxisIndex: 0, yAxisIndex: 0, data: calls.map(c => c.contextSize),
        lineStyle: { color: CHART_COLORS.brand, width: 2.5 },
        symbol: "circle", showSymbol: calls.length <= ZOOM_THRESHOLD, symbolSize: 4,
        itemStyle: { color: CHART_COLORS.brand },
        areaStyle: { color: brandAreaGradient() },
        markPoint: {
          symbol: "diamond", symbolSize: 11,
          data: [
            ...calls.filter(c => c.isCompaction).map(c => ({
              coord: [c.idx, c.contextSize],
              itemStyle: { color: CHART_COLORS.compaction }, label: { show: false },
            })),
            ...subAgentEvents.map(ev => {
              const call = calls[ev.triggerIdx];
              return {
                coord: [ev.triggerIdx, call?.contextSize ?? 0],
                symbol: "triangle", symbolSize: 12,
                itemStyle: { color: CHART_COLORS.subAgent, borderColor: "#ffffff", borderWidth: 1 },
                label: { show: true, position: "top" as const,
                  formatter: `-${fmtK(ev.totalSavings)}`, color: CHART_COLORS.subAgentDark,
                  fontSize: 9, fontWeight: 700, backgroundColor: CHART_COLORS.subAgentWeakBg,
                  borderColor: CHART_COLORS.subAgentWeakBd, borderWidth: 1, borderRadius: 3, padding: [1, 4] },
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
        lineStyle: { color: CHART_COLORS.subAgent, width: 1.5, type: "dashed" },
        itemStyle: { color: CHART_COLORS.subAgent },
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
        // CustomSeriesOption["renderItem"] — echarts/core doesn't re-export this type,
        // so we go through `any` rather than dragging in echarts/types just for the cast.
        renderItem: renderDualCell as unknown as (...args: unknown[]) => unknown,
        encode: { x: 0, y: 1 },
        z: 2,
      },
    ],
  };
}

export interface TurnMinimapProps {
  turn: UserTurn;
  onSelectCall?: (callId: number) => void;
  onHoverCall?: (callId: number) => void;
}

export function TurnMinimap({ turn, onSelectCall, onHoverCall }: TurnMinimapProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  // Latest-callback / latest-data refs. The init effect below must only run
  // once per mount (otherwise dispose+reinit happens on every parent render
  // because callers typically pass an inline `onSelectCall` lambda, which
  // races with the setOption effect and leaves the chart data-less → all
  // clicks silently no-op). The click handler reads these refs at call time.
  const onSelectCallRef = useRef(onSelectCall);
  const onHoverCallRef = useRef(onHoverCall);
  const turnRef = useRef(turn);
  useEffect(() => { onSelectCallRef.current = onSelectCall; }, [onSelectCall]);
  useEffect(() => { onHoverCallRef.current = onHoverCall; }, [onHoverCall]);
  useEffect(() => { turnRef.current = turn; }, [turn]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = echarts.init(el, undefined, { renderer: "canvas" });
    chartRef.current = chart;

    // Single zr-level click handler: the tooltip already snaps to a column on
    // hover (axisPointer trigger), so any click within either grid should
    // navigate to that column — regardless of whether the user landed on the
    // line marker, the area fill, a markPoint diamond/triangle, a heatmap
    // cell, or the splitArea between cells. We convert pixel → category index
    // via the x-axis, and use containPixel to ignore clicks outside the grids
    // (legend, padding, zoom slider).
    // Two-layer click handling:
    //
    //   (1) echarts series-level click — fires when the user lands ON a
    //       drawn data element. For the line series we get `params.dataIndex`
    //       directly; for the custom heatmap series the cell's data tuple
    //       is `[callIdx, rowIdx, inputSize, outputSize, count]`, so we
    //       read `params.data[0]`. This is the more reliable path because
    //       echarts owns the hit-testing for the custom-series children.
    //
    //   (2) zr-level click — covers clicks that miss every drawn element
    //       but still land inside a grid (axis padding, splitArea between
    //       cells, blank line-area fill). We convert pixel → category via
    //       the x-axis and look up the call by index.
    //
    // Earlier the zr handler alone was enough, but on some echarts builds
    // the custom-series `group` returned by renderItem swallowed the zr
    // event before it bubbled, so direct cell clicks no-op'd while line
    // clicks worked. Adding (1) makes cells reliably clickable.
    // De-dupe guard: both handlers below can fire for the same click on a
    // drawn element. We set a flag in the series-level handler and consume
    // it in the zr-level handler to prevent double-navigate.
    let handledThisClick = false;
    chart.on("click", (params: { seriesId?: string; dataIndex?: number; data?: unknown }) => {
      const cb = onSelectCallRef.current;
      if (!cb) return;
      let callIdx: number | null = null;
      if (params.seriesId === "tool-dual" && Array.isArray(params.data)) {
        const c = (params.data as number[])[0];
        if (typeof c === "number") callIdx = c;
      } else if (typeof params.dataIndex === "number") {
        callIdx = params.dataIndex;
      }
      if (callIdx == null || callIdx < 0) return;
      const call = turnRef.current.calls[callIdx];
      if (call) {
        handledThisClick = true;
        cb(call.id);
      }
    });

    chart.getZr().on("click", (e) => {
      if (handledThisClick) { handledThisClick = false; return; }
      const cb = onSelectCallRef.current;
      if (!cb) return;
      const px: [number, number] = [e.offsetX, e.offsetY];
      const inCtx = chart.containPixel({ gridIndex: 0 }, px);
      const inMatrix = chart.containPixel({ gridIndex: 1 }, px);
      if (!inCtx && !inMatrix) return;
      const axisIndex = inCtx ? 0 : 1;
      const raw = chart.convertFromPixel({ xAxisIndex: axisIndex }, px) as unknown as number | null;
      if (typeof raw !== "number" || raw < 0) return;
      const idx = Math.round(raw);
      const call = turnRef.current.calls[idx];
      if (call) cb(call.id);
    });

    // Hover navigation: dwell 300ms on a column to scroll its call card into view.
    let hoverTimer: ReturnType<typeof setTimeout> | null = null;
    const clearHover = () => { if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; } };

    chart.getZr().on("mousemove", (e) => {
      const cb = onHoverCallRef.current;
      if (!cb) return;
      const px: [number, number] = [e.offsetX, e.offsetY];
      const inCtx = chart.containPixel({ gridIndex: 0 }, px);
      const inMatrix = chart.containPixel({ gridIndex: 1 }, px);
      if (!inCtx && !inMatrix) { clearHover(); return; }
      const axisIndex = inCtx ? 0 : 1;
      const raw = chart.convertFromPixel({ xAxisIndex: axisIndex }, px) as unknown as number | null;
      if (typeof raw !== "number" || raw < 0) { clearHover(); return; }
      const idx = Math.round(raw);
      clearHover();
      hoverTimer = setTimeout(() => {
        const call = turnRef.current.calls[idx];
        if (call) onHoverCallRef.current?.(call.id);
      }, 300);
    });

    chart.getZr().on("mouseout", clearHover);

    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);
    return () => { clearHover(); ro.disconnect(); chart.dispose(); chartRef.current = null; };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const data = buildData(turn);
    const rowCount = Math.max(data.activeRows.length, 1);
    const showZoom = turn.calls.length > ZOOM_THRESHOLD;
    const totalH = 48 + CTX_H + GAP + X_LABEL_H + rowCount * ROW_H + (showZoom ? ZOOM_H : 10);
    if (containerRef.current) containerRef.current.style.height = `${totalH}px`;
    chart.resize();
    chart.setOption(buildOption(data, (key, fallback) => t(key, fallback ?? key) as string), true);
  }, [turn, t]);

  if (!turn.calls.length) return null;

  const data = buildData(turn);

  return (
    <div style={{ background: "transparent", overflow: "hidden" }}>
      <div ref={containerRef} style={{ width: "100%", height: 220 }} />
    </div>
  );
}

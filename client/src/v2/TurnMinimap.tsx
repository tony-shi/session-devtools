// Turn-level ECharts visualization — two stacked panels:
//   Grid 0:  Context step line  (x = call index C1 … Cn)
//   Grid 1:  Tool I/O Matrix    (x = transition C1→C2 …, y = tool type row)
//
// Data flows from UserTurn.calls[].incomingDiff:
//   category "Tool Output", changeType "added"  → output delta per slot
//   category "Tool Output", changeType "removed" → compaction-removed (skip)
//
// Input size is not available per-tool in the current data model; a thin fixed
// placeholder is shown.  The left slim bar will be upgraded when proxy data
// carries per-tool input tokens.

import React, { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { LineChart, CustomChart } from "echarts/charts";
import { GridComponent, TooltipComponent, AxisPointerComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { UserTurn, LlmCall } from "./drilldown-types";

echarts.use([LineChart, CustomChart, GridComponent, TooltipComponent, AxisPointerComponent, CanvasRenderer]);

// ─── Formatting ───────────────────────────────────────────────────────────────

function fmtK(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (abs >= 1_000)     return (n / 1_000).toFixed(1)     + "k";
  return String(Math.round(n));
}

// ─── Tool taxonomy ────────────────────────────────────────────────────────────
// Maps canonical tool names to display labels and colors.

const TOOL_ROWS = ["Read", "Write", "Edit", "Bash", "Grep", "Agent", "WebFetch", "Other"] as const;
type ToolRow = typeof TOOL_ROWS[number];

const TOOL_COLOR: Record<ToolRow, string> = {
  Read:     "#6366f1",
  Write:    "#f59e0b",
  Edit:     "#f97316",
  Bash:     "#22c55e",
  Grep:     "#3b82f6",
  Agent:    "#8b5cf6",
  WebFetch: "#06b6d4",
  Other:    "#94a3b8",
};

function classifyTool(label: string): ToolRow {
  const m = label.match(/^([A-Za-z_]+)\(/);
  const name = m ? m[1] : label.split(" ")[0];
  if (name === "Read")     return "Read";
  if (name === "Write")    return "Write";
  if (name === "Edit")     return "Edit";
  if (name === "Bash")     return "Bash";
  if (name === "Grep" || name === "grep") return "Grep";
  if (name === "Agent")    return "Agent";
  if (name === "WebFetch") return "WebFetch";
  return "Other";
}

// ─── Data model ───────────────────────────────────────────────────────────────

interface TransitionSlot {
  slotIdx: number;           // 0-based
  fromCall: LlmCall;
  toCall: LlmCall;
  label: string;             // e.g. "C2→C3"
  contextDelta: number;
  isCompaction: boolean;
}

interface ToolCell {
  slotIdx: number;
  toolRow: ToolRow;
  outputDelta: number;       // tokens added (sum of matching incomingDiff)
  callCount: number;         // number of distinct tool uses
  hasError: boolean;
  labels: string[];          // original labels e.g. ["Bash(npm test)"]
}

interface MinimapData {
  // Context line: one point per call
  calls: { idx: number; label: string; contextSize: number; isCompaction: boolean }[];
  // Transition slots: between consecutive calls
  slots: TransitionSlot[];
  // Tool matrix: sparse — only cells with data
  cells: ToolCell[];
  // Which tool rows have any data (determines visible rows)
  activeRows: ToolRow[];
  maxCtx: number;
  maxOutput: number;
}

function buildData(turn: UserTurn): MinimapData {
  const calls = turn.calls.map((c, i) => ({
    idx: i,
    label: `C${c.indexInTurn}`,
    contextSize: c.contextSize,
    isCompaction: c.isCompaction,
  }));

  const slots: TransitionSlot[] = [];
  for (let i = 0; i < turn.calls.length - 1; i++) {
    const from = turn.calls[i];
    const to   = turn.calls[i + 1];
    slots.push({
      slotIdx: i,
      fromCall: from,
      toCall: to,
      label: `C${from.indexInTurn}→C${to.indexInTurn}`,
      contextDelta: to.contextSize - from.contextSize,
      isCompaction: to.isCompaction,
    });
  }

  // Build cells from toolNames on the *source* call of each slot.
  // call[i].toolNames = tools dispatched in call i → they produce results
  // that appear in call[i+1]'s context (slot i).
  // outputDelta for a cell = context delta of the slot divided equally among
  // tool rows (best available approximation without per-tool attribution).
  const cellMap = new Map<string, ToolCell>();

  for (const slot of slots) {
    const names = slot.fromCall.toolNames ?? [];
    if (!names.length) continue;

    // Count occurrences of each tool type in this slot
    const rowCounts = new Map<ToolRow, number>();
    for (const n of names) {
      const row = classifyTool(n);
      rowCounts.set(row, (rowCounts.get(row) ?? 0) + 1);
    }

    // Context delta from this slot to distribute as output proxy
    const totalDelta = Math.max(slot.contextDelta, 0);
    const totalCount = names.length;

    for (const [row, count] of rowCounts) {
      const key = `${slot.slotIdx}:${row}`;
      // Proportional share of the context delta
      const outputDelta = totalCount > 0 ? Math.round(totalDelta * count / totalCount) : 0;
      cellMap.set(key, {
        slotIdx: slot.slotIdx,
        toolRow: row,
        outputDelta,
        callCount: count,
        hasError: false,
        labels: names.filter(n => classifyTool(n) === row),
      });
    }
  }

  const cells = Array.from(cellMap.values());

  // Determine active rows (preserve TOOL_ROWS order)
  const usedRows = new Set(cells.map(c => c.toolRow));
  const activeRows = TOOL_ROWS.filter(r => usedRows.has(r));

  const maxCtx    = Math.max(...calls.map(c => c.contextSize), 50_000);
  const maxOutput = Math.max(...cells.map(c => c.outputDelta), 1);

  return { calls, slots, cells, activeRows, maxCtx, maxOutput };
}

// ─── ECharts option builder ───────────────────────────────────────────────────

const PAD_L = 60;  // space for y-axis labels
const PAD_R = 16;

// Heights
const CTX_H  = 80;  // context line grid height
const ROW_H  = 28;  // each tool row height

function buildOption(data: MinimapData): echarts.EChartsCoreOption {
  const { calls, slots, cells, activeRows, maxCtx, maxOutput } = data;
  if (!calls.length) return {};

  const nRows   = activeRows.length;
  const matrixH = nRows * ROW_H;

  // Gap between the two grids
  const GAP = 12;

  // ── Grid 0: context line ──────────────────────────────────────────────────
  // x = call index 0..n-1  (categories: C1, C2, …)
  // y = context size

  const ctxCats  = calls.map(c => c.label);
  const ctxData  = calls.map(c => c.contextSize);

  const yTickStep = maxCtx <= 100_000 ? 50_000 : maxCtx <= 200_000 ? 100_000 : 200_000;
  const yTicks = Array.from(
    { length: Math.floor(maxCtx / yTickStep) + 1 },
    (_, i) => i * yTickStep,
  ).filter(v => v <= maxCtx);

  // ── Grid 1: tool I/O matrix ───────────────────────────────────────────────
  // x = slot index 0..n-2  (categories: "C1→C2", …)
  // y = tool row index     (categories: tool names)

  const slotCats = slots.map(s => s.label);
  const rowCats  = activeRows as string[];

  // ── Custom renderItem for matrix cells ───────────────────────────────────
  // Data point: [slotIdx, rowIdx]
  // cellMap lookup by key to get actual values

  const cellLookup = new Map(cells.map(c => [`${c.slotIdx}:${c.toolRow}`, c]));

  function renderCell(
    params: echarts.CustomSeriesRenderItemParams,
    api: echarts.CustomSeriesRenderItemAPI,
  ): echarts.CustomSeriesRenderItemReturn {
    const si  = api.value(0) as number;   // slot index
    const ri  = api.value(1) as number;   // row index
    const row = activeRows[ri];
    const cell = cellLookup.get(`${si}:${row}`);

    // Cell bounding box from the coordinate system
    const tl = api.coord([si - 0.5, ri - 0.5]);
    const br = api.coord([si + 0.5, ri + 0.5]);
    const cw = Math.max(br[0] - tl[0] - 2, 4);
    const ch = Math.max(br[1] - tl[1] - 2, 4);  // note: y increases downward in pixel
    const cx = (tl[0] + br[0]) / 2;
    const cy = (tl[1] + br[1]) / 2;

    if (!cell) {
      // Empty cell — faint dot
      return {
        type: "circle",
        shape: { cx, cy, r: 1 },
        style: { fill: "#e5e7eb" },
      } as echarts.CustomSeriesRenderItemReturn;
    }

    const color = TOOL_COLOR[row];
    const children: echarts.CustomSeriesRenderItemReturn[] = [];

    // Output bar: left-anchored after input stub, width ∝ output size
    const outFrac = Math.min(cell.outputDelta / maxOutput, 1);
    const available = cw - 10;   // space after stub (4px) + gap (2px) + right margin (4px)
    const barW    = Math.max(Math.round(outFrac * available), 2);
    const barH    = Math.max(ch - 6, 4);
    const barX    = cx - cw / 2 + 8;   // stub (4) + gap (4)
    const barY    = cy - barH / 2;

    children.push({
      type: "rect",
      shape: { x: barX, y: barY, width: barW, height: barH },
      style: { fill: color + "cc", stroke: color, lineWidth: 0.5 },
    } as echarts.CustomSeriesRenderItemReturn);

    // Input stub: thin left bar (placeholder — we don't have per-tool input size)
    const stubW = 4;
    const stubH = Math.max(barH - 4, 3);
    children.push({
      type: "rect",
      shape: { x: cx - cw / 2 + 2, y: cy - stubH / 2, width: stubW, height: stubH },
      style: { fill: color + "55", stroke: color + "88", lineWidth: 0.5 },
    } as echarts.CustomSeriesRenderItemReturn);

    // Count badge (only if > 1)
    if (cell.callCount > 1) {
      children.push({
        type: "text",
        style: {
          text: String(cell.callCount),
          x: cx + cw / 2 - 2,
          y: cy - barH / 2,
          textAlign: "right", textVerticalAlign: "top",
          fontSize: 8, fill: color, fontWeight: "bold",
        },
      } as echarts.CustomSeriesRenderItemReturn);
    }

    // Error marker
    if (cell.hasError) {
      children.push({
        type: "circle",
        shape: { cx: cx + cw / 2 - 3, cy: cy - barH / 2 + 3, r: 3 },
        style: { fill: "#dc2626" },
      } as echarts.CustomSeriesRenderItemReturn);
    }

    return { type: "group", children } as echarts.CustomSeriesRenderItemReturn;
  }

  // All matrix data points (every combination of slot × row, sparse ok)
  const matrixPoints: [number, number][] = [];
  for (let si = 0; si < slots.length; si++) {
    for (let ri = 0; ri < activeRows.length; ri++) {
      matrixPoints.push([si, ri]);
    }
  }

  // ── Slot delta labels: embedded in matrix xAxis via rich text ───────────
  // Two-line label: slot name + context delta in color.
  // ECharts rich styles are static, so we pick "pos"/"neg"/"cmp" bucket.
  function slotLabelFormatter(value: string): string {
    const si = slotCats.indexOf(value);
    if (si < 0) return value;
    const slot  = slots[si];
    const delta = slot.contextDelta;
    const sign  = delta >= 0 ? "+" : "";
    const style = slot.isCompaction ? "cmp"
                : delta > 0         ? "pos"
                :                     "neg";
    return `{slot|${value}}\n{${style}|${sign}${fmtK(delta)}}`;
  }

  // ── Tooltip formatter ────────────────────────────────────────────────────
  function tooltipFormatter(params: echarts.TooltipComponentFormatterCallbackParams): string {
    const arr = Array.isArray(params) ? params : [params];
    if (!arr.length) return "";
    const p = arr[0];
    const seriesName = p.seriesName as string;

    if (seriesName === "Context") {
      const i   = p.dataIndex as number;
      const c   = calls[i];
      const prev = calls[i - 1];
      const delta = prev ? c.contextSize - prev.contextSize : 0;
      return [
        `<strong>${c.label}</strong>`,
        `<br/>Context: <strong>${fmtK(c.contextSize)}</strong>`,
        i > 0 ? `<br/>Δ vs prev: <span style="color:${delta >= 0 ? "#f59e0b" : "#22c55e"}">${delta >= 0 ? "+" : ""}${fmtK(delta)}</span>` : "",
      ].join("");
    }

    if (seriesName === "Matrix") {
      const si  = p.value as number[] | undefined;
      if (!si) return "";
      const slotIdx = si[0];
      const rowIdx  = si[1];
      const row     = activeRows[rowIdx];
      const slot    = slots[slotIdx];
      const cell    = cellLookup.get(`${slotIdx}:${row}`);
      if (!slot) return "";

      const slotInfo = [
        `<strong>${slot.label}</strong>`,
        ` ctx Δ <span style="color:${slot.contextDelta >= 0 ? "#f59e0b" : "#22c55e"}">${slot.contextDelta >= 0 ? "+" : ""}${fmtK(slot.contextDelta)}</span>`,
      ].join("");

      if (!cell) return slotInfo + `<br/><span style="color:#9ca3af">${row}: —</span>`;

      const toolLines = cell.labels.map(l =>
        `<br/>&nbsp;&nbsp;<span style="color:#9ca3af">${l}</span>`
      ).join("");

      return [
        slotInfo,
        `<br/><span style="color:${TOOL_COLOR[row]};font-weight:700">${row}</span>`,
        ` ×${cell.callCount}`,
        `<br/>Out: <strong>+${fmtK(cell.outputDelta)}</strong>`,
        toolLines,
        cell.hasError ? `<br/><span style="color:#dc2626">⚠ low-confidence attribution</span>` : "",
      ].join("");
    }

    return "";
  }

  // ─── Full option ────────────────────────────────────────────────────────────
  return {
    animation: false,
    backgroundColor: "transparent",

    // Two grids stacked vertically
    grid: [
      // Grid 0: context line
      { id: "ctx",    left: PAD_L, right: PAD_R, top: 8,                          height: CTX_H },
      // Grid 1: tool matrix — top accounts for 2-line xAxis labels (position: top)
      { id: "matrix", left: PAD_L, right: PAD_R, top: 8 + CTX_H + GAP + 30,      height: matrixH },
    ],

    xAxis: [
      // Context line x-axis (call labels)
      {
        id: "xCtx", gridId: "ctx", gridIndex: 0,
        type: "category", data: ctxCats,
        boundaryGap: false,
        axisLine: { lineStyle: { color: "#e5e7eb" } },
        axisTick: { show: false },
        axisLabel: { fontSize: 9, color: "#9ca3af" },
        splitLine: { lineStyle: { color: "#f3f4f6" } },
      },
      // Matrix x-axis (slot labels + delta, one slot = one column)
      {
        id: "xMatrix", gridId: "matrix", gridIndex: 1,
        type: "category", data: slotCats,
        boundaryGap: true,
        axisLine: { lineStyle: { color: "#e5e7eb" } },
        axisTick: { show: false },
        position: "top",
        axisLabel: {
          fontSize: 9,
          formatter: slotLabelFormatter,
          rich: {
            slot: { fontSize: 9, color: "#9ca3af",  lineHeight: 14 },
            pos:  { fontSize: 9, color: "#f59e0b",  fontWeight: "bold", lineHeight: 14 },
            neg:  { fontSize: 9, color: "#22c55e",  fontWeight: "bold", lineHeight: 14 },
            cmp:  { fontSize: 9, color: "#ef4444",  fontWeight: "bold", lineHeight: 14 },
          },
        },
        splitLine: { lineStyle: { color: "#f3f4f6", type: "dashed" } },
      },
    ],

    yAxis: [
      // Context line y-axis
      {
        id: "yCtx", gridId: "ctx", gridIndex: 0,
        type: "value", min: 0, max: maxCtx,
        axisLabel: {
          fontSize: 8, color: "#d1d5db",
          formatter: (v: number) => fmtK(v),
          width: 52, overflow: "truncate",
        },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: {
          lineStyle: { color: "#f3f4f6" },
          show: true,
          interval: (_idx: number, value: number) => yTicks.includes(value),
        },
      },
      // Matrix y-axis (tool row labels)
      {
        id: "yMatrix", gridId: "matrix", gridIndex: 1,
        type: "category",
        data: rowCats,
        // Extend one unit below to make room for header row
        // We use min: -1 and a custom "header" row at y=-0.5
        inverse: false,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          fontSize: 10, color: "#374151", fontWeight: "bold",
          formatter: (v: string) => v,
        },
        splitLine: { lineStyle: { color: "#f3f4f6" } },
      },
    ],

    tooltip: {
      trigger: "item",
      backgroundColor: "#1f2937",
      borderColor: "#374151",
      borderWidth: 1,
      textStyle: { color: "#f9fafb", fontSize: 11 },
      formatter: tooltipFormatter,
    },

    series: [
      // ── Context step line (Grid 0) ────────────────────────────────
      {
        id: "ctx-line",
        name: "Context",
        type: "line",
        xAxisIndex: 0, yAxisIndex: 0,
        data: ctxData,
        step: "end",
        lineStyle: { color: "#6366f1", width: 2 },
        symbol: "circle", symbolSize: 5,
        itemStyle: { color: "#6366f1" },
        areaStyle: {
          color: {
            type: "linear", x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [{ offset: 0, color: "#6366f118" }, { offset: 1, color: "#6366f103" }],
          },
        },
        // Compaction dots rendered separately; mark compaction calls
        markPoint: {
          symbol: "diamond",
          symbolSize: 10,
          data: calls
            .filter(c => c.isCompaction)
            .map(c => ({ coord: [c.idx, c.contextSize], itemStyle: { color: "#ef4444" }, label: { show: false } })),
        },
        z: 3,
      },

      // ── Tool matrix cells (Grid 1) ────────────────────────────────
      {
        id: "matrix",
        name: "Matrix",
        type: "custom",
        xAxisIndex: 1, yAxisIndex: 1,
        renderItem: renderCell,
        data: matrixPoints,
        z: 2,
        encode: { x: 0, y: 1 },
      },

    ],
  };
}

// ─── React component ──────────────────────────────────────────────────────────

export interface TurnMinimapProps {
  turn: UserTurn;
  onSelectCall?: (callId: number) => void;
}

export function TurnMinimap({ turn, onSelectCall }: TurnMinimapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef     = useRef<echarts.ECharts | null>(null);
  const dataRef      = useRef<MinimapData | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = echarts.init(el, undefined, { renderer: "canvas" });
    chartRef.current = chart;

    chart.on("click", "series.line", (params) => {
      if (!onSelectCall) return;
      const i = params.dataIndex as number;
      const call = turn.calls[i];
      if (call) onSelectCall(call.id);
    });

    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const data = buildData(turn);
    dataRef.current = data;

    const nRows  = data.activeRows.length;
    // 8 top pad + ctx grid + 12 gap + xAxis labels (~30px for 2-line) + matrix rows + 8 bottom pad
    const totalH = 8 + CTX_H + 12 + 30 + nRows * ROW_H + 8;
    // Resize container to fit dynamic height
    if (containerRef.current) {
      containerRef.current.style.height = `${totalH}px`;
    }
    chart.resize();
    chart.setOption(buildOption(data), true);
  }, [turn]);

  if (!turn.calls.length) return null;

  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, background: "#fafafa", overflow: "hidden" }}>
      {/* Header row */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "5px 10px", borderBottom: "1px solid #f3f4f6",
      }}>
        {/* Context legend */}
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <div style={{ width: 14, height: 0, borderTop: "2px solid #6366f1" }} />
          <span style={{ fontSize: 9, color: "#9ca3af" }}>context</span>
        </div>
        <div style={{ width: 1, height: 12, background: "#e5e7eb" }} />
        {/* Tool legend chips */}
        {(["Read","Bash","Edit","Write","Agent"] as ToolRow[]).map(r => (
          <div key={r} style={{ display: "flex", alignItems: "center", gap: 3 }}>
            <div style={{ width: 8, height: 8, borderRadius: 1, background: TOOL_COLOR[r] + "cc", border: `1px solid ${TOOL_COLOR[r]}` }} />
            <span style={{ fontSize: 9, color: "#9ca3af" }}>{r}</span>
          </div>
        ))}
        <span style={{ marginLeft: "auto", fontSize: 9, color: "#d1d5db" }}>
          {turn.calls.length} calls · {Math.max(turn.calls.length - 1, 0)} slots
        </span>
      </div>

      {/* Chart */}
      <div ref={containerRef} style={{ width: "100%", height: 200 }} />

      {/* Footer: cell glyph legend */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "4px 10px", borderTop: "1px solid #f3f4f6",
        fontSize: 9, color: "#9ca3af",
      }}>
        <span style={{ fontWeight: 700, color: "#6b7280" }}>cell:</span>
        <span>▏= input (placeholder)</span>
        <span>█ = output size</span>
        <span style={{ color: "#dc2626" }}>● = low-conf</span>
        <span>N = call count</span>
      </div>
    </div>
  );
}

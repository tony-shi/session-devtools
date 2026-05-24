// ContextTimelineChart —— session 总览里的 context 走势图（echarts）：每个 call
// 的 context size 折线 + compact 事件标记，带 X 轴模式切换（SegmentedToggle）。
// 抽自 SessionOverviewPanel.tsx，逻辑零改动。

import React, { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import * as echarts from "echarts";
import type { CompactEvent } from "../../drilldown-types";
import type { MockUserTurn } from "../../lib/mock-data";
import { fmtK } from "../../lib/format";
import { BRAND } from "../../shared/brand";
import { CHART_COLORS, TOOLTIP_PRESET, brandAreaGradient } from "../../shared/chart-theme";
import { SegmentedToggle } from "../../shared/SegmentedToggle";

type TimelineXMode = "linear" | "time";

export function ContextTimelineChart({
  turns, compactEvents = [], isMock,
}: { turns: MockUserTurn[]; compactEvents?: CompactEvent[]; isMock: boolean }) {
  const { t } = useTranslation();
  const [xMode, setXMode] = useState<TimelineXMode>("linear");
  const chartRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<echarts.ECharts | null>(null);

  const turnPoints = turns.map(turn => {
    const peak = Math.max(...turn.calls.map(c => c.contextSize), 0);
    const hasCompaction = turn.calls.some(c => c.isCompaction);
    const parseTs = (s: string) => {
      if (!s) return NaN;
      const t = s.length <= 8 ? new Date(`1970-01-01T${s}Z`).getTime() : new Date(s).getTime();
      return isNaN(t) ? NaN : t;
    };
    const firstMs = parseTs(turn.calls[0]?.timestamp ?? "");
    const lastMs  = parseTs(turn.calls[turn.calls.length - 1]?.timestamp ?? "");
    const durationMs = (!isNaN(firstMs) && !isNaN(lastMs)) ? Math.max(lastMs - firstMs, 0) : 0;
    return { turnId: turn.id, contextSize: peak, isCompaction: hasCompaction, firstMs, durationMs };
  });

  const peakCtx = Math.max(...turnPoints.map(p => p.contextSize), 0);

  // Build ECharts option based on current mode
  const buildOption = (mode: TimelineXMode): echarts.EChartsOption => {
    const nT = turnPoints.length;
    const lineColor = CHART_COLORS.brand;

    const labelStyle = {
      fontSize: 9,
      borderWidth: 0,
      padding: [2, 4] as [number, number],
      borderRadius: 3,
    };

    // Shared markPoint data for max + final annotations
    const buildAnnotations = (
      maxIdx: number, maxVal: number, maxX: number | string,
      finalIdx: number, finalVal: number, finalX: number | string,
    ) => {
      const isSame = maxIdx === finalIdx;
      const pts: { name: string; coord: (number | string)[]; symbol: string; label: object }[] = [];
      // max point
      pts.push({
        name: "max",
        coord: [maxX, maxVal],
        symbol: "none",
        label: {
          show: true,
          formatter: `Max\n${fmtK(maxVal)}`,
          position: "top" as const,
          ...labelStyle,
          color: CHART_COLORS.brand,
          backgroundColor: BRAND.indigo50,
        },
      });
      // final point (skip if same as max)
      if (!isSame) {
        pts.push({
          name: "final",
          coord: [finalX, finalVal],
          symbol: "none",
          label: {
            show: true,
            formatter: `Final\n${fmtK(finalVal)}`,
            position: "top" as const,
            ...labelStyle,
            color: "#6b7280",
            backgroundColor: "#f3f4f6",
          },
        });
      }
      return pts;
    };

    // +Δ label shown above each point (skip first point, no delta)
    const deltaLabel = (values: number[]) => ({
      show: true,
      position: "top" as const,
      fontSize: 9,
      fontWeight: 500,
      padding: [1, 3] as [number, number],
      borderRadius: 3,
      borderWidth: 0,
      formatter: (params: unknown) => {
        const idx = (params as { dataIndex: number }).dataIndex;
        if (idx === 0) return "";
        const delta = values[idx] - values[idx - 1];
        if (delta <= 0) return "";
        return `+${fmtK(delta)}`;
      },
      color: CHART_COLORS.brand,
      backgroundColor: "transparent",
    });

    if (mode === "linear" || nT <= 1) {
      const xLabels = turnPoints.map(p => `T${p.turnId}`);
      const values = turnPoints.map(p => p.contextSize);
      const compactionIndices = turnPoints
        .map((p, i) => p.isCompaction ? i : -1)
        .filter(i => i >= 0);

      // Fix B2：压缩是 between-turns 事件，不属于任何 turn 点。用 markLine 画在
      // "压缩后第一个 turn"（belonging.beforeTurnId）的 category 处 —— 一条竖直
      // 边界线 + "压缩 N" 标签，表达"这里发生过压缩、context 在此被重写"，而不是
      // 把菱形/badge 错打在某个 turn 数据点上。
      const compactionMarkLines = compactEvents
        .map(ev => {
          const targetTurnId =
            ev.belonging.kind === "between-turns" ? ev.belonging.beforeTurnId
            : ev.belonging.kind === "post-session" ? ev.belonging.afterTurnId
            : null;
          if (targetTurnId == null) return null;
          const xl = `T${targetTurnId}`;
          if (!xLabels.includes(xl)) return null;
          return { xAxis: xl, label: `${t("sessionOverview.compact.label")} ${ev.index + 1}` };
        })
        .filter((x): x is { xAxis: string; label: string } => x !== null);

      const maxIdx = values.indexOf(Math.max(...values));
      const finalIdx = values.length - 1;
      const annotations = buildAnnotations(
        maxIdx, values[maxIdx], xLabels[maxIdx],
        finalIdx, values[finalIdx], xLabels[finalIdx],
      );

      return {
        grid: { top: 36, bottom: 28, left: 12, right: 44, containLabel: false },
        xAxis: {
          type: "category",
          data: xLabels,
          axisLabel: { fontSize: 10, color: CHART_COLORS.axisLabel, interval: 0 },
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { show: false },
        },
        yAxis: {
          type: "value",
          min: 0,
          axisLabel: {
            fontSize: 9,
            color: CHART_COLORS.axisLabel,
            formatter: (v: number) => fmtK(v),
            inside: false,
          },
          splitLine: { lineStyle: { color: CHART_COLORS.splitLine } },
          axisLine: { show: false },
          axisTick: { show: false },
        },
        series: [
          {
            type: "line",
            data: values,
            smooth: false,
            lineStyle: { color: lineColor, width: 1.5 },
            itemStyle: { color: lineColor },
            symbolSize: (_, params) =>
              compactionIndices.includes((params as { dataIndex: number }).dataIndex) ? 8 : 5,
            symbol: (_, params) =>
              compactionIndices.includes((params as { dataIndex: number }).dataIndex) ? "diamond" : "circle",
            areaStyle: { color: brandAreaGradient() },
            label: deltaLabel(values),
            labelLayout: { hideOverlap: true },
            markPoint: {
              silent: true,
              data: [
                ...compactionIndices.map(i => ({
                  name: `compaction-${i}`,
                  coord: [xLabels[i], values[i]],
                  itemStyle: { color: CHART_COLORS.compaction },
                  symbol: "diamond",
                  symbolSize: 8,
                  label: { show: false },
                })),
                ...annotations,
              ],
            },
            markLine: {
              silent: true,
              symbol: "none",
              data: compactionMarkLines.map(m => ({
                xAxis: m.xAxis,
                lineStyle: { color: CHART_COLORS.compaction, type: "dashed", width: 1 },
                label: {
                  show: true, position: "insideEndTop", fontSize: 9,
                  color: CHART_COLORS.compaction, formatter: m.label,
                },
              })),
            },
          },
        ],
        tooltip: {
          ...TOOLTIP_PRESET,
          trigger: "axis",
          formatter: (params: unknown) => {
            const p = (params as Array<{ name: string; value: number }>)[0];
            if (!p) return "";
            return `${p.name}: ${fmtK(p.value)}`;
          },
        },
      };
    } else {
      // Time mode: value axis using cumulative active time in seconds
      const hasTimestamps = turnPoints.every(p => !isNaN(p.firstMs));
      if (!hasTimestamps) {
        return buildOption("linear");
      }

      const cumActive: number[] = [0];
      for (let i = 1; i < nT; i++) {
        const prevEnd = turnPoints[i - 1].firstMs + turnPoints[i - 1].durationMs;
        cumActive.push(cumActive[i - 1] + turnPoints[i - 1].durationMs);
        void prevEnd; // idle gaps no longer displayed
      }

      const dataPoints = turnPoints.map((p, i) => ({
        value: [cumActive[i] / 1000, p.contextSize] as [number, number],
        isCompaction: p.isCompaction,
        turnId: p.turnId,
      }));

      const ctxValues = dataPoints.map(d => d.value[1]);
      const maxDpIdx = ctxValues.indexOf(Math.max(...ctxValues));
      const finalDpIdx = dataPoints.length - 1;
      const timeAnnotations = buildAnnotations(
        maxDpIdx, dataPoints[maxDpIdx].value[1], dataPoints[maxDpIdx].value[0],
        finalDpIdx, dataPoints[finalDpIdx].value[1], dataPoints[finalDpIdx].value[0],
      );

      return {
        grid: { top: 36, bottom: 28, left: 12, right: 44, containLabel: false },
        xAxis: {
          type: "value",
          min: 0,
          max: dataPoints[dataPoints.length - 1]?.value[0] ?? "dataMax",
          axisLabel: {
            fontSize: 9,
            color: CHART_COLORS.axisLabel,
            formatter: (v: number) => {
              if (v < 60) return `${v}s`;
              return `${Math.round(v / 60)}m`;
            },
          },
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { show: false },
        },
        yAxis: {
          type: "value",
          min: 0,
          axisLabel: {
            fontSize: 9,
            color: CHART_COLORS.axisLabel,
            formatter: (v: number) => fmtK(v),
          },
          splitLine: { lineStyle: { color: CHART_COLORS.splitLine } },
          axisLine: { show: false },
          axisTick: { show: false },
        },
        series: [
          {
            type: "line",
            data: dataPoints.map(d => d.value),
            smooth: false,
            lineStyle: { color: lineColor, width: 1.5 },
            itemStyle: {
              color: (params: unknown) => {
                const idx = (params as { dataIndex: number }).dataIndex;
                return dataPoints[idx]?.isCompaction ? CHART_COLORS.compaction : lineColor;
              },
            },
            symbolSize: (_, params) => dataPoints[(params as { dataIndex: number }).dataIndex]?.isCompaction ? 8 : 5,
            symbol: (_, params) => dataPoints[(params as { dataIndex: number }).dataIndex]?.isCompaction ? "diamond" : "circle",
            areaStyle: { color: brandAreaGradient() },
            label: deltaLabel(ctxValues),
            labelLayout: { hideOverlap: true },
            markPoint: { silent: true, data: timeAnnotations },
          },
        ],
        tooltip: {
          ...TOOLTIP_PRESET,
          trigger: "axis",
          formatter: (params: unknown) => {
            const p = (params as Array<{ dataIndex: number; value: [number, number] }>)[0];
            if (!p) return "";
            const d = dataPoints[p.dataIndex];
            const compTag = d?.isCompaction ? " ◆" : "";
            return `T${d?.turnId}: ${fmtK(p.value[1])}${compTag}`;
          },
        },
      };
    }
  };

  // Init chart once
  useEffect(() => {
    if (!chartRef.current) return;
    const chart = echarts.init(chartRef.current, undefined, { renderer: "svg" });
    instanceRef.current = chart;
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(chartRef.current);
    return () => {
      observer.disconnect();
      chart.dispose();
      instanceRef.current = null;
    };
  }, []);

  // Re-set option whenever mode or data changes — replacesMerge ensures X axis fully resets
  useEffect(() => {
    const chart = instanceRef.current;
    if (!chart || !turnPoints.length) return;
    chart.setOption(buildOption(xMode), { replaceMerge: ["xAxis", "yAxis", "series"] });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xMode, turns]);

  if (!turns.length) return null;

  return (
    <div style={{ overflow: "hidden" }}>
      {/* Mode toggle */}
      <div style={{ padding: "6px 10px 0" }}>
        <SegmentedToggle<TimelineXMode>
          value={xMode}
          onChange={setXMode}
          options={[
            { id: "linear", label: t("sessionOverview.charts.xAxisLinear") },
            { id: "time",   label: t("sessionOverview.charts.xAxisTime") },
          ]}
        />
      </div>

      <div ref={chartRef} style={{ width: "100%", height: 150 }} />

      {/* Footer annotation */}
      {!isMock && (
        <div style={{ padding: "2px 10px 6px", fontSize: 10, color: "#9ca3af", display: "flex", gap: 16, flexWrap: "wrap" }}>
          <span>{t("sessionOverview.charts.peak")}: <strong style={{ color: "#374151" }}>{fmtK(peakCtx)}</strong></span>
          {xMode === "time" && <span style={{ color: "#c4b5d5" }}>{t("sessionOverview.charts.xAxisTimeHint")}</span>}
        </div>
      )}
    </div>
  );
}


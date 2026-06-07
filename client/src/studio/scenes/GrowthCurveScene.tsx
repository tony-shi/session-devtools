import { AbsoluteFill, useCurrentFrame, interpolate, Easing } from "remotion";
import { useT } from "../i18n";
import type { ActClock } from "./storyClock";
import curveFixture from "../fixtures/growth-curve.json";

// Story 3 的「增长曲线」幕 —— 自绘 SVG,不引 ECharts(Remotion 需要确定性逐帧渲染)。
// 数据 = 真实会话 8a9637a5 全程 251 个有效 call 的 contextSize(token),含一次真实 compact:
//   call ~240:943,784 → 48,939(摘要本身 13,055 token;窗口上限 1M)。
//
// 两种模式:
//   open —— 开场幕(step 0-1):曲线从左到右逐拍爬升,止步于峰值(悬崖留给幕E)。
//   full —— compact 幕(step 15-16):先停在峰值 + 上限虚线;到 step16 的「跌回」拍
//            (beat 2)揭示悬崖:尾段画出 + 红色标注卡。

type Pt = { id: number; t: number; ctx: number; compact: boolean };
const PTS = curveFixture as Pt[];

// 悬崖 = 序列里最大跌幅的那个点(真实 compact 落点)。
let CLIFF = 1;
for (let i = 1; i < PTS.length; i++) {
  if (PTS[i - 1].ctx - PTS[i].ctx > PTS[CLIFF - 1].ctx - PTS[CLIFF].ctx) CLIFF = i;
}

// 画布几何(1920×1080;底部留出字幕区)。
const M = { left: 170, right: 130, top: 170, bottom: 240 };
const W = 1920 - M.left - M.right;
const H = 1080 - M.top - M.bottom;
const Y_MAX = 1_000_000; // 纵轴顶 = 窗口上限(1M token),峰值 94 万正好「逼近天花板」

const x = (i: number) => M.left + (i / (PTS.length - 1)) * W;
const y = (ctx: number) => M.top + H - (Math.min(ctx, Y_MAX) / Y_MAX) * H;

function pathFor(upTo: number): string {
  const n = Math.max(2, Math.min(PTS.length, Math.ceil(upTo)));
  return PTS.slice(0, n).map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.ctx).toFixed(1)}`).join(" ");
}
function areaFor(upTo: number): string {
  const n = Math.max(2, Math.min(PTS.length, Math.ceil(upTo)));
  const base = M.top + H;
  return `${pathFor(upTo)} L${x(n - 1).toFixed(1)},${base} L${x(0).toFixed(1)},${base} Z`;
}

export function GrowthCurveScene({ clock, mode }: { clock: ActClock; mode: "open" | "full" }) {
  const frame = useCurrentFrame();
  const t = useT();

  // open:全程缓动爬到峰值(CLIFF-1);full:峰值即起点,悬崖拍后画出尾段。
  let reveal: number;
  let cliffP = 0; // 悬崖揭示进度 0..1
  if (mode === "open") {
    reveal = interpolate(frame, [0, clock.total * 0.82], [3, CLIFF], {
      easing: Easing.inOut(Easing.quad), extrapolateLeft: "clamp", extrapolateRight: "clamp",
    });
  } else {
    // 触发帧:step 16「之后的对话从摘要轻装出发…」(beat 2);找不到就退到 65%。
    const trigger = clock.segments.find((s) => s.stepIdx === 16 && s.beat === 2)?.start ?? clock.total * 0.65;
    cliffP = interpolate(frame, [trigger, trigger + 45], [0, 1], {
      easing: Easing.out(Easing.quad), extrapolateLeft: "clamp", extrapolateRight: "clamp",
    });
    reveal = CLIFF + cliffP * (PTS.length - CLIFF);
  }

  const peakOn = mode === "full" || reveal >= CLIFF * 0.92;     // 峰值标注(开场幕末段浮现)
  const peakFade = mode === "open"
    ? interpolate(reveal, [CLIFF * 0.92, CLIFF], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
    : 1;
  const peakI = CLIFF - 1;

  const fontFamily = "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, -apple-system, sans-serif";
  const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";

  return (
    <AbsoluteFill style={{ background: "#fff", fontFamily }}>
      {/* 左上来源 chip */}
      <div style={{
        position: "absolute", top: 64, left: M.left,
        fontSize: 26, color: "#64748b", background: "#f1f5f9",
        padding: "10px 22px", borderRadius: 999, fontWeight: 500,
      }}>{t.gcChip}</div>

      <svg width={1920} height={1080} style={{ position: "absolute", inset: 0 }}>
        {/* 横向网格 + y 轴刻度:0 / 50万 / 100万 */}
        {[0, 0.5, 1].map((f, i) => (
          <g key={f}>
            <line x1={M.left} y1={M.top + H - f * H} x2={M.left + W} y2={M.top + H - f * H}
              stroke="#e2e8f0" strokeWidth={i === 0 ? 2 : 1} strokeDasharray={i === 0 ? undefined : "6 8"} />
            <text x={M.left - 18} y={M.top + H - f * H + 9} textAnchor="end"
              fontSize={24} fill="#94a3b8" fontFamily={mono}>{t.gcTicks[i]}</text>
          </g>
        ))}
        {/* 窗口上限(1M)虚线 —— full 模式强调,open 模式弱化 */}
        <line x1={M.left} y1={y(Y_MAX)} x2={M.left + W} y2={y(Y_MAX)}
          stroke={mode === "full" ? "#f59e0b" : "#e2e8f0"} strokeWidth={mode === "full" ? 3 : 1} strokeDasharray="14 10" />
        {mode === "full" && (
          <text x={M.left + W} y={y(Y_MAX) - 14} textAnchor="end" fontSize={26} fill="#d97706" fontWeight={600}>
            {t.gcWindow}
          </text>
        )}

        {/* 曲线主体 */}
        <path d={areaFor(reveal)} fill="rgba(99,102,241,0.08)" />
        <path d={pathFor(reveal)} fill="none" stroke="#6366f1" strokeWidth={5} strokeLinejoin="round" strokeLinecap="round" />

        {/* 峰值标注 */}
        {peakOn && (
          <g opacity={peakFade}>
            <circle cx={x(peakI)} cy={y(PTS[peakI].ctx)} r={10} fill="#6366f1" />
            <text x={x(peakI) - 16} y={y(PTS[peakI].ctx) - 22} textAnchor="end"
              fontSize={30} fill="#4338ca" fontWeight={700}>{t.gcPeak}</text>
          </g>
        )}

        {/* 悬崖:红色竖虚线 + 落点 */}
        {mode === "full" && cliffP > 0 && (
          <g opacity={Math.min(1, cliffP * 1.4)}>
            <line x1={x(CLIFF)} y1={y(PTS[CLIFF - 1].ctx)} x2={x(CLIFF)} y2={y(PTS[CLIFF].ctx)}
              stroke="#dc2626" strokeWidth={3} strokeDasharray="10 8" />
            <circle cx={x(CLIFF)} cy={y(PTS[CLIFF].ctx)} r={9} fill="#dc2626" />
          </g>
        )}
        {/* x 轴说明 */}
        <text x={M.left + W} y={M.top + H + 44} textAnchor="end" fontSize={24} fill="#94a3b8">{t.gcAxisCalls}</text>
      </svg>

      {/* compact 标注卡(悬崖揭示后浮现) */}
      {mode === "full" && cliffP > 0.4 && (
        <div style={{
          position: "absolute",
          left: x(CLIFF) - 420, top: y(PTS[CLIFF].ctx) - 170,
          opacity: interpolate(cliffP, [0.4, 1], [0, 1]),
          background: "#fef2f2", border: "2px solid #fca5a5", borderRadius: 16,
          padding: "18px 28px", boxShadow: "0 12px 36px rgba(220,38,38,0.12)",
        }}>
          <div style={{ fontSize: 30, fontWeight: 800, color: "#b91c1c", marginBottom: 6 }}>{t.gcCompactLabel}</div>
          <div style={{ fontSize: 28, color: "#7f1d1d", fontFamily: mono }}>{t.gcCompactDrop}</div>
        </div>
      )}
    </AbsoluteFill>
  );
}

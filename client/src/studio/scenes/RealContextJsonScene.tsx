import { AbsoluteFill, useCurrentFrame, interpolate, Easing } from "remotion";
import JsonView from "@uiw/react-json-view";
import type React from "react";
import request from "../fixtures/request-real-context.json";
import type { ActClock } from "./storyClock";

// 故事二开场幕(需求2 重写):放弃「全文滚墙」(巨型 DOM 逐帧重渲 → 帧率差、滚不到头)。
// 新交互 = 默认只展示第一层结构 → 按拍子逐层点开(内容爆长,示意结构复杂)→ 轻度滚动一小段
// + 底部渐隐(暗示后面还有很多,不真滚到头)→ 「三个核心字段」拍收回到顶层。
//
// 时间锚点不写死帧数,从 clock.segments 取:
//   expandAt = step1 beat0(「庞大的 JSON…层层嵌套」)→ 进入展开+轻滚
//   foldAt   = step1 beat1(「顶层其实只有三个核心字段」)→ 收回 collapsed=1
const REQ = request as unknown as object;

const SCROLL_PX = 760;  // 轻滚总幅度(像素,留有克制 —— 只示意,不读完)
const FADE = 12;        // 层间交叉淡化帧数

export const RealContextJsonScene = ({ clock }: { clock: ActClock }) => {
  const frame = useCurrentFrame();
  const expandAt = clock.segments.find((s) => s.stepIdx === 1 && s.beat === 0)?.start
    ?? Math.round(clock.total * 0.4);
  const foldAt = clock.segments.find((s) => s.stepIdx === 1 && s.beat === 1)?.start
    ?? Math.round(clock.total * 0.7);

  // 展开期内的进度:前段先「点开第二层」,过 1/3 再「点开第三层」,同时缓滚。
  const p = interpolate(frame, [expandAt, foldAt], [0, 1], {
    easing: Easing.inOut(Easing.quad),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const expandPhase = frame >= expandAt && frame < foldAt;
  const collapsedDepth = p < 0.33 ? 2 : 3;          // 逐层点开:2 层 → 3 层
  const scrollY = Math.round(p * SCROLL_PX);          // 轻滚
  const expandOpacity = interpolate(
    frame,
    [expandAt, expandAt + FADE, foldAt - FADE, foldAt],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  const jsonStyle = {
    fontSize: 24,
    lineHeight: 1.75,
    background: "transparent",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  } as React.CSSProperties;

  return (
    <AbsoluteFill
      style={{
        background: "#fff",
        padding: "76px 110px",
        flexDirection: "column",
        gap: 22,
        fontFamily: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, -apple-system, sans-serif",
      }}
    >
      <div style={{ color: "#0f172a", fontSize: 36, fontWeight: 800, letterSpacing: 0.5 }}>
        这一次调用,真正发给模型的 request
      </div>
      <div style={{ color: "#64748b", fontSize: 22 }}>
        claude-opus-4-8 · tools × 10 · system × 4 · messages × 2 · 共约 6.5 万字符
      </div>
      <div
        style={{
          flex: 1,
          position: "relative",
          overflow: "hidden",
          background: "#f8fafc",
          borderRadius: 18,
          border: "1px solid #e2e8f0",
          boxShadow: "0 10px 40px rgba(15,23,42,0.06)",
        }}
      >
        {/* 顶层总览(开场 + 「三个核心字段」收回后) */}
        <div style={{ position: "absolute", inset: 0, padding: "26px 34px", opacity: 1 - expandOpacity }}>
          <JsonView
            value={REQ}
            collapsed={1}
            displayDataTypes={false}
            enableClipboard={false}
            indentWidth={20}
            style={jsonStyle}
          />
        </div>
        {/* 展开层:逐层点开 + 轻滚 + 底部渐隐(只在展开期挂载,控制 DOM 量) */}
        {expandPhase && (
          <div style={{ position: "absolute", inset: 0, padding: "26px 34px", opacity: expandOpacity }}>
            <div style={{ transform: `translateY(${-scrollY}px)` }}>
              <JsonView
                key={collapsedDepth /* 切层级时重挂,展开状态干净 */}
                value={REQ}
                collapsed={collapsedDepth}
                displayDataTypes={false}
                enableClipboard={false}
                indentWidth={20}
                style={jsonStyle}
              />
            </div>
            {/* 底部渐隐:暗示「后面还很长」,不真滚到头 */}
            <div
              style={{
                position: "absolute",
                left: 0, right: 0, bottom: 0, height: 180,
                background: "linear-gradient(to bottom, rgba(248,250,252,0), #f8fafc)",
                pointerEvents: "none",
              }}
            />
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};

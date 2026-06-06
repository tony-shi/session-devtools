import { AbsoluteFill, useCurrentFrame, interpolate, Easing } from "remotion";
import JsonView from "@uiw/react-json-view";
import type React from "react";
import request from "../fixtures/request-real-context.json";
import type { ActClock } from "./storyClock";

// 故事二开场幕:把真实的 request JSON 摊开给观众看 —— 两个阶段:
//   Phase A(step0 + step1 第一句「庞大的 json…6.4万字符」):原始 pretty-print 全文铺成
//     一面 ~2.3 万 px 的「墙」,慢→快滚屏 + 右侧假滚动条(thumb 只占 ~4%,本身就是体量提示)。
//     直观回答「这个 json 有多大」—— 快进着滚都要二十多秒。
//   Phase B(step1「重点是三个字段」起):交叉淡入折叠总览(JsonView, collapsed=1),
//     呼应旁白「不要被长度吓倒,重点是 tools / system / messages」。
// 切点不写死帧数:从 clock.segments 找 {step1, beat1} 的 start —— 改旁白时长自动重排。
const REQ = request as unknown as object;
const WALL = JSON.stringify(REQ, null, 2); // ~7.1 万字符 / wrap 后 ~880 行,这就是「墙」本体

// 滚动终点对齐:translateY(-p·(H−V)) = translateY(-p·100%) + translateY(p·V)。
// 内容高 H 不必精确知道;V 是裁剪视口的近似像素高(1080 − 上下边距 − 标题区 − 内边距)。
const VIEW_H = 760;
const FADE = 10; // 两阶段交叉淡化帧数

export const RealContextJsonScene = ({ clock }: { clock: ActClock }) => {
  const frame = useCurrentFrame();
  // 切到折叠总览的帧 = step1 beat1(「先不要被长度吓倒…重点为三个字段」)开始;找不到则退到 60%。
  const switchAt = clock.segments.find((s) => s.stepIdx === 1 && s.beat === 1)?.start
    ?? Math.round(clock.total * 0.6);
  // 滚动进度:慢起步(前几秒还能读清)→ 越滚越快(读不动了),终点恰好滚到墙底。
  const p = interpolate(frame, [0, switchAt], [0, 1], {
    easing: Easing.in(Easing.quad),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const wallOpacity = interpolate(frame, [switchAt - FADE, switchAt], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

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
        claude-opus-4-8 · tools × 10 · system × 4 · messages × 2 · 共六万多字符
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
        {/* Phase A:原始 JSON 文本墙,整面滚过 */}
        {frame < switchAt && (
          <div style={{ position: "absolute", inset: 0, padding: "26px 56px 26px 34px", opacity: wallOpacity }}>
            <pre
              style={{
                margin: 0,
                whiteSpace: "pre-wrap",
                wordBreak: "break-all", // messages 里上万字符的单行长串必须强制折行
                fontSize: 17,
                lineHeight: 1.55,
                color: "#475569",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                transform: `translateY(${p * VIEW_H}px) translateY(${-p * 100}%)`,
              }}
            >
              {WALL}
            </pre>
            {/* 假滚动条:thumb 高度 ≈ 视口/全文 ≈ 4% —— 「条有多细,文有多长」 */}
            <div style={{ position: "absolute", top: 14, bottom: 14, right: 12, width: 8, borderRadius: 4, background: "#e2e8f0" }}>
              <div
                style={{
                  position: "absolute",
                  top: `${p * 96}%`,
                  height: "4%",
                  width: "100%",
                  borderRadius: 4,
                  background: "#94a3b8",
                }}
              />
            </div>
          </div>
        )}
        {/* Phase B:折叠总览 —— 「重点是三个字段」 */}
        {frame >= switchAt - FADE && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              padding: "26px 34px",
              opacity: 1 - wallOpacity,
            }}
          >
            <JsonView
              value={REQ}
              collapsed={1}
              displayDataTypes={false}
              enableClipboard={false}
              indentWidth={20}
              style={{
                fontSize: 24,
                lineHeight: 1.75,
                background: "transparent",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
              } as React.CSSProperties}
            />
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};

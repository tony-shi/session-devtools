import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from "remotion";

// Phase 0 探针 —— 不分享任何 walkthrough 组件,只验证工具链:
//   (a) Remotion 在 React 19.2 / TS6 / Vite8 这套栈里能 bundle + render
//   (b) frame 驱动的 interpolate / 打字机能用(这是 parity 的地基)
//   (c) 中文(CJK)在无头 Chromium 里渲得出来、不是豆腐块 —— 中文内容的关键风险点
//   (d) 内联 style(walkthrough 的写法)在 Remotion 里原样成立
export const HelloProbe = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // 标题:frame 0→20 淡入 + 上移(等价现在的 CSS transition,但确定性)
  const titleOpacity = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: "clamp" });
  const titleY = interpolate(frame, [0, 20], [24, 0], { extrapolateRight: "clamp" });

  // 打字机:frame 20 → 20+2s 之间把整行逐字打出(纯 frame 函数,无 setTimeout)
  const line = "找出这个仓库里最关键的 3 个文件 —— 先 Grep,再 Read,最后 tool_use";
  const typed = Math.floor(
    interpolate(frame, [20, 20 + fps * 2], [0, line.length], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }),
  );

  return (
    <AbsoluteFill
      style={{
        background: "#fff",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        gap: 28,
        fontFamily:
          "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, -apple-system, 'Segoe UI', sans-serif",
      }}
    >
      <div
        style={{
          opacity: titleOpacity,
          transform: `translateY(${titleY}px)`,
          fontSize: 60,
          fontWeight: 800,
          color: "#6366f1",
          letterSpacing: 1,
        }}
      >
        Remotion · Phase 0 探针
      </div>

      <div
        style={{
          maxWidth: 1200,
          fontSize: 34,
          lineHeight: 1.6,
          color: "#1f2937",
          background: "#f1f5f9",
          border: "1px solid #e2e8f0",
          borderRadius: 18,
          padding: "22px 30px",
          whiteSpace: "pre-wrap",
        }}
      >
        {line.slice(0, typed)}
        {typed < line.length && (
          <span style={{ color: "#6366f1" }}>▍</span>
        )}
      </div>

      <div style={{ fontSize: 22, color: "#94a3b8", fontFamily: "monospace" }}>
        frame {frame} · React 19 · CJK + 英文 + 代码术语混排
      </div>
    </AbsoluteFill>
  );
};

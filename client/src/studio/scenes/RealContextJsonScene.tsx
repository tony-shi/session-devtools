import { AbsoluteFill } from "remotion";
import JsonView from "@uiw/react-json-view";
import type React from "react";
import request from "../fixtures/request-real-context.json";

// 故事二开场幕:把真实的 request JSON 摊开给观众看 ——
//   "这就是真发给模型的请求,六万多字符,直接读根本读不动" → 后面切到归因面板做"解读"。
// 用前端已引入的 @uiw/react-json-view 渲染(不自己造轮子),折叠到顶层:
//   段其实不多 —— model / tools[10] / system[4] / messages[2] / …
const REQ = request as unknown as object;

export const RealContextJsonScene = () => (
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
        overflow: "hidden",
        background: "#f8fafc",
        borderRadius: 18,
        padding: "26px 34px",
        border: "1px solid #e2e8f0",
        boxShadow: "0 10px 40px rgba(15,23,42,0.06)",
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
  </AbsoluteFill>
);

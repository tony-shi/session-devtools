// Shared "no-proxy" indicator dot.
//
// 同一颗黄圆点用在三处：
//   (a) 左侧 nav 中 unmatched 的 LLM 调用条目末尾（SessionDetailV2 sidebar）
//   (b) 右侧 chrome 区 hasProxy=false 时的 inline 标记（LlmCallDetailPanel）
//   (c) AuditBoundaryStatus 全部 skip 都是 no-proxy 时的左侧 dot
// 视觉规约：8×8 黄圆 `#f59e0b`，i18n tooltip 由调用方传入。

export function NoProxyDot({ size = 8, title }: { size?: number; title?: string }) {
  return (
    <span
      title={title}
      style={{
        width: size,
        height: size,
        borderRadius: 999,
        background: "#f59e0b",
        flexShrink: 0,
        display: "inline-block",
      }}
    />
  );
}

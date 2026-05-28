import type { Focus } from "../types";

// ep5 第一/三幕:Compaction 概念图 —— 压缩前(长,逼近上限)→ 总结 → 压缩后(短摘要)+ 代价。
// focus="compact" 按 beat 逐拍;focus="diagram" 静态全图。比例示意,真实数字在 compact-real。

export function CompactView({ focus, beat }: { focus: Focus; beat: number }) {
  const diagram = focus === "diagram";
  const stage = diagram ? 9 : beat;
  const PRE = 88; // 示意:压缩前占满上限的比例
  const POST = 22; // 压缩后

  return (
    <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 40 }}>
      <div style={{ width: "min(620px, 100%)", animation: "wt-fade .4s ease both" }}>
        {/* 压缩前 */}
        <div style={{ fontSize: 12, fontWeight: 700, color: "#b91c1c", marginBottom: 6 }}>压缩前 · 历史 + 工具结果越来越长,逼近上限</div>
        <div style={{ position: "relative", height: 34, borderRadius: 8, background: "#f1f5f9", overflow: "hidden", border: "1px solid #e5e7eb" }}>
          <div style={{ width: `${PRE}%`, height: "100%", background: "#fca5a5", display: "flex", alignItems: "center", paddingLeft: 12, color: "#7f1d1d", fontSize: 11, fontWeight: 700 }}>长历史(context 快满)</div>
          <div style={{ position: "absolute", top: -2, bottom: -2, left: "100%", marginLeft: -2, width: 2, background: "#ef4444" }} />
        </div>

        {stage >= 1 && <div style={{ marginTop: 8, fontSize: 12, color: "#b45309" }}>⚠ 再涨就超上限 —— 触发 compaction</div>}
        {stage >= 2 && <div style={{ textAlign: "center", margin: "12px 0", color: "#6366f1", fontSize: 13, fontWeight: 700 }}>↓ 发起一次总结调用,把长历史压成摘要</div>}

        {/* 压缩后 */}
        {stage >= 3 && (
          <div style={{ animation: "wt-rise .35s ease both" }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#15803d", marginBottom: 6 }}>压缩后 · 一段摘要,context 大幅缩小</div>
            <div style={{ height: 34, borderRadius: 8, background: "#f1f5f9", overflow: "hidden", border: "1px solid #e5e7eb" }}>
              <div style={{ width: `${POST}%`, height: "100%", background: "#86efac", display: "flex", alignItems: "center", paddingLeft: 12, color: "#14532d", fontSize: 11, fontWeight: 700 }}>摘要</div>
            </div>
          </div>
        )}

        {/* 代价 */}
        {stage >= 4 && <div style={{ marginTop: 14, fontSize: 13, color: "#b91c1c", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "8px 12px", animation: "wt-fade .3s ease both" }}>代价①:前缀被改写 → Ep4 那个几乎免费的缓存全部失效。</div>}
        {stage >= 5 && <div style={{ marginTop: 8, fontSize: 13, color: "#b45309", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "8px 12px", animation: "wt-fade .3s ease both" }}>代价②:摘要保留大意,但丢了原话细节 —— 记得做过什么,记不清原文。</div>}
        {stage >= 6 && <div style={{ marginTop: 8, fontSize: 12, color: "#64748b" }}>可手动 /compact,也会在接近上限时自动触发。</div>}
      </div>
      <style>{`@keyframes wt-fade{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}@keyframes wt-rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}`}</style>
    </div>
  );
}

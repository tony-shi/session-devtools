import type { Focus } from "../types";

// ep8 概念图:subagent —— 开第二个 context。
// 主 context(干净)→ 派出隔离的子 context(自己走完整套 loop)→ 只带回一段摘要。
// focus="spawn" 按 beat 逐拍;focus="diagram" 静态全图。

export function SubagentView({ focus, beat }: { focus: Focus; beat: number }) {
  const diagram = focus === "diagram";
  const stage = diagram ? 9 : beat;

  return (
    <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 40 }}>
      <div style={{ width: "min(760px, 100%)", animation: "wt-fade .4s ease both" }}>
        <div style={{ display: "flex", alignItems: "stretch", gap: 16 }}>
          {/* 主 context */}
          <div style={{ flex: 1, border: "2px solid #6366f1", borderRadius: 12, padding: "16px 16px", background: "#eef2ff" }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: "#312e81" }}>主 agent · 主 context</div>
            <div style={{ fontSize: 12, color: "#475569", marginTop: 8, lineHeight: 1.6 }}>
              {stage >= 1 ? "遇到一个大的子任务,派一个子 agent 去做。" : "前面所有 context,都是同一个。"}
            </div>
            {stage >= 5 && <div style={{ marginTop: 10, fontSize: 12, color: "#15803d", fontWeight: 700 }}>← 收到一段摘要,主 context 保持干净</div>}
          </div>

          {/* 箭头 */}
          {stage >= 2 && (
            <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", color: "#94a3b8", fontSize: 12, minWidth: 56 }}>
              <div style={{ fontSize: 20 }}>→</div>
              <div>派发</div>
              {stage >= 4 && <div style={{ fontSize: 20, marginTop: 8 }}>←</div>}
              {stage >= 4 && <div style={{ color: "#15803d" }}>摘要</div>}
            </div>
          )}

          {/* 子 context */}
          {stage >= 2 && (
            <div style={{ flex: 1, border: "2px dashed #f59e0b", borderRadius: 12, padding: "16px 16px", background: "#fffbeb", animation: "wt-fade .35s ease both" }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: "#b45309" }}>子 agent · 独立 context</div>
              <div style={{ fontSize: 12, color: "#475569", marginTop: 8, lineHeight: 1.6 }}>
                {stage >= 3 ? "自己走完前几集那一整套:自己的 loop、自己的 context、自己的成本。" : "主 agent 的历史它看不到,它的探索也不挤占主 context。"}
              </div>
            </div>
          )}
        </div>

        {stage >= 6 && <div style={{ marginTop: 16, fontSize: 13, color: "#b45309", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "8px 12px", animation: "wt-fade .3s ease both" }}>不是免费魔法:它自己烧 token,也会丢中间细节 —— 只有结论回到主线。</div>}
      </div>
      <style>{`@keyframes wt-fade{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}`}</style>
    </div>
  );
}

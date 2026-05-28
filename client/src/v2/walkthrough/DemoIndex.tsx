import { useNavigate } from "react-router-dom";
import { STORIES } from "./stories";
import { loadLang, pickLines, pickTitle } from "./i18n";

// /demo 目录页(仅 dev)。按课程顺序列出每一集 + 集内每一幕(act / focus / 首行),
// 方便录制前快速理解结构、跳到任意一集。生产构建里随 DemoStage 一同被剥离。
export function DemoIndex() {
  const navigate = useNavigate();
  const stories = Object.values(STORIES);
  // 跟随 DemoStage 上一次保存的语言显示标题 / 首句 —— 缺译自动回退到中文。
  const lang = loadLang();

  return (
    <div style={{ maxWidth: 920, margin: "0 auto", padding: "32px 24px 80px" }}>
      <h1 style={{ fontSize: 24, fontWeight: 800, color: "#0f172a", margin: 0 }}>Walkthrough 演示目录</h1>
      <p style={{ color: "#64748b", fontSize: 13, marginTop: 6 }}>
        共 {stories.length} 集 · 课程顺序:loop → context → diff → tools → cache → compaction → extend → subagent。
        点任意一集进入播放(← / → 切幕,Space 播放/暂停,R 重播,Esc 退出)。
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 24 }}>
        {stories.map((s, i) => (
          <div key={s.id} style={{ border: "1px solid #e2e8f0", borderRadius: 14, overflow: "hidden", background: "#fff" }}>
            <button
              onClick={() => navigate(`/demo/${s.id}`)}
              style={{ width: "100%", textAlign: "left", display: "flex", alignItems: "center", gap: 12, padding: "14px 18px", background: "#f8fafc", border: "none", borderBottom: "1px solid #eef2f6", cursor: "pointer" }}
            >
              <span style={{ flexShrink: 0, width: 34, height: 34, borderRadius: 999, background: "#6366f1", color: "#fff", fontSize: 14, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>{i + 1}</span>
              <span style={{ flex: 1 }}>
                <span style={{ display: "block", fontSize: 16, fontWeight: 700, color: "#0f172a" }}>{pickTitle(s, lang)}</span>
                <code style={{ fontSize: 12, color: "#6366f1" }}>/demo/{s.id}</code>
              </span>
              <span style={{ color: "#94a3b8", fontSize: 13 }}>{s.steps.length} 幕 →</span>
            </button>

            <div style={{ padding: "10px 18px 14px" }}>
              {s.steps.map((st, j) => {
                const subtitle = pickLines(st, lang);
                return (
                  <div key={j} style={{ display: "flex", gap: 12, padding: "7px 0", borderBottom: j < s.steps.length - 1 ? "1px dashed #eef2f6" : "none" }}>
                    <span style={{ flexShrink: 0, fontSize: 12, fontWeight: 700, color: "#475569", width: 44 }}>幕 {j + 1}</span>
                    <span style={{ flexShrink: 0, fontSize: 11, color: "#64748b", fontFamily: "monospace", width: 200, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{st.act} · {st.focus}</span>
                    <span style={{ flex: 1, fontSize: 12, color: "#334155" }}>{subtitle[0]}<span style={{ color: "#94a3b8" }}> · {subtitle.length} 句</span></span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

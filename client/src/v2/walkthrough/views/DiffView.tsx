import type { LlmCall } from "../../drilldown-types";
import type { Focus } from "../types";

// ep3 第一/三幕:Context Diff 概念图 —— 稳定前缀(灰)+ 尾部逐拍追加的新增块(绿)。
// 完整 diff = 模型回应(思考/说明)+ tool_use + tool_result + 注入。
// focus="diff":按 beat 逐拍追加;focus="diagram":静态全图(收尾)。

const clip = (s: string, n: number) => { const t = (s ?? "").trim(); return t.length > n ? t.slice(0, n) + "…" : t; };

type Chunk = { label: string; lines: string[] };

function buildChunks(call: LlmCall): Chunk[] {
  const tools = call.toolCalls ?? [];
  const chunks: Chunk[] = [
    { label: "模型回应 · 思考与说明", lines: [clip(call.assistantText ?? "", 160) || "(无文本)"] },
  ];
  if (tools.length) {
    chunks.push({ label: "tool_use · 模型决定调用", lines: tools.map((t) => `→ ${t.name}(${clip(t.inputPreview, 40)})`) });
    chunks.push({ label: "tool_result · Agent 执行结果", lines: tools.map((t) => `${t.name}: ${clip(t.outputPreview, 60) || "(空)"}`) });
  }
  chunks.push({ label: "system-reminder · 运行时注入(示意)", lines: ["如:文件被改 / 待办提醒 / plan mode"] });
  return chunks;
}

export function DiffView({ call, focus, beat }: { call: LlmCall | null; focus: Focus; beat: number }) {
  if (!call) return <div style={{ padding: 24, color: "#6b7280" }}>该会话无可 diff 的 call。</div>;
  const diagram = focus === "diagram";
  const chunks = buildChunks(call);
  const revealed = diagram ? chunks.length : Math.max(0, beat - 1); // beat0-1 只显前缀

  return (
    <div style={{ height: "100%", overflowY: "auto", display: "flex", alignItems: "center", justifyContent: "center", padding: 40 }}>
      <div style={{ width: "min(640px, 100%)", display: "flex", flexDirection: "column", gap: 8, animation: "wt-fade .4s ease both" }}>
        {/* 稳定前缀(灰) */}
        <div style={{ border: "1px solid #e5e7eb", background: "#f8fafc", borderRadius: 10, padding: "12px 16px", color: "#64748b" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#94a3b8" }}>稳定前缀(上一次就有,基本不变)</div>
          <div style={{ fontSize: 13, marginTop: 4 }}>tools · system · 之前的对话</div>
        </div>

        {revealed > 0 && <div style={{ textAlign: "center", color: "#16a34a", fontSize: 12, fontWeight: 700 }}>↓ 这一次新增(diff)</div>}

        {/* 尾部新增块(绿) */}
        {chunks.slice(0, revealed).map((c, i) => (
          <div key={i} style={{ border: "1px solid #bbf7d0", background: "#f0fdf4", borderRadius: 10, padding: "10px 14px", animation: "wt-rise .35s ease both" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
              <span style={{ color: "#16a34a", fontWeight: 700, fontSize: 13 }}>+</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: "#15803d" }}>{c.label}</span>
            </div>
            {c.lines.map((ln, j) => (
              <div key={j} style={{ fontSize: 13, color: "#374151", lineHeight: 1.5, fontFamily: c.label.startsWith("tool") ? "monospace" : undefined, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{ln}</div>
            ))}
          </div>
        ))}
      </div>
      <style>{`@keyframes wt-fade{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}@keyframes wt-rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}`}</style>
    </div>
  );
}

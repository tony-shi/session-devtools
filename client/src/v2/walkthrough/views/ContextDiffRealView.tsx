import { useEffect, useState } from "react";
import { apiV2 } from "../../api";
import type { DiffTreeResult } from "../../diff-tree-types";
import { sectionPalette } from "../../lens-palette";

// ep3 第二幕:切到真实 diffTree —— 这一次 Call 相对上一次,真实新增了什么。
// 复用真实 diff 数据(apiV2.diffTree),不带任何 diff schema 细节;数据不全时概念兜底。
export function ContextDiffRealView({ sessionId, callId }: { sessionId: string; callId: number; beat: number }) {
  const [data, setData] = useState<DiffTreeResult | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    apiV2.diffTree(sessionId, callId)
      .then((d) => { if (!cancelled) { setData(d); setState("ok"); } })
      .catch(() => { if (!cancelled) setState("error"); });
    return () => { cancelled = true; };
  }, [sessionId, callId]);

  const unavailable = state === "error" || (data && data.unavailableReason);
  const fallback = (
    <div style={{ color: "#6b7280", fontSize: 13, border: "1px dashed #cbd5e1", borderRadius: 10, padding: "12px 16px" }}>
      这条 call 的 diff 数据不全(通常是没开 proxy)—— 但概念不变:每一次新增 = 模型回应 + 工具结果 + 运行时注入。
    </div>
  );

  let body: React.ReactNode = <div style={{ color: "#6b7280", fontSize: 13 }}>正在读取真实 diff…</div>;
  if (unavailable) body = fallback;
  else if (state === "ok" && data) {
    const total = data.sections.reduce((s, x) => s + x.newTotal, 0) || 1;
    const added = data.summary.insertedChars;
    const addedPct = Math.min(100, (added / total) * 100);
    const addedLeaves = data.sections
      .flatMap((s) => s.leaves.filter((l) => l.kind === "added").map((l) => ({ section: s.id, leaf: l })))
      .slice(0, 6);
    body = (
      <>
        <div style={{ fontSize: 13, color: "#15803d", fontWeight: 700, marginBottom: 10 }}>
          相对上一次 Call,新增约 {added.toLocaleString()} 字符 · {data.summary.addedCount} 块
        </div>
        {/* kept(灰) + added(绿) */}
        <div style={{ display: "flex", height: 30, borderRadius: 8, overflow: "hidden", gap: 2 }}>
          <div style={{ width: `${100 - addedPct}%`, background: "#e2e8f0", display: "flex", alignItems: "center", justifyContent: "center", color: "#64748b", fontSize: 11, fontWeight: 700 }}>{100 - addedPct > 12 ? "沿用(前缀)" : ""}</div>
          <div style={{ width: `${addedPct}%`, background: "#22c55e", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 11, fontWeight: 700 }}>{addedPct > 8 ? "新增" : ""}</div>
        </div>
        {/* 新增的真实块 */}
        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 6 }}>
          {addedLeaves.map(({ section, leaf }, i) => {
            const meta = sectionPalette[section];
            return (
              <div key={i} style={{ border: "1px solid #bbf7d0", background: "#f0fdf4", borderRadius: 8, padding: "6px 10px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: meta.barBg, flexShrink: 0 }} />
                  <span style={{ fontSize: 11, fontWeight: 700, color: "#15803d" }}>+ {leaf.wireMeta?.toolName ?? leaf.wireMeta?.messageRole ?? meta.label}</span>
                </div>
                <div style={{ fontSize: 12, color: "#475569", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{(leaf.preview ?? "").slice(0, 90)}</div>
              </div>
            );
          })}
        </div>
      </>
    );
  }

  return (
    <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 40 }}>
      <div style={{ width: "min(680px, 100%)", animation: "wt-fade .4s ease both" }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#334155", marginBottom: 12 }}>这一次 Call 相对上一次,真实新增了什么</div>
        {body}
      </div>
      <style>{`@keyframes wt-fade{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}`}</style>
    </div>
  );
}

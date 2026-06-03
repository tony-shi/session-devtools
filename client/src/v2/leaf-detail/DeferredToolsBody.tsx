// 特化渲染：延迟工具 listing（deferred-tools-listing.v1/v2）。
//
// 真实格式（2.1.160 wire 确认）：一段引导语 + 换行分隔的工具名。两类：
//   - Claude Code 故意 defer 的工具：裸名（CronCreate / TaskUpdate / WebFetch …）。
//   - MCP 工具：mcp__<server>__<tool>（按 "__" 分割，server=中段，如 claude_ai_Gmail / tavily）。
// 这里把 CC defer 平铺成 chips、MCP 按 server 分组可折叠。
//
// body-only：parsed = 上述分组视图；raw = 原文 pre。统一详情头由 dispatcher(SelectedDetail)
// 渲染，本组件接 rawMode 决定 parsed/raw，不 import SelectedDetailHeader（避免循环依赖）。
import React, { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { LeafLite } from "../AttributionTreePanel";

function parseDeferredTools(raw: string): { cc: string[]; mcp: Map<string, string[]> } {
  const cc: string[] = [];
  const mcp = new Map<string, string[]>();
  for (const line of raw.split("\n")) {
    const name = line.trim();
    if (!name || /\s/.test(name)) continue; // 跳过引导语（有空格）与空行
    if (name.startsWith("mcp__")) {
      const parts = name.split("__"); // ["mcp", server, tool…]
      const server = parts.length >= 3 ? parts[1]! : "(unknown)";
      const tool = parts.length >= 3 ? parts.slice(2).join("__") : name;
      if (!mcp.has(server)) mcp.set(server, []);
      mcp.get(server)!.push(tool);
    } else if (/^[A-Za-z][\w]*$/.test(name)) {
      cc.push(name);
    }
  }
  return { cc, mcp };
}

const wrap: React.CSSProperties = {
  display: "flex", flexDirection: "column", gap: 12,
  padding: "10px 12px", background: "#fafafa", border: "1px solid #e5e7eb", borderRadius: 6,
};
const preStyle: React.CSSProperties = {
  margin: 0, padding: "10px 12px", background: "#fafafa", border: "1px solid #e5e7eb",
  borderRadius: 6, fontSize: 11.5, fontFamily: "ui-monospace, SFMono-Regular, monospace",
  color: "#1f2937", whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.55,
};
const sectionTitle: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: "#6b7280", marginBottom: 4 };
const ccChip: React.CSSProperties = {
  display: "inline-block", padding: "2px 7px", margin: "2px 4px 2px 0",
  fontSize: 11.5, fontFamily: "ui-monospace, SFMono-Regular, monospace",
  background: "#eef2ff", color: "#4338ca", border: "1px solid #e0e7ff", borderRadius: 4,
};
const mcpChip: React.CSSProperties = { ...ccChip, background: "#f5f3ff", color: "#6d28d9", borderColor: "#ede9fe" };
const serverBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 4, padding: "1px 4px",
  background: "transparent", border: "none", cursor: "pointer", fontSize: 12,
  color: "#4b5563", fontFamily: "ui-monospace, SFMono-Regular, monospace",
};

export function DeferredToolsBody({ leaf, rawMode }: { leaf: LeafLite; rawMode: boolean }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const raw = leaf.rawText ?? leaf.preview;
  const { cc, mcp } = parseDeferredTools(raw);
  const mcpTotal = [...mcp.values()].reduce((s, a) => s + a.length, 0);

  if (rawMode) return <pre style={preStyle}>{raw}</pre>;

  return (
    <div style={wrap}>
      {cc.length > 0 && (
        <div>
          <div style={sectionTitle}>Claude Code 延迟工具 · {cc.length}</div>
          <div>{cc.map((n) => <span key={n} style={ccChip}>{n}</span>)}</div>
        </div>
      )}
      {mcp.size > 0 && (
        <div>
          <div style={sectionTitle}>MCP 工具 · {mcpTotal}（{mcp.size} 个 server）</div>
          {[...mcp.entries()].map(([server, tools]) => {
            const isCol = collapsed.has(server);
            return (
              <div key={server} style={{ marginTop: 2 }}>
                <button
                  type="button"
                  style={serverBtn}
                  onClick={() => setCollapsed((s) => {
                    const n = new Set(s);
                    if (n.has(server)) n.delete(server); else n.add(server);
                    return n;
                  })}
                >
                  {isCol ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                  <span style={{ fontWeight: 600 }}>{server}</span>
                  <span style={{ color: "#9ca3af" }}>· {tools.length}</span>
                </button>
                {!isCol && (
                  <div style={{ paddingLeft: 18 }}>
                    {tools.map((t) => <span key={t} style={mcpChip}>{t}</span>)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {cc.length === 0 && mcp.size === 0 && (
        <div style={{ color: "#9ca3af", fontSize: 12 }}>（未解析出工具名，请切到原文查看）</div>
      )}
    </div>
  );
}

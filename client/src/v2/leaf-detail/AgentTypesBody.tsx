// 特化渲染：Agent 类型 listing（agent-types-listing.v1/v2）。
//
// 真实格式（2.1.160 wire 确认）：
//   Available agent types for the Agent tool:
//   - <name>: <desc> (Tools: <toolsStr>)
// toolsStr 三形态：`*`（全部）/ `All tools except A, B`（排除）/ `Bash, Read`（列举）。
// 渲染成表格（类型 / 用途 / 工具），工具列直接展示具体工具（chips），不计数。
//
// body-only：parsed = 表格；raw（或解析为空）= 原文 pre。统一详情头由 dispatcher 渲染，
// 本组件接 rawMode 决定 parsed/raw，不 import SelectedDetailHeader（避免循环依赖）。
import React from "react";
import {
  LISTING_MONO, listingChip, listingChipMuted, listingChipAll,
  listingPre, listingCell, listingHeadCell, listingTableWrap,
} from "./listing-style";
import { BRAND } from "../shared/brand";
import type { LeafLite } from "../AttributionTreePanel";

interface AgentRow { name: string; desc: string; tools: string }

function parseAgentTypes(raw: string): AgentRow[] {
  const out: AgentRow[] = [];
  for (const line of raw.split("\n")) {
    const l = line.trim();
    if (!l.startsWith("- ")) continue;
    const body = l.slice(2);
    const sep = body.indexOf(": "); // name 到第一个 ": "（name 可含单 ":"，如 codex:codex-rescue）
    if (sep < 0) continue;
    const name = body.slice(0, sep);
    const rest = body.slice(sep + 2);
    // 末尾 (Tools: …)；desc 自身可能含 ()，故非贪婪 desc + 锚定结尾的 (Tools: …)
    const m = rest.match(/^([\s\S]*?)\s*\(Tools:\s*([^)]*)\)\s*$/);
    if (m) out.push({ name, desc: m[1]!.trim(), tools: m[2]!.trim() });
    else out.push({ name, desc: rest.trim(), tools: "" });
  }
  return out;
}

const toolChip: React.CSSProperties = listingChip;
const exclChip: React.CSSProperties = listingChipMuted;

/** 工具列：展示具体工具（不计数），区分 全部 / 排除 / 列举 三形态。 */
function ToolsCell({ tools }: { tools: string }) {
  if (!tools) return <span style={{ color: "#9ca3af" }}>—</span>;
  if (tools === "*") return <span style={listingChipAll}>全部 *</span>;
  const excl = tools.match(/^All tools except\s+(.+)$/i);
  if (excl) {
    const names = excl[1]!.split(/,\s*/).filter(Boolean);
    return (
      <span>
        <span style={{ fontSize: 11, color: "#9ca3af", marginRight: 4 }}>全部，除：</span>
        {names.map((n) => <span key={n} style={exclChip}>{n}</span>)}
      </span>
    );
  }
  const names = tools.split(/,\s*/).filter(Boolean);
  return <>{names.map((n) => <span key={n} style={toolChip}>{n}</span>)}</>;
}

const preStyle: React.CSSProperties = listingPre;
const cell: React.CSSProperties = listingCell;
const headCell: React.CSSProperties = listingHeadCell;

export function AgentTypesBody({ leaf, rawMode }: { leaf: LeafLite; rawMode: boolean }) {
  const raw = leaf.rawText ?? leaf.preview;
  const rows = parseAgentTypes(raw);

  if (rawMode || rows.length === 0) return <pre style={preStyle}>{raw}</pre>;

  return (
    <div style={listingTableWrap}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr>
            <th style={{ ...headCell, width: "1%", whiteSpace: "nowrap" }}>类型</th>
            <th style={headCell}>用途</th>
            <th style={{ ...headCell, width: "30%" }}>工具</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td style={{ ...cell, whiteSpace: "nowrap", fontFamily: LISTING_MONO, color: BRAND.indigo700, fontWeight: 600 }}>
                {r.name}
              </td>
              <td style={{ ...cell, color: r.desc ? "#374151" : "#9ca3af", lineHeight: 1.5 }}>
                <span style={{
                  display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                }} title={r.desc}>
                  {r.desc || "—"}
                </span>
              </td>
              <td style={cell}><ToolsCell tools={r.tools} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

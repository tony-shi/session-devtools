// SideCallDetailPanel —— 单个 side call（后台 LLM 请求）的 URL 可寻址详情视图。
//
// 与 LlmCallDetailPanel 的视觉骨架一致（顶部 header → REQUEST → RESPONSE），但
// 是 proxy-only 路径：直接 fetch proxy 的原始 req/res body 解析，没有 JSONL 归因 /
// AttributionGraph 接线（side call 不在对话主线里，没有可归因的 jsonl 坐标）。
//
// req_body 是 Anthropic 请求 JSON（{model, system, messages, tools}）。
// res_body 是 SSE 文本（流式）或 JSON —— 两种都尽力抽出 assistant 文本。

import React, { useEffect, useState } from "react";
import { apiV2, type ProxyBodyResponse } from "../../api";
import { shortModelName, modelColor } from "../../lib/format";
import { EventUnitCard, SegmentView, type EventSegment } from "../../shared/EventUnitCard";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

// ── 解析 helpers（纯函数，文件内私有）─────────────────────────────────────────

interface ParsedRequest {
  model: string | null;
  /** system blocks 拍平成文本段（string system → 单段；block 数组 → 逐段）。 */
  systemBlocks: string[];
  /** 每条 message 的 role + 抽出的文本（content 是 string 或 block 数组）。 */
  messages: Array<{ role: string; text: string }>;
}

function blockText(content: unknown): string {
  // content 可能是 string，或 [{type:"text",text}, {type:"tool_use",...}, …]。
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (b && typeof b === "object") {
      const block = b as Record<string, unknown>;
      if (typeof block.text === "string") parts.push(block.text);
      else parts.push(JSON.stringify(block));
    }
  }
  return parts.join("\n");
}

function parseRequest(reqBody: string): ParsedRequest | null {
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(reqBody) as Record<string, unknown>; }
  catch { return null; }

  const model = typeof obj.model === "string" ? obj.model : null;

  const systemBlocks: string[] = [];
  if (typeof obj.system === "string") {
    systemBlocks.push(obj.system);
  } else if (Array.isArray(obj.system)) {
    for (const b of obj.system) {
      if (typeof b === "string") systemBlocks.push(b);
      else if (b && typeof b === "object" && typeof (b as Record<string, unknown>).text === "string") {
        systemBlocks.push((b as Record<string, unknown>).text as string);
      }
    }
  }

  const messages: Array<{ role: string; text: string }> = [];
  if (Array.isArray(obj.messages)) {
    for (const m of obj.messages) {
      if (m && typeof m === "object") {
        const msg = m as Record<string, unknown>;
        const role = typeof msg.role === "string" ? msg.role : "?";
        messages.push({ role, text: blockText(msg.content) });
      }
    }
  }

  return { model, systemBlocks, messages };
}

// res_body 是 SSE（流式）时：扫描 `data: {...}` 行，把 content_block_delta 的
// delta.text 拼起来；否则当 JSON 解析，抽 .content[].text。两条路径都 best-effort，
// 失败时返回 null（UI 退回展示原始文本）。
function parseResponseText(resBody: string): string | null {
  const trimmed = resBody.trimStart();
  // JSON 响应（非流式）
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(resBody) as Record<string, unknown>;
      if (Array.isArray(obj.content)) return blockText(obj.content);
    } catch { /* fall through to SSE path */ }
  }
  // SSE：逐行抽 `data: {...}` 里的 content_block_delta.delta.text
  const parts: string[] = [];
  for (const line of resBody.split("\n")) {
    const trimmedLine = line.trim();
    if (!trimmedLine.startsWith("data:")) continue;
    const payload = trimmedLine.slice("data:".length).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const evt = JSON.parse(payload) as Record<string, unknown>;
      if (evt.type === "content_block_delta") {
        const delta = evt.delta as Record<string, unknown> | undefined;
        if (delta && typeof delta.text === "string") parts.push(delta.text);
      }
    } catch { /* skip非 JSON 行 */ }
  }
  return parts.length > 0 ? parts.join("") : null;
}

// ── Section 壳 ───────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 700, color: "#6b7280",
      textTransform: "uppercase", letterSpacing: "0.06em",
      marginBottom: 8,
    }}>
      {children}
    </div>
  );
}

export function SideCallDetailPanel({
  sessionId, proxyRequestId, onClose,
}: {
  sessionId: string;
  proxyRequestId: number;
  onClose?: () => void;
}) {
  const [body, setBody] = useState<ProxyBodyResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // 数据加载 effect：标准 fetch-on-mount 模式。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setBody(null);
    apiV2.proxyBody(proxyRequestId)
      .then(d => { if (!cancelled) setBody(d); })
      .catch(() => { if (!cancelled) setBody({ req_body: "", res_body: "", error: "request body unavailable" }); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // sessionId 不参与 fetch（proxyBody 仅按 proxyRequestId 寻址），但保留在
    // 依赖里以便 session 切换时也刷新，语义更稳。
  }, [proxyRequestId, sessionId]);

  const parsedReq = body && !body.error ? parseRequest(body.req_body) : null;
  const responseText = body && !body.error ? parseResponseText(body.res_body) : null;

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "16px 22px", minWidth: 0 }}>
      {/* ── Header ──────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, flexWrap: "wrap", paddingBottom: 10, borderBottom: "1px solid #f3f4f6" }}>
        <span style={{ fontSize: 14, fontWeight: 800, color: "#111827" }}>
          后台请求 proxy#{proxyRequestId}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          {parsedReq?.model && (
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <div style={{ width: 7, height: 7, borderRadius: 2, background: modelColor(parsedReq.model), flexShrink: 0 }} />
              <span style={{ fontSize: 11, color: "#6b7280" }}>{shortModelName(parsedReq.model)}</span>
            </div>
          )}
          {onClose && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={onClose}
                  style={{
                    border: "1px solid #e5e7eb", background: "#fff", color: "#64748b",
                    borderRadius: 6, padding: "1px 7px", fontSize: 14, lineHeight: 1,
                    cursor: "pointer", fontWeight: 700,
                  }}
                >
                  ×
                </button>
              </TooltipTrigger>
              <TooltipContent>关闭</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      {loading ? (
        <div style={{ fontSize: 11, color: "#9ca3af", padding: "20px 0" }}>Loading…</div>
      ) : body?.error ? (
        <div style={{
          fontSize: 11, color: "#b45309",
          background: "#fffbeb", border: "1px solid #fde68a",
          borderRadius: 6, padding: "10px 12px",
        }}>
          {body.error === "request body unavailable" ? "请求体不可用（proxy 未保留或已被裁剪）。" : body.error}
        </div>
      ) : (
        <>
          {/* ══ REQUEST ══════════════════════════════ */}
          <SectionLabel>Request</SectionLabel>
          {!parsedReq ? (
            <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 16 }}>无法解析请求体。</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 18 }}>
              {parsedReq.systemBlocks.map((sys, i) => (
                <EventUnitCard
                  key={`sys-${i}`}
                  color="#64748b"
                  kindLabel="System"
                  segments={[{ label: "SYSTEM", content: sys, monospace: false, truncateAt: 2000 }]}
                  defaultExpanded
                  expandable={false}
                />
              ))}
              {parsedReq.messages.map((m, i) => (
                <EventUnitCard
                  key={`msg-${i}`}
                  color={m.role === "assistant" ? "#16a34a" : "#3b82f6"}
                  kindLabel={m.role}
                  segments={[{ label: m.role.toUpperCase(), content: m.text || "(empty)", monospace: false, truncateAt: 2000 }]}
                  defaultExpanded
                  expandable={false}
                />
              ))}
              {parsedReq.systemBlocks.length === 0 && parsedReq.messages.length === 0 && (
                <div style={{ fontSize: 11, color: "#9ca3af" }}>请求体无 system / messages。</div>
              )}
            </div>
          )}

          {/* ══ RESPONSE ═════════════════════════════ */}
          <SectionLabel>Response</SectionLabel>
          {responseText != null ? (
            <div style={{
              border: "1px solid #bbf7d0", background: "#f0fdf4",
              borderRadius: 6, padding: "0 10px 8px",
            }}>
              <SegmentView seg={{ label: "ASSISTANT", content: responseText, monospace: false, truncateAt: 4000 } as EventSegment} />
            </div>
          ) : (
            <div style={{ fontSize: 11, color: "#9ca3af" }}>无法从响应体抽出文本（可能为非文本响应）。</div>
          )}
        </>
      )}
    </div>
  );
}

// 特化渲染：tool 定义（tools.* 段，rawText 是完整 tool JSON）。
//
// body-only：只渲染内容主体（parsed = description / 参数表 / 其它字段；raw = JsonView；
// parse 失败 = 原文 pre，绝不白屏）。统一详情头由 dispatcher(SelectedDetail) 渲染，
// 本组件接 rawMode 决定 parsed/raw，不 import SelectedDetailHeader（避免循环依赖）。
import React, { useMemo, Fragment } from "react";
import { useTranslation } from "react-i18next";
import JsonView from "@uiw/react-json-view";
import { BRAND } from "../shared/brand";
import { renderMarkdownWithHighlights } from "./MarkdownHighlightCard";
import {
  tryParseSegmentJson, extractToolParams, relocateFieldsToDescription,
  TOOL_MONO, TOOL_JSON_VIEW_STYLE, PARAM_GRID_COLS,
} from "./tool-format";
import type { LeafLite } from "../AttributionTreePanel";

export function ToolDefinitionBody({ leaf, rawMode }: { leaf: LeafLite; rawMode: boolean }) {
  const { t } = useTranslation();
  const fullText = leaf.rawText ?? leaf.preview;

  // 单个 useMemo 完成 parse + 派生，避免条件 hook。
  const parsed = useMemo(() => {
    const obj = tryParseSegmentJson(fullText);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tool = obj as Record<string, any>;
    return {
      tool,
      description: typeof tool.description === "string" ? tool.description : undefined,
      inputSchema: tool.input_schema,
      params: extractToolParams(tool.input_schema),
      otherFields: Object.entries(tool).filter(
        ([k]) => k !== "name" && k !== "description" && k !== "input_schema",
      ),
    };
  }, [fullText]);

  // tool 描述里的动态字段（如 Bash 的 Co-Authored-By 模型名）：origin.dynamicFields 的坐标相对
  // 完整 tool JSON(rawText)，而这里渲染的是 parse 后的 description 子串。relocateFieldsToDescription
  // 借 JSON.parse 把坐标精确搬到 description，再交给 position 高亮 —— 与其它动态字段一样标黄。
  const dynamicFields = leaf.origin.kind === "rule" ? leaf.origin.dynamicFields : undefined;
  const relocated = useMemo(
    () => relocateFieldsToDescription(fullText, dynamicFields),
    [fullText, dynamicFields],
  );

  // parse 失败兜底：原文 <pre>，绝不白屏。
  if (!parsed) {
    return (
      <pre style={{
        margin: 0, padding: "10px 12px",
        background: "#fafafa", border: "1px solid #e5e7eb", borderRadius: 6,
        fontFamily: TOOL_MONO, fontSize: 11.5, lineHeight: 1.55,
        whiteSpace: "pre-wrap", wordBreak: "break-word", color: "#1f2937",
      }}>
        {fullText}
      </pre>
    );
  }

  if (rawMode) {
    return (
      <div style={{ padding: "10px 12px", background: "#fafafa", border: "1px solid #e5e7eb", borderRadius: 6 }}>
        <JsonView value={parsed.tool} collapsed={2} displayDataTypes={false} displayObjectSize={false} enableClipboard style={TOOL_JSON_VIEW_STYLE} />
      </div>
    );
  }

  const { description, inputSchema, params, otherFields } = parsed;
  const labelStyle: React.CSSProperties = {
    fontSize: 11, fontWeight: 700, color: "#6b7280",
    textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 5,
  };
  const cellBase: React.CSSProperties = {
    fontSize: 12, padding: "5px 10px", wordBreak: "break-word", minWidth: 0,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Description —— 主角，markdown 渲染 */}
      <div>
        <div style={labelStyle}>{t("toolDef.description")}</div>
        {description && description.trim() ? (
          <div className="md-prose" style={{ fontSize: 12, color: "#1f2937", border: "1px solid #e5e7eb", borderRadius: 6, background: "#fff", padding: "8px 12px" }}>
            {relocated
              ? renderMarkdownWithHighlights(relocated.description, relocated.fields)
              : renderMarkdownWithHighlights(description, undefined)}
          </div>
        ) : (
          <div style={{ fontSize: 11, color: "#9ca3af", fontStyle: "italic" }}>{t("toolDef.noDescription")}</div>
        )}
      </div>

      {/* Parameters —— 来自 input_schema.properties */}
      {inputSchema != null && (
        <div>
          <div style={labelStyle}>
            {t("toolDef.parameters")}{params.length > 0 ? ` (${params.length})` : ""}
          </div>
          {params.length > 0 ? (
            <div style={{ border: "1px solid #e5e7eb", borderRadius: 6, overflow: "hidden" }}>
              <div style={{ display: "grid", gridTemplateColumns: PARAM_GRID_COLS, background: "#f9fafb", borderBottom: "1px solid #e5e7eb", fontWeight: 700, color: "#6b7280" }}>
                <span style={cellBase}>{t("toolDef.colName")}</span>
                <span style={cellBase}>{t("toolDef.colType")}</span>
                <span style={cellBase}>{t("toolDef.colRequired")}</span>
                <span style={cellBase}>{t("toolDef.colDesc")}</span>
              </div>
              {params.map((p, i) => (
                <div key={p.name} style={{ display: "grid", gridTemplateColumns: PARAM_GRID_COLS, borderBottom: i < params.length - 1 ? "1px solid #f3f4f6" : undefined, alignItems: "start" }}>
                  <span style={{ ...cellBase, fontFamily: TOOL_MONO, color: BRAND.indigo700, fontWeight: 600 }}>{p.name}</span>
                  <span style={{ ...cellBase, fontFamily: TOOL_MONO, color: "#0f766e" }}>{p.type}</span>
                  <span style={cellBase}>
                    {p.required
                      ? <span style={{ color: "#b45309", fontWeight: 600 }}>● {t("toolDef.required")}</span>
                      : <span style={{ color: "#9ca3af" }}>{t("toolDef.optional")}</span>}
                  </span>
                  <span style={{ ...cellBase, color: p.description ? "#374151" : "#9ca3af" }}>{p.description ?? "—"}</span>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 11, color: "#9ca3af", fontStyle: "italic" }}>{t("toolDef.noParams")}</div>
          )}
        </div>
      )}

      {/* Other fields —— type / cache_control / 服务端 tool 配置等 */}
      {otherFields.length > 0 && (
        <div>
          <div style={labelStyle}>{t("toolDef.otherFields")}</div>
          <div style={{ display: "grid", gridTemplateColumns: "max-content 1fr", columnGap: 16, rowGap: 6, padding: "10px 12px", background: "#fafafa", border: "1px solid #e5e7eb", borderRadius: 6 }}>
            {otherFields.map(([k, v]) => (
              <Fragment key={k}>
                <span style={{ fontFamily: TOOL_MONO, color: "#6b7280", fontWeight: 600, fontSize: 12 }}>{k}</span>
                <span style={{ fontSize: 12, color: "#1f2937", fontFamily: v !== null && typeof v === "object" ? TOOL_MONO : "inherit", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  {v !== null && typeof v === "object" ? JSON.stringify(v) : String(v)}
                </span>
              </Fragment>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

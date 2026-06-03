// 共享：tool 定义解析 + tool 详情用的样式常量。
//
// 从 AttributionTreePanel 抽出，供 leaf-detail/ToolDefinitionBody 复用。放这里而非 panel，
// 是为了让 body 组件不用反向 import panel 的值（否则 panel → body → panel 成循环依赖）。
// 纯逻辑 + 常量，无 React 渲染、无 panel 依赖；panel 自身仍可单向 import 本文件。
import type { CSSProperties } from "react";

/**
 * Best-effort JSON parse（"原始 JSON"段开关用）。内容不是 JSON（不以 { 或 [ 开头 /
 * 解析失败）时返回 undefined，让开关保持隐藏而不是报错。
 */
export function tryParseSegmentJson(s: string): unknown {
  if (!s) return undefined;
  const trimmed = s.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return undefined;
  try { return JSON.parse(trimmed); } catch { return undefined; }
}

export interface ToolParamRow {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

export const TOOL_MONO = "ui-monospace, SFMono-Regular, monospace";
export const TOOL_JSON_VIEW_STYLE: CSSProperties = {
  backgroundColor: "transparent",
  fontFamily: TOOL_MONO,
  fontSize: 11,
  lineHeight: 1.5,
};
export const PARAM_GRID_COLS = "minmax(96px,1.2fr) minmax(72px,0.8fr) 84px 2fr";

// JSON Schema 的 type 描述：处理 array<item> / 联合 type / enum / object。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function describeSchemaType(schema: any): string {
  if (!schema || typeof schema !== "object") return "any";
  if (Array.isArray(schema.enum)) return `enum(${schema.enum.length})`;
  const ty = schema.type;
  if (Array.isArray(ty)) return ty.join(" | ");
  if (ty === "array") {
    const item = schema.items ? describeSchemaType(schema.items) : "any";
    return `array<${item}>`;
  }
  if (typeof ty === "string") return ty;
  if (schema.anyOf || schema.oneOf || schema.allOf) return "union";
  return schema.properties ? "object" : "any";
}

// 从 input_schema.properties 派生参数行；保留 schema 内的物理顺序（不重排）。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractToolParams(inputSchema: any): ToolParamRow[] {
  if (!inputSchema || typeof inputSchema !== "object") return [];
  const props = inputSchema.properties;
  if (!props || typeof props !== "object") return [];
  const required: string[] = Array.isArray(inputSchema.required) ? inputSchema.required : [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Object.entries(props as Record<string, any>).map(([name, sch]) => ({
    name,
    type: describeSchemaType(sch),
    required: required.includes(name),
    description: typeof sch?.description === "string" ? sch.description.trim() : undefined,
  }));
}

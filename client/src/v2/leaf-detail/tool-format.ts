// 共享：tool 定义解析 + tool 详情用的样式常量。
//
// 从 AttributionTreePanel 抽出，供 leaf-detail/ToolDefinitionBody 复用。放这里而非 panel，
// 是为了让 body 组件不用反向 import panel 的值（否则 panel → body → panel 成循环依赖）。
// 纯逻辑 + 常量，无 React 渲染、无 panel 依赖；panel 自身仍可单向 import 本文件。
import type { CSSProperties } from "react";
import type { DynamicField } from "../attribution-tree-types";

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

// 私有边界标记（Unicode Private Use Area）：插入 JSON 字符串值内部仍是合法 JSON，且内容
// 几乎不可能自然含 PUA 字符。仅用于「在 rawText 标位置 → JSON.parse 搬运 → 提取后剥离」，
// 不进入 markdown 渲染。
const REL_OPEN = "\uE000";
const REL_CLOSE = "\uE001";

/**
 * 把 dynamicField 坐标从「完整 tool JSON(rawText)」搬运到「parse 后的 description 子串」。
 *
 * 思路（借 JSON.parse 做精确转义处理，不手写坐标映射，也不靠 valuePreview 文本匹配猜歧义）：
 *   1. 在 rawText 的每个 field [charStart,charEnd) 两端插入私有边界标记（不破坏 JSON）；
 *   2. JSON.parse 后取 description —— 标记被一起搬运到去转义后的精确位置；
 *   3. 扫描带标记 description，按出现顺序对应字段、提取相对 description 的局部坐标，并剥离标记。
 * 返回 { description(干净), fields(坐标相对 description) }，交给 position 高亮。
 * 字段在 description 出现多次也精确（标记插在规则指定的那一次，不是 indexOf 第一个）。
 * 注入破坏 JSON（标记恰落在转义序列中间）或无字段 → 返回 null，调用方回退为不高亮。
 */
export function relocateFieldsToDescription(
  rawText: string,
  fields: DynamicField[] | undefined,
): { description: string; fields: DynamicField[] } | null {
  if (!fields || fields.length === 0) return null;
  const valid = fields
    .filter((f) => f.charStart >= 0 && f.charEnd <= rawText.length && f.charStart < f.charEnd)
    .sort((a, b) => a.charStart - b.charStart);
  if (valid.length === 0) return null;

  // 降序插入标记，避免前面的插入移动后面的 offset。
  let marked = rawText;
  for (let k = valid.length - 1; k >= 0; k--) {
    const f = valid[k];
    marked = marked.slice(0, f.charEnd) + REL_CLOSE + marked.slice(f.charEnd);
    marked = marked.slice(0, f.charStart) + REL_OPEN + marked.slice(f.charStart);
  }

  let markedDesc: string;
  try {
    const obj = JSON.parse(marked);
    if (!obj || typeof obj !== "object" || typeof (obj as Record<string, unknown>).description !== "string") return null;
    markedDesc = (obj as Record<string, string>).description;
  } catch {
    return null;
  }

  // 扫描：OPEN 记起点、CLOSE 配对生成局部坐标；其余字符进 clean。cleanLen 按 UTF-16 code unit
  // 计（与 remark position.offset 同坐标系）。valid 已按 charStart 升序，标记出现顺序与之一致。
  const parts: string[] = [];
  const out: DynamicField[] = [];
  let cleanLen = 0;
  let pendingStart = -1;
  let vi = 0;
  for (const ch of markedDesc) {
    if (ch === REL_OPEN) { pendingStart = cleanLen; continue; }
    if (ch === REL_CLOSE) {
      if (pendingStart >= 0 && vi < valid.length) {
        out.push({ ...valid[vi], charStart: pendingStart, charEnd: cleanLen, charCount: cleanLen - pendingStart });
      }
      pendingStart = -1;
      vi++;
      continue;
    }
    parts.push(ch);
    cleanLen += ch.length;
  }
  if (out.length === 0) return null;
  return { description: parts.join(""), fields: out };
}

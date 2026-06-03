// 基础组件：MD 渲染 + 动态字段黄底高亮。
//
// 这是"内容型" leaf 的默认 body —— CLAUDE.md / 全局指令 / 记忆 / 账号 / 系统提示词 / 动态注入
// 等都复用它（统一头 SelectedDetailHeader 在下方各 detail 组件里接）。从 AttributionTreePanel
// 抽出独立成基础组件：便于复用，也便于单独改高亮样式而不动 dispatcher。
//
// 高亮机制（position-based）：dynamicField 的 charStart/charEnd 是相对「渲染文本」的字符区间。
// 渲染后遍历 hast 文本节点，用节点自带的 source position(offset) 与字段区间求交，把相交的
// 文本片段包成黄底 <span>。不往内容里注入任何标记 —— 信号与数据分离，markdown 解析不被污染，
// 跨节点的字段(整段 markdown，如 MEMORY.md)也能各节点高亮自己那段，永不泄漏标记乱码。
// 取代了旧的「注入 DYNSTART 哨兵字符串 + 单节点 regex 配对」机制(哨兵会被 markdown 解析拆散)。
import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import i18n from "../../i18n";
import type { DynamicField } from "../attribution-tree-types";

interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  // remark→rehype 管线保留的源字符偏移；纯空白(\n)节点可能无 position，按缺失处理。
  position?: { start?: { offset?: number }; end?: { offset?: number } };
}

const HIGHLIGHT_STYLE = {
  background: "#fef3c7",
  color: "#92400e",
  borderRadius: 2,
  padding: "0 2px",
  boxShadow: "inset 0 -1px 0 #fcd34d",
};

function highlightTitle(field: DynamicField | undefined): string {
  return field
    ? `${field.name} · ${field.source} · ${i18n.t("attribution.stability.runtimeDynamicValue")}`
    : i18n.t("attribution.stability.runtimeDynamicValue");
}

function makeHighlightSpan(text: string, field: DynamicField | undefined): HastNode {
  return {
    type: "element",
    tagName: "span",
    properties: { style: HIGHLIGHT_STYLE, title: highlightTitle(field) },
    children: [{ type: "text", value: text }],
  };
}

/**
 * 把单个文本节点按「与各 dynamicField 区间的交集」切成 [文本, 高亮span, 文本…]。
 * 无交集返回 null（不动该节点）。
 *  - node.position.offset 给出本节点在源文本里的字符区间 [ns, ne)。
 *  - 仅当源区间长度 === node.value 长度时，offset 与 value 逐字符对应，按局部坐标精确切片；
 *    否则(节点含 markdown 语法符号/转义实体，如 inline code 的反引号)整节点高亮降级 ——
 *    宁可整段标黄，也不按错位 offset 切出错误片段(绝不泄漏、绝不错位到别处)。
 */
function splitTextNodeByFields(node: HastNode, fields: DynamicField[]): HastNode[] | null {
  const ns = node.position?.start?.offset;
  const ne = node.position?.end?.offset;
  if (typeof ns !== "number" || typeof ne !== "number") return null;
  const value = node.value ?? "";

  const hits: { idx: number; ls: number; le: number }[] = [];
  for (let i = 0; i < fields.length; i++) {
    const s = Math.max(ns, fields[i].charStart);
    const e = Math.min(ne, fields[i].charEnd);
    if (s < e) hits.push({ idx: i, ls: s - ns, le: e - ns });
  }
  if (hits.length === 0) return null;

  // 含语法符号/实体的节点：offset 与 value 不逐字符对应 → 整节点高亮（降级，不错位）。
  if (ne - ns !== value.length) {
    return [makeHighlightSpan(value, fields[hits[0].idx])];
  }

  hits.sort((a, b) => a.ls - b.ls);
  const out: HastNode[] = [];
  let cur = 0;
  for (const h of hits) {
    const ls = Math.max(cur, Math.min(value.length, h.ls));
    const le = Math.max(ls, Math.min(value.length, h.le));
    if (ls > cur) out.push({ type: "text", value: value.slice(cur, ls) });
    if (le > ls) out.push(makeHighlightSpan(value.slice(ls, le), fields[h.idx]));
    cur = le;
  }
  if (cur < value.length) out.push({ type: "text", value: value.slice(cur) });
  return out;
}

/** rehype 插件：遍历 hast，按 source position 把 dynamicField 区间高亮成黄底 span。 */
function rehypeHighlightByPosition(fields: DynamicField[]) {
  return () => {
    return (tree: HastNode) => {
      const visit = (node: HastNode) => {
        if (!node.children) return;
        // 逆序遍历：把某 text 节点替换成多节点时，splice 不影响前面未访问的 index。
        for (let i = node.children.length - 1; i >= 0; i--) {
          const child = node.children[i];
          if (child.type === "text") {
            const replacement = splitTextNodeByFields(child, fields);
            if (replacement) node.children.splice(i, 1, ...replacement);
          } else {
            visit(child);
          }
        }
      };
      visit(tree);
    };
  };
}

/** MD 渲染 + 动态字段黄底高亮；无动态字段时退化为纯 MD。 */
export function renderMarkdownWithHighlights(
  text: string,
  fields: DynamicField[] | undefined,
): React.ReactNode {
  if (!fields || fields.length === 0) {
    return <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>;
  }
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlightByPosition(fields)]}
    >
      {text}
    </ReactMarkdown>
  );
}

/** 基础卡片：带外壳的高亮 MD。内容型 leaf 的默认 body 直接用它。 */
export function MarkdownHighlightCard({
  text,
  dynamicFields,
}: {
  text: string;
  dynamicFields?: DynamicField[];
}) {
  return (
    <div className="md-prose" style={{
      fontSize: 12, color: "#1f2937",
      border: "1px solid #e5e7eb", borderRadius: 6, background: "#fff",
      padding: "8px 12px",
    }}>
      {renderMarkdownWithHighlights(text, dynamicFields)}
    </div>
  );
}

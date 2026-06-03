// 基础组件：MD 渲染 + 动态字段黄底高亮。
//
// 这是"内容型" leaf 的默认 body —— CLAUDE.md / 全局指令 / 记忆 / 账号 / 系统提示词 / 动态注入
// 等都复用它（统一头 SelectedDetailHeader 在下方各 detail 组件里接）。从 AttributionTreePanel
// 抽出独立成基础组件：便于复用，也便于单独改高亮样式而不动 dispatcher。
//
// 高亮机制：在动态字段(captureGroups)的字符区间两侧注入占位标记 DYNSTART…DYNEND，
// 再用 rehype 插件把占位还原成黄底 <span>（在 hover 上给出 字段名·来源·"运行时动态值"）。
import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import i18n from "../../i18n";
import type { DynamicField } from "../attribution-tree-types";

function injectDynamicPlaceholders(text: string, fields: DynamicField[]): string {
  if (!fields || fields.length === 0) return text;

  const validFields = fields
    .map((f, index) => ({ ...f, originalIndex: index }))
    .filter((f) => f.charStart >= 0 && f.charEnd <= text.length && f.charStart < f.charEnd)
    .sort((a, b) => b.charStart - a.charStart);

  let result = text;
  validFields.forEach((f) => {
    const before = result.substring(0, f.charStart);
    const value = result.substring(f.charStart, f.charEnd);
    const after = result.substring(f.charEnd);
    result = `${before}DYNSTARTa${f.originalIndex}a${value}DYNEND${after}`;
  });

  return result;
}

interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

function rehypeHighlightDynamicFields(fields: DynamicField[]) {
  return () => {
    return (tree: HastNode) => {
      function visit(node: HastNode) {
        if (node.type === "text" && typeof node.value === "string") {
          const text = node.value;
          const regex = /DYNSTARTa(\d+)a([\s\S]*?)DYNEND/g;

          if (regex.test(text)) {
            regex.lastIndex = 0;
            const children: HastNode[] = [];
            let lastIndex = 0;
            let match;
            while ((match = regex.exec(text)) !== null) {
              const matchIndex = match.index;
              if (matchIndex > lastIndex) {
                children.push({ type: "text", value: text.substring(lastIndex, matchIndex) });
              }
              const fieldIdx = parseInt(match[1], 10);
              const val = match[2];
              const field = fields[fieldIdx];

              children.push({
                type: "element",
                tagName: "span",
                properties: {
                  style: {
                    background: "#fef3c7",
                    color: "#92400e",
                    borderRadius: 2,
                    padding: "0 2px",
                    boxShadow: "inset 0 -1px 0 #fcd34d",
                  },
                  title: field ? `${field.name} · ${field.source} · ${i18n.t("attribution.stability.runtimeDynamicValue")}` : i18n.t("attribution.stability.runtimeDynamicValue"),
                },
                children: [{ type: "text", value: val }],
              });
              lastIndex = regex.lastIndex;
            }
            if (lastIndex < text.length) {
              children.push({ type: "text", value: text.substring(lastIndex) });
            }

            node.type = "element";
            node.tagName = "span";
            node.properties = {};
            node.children = children;
          }
        } else if (node.children) {
          node.children.forEach(visit);
        }
      }
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

  const textWithPlaceholders = injectDynamicPlaceholders(text, fields);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlightDynamicFields(fields)]}
    >
      {textWithPlaceholders}
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

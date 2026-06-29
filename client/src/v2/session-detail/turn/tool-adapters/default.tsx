// Default tool-use adapter —— 没有专属 adapter 的 tool 走这里（Read / Write /
// Grep / Edit / Bash …）。等价于重构前 ToolCallRow 的通用渲染：description 抽取
// + INPUT segment（Bash 命令特化 + 其余剥掉 description 的 JSON）。

import type { ToolCallSlot } from "../../../drilldown-types";
import type { EventSegment } from "../../../shared/EventUnitCard";
import type { ToolUseRender, ToolUseCtx } from "./types";

/** tool_use 的人类意图标签：优先 description，否则退到常见标量字段。 */
export function extractDescription(inputPreview: string): string | undefined {
  if (!inputPreview) return undefined;
  try {
    const obj = JSON.parse(inputPreview) as Record<string, unknown>;
    if (typeof obj.description === "string" && obj.description.trim()) {
      return obj.description.trim();
    }
    for (const key of ["command", "file_path", "pattern", "query", "prompt", "url"]) {
      const v = obj[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  } catch { /* inputPreview may be truncated/non-JSON — no subtitle */ }
  return undefined;
}

/** 通用 INPUT segment：Bash 直接展示 command；其余剥掉 description 后展示 JSON。 */
export function genericInputSegments(tc: ToolCallSlot): EventSegment[] {
  if (!tc.inputPreview) return [];
  const parsedInput = (() => {
    try { return JSON.parse(tc.inputPreview); } catch { return undefined; }
  })();
  if (parsedInput && typeof parsedInput === "object") {
    if (tc.name === "Bash" && typeof (parsedInput as Record<string, unknown>).command === "string") {
      return [{
        label: "INPUT",
        content: (parsedInput as Record<string, string>).command,
        monospace: true,
        rawJson: parsedInput,
      }];
    }
    const strippedInput = { ...(parsedInput as Record<string, unknown>) };
    delete strippedInput.description;
    return [{
      label: "INPUT",
      content: Object.keys(strippedInput).length > 0 ? JSON.stringify(strippedInput, null, 2) : "",
      monospace: true,
      rawJson: parsedInput,
    }];
  }
  return [{
    label: "INPUT",
    content: tc.inputPreview,
    monospace: true,
    truncateAt: 600,
  }];
}

export function defaultToolUse(tc: ToolCallSlot, _ctx: ToolUseCtx): ToolUseRender {
  const description = extractDescription(tc.inputPreview);
  return { preview: description, description, segments: genericInputSegments(tc) };
}

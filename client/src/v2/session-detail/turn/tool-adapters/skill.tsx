// Skill tool-use adapter —— Skill 工具的结构化参数渲染。input schema 被 cli.js
// 固定为 { skill: string, args?: string }（SkillTool.ts zod schema），所以解析
// 永远安全；失败时回退到通用渲染。

import type { ToolCallSlot } from "../../../drilldown-types";
import type { ToolUseRender, ToolUseCtx } from "./types";
import { defaultToolUse } from "./default";

export function skillUse(tc: ToolCallSlot, ctx: ToolUseCtx): ToolUseRender {
  const { t } = ctx;
  try {
    const obj = JSON.parse(tc.inputPreview) as { skill?: string; args?: string };
    if (typeof obj.skill !== "string") return defaultToolUse(tc, ctx);
    let content = t("skillInvocation.requestLoad", { skill: obj.skill });
    if (typeof obj.args === "string" && obj.args.length > 0) {
      content += "\n" + t("skillInvocation.argsLabel", { args: obj.args });
    }
    const preview = t("skillInvocation.requestLoad", { skill: obj.skill });
    return {
      preview,
      description: preview,
      segments: [{ label: "INPUT", content, monospace: false, rawJson: obj }],
    };
  } catch {
    return defaultToolUse(tc, ctx);
  }
}

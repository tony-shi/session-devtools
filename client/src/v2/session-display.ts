import type { SessionV2 } from "./types";

function isCommandText(value: string): boolean {
  const text = value.trimStart();
  return text.startsWith("<command-name>") || text.startsWith("<local-command-caveat>");
}

export function cleanSessionText(value: string | null | undefined, maxLength = 96): string | null {
  if (!value) return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || isCommandText(text)) return null;
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 3))}...` : text;
}

// 大标题：custom_title > ai_title > session_id（完整）
// overrideTitle: drilldown 实时解析的 title，优先级同 ai_title（在 custom_title 之后）
export function getSessionTitle(session: SessionV2, overrideTitle?: string | null): string {
  return cleanSessionText(session.custom_title)
    ?? cleanSessionText(overrideTitle)
    ?? cleanSessionText(session.ai_title)
    ?? session.session_id;
}

// 副标题：recap(away_summary) > 用户第一条有效输入
export function getSessionSubtitle(session: SessionV2): string | null {
  return cleanSessionText(session.away_summary, 200)
    ?? cleanSessionText(session.first_user_message, 200);
}

// 保留旧名称作为别名，避免破坏其他调用处
export const getSessionDisplayName = getSessionTitle;
export const getSessionSummary = getSessionSubtitle;

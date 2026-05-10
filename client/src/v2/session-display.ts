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

function leaf(path: string | null | undefined): string | null {
  if (!path) return null;
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

export function getSessionDisplayName(session: SessionV2, overrideTitle?: string | null): string {
  return cleanSessionText(overrideTitle)
    ?? cleanSessionText(session.custom_title)
    ?? cleanSessionText(session.ai_title)
    ?? cleanSessionText(session.first_user_message)
    ?? cleanSessionText(session.project)
    ?? cleanSessionText(leaf(session.cwd))
    ?? session.session_id.slice(0, 16);
}

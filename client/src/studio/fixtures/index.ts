// Fixtures 语言选择器 —— 屏幕上的对话 / 调用链素材按语言取。
//   zh: 手工本地化版(session 5e7476cd)
//   en: 自动 dump 自真实英文 session 9e1ba147(scripts/voice/dump-fixture.ts --lang en)
// 上层(AgentLoopStory / Root / RecapScene)只调 getXxxFixture(lang),不直接 import 某语言文件。

import type { SceneTurn } from "../scenes/timeline";
import { conversationFixture as convZh } from "./conversation.zh";
import { conversationFixture as convEn } from "./conversation.en";
import { turnFixture as turnZh } from "./turn.zh";
import { turnFixture as turnEn } from "./turn.en";

export type { LoopTurn, LoopCall, LoopToolCall } from "./turn.zh";

export function getConversationFixture(lang: string): SceneTurn[] {
  return lang === "en" ? convEn : convZh;
}

export function getTurnFixture(lang: string) {
  return lang === "en" ? turnEn : turnZh;
}

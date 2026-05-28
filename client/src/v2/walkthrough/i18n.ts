// Walkthrough 双语脚手架。设计原则:
//   - 增量 / 可选 —— 现有 story / view 都不必改;只往 step 上加 `linesEn`、往 story 上加 `titleEn`,
//     视图侧用 `bi("中文","english")` 内联打英文,缺哪句就回退到中文。
//   - 单一开关 —— DemoStage 顶角 [中 / EN] 切换,落库 localStorage。
//   - 不引依赖 —— 不上 i18next 之类的库,关键路径只是一句"挑那个字段"。
//
// 用法速记:
//   1) 在 step 上加 `linesEn: ["...", "..."]`(顺序与 lines 一一对应,缺位项自动 fallback)。
//   2) 在 story 上加 `titleEn: "..."`(可选)。
//   3) 视图侧:`const { t } = useT(); t(bi("用户输入", "User input"))`,en 缺省时仍显示中文。

import { createContext, useContext } from "react";
import type { Step, Story } from "./types";

export type Lang = "zh" | "en";

export const LangCtx = createContext<Lang>("zh");
export const useLang = (): Lang => useContext(LangCtx);

const LANG_KEY = "wt:lang";

export function loadLang(): Lang {
  if (typeof window === "undefined") return "zh";
  const v = window.localStorage.getItem(LANG_KEY);
  return v === "en" ? "en" : "zh";
}

export function saveLang(lang: Lang): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LANG_KEY, lang);
}

// 二元串:{ zh, en? } —— en 缺省时回退到 zh。允许直接传字符串(视作只有 zh)。
export type Bi = { zh: string; en?: string };
export type BiLike = Bi | string;

export function toBi(v: BiLike): Bi {
  return typeof v === "string" ? { zh: v } : v;
}

export function pickBi(v: BiLike, lang: Lang): string {
  const b = toBi(v);
  if (lang === "en" && b.en) return b.en;
  return b.zh;
}

// 内联简写:`bi("中文", "english")` —— en 可省。
export function bi(zh: string, en?: string): Bi {
  return { zh, en };
}

// 视图侧 hook:返回当前 lang 与一个解析器 t() —— 把 Bi 渲染成最终字符串。
export function useT(): { lang: Lang; t: (v: BiLike) => string } {
  const lang = useLang();
  return { lang, t: (v) => pickBi(v, lang) };
}

// 故事数据侧解析器 —— 字幕逐句 fallback,英文缺位不会丢句。
export function pickLines(step: Step, lang: Lang): string[] {
  if (lang !== "en" || !step.linesEn) return step.lines;
  return step.lines.map((zh, i) => step.linesEn?.[i] ?? zh);
}

export function pickTitle(story: Story, lang: Lang): string {
  if (lang === "en" && story.titleEn) return story.titleEn;
  return story.title;
}

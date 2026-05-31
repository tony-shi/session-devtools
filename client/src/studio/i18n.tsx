// Studio i18n —— Remotion 合成层的语言字典 + Context。
// 设计:scenes 深层嵌套很多子组件,逐层透传 lang 太碎,改用 React Context:
//   AgentLoopStory 顶层 <LangProvider value={lang}>,任意子组件 useT() 拿当前语言字典。
// 原则:React UI 不含中文逻辑 —— 所有屏幕文案都从这里按 lang 取,组件零硬编中文。

import { createContext, useContext, type ReactNode } from "react";

export type Lang = "zh" | "en";

export interface StudioStrings {
  // —— AgentLoopScene ——
  toolVerb: Record<string, string>;
  toolVerbFallback: string;
  moreLines: (n: number) => string;
  rail: Record<string, string[]>;
  railExit: string[];
  loopProgress: string;
  alActorUser: string;
  alTaskLabel: string;
  alLlmLabel: string;
  alDeciding: string;
  alResultLabel: string;
  alFlowRun: string;
  alEmpty: string;
  alFinalLabel: (calls: number) => string;
  alNoFinalText: string;
  ctxPrompt: string;
  ctxUserInput: string;
  ctxTitle: string;
  ctxPending: string;
  ctxPromptNote: string;
  ctxLatestResult: string;
  flowAssemble: string;
  flowStuffBack: string;
  // —— RecapScene ——
  recapTitle: string;
  sessionSub: string;
  zoomIn: string;
  edgeYes: string;
  edgeAgentRun: string;
  edgeExit: string;
  edgeLoop: string;
  boxCallSub: string;
  boxUseSub: string;
  boxResultSub: string;
  boxFinalSub: string;
  diamond: { a: string; b: string };
  pseudoIntro: string;
  pseudoLines: { code: string; comment?: string }[];
  twoEngines: { pre: string; model: string; mid: string; tool: string; post: string };
  // —— ConversationScene ——
  convUser: string;
  turnBadge: (id: number) => string;
  llmCalls: (n: number) => string;
  claudeThinking: string;
  // —— NextChapterScene ——
  nextKicker: string;
  nextTitle: string;
  nextFooter: string;
}

const ZH: StudioStrings = {
  toolVerb: { Bash: "执行命令", Read: "读取文件", Grep: "搜索代码", Glob: "匹配文件", Edit: "修改文件", Write: "写入文件", Task: "派生子 Agent", WebFetch: "抓取网页" },
  toolVerbFallback: "调用工具",
  moreLines: (n) => `… (+${n} 行)`,
  rail: {
    "call": ["① 组装 context", "系统 · 记忆 · 规则 · 历史 · 工具定义", "再填入本轮要解决的问题"],
    "tool-use": ["② 模型不直接回答", "提出 tool_use:一个动作请求", "读文件 / 搜代码 / 跑命令"],
    "tool-result": ["③ 执行 → tool_result", "拿到真实结果,不靠幻想", "结果进入下一次 Call 的 context"],
    "loop": ["④ tool_result 塞回 context", "触发下一次 LLM Call", "context 越滚越大,理解越完整", "—— 这就是 Agent Loop"],
  },
  railExit: ["⑤ 信息已足够", "模型不再 tool_use", "跳出循环 → 最终回答", "Turn 到此结束"],
  loopProgress: "循环进度",
  alActorUser: "用户",
  alTaskLabel: "用户输入 · 本轮任务",
  alLlmLabel: "LLM 调用结果",
  alDeciding: "模型在判断该做什么…",
  alResultLabel: "Agent 执行结果 · tool_result",
  alFlowRun: "执行",
  alEmpty: "(空)",
  alFinalLabel: (calls) => `Final · 最终回答 · 本轮 ${calls} 次 LLM 调用`,
  alNoFinalText: "(无最终文本)",
  ctxPrompt: "提示词",
  ctxUserInput: "用户输入",
  ctxTitle: "Context · 发给模型的",
  ctxPending: "待填入",
  ctxPromptNote: "提示词 = 系统 · 记忆 · 规则 · 历史 · 工具定义(各种 agent 注入)",
  ctxLatestResult: "最新 tool_result:",
  flowAssemble: "组装",
  flowStuffBack: "塞回",
  recapTitle: "回顾 · 把它串成一个 while 循环",
  sessionSub: "一次完整会话,组织起多个 Turn",
  zoomIn: "↓ 放大",
  edgeYes: "要",
  edgeAgentRun: "Agent 执行",
  edgeExit: "不要 → 退出",
  edgeLoop: "循环 · 塞回 context",
  boxCallSub: "一次带 context 的模型决策",
  boxUseSub: "模型想做什么",
  boxResultSub: "现实返回的证据",
  boxFinalSub: "不再 tool_use,Turn 结束",
  diamond: { a: "还要", b: "tool_use?" },
  pseudoIntro: "同一个东西,写成代码就是:",
  pseudoLines: [
    { code: "while 模型还要 tool_use:" },
    { code: "tool_use", comment: "模型想做什么" },
    { code: "tool_result", comment: "塞回 context,绕回循环" },
    { code: "# 信息足够 → 跳出循环" },
    { code: "final answer", comment: "Turn 结束" },
  ],
  twoEngines: { pre: "驱动它的只有两件事:", model: "模型", mid: "负责推理,", tool: "工具", post: "负责行动。" },
  convUser: "用户",
  turnBadge: (id) => `Turn ${id} · 轮次`,
  llmCalls: (n) => `${n} 次 LLM 调用`,
  claudeThinking: "Claude 思考中",
  nextKicker: "下一章",
  nextTitle: "深入剖析:context 到底是什么?",
  nextFooter: "提示词 · 用户输入 · 每一轮的 tool_use / tool_result —— 这一整条,到底装了什么?",
};

const EN: StudioStrings = {
  toolVerb: { Bash: "run command", Read: "read file", Grep: "search code", Glob: "match files", Edit: "edit file", Write: "write file", Task: "spawn subagent", WebFetch: "fetch web" },
  toolVerbFallback: "call tool",
  moreLines: (n) => `… (+${n} lines)`,
  rail: {
    "call": ["① Assemble context", "system · memory · rules · history · tool defs", "then add this turn's problem"],
    "tool-use": ["② The model doesn't answer directly", "it emits tool_use: an action request", "read a file / search code / run a command"],
    "tool-result": ["③ Execute → tool_result", "real results, not guesses", "the result enters the next Call's context"],
    "loop": ["④ tool_result goes back into context", "triggers the next LLM Call", "context grows, understanding deepens", "—— that's the Agent Loop"],
  },
  railExit: ["⑤ Enough information", "the model stops calling tools", "break the loop → final answer", "the turn ends here"],
  loopProgress: "Loop progress",
  alActorUser: "User",
  alTaskLabel: "User input · this turn's task",
  alLlmLabel: "LLM response",
  alDeciding: "The model is deciding what to do…",
  alResultLabel: "Agent result · tool_result",
  alFlowRun: "run",
  alEmpty: "(empty)",
  alFinalLabel: (calls) => `Final · answer · ${calls} LLM call${calls === 1 ? "" : "s"} this turn`,
  alNoFinalText: "(no final text)",
  ctxPrompt: "Prompt",
  ctxUserInput: "User input",
  ctxTitle: "Context · sent to the model",
  ctxPending: "pending",
  ctxPromptNote: "Prompt = system · memory · rules · history · tool defs (various agent injections)",
  ctxLatestResult: "Latest tool_result:",
  flowAssemble: "assemble",
  flowStuffBack: "put back",
  recapTitle: "Recap · as a while loop",
  sessionSub: "one full session, organizing many Turns",
  zoomIn: "↓ zoom in",
  edgeYes: "yes",
  edgeAgentRun: "Agent runs it",
  edgeExit: "no → exit",
  edgeLoop: "loop · back into context",
  boxCallSub: "one model decision with context",
  boxUseSub: "what the model wants to do",
  boxResultSub: "evidence from the real world",
  boxFinalSub: "no more tool_use, turn ends",
  diamond: { a: "still need", b: "tool_use?" },
  pseudoIntro: "The same thing, written as code:",
  pseudoLines: [
    { code: "while model still wants tool_use:" },
    { code: "tool_use", comment: "what the model wants" },
    { code: "tool_result", comment: "back into context" },
    { code: "# enough info → break the loop" },
    { code: "final answer", comment: "turn ends" },
  ],
  twoEngines: { pre: "Only two things drive it: the ", model: "model", mid: " reasons, the ", tool: "tools", post: " act." },
  convUser: "User",
  turnBadge: (id) => `Turn ${id}`,
  llmCalls: (n) => `${n} LLM call${n === 1 ? "" : "s"}`,
  claudeThinking: "Claude is thinking",
  nextKicker: "Next chapter",
  nextTitle: "A closer look: what exactly is context?",
  nextFooter: "Prompt · user input · each round's tool_use / tool_result — what's really inside this whole thing?",
};

const STRINGS: Record<Lang, StudioStrings> = { zh: ZH, en: EN };

const LangContext = createContext<Lang>("zh");

export function LangProvider({ lang, children }: { lang: string; children: ReactNode }) {
  const v: Lang = lang === "en" ? "en" : "zh";
  return <LangContext.Provider value={v}>{children}</LangContext.Provider>;
}

export function useLang(): Lang {
  return useContext(LangContext);
}

export function useT(): StudioStrings {
  return STRINGS[useContext(LangContext)];
}

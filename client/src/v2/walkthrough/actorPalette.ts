// Walkthrough 统一演员配色 —— 贯穿 conversation / loop / recap,保证「同一角色 = 同一颜色」。
//   user  人类输入                         → 暖灰
//   llm   模型(产出 tool_use + 最终回答)→ 赤陶(Anthropic 品牌色)
//   agent 执行工具(产出 tool_result)     → 雾绿
//   done  循环收束 / Turn 终止             → 森林绿
// 色温:暖调、低饱和度,呼应 Anthropic 报纸调,远离 Tailwind 工程师默认冷调。
export const ACTOR_COLOR = {
  user: { main: "#6B6964", bg: "#F5F4F1", border: "#E5E2DC" },
  llm: { main: "#D97757", bg: "#FBEFE9", border: "#F5D7C7" },
  agent: { main: "#4A9B8E", bg: "#ECF5F2", border: "#C9E2D9" },
  done: { main: "#558A42", bg: "#EEF4E7", border: "#CFE0BD" },
} as const;

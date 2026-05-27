// Walkthrough 统一演员配色 —— 贯穿 conversation / loop / recap,保证「同一角色 = 同一颜色」。
//   user  人类输入                         → slate
//   llm   模型(产出 tool_use + 最终回答)→ 靛蓝
//   agent 执行工具(产出 tool_result)     → teal
//   done  循环收束 / Turn 终止             → 绿
// 颜色故事:靛蓝 = 模型侧,teal = 现实/工具侧,绿 = 收束。切幕时颜色记忆不被打乱。
export const ACTOR_COLOR = {
  user: { main: "#64748b", bg: "#f1f5f9", border: "#e2e8f0" },
  llm: { main: "#6366f1", bg: "#eef2ff", border: "#e0e7ff" },
  agent: { main: "#0f766e", bg: "#f0fdfa", border: "#ccfbf1" },
  done: { main: "#16a34a", bg: "#f0fdf4", border: "#bbf7d0" },
} as const;

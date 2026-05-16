// derived：从节点 origin 派生出的"产品化"分类字段。
//
// 这些字段**没有任何独立信息** —— 全部能从 origin 子结构推出来。但把推导集中
// 在一个 helper 里、由 serializer 一次写入 SerializedNode，有两个好处：
//   1. **前端不重复推导**。多个 panel / lens 都需要"这片内容是谁写的"，
//      如果各自手算 (origin.kind === "jsonl" && eventKind.source === "user_input")
//      的判定，口径会迅速漂移。后端算一次、序列化、前端只读。
//   2. **未来扩 origin 子结构时单点改动**。新增 mechanism 或 source 值时，只动
//      authorshipOf 一个函数，前端配色表 fallback 灰自然兜底。
//
// 与 coverageStateOf 同等地位 —— 都是 origin → 产品化标签的纯函数。

import type { SegmentOrigin } from "./origin";

/**
 * Authorship：节点内容的"作者身份"。
 *
 * 这是 origin 多维信息在"谁写的"这一轴上的投影。前端 Origin lens 的默认配色键。
 *
 *   - "human"          人类输入。jsonl.user_input。
 *   - "assistant"      模型输出。jsonl.assistant_text / thinking / tool_use（tool 调用
 *                      由 LLM 生成）。
 *   - "tool_protocol"  工具执行结果。jsonl.tool_result —— harness 执行了 tool，
 *                      内容来自 tool 自身。
 *   - "harness"        Claude Code 主动合成。包括两类：
 *                        (a) rule origin —— Claude Code CLI 启动时拼装的静态/动态 prompt
 *                        (b) jsonl.harness_injection（Skill / compaction summary）
 *                            + jsonl.system_local_command / stop_hook / away_summary
 *                            + jsonl.attachment（CLI 注入的 task_reminder 等）
 *   - "unattributed"   structural / unknown —— 节点存在但无解释。
 */
export type Authorship =
  | "human"
  | "assistant"
  | "tool_protocol"
  | "harness"
  | "unattributed";

export function authorshipOf(origin: SegmentOrigin): Authorship {
  if (origin.kind === "jsonl") {
    switch (origin.eventKind.source) {
      case "user_input":
        return "human";
      case "assistant_text":
      case "thinking":
      case "tool_use":
        // tool_use 由 LLM 在 response 中生成 —— authorship 归 assistant
        return "assistant";
      case "tool_result":
        // tool_result 的 content 来自 tool 自身的执行输出，harness 只是搬运
        return "tool_protocol";
      case "harness_injection":
      case "system_local_command":
      case "stop_hook":
      case "away_summary":
      case "attachment":
        return "harness";
      case "unknown":
        return "unattributed";
      default:
        return "unattributed";
    }
  }
  if (origin.kind === "rule") {
    // rule origin：Claude Code CLI 拼装的 prompt 段（system intro / tone-style /
    // tools 描述 / billing-noise 等）。authorship=harness。
    return "harness";
  }
  // structural / unknown：未解释 → unattributed
  return "unattributed";
}

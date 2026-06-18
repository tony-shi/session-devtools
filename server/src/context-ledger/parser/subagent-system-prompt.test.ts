// workflow / Task subagent 归因规则的真值契约测试（I 项，05 文档）。
//
// fixture 是 2026-06 真实 proxy 请求快照（来源见各规则 sourcemapRef）：
//   - WF_SYS2: bd5d3dd7 workflow agent 的 sys[2] 全文（2.1.167，含动态 env 尾）
//   - SO_DESC: StructuredOutput 工具 description（session-static）
//   - TASK_SYS: d24ba398 general-purpose Task agent 的 sys[2] 全文
// 验证：喂进真实归因管线后命中新规则而非落 unknown（此前 workflow agent 请求
// 的 sys[2] 整段产 unknown 段——这正是规则补齐要消除的）。
// 防过拟合：前缀/desc 的跨请求一致性已在提取阶段对 ≥2 条真实请求验证。

import { describe, it, expect } from "vitest";
import { attributeWithJsonl } from "./index.ts";
import type { SegmentNode } from "./types.ts";
import { withBillingHeader } from "./attribution/test-fixtures.ts";

const WF_SYS2 = "You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.\n\nCRITICAL: You MUST call the StructuredOutput tool exactly once to return your final answer. The tool's input schema defines the required shape.\n- Do your work (Read files, run commands, etc.), then call StructuredOutput with your answer.\n- Do NOT put your answer in a text response. The script reads ONLY the StructuredOutput tool call.\n- If the schema validation fails, read the error and call StructuredOutput again with a corrected shape.\n- After calling StructuredOutput successfully, end your turn. No acknowledgment needed.\n\nNotes:\n- Agent threads always have their cwd reset between bash calls, as a result please only use absolute file paths.\n- In your final response, share file paths (always absolute, never relative) that are relevant to the task. Include code snippets only when the exact text is load-bearing (e.g., a bug you found, a function signature the caller asked for) \u2014 do not recap code you merely read.\n- For clear communication with the user the assistant MUST avoid using emojis.\n- Do not use a colon before tool calls. Text like \"Let me read the file:\" followed by a read tool call should just be \"Let me read the file.\" with a period.\n- Do NOT Write report/summary/findings/analysis .md files. Return findings directly as your final assistant message \u2014 the parent agent reads your text output, not files you create.\n\nHere is useful information about the environment you are running in:\n<env>\nWorking directory: /Users/shihuashen/Documents/session-dashboard\nIs directory a git repo: Yes\nPlatform: darwin\nShell: zsh\nOS Version: Darwin 25.5.0\n</env>\nYou are powered by the model named Opus 4.8 (1M context). The exact model ID is claude-opus-4-8[1m].\n\nAssistant knowledge cutoff is January 2026.\n\ngitStatus: This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.\n\nCurrent branch: main\n\nMain branch (you will usually use this for PRs): main\n\nGit user: tony-shi\n\nStatus:\nM CHANGELOG.md\n\nRecent commits:\n88095c7 chore(release): 0.1.0-alpha.8\n71b2964 feat: render user input leaf as unified card; update changelog\nae69fa1 feat: several ui refine\n13b6d9f feat: ui refine\n998495e feat: add controlled focus props to AttributionTreeLensPanel";

const SO_DESC = "Use this tool to return your final response in the requested structured format. You MUST call this tool exactly once at the end of your response to provide the structured output.";

const TASK_SYS = "You are an agent for Claude Code, Anthropic's official CLI for Claude. Given the user's message, you should use the tools available to complete the task. Complete the task fully\u2014don't gold-plate, but don't leave it half-done. When you complete the task, respond with a concise report covering what was done and any key findings \u2014 the caller will relay this to the user, so it only needs the essentials.\n\nYour strengths:\n- Searching for code, configurations, and patterns across large codebases\n- Analyzing multiple files to understand system architecture\n- Investigating complex questions that require exploring many files\n- Performing multi-step research tasks\n\nGuidelines:\n- For file searches: search broadly when you don't know where something lives. Use Read when you know the specific file path.\n- For analysis: Start broad and narrow down. Use multiple search strategies if the first doesn't yield results.\n- Be thorough: Check multiple locations, consider different naming conventions, look for related files.\n- NEVER create files unless they're absolutely necessary for achieving your goal. ALWAYS prefer editing an existing file to creating a new one.\n- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested.\n\nNotes:\n- Agent threads always have their cwd reset between bash calls, as a result please only use absolute file paths.\n- In your final response, share file paths (always absolute, never relative) that are relevant to the task. Include code snippets only when the exact text is load-bearing (e.g., a bug you found, a function signature the caller asked for) \u2014 do not recap code you merely read.\n- For clear communication with the user the assistant MUST avoid using emojis.\n- Do not use a colon before tool calls. Text like \"Let me read the file:\" followed by a read tool call should just be \"Let me read the file.\" with a period.\n- Do NOT Write report/summary/findings/analysis .md files. Return findings directly as your final assistant message \u2014 the parent agent reads your text output, not files you create.\n\nHere is useful information about the environment you are running in:\n<env>\nWorking directory: /Users/shihuashen/Documents/session-dashboard/client\nIs directory a git repo: Yes\nPlatform: darwin\nShell: zsh\nOS Version: Darwin 25.5.0\n</env>\nYou are powered by the model named Opus 4.8 (1M context). The exact model ID is claude-opus-4-8[1m].\n\nAssistant knowledge cutoff is January 2026.\n\ngitStatus: This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.\n\nCurrent branch: main\n\nMain branch (you will usually use this for PRs): main\n\nGit user: tony-shi\n\nStatus:\n(clean)\n\nRecent commits:\nae69fa1 feat: several ui refine\n13b6d9f feat: ui refine\n998495e feat: add controlled focus props to AttributionTreeLensPanel\n118c52d feat: add i18n\n425e78e feat: style refine";

function collectRuleIds(nodes: SegmentNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.origin?.kind === "rule") out.push(n.origin.ruleId);
    collectRuleIds(n.children, out);
  }
  return out;
}

function attribute(sys2: string, tools: Array<{ name: string; description: string; input_schema: object }>) {
  const reqBody = withBillingHeader(
    {
      system: [
        { type: "text" as const, text: "You are Claude Code, Anthropic's official CLI for Claude." },
        { type: "text" as const, text: sys2 },
      ],
      tools,
      messages: [{ role: "user", content: [{ type: "text", text: "agent prompt here" }] }],
    },
    "2.1.170.000",
  );
  const { snapshot } = attributeWithJsonl({
    reqBody,
    proxyFile: "synthetic",
    jsonl: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    call: { callId: 0, turnId: 0 } as any,
  });
  return collectRuleIds(snapshot.roots);
}

describe("workflow / Task subagent 归因规则", () => {
  it("workflow agent 的 sys[2] 命中 workflow-subagent 规则（不再 unknown）", () => {
    const ruleIds = attribute(WF_SYS2, [
      { name: "StructuredOutput", description: SO_DESC, input_schema: { type: "object" } },
    ]);
    expect(ruleIds).toContain("claude-code.system-prompt.workflow-subagent.v1");
  });

  it("StructuredOutput 工具描述命中 tool 规则", () => {
    const ruleIds = attribute(WF_SYS2, [
      { name: "StructuredOutput", description: SO_DESC, input_schema: { type: "object" } },
    ]);
    expect(ruleIds).toContain("claude-code.tool.StructuredOutput.v1");
  });

  it("Task general-purpose agent 的 sys[2] 命中 task-agent 规则", () => {
    const ruleIds = attribute(TASK_SYS, [
      { name: "Read", description: "Read a file", input_schema: {} },
    ]);
    expect(ruleIds).toContain("claude-code.system-prompt.task-agent.v1");
  });
});

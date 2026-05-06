// Claude Code 主会话（main_session）模板
// 参考：restored-src/src/utils/api.ts splitSysPromptPrefix + appendSystemContext
//
// 实际 wire 上 system 固定 3 个 block：
//   block[0]  billing header（"x-anthropic-billing-header: ..."）  cache_control=null
//   block[1]  identity（"You are Claude Code, ..."）               cache_control=ephemeral
//   block[2]  rest.join('\n\n')：主提示词 + '\n\n' + systemContext  cache_control=ephemeral
//
// 关键点（来自 appendSystemContext 实现）：
//   systemContext（gitStatus / cacheBreaker 等）通过 Object.entries().map(...).join('\n')
//   拼成一个字符串，再 push 到 systemPrompt 数组末尾，最终被 rest.join('\n\n') 合并进
//   block[2]——不会成为独立的第 4 个 block。
//
// block[2] 内部结构（H1 切分 + 末尾 context 段）：
//   前导段（CLAUDE.md 内容等，H1 之前）
//   # System  ... # Doing tasks  ...（若干 H1 section）
//   \n\ngitStatus: ...\n（systemContext 段，位于所有 H1 section 之后）

import type { RequestTemplate } from "../types";

export const CLAUDE_CODE_MAIN_SESSION_TEMPLATE: RequestTemplate = {
  id: "claude-code-main-session",
  queryKindPredicate: "main_session",
  version: "phase1.v2",
  slots: {
    // ── system ──────────────────────────────────────────────────────────────
    // 顺序敏感：matcher 按数组顺序逐一尝试 anchor；main-prompt-block 是 fallback。
    system: [
      {
        id: "system.billing",
        jsonPathPattern: "reqBody.system[*]",
        multiplicity: "optional",
        // billing header block：内容以 "x-anthropic-billing-header" 开头
        // 参考 splitSysPromptPrefix：block.startsWith('x-anthropic-billing-header')
        anchor: { kind: "literal", text: "x-anthropic-billing-header" },
      },
      {
        id: "system.identity",
        jsonPathPattern: "reqBody.system[*]",
        multiplicity: "one",
        // identity block：CLI_SYSPROMPT_PREFIXES 里最常见的值
        // 参考 splitSysPromptPrefix：CLI_SYSPROMPT_PREFIXES.has(block)
        anchor: { kind: "literal", text: "You are Claude Code" },
      },
      {
        id: "system.main-prompt-block",
        jsonPathPattern: "reqBody.system[*]",
        multiplicity: "one",
        // rest.join('\n\n')——billing / identity 都不命中时进这里。
        // 内部用 H1 header 切分，末尾可能有 systemContext 段（gitStatus / cacheBreaker）。
        children: [
          {
            id: "system.section.prelude",
            jsonPathPattern: "reqBody.system[*]",
            multiplicity: "optional",
            // H1 之前的前导段（通常是 CLAUDE.md 注入内容）
          },
          {
            id: "system.section.system",
            jsonPathPattern: "reqBody.system[*]",
            multiplicity: "optional",
            anchor: { kind: "h1_header", header: "System" },
          },
          {
            id: "system.section.doing-tasks",
            jsonPathPattern: "reqBody.system[*]",
            multiplicity: "optional",
            anchor: { kind: "h1_header", header: "Doing tasks" },
          },
          {
            id: "system.section.actions",
            jsonPathPattern: "reqBody.system[*]",
            multiplicity: "optional",
            anchor: { kind: "h1_header", header: "Executing actions with care" },
          },
          {
            id: "system.section.using-tools",
            jsonPathPattern: "reqBody.system[*]",
            multiplicity: "optional",
            anchor: { kind: "h1_header", header: "Using your tools" },
          },
          {
            id: "system.section.tone-style",
            jsonPathPattern: "reqBody.system[*]",
            multiplicity: "optional",
            anchor: { kind: "h1_header", header: "Tone and style" },
          },
          {
            id: "system.section.text-output",
            jsonPathPattern: "reqBody.system[*]",
            multiplicity: "optional",
            // 实际 H1 含括号副标题，全部 fixture 一致：
            // "# Text output (does not apply to tool calls)"
            anchor: { kind: "h1_header", header: "Text output (does not apply to tool calls)" },
          },
          {
            id: "system.section.output-efficiency",
            jsonPathPattern: "reqBody.system[*]",
            multiplicity: "optional",
            anchor: { kind: "h1_header", header: "Output efficiency" },
          },
          {
            id: "system.section.session-guidance",
            jsonPathPattern: "reqBody.system[*]",
            multiplicity: "optional",
            anchor: { kind: "h1_header", header: "Session-specific guidance" },
          },
          {
            id: "system.section.environment",
            jsonPathPattern: "reqBody.system[*]",
            multiplicity: "optional",
            anchor: { kind: "h1_header", header: "Environment" },
          },
          {
            id: "system.section.auto-memory",
            jsonPathPattern: "reqBody.system[*]",
            multiplicity: "optional",
            anchor: { kind: "h1_header", header: "auto memory" },
          },
          {
            id: "system.section.context-management",
            jsonPathPattern: "reqBody.system[*]",
            multiplicity: "optional",
            // "# Context management" — Claude Code 2.x 实际出现的 section
            anchor: { kind: "h1_header", header: "Context management" },
          },
          {
            id: "system.section.language",
            jsonPathPattern: "reqBody.system[*]",
            multiplicity: "optional",
            anchor: { kind: "h1_header", header: "Language" },
          },
          {
            // systemContext 段：appendSystemContext 追加的 "key: value\n..." 块，
            // 目前包含 gitStatus（和可选的 cacheBreaker）。
            // 它出现在 block[2] 末尾，紧跟最后一个 H1 section 之后，不含 H1 标题。
            // WHY 用 literal 而非独立 block：appendSystemContext 把 context 字符串
            // push 进 systemPrompt 数组，再被 rest.join('\n\n') 合并，不是独立 block。
            id: "system.section.context",
            jsonPathPattern: "reqBody.system[*]",
            multiplicity: "optional",
            anchor: { kind: "literal", text: "gitStatus:" },
          },
        ],
      },
    ],

    // ── tools ───────────────────────────────────────────────────────────────
    tools: [
      {
        id: "tools.builtin",
        jsonPathPattern: "reqBody.tools[*]",
        multiplicity: "zero_or_more",
      },
    ],

    // ── messages ────────────────────────────────────────────────────────────
    messages: [
      {
        id: "messages.text",
        jsonPathPattern: "reqBody.messages[*].content[*]",
        multiplicity: "zero_or_more",
        children: [
          {
            id: "messages.inline.system-reminder",
            jsonPathPattern: "reqBody.messages[*].content[*]",
            multiplicity: "zero_or_more",
            anchor: { kind: "tag_prefix", prefix: "<system-reminder>" },
          },
          {
            id: "messages.inline.local-command",
            jsonPathPattern: "reqBody.messages[*].content[*]",
            multiplicity: "zero_or_more",
            anchor: { kind: "tag_prefix", prefix: "<local-command-" },
          },
          {
            id: "messages.inline.free-text",
            jsonPathPattern: "reqBody.messages[*].content[*]",
            multiplicity: "optional",
          },
        ],
      },
      {
        id: "messages.tool_use",
        jsonPathPattern: "reqBody.messages[*].content[*]",
        multiplicity: "zero_or_more",
      },
      {
        id: "messages.tool_result",
        jsonPathPattern: "reqBody.messages[*].content[*]",
        multiplicity: "zero_or_more",
      },
    ],
  },
};

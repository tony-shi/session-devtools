// Claude Code 主会话（main_session）模板
// 适用范围：tools.length > 0 的请求。
// system block 里包含 identity、若干 H1 章节，messages 里有 text / tool_use / tool_result。
// 这里只声明 slot 边界（jsonPath + anchor），实际切分在 parser/matcher.ts。

import type { RequestTemplate } from "../types";

export const CLAUDE_CODE_MAIN_SESSION_TEMPLATE: RequestTemplate = {
  id: "claude-code-main-session",
  queryKindPredicate: "main_session",
  version: "phase1.v1",
  slots: {
    // ── system ──────────────────────────────────────────────────────────────
    // 顺序敏感：matcher 按数组顺序逐一尝试 anchor。
    // main-prompt-block 没有 anchor，是 fallback——meta / identity / context-management
    // 都不命中时进入这里，再用 H1 children 切分子 section。
    system: [
      {
        id: "system.meta",
        jsonPathPattern: "reqBody.system[*]",
        multiplicity: "optional",
        // billing & version meta block 通常是裸 frontmatter / "---" 起首
        anchor: { kind: "literal", text: "---" },
      },
      {
        id: "system.identity",
        jsonPathPattern: "reqBody.system[*]",
        multiplicity: "one",
        anchor: { kind: "literal", text: "You are Claude Code" },
      },
      {
        id: "system.context-management",
        jsonPathPattern: "reqBody.system[*]",
        multiplicity: "optional",
        // gitStatus block 紧贴 system 末尾，是独立 block
        anchor: { kind: "literal", text: "gitStatus" },
      },
      {
        id: "system.main-prompt-block",
        jsonPathPattern: "reqBody.system[*]",
        multiplicity: "one",
        // 整块兜底；children 用 H1 header 再切分
        children: [
          {
            id: "system.section.prelude",
            jsonPathPattern: "reqBody.system[*]",
            multiplicity: "optional",
            // 没有 anchor = 第一个 H1 之前的前导段
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
            anchor: { kind: "h1_header", header: "Text output" },
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
            id: "system.section.language",
            jsonPathPattern: "reqBody.system[*]",
            multiplicity: "optional",
            anchor: { kind: "h1_header", header: "Language" },
          },
        ],
      },
    ],

    // ── tools ───────────────────────────────────────────────────────────────
    // 不按 name 写死，而是动态展开：matcher 会把每个 tool 的 name 拼到 slotId 里。
    tools: [
      {
        id: "tools.builtin",
        jsonPathPattern: "reqBody.tools[*]",
        multiplicity: "zero_or_more",
        // 没有 anchor，整块（每个 tool 对象一段）
      },
    ],

    // ── messages ────────────────────────────────────────────────────────────
    // block 级 slot：按 block.type 分流；text block 内再按 inline tag 切 children。
    messages: [
      {
        id: "messages.text",
        jsonPathPattern: "reqBody.messages[*].content[*]",
        multiplicity: "zero_or_more",
        // 没有 anchor；matcher 内部按 block.type==="text" 命中
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
            // 兜底：非 tag 段
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

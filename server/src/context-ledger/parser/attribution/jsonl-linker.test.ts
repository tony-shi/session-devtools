import { describe, it, expect } from "vitest";
import { attributeWithJsonl } from "../index";
import type { LinkableJsonlEvent } from "./jsonl-linker";
import { isCommandLikeText, COMMAND_TEXT_PREFIX_RE } from "./jsonl-linker";
import { withBillingHeader } from "./test-fixtures";

// 构造一个完整 fixture：1 个 user input + 1 个 assistant call 含 tool_use + 1 个 tool_result
// + 1 个 assistant 收尾文本。proxy reqBody 把它们拍扁成 messages[]，jsonl 是事件流。

function makeFixture() {
  const userInputText = "请帮我看一下 package.json 里的 dev 脚本";
  const assistantText1 = "我先看下 package.json。";
  const toolUseId = "toolu_test_abc123";
  const toolResultText = '{"dev": "vite"}';
  const assistantText2 = "dev 脚本是 vite。";

  // —— proxy 视角的 messages（积累态）——
  const reqBody = withBillingHeader({
    system: [
      { type: "text" as const, text: "You are Claude Code, Anthropic's official CLI for Claude." },
      // 给一个有 H1 的 main-prompt block 让 selector 判定 main_session
      { type: "text" as const, text: "Prelude.\n# Doing tasks\nDo stuff.\n" },
    ],
    tools: [{ name: "Read", description: "Read a file", input_schema: {} }],
    messages: [
      // [0] 用户原始输入
      { role: "user", content: [{ type: "text", text: userInputText }] },
      // [1] 助手第一次响应：含文本 + tool_use
      {
        role: "assistant",
        content: [
          { type: "text", text: assistantText1 },
          { type: "tool_use", id: toolUseId, name: "Read", input: { file: "package.json" } },
        ],
      },
      // [2] 用户消息（实际是 tool_result）
      { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: toolResultText }] },
      // [3] 助手最终输出
      { role: "assistant", content: [{ type: "text", text: assistantText2 }] },
    ],
  });

  // —— jsonl 视角的事件流（claude-code 记录的）——
  const events: LinkableJsonlEvent[] = [
    {
      lineIdx: 10,
      type: "user",
      userText: userInputText,
      callId: 1,
      turnId: 2,
    },
    {
      lineIdx: 11,
      type: "assistant",
      assistantText: assistantText1,
      toolUses: [{ id: toolUseId, name: "Read" }],
      callId: 1,
      turnId: 2,
    },
    {
      lineIdx: 12,
      type: "user",
      toolResults: [{ toolUseId, contentText: toolResultText }],
      callId: 1,
      turnId: 2,
    },
    {
      lineIdx: 13,
      type: "assistant",
      assistantText: assistantText2,
      callId: 1,
      turnId: 2,
    },
  ];

  return { reqBody, events, toolUseId, userInputText, assistantText1, assistantText2, toolResultText };
}

describe("PR 3 — jsonl-linker", () => {
  it("tool_use by id → JsonlOrigin (definitive, eventKind=tool_use, toolUseId 填入)", () => {
    const fx = makeFixture();
    const { snapshot, linkReport } = attributeWithJsonl({
      reqBody: fx.reqBody,
      proxyFile: "t.json",
      jsonl: fx.events,
      call: { callId: 1, turnId: 2 },
    });
    expect(linkReport.matched.toolUse).toBe(1);

    const tu = Object.values(snapshot.index).find((n) => n.slotType === "messages.tool_use");
    expect(tu?.origin.kind).toBe("jsonl");
    if (tu?.origin.kind === "jsonl") {
      expect(tu.origin.eventKind.source).toBe("tool_use");
      expect(tu.origin.confidence).toBe("definitive");
      expect(tu.origin.toolUseId).toBe(fx.toolUseId);
      expect(tu.origin.jsonlLineIdx).toBe(11);
      expect(tu.origin.sourceCallId).toBe(1);
      expect(tu.origin.sourceTurnId).toBe(2);
    }
  });

  it("tool_result by tool_use_id → JsonlOrigin (definitive)", () => {
    const fx = makeFixture();
    const { snapshot, linkReport } = attributeWithJsonl({
      reqBody: fx.reqBody,
      proxyFile: "t.json",
      jsonl: fx.events,
      call: { callId: 1, turnId: 2 },
    });
    expect(linkReport.matched.toolResult).toBe(1);

    const tr = Object.values(snapshot.index).find((n) => n.slotType === "messages.tool_result");
    expect(tr?.origin.kind).toBe("jsonl");
    if (tr?.origin.kind === "jsonl") {
      expect(tr.origin.eventKind.source).toBe("tool_result");
      expect(tr.origin.toolUseId).toBe(fx.toolUseId);
      expect(tr.origin.jsonlLineIdx).toBe(12);
    }
  });

  it("user_input by content equality → JsonlOrigin (definitive, eventKind=user_input)", () => {
    const fx = makeFixture();
    const { snapshot, linkReport } = attributeWithJsonl({
      reqBody: fx.reqBody,
      proxyFile: "t.json",
      jsonl: fx.events,
      call: { callId: 1, turnId: 2 },
    });
    expect(linkReport.matched.userInput).toBe(1);

    const ui = Object.values(snapshot.index).find(
      (n) =>
        n.wireMeta?.messageRole === "user" &&
        n.wireMeta.messageIdx === 0 &&
        n.children.length === 0 &&
        n.rawText === fx.userInputText,
    );
    expect(ui?.origin.kind).toBe("jsonl");
    if (ui?.origin.kind === "jsonl") {
      expect(ui.origin.eventKind.source).toBe("user_input");
      expect(ui.origin.eventKind.contentType).toBe("text");
      expect(ui.origin.confidence).toBe("definitive");
      expect(ui.origin.jsonlLineIdx).toBe(10);
    }
  });

  it("assistant_text by content equality → JsonlOrigin (definitive)", () => {
    const fx = makeFixture();
    const { snapshot, linkReport } = attributeWithJsonl({
      reqBody: fx.reqBody,
      proxyFile: "t.json",
      jsonl: fx.events,
      call: { callId: 1, turnId: 2 },
    });
    expect(linkReport.matched.assistantText).toBe(2); // assistant_text1 和 assistant_text2

    const asst1 = Object.values(snapshot.index).find(
      (n) => n.wireMeta?.messageRole === "assistant" && n.rawText === fx.assistantText1,
    );
    expect(asst1?.origin.kind).toBe("jsonl");
    if (asst1?.origin.kind === "jsonl") {
      expect(asst1.origin.eventKind.source).toBe("assistant_text");
      expect(asst1.origin.eventKind.contentType).toBe("text");
      expect(asst1.origin.jsonlLineIdx).toBe(11);
    }

    const asst2 = Object.values(snapshot.index).find(
      (n) => n.wireMeta?.messageRole === "assistant" && n.rawText === fx.assistantText2,
    );
    expect(asst2?.origin.kind).toBe("jsonl");
    if (asst2?.origin.kind === "jsonl") {
      expect(asst2.origin.jsonlLineIdx).toBe(13);
    }
  });

  it("tool_use_id 不在 jsonl 中时不覆盖 origin (保留 wire rule origin)", () => {
    const fx = makeFixture();
    const eventsWithoutToolUse: LinkableJsonlEvent[] = fx.events.map((e) =>
      e.toolUses ? { ...e, toolUses: undefined } : e,
    );
    const { snapshot, linkReport } = attributeWithJsonl({
      reqBody: fx.reqBody,
      proxyFile: "t.json",
      jsonl: eventsWithoutToolUse,
      call: { callId: 1, turnId: 2 },
    });
    expect(linkReport.matched.toolUse).toBe(0);

    const tu = Object.values(snapshot.index).find((n) => n.slotType === "messages.tool_use");
    // 没有 jsonl 命中，origin 应保留为 PR 2 写入的 wire rule origin
    expect(tu?.origin.kind).toBe("rule");
    if (tu?.origin.kind === "rule") {
      expect(tu.origin.ruleId).toBe("wire.messages.tool_use");
    }
  });

  it("不变量在整条 pipeline 之后仍然成立", () => {
    const fx = makeFixture();
    const { snapshot } = attributeWithJsonl({
      reqBody: fx.reqBody,
      proxyFile: "t.json",
      jsonl: fx.events,
      call: { callId: 1, turnId: 2 },
    });
    // attributeWithJsonl 内部已经跑了 assertAllInvariants；这里再次显式验证。
    // 任何节点都有 origin
    for (const node of Object.values(snapshot.index)) {
      expect(node.origin).toBeDefined();
    }
    // 叶子拼接 ≡ 父节点 rawText
    for (const node of Object.values(snapshot.index)) {
      if (node.children.length === 0) continue;
      const concat = node.children
        .flatMap(function leaves(n): string[] {
          if (n.children.length === 0) return [n.rawText];
          return n.children.flatMap(leaves);
        })
        .join("");
      expect(concat).toBe(node.rawText);
    }
  });

  it("multi-turn：messages[N>0] 的新人类输入也能被 user_input 链上（B 方案：内容相等而非 messageIdx===0）", () => {
    // 复现 0847a580 Turn 2 的实情：accumulated proxy 里第二轮新输入位于 messages[2N]
    // （前面被 tool_result + assistant 交替占据），不再是 messages[0]。
    // 旧 linker 用 `messageIdx !== 0 → return false` 直接拒掉，导致这条人类输入被
    // 误识别为 structural/no_rule_matched；B 方案以内容相等做 deterministic join，
    // 不再依赖 message 位置。
    const turn1Text = "请帮我看一下 package.json 里的 dev 脚本";
    const turn2Text = "再帮我跑一下 dev 看看会不会报错";
    const reqBody = withBillingHeader({
      system: [
        { type: "text" as const, text: "You are Claude Code, Anthropic's official CLI for Claude." },
        { type: "text" as const, text: "Prelude.\n# Doing tasks\nDo stuff.\n" },
      ],
      tools: [{ name: "Read", description: "Read a file", input_schema: {} }],
      messages: [
        { role: "user", content: [{ type: "text", text: turn1Text }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "好，我看一下。" },
            { type: "tool_use", id: "toolu_x1", name: "Read", input: { file: "package.json" } },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_x1", content: '{"dev":"vite"}' }] },
        { role: "assistant", content: [{ type: "text", text: "dev 是 vite。" }] },
        // Turn 2 新的人类输入：位于 messages[4]，不再是 [0]
        { role: "user", content: [{ type: "text", text: turn2Text }] },
      ],
    });
    const events: LinkableJsonlEvent[] = [
      { lineIdx: 1, type: "user", userText: turn1Text },
      { lineIdx: 2, type: "assistant", assistantText: "好，我看一下。", toolUses: [{ id: "toolu_x1", name: "Read" }] },
      { lineIdx: 3, type: "user", toolResults: [{ toolUseId: "toolu_x1", contentText: '{"dev":"vite"}' }] },
      { lineIdx: 4, type: "assistant", assistantText: "dev 是 vite。" },
      { lineIdx: 5, type: "user", userText: turn2Text },
    ];
    const { snapshot, linkReport } = attributeWithJsonl({
      reqBody, proxyFile: "t.json", jsonl: events, call: { callId: 2, turnId: 2 },
    });
    // 两条人类输入都应该 deterministic 命中
    expect(linkReport.matched.userInput).toBe(2);

    const t2node = Object.values(snapshot.index).find(
      (n) =>
        n.wireMeta?.messageRole === "user" &&
        n.wireMeta.messageIdx === 4 &&
        n.children.length === 0 &&
        n.rawText === turn2Text,
    );
    expect(t2node?.origin.kind).toBe("jsonl");
    if (t2node?.origin.kind === "jsonl") {
      expect(t2node.origin.eventKind.source).toBe("user_input");
      expect(t2node.origin.confidence).toBe("definitive");
      expect(t2node.origin.fullyCovered).toBe(true);
      expect(t2node.origin.jsonlLineIdx).toBe(5);
    }
  });

  it("内容不相等时不再走 turn-inferred 兜底，节点保留 structural（B 方案：去掉无差别拿首条事件的近似匹配）", () => {
    // 旧逻辑：找不到内容相等的事件就拿"首条 turnId === ctx.turnId 或 turnId===undefined"
    // 的事件做 inferred/partial 兜底。生产里 readSessionEventsForLinker 不填 turnId，
    // 兜底退化为"无脑取全 session 首条 user-input"，会把任何文本不一致的 user 块
    // 误绑到首条 turn 的输入上。B 方案直接放弃这条兜底。
    const reqBody = withBillingHeader({
      system: [
        { type: "text" as const, text: "You are Claude Code, Anthropic's official CLI for Claude." },
        { type: "text" as const, text: "Prelude.\n# Doing tasks\nDo stuff.\n" },
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: "proxy 里的用户输入文本（与 jsonl 不完全相同）" }] },
      ],
    });
    const events: LinkableJsonlEvent[] = [
      { lineIdx: 1, type: "user", userText: "jsonl 里的另一条用户输入（与 proxy 拼写不同）" },
    ];
    const { snapshot, linkReport } = attributeWithJsonl({
      reqBody, proxyFile: "t.json", jsonl: events, call: { callId: 1, turnId: 1 },
    });
    expect(linkReport.matched.userInput).toBe(0);
    const node = Object.values(snapshot.index).find(
      (n) => n.wireMeta?.messageRole === "user" && n.children.length === 0,
    );
    expect(node?.origin.kind).not.toBe("jsonl");
  });

  it("commandText：slash command 块（<command-name>...）由 commandText 维度 deterministic 链上", () => {
    // Claude Code 把人类敲 `/status` 这件事记成一条 user 事件，文本以
    // <command-name>...</command-name>... 开头。proxy 累积 reqBody 里该块原样保留为
    // role=user 的 text block。adapter 现在按 isCommandLikeText 把它路由进 commandText，
    // linker 走独立的 linkCommandTextNode 等值查命中。
    const commandBlock =
      "<command-name>/status</command-name>\n            <command-message>status</command-message>\n            <command-args></command-args>\n<local-command-stdout>OK</local-command-stdout>";
    const reqBody = withBillingHeader({
      system: [
        { type: "text" as const, text: "You are Claude Code, Anthropic's official CLI for Claude." },
        { type: "text" as const, text: "Prelude.\n# Doing tasks\nDo stuff.\n" },
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: commandBlock }] },
      ],
    });
    const events: LinkableJsonlEvent[] = [
      { lineIdx: 7, type: "user", commandText: commandBlock },
    ];
    const { snapshot, linkReport } = attributeWithJsonl({
      reqBody, proxyFile: "t.json", jsonl: events, call: { callId: 1, turnId: 1 },
    });
    expect(linkReport.matched.commandText).toBe(1);
    expect(linkReport.matched.userInput).toBe(0);

    const node = Object.values(snapshot.index).find(
      (n) => n.wireMeta?.messageRole === "user" && n.children.length === 0,
    );
    expect(node?.origin.kind).toBe("jsonl");
    if (node?.origin.kind === "jsonl") {
      expect(node.origin.eventKind.source).toBe("system_local_command");
      expect(node.origin.confidence).toBe("definitive");
      expect(node.origin.fullyCovered).toBe(true);
      expect(node.origin.jsonlLineIdx).toBe(7);
    }
  });

  it("commandText 不会和 userInput 抢命中：正则把候选集严格限定到固定 tag 起始", () => {
    // 把同一段命令文本同时塞进 userInputTextIndex 是不可能的（adapter 不会路由）；
    // 这里更直接：linkCommandTextNode 内部用 isCommandLikeText 自检，
    // 哪怕事件里乱塞 commandText、节点文本不是命令形态，也不会误绑。
    expect(COMMAND_TEXT_PREFIX_RE.test("<command-name>/foo</command-name>")).toBe(true);
    expect(COMMAND_TEXT_PREFIX_RE.test("<bash-input>ls</bash-input>")).toBe(true);
    expect(COMMAND_TEXT_PREFIX_RE.test("<local-command-stdout>x</local-command-stdout>")).toBe(true);
    expect(COMMAND_TEXT_PREFIX_RE.test("<local-command-caveat>x</local-command-caveat>")).toBe(true);
    // 不是命令外壳：普通人类输入
    expect(isCommandLikeText("hello world")).toBe(false);
    // 内部位置出现 tag 不算（必须 trim 后起始）
    expect(isCommandLikeText("说明：<command-name>/foo</command-name>")).toBe(false);
    // leading whitespace 容忍
    expect(isCommandLikeText("   \n<bash-input>ls</bash-input>")).toBe(true);
  });

  it("commandText 在 reverse audit 下进 command_text 桶", async () => {
    const { computeReverseAudit } = await import("../audit/reverse");
    const cmd = "<command-name>/status</command-name>";
    const reqBody = withBillingHeader({
      system: [
        { type: "text" as const, text: "You are Claude Code, Anthropic's official CLI for Claude." },
        { type: "text" as const, text: "Prelude.\n# Doing tasks\nDo stuff.\n" },
      ],
      messages: [{ role: "user", content: [{ type: "text", text: cmd }] }],
    });
    const events: LinkableJsonlEvent[] = [
      { lineIdx: 1, type: "user", commandText: cmd },
      { lineIdx: 2, type: "user", commandText: "<bash-input>ls</bash-input>" }, // 在 jsonl 里有但 proxy 没引用 → missing
    ];
    const { snapshot } = attributeWithJsonl({
      reqBody, proxyFile: "t.json", jsonl: events, call: { callId: 1, turnId: 1 },
    });
    const rev = computeReverseAudit(snapshot, events);
    expect(rev.byKind.command_text.total).toBe(2);
    expect(rev.byKind.command_text.linked).toBe(1);
    expect(rev.byKind.command_text.missing).toBe(1);
    const miss = rev.missing.find((m) => m.eventKind === "command_text");
    expect(miss?.jsonlLineIdx).toBe(2);
  });

  it("slash command 多段（<command-name>+<command-message>+<command-args>）合并成单个 local-command leaf", () => {
    // CLI 在一个 text block 内紧挨着发 3 个 <command-*> tag；splitInlineTags 把它们
    // 折叠成一个 messages.inline.local-command leaf，命中 local-command 规则进 full 桶，
    // 而不是被中间空白拆成多个 free-text 噪声 leaf。
    const block =
      "<command-name>/status</command-name>\n            <command-message>status</command-message>\n            <command-args></command-args>\n";
    const reqBody = withBillingHeader({
      system: [
        { type: "text" as const, text: "You are Claude Code, Anthropic's official CLI for Claude." },
        { type: "text" as const, text: "Prelude.\n# Doing tasks\nDo stuff.\n" },
      ],
      // 非空 tools 触发 main_session 模板（含 messages.inline.* 子 slot）
      tools: [{ name: "Read", description: "Read a file", input_schema: {} }],
      messages: [{ role: "user", content: [{ type: "text", text: block }] }],
    });
    const { snapshot } = attributeWithJsonl({
      reqBody, proxyFile: "t.json", jsonl: [], call: { callId: 1, turnId: 1 },
    });
    const leaves = Object.values(snapshot.index).filter(
      (n) => n.children.length === 0 && n.jsonPath?.startsWith("reqBody.messages[0].content[0]"),
    );
    // 期望恰好 1 个 leaf：把 3 个紧邻 <command-*> tag 合并为一段
    expect(leaves.length).toBe(1);
    expect(leaves[0]!.slotType).toBe("messages.inline.local-command");
    // 规则按家族前缀匹配，命中即 full
    expect(leaves[0]!.origin.kind).toBe("rule");
    if (leaves[0]!.origin.kind === "rule") {
      expect(leaves[0]!.origin.ruleId).toBe("claude-code.messages.local-command.v1");
      expect(leaves[0]!.origin.fullyCovered).toBe(true);
    }
  });

  it("<bash-input>/<bash-stdout> 也通过 local-command rule 取得 full 覆盖", () => {
    // 旧 splitInlineTags 只识别 <local-command-*> 与 <system-reminder>，<bash-*> 与
    // <command-*> 落到 messages.inline.free-text 槽，规则因 slot 不对而不放行。
    // 扩家族前缀后这两族也进 local-command 槽并命中正则。
    const reqBody = withBillingHeader({
      system: [
        { type: "text" as const, text: "You are Claude Code, Anthropic's official CLI for Claude." },
        { type: "text" as const, text: "Prelude.\n# Doing tasks\nDo stuff.\n" },
      ],
      tools: [{ name: "Read", description: "Read a file", input_schema: {} }],
      messages: [
        { role: "user", content: [{ type: "text", text: "<bash-input>ls -la</bash-input>\n<bash-stdout>file1\nfile2\n</bash-stdout>\n" }] },
      ],
    });
    const { snapshot } = attributeWithJsonl({
      reqBody, proxyFile: "t.json", jsonl: [], call: { callId: 1, turnId: 1 },
    });
    const leaves = Object.values(snapshot.index).filter(
      (n) => n.children.length === 0 && n.jsonPath?.startsWith("reqBody.messages[0].content[0]"),
    );
    // 两个 bash-* tag 紧邻 → 合并为 1 个 local-command leaf
    expect(leaves.length).toBe(1);
    expect(leaves[0]!.slotType).toBe("messages.inline.local-command");
    expect(leaves[0]!.origin.kind).toBe("rule");
  });

  it("tool_result 容器被 SmooshContent 切走 SR 子段后，剩下的 free-text leftover 继承父 jsonl/tool_result origin", () => {
    // 真实命中点：grep / Read / Bash 的工具输出末尾会被 claude-code 拼上一个
    // <system-reminder>...</system-reminder>，smoosh 规则把 SR 切成独立子 leaf，
    // 剩下的工具输出 free-text 一直以来在 audit 里以 structural/no_rule_matched 出现。
    // 现在 leftover 直接继承父的 tool_result jsonl link。
    const toolUseId = "toolu_leftover_test";
    const toolOutput = "60:  ruleId: string;\n125:  ruleId: \"claude-code.system-prompt-identity.v1\",\n";
    const reminder = "<system-reminder>\nThe task tools haven't been used recently.\n</system-reminder>";
    const reqBody = withBillingHeader({
      system: [
        { type: "text" as const, text: "You are Claude Code, Anthropic's official CLI for Claude." },
        { type: "text" as const, text: "Prelude.\n# Doing tasks\nDo stuff.\n" },
      ],
      tools: [{ name: "Read", description: "Read a file", input_schema: {} }],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              content: toolOutput + reminder,
            },
          ],
        },
      ],
    });
    const events: LinkableJsonlEvent[] = [
      // 工具结果在 jsonl 里 contentText 包含整段（leftover 内容 + SR 段）
      { lineIdx: 9, type: "user", toolResults: [{ toolUseId, contentText: toolOutput + reminder }] },
    ];
    const { snapshot, linkReport } = attributeWithJsonl({
      reqBody, proxyFile: "t.json", jsonl: events, call: { callId: 1, turnId: 1 },
    });
    expect(linkReport.matched.toolResult).toBe(1);
    expect(linkReport.matched.toolResultLeftover).toBe(1);

    const leftover = Object.values(snapshot.index).find(
      (n) =>
        n.children.length === 0 &&
        n.slotType === "messages.inline.free-text" &&
        n.rawText.startsWith("60:  ruleId"),
    );
    expect(leftover?.origin.kind).toBe("jsonl");
    if (leftover?.origin.kind === "jsonl") {
      expect(leftover.origin.eventKind.source).toBe("tool_result");
      expect(leftover.origin.toolUseId).toBe(toolUseId);
      expect(leftover.origin.jsonlLineIdx).toBe(9);
      expect(leftover.origin.fullyCovered).toBe(true);
    }
  });

  it("CLI 注入的 [Image: source: <path>] 占位文本：独立成块 → image-placeholder rule full 覆盖", () => {
    // 用户上传截图时 CLI 同时往 messages.content[] 里 push 两个 block：真实 base64
    // image block + 一段文本占位 `[Image: source: <path>]`。后者过去落 free-text
    // 无人认领；现在 ast-builder 整块识别为 messages.inline.image-placeholder slot，
    // 规则 claude-code.messages.image-placeholder.v1 命中 full。
    const placeholder = "[Image: source: /Users/foo/Desktop/截屏.png]";
    const reqBody = withBillingHeader({
      system: [
        { type: "text" as const, text: "You are Claude Code, Anthropic's official CLI for Claude." },
        { type: "text" as const, text: "Prelude.\n# Doing tasks\nDo stuff.\n" },
      ],
      tools: [{ name: "Read", description: "Read a file", input_schema: {} }],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "看这张图" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0..." } },
            { type: "text", text: placeholder },
          ],
        },
      ],
    });
    const { snapshot } = attributeWithJsonl({
      reqBody, proxyFile: "t.json", jsonl: [], call: { callId: 1, turnId: 1 },
    });
    const node = Object.values(snapshot.index).find(
      (n) => n.children.length === 0 && n.rawText === placeholder,
    );
    expect(node?.slotType).toBe("messages.inline.image-placeholder");
    expect(node?.origin.kind).toBe("rule");
    if (node?.origin.kind === "rule") {
      expect(node.origin.ruleId).toBe("claude-code.messages.image-placeholder.v1");
      expect(node.origin.fullyCovered).toBe(true);
    }
  });

  it("用户在 prose 里回引 [Image #N]（混入用户输入同一 text block）→ 不切碎，保持整段 user_input link", () => {
    // 防回归：CLI 自动注入的占位符（独立成块）才切；用户 prose 里的 `[Image #N]`
    // 回引和散文同 block，强行切会破坏 jsonl userText 哈希等值匹配。
    const mixed =
      "[Image #2] [Image #3]\n\n继续考虑 UI 问题。我们可以看到：[Image #1] 这里点击展开 call 应该跳转。";
    const reqBody = withBillingHeader({
      system: [
        { type: "text" as const, text: "You are Claude Code, Anthropic's official CLI for Claude." },
        { type: "text" as const, text: "Prelude.\n# Doing tasks\nDo stuff.\n" },
      ],
      tools: [{ name: "Read", description: "Read a file", input_schema: {} }],
      messages: [{ role: "user", content: [{ type: "text", text: mixed }] }],
    });
    const events: LinkableJsonlEvent[] = [
      { lineIdx: 1, type: "user", userText: mixed },
    ];
    const { snapshot, linkReport } = attributeWithJsonl({
      reqBody, proxyFile: "t.json", jsonl: events, call: { callId: 1, turnId: 1 },
    });
    // 整段是一个 free-text leaf，命中 jsonl/user_input definitive
    expect(linkReport.matched.userInput).toBe(1);
    const node = Object.values(snapshot.index).find(
      (n) => n.children.length === 0 && n.rawText === mixed,
    );
    expect(node?.slotType).toBe("messages.inline.free-text");
    expect(node?.origin.kind).toBe("jsonl");
    if (node?.origin.kind === "jsonl") {
      expect(node.origin.eventKind.source).toBe("user_input");
      expect(node.origin.fullyCovered).toBe(true);
    }
  });

  it("[Image #<N>] 形态（无 source）也被 image-placeholder 规则覆盖（独立成块时）", () => {
    // 后续 turn CLI 偶尔会以 `[Image #N]` 单独成块的形式回引已上传的图片。
    const placeholder = "[Image #3]";
    const reqBody = withBillingHeader({
      system: [
        { type: "text" as const, text: "You are Claude Code, Anthropic's official CLI for Claude." },
        { type: "text" as const, text: "Prelude.\n# Doing tasks\nDo stuff.\n" },
      ],
      tools: [{ name: "Read", description: "Read a file", input_schema: {} }],
      messages: [{ role: "user", content: [{ type: "text", text: placeholder }] }],
    });
    const { snapshot } = attributeWithJsonl({
      reqBody, proxyFile: "t.json", jsonl: [], call: { callId: 1, turnId: 1 },
    });
    const node = Object.values(snapshot.index).find(
      (n) => n.children.length === 0 && n.rawText === placeholder,
    );
    expect(node?.slotType).toBe("messages.inline.image-placeholder");
    expect(node?.origin.kind).toBe("rule");
  });

  it("away-summary recap prompt（CLI \"while you were away\" 注入）由专门规则覆盖", () => {
    // CLI 在用户离开重回时把 recap prompt 追加进主 session 最后一条 user message。
    // prompt 第一句固定 "The user stepped away and is coming back."，后续指令措辞跟随
    // 版本演进（"Write exactly 1-3 short sentences..." vs "Recap in under 40 words..."），
    // 规则用通用尾巴 [\s\S]+ 把两种都吃下。
    const newWording = "The user stepped away and is coming back. Recap in under 40 words, 1-2 plain sentences, no markdown. Lead with the overall goal.";
    const oldWording = "The user stepped away and is coming back. Write exactly 1-3 short sentences. Start by stating the high-level task — what they are building or debugging, not implementation details.";
    for (const promptText of [newWording, oldWording]) {
      const reqBody = withBillingHeader({
        system: [
          { type: "text" as const, text: "You are Claude Code, Anthropic's official CLI for Claude." },
          { type: "text" as const, text: "Prelude.\n# Doing tasks\nDo stuff.\n" },
        ],
        tools: [{ name: "Read", description: "Read a file", input_schema: {} }],
        messages: [{ role: "user", content: [{ type: "text", text: promptText }] }],
      });
      const { snapshot } = attributeWithJsonl({
        reqBody, proxyFile: "t.json", jsonl: [], call: { callId: 1, turnId: 1 },
      });
      const node = Object.values(snapshot.index).find(
        (n) => n.children.length === 0 && n.rawText === promptText,
      );
      expect(node?.slotType).toBe("messages.inline.free-text");
      expect(node?.origin.kind).toBe("rule");
      if (node?.origin.kind === "rule") {
        expect(node.origin.ruleId).toBe("claude-code.messages.away-summary.v1");
        expect(node.origin.fullyCovered).toBe(true);
      }
    }
  });

  it("away-summary side-query 形态：messages.text 整块也由同一规则覆盖", () => {
    // 旧形态（services/awaySummary.ts queryModelWithoutStreaming）：tools:[]、单 message
    // → selectTemplate 落 side_query 模板 → matcher 把整块塞进 messages.text，
    // 不再走 splitInlineTags 切分子段，规则需直接绑定到 messages.text 槽。
    const prompt = "The user stepped away and is coming back. Recap in under 40 words.";
    const reqBody = withBillingHeader({
      system: [{ type: "text" as const, text: "You are Claude Code, Anthropic's official CLI for Claude." }],
      messages: [{ role: "user", content: prompt }],
    });
    const { snapshot } = attributeWithJsonl({
      reqBody, proxyFile: "t.json", jsonl: [], call: { callId: 1, turnId: 1 },
    });
    const node = Object.values(snapshot.index).find(
      (n) => n.children.length === 0 && n.rawText === prompt,
    );
    expect(node?.slotType).toBe("messages.text");
    expect(node?.origin.kind).toBe("rule");
    if (node?.origin.kind === "rule") {
      expect(node.origin.ruleId).toBe("claude-code.messages.away-summary.v1");
    }
  });

  it("空 jsonl events 时 linkReport.matched 全为 0，origin 保留 PR 2 状态", () => {
    const fx = makeFixture();
    const { snapshot, linkReport } = attributeWithJsonl({
      reqBody: fx.reqBody,
      proxyFile: "t.json",
      jsonl: [],
      call: { callId: 1, turnId: 2 },
    });
    expect(linkReport.matched.toolUse).toBe(0);
    expect(linkReport.matched.toolResult).toBe(0);
    expect(linkReport.matched.userInput).toBe(0);
    expect(linkReport.matched.assistantText).toBe(0);
    // 无任何 JsonlOrigin
    for (const node of Object.values(snapshot.index)) {
      expect(node.origin.kind).not.toBe("jsonl");
    }
  });
});

describe("PR 3 — #8 tool-reference turn boundary (`Tool loaded.`)", () => {
  // 模拟 Tool Search beta 流程：
  //   1) assistant 一次 ToolSearch tool_use（jsonl line 10）
  //   2) user tool_result 携带 tool_reference 子块（jsonl line 11）
  //   3) Claude Code 在 API normalize 时给同一 user 消息追加 `Tool loaded.` text
  //      block（reqBody 看到，但 jsonl 没有）
  function makeBoundaryFixture() {
    const toolUseId = "toolu_search_42";
    const reqBody = withBillingHeader({
      system: [
        { type: "text" as const, text: "You are Claude Code, Anthropic's official CLI for Claude." },
        { type: "text" as const, text: "Prelude.\n# Doing tasks\nDo stuff.\n" },
      ],
      tools: [{ name: "ToolSearch", description: "Search tools", input_schema: {} }],
      messages: [
        { role: "user", content: [{ type: "text", text: "请帮我找几个 task 工具" }] },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: toolUseId, name: "ToolSearch", input: { query: "task" } },
          ],
        },
        {
          // tool_result + 末尾被 normalize 追加的 Tool loaded.
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              content: [
                { type: "tool_reference", tool_name: "TaskCreate" },
                { type: "tool_reference", tool_name: "TaskUpdate" },
              ],
            },
            { type: "text", text: "Tool loaded." },
          ],
        },
      ],
    });
    const events: LinkableJsonlEvent[] = [
      { lineIdx: 9, type: "user", userText: "请帮我找几个 task 工具" },
      { lineIdx: 10, type: "assistant", toolUses: [{ id: toolUseId, name: "ToolSearch" }] },
      {
        lineIdx: 11,
        type: "user",
        toolResults: [
          {
            toolUseId,
            contentText: "",
            toolReferenceNames: ["TaskCreate", "TaskUpdate"],
          },
        ],
      },
    ];
    return { reqBody, events, toolUseId };
  }

  it("`Tool loaded.` 文本叶子 → JsonlOrigin(source=tool_result, toolUseId, jsonlLineIdx=11)", () => {
    const fx = makeBoundaryFixture();
    const { snapshot, linkReport } = attributeWithJsonl({
      reqBody: fx.reqBody,
      proxyFile: "t.json",
      jsonl: fx.events,
      call: { callId: 1, turnId: 1 },
    });
    expect(linkReport.matched.toolReferenceBoundary).toBe(1);

    const boundary = Object.values(snapshot.index).find(
      (n) =>
        n.wireMeta?.messageRole === "user" &&
        n.children.length === 0 &&
        n.rawText === "Tool loaded.",
    );
    expect(boundary?.origin.kind).toBe("jsonl");
    if (boundary?.origin.kind === "jsonl") {
      expect(boundary.origin.eventKind.source).toBe("tool_result");
      expect(boundary.origin.toolUseId).toBe(fx.toolUseId);
      expect(boundary.origin.jsonlLineIdx).toBe(11);
      expect(boundary.origin.fullyCovered).toBe(true);
      expect(boundary.origin.confidence).toBe("definitive");
    }
  });

  it("appendMessageTag 加 `[id:xxx]` 尾标的 `Tool loaded.` 也能命中", () => {
    const fx = makeBoundaryFixture();
    // 改写 reqBody 里 Tool loaded text 为带尾标形态
    const msgs = fx.reqBody.messages;
    const tooledMsg = msgs[2] as { content: Array<{ type: string; text?: string }> };
    tooledMsg.content[1].text = "Tool loaded.\n[id:a1b2c3]";

    const { snapshot, linkReport } = attributeWithJsonl({
      reqBody: fx.reqBody,
      proxyFile: "t.json",
      jsonl: fx.events,
      call: { callId: 1, turnId: 1 },
    });
    expect(linkReport.matched.toolReferenceBoundary).toBe(1);

    const boundary = Object.values(snapshot.index).find(
      (n) =>
        n.wireMeta?.messageRole === "user" &&
        n.children.length === 0 &&
        n.rawText === "Tool loaded.\n[id:a1b2c3]",
    );
    expect(boundary?.origin.kind).toBe("jsonl");
  });

  it("jsonl 完全没有 tool_reference 事件时不误链 `Tool loaded.` 字面叶子", () => {
    const fx = makeBoundaryFixture();
    // 砍掉 tool_reference 信息：toolResults 还在，但 toolReferenceNames 缺失
    const events = fx.events.map((ev) =>
      ev.toolResults
        ? { ...ev, toolResults: ev.toolResults.map(({ toolReferenceNames: _, ...rest }) => rest) }
        : ev,
    );
    const { snapshot, linkReport } = attributeWithJsonl({
      reqBody: fx.reqBody,
      proxyFile: "t.json",
      jsonl: events,
      call: { callId: 1, turnId: 1 },
    });
    expect(linkReport.matched.toolReferenceBoundary).toBe(0);

    const boundary = Object.values(snapshot.index).find(
      (n) =>
        n.wireMeta?.messageRole === "user" &&
        n.children.length === 0 &&
        n.rawText === "Tool loaded.",
    );
    // 没有 jsonl 证据 → 保持非 jsonl origin（structural / no_rule）
    expect(boundary?.origin.kind).not.toBe("jsonl");
  });
});

describe("PR 3 — #9 harness injection (Skill SKILL.md → user position)", () => {
  // 完整 Skill 触发链 fixture：assistant.tool_use(Skill) → user.tool_result →
  // user.isMeta=true.text=<SKILL.md body>。proxy reqBody 把后两条合并到一条
  // user message：content=[tool_result(status), text(skill body)]。
  function makeSkillFixture() {
    const toolUseId = "toolu_skill_demo";
    const skillBody =
      "Base directory for this skill: /tmp/.claude/skills/demo\n\n" +
      "# Demo Skill\n\nUse this skill to do demo things. Steps:\n1. Foo\n2. Bar\n";
    const reqBody = {
      system: [
        { type: "text" as const, text: "You are Claude Code, Anthropic's official CLI for Claude." },
        { type: "text" as const, text: "Prelude.\n# Doing tasks\nDo stuff.\n" },
      ],
      tools: [{ name: "Skill", description: "Invoke a skill", input_schema: {} }],
      messages: [
        { role: "user", content: [{ type: "text", text: "用 demo skill 试试" }] },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: toolUseId, name: "Skill", input: { skill: "demo" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: toolUseId, content: "Launching skill: demo" },
            { type: "text", text: skillBody },
          ],
        },
      ],
    };
    const events: LinkableJsonlEvent[] = [
      { lineIdx: 9, type: "user", userText: "用 demo skill 试试" },
      { lineIdx: 10, type: "assistant", toolUses: [{ id: toolUseId, name: "Skill" }] },
      { lineIdx: 11, type: "user", toolResults: [{ toolUseId, contentText: "Launching skill: demo" }] },
      {
        lineIdx: 12,
        type: "user",
        harnessInjection: {
          mechanism: "skill_invocation",
          payload: "skill_md_body",
          rawText: skillBody,
          triggerToolUseId: toolUseId,
        },
      },
    ];
    return { reqBody, events, toolUseId, skillBody };
  }

  it("Skill SKILL.md body 叶子 → JsonlOrigin(source=harness_injection, harness.mechanism=skill_invocation)", () => {
    const fx = makeSkillFixture();
    const { snapshot, linkReport } = attributeWithJsonl({
      reqBody: fx.reqBody,
      proxyFile: "t.json",
      jsonl: fx.events,
      call: { callId: 1, turnId: 1 },
    });
    expect(linkReport.matched.harnessInjection).toBe(1);

    const leaf = Object.values(snapshot.index).find(
      (n) =>
        n.wireMeta?.messageRole === "user" &&
        n.children.length === 0 &&
        n.rawText === fx.skillBody,
    );
    expect(leaf?.origin.kind).toBe("jsonl");
    if (leaf?.origin.kind === "jsonl") {
      expect(leaf.origin.eventKind.source).toBe("harness_injection");
      expect(leaf.origin.jsonlLineIdx).toBe(12);
      expect(leaf.origin.toolUseId).toBe(fx.toolUseId);
      expect(leaf.origin.harness?.mechanism).toBe("skill_invocation");
      expect(leaf.origin.harness?.payload).toBe("skill_md_body");
      expect(leaf.origin.fullyCovered).toBe(true);
      expect(leaf.origin.confidence).toBe("definitive");
    }
  });

  it("没有 harnessInjection 字段（adapter 没识别为 Skill 触发链）时叶子保持 structural", () => {
    const fx = makeSkillFixture();
    // 把 harnessInjection 砍掉 —— 模拟 adapter 没把这条 isMeta text 识别为 Skill harness
    const events = fx.events.map((ev) =>
      ev.harnessInjection ? { lineIdx: ev.lineIdx, type: ev.type } : ev,
    );
    const { snapshot, linkReport } = attributeWithJsonl({
      reqBody: fx.reqBody,
      proxyFile: "t.json",
      jsonl: events,
      call: { callId: 1, turnId: 1 },
    });
    expect(linkReport.matched.harnessInjection).toBe(0);
    const leaf = Object.values(snapshot.index).find(
      (n) =>
        n.wireMeta?.messageRole === "user" &&
        n.children.length === 0 &&
        n.rawText === fx.skillBody,
    );
    expect(leaf?.origin.kind).not.toBe("jsonl");
  });

  // compaction_summary：与 skill_invocation 同结构（authorship=harness），但
  // 没有 triggerToolUseId（不是 tool 调起的，是 autocompact / /compact 触发）。
  it("compaction summary 文本叶子 → harness_injection (mechanism=compaction_summary, payload=conversation_summary, 无 trigger toolUseId)", () => {
    const summaryBody =
      "This session is being continued from a previous conversation that ran out of context. " +
      "The summary below covers the earlier portion of the conversation.\n\n" +
      "Summary:\n1. Did A\n2. Did B\n\nContinued tasks: do C.";
    const reqBody = {
      system: [
        { type: "text" as const, text: "You are Claude Code, Anthropic's official CLI for Claude." },
        { type: "text" as const, text: "Prelude.\n# Doing tasks\nDo stuff.\n" },
      ],
      messages: [{ role: "user", content: [{ type: "text", text: summaryBody }] }],
    };
    const events: LinkableJsonlEvent[] = [
      {
        lineIdx: 0,
        type: "user",
        harnessInjection: {
          mechanism: "compaction_summary",
          payload: "conversation_summary",
          rawText: summaryBody,
          // 无 triggerToolUseId
        },
      },
    ];
    const { snapshot, linkReport } = attributeWithJsonl({
      reqBody,
      proxyFile: "t.json",
      jsonl: events,
      call: { callId: 1, turnId: 1 },
    });
    expect(linkReport.matched.harnessInjection).toBeGreaterThanOrEqual(1);
    const leaf = Object.values(snapshot.index).find(
      (n) =>
        n.wireMeta?.messageRole === "user" &&
        n.children.length === 0 &&
        n.rawText === summaryBody,
    );
    expect(leaf?.origin.kind).toBe("jsonl");
    if (leaf?.origin.kind === "jsonl") {
      expect(leaf.origin.eventKind.source).toBe("harness_injection");
      expect(leaf.origin.harness?.mechanism).toBe("compaction_summary");
      expect(leaf.origin.harness?.payload).toBe("conversation_summary");
      // compaction 路径无 triggerToolUseId
      expect(leaf.origin.toolUseId).toBeUndefined();
    }
  });
});

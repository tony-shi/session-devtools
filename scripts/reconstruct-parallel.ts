#!/usr/bin/env bun
// reconstruct-parallel.ts
// 从 reconstruct.md 提取任务 prompt，并生成可复制的 Claude Code worktree 命令。

import { readFileSync } from "node:fs";
import { join } from "node:path";

interface ReconstructTask {
  id: string;
  number: string;
  title: string;
  section: string;
  prompt: string;
}

const ROOT = join(import.meta.dir, "..");
const DOC_PATH = join(ROOT, "reconstruct.md");

const VALUE_FLAGS = new Set([
  "--baseline",
  "--audit-home",
  "--budget",
  "--model",
  "--effort",
  "--permission-mode",
  "--claude-cmd",
]);

const BATCHES: Record<string, string[]> = {
  "1": ["reconstruct-01-guardrails"],
  "2": ["reconstruct-02-rule-materializer", "reconstruct-03-runtime-snapshot"],
  "3": [
    "reconstruct-04-system-rules",
    "reconstruct-05-tool-rules",
    "reconstruct-06-request-scalars",
  ],
  "4": ["reconstruct-07-audit-fixtures"],
};

function usage(exitCode = 0): never {
  const text = `
用法：
  bun run scripts/reconstruct-parallel.ts list
  bun run scripts/reconstruct-parallel.ts prompt <taskId> [--baseline <runId>]
  bun run scripts/reconstruct-parallel.ts command <taskId> [--baseline <runId>]
  bun run scripts/reconstruct-parallel.ts commands --batch <1|2|3|4> [--baseline <runId>]
  bun run scripts/reconstruct-parallel.ts commands <taskId...> [--baseline <runId>]

常用：
  export RECON_AUDIT_HOME="$PWD/.audit/reconstruct"
  export RECON_BASELINE_RUN_ID="<baselineRunId>"
  export RECON_CLAUDE_CMD='ANTHROPIC_BASE_URL=http://internal-proxy.example:8742 claude --disallowed-tools "WebSearch(*)" --dangerously-skip-permissions'
  bun run scripts/reconstruct-parallel.ts commands --batch 2

说明：
  - command/commands 只打印命令，不执行。
  - RECON_CLAUDE_CMD / --claude-cmd 接收 shell 片段，不是 alias 名；非交互 bash 不展开 zsh alias。
  - worker 命令会设置 CONTEXT_AUDIT_HOME="$RECON_AUDIT_HOME"。
  - worker prompt 会要求 fixture audit 使用 --baseline "$RECON_BASELINE_RUN_ID" --no-update-latest。
`;
  (exitCode === 0 ? console.log : console.error)(text.trim());
  process.exit(exitCode);
}

function readDoc(): string {
  return readFileSync(DOC_PATH, "utf-8");
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseTasks(doc: string): { globalIntro: string; tasks: ReconstructTask[] } {
  const headingRe = /^## Worktree (\d{2})\s+[—-]\s+(.+)$/gm;
  const matches = [...doc.matchAll(headingRe)];
  const globalIntro = matches.length > 0
    ? doc.slice(0, matches[0]!.index).trim()
    : doc.trim();

  const tasks: ReconstructTask[] = [];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!;
    const number = match[1]!;
    const title = match[2]!.trim();
    const start = match.index ?? 0;
    const end = matches[i + 1]?.index ?? doc.indexOf("\n## 合并策略", start);
    const section = doc.slice(start, end > start ? end : undefined).trim();
    const id =
      section.match(/任务名\s+(reconstruct-\d{2}-[a-z0-9-]+)/)?.[1] ??
      `reconstruct-${number}-${slugify(title)}`;
    const prompt = section.match(/### Prompt\s*\n\s*```text\n([\s\S]*?)\n```/)?.[1]?.trim();
    if (!prompt) {
      throw new Error(`任务 ${id} 缺少 ### Prompt 代码块`);
    }
    tasks.push({ id, number, title, section, prompt });
  }
  return { globalIntro, tasks };
}

function findTask(tasks: ReconstructTask[], id: string): ReconstructTask {
  const normalized = id.match(/^\d{2}$/) ? `reconstruct-${id}` : id;
  const task = tasks.find((t) => t.id === id || t.id.startsWith(normalized));
  if (!task) {
    throw new Error(`未知任务：${id}`);
  }
  return task;
}

function getOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function positionalArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("--")) continue;
    out.push(arg);
  }
  return out;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildPrompt(globalIntro: string, task: ReconstructTask, baseline?: string): string {
  const baselineText = baseline ?? "<RECON_BASELINE_RUN_ID>";
  return [
    `你是 Claude Code 非交互 worker，当前任务是 ${task.id}。`,
    "本 prompt 由 develop worktree 的 reconstruct.md 自动生成；如果新 worktree 中尚未包含 reconstruct.md，以本 prompt 内嵌内容为准。",
    [
      "运行约束：",
      "- 不要 commit、push、merge，也不要切换到其它任务分支。",
      "- 不要修改 digest.cfg、.env、用户全局配置或 proxy 原始数据。",
      "- 只修改本任务允许范围内的文件；遇到跨任务依赖缺失时，保守记录阻塞，不要扩大范围。",
      "- fixture/audit 验证必须使用 CONTEXT_AUDIT_HOME 隔离目录，并带 --no-update-latest，避免并行 worker 抢写 latest 指针。",
      `- 如需跑 fixture audit，使用：CONTEXT_AUDIT_HOME="$CONTEXT_AUDIT_HOME" bun run context:audit:fixtures --baseline ${baselineText} --no-update-latest`,
    ].join("\n"),
    "以下是 reconstruct.md 的全局约束：",
    globalIntro,
    "以下是本 worktree 的任务 prompt：",
    task.prompt,
  ].join("\n\n");
}

function buildCommand(task: ReconstructTask, args: string[]): string {
  const baseline = getOption(args, "--baseline") ?? "${RECON_BASELINE_RUN_ID:?先设置 RECON_BASELINE_RUN_ID}";
  const auditHome = getOption(args, "--audit-home") ?? "${RECON_AUDIT_HOME:?先设置 RECON_AUDIT_HOME}";
  const budget = getOption(args, "--budget") ?? "8";
  const effort = getOption(args, "--effort") ?? "high";
  const model = getOption(args, "--model");
  const claudeCmd = getOption(args, "--claude-cmd") ?? process.env.RECON_CLAUDE_CMD ?? "claude";
  const bypass = hasFlag(args, "--bypass");
  const includePermissionFlags = !hasFlag(args, "--no-permission-flags");
  const includeToolFlags = !hasFlag(args, "--no-tool-flags");
  const permissionMode = getOption(args, "--permission-mode") ?? (bypass ? "bypassPermissions" : "acceptEdits");
  const allowedTools = [
    "Read",
    "Edit",
    "MultiEdit",
    "Write",
    "Bash(git *)",
    "Bash(bun *)",
    "Bash(bunx *)",
    "Bash(rg *)",
    "Bash(sed *)",
    "Bash(cat *)",
    "Bash(ls *)",
    "Bash(pwd)",
    "Bash(mkdir *)",
  ].join(",");

  const lines = [
    `CONTEXT_AUDIT_HOME="${auditHome}" \\`,
    `${claudeCmd} -p \\`,
    `  --worktree ${shellQuote(task.id)} \\`,
    `  --name ${shellQuote(task.id)} \\`,
    `  --effort ${shellQuote(effort)} \\`,
    `  --max-budget-usd ${shellQuote(budget)} \\`,
  ];
  if (includePermissionFlags) {
    lines.push(`  --permission-mode ${shellQuote(permissionMode)} \\`);
  }
  if (model) {
    lines.push(`  --model ${shellQuote(model)} \\`);
  }
  if (includeToolFlags && !bypass) {
    lines.push(`  --allowedTools ${shellQuote(allowedTools)} \\`);
  }
  lines.push(
    `  "$(bun run scripts/reconstruct-parallel.ts prompt ${shellQuote(task.id)} --baseline "${baseline}")"`,
  );
  return lines.join("\n");
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") usage(0);

  const { globalIntro, tasks } = parseTasks(readDoc());

  if (command === "list") {
    for (const task of tasks) {
      console.log(`${task.id}\tWorktree ${task.number}\t${task.title}`);
    }
    return;
  }

  if (command === "prompt") {
    const taskId = positionalArgs(rest)[0];
    if (!taskId) usage(1);
    const task = findTask(tasks, taskId);
    console.log(buildPrompt(globalIntro, task, getOption(rest, "--baseline")));
    return;
  }

  if (command === "command") {
    const taskId = positionalArgs(rest)[0];
    if (!taskId) usage(1);
    const task = findTask(tasks, taskId);
    console.log(buildCommand(task, rest));
    return;
  }

  if (command === "commands") {
    const batch = getOption(rest, "--batch");
    const ids = batch ? BATCHES[batch] : positionalArgs(rest);
    if (!ids || ids.length === 0) usage(1);
    for (let i = 0; i < ids.length; i++) {
      const task = findTask(tasks, ids[i]!);
      if (i > 0) console.log("\n# " + "─".repeat(70) + "\n");
      console.log(`# ${task.id}`);
      console.log(buildCommand(task, rest));
    }
    return;
  }

  usage(1);
}

main();

// parseCommandEnvelope —— 把 cli.js 写死的 command 信封（固定模板、确定性 schema）
// 解析成结构化、可读的渲染。用于 IntervalEventRow 的 user:command /
// system:local_command 两类事件。解析失败返回 null，调用方回退到原始 preview。
//
// 输出 shape:
//   - segmentLabel:  body 段标题 ("命令输入" / "命令输出" / "BASH 输入" ...)
//   - segmentContent: 已结构化的可读文本 (XML 标签已剥离)
//   - direction:     "in" = 用户输入；"out" = 命令执行结果
//   - kindLabelOverride: 可选，覆盖头部 kindLabel 让输入/输出在折叠态也能区分

import type { IntervalEvent } from "../../drilldown-types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseCommandEnvelope(ev: IntervalEvent, t: any): {
  segmentLabel: string;
  segmentContent: string;
  direction: "in" | "out";
  kindLabelOverride?: string;
  preview: string;
} | null {
  const raw = ev.contentPreview || "";
  const match = (re: RegExp): string | undefined => {
    const m = raw.match(re);
    return m ? m[1] : undefined;
  };
  if (ev.kind === "user:command") {
    const name = match(/<command-name>([\s\S]*?)<\/command-name>/)?.trim();
    if (name) {
      const msg  = match(/<command-message>([\s\S]*?)<\/command-message>/)?.trim();
      const args = match(/<command-args>([\s\S]*?)<\/command-args>/)?.trim();
      const lines = [`$ ${name}`];
      if (msg && msg !== name)     lines.push(`  description: ${msg}`);
      if (args && args.length > 0) lines.push(`  args: ${args}`);
      return {
        segmentLabel: t("callChain.segmentCmdInput"), segmentContent: lines.join("\n"), direction: "in",
        kindLabelOverride: t("callChain.segmentCmd"), preview: `$ ${name}${msg && msg !== name ? `  (${msg})` : ""}`,
      };
    }
    const bash = match(/<bash-input>([\s\S]*?)<\/bash-input>/)?.trim();
    if (bash != null) {
      return {
        segmentLabel: t("callChain.segmentBashInput"), segmentContent: `$ ${bash}`, direction: "in",
        kindLabelOverride: "bash", preview: `$ ${bash}`,
      };
    }
    return null;
  }
  if (ev.kind === "system:local_command") {
    const stdout = match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
    const stderr = match(/<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/);
    const bashOut = match(/<bash-stdout>([\s\S]*?)<\/bash-stdout>/);
    const bashErr = match(/<bash-stderr>([\s\S]*?)<\/bash-stderr>/);
    const parts: string[] = [];
    if (stdout != null && stdout.trim().length > 0) parts.push(stdout);
    if (stderr != null && stderr.trim().length > 0) parts.push(`stderr:\n${stderr}`);
    if (bashOut != null && bashOut.trim().length > 0) parts.push(bashOut);
    if (bashErr != null && bashErr.trim().length > 0) parts.push(`stderr:\n${bashErr}`);
    if (parts.length > 0) {
      const joined = parts.join("\n\n");
      const first = joined.split("\n")[0] ?? "";
      return {
        segmentLabel: t("callChain.segmentCmdOutput"), segmentContent: joined, direction: "out",
        kindLabelOverride: t("callChain.segmentCmdOutputOverride"), preview: first.slice(0, 120),
      };
    }
    return null;
  }
  return null;
}

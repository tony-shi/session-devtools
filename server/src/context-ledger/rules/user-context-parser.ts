// rules/user-context-parser.ts
//
// 二次解析 messages.user-context.v2 命中的 <system-reminder> userContext block。
// v2 规则只把 `# claudeMd\n` 到 `\n# userEmail` 之间整段抓成 contextBody（外加 userEmail /
// currentDate 两个标量 group）；本模块把 contextBody 拆成结构化子段：
//   preamble（claudeMd 前言）+ 0..N 个 "Contents of <path> (<desc>):" 文件
//   （desc 含 "project instructions" → 项目指令文件；含 "auto-memory" → 持久化记忆 MEMORY.md）。
// 组成可变（CLAUDE.md/AGENTS.md/MEMORY.md 谁缺都行），故按实际 marker 切，有几个算几个。
//
// 与 skill-listing-parser 同形：输入 segment 原文 + 规则命中的捕获组（带 segment 内绝对偏移），
// 输出带绝对 charStart/charEnd 的结构。resolver.buildPayload 调用本函数。
// 旁路模块：不被现有代码 import 时完全无副作用。

export type UserContextKind =
  | "claudemd-preamble" // # claudeMd 后的固定前言（无项目文件时也在）
  | "project-instructions" // CLAUDE.md / AGENTS.md 等项目指令文件（壳 + 正文）
  | "memory" // 持久化记忆 MEMORY.md（壳 + 正文）
  | "context-file" // 其它 "Contents of …" 文件（desc 既非 project 也非 auto-memory）
  | "user-email"
  | "current-date";

export interface UserContextField {
  kind: UserContextKind;
  /** 相对 segment rawText 起点的绝对字符偏移 */
  charStart: number;
  charEnd: number;
  valuePreview: string;
  /** "Contents of <path> (...)" 里的 path（kind=project-instructions/memory/context-file 时） */
  path?: string;
}

export interface UserContextPayload {
  fields: UserContextField[];
}

/** 规则命中的命名捕获组（rule-evaluator 的 DynamicField 子集）。 */
export interface UserContextCapture {
  name: string;
  charStart: number;
  charEnd: number;
}

const PREVIEW_MAX = 120;
function preview(s: string): string {
  return s.length > PREVIEW_MAX ? s.slice(0, PREVIEW_MAX - 1) + "…" : s;
}

function classify(desc: string): UserContextKind {
  if (/auto-memory/.test(desc)) return "memory";
  if (/project instructions/.test(desc)) return "project-instructions";
  return "context-file";
}

/**
 * 从 segment 原文 + 命中的捕获组构造 userContext payload。
 * @param rawText  segment 完整原文（node.rawText）
 * @param captures rule-evaluator 产出的命名捕获（contextBody / userEmail / currentDate），
 *                 各带 segment 内绝对偏移
 */
export function parseUserContextBody(
  rawText: string,
  captures: readonly UserContextCapture[],
): UserContextPayload | undefined {
  const by = new Map(captures.map((c) => [c.name, c]));
  const fields: UserContextField[] = [];

  const cb = by.get("contextBody");
  if (cb) {
    const body = rawText.slice(cb.charStart, cb.charEnd);
    // 定位每个 "Contents of <path> (<desc>):" 文件头
    const re = /Contents of (?<path>[^\n]+?) \((?<desc>[^)]*)\):/g;
    const marks: Array<{ at: number; path: string; desc: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      marks.push({ at: m.index, path: m.groups?.["path"] ?? "", desc: m.groups?.["desc"] ?? "" });
    }
    // preamble = body 开头到第一个文件头（无文件头时为整段）
    const preEnd = marks.length ? marks[0]!.at : body.length;
    if (preEnd > 0) {
      fields.push({
        kind: "claudemd-preamble",
        charStart: cb.charStart,
        charEnd: cb.charStart + preEnd,
        valuePreview: preview(body.slice(0, preEnd)),
      });
    }
    for (let i = 0; i < marks.length; i++) {
      const mk = marks[i]!;
      const end = i + 1 < marks.length ? marks[i + 1]!.at : body.length;
      fields.push({
        kind: classify(mk.desc),
        charStart: cb.charStart + mk.at,
        charEnd: cb.charStart + end,
        valuePreview: preview(body.slice(mk.at, end)),
        path: mk.path,
      });
    }
  }

  const email = by.get("userEmail");
  if (email) {
    fields.push({
      kind: "user-email",
      charStart: email.charStart,
      charEnd: email.charEnd,
      valuePreview: rawText.slice(email.charStart, email.charEnd),
    });
  }

  const date = by.get("currentDate");
  if (date) {
    fields.push({
      kind: "current-date",
      charStart: date.charStart,
      charEnd: date.charEnd,
      valuePreview: rawText.slice(date.charStart, date.charEnd),
    });
  }

  return fields.length > 0 ? { fields } : undefined;
}

// ── 接线（已在 resolver.ts / types.ts 落地）──────────────────────────────────────
// types.ts: SegmentAttributionPayload.userContext?: UserContextPayload
// resolver.ts: USER_CONTEXT_RULE_IDS = {claude-code.messages.user-context.v2};
//   buildPayload() 内：caps = evaluation.dynamicFields.map(f=>({name,charStart,charEnd}));
//   return { userContext: parseUserContextBody(node.rawText, caps) }

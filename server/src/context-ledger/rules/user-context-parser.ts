// rules/user-context-parser.ts
//
// 二次解析 messages.user-context.v2（claude-code.messages.user-context.v2）命中的
// <system-reminder> userContext block，把 named-capture 产出的动态载荷整理成结构化
// 子段，并把 projectInstructions 进一步切成单个 "Contents of <path> (project
// instructions…)" 文件（CLAUDE.md / AGENTS.md）。
//
// 与 skill-listing-parser 同形：输入 segment 原文 + 规则命中的捕获组（带 segment 内
// 绝对偏移），输出带绝对 charStart/charEnd 的结构。resolver.buildPayload 调用本函数。
//
// 旁路模块：不被现有代码 import 时完全无副作用；接线见文件尾部注释。

export type UserContextKind =
  | "project-instructions" // CLAUDE.md / AGENTS.md 等项目指令文件（壳+正文）
  | "memory" // 持久化记忆 MEMORY.md 正文
  | "user-email"
  | "current-date";

export interface UserContextProjectFile {
  /** "Contents of <path> (project instructions…)" 里的 path */
  path: string;
  charStart: number;
  charEnd: number;
}

export interface UserContextField {
  kind: UserContextKind;
  /** 相对 segment rawText 起点的绝对字符偏移 */
  charStart: number;
  charEnd: number;
  valuePreview: string;
  /** memory 的运行时路径（kind=memory 时） */
  path?: string;
  /** projectInstructions 内逐文件切分（kind=project-instructions 时） */
  projectFiles?: UserContextProjectFile[];
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

/**
 * 把 projectInstructions 正文切成逐个项目指令文件。
 * @param body   projectInstructions 组的完整文本（已从 rawText slice）
 * @param offset 该组在 segment rawText 内的起点（用于换算绝对偏移）
 */
function splitProjectFiles(body: string, offset: number): UserContextProjectFile[] {
  const re = /Contents of (?<path>[^\n]+?) \(project instructions[^)]*\):/g;
  const starts: Array<{ path: string; at: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    starts.push({ path: m.groups?.["path"] ?? "", at: m.index });
  }
  return starts.map((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1]!.at : body.length;
    return { path: s.path, charStart: offset + s.at, charEnd: offset + end };
  });
}

/**
 * 从 segment 原文 + 命中的捕获组构造 userContext payload。
 * @param rawText  segment 完整原文（node.rawText）
 * @param captures rule-evaluator 产出的命名捕获（projectInstructions / memoryPath /
 *                 memoryContents / userEmail / currentDate），各带 segment 内绝对偏移
 */
export function parseUserContextBody(
  rawText: string,
  captures: readonly UserContextCapture[],
): UserContextPayload | undefined {
  const by = new Map(captures.map((c) => [c.name, c]));
  const sliceOf = (c: UserContextCapture) => rawText.slice(c.charStart, c.charEnd);
  const fields: UserContextField[] = [];

  const proj = by.get("projectInstructions");
  if (proj) {
    const body = sliceOf(proj);
    fields.push({
      kind: "project-instructions",
      charStart: proj.charStart,
      charEnd: proj.charEnd,
      valuePreview: preview(body),
      projectFiles: splitProjectFiles(body, proj.charStart),
    });
  }

  const memBody = by.get("memoryContents");
  if (memBody) {
    const memPath = by.get("memoryPath");
    fields.push({
      kind: "memory",
      charStart: memBody.charStart,
      charEnd: memBody.charEnd,
      valuePreview: preview(sliceOf(memBody)),
      ...(memPath ? { path: sliceOf(memPath) } : {}),
    });
  }

  const email = by.get("userEmail");
  if (email) {
    fields.push({
      kind: "user-email",
      charStart: email.charStart,
      charEnd: email.charEnd,
      valuePreview: sliceOf(email),
    });
  }

  const date = by.get("currentDate");
  if (date) {
    fields.push({
      kind: "current-date",
      charStart: date.charStart,
      charEnd: date.charEnd,
      valuePreview: sliceOf(date),
    });
  }

  return fields.length > 0 ? { fields } : undefined;
}

// ── 接线说明（需看到原文后在 resolver.ts / types.ts 落地）─────────────────────────
//
// 1) parser/attribution/types.ts — 给 SegmentAttributionPayload 增加可选字段：
//      import type { UserContextPayload } from "../../rules/user-context-parser";
//      export interface SegmentAttributionPayload {
//        skillListing?: ...;          // 既有
//        userContext?: UserContextPayload;   // 新增
//      }
//
// 2) parser/attribution/resolver.ts — 与 skill-listing 同形接入 buildPayload：
//      import { parseUserContextBody } from "../../rules/user-context-parser";
//      const USER_CONTEXT_RULE_IDS = new Set(["claude-code.messages.user-context.v2"]);
//      // buildPayload() 内，skill-listing 分支之后：
//      if (USER_CONTEXT_RULE_IDS.has(rule.ruleId)) {
//        const caps = (evaluation.dynamicFields ?? []).map(f => ({
//          name: f.name, charStart: f.charStart, charEnd: f.charEnd,
//        }));
//        const userContext = parseUserContextBody(node.rawText, caps);
//        return userContext ? { userContext } : undefined;
//      }
//
// 3) 前端按 payload.userContext.fields 渲染子段（展示元数据走后端，不前端硬编码）。

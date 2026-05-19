// skill_listing 正文逐行解析器
//
// 配合 claude-code.messages.skill-listing.v1 rule 使用：
//   rule 的 regex 用 (?<skillsBlock>...) 把 SR 包裹之间的 N 行 "- name: desc"
//   作为整体捕获；本模块负责把这段 body 按行拆成结构化 SkillEntry[]，
//   供 SegmentAttribution.payload.skillListing 透传给前端。
//
// 设计原则（与 rule 一致）：
//   - 只识别 cli.js 真实可能产出的三种行格式：
//       1) full         "- name: description"            （正常预算）
//       2) truncated    "- name: descrip…"           （description 被 cli 截断）
//       3) names_only   "- name"                          （极端预算，无 ": desc"）
//   - 多行 description：SKILL.md 作者可能在 description 里写
//     "TRIGGER when: ..." / "SKIP: ..." 等独立段落，cli.js 不做处理直接连同
//     换行符塞进 listing。这些续行不以 "- " 开头 —— 我们把它们 append 回前一个
//     skill 的 description（用 "\n" 连接），这样 entries 数 = 实际 skill 数。
//   - 解析失败的行保留 rawLine + parseError=true，永不抛错；下游回退 raw 渲染。
//     仅当一行既不是新 skill 也没有可追加的前序 skill 时才标 parseError。
//   - 不做 namespace 拆分（"claude-hud:setup" 整体作为 name 留给前端按需切）。
//   - 不做跨 turn / 跨 session 派生（这是 aggregator 的活，不是 parser 的）。
//
// sourcemap 锚点：
//   restored-src/src/tools/SkillTool/prompt.ts:52-66 formatCommandDescription
//   restored-src/src/tools/SkillTool/prompt.ts:70-160 formatCommandsWithinBudget

export interface SkillEntry {
  /**
   * 该 entry 在 listing 中占据的全部原文（去 trailing \n）。
   * 含续行时为 "- name: head\n续行1\n续行2" 的合并形态，反映 LLM 真实读到的样子。
   */
  rawLine: string;
  /** 解析出的 skill 名；plugin 命名空间形如 "claude-hud:setup" 整体作为 name。null 表示该行解析失败。 */
  name: string | null;
  /**
   * 解析出的描述；names_only 模式或解析失败时为 null。
   * 含续行时描述以 "\n" 连接各段（如 claude-api 的 TRIGGER when / SKIP 段）。
   */
  description: string | null;
  /** true = 该 entry 无法对齐任何已知 skill 行格式；前端应按 rawLine 兜底渲染。 */
  parseError: boolean;
  /** 该 entry 在 segment rawText 中的字符起点（含），指向首行起始。 */
  lineStart: number;
  /** 该 entry 在 segment rawText 中的字符终点（不含），含全部续行。 */
  lineEnd: number;
}

export interface SkillListingPayload {
  entries: SkillEntry[];
  /** 成功解析的行数（parseError=false）。 */
  successCount: number;
  /** 解析失败的行数（parseError=true）。 */
  errorCount: number;
}

// name 允许字母/数字/下划线/连字符，并允许若干段以 ":" 连接（plugin 命名空间）。
// 拒绝 name 起头/收尾的空白与冒号，避免误吃 description 中含冒号的内容。
// description 允许任意非换行字符（包括中文、unicode ellipsis、反引号代码等）。
const FULL_LINE_RE = /^- (?<name>[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)*): (?<description>.+)$/;
const NAMES_ONLY_RE = /^- (?<name>[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)*)$/;

/**
 * 解析 skill_listing 的 body 文本。
 *
 * @param body  rule 的 (?<skillsBlock>...) 捕获到的正文文本，多行用 "\n" 分隔。
 *              形态：N 行，每行 "- name: desc" / "- name: desc…" / "- name"。
 * @param bodyOffsetInSegment  body 在所在 segment rawText 中的字符起点。
 *              用于把每条 entry 的 lineStart / lineEnd 折算为相对 segment 的偏移
 *              （便于前端做高亮）。默认 0（仅本模块单测时不传）。
 */
export function parseSkillListingBody(
  body: string,
  bodyOffsetInSegment: number = 0,
): SkillListingPayload {
  // split("\n") 而非 splitlines：cli.js 用 "\n".join() 拼，不会有 \r。
  // 若末尾意外多了一个 "\n"，最后一个 entry 会是空串；下面用 trim 过滤掉。
  const lines = body.split("\n");
  const entries: SkillEntry[] = [];
  let cursor = 0; // 相对 body 起点的字符偏移

  for (const line of lines) {
    const lineStart = bodyOffsetInSegment + cursor;
    const lineEnd = lineStart + line.length;
    cursor += line.length + 1; // +1 for the "\n" separator

    // 跳过纯空白行（cli.js 不应产出，但容错）
    if (line.trim() === "") continue;

    const fullMatch = FULL_LINE_RE.exec(line);
    if (fullMatch?.groups) {
      entries.push({
        rawLine: line,
        name: fullMatch.groups.name ?? null,
        description: fullMatch.groups.description ?? null,
        parseError: false,
        lineStart,
        lineEnd,
      });
      continue;
    }

    const nameOnlyMatch = NAMES_ONLY_RE.exec(line);
    if (nameOnlyMatch?.groups) {
      entries.push({
        rawLine: line,
        name: nameOnlyMatch.groups.name ?? null,
        description: null, // names_only 模式，cli.js 没塞 description
        parseError: false,
        lineStart,
        lineEnd,
      });
      continue;
    }

    // 既不是 full 也不是 names_only —— 是续行（前序 skill description 跨多行），
    // 还是真正的解析失败？规则：若上一个 entry 存在且解析成功，就把本行 append
    // 到它的 description（用 "\n" 连接），并扩展 rawLine / lineEnd。否则才标 parseError。
    const prev = entries[entries.length - 1];
    if (prev && !prev.parseError) {
      prev.rawLine = prev.rawLine + "\n" + line;
      prev.description = prev.description == null ? line : prev.description + "\n" + line;
      prev.lineEnd = lineEnd;
      continue;
    }

    // 没有可挂的前序 entry —— 这是真正的孤立异常行（cli.js 不应产出，防御性兜底）。
    entries.push({
      rawLine: line,
      name: null,
      description: null,
      parseError: true,
      lineStart,
      lineEnd,
    });
  }

  const successCount = entries.filter(e => !e.parseError).length;
  const errorCount = entries.length - successCount;

  return { entries, successCount, errorCount };
}

// rule-corpus/index.ts
//
// loadCorpus():扫 rule-corpus/{rules,exclusions,manifests}/*.md → 解析 + 校验 → 输出。
//
// MD 文件结构约定:
//   ---
//   <YAML frontmatter,符合 RuleSchema/ExclusionsSchema/VersionManifestSchema>
//   ---
//
//   ## pattern  (仅 rules/ 文件需要,且 frontmatter.attribution.patternFromBody=true 时)
//
//   ```regex
//   <pattern 字符串,multiline,无转义包袱>
//   ```
//
// 设计要点:
//   - frontmatter 放结构化元数据,YAML;body 放 pattern,fenced code block。
//   - body 抽 pattern 时,只认第一个 fenced code block(语言标签 regex/exact/prefix 任意,
//     用 frontmatter.attribution.matchMode 决定语义)。
//   - 空 corpus(无文件)合法,输出空数组。Phase 1 阶段就是这个状态。

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import {
  RuleSchema,
  type Rule,
} from "./schema";

// ESM-compatible __dirname(package.json type=module)
const CORPUS_ROOT = dirname(fileURLToPath(import.meta.url));  // server/src/context-ledger/rule-corpus

const RULES_DIR = join(CORPUS_ROOT, "rules");

// 从 MD body 抽 pattern。
// 解析契约(防 P1-2 嵌套 fence 截断):
//   - opening fence  = "## pattern" header 之后的**第一个** ```<lang>\n
//   - closing fence  = 文件末尾的**最后一个** \n```(允许 pattern 内含嵌套 ``` markdown 例子)
//   - 若文件不含 "## pattern" header,fallback 到 body 第一个 ``` 作 open
//   - trailingNewlines 处理:trim body 末尾所有 \n,再由 caller 按 frontmatter.trailingNewlines 追加
function extractPatternFromBody(body: string, filePath: string): string {
  const headerIdx = body.indexOf("## pattern");
  const searchFrom = headerIdx >= 0 ? headerIdx : 0;
  const openRe = /```[a-zA-Z]*\n/;
  const openMatch = openRe.exec(body.slice(searchFrom));
  if (!openMatch) {
    throw new Error(
      `[corpus] ${filePath}: patternFromBody=true 但 body 里没找到 pattern 围栏开始;` +
      `请用 \`\`\`regex / \`\`\`exact / \`\`\`text 等围栏包裹 pattern。`,
    );
  }
  const patternStart = searchFrom + openMatch.index + openMatch[0].length;
  // closing = 文件最末一个 \n```(允许 pattern 含嵌套 ```)
  const closeIdx = body.lastIndexOf("\n```");
  if (closeIdx < patternStart) {
    throw new Error(
      `[corpus] ${filePath}: pattern 围栏未闭合或位置错乱(open 在 ${patternStart},last close 在 ${closeIdx})。`,
    );
  }
  return body.slice(patternStart, closeIdx).replace(/\n+$/, "");
}

function listMdFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => join(dir, name));
}

/** 加载一条 rule MD 文件 → 已校验 Rule 对象。 */
export function loadRuleFile(filePath: string): Rule {
  const raw = readFileSync(filePath, "utf8");
  const { data, content } = matter(raw);

  const parsed = RuleSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(
      `[corpus] ${filePath} frontmatter 不通过 schema:\n${parsed.error.message}`,
    );
  }
  const fm = parsed.data;

  let pattern: string | null = null;
  if (fm.attribution.patternFromBody) {
    const body = extractPatternFromBody(content, filePath);
    pattern = body + "\n".repeat(fm.attribution.trailingNewlines);
  }

  return { ...fm, pattern, filePath };
}

/** 加载所有 rules/*.md 文件。空目录合法,返回 []。
 *  排序契约(防 catch-all 抢匹配):
 *    1. priority 降序(高优先级在前;catch-all priority=-100 自动落最后)
 *    2. 同 priority 内 filePath 字典序(稳定 tiebreaker,跨 FS 一致)
 *  下游 runtime first-match 直接消费此顺序。 */
export function loadAllRules(): Rule[] {
  const rules = listMdFiles(RULES_DIR).map(loadRuleFile);
  rules.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0;
  });
  return rules;
}

/** 一次性加载整个 corpus(供 generator 使用)。
 *  注:Piebald exclusions/manifests 已脱钩(corpus 改 proxy + cli.js binary 自维护),
 *  corpus 现在只含 rules。 */
export interface CorpusSnapshot {
  rules: Rule[];
}

export function loadCorpus(): CorpusSnapshot {
  return {
    rules: loadAllRules(),
  };
}

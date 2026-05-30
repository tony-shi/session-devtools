// rule-corpus/schema.ts
//
// corpus rule 的 zod schema(单一真值)。
//
// rule 维护真值 = proxy 实际文本 + cli.js binary(固化性/版本),不再依赖 Piebald。
// `sourceUnits` 字段保留为「可选文档性参考」—— 偶尔标注某 rule 对应 Piebald 哪个
// source unit(加强理解),不参与任何 gate / 校验(Piebald 对照机制已脱钩)。

import { z } from "zod";

// ── Rule 子结构 ───────────────────────────────────────────────────────────────

// 与 rules/rule-registry.ts 的 RuleMatchMode 完全一致(corpus 接受全部 5 值)。
// "structural" 用于 tool_result / wire 协议级 rule(category=tool_result),不靠文本 pattern。
// "contains" 保留兼容(legacy 数据少量使用)。
export const RuleMatchMode = z.enum(["exact", "prefix", "regex", "contains", "structural"]);
export type RuleMatchMode = z.infer<typeof RuleMatchMode>;

export const RuleMaterialization = z.enum([
  "exact_text",
  "normalized_text",
  "shape",
  "presence",
  "unavailable",
]);
export type RuleMaterialization = z.infer<typeof RuleMaterialization>;

// 明确二元(用户要求:不接受模糊的 semi-static)。判据 = 内容可复现性(NOT 会话内时间稳定):
//   static  = 完全固定文本,任何用户/项目/时间/会话下逐字一样,可 exact 复现
//             (identity / harness / prelude / session-guidance / tool schema)
//   dynamic = 含运行时插值值(路径/cwd/日期/git/用户数据)或每次重新生成
//             (memory ← memoryPath / environment ← cwd / git-status / billing ← fingerprint)
// 注意:判据是"能否跨环境逐字复现",不是"同一会话内是否变"。memory 的 memoryPath 在
//   同一会话内不变,但它是 {home}/.claude/projects/<项目>/memory/ 运行时插值——换用户/项目
//   就变,故 dynamic。含动态字段的段用 Rule.dynamicSource 说明"变的是哪部分",保留二元的
//   同时不丢"主体是固定指令"的信息。
export const RuleStability = z.enum(["static", "dynamic"]);
export type RuleStability = z.infer<typeof RuleStability>;

// sourceUnit relation —— 该 rule 对应的 Piebald source unit 与运行时字节的关系。
// 纯文档性标注(Piebald 对照机制已脱钩,不再有 drift 校验)。
export const SourceRelation = z.enum([
  "exact",            // Piebald 文本与运行时字节逐字相等
  "template",         // Piebald 含 ${var},运行时是变量替换后的字面
  "partial",          // pattern 锚定 Piebald 一段稳定前缀,正文动态
  "runtime-derived",  // CLI 端从多个 Piebald 单元拼/选/条件产出,Piebald 不直接列出
]);
export type SourceRelation = z.infer<typeof SourceRelation>;

// 可选文档性参考:标注某 rule 偶尔对应的 Piebald source unit(加强理解,不参与校验)。
export const RuleSourceUnitRef = z.object({
  unitId: z.string(),         // Piebald unit basename(去 .md)
  relation: SourceRelation,
});

// VersionPredicate —— 复刻 server/src/context-ledger/version.ts 的 VersionPredicate
// (corpus 不能 import 运行时模块以避免循环;在 generator 时再 cast)。
export const VersionPredicate = z.union([
  z.object({ minCcVersion: z.string() }),
  z.object({ maxCcVersion: z.string() }),
  z.object({ range: z.tuple([z.string(), z.string()]) }),
  z.object({ exactCcVersions: z.array(z.string()) }),
]);
export type VersionPredicate = z.infer<typeof VersionPredicate>;

export const NoteTemplate = z.object({
  format: z.string(),
  requireGroup: z.string().optional(),
  absentGroup: z.string().optional(),
});

// Confidence —— 与 types.ts 的 Confidence 对齐(corpus 只允许 override 三档)。
export const ConfidenceOverride = z.enum(["definitive", "estimated", "inferred", "unknown"]);

// ── L3: Rule(corpus 文件 frontmatter 解码后的产物)─────────────────────────────

export const RuleSchema = z.object({
  // 标识与定位
  ruleId: z.string(),
  // slotId 大多是单值;少数 rule(如 away-summary)绑定多个槽,允许数组形态
  slotId: z.union([z.string(), z.array(z.string()).min(1)]),

  // 版本/校对
  verifiedFor: z.string().nullable(),
  appliesTo: VersionPredicate.optional(),

  // 可选文档性参考:偶尔标注对应的 Piebald source unit(加强理解,不参与校验)。
  sourceUnits: z.array(RuleSourceUnitRef).default([]),

  // 元数据(平移自 ContextLedgerRule)
  description: z.string(),
  stability: RuleStability,
  sourcemapRef: z.string().optional(),
  queryScope: z.enum(["main_session", "side_query", "any"]).optional(),
  materialization: RuleMaterialization.optional(),

  // ── 用户向展示元数据(透出到前端 SerializedNode,供 attribution 面板做"导览"展示)──
  // displayName:人类可读的段名（如"记忆"/"环境"），替代晦涩的 slotType slug。
  // summary:一句话解读（告诉用户这段在 system prompt 里干什么），用户向、非技术。
  // dynamicSource:仅 stability=dynamic 段填写——说明"变的是哪部分"
  //   （如 environment 的 "date + git 分支/改动文件"；billing 的 "cc_version + attestation"）。
  // stability 在本系统按"时间维度"语义:static=逐字永不变 / semi-static=模板化跨请求稳定
  //   / dynamic=每轮或每次真变。区别于 materialization（内容能否逐字复现）。
  displayName: z.string().optional(),
  summary: z.string().optional(),
  dynamicSource: z.string().optional(),

  // priority:候选评估时显式优先级。runtime first-match 取按 priority 降序的首条。
  // 约定:
  //   - 默认 0(具名 rule)
  //   - catch-all rule(空泛 prefix 如 "<system-reminder>") 显式赋 -100,保证排在最后
  //   - 极高优先级(如 exact 全文匹配优先于 prefix)可赋 +10/+100
  // 同 priority 内按 filename 字典序为稳定 tiebreaker。
  priority: z.number().int().default(0),

  // attribution 主体(pattern 从 body 抽出,frontmatter 不放 pattern 文本)
  attribution: z.object({
    // pattern 由 body 的 fenced code block 提供;null 表示 attribution 不靠 pattern 匹配
    // (如某些结构性 rule);frontmatter 用 patternFromBody=false 显式声明 null。
    patternFromBody: z.boolean().default(true),
    // exact matchMode 时 pattern 末尾 \n 在 MD 里不可见 → 此字段显式声明:
    // loader 先 trim body 末尾所有 \n,然后追加 N 个 \n。默认 0。
    // 仅对 exact 严格生效;regex/prefix/contains 自行控制结尾,通常留默认 0。
    trailingNewlines: z.number().int().nonnegative().default(0),
    matchMode: RuleMatchMode,
    mechanism: z.string(),
    category: z.string(),  // 与 SegmentCategory 对齐(corpus 不导入运行时枚举,字符串校验)
    captureGroups: z.record(z.string(), z.string()).optional(),
    notesTemplate: z.array(NoteTemplate).optional(),
    confidenceOverride: ConfidenceOverride.optional(),
  }),
});
export type RuleFrontmatter = z.infer<typeof RuleSchema>;

// 解码后的完整 Rule(frontmatter + body 抽取的 pattern)
export interface Rule extends RuleFrontmatter {
  // 来自 body fenced code block(matchMode=regex/exact/prefix/contains 时必填,除非 patternFromBody=false)
  pattern: string | null;
  // 来自文件相对路径(便于错误信息回链)
  filePath: string;
}

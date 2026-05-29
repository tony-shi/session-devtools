// Context Ledger Rule Registry
//
// 每条 rule 只承担一个职责：attribution —— 如何从 proxy segment 识别它是什么。
//   - pattern / matchMode / mechanism / category 由 attribution 子对象描述。
//   - materialization 顶层字段说明命中后可重建到什么程度（exact_text / shape / presence / ...）。
//
// 旧的 reconstruction / reconciliation / tailInjection / attribution.location 字段
// 已于 audit 重整时移除（PR4）；旧链路代码归档在 server/src/context-ledger/_archive/。
// 历史细节见 git history。
//
// ── 版本策略 ─────────────────────────────────────────────────────────────────
// 我们只针对**当前实际安装**的一个 Claude Code 版本维护 rule，不做跨版本兼容。
// 当前目标版本 = SUPPORTED_CLAUDE_CODE_VERSION（见下方常量）。
// 校对来源优先级：
//   P0 事实：~/.api-dashboard/proxy/traffic.jsonl 的 dump + 本地 cli.js（grep 验证）
//   P1 参考：claude-code-sourcemap 还原源码 / survey 文档
//
// 字段说明：
//   verifiedFor: SUPPORTED_CLAUDE_CODE_VERSION → 已对照当前版本人工校对通过
//   verifiedFor: null                          → 待人工校对（命中时 confidence 强制降为 inferred）
//
// 新增/修订流程：
//   1. 在本地安装的 cli.js 里 grep 目标字段，确认当前版本的真实文本
//   2. 在 proxy dump 里找 ≥1 条样本验证 pattern
//   3. PR 人工 review，校对通过后将 verifiedFor 设为 SUPPORTED_CLAUDE_CODE_VERSION
//   4. 升级 SUPPORTED_CLAUDE_CODE_VERSION 时，所有 verifiedFor 必须重新清零并逐条复审
// ────────────────────────────────────────────────────────────────────────────

import type {
  Confidence,
  SegmentCategory,
  RuleMechanism,
} from "../types";

// Corpus-managed rules(Phase 2 起逐条迁移;rule-registry.ts 此处只保留尚未迁的常量 +
// 数组顺序拼装)。corpus 单一真值见 ../rule-corpus/。
// (CORPUS_LEDGER_RULES_BY_ID 在文件后部的"corpus 全量获取"区一并 import,这里不重复)

// 当前唯一支持的 Claude Code 版本。改这里时必须同步把所有 rule 的 verifiedFor 清零并重新人工校对。
export const SUPPORTED_CLAUDE_CODE_VERSION = "2.1.126";

// ── 类型定义 ──────────────────────────────────────────────────────────────────

export type RuleStability = "static" | "semi-static" | "dynamic";

// regex：pattern 是正则表达式字符串，attribution 用 new RegExp(pattern).test(text)；
//   captureGroups 提供结构化命名组语义，attribution 可提取动态字段到 metadata。
export type RuleMatchMode = "exact" | "prefix" | "contains" | "structural" | "regex";

// materialization：rule 命中后能给出多强的"内容可重建"语义。
//   exact_text      — 文本固定，可完整复现（如 identity prefix）
//   normalized_text — 文本有微小变体，可规范化后复现
//   shape           — 只能复现结构/轮廓
//   presence        — 只能确认"有这段"，内容不可预测（如含 fingerprint 的 header）
//   unavailable     — 无法从 JSONL/harness 推断任何内容
export type RuleMaterialization =
  | "exact_text"
  | "normalized_text"
  | "shape"
  | "presence"
  | "unavailable";

export interface ContextLedgerRule {
  ruleId: string;
  // 已对照 SUPPORTED_CLAUDE_CODE_VERSION 人工校对通过的版本号；null = 待校对。
  // 必须严格等于 SUPPORTED_CLAUDE_CODE_VERSION 才视为 verified；
  // 任何其它字符串（如旧版本号）等同于 null，audit 报告会列入"待校对"。
  verifiedFor: string | null;
  description: string;
  stability: RuleStability;
  sourcemapRef?: string;

  // 用户向展示元数据(透出到 SerializedNode.ruleMeta,供 attribution 面板"导览"展示)。
  // displayName:人类可读段名;summary:一句话解读;dynamicSource:仅 dynamic 段,说明变的是哪部分。
  displayName?: string;
  summary?: string;
  dynamicSource?: string;

  // queryScope：此 rule 适用的 query 类型。
  // "main_session" — 只匹配主对话（tools > 0, messages > 1）
  // "side_query"   — 只匹配 side query（tools = 0, messages = 1）
  // "any"          — 匹配所有 query（未指定时默认）
  queryScope?: "main_session" | "side_query" | "any";

  // appliesTo：cc_version 版本谓词。缺省 = 所有版本都尝试（行为不变）。
  // 标了此字段的 rule 只在 AttributionContext.ccVersion 满足谓词时才进入候选集；
  // 用于内容/打包形态在不同 cc_version 间有真实差异的场景（如 tone-style v0/v1）。
  appliesTo?: import("../version").VersionPredicate;

  // materialization：命中后能复现到什么程度（PR4 起从 reconstruction 块提升到顶层）。
  materialization?: RuleMaterialization;

  // attribution：proxy → 识别视角
  attribution?: {
    pattern: string | null;
    matchMode: RuleMatchMode;
    mechanism: RuleMechanism;
    category: SegmentCategory;
    // matchMode=regex 时，列出 pattern 中命名捕获组的语义说明。
    captureGroups?: Record<string, string>;
    // notes 模板：attribution 主流程根据此字段渲染 notes，不再用 ruleId 硬编码。
    // format 中 {groupName} 会被捕获组值替换；
    // requireGroup：指定的组必须命中才生成此 note；
    // absentGroup：指定的组缺失时才生成此 note。
    notesTemplate?: Array<{
      format: string;
      requireGroup?: string;
      absentGroup?: string;
    }>;
    // 覆盖 confidence 计算（用于 SESSION_GUIDANCE_EMBEDDED 等特殊 rule）。
    confidenceOverride?: Confidence;
  };
}

// ── 首批已人工确认的 rule ──────────────────────────────────────────────────────

// 历史 sourcemap 注释见 git history(commit 前 rule-registry.ts 111-152)。

// ── 动态 system section rules ─────────────────────────────────────────────────
//
// sourcemap 确认（restored-src/src/constants/prompts.ts:491-555）：
// resolvedDynamicSections 包含以下 section（均在 SYSTEM_PROMPT_DYNAMIC_BOUNDARY 之后）：
//   - getSessionSpecificGuidanceSection()  → "# Session-specific guidance"（条件：有工具/skills 时）
//   - computeSimpleEnvInfo()               → "# Environment"（无条件，每次都有）
//   - getLanguageSection()                 → "# Language"（条件：settings.language 有值时）
//   - loadMemoryPrompt()                   → "# auto memory"（条件：有 memory 文件时）
//
// attribution 机制说明：
//   attribution 不通过文本 pattern 匹配这些 section——而是通过 parser 产出的
//   segment.metadata.sectionHeader 精确判断（sectionHeader ∈ DYNAMIC_SECTION_HEADERS）。
//   每条 rule 的 attribution.pattern 用于记录该 section 的文本特征，但实际运行时
//   attribution 代码直接比对 sectionHeader 字符串，不调用 matchesRulePattern。
//   这比 contains 匹配更精确：sectionHeader 由 splitter 从行首 h1 提取，不会误命中。
//
// reconstruction 视角：各 section 内容均为运行时动态生成，不可精确复现：
//   - Session-specific guidance：依赖 enabledTools、skillToolCommands 等运行时状态
//   - Environment：依赖 cwd、model、git status、platform 等每次变化
//   - Language：依赖 settings.language
//   - auto memory：依赖 memory 文件内容（用户数据）
//
// 拆分为独立 rule 的原因：
//   每个 section 有不同的触发条件（preCondition）、不同的内容结构、
//   不同的 reconciliation 策略——合并为一条会丢失这些语义区分。

// ── # Session-specific guidance ───────────────────────────────────────────────
//
// getSessionSpecificGuidanceSection(enabledTools, skillToolCommands) — prompts.ts:352-400
//
// 结构分析（sourcemap 确认）：
//   bullet 1（条件：!getIsNonInteractiveSession()）：固定文本，CLI 交互模式总是出现
//   bullet 2（条件：hasAgentTool + !isForkSubagentEnabled()）：getAgentToolSection() 非 fork 分支，固定文本
//   bullet 3（条件：hasAgentTool + areExplorePlanAgentsEnabled() + !isForkSubagentEnabled()）：
//     含 ${searchTools} 插值，external CLI（hasEmbeddedSearchTools()=false）固定为 "the Glob or Grep"
//   bullet 4（条件：hasSkills）：固定文本
//
// ant-native 变体（searchTools="find/grep via the Bash tool"）已删除：
//   hasEmbeddedSearchTools()=true 仅 Anthropic 内部构建设置，我们的 proxy 场景永远不会触发。
//   fixture 已改为从真实 external CLI 会话（session-dashboard 主 worktree）录制，
//   ant-native 变体不再有对应的 proxy 样本，保留 rule 只会干扰 attributionOnlyCoverage 统计。

// ── # Environment ──────────────────────────────────────────────────────────────
//
// computeSimpleEnvInfo(modelId) — prompts.ts:651-710
//
// 结构分析（sourcemap 确认）：
//
// 固定 header（始终固定）:
//   "# Environment\n"
//   "You have been invoked in the following environment: \n"
//
// 动态 bullet 顺序（prependBullets + envItems 数组）:
//   " - Primary working directory: {cwd}"          ← getCwd()
//   "  - This is a git worktree..."                 ← 条件出现（getCurrentWorktreeSession() !== null）
//   "  - Is a git repository: {isGit}"             ← getIsGit()（数组传入 → 两格缩进）
//   " - Platform: {platform}"                      ← env.platform（'darwin'/'win32'/'linux'）
//   " - Shell: {shell}"                            ← getShellInfoLine()（win32 追加 suffix）
//   " - OS Version: {unameSR}"                     ← getUnameSR()
//   " - You are powered by {modelDesc}"            ← getMarketingNameForModel(modelId)
//   " - Assistant knowledge cutoff is {cutoff}."  ← getKnowledgeCutoff(modelId)（各模型固定常量）
//   " - The most recent Claude model family is {modelFamily}..."  ← CLAUDE_4_5_OR_4_6_MODEL_IDS（半固定, @[MODEL LAUNCH] 更新）
//   " - Claude Code is available as a CLI..."      ← 完全固定常量
//   " - Fast mode for Claude Code uses {frontierModel}..."  ← FRONTIER_MODEL_NAME（半固定）
//
// 之后 appendSystemContext(systemPrompt, systemContext) 追加 gitStatus（query.ts:450）:
//   "\nWhen working with tool results..."           ← 固定说明文
//   "\ngitStatus: ..."                             ← 动态（git status、branch、commits）
//
// attribution: 用 regex 锚定固定结构 + captureGroups 提取动态字段。
// worktree bullet 条件出现，无法精确匹配 → regex 是唯一选择。
//
// fixture 验证（text[26311:27912]）：以下 regex 完全匹配确认。
// ── # auto memory ──────────────────────────────────────────────────────────────
//
// loadMemoryPrompt() → buildMemoryLines('auto memory', memoryDir) — memdir.ts:419, 484
//
// 结构分析（sourcemap 确认，memdir.ts:199-266 + memoryTypes.ts）：
//
//   动态字段（唯一）：
//     memoryDir = getAutoMemPath()
//       默认路径：~/.claude/projects/{sanitized-cwd}/memory/
//       sanitized-cwd：工作目录路径中的 / 替换为 -
//       例：/Users/x/Documents/session-dashboard → -Users-x-Documents-session-dashboard
//       可被 CLAUDE_CODE_REMOTE_MEMORY_DIR 或 settings.autoMemoryPath 覆盖
//
//   静态段（全部固定常量）：
//     DIR_EXISTS_GUIDANCE（memdir.ts:116）："This directory already exists — write to it directly..."
//     TYPES_SECTION_INDIVIDUAL（memoryTypes.ts:113）："## Types of memory" + XML 类型定义
//     WHAT_NOT_TO_SAVE_SECTION（memoryTypes.ts:183）："## What NOT to save in memory"
//     WHEN_TO_ACCESS_SECTION（memoryTypes.ts:216）："## When to access memories"
//     TRUSTING_RECALL_SECTION（memoryTypes.ts:240）
//     howToSave：skipIndex=false 时含 ENTRYPOINT_NAME='MEMORY.md'、MAX_ENTRYPOINT_LINES=200（常量）
//     "## Memory and other forms of persistence"
//
//   条件段：
//     "## Searching past context"：feature flag tengu_coral_fern，默认 false，通常不出现
//
// 存储位置：完全在本地文件系统，不上传到 Anthropic 服务器。
//   路径在 proxy 可观测（从 memoryDir 字段读取），是用户私有数据。
//
// 收紧策略：
//   pattern 用 regex 精确锚定固定 prefix（header + memoryDir 前的固定文字），
//   captureGroups 提取 memoryDir 供 attribution notes 展示。
//   固定部分（TYPES_SECTION 等）虽然很长，但完全静态，可用 prefix match 验证存在。
//   完整内容因含用户私有路径，comparePolicy 用 normalized_hash（路径部分 normalize）。

// ── # VSCode Extension Context section ────────────────────────────────────────
//
// 来源：VSCode 扩展 anthropic.claude-code 2.1.142, extension.js:800（变量 N64）。
// 注入方式：扩展端 `systemPrompt: { preset: "claude_code", append: N64 }`
//   无条件追加；CLI harness 对此段无感知。
//
// 与 harness_injection 的区别：
//   - 触发条件：仅 VSCode 扩展发起的请求才有；CLI 直接调用、其他客户端不出现
//   - 注入侧：扩展端在 SDK 调用前 append，不属于 CLI harness 行为
//   → 用独立 category `ide_injection` 区分
//
// 稳定性：完全静态。形如 `[filename.ts](src/filename.ts)` 看似占位符，
//   实为文档里的字面示例；无模板变量、无条件分支。
//
// 注意原文特征（保持精确匹配）：
//   - "from the root of  the user's workspace" 中 "of  the" 是**两个空格**（扩展原文）
//   - "DO NOT USE backtickets `" 含一个未配对的反引号（扩展 template literal 里写作 \`）

// (旧 DYNAMIC_SECTION_RULE 别名已随 environment 迁移到 corpus 而移除)

// ── Registry 导出 ────────────────────────────────────────────────────────────

// ── billing noise rule ────────────────────────────────────────────────────────
//
// sourcemap 确认（restored-src/src/constants/system.ts:73-95）：
//
// getAttributionHeader(fingerprint) 构建格式：
//   x-anthropic-billing-header: cc_version=<semver>.<fingerprint>; cc_entrypoint=<entrypoint>;[ cch=<token>;][ cc_workload=<tag>;]
//
// 字段语义：
//   cc_version    — <semver>.<fingerprint>，fingerprint 由当前 turn 消息内容 hash 计算（每次不同）
//   cc_entrypoint — CLAUDE_CODE_ENTRYPOINT env，如 "cli"（进程级固定）
//   cch           — attestation token，NATIVE_CLIENT_ATTESTATION feature 开启时出现；
//                   Claude Code HTTP stack 将占位符 "00000" 替换为真实 hash（每次不同）
//   cc_workload   — 可选，cron 等特殊 workload 场景注入，普通交互请求不出现
//
// 注入位置（唯一合法来源，sourcemap 确认）：
//   system[0]：主请求路径（claude.ts:1360）通过 getAttributionHeader() 主动注入，
//   cacheScope: null。harness 保证每次请求在此位置注入一次，不在其他位置注入。
//
// messages 里出现相同文本不命中此 rule：
//   messages 里的 billing header 字符串是集成逻辑（sideQuery、subagent 等）传入的
//   历史内容意外携带，不是 harness 在当前请求主动注入的结果。
//   attribution 不应对其生效——正确行为是 fall through 为普通 user_message。
//   rule 的 section=system 约束确保这一点。
//
// 稳定性：dynamic（fingerprint 和 cch 每次请求都变，内容不可复现）
//
// attribution 视角：
//   - pattern：以 "x-anthropic-billing-header:" 开头（前缀匹配）
//   - location.section = "system"：严格限定，messages 里相同文本不命中
//
// reconstruction 视角：
//   - trigger = always_per_query（每次请求无条件注入）
//   - materialization = presence（fingerprint/cch 动态生成，内容不可复现）
//
// reconciliation 视角：
//   - comparePolicy = known_noise（不计入 coverage 分子，直接归入 known_noise finding）
//   - exactTextExpected = false（动态字段）
// ── 静态 system prompt body rules ────────────────────────────────────────────
//
// 以下 rules 覆盖 getSystemPrompt() 返回的静态段（BOUNDARY 之前）。
// 每条 rule 对应一个 section，attribution 用 pattern 识别，
// reconciliation 用 contentPattern 做精确对账（comparePolicy: raw_hash）。
//
// 来源：restored-src/src/constants/prompts.ts
//
// ── Intro section（两条互斥 rule）─────────────────────────────────────────────
//
// getSimpleIntroSection(outputStyleConfig) 有两个变体：
//   standard：    outputStyleConfig === null（默认模式）
//   output-style：outputStyleConfig !== null（用户配置了输出风格）
//
// 两条 rule attribution 侧各有独立 pattern，proxy rawText 命中哪条是哪条。
// reconstruction 侧用 preCondition 区分：reconstructor 根据 harness state 只激活一条。
//
// 注意：CYBER_RISK_INSTRUCTION（cyberRiskInstruction.ts:24）是 Safeguards 团队维护的
// 常量，目前内容固定，但可能随版本更新。contentPattern 包含其当前值，如有变化需更新 rule。

// ── # System section ──────────────────────────────────────────────────────────
//
// getSimpleSystemSection() — prompts.ts:186-197
// 完全静态：6 条固定 bullet + getHooksSection() 固定字符串，无条件分支。

// ── # Doing tasks section ─────────────────────────────────────────────────────
//
// getSimpleDoingTasksSection() — prompts.ts:199-253
//
// 条件分支说明：
//   USER_TYPE === 'ant'：追加 4 条注释相关 bullet + 2 条 assertiveness/false-claims bullet。
//   USER_TYPE !== 'ant'（external）：这些 bullet 全部不出现。
//   MACRO.ISSUES_EXPLAINER：编译期宏，external build 展开为 GitHub issues URL。
//
// 关于 ant 用户：
//   `USER_TYPE === 'ant'` 是 Anthropic 内部编译期常量（build-time --define），
//   external build 永远不走 ant 分支。我们的 proxy 捕获的是 external 用户请求，
//   不会观测到 ant 分支文本——此 rule 的 `preCondition` 已标注此约束。
//
// 版本说明：
//   fixture 里观测到的文本（含 "exploratory questions"、"Prefer editing" 等 bullet）
//   和当前 sourcemap（2.1.123）的 items 数组不完全一致——fixture 版本较旧。
//   此 rule 对应 fixture 观测版本，标注 ruleVersion="<2.1.123"。
//   当前版本的 doing tasks 内容改动较大（移除了 exploratory questions 等），
//   如有新版 fixture 需另建 rule。

// ── # Using your tools section ────────────────────────────────────────────────
//
// getUsingYourToolsSection(enabledTools) — prompts.ts:269-314
//
// 条件分支说明：
//   taskToolName：取 enabledTools 中 TaskCreate 或 TodoWrite（优先 TaskCreate）。
//     存在时追加"Break down and manage your work with the {taskToolName} tool..."bullet。
//     fixture 里此 bullet 不存在——说明当时请求的工具集里没有这两个工具（或版本不同）。
//   isReplModeEnabled()：REPL 模式下内容完全不同（仅 taskTool bullet）。
//   hasEmbeddedSearchTools()：ant internal build 时 Glob/Grep 不存在，bullet 变少。
//   外部普通 CLI 模式（我们的 proxy 捕获的场景）：非 REPL，非 embedded，非 ant。
//
// 版本说明：
//   fixture 里的文本（"Prefer dedicated tools over Bash..."等）和当前 sourcemap
//   不完全一致——fixture 版本是旧版。当前 sourcemap 的第一条 item 是
//   "Do NOT use the Bash tool..."，与 fixture 不同。
//   此 rule 对应 fixture 观测版本，标注 ruleVersion="<2.1.123"。
//
// 关于 ant 用户：同 doing tasks，ant 分支不会出现在 external proxy 捕获的请求里。

// ── # Executing actions with care section ─────────────────────────────────────
//
// getActionsSection() — prompts.ts:255-267
// 完全静态：单一固定字符串，无任何条件分支。

// ── # Output efficiency section ───────────────────────────────────────────────
//
// ⚠️  STALE RULE — 2.1.126 binary 及真实 proxy dump 确认此 section 从未出现。
//
// 旧 sourcemap（2.1.123）推测 external 分支 header 为 "# Output efficiency"，
// 但 2.1.126 binary grep 结果：`Output efficiency` 出现次数 = 0。
// 2.1.126 真实 dump 的 system section headers：
//   # System / # Doing tasks / # Executing actions with care /
//   # Using your tools / # Tone and style /
//   # Text output (does not apply to tool calls) ← 当前实际 header
//   # Session-specific guidance / # auto memory / # Environment / # Context management
//
// 结论：`# Output efficiency` 这个 header 可能仅存在于某个中间版本，
// 或者 sourcemap 推断有误。保留 rule 仅作历史记录，P2-8 anchor 测试已从
// fixtureHitRules 中排除（从未在真实 dump 命中）。

// ── # Tone and style section ──────────────────────────────────────────────────
//
// getSimpleToneAndStyleSection() — prompts.ts:430-442
// external 用户：5 条 bullet（含 "Your responses should be short and concise."）
// ant 用户：4 条 bullet（无上述一条）
// 对 external 用户内容确定，可精确匹配。

// Nm3()/HM3() 函数本身用 `[header, ...bullets].join('\n')` 拼接，输出严格止于 `period.`，共 555 字节。
// content 在 2.1.140 / 2.1.142 之间没变；变的是 system 数组的切法（cache 切点位置）。
// 这导致 splitByH1Headers 切出来的 leaf 在两个版本下尾部不同：
//   - 2.1.142+ ：cache 切点放在 Nm3 之后，tone-style 落到 system block 末尾，leaf = 555B
//   - 2.1.140- ：单个 system block 内多 section 用 `\n\n` 拼接，leaf 含尾 `\n\n` = 557B
//
// 因此拆 v0/v1 两条 byte-exact rule + appliesTo 版本范围。**不用 regex tolerance**——
// 把 wire 形态差异交给版本维度表达，rule 严格 byte-equal，未见过的形态明确暴露成 no_rule_matched。
const TONE_STYLE_NM3_OUTPUT_555B =
  "# Tone and style\n" +
  " - Only use emojis if the user explicitly requests it. Avoid using emojis in all communication unless asked.\n" +
  " - Your responses should be short and concise.\n" +
  " - When referencing specific functions or pieces of code include the pattern file_path:line_number to allow the user to easily navigate to the source code location.\n" +
  " - Do not use a colon before tool calls. Your tool calls may not be shown directly in the output, so text like \"Let me read the file:\" followed by a read tool call should just be \"Let me read the file.\" with a period.";

// 老形态（2.1.140 及更早）：leaf = Nm3 输出 + 尾 `\n\n` = 557B。
// 已实测：2.1.139.6c9 (15aa1c88 #47) / 2.1.140.453 (427a2904 T3 C1) 都是 557B。
// 边界 = 2.1.140 → 2.1.141 之间（Anthropic 把 cache 切点放到 Nm3 之后）。
// 2.1.141.7ed (59339097 #15) 已经是新形态（555B）了——这跟我们一开始的推测不同，
// 当时把 v0 上限标在 2.1.141 是没实测样本的猜测，现在按观察事实修正到 2.1.140。
// 下限不约束：rule 是 byte-exact 的，更老版本如果改过 Nm3 内容自然字面对不上。
// 新形态（2.1.141 起）：cache 切点把 `\n\n` 推到 block 边界外，leaf = Nm3 输出 = 555B。
// 已实测：2.1.141.7ed (59339097 #15) / 2.1.142.6c2 (9b61c7de #93)。
// ── # Text output section（旧版 output efficiency header）────────────────────
//
// fixture 里观测到的实际 header 是 "# Text output (does not apply to tool calls)"，
// 而当前 sourcemap（2.1.123）里 external 分支的 header 是 "# Output efficiency"。
//
// 这是版本演进导致的 header 名称变化，不是同一版本内的两个变体：
//   旧版 Claude Code：# Text output (does not apply to tool calls)
//   当前 2.1.123    ：# Output efficiency
//
// 两条 rule 都保留，各自覆盖一个版本，proxy 里不同版本的请求可以各自命中。
// output-efficiency.external.v1 对应当前版本（现有 fixture 暂无命中案例）。
// text-output-section.v1 对应旧版本（当前 fixture 里实际观测到的 header）。

// ── # Context management section ─────────────────────────────────────────────
//
// 【拆分原因】历史上 "# Context management" 和后续 "gitStatus: ..." 在 dump 里贴在
// 同一个 system block 末尾，老版本 rule 用一个 regex 把两者一起匹配。2.1.142 起
// template 把它们切成两个独立 slot（context-management / context），各自走一个 leaf：
//
//   slot context-management leaf : `# Context management\n{mm3 body}\n\n` (有 gitStatus 跟随时)
//   slot context           leaf : `gitStatus: ...\n\nCurrent branch: ...`（块末尾，无尾换行）
//
// 因此拆成两条 rule，分别绑定到各自 slot。
//
// 【内容变化（2.1.126 → 2.1.142）】DM3 常量改名为 mm3，且文案完全换了：
//   旧（DM3 / 2.1.126）：
//     "When working with tool results, write down any important information you
//      might need later in your response, as the original tool result may be
//      cleared later."
//   新（mm3 / 2.1.142）：
//     "When the conversation grows long, some or all of the current context is
//      summarized; the summary, along with any remaining unsummarized context, is
//      provided in the next context window so work can continue — you don't need
//      to wrap up early or hand off mid-task."
//
// 二者完全是两条独立 hint —— 不是 "改了一个标点" 的小变更。
//
// 【尾换行说明】slot context-management leaf 末尾的 `\n\n` 是与下个 slot
// (`gitStatus:...`) 之间的 section 分隔符，被 proxy-block-splitter 划入本 leaf。
// 非 git 仓库时 gitStatus slot 缺失，这个 leaf 会是块内最后一段，无尾换行。
// 因此 pattern 用 regex + `(?:\n\n)?$` 兼容两种形态。

// ── gitStatus 块（slot system.main-prompt.section.context）──────────────────
//
// 【来源】函数 x98() / sourcemap getGitStatusContext()（2.1.142 binary）：
//   组装：[
//     "This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.",
//     `Current branch: ${O}`,
//     `Main branch (you will usually use this for PRs): ${T}`,
//     ...A ? [`Git user: ${A}`] : [],
//     `Status:\n${w||"(clean)"}`,
//     `Recent commits:\n${z}`,
//   ].join("\n\n")
//
// 之后 appendSystemContext 把它作为 (key, value) 注入 system，key 名是 "gitStatus"，
// 显示为前缀 "gitStatus: "。
//
// 前提：!CLAUDE_CODE_REMOTE && X5_()（X5_ 检查 CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS 和
//       settings.includeGitInstructions，默认 true）。
// 非 git 仓库时 fj() 返回 false → x98() 返回 null → 整个 slot 缺失（leaf 不存在）。
//
// gitUser 是条件字段（git config user.name 为空时整行缺失）。
// status 空时为 "(clean)"，>2000 chars 时被截断附提示。

// ── Tools schema rules ────────────────────────────────────────────────────────
//
// 每条 tool rule 覆盖 reqBody.tools[i]（tools 数组某一项）的 description + input_schema。
//
// ── tools[] 顺序规则（P0 事实，sourcemap 确认）────────────────────────────────
//
// 来源：restored-src/src/tools.ts:362，函数 assembleToolPool()
//
//   const byName = (a: Tool, b: Tool) => a.name.localeCompare(b.name)
//   return uniqBy(
//     [...builtInTools].sort(byName).concat(allowedMcpTools.sort(byName)),
//     'name',
//   )
//
// 规则：
//   1. 内置工具（builtInTools）先按 name.localeCompare() 字母序排列，形成前缀段。
//   2. MCP 工具（allowedMcpTools）紧接其后，同样按字母序排列，形成后缀段。
//   3. 两段严格分开——不做全局混排。原因（sourcemap 注释明确）：全局混排会在 MCP
//      工具名落在内置工具字母序之间时破坏服务端 claude_code_system_cache_policy 的
//      cache breakpoint，使每次 MCP 工具集变化都导致内置工具段缓存失效。
//
// 验证：所有已录制 fixture（2026-05-01）的 tools[] 顺序完全一致，均符合上述规则。
//   内置工具示例顺序：Agent → AskUserQuestion → Bash → CronCreate → ... → Write
//   MCP 工具紧随其后：mcp__claude_ai_Gmail__authenticate → ... → mcp__tavily__tavily_search
//
// reconstruction 排序要求：
//   materializer 生成的 tool segments 必须按同一字母序排列，否则：
//   (a) reqBody.tools[i] 的 sourceMap 路径错位；
//   (b) canonical hash 因顺序不同而不匹配；
//   (c) reconciliation 产生虚假 order_mismatch finding。
//   内置工具和 MCP 工具仍然分段：内置工具先，MCP 工具后。
//   见 tool-schema-registry.ts：BUILTIN_TOOL_SCHEMA_JSON 的 key 顺序即字母序基准。
//
// ── 分析依据（P0 优先级）──────────────────────────────────────────────────────
//   - dump 实测（2026-05-01 请求，40 个 tool）：完整 tool JSON 存入 tool-schema-registry.ts
//   - binary 前/后缀分析：部分 description 含模板插值（如 Bash/Agent），用 regex 头尾锚定
//   - input_schema 全部静态 JSON，dump 即事实
//
// 匹配策略分类：
//   exact   — 29 个内置工具（描述静态，dump 即 truth）；11 个 MCP 工具（description 静态）
//   regex   — Agent / Bash / ScheduleWakeup（description 含动态插值，头尾锚定）
//   unknown — ToolSearch（deferred tool，不出现在普通 proxy dump，无 P0 input_schema）
//
// reconstruction materialization 分类：
//   exact_text  — 所有 exact 工具（完整 tool JSON 存入 tool-schema-registry.ts）
//   shape       — Agent / Bash / ScheduleWakeup（description 动态，无法复现）
//   attribution_only（MCP）— input_schema 由用户 MCP server 配置决定，不可正向复现
//
// attribution 位置：section="tools"，index 不固定
// reconstruction：trigger="always_per_query"（tools 数组每次请求都完整发送）
// reconciliation：static → raw_hash；dynamic → presence_only

// ── Edit ─────────────────────────────────────────────────────────────────────
// binary 分析：description 前 52B 可 exact，后 144B 可 exact，中间有动态注入（Fg5() 等）。
// 但 dump 是 P0 事实：dump 里的 1094B description 就是实际发出的，直接 exact 匹配。
// 验证：binary 里 "Performs exact string replacements in files.\n\nUsage:" 有 exact 命中。
// ── Write ────────────────────────────────────────────────────────────────────
// dump 620B，binary 有 oS1() 动态插入（Read-before-write 辅助内容），
// 但 dump 是 P0，直接 exact。
// ── Read ─────────────────────────────────────────────────────────────────────
// dump 1635B。binary 分析：offset 400B 处插入 ${pIH}（默认行数，运行时可能是 2000）。
// dump 里已是渲染后的值，P0 直接 exact。
// ── Skill ────────────────────────────────────────────────────────────────────
// dump 1315B。binary 分析：覆盖 99.1%，中间仅 8 字节编码边界问题，dump 已正确。
// ── ToolSearch ───────────────────────────────────────────────────────────────
// dump 963B。binary 里 em-dash 是 — 转义，但 dump 已渲染为 UTF-8 "—"，P0 exact。
// ── Agent ────────────────────────────────────────────────────────────────────
// dump 8071B。binary 分析：仅 5.6% 静态，中间 agent 列表（Available agent types...）完全
// 由运行时动态生成（loadAgents、用户自定义 agent 等），无法 exact。
// 策略：regex 头尾锚定。
//   HEAD anchor（126B，binary exact）："Launch a new agent to handle complex..." 到 \n\n 为止
//   TAIL anchor（329B，binary exact）："second opinion..." 结尾 </example>\n
// ── Bash ─────────────────────────────────────────────────────────────────────
// dump 10686B。binary 分析：仅 2% 静态。
// description 大量动态内容：git commit 指南、gh CLI 指南、working directory 变量、
// CLAUDE_CODE_REMOTE 条件段等，全部运行时组装。
// 策略：regex 头尾锚定（head = 53B 静态前言；tail = 最后的 GitHub PR 操作说明）。
// ── ScheduleWakeup ────────────────────────────────────────────────────────────
// dump 2312B。binary 分析：仅 3% 静态，且 binary 里 em-dash 是 —。
// 这是外部插件（/loop 功能），description 含 em-dash + 动态内容。
// 策略：regex 头尾锚定（head = 51B；tail = 最后一句 "make it specific.\n"）。
// ── Harness 系统工具 rules（全部 exact，P0 dump 直接提取）────────────────────────
// 这批 tool 是 Claude Code harness 每次请求都注入的系统工具，description 静态。
// 来源：dump 2026-05-01 实测，40 tools 中排除 mcp__ 和已有 rule 的 8 个。

// ── side query rules ──────────────────────────────────────────────────────────
//
// queryHaiku()（claude.ts:3241）发出的内部 side query。
// 特征（sourcemap 确认）：
//   - tools: []（硬编码，claude.ts:3274）
//   - messages: [1条]（只有 userPrompt，即主 session 第一条用户消息文本）
//   - model: getSmallFastModel() = claude-haiku-4-5-20251001
//   - output_config.format.type = "json_schema"（structured output）
//   - system: [billing_header, cli_identity, SESSION_TITLE_PROMPT]（3 块）
//
// side query 与主 query 的根本区别：
//   - 不写 session storage（sideQuery.ts 不调用 sessionStorage，无 promptId）
//   - 无对应 JSONL 条目——因此 pipeline 无法用标准 mutation 路径重建 expected
//   - expected 理论上可从"触发时刻主 session 的第一条 user_message"派生，
//     但 pipeline 当前无 parentSessionJSONL 上下文，故 expected 不可得
//   - 正确的 audit 模式：attribution-only（验证我们能识别这条请求是什么，而非验证内容精确）
//
// queryScope: "side_query"——parser 推断的 queryKind === "side_query" 时才命中。
// 主请求（tools>0）永远不会命中 side_query rule，强约束防止误匹配。
//
// FIXTURE STATUS：
//   proxy-request.json 已录制（server/test/fixtures/context-reconstruction/side-query-session-title/）。
//   版本：cc_version=2.1.122.d93（traffic.jsonl.2026-05-01T05-59-26-948Z:1995）。
//   无对应 session.jsonl——side query 不属于任何主 session JSONL，进入 proxyWithoutJsonl 分支。
//   pipeline 以 --proxy-only 模式处理：attribution 识别 + 无 expected 重建 + 无 reconciliation。
//   reconciliation.comparePolicy = "presence_only"：只验证 attribution 命中，不做 hash/text 比对。

// ── session title generation ───────────────────────────────────────────────────
// generateSessionTitle() — sessionTitle.ts:79
// SESSION_TITLE_PROMPT（sessionTitle.ts:56-68）：硬编码常量，当前版本精确 700 chars。
// Safeguards 团队不拥有这段文本，但实际上非常稳定。
//
// 识别信号组合（三重约束，缺一不可）：
//   1. queryScope = "side_query"（tools=0, messages=1）← 防止主请求误命中
//   2. system[2] 完整文本精确 regex 匹配 ← 防止其他 side query 误命中
//   3. output_config.format.type = "json_schema" ← parser 已存入 snapshot.request.outputFormat
//
// attribution 视角（proxy → 识别）：
//   system[2] 的 rawText 匹配 SESSION_TITLE_PROMPT → category=system_prompt, mechanism=system_prompt_pattern
//   attribution 可正常工作，不受 JSONL 缺失影响。
//
// reconstruction 视角（expected 构建）：
//   side query 无 JSONL，expected 不可正向重建。
//   理论路径（未实现）：PipelineInput.parentSessionJSONL → 取主 session 第一条 user_message
//   → 作为 expected messages[0]；system 由 billing + identity + contentPattern 组合。
//   当前阻塞：pipeline 无 parentSessionJSONL 字段，trigger=from_harness_state 仅作规范记录。
//
// reconciliation 视角（对账）：
//   comparePolicy = "presence_only"：无 expected，只验证 attribution 命中；不做 hash/char 比对。
//   exactTextExpected = false：side query expected 不可得，不强制精确对账。

// ── MCP tool rules ────────────────────────────────────────────────────────────
//
// 以下 rule 覆盖用户配置的 MCP 工具（非 Claude Code 内置）。
// 来源：claude.ai 官方 MCP proxy（gmailmcp / calendarmcp / drivemcp）以及 tavily。
// P0 事实：本地 proxy dump 的 rawText（= tool.description）直接 exact 匹配。
// charCount = JSON.stringify(整个 tool 对象) 长度，包含 input_schema。
// attribution matchMode=prefix：MCP description 完全静态，用 prefix 精确命中。
// reconciliation comparePolicy=raw_hash：整个 tool JSON 不变，hash 可精确比对。
//
// ── reconstruction：MCP tools 保持 attribution_only ──────────────────────────
//
// MCP tool 的 input_schema 由用户本地 MCP server 配置动态提供（通过 appState.mcp.tools
// 在运行时注入，见 sourcemap tools.ts:assembleToolPool）。不同用户、不同 MCP server
// 版本的 input_schema 可能不同，无法从 JSONL 或 harness 静态数据正向复现。
//
// 因此所有 MCP tool rule 的 reconstruction.emits 不携带 contentPattern，
// materializer 检测到 mcp__ 前缀时直接 skip，写入 unmaterializedRuleIds。
// 这是设计上的保守降级，不是 bug。
//
// 顺序注意：MCP tools 在内置工具之后，同样按字母序排列（见上方顺序规则）。

// ── claude.ai Gmail ───────────────────────────────────────────────────────────
// ── claude.ai Google Calendar ─────────────────────────────────────────────────
// ── claude.ai Google Drive ────────────────────────────────────────────────────
// ── tavily MCP ────────────────────────────────────────────────────────────────
// ── messages 层注入 rule ──────────────────────────────────────────────────────
//
// task_reminder：每 10 个 assistant turn 且距上次提醒也 ≥ 10 turn 时触发。
// 由 getTaskReminderAttachments()（attachments.ts:3375）生成 attachment，
// 再经 normalizeAttachmentForAPI → wrapMessagesInSystemReminder 包成
// <system-reminder>...</system-reminder>，最后由 smooshSystemReminderSiblings
// 折叠进同一 user message 里最后一个 tool_result 的 content 尾部。
//
// 结果：proxy 里没有独立 segment，该文本附在 tool_result rawText 末尾。
// attribution 层通过 CLAUDE_CODE_TOOL_RESULT_SMOOSH_RULE 的 tailInjection 字段
// 在 tool_result 分支检测，reconciliation 层读 tail_injection_chars note 消化差值。
//
// 渲染模板（messages.ts:3688）：
//   前缀：固定字符串（TASK_REMINDER_PREFIX_TEXT）
//   后缀：tasks.map(t => `#${t.id}. [${t.status}] ${t.subject}`).join("\n")（可空）
//   整体包裹：<system-reminder>\n{text}\n</system-reminder>
//
// 参考 restored-src/src/utils/attachments.ts:3375
//      restored-src/src/utils/messages.ts:3680

// task_reminder 固定前缀（用于 tailInjection pattern 和 attribution 检测）

// ── SmooshContent rule prefix 常量 ───────────────────────────────────────────
//
// 这些常量是 6 类 smoosh 注入内容的固定前缀，用于 AST attribution 时识别。
// 每个 smoosh 段都形如：<system-reminder>\n{prefix}{动态正文}\n</system-reminder>
// 真实数据来源：扫描 ~/.api-dashboard/proxy/traffic.jsonl* 共 64,093 个 SR 段后归类。






// ── SmooshContent rule 簇（v2 路径）──────────────────────────────────────────
//
// 设计背景：
//   smoosh 是一个**机制**（smooshSystemReminderSiblings, restored-src/src/utils/messages.ts:1835），
//   它把 user message 里的 `<system-reminder>...</system-reminder>` 兄弟节点折叠进
//   同一 message 中最后一个 tool_result 的 content 尾部。该机制承载的**内容**多样：
//   task-reminder / queued-command / file-modified / plan-mode 三 variant 等。
//
//   旧 task-reminder.v1 + TOOL_RESULT_SMOOSH_RULE.tailInjection 只覆盖了 task-reminder 一类。
//   本批 6 个 v2 rule 让每类 smoosh 内容都有独立 ruleId / pattern，AST 切出 SR 子段后
//   按 prefix 命中具体 rule。
//
//   AST 切分由 ast-builder.ts 在 tool_result.content 尾部增加 SR 切分实现（阶段 2.2）；
//   SLOT 绑定在 context-rule-registry.ts 的 SLOT_BINDINGS 里追加。
//
// 校验依据：扫描 ~/.api-dashboard/proxy/traffic.jsonl* 共 64,093 SR 段，按前缀聚类，
//          覆盖 top 6 类约 99.6%。

// 1) task-reminder v2
//
// 模板演进：CLI 2.1.141 起新版前缀（不含 "Make sure that you NEVER mention..."），
//          旧版仍存于历史 dump，pattern 同前缀仍可命中。verifiedFor 设为运行版本号。
// 2) queued-command v2
//
// sourcemap: restored-src/src/utils/messages.ts:5368 附近（pairing 之后 re-smoosh）
//          attachment.type === "queued_command" 的 prompt 文本被 wrap 后 smoosh。
// 真实数据：proxy 中固定尾部 "IMPORTANT: After completing your current task, you MUST address the user's message above. Do not ignore it."
// 3) file-modified v1
//
// sourcemap: restored-src/src/utils/messages.ts 文件编辑后再次发起 LLM 调用时
//          注入的 "Note: {filepath} was modified..." 段。
// 内容形如：
//   <system-reminder>
//   Note: {filepath} was modified, either by the user or by a linter. ...
//   Here are the relevant changes (shown with line numbers):
//   1   {line1}
//   2   {line2}
//   ...
//   </system-reminder>
// 4) plan-mode strict v1
//
// 进入 plan mode 时（或在 plan mode 中需要重申约束时）的长版本指令。
// 真实数据有两个 variant，统一前缀 "Plan mode is active. The user indicated..."。
// 内含 plan 文件路径 + 工作流说明，动态部分主要是 plan file path。
// 5) plan-mode reminder v1
//
// plan mode 进行中每次 turn 注入的短提醒，内容相对静态（只含 plan file path 动态）。
// 6) plan-mode exited v1
//
// 退出 plan mode 时的告知段。短，相对静态。
// ── userContext injection rule ────────────────────────────────────────────────
//
// sourcemap: context.ts:155 getUserContext()
//   返回 { claudeMd?, userEmail?, currentDate }
//   claudeMd = getClaudeMds(filterInjectedMemoryFiles(memoryFiles))
//     → 拼接 "Contents of {path} (project instructions, ...):\n\n{content}"
//     → 可包含 CLAUDE.md 层级（Project / Local / Global），不包含 AGENTS.md
//   userEmail = "The user's email address is {emailAddress}."（仅非 ANTHROPIC_UNIX_SOCKET 时注入）
//   currentDate = "Today's date is {localISODate()}."（每次都注入）
//
// sourcemap: utils/api.ts:449 prependUserContext()
//   插入 messages[0]（isMeta=true）：
//     `<system-reminder>\n
//      As you answer the user's questions, you can use the following context:\n
//      {Object.entries(context).map(([k,v]) => '# '+k+'\n'+v).join('\n')}
//      \n\n      IMPORTANT: this context may or may not be relevant to your tasks.
//      You should not respond to this context unless it is highly relevant to your task.\n
//      </system-reminder>\n`
//
// key 顺序（binary 2.1.128 确认）：claudeMd → userEmail → currentDate
// 因此 head anchor = 固定前缀 + "# claudeMd\n"
// tail anchor = "# currentDate\n" + 一行日期 + "\n\n      IMPORTANT: ..." + 固定尾
//
// reconstruction：内容完全动态（CLAUDE.md 随项目变化，email/date 随用户/时间变化），
// 使用 normalized_text + contentPattern=null。
// reconciliation：presence_only（无法事先知道文本内容）。
// ── system-reminder 子类：skill_listing ──────────────────────────────────────
//
// 这是 system-reminder 的特化形态，由 `uMY`（attachments.ts:2700-2750
// getSkillListingAttachment）每轮生成、`normalizeAttachmentForAPI` 的
// skill_listing 分支（messages.ts:3728-3737）经 wrapMessagesInSystemReminder
// 包成 SR 后塞进 messages.inline.system-reminder。
//
// 真实形态（cli.js 硬编码）：
//   <system-reminder>
//   The following skills are available for use with the Skill tool:
//
//   - {skill1.name}: {skill1.description}
//   - {skill2.name}: {skill2.description}
//   ...
//   </system-reminder>
//
// 动态信息：
//   - 行数 = 当轮"新增"的 skill 数（首轮 dump 全量，之后只发 delta）
//   - 名称可含 plugin 命名空间冒号（如 "claude-hud:setup"）
//   - 描述在预算压力下可能被 … 截断，极端时整行只剩 "- name"（无冒号无 desc）
//
// 设计：只用 header signature 锚定 + 一个 skillsBlock 命名组捕获整段正文。
// 前端拿到 skillsBlock 后自行按行解析能识别的 skill 名；解析失败的行回退到 raw。
// 平行的 task / todo / date_change 等 SR 子类后续按相同模式逐条补。
//
// sourcemap 锚点：
//   - 内容生成：restored-src/src/utils/attachments.ts:2745
//   - SR 包裹：restored-src/src/utils/messages.ts:3728 + :3097 wrapInSystemReminder
//   - 单行格式：restored-src/src/tools/SkillTool/prompt.ts:65 formatCommandDescription

// ── P2-1：messages 层 harness injection rules ─────────────────────────────────
//
// 这两条 rule 把 proxy-attribution.ts 里的硬编码 isSystemReminder / isLocalCommand
// 常量检测迁入 rule registry，让 attribution 主流程通过 findMatchingRule 命中。

// tool_result 基础 rule：通过 tailInjection 声明可能携带 task_reminder smoosh。
// attribution 层：tool_result 分支已由 wire schema 直接确定 category，
// 本 rule 主要作为 tailInjection 的载体（attribution 代码在 tool_result 分支
// 调用 findTailInjectionRule() 找到此 rule，再做 rawText 尾部检测）。
// ── @file attachment 注入 rule ───────────────────────────────────────────────
//
// sourcemap: attachments.ts generateFileAttachment（3020）→ case 'file'（messages.ts:3545）
//
// 用户 @-mention 一个文件时，Claude Code 生成 attachment.type=file 记录到 JSONL，
// normalizeAttachmentForAPI 将其展开为 2-3 条 synthetic messages（均被 wrapMessagesInSystemReminder 包裹）：
//
//   segment[0] — Read call wrapper（messages.ts:4330 createToolUseMessage）：
//     "<system-reminder>\nCalled the Read tool with the following input: {\"file_path\":\"...\"}\n</system-reminder>"
//
//   segment[1] — Read result wrapper（messages.ts:4313 createToolResultMessage）：
//     "<system-reminder>\nResult of calling the Read tool:\n1\t{line1}\n2\t{line2}\n...\n</system-reminder>"
//
//   segment[2] — truncation note（messages.ts:3565，仅当 attachment.truncated=true）：
//     "<system-reminder>\nNote: The file {filename} was too large and has been truncated to the first 2000 lines. ...\n</system-reminder>"
//
// 行号格式（FileReadTool.ts:652）："{lineNum}\t{lineText}\n"，从 startLine（通常为 1）开始。
//
// already_read_file（attachments.ts:3099）：文件已在 context 中时，normalizeAttachmentForAPI
// 对 already_read_file 直接 return []，不向 API 发送任何内容。因此 already_read_file
// 出现时 expected 侧不应生成任何 segment——reconstructor 检测 attachmentType 来区分。
//
// reconstruction 的具体渲染逻辑在 expected-context-reconstructor.ts
// handleFileAttachmentMutation()，rule 只声明激活条件与对账策略。
// ── image content block ──────────────────────────────────────────────────────
//
// 来源：Anthropic API 协议固定 content block 类型。
//   wire 形态：{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iV..."}}
//             或 {"type":"image","source":{"type":"url","url":"https://..."}}
//   JSONL 形态：同上（在 user 事件的 message.content[] 里，与 text block 平级）
//
// matcher 把 image block 切到独立 slot "messages.block.image"，rawText 为完整 JSON 字面量。
//
// 稳定性：dynamic（base64 data / url 内容不可预测）。
// materialization：presence——能确认"此处有一张图（含 mediaType）"，但不试图重建 data。
//
// captureGroups：从 JSON 字面量提取 source.type 和 media_type 供 attribution notes 展示，
//   也作为 jsonl-linker 后续做 digest 匹配的元信息。

// CLI 把"用户上传图片"这件事在 proxy reqBody 里同时表达成两种 block：
//   1. {type:"image", source:{...}}  —— 真正喂给模型的 base64 / url（由 CLAUDE_CODE_MESSAGES_IMAGE_RULE 处理）
//   2. {type:"text",  text:"[Image: source: /path/to/foo.png]"}  —— 给 user 看的占位文本，本规则负责
//
// 后续 turn 用户回引同一张图时，CLI 会发出 `[Image #N]`（无 source），也归此规则。
//
// 形态由 ast-builder.splitInlineTags 在 messages.text 子树里识别为
// messages.inline.image-placeholder slot；本规则按形态 regex 覆盖 rawText。
// CLI 的 "while you were away" recap prompt（services/awaySummary.ts）。
// 两种形态都见过：
//   1. side-query（旧）：tools:[]、small fast model、独立 querySource: 'away_summary'，
//      prompt 落在 side-query.user 单一槽。
//   2. main-session 末尾（新）：把 prompt 追加为主 session 当前 call 的最后一个 user
//      message，落在 messages.text → splitInlineTags → messages.inline.free-text。
// prompt 第一句固定（"The user stepped away and is coming back."），后续指令措辞
// 在版本间会改（"Write exactly 1-3 short sentences..." vs "Recap in under 40 words..."），
// 用 [\s\S]+ 吃掉后续。
// ── P? Batch1：inline system-reminder 细分 rules（参考 Piebald v2.1.150 抽取）────
//
// 路由前提（ast-builder.splitInlineTags）：只有以 "<system-reminder>" 开头的段才会被
// 切到 messages.inline.system-reminder 槽。故以下 pattern 均锚定 SR 壳。
// ⚠️ wrapper/位置按推测（Piebald 快照只给内层模板），尚未用真实 JSONL 取证：
//   - file-truncated / token-usage / todowrite：把握较高（同 file-modified / task-reminder 形态）。
//   - new-diagnostics：风险最高 —— 内层自带 <new-diagnostics> 标签，若注入时不再包 SR 壳，
//     则会落到 messages.inline.free-text 成为死规则，待 smoke 暴露后再决定（可能需改 ast-builder）。
// verifiedFor 一律 null（命中后置信度降级为 inferred；未按 SUPPORTED 版本逐条校对）。

// Batch1 续：memory 注入（合并 Piebald 的 memory-file-contents + nested-memory-contents，
// 两形态文本同构 'Contents of {path}:\n\n{content}'，合一条避免互相抢匹配）。
// 从 corpus 全量获取(含 Phase 3 新增的 Harness/Memory/intro-v2/style-guidance 等)
import { CORPUS_LEDGER_RULES, CORPUS_LEDGER_RULES_BY_ID } from "../rule-corpus/runtime";

// ── Legacy-compat re-exports(给仍 import 旧 const 名的外部代码用)──────────────
// 这些 const 名等同于直接从 corpus 取该 ruleId 对应的 rule。新代码应直接用
// CORPUS_LEDGER_RULES_BY_ID["..."],这里仅为不破坏现有 test/外部 import。
// Phase 6 后续清理:把这些 import 改为直接走 ruleId,这一节再删。
export const CLAUDE_CODE_MESSAGES_SKILL_LISTING_V1_RULE =
  CORPUS_LEDGER_RULES_BY_ID["claude-code.messages.skill-listing.v1"]!;

export const CONTEXT_LEDGER_RULES: ContextLedgerRule[] = [
  // ── corpus 管理的 system 规则(billing/identity + 15 条 H1 + Phase 3 新增) ──
  // 顺序由 corpus 文件名字典序决定;system 规则的 patterns 大多互斥(不同 H1 锚点),
  // first-match 语义不受顺序影响。详见 rule-corpus/rules/。
  ...CORPUS_LEDGER_RULES,
  // ── IDE 扩展注入（仅 VSCode 扩展发起的请求才出现） ──────────────────────────
  // ── tool schema rules ─────────────────────────────────────────────────────
  // harness 系统工具（22 条，全部 exact，dump 直接提取）
  // ── MCP tool rules ────────────────────────────────────────────────────────
  // ── messages 层注入 rules ─────────────────────────────────────────────────
  // SmooshContent v2 rule 簇必须排在 SYSTEM_REMINDER_RULE（通用 SR 前缀兜底）之前，
  // 否则候选评估时会被 generic rule 抢先命中。
  // 必须排在 SYSTEM_REMINDER_RULE 之前，否则会被通用 SR 前缀兜底抢先命中。
  // Batch1 inline SR 细分（必须排在通用 SYSTEM_REMINDER_RULE 之前）
  // ── image content block ──────────────────────────────────────────────────
  // ── system-injected recap prompts ────────────────────────────────────────
  // ── side query rules ──────────────────────────────────────────────────────
];

export const CONTEXT_LEDGER_RULE_BY_ID: ReadonlyMap<string, ContextLedgerRule> = new Map(
  CONTEXT_LEDGER_RULES.map((rule) => [rule.ruleId, rule]),
);

export function getContextLedgerRule(ruleId: string): ContextLedgerRule | undefined {
  return CONTEXT_LEDGER_RULE_BY_ID.get(ruleId);
}

// ── 校对状态汇总（B1.4）─────────────────────────────────────────────────────────

// 单条 rule 是否已对照 SUPPORTED_CLAUDE_CODE_VERSION 校对通过。
// 只有严格相等才算 verified；任何其它字符串（含旧版号）等同于 null。
export function isRuleVerified(rule: ContextLedgerRule): boolean {
  return rule.verifiedFor === SUPPORTED_CLAUDE_CODE_VERSION;
}

export interface RuleVerificationSummary {
  supportedVersion: string;
  total: number;
  verified: number;
  pending: number;
  pendingRuleIds: string[];
}

export function getRuleVerificationSummary(): RuleVerificationSummary {
  const pending: string[] = [];
  for (const rule of CONTEXT_LEDGER_RULES) {
    if (!isRuleVerified(rule)) pending.push(rule.ruleId);
  }
  return {
    supportedVersion: SUPPORTED_CLAUDE_CODE_VERSION,
    total: CONTEXT_LEDGER_RULES.length,
    verified: CONTEXT_LEDGER_RULES.length - pending.length,
    pending: pending.length,
    pendingRuleIds: pending,
  };
}

// ── 兼容旧导出（过渡期，待下一阶段清理） ────────────────────────────────────────
// proxy-attribution.ts 等使用旧名称的代码在本次一并迁移；
// 若仍有外部引用，此处保留临时别名避免编译中断。
/** @deprecated 使用 ContextLedgerRule */
export type AttributionRule = ContextLedgerRule;
/** @deprecated 使用 CONTEXT_LEDGER_RULES */
export const ATTRIBUTION_RULES = CONTEXT_LEDGER_RULES;
/** @deprecated 使用 CONTEXT_LEDGER_RULE_BY_ID */
export const ATTRIBUTION_RULE_BY_ID = CONTEXT_LEDGER_RULE_BY_ID;
/** @deprecated 使用 getContextLedgerRule */
export const getAttributionRule = getContextLedgerRule;

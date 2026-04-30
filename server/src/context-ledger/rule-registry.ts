// Context Ledger Rule Registry
//
// 每条 rule 描述三个视角的语义：
//   attribution   — 如何从 proxy segment 识别它是什么（pattern / location）
//   reconstruction — 如何在 expected context 里正向生成它（trigger / materialization）
//   reconciliation — 如何在对账时比较 proxy 与 expected（comparePolicy / confidence）
//
// 已人工审核确认的 rule：
//   claude-code.system-prompt-identity.v1        — identity 固定行（57 chars）
//   claude-code.system-prompt-dynamic-section.v1 — 动态 system block（# Environment / # Session-specific guidance 等）
//
// ruleVersion = "2.1.123" 是人工审核版本占位，表示"基于 Claude Code 2.1.x 系列审核"，
// 不是严格最小兼容版本声明。
//
// 新增 rule 必须经过：sourcemap grep → proxy 样本确认 → PR 人工 review → 入 registry。
// proxy diff 只能产生 candidate，不能自动写入 registry。

import type {
  Confidence,
  SegmentCategory,
  SegmentFlag,
  SegmentLifecycle,
  SegmentRole,
  SegmentSection,
} from "./types";
import type { ProxySegmentAttribution } from "./types";

// ── 类型定义 ──────────────────────────────────────────────────────────────────

export type RuleStability = "static" | "semi-static" | "dynamic";

// regex：pattern 是正则表达式字符串，attribution 用 new RegExp(pattern).test(text)；
//   pattern_regex 字段同时提供结构化捕获组，attribution 可提取动态字段到 metadata。
export type RuleMatchMode = "exact" | "prefix" | "contains" | "structural" | "regex";

// materialization：reconstruction 层能否复现该 segment 的文本内容。
//   exact_text     — 文本固定，可完整复现（如 identity prefix）
//   normalized_text — 文本有微小变体，可规范化后复现
//   shape          — 只能复现结构/轮廓，不能复现完整文本
//   presence       — 只能确认"有这段"，内容不可预测（如 billing header 含 fingerprint）
//   unavailable    — 无法从 JSONL/harness 推断任何内容
export type RuleMaterialization =
  | "exact_text"
  | "normalized_text"
  | "shape"
  | "presence"
  | "unavailable";

// comparePolicy：reconciliation 对账时的比较策略。
//   raw_hash       — 精确哈希比对，要求内容完全一致
//   normalized_hash — 规范化后哈希比对
//   char_diff      — 字符级 diff，允许内容存在，量化偏差
//   structural     — 只比较结构特征（section/category/role）
//   presence_only  — 只检查是否存在，不比较内容（适合动态注入内容）
//   known_noise    — 已知噪声，不计入 coverage 分子
export type RuleComparePolicy =
  | "raw_hash"
  | "normalized_hash"
  | "char_diff"
  | "structural"
  | "presence_only"
  | "known_noise";

// 位置约束：描述 rule 在 proxy rawBody 里的语义位置。
//   section / category / role：segment 维度约束
//   segmentPosition：在 segment 文本内的位置语义
//     segment_start  — 必须是 segment 文本的起始（trimStart 后 startsWith）
//     first_paragraph — 必须是第一段落
//     anywhere       — 文本中任意位置（contains）
//   jsonPathHint / orderHint：仅供人工审核参考，不参与运行时硬约束
export interface RuleLocationConstraint {
  section?: SegmentSection;
  category?: SegmentCategory;
  role?: SegmentRole;
  segmentPosition?: "segment_start" | "first_paragraph" | "anywhere";
  jsonPathHint?: string;
  orderHint?: number;
}

export interface ContextLedgerRule {
  ruleId: string;
  ruleVersion: string;
  description: string;
  stability: RuleStability;
  sourcemapRef?: string;

  // queryScope：此 rule 适用的 query 类型。
  // "main_session" — 只匹配主对话（tools > 0, messages > 1）
  // "side_query"   — 只匹配 side query（tools = 0, messages = 1）
  // "any"          — 匹配所有 query（未指定时默认）
  // attribution 时 snapshot.request.queryKind 不一致则此 rule 不命中。
  queryScope?: "main_session" | "side_query" | "any";

  // attribution：proxy → 识别视角
  attribution?: {
    pattern: string | null;
    matchMode: RuleMatchMode;
    location?: RuleLocationConstraint;
    mechanism: ProxySegmentAttribution["mechanism"];
    category: SegmentCategory;
    // matchMode=regex 时，列出 pattern 中命名捕获组的语义说明。
    // 纯文档性字段，attribution 代码通过 exec() 提取对应字段后存入 metadata。
    captureGroups?: Record<string, string>;
  };

  // reconstruction：mutation/harness → 构建 expected 视角
  reconstruction?: {
    // always_per_query — harness 每次请求无条件注入（不依赖 JSONL mutation）
    // from_jsonl       — 从 JSONL mutation 流派生
    // from_memory      — 从 memory_fs 读取
    // from_harness_state — 从 harness 运行时状态（env/config）派生
    trigger: "always_per_query" | "from_jsonl" | "from_memory" | "from_harness_state";
    // preCondition：expected reconstructor 激活此 rule 的前提条件（自然语言描述）。
    // 当同一语义位置有多条互斥 rule 时（如 intro 的两个变体），
    // reconstructor 根据 harness state 评估 preCondition，只激活符合条件的那条。
    // proxy attribution 侧不使用此字段——proxy 命中哪条 rule 由 rawText pattern match 决定。
    preCondition?: string;
    materialization: RuleMaterialization;
    emits: {
      section: SegmentSection;
      category: SegmentCategory;
      lifecycle?: SegmentLifecycle;
      flags?: SegmentFlag[];
      // contentPattern：exact_text / normalized_text 时的完整文本；其他时为 null
      contentPattern?: string | null;
    };
  };

  // reconciliation：对账视角
  reconciliation?: {
    comparePolicy: RuleComparePolicy;
    confidence: Confidence;
    // exactTextExpected：reconciliation 是否期望 proxy 与 expected 文本完全一致
    exactTextExpected: boolean;
  };
}

// ── 首批已人工确认的 rule ──────────────────────────────────────────────────────

// sourcemap 确认（restored-src/src/constants/system.ts）：
//   DEFAULT_PREFIX = `You are Claude Code, Anthropic's official CLI for Claude.`
//   通过 CLI_SYSPROMPT_PREFIXES Set.has() 精确匹配，无动态变量，无尾部换行。
//   harness 在 buildSystemPrompt 里将其作为独立 block 写入 system[]，
//   在 billing header（若存在）之后紧接出现。
//
// attribution 视角：
//   - pattern 与 sourcemap DEFAULT_PREFIX 字面量完全一致（含句号，无换行）
//   - segmentPosition = segment_start：整个 57-char block 就是这一句话
//   - 职责边界：识别"这段 system content 是 Claude Code identity block"，
//     不归因整段 system prompt 的完整内容来源
//
// reconstruction 视角：
//   - trigger = always_per_query：harness 每次请求都注入，不依赖 JSONL
//   - materialization = exact_text：内容固定，可完整复现
//   - 注入的 segment 本身只有 57 chars，不代表整段 system prompt
//
// reconciliation 视角：
//   - comparePolicy = char_diff：proxy 里这段是 57 chars，expected 也是 57 chars，
//     精确可比；用 char_diff 而非 raw_hash 是因为 expected 段是由 rule 构造的，
//     不是从 JSONL 读出的原始字节，hash 对齐成本高
//   - exactTextExpected = true：内容静态，proxy 与 expected 应完全一致
export const CLAUDE_CODE_SYSTEM_PROMPT_IDENTITY_RULE: ContextLedgerRule = {
  ruleId: "claude-code.system-prompt-identity.v1",
  ruleVersion: "2.1.123",
  description:
    "Claude Code system prompt 的固定身份标识行（57 chars）。" +
    "仅用于 attribution 识别锚点与 reconstruction 注入，不归因整段 system prompt 内容来源。",
  stability: "static",
  sourcemapRef: "restored-src/src/constants/system.ts",

  attribution: {
    // 严格精确匹配，含句号，无尾部换行；对应 sourcemap DEFAULT_PREFIX
    pattern: "You are Claude Code, Anthropic's official CLI for Claude.",
    matchMode: "exact",
    mechanism: "system_prompt_pattern",
    category: "system_prompt",
    location: {
      section: "system",
      // segment_start：整个 block 就是这句话（或以这句话开头的更长文本）
      segmentPosition: "segment_start",
      // jsonPathHint / orderHint 仅供人工审核参考
      jsonPathHint: "reqBody.system[*]",
      // billing header 存在时 orderHint=1，不存在时 orderHint=0；
      // 运行时用 segmentPosition 匹配，不依赖硬索引
      orderHint: 1,
    },
  },

  reconstruction: {
    trigger: "always_per_query",
    materialization: "exact_text",
    emits: {
      section: "system",
      category: "system_prompt",
      lifecycle: "session",
      contentPattern: "You are Claude Code, Anthropic's official CLI for Claude.",
    },
  },

  reconciliation: {
    comparePolicy: "char_diff",
    confidence: "exact",
    exactTextExpected: true,
  },
};

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
// getSessionSpecificGuidanceSection() — prompts.ts:352-400
// 条件：enabledTools 非空时产出。内容依赖具体工具集，结构已知但文本不可精确复现。
export const CLAUDE_CODE_SESSION_GUIDANCE_RULE: ContextLedgerRule = {
  ruleId: "claude-code.system-prompt-session-guidance.v1",
  ruleVersion: "2.1.123",
  description:
    "Claude Code system prompt 的 # Session-specific guidance section。" +
    "依赖 enabledTools / skillToolCommands，内容每次可能不同。",
  stability: "dynamic",
  sourcemapRef: "restored-src/src/constants/prompts.ts:352",

  attribution: {
    // attribution 实际通过 sectionHeader === "Session-specific guidance" 匹配（见 proxy-attribution.ts）
    // pattern 仅作文档性记录，matchMode=regex 保持一致性
    pattern: "^# Session-specific guidance\\n",
    matchMode: "regex",
    mechanism: "system_prompt_pattern",
    category: "harness_injection",
    location: {
      section: "system",
      segmentPosition: "segment_start",
    },
  },

  reconstruction: {
    preCondition: "enabledTools 非空（正常 CLI 会话均满足）",
    trigger: "always_per_query",
    // 结构可知（知道有哪些 bullet），内容随工具集变化
    materialization: "shape",
    emits: {
      section: "system",
      category: "harness_injection",
      lifecycle: "query",
      flags: ["injected"],
      contentPattern: null,
    },
  },

  reconciliation: {
    comparePolicy: "structural",
    confidence: "inferred",
    exactTextExpected: false,
  },
};

// ── # Environment ──────────────────────────────────────────────────────────────
// computeSimpleEnvInfo() — prompts.ts:651-710
// 无条件注入，每次请求都有。内容包含 cwd/model/git/platform，每次变化。
// 开头固定为 "# Environment\nYou have been invoked in the following environment: "
export const CLAUDE_CODE_ENVIRONMENT_SECTION_RULE: ContextLedgerRule = {
  ruleId: "claude-code.system-prompt-environment.v1",
  ruleVersion: "2.1.123",
  description:
    "Claude Code system prompt 的 # Environment section。" +
    "computeSimpleEnvInfo() 无条件注入，包含 cwd/model/git/platform，每次请求内容不同。",
  stability: "dynamic",
  sourcemapRef: "restored-src/src/constants/prompts.ts:651",

  attribution: {
    // 开头固定前缀可精确匹配（sourcemap:706-708）
    pattern: "^# Environment\\nYou have been invoked in the following environment: ",
    matchMode: "regex",
    mechanism: "system_prompt_pattern",
    category: "harness_injection",
    location: {
      section: "system",
      segmentPosition: "segment_start",
    },
  },

  reconstruction: {
    trigger: "always_per_query",
    // 开头固定，但 bullet 内容（cwd/model/git）每次不同
    materialization: "shape",
    emits: {
      section: "system",
      category: "harness_injection",
      lifecycle: "query",
      flags: ["injected"],
      contentPattern: null,
    },
  },

  reconciliation: {
    // 开头固定可做 prefix 验证，整体用 structural 因内容每次变
    comparePolicy: "structural",
    confidence: "inferred",
    exactTextExpected: false,
  },
};

// ── # auto memory ──────────────────────────────────────────────────────────────
// loadMemoryPrompt() — memdir.ts
// 条件：有 memory 文件时注入。内容为用户 memory 文件的 markdown 内容，完全动态。
// 开头固定为 "# auto memory\n"
export const CLAUDE_CODE_AUTO_MEMORY_SECTION_RULE: ContextLedgerRule = {
  ruleId: "claude-code.system-prompt-auto-memory.v1",
  ruleVersion: "2.1.123",
  description:
    "Claude Code system prompt 的 # auto memory section。" +
    "loadMemoryPrompt() 在有 memory 文件时注入。内容为用户 memory 文件，完全动态。",
  stability: "dynamic",
  sourcemapRef: "restored-src/src/memdir/memdir.ts",

  attribution: {
    pattern: "^# auto memory\\n",
    matchMode: "regex",
    mechanism: "system_prompt_pattern",
    category: "harness_injection",
    location: {
      section: "system",
      segmentPosition: "segment_start",
    },
  },

  reconstruction: {
    preCondition: "memory 目录存在且有 .md 文件（用户启用了 auto memory）",
    trigger: "from_memory",
    // 内容来自用户 memory 文件，完全不可预测
    materialization: "unavailable",
    emits: {
      section: "system",
      category: "harness_injection",
      lifecycle: "query",
      flags: ["injected"],
      contentPattern: null,
    },
  },

  reconciliation: {
    comparePolicy: "presence_only",
    confidence: "inferred",
    exactTextExpected: false,
  },
};

// 保留旧名称作为兼容别名，指向 Environment rule（attribution 代码直接用 ruleId 字符串引用）
/** @deprecated 已拆分为三条独立 rule，此别名仅供过渡期引用 */
export const CLAUDE_CODE_SYSTEM_PROMPT_DYNAMIC_SECTION_RULE = CLAUDE_CODE_ENVIRONMENT_SECTION_RULE;

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
//                   Bun native HTTP stack 将占位符 "00000" 替换为真实 hash（每次不同）
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
export const CLAUDE_CODE_BILLING_NOISE_RULE: ContextLedgerRule = {
  ruleId: "claude-code.billing-noise.v1",
  ruleVersion: "2.1.123",
  description:
    "Claude Code 每次请求在 system[0] 主动注入的 attribution header。" +
    "含动态字段 cc_version（fingerprint）和 cch（attestation），内容不可复现。" +
    "只匹配 system section——messages 里相同文本是集成逻辑携带，不命中此 rule。",
  stability: "dynamic",
  sourcemapRef: "restored-src/src/constants/system.ts",

  attribution: {
    // 正则：必选字段精确锚定，可选字段用 (?:...)? 兜住，尾部留扩展余地。
    // 必选：cc_version=<semver>.<hex_fingerprint>; cc_entrypoint=<word>;
    // 可选：cch=<hex>;（NATIVE_CLIENT_ATTESTATION）、cc_workload=<tag>;（cron 等）
    // 尾部：(?:; \w+=[^;]+)* 兜住未来新增字段（sourcemap 注释："tolerates unknown extra fields"）
    pattern:
      "^x-anthropic-billing-header: " +
      "cc_version=(?<version>\\d+\\.\\d+\\.\\d+\\.[0-9a-f]+); " +
      "cc_entrypoint=(?<entrypoint>\\w+);" +
      "(?: cch=(?<cch>[0-9a-f]+);)?" +
      "(?: cc_workload=(?<workload>\\S+);)?" +
      "(?:; \\w+=[^;]+)*" +
      "\\s*$",
    matchMode: "regex",
    mechanism: "billing_noise_pattern",
    category: "billing_noise",
    location: {
      section: "system",           // 严格限定 system section，messages 里不命中
      segmentPosition: "segment_start",
    },
    captureGroups: {
      version:    "cc_version 完整值（semver.hex_fingerprint），fingerprint 每次不同",
      entrypoint: "cc_entrypoint 值，如 'cli'（进程级固定）",
      cch:        "attestation token（hex），NATIVE_CLIENT_ATTESTATION 开启时才出现",
      workload:   "cc_workload tag，cron 等特殊场景才出现",
    },
  },

  reconstruction: {
    trigger: "always_per_query",
    // fingerprint（cc_version 后半部分）和 cch 每次动态计算，内容不可复现
    materialization: "presence",
    emits: {
      section: "system",
      category: "billing_noise",
      lifecycle: "noise",
      flags: ["known_noise"],
      contentPattern: null,
    },
  },

  reconciliation: {
    // 不计入 coverage 分子，直接归入 known_noise finding
    comparePolicy: "known_noise",
    confidence: "exact",
    exactTextExpected: false,
  },
};

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

export const CLAUDE_CODE_INTRO_STANDARD_RULE: ContextLedgerRule = {
  ruleId: "claude-code.system-prompt-intro.standard.v1",
  ruleVersion: "2.1.123",
  description:
    "Claude Code system prompt intro 段（标准模式）。" +
    "outputStyleConfig === null 时注入，以 'with software engineering tasks.' 结尾。",
  stability: "static",
  sourcemapRef: "restored-src/src/constants/prompts.ts + restored-src/src/constants/cyberRiskInstruction.ts",

  attribution: {
    // 完整文本精确匹配（正则 escape 关键符号）：
    // 开头换行 + 第一句（with software engineering tasks）+
    // CYBER_RISK_INSTRUCTION（Safeguards 团队维护，当前版本固定）+
    // NEVER generate URLs 声明
    // 与 output-style 变体互斥（output-style 变体第一句措辞不同，不会误命中）
    pattern:
      "^\\nYou are an interactive agent that helps users with software engineering tasks\\. " +
      "Use the instructions below and the tools available to you to assist the user\\.\\n\\n" +
      "IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, " +
      "and educational contexts\\. Refuse requests for destructive techniques, DoS attacks, " +
      "mass targeting, supply chain compromise, or detection evasion for malicious purposes\\. " +
      "Dual-use security tools \\(C2 frameworks, credential testing, exploit development\\) " +
      "require clear authorization context: pentesting engagements, CTF competitions, " +
      "security research, or defensive use cases\\.\\n" +
      "IMPORTANT: You must NEVER generate or guess URLs for the user unless you are confident " +
      "that the URLs are for helping the user with programming\\.",
    matchMode: "regex",
    mechanism: "system_prompt_pattern",
    category: "system_prompt",
    location: {
      section: "system",
      segmentPosition: "segment_start",
    },
  },

  reconstruction: {
    preCondition: "outputStyleConfig === null（settings.outputStyle 为 'default' 或未设置）",
    trigger: "always_per_query",
    materialization: "exact_text",
    emits: {
      section: "system",
      category: "system_prompt",
      lifecycle: "session",
      // sourcemap 构造：getSimpleIntroSection(null) 产出的完整文本
      // = "\n" + intro句 + "\n\n" + CYBER_RISK_INSTRUCTION + "\n" + NEVER_URL句
      // fixture 验证：[0..836) 去掉尾部 "\n\n" = 834 chars，与此一致
      contentPattern:
        "\nYou are an interactive agent that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.\n\n" +
        "IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.\n" +
        "IMPORTANT: You must NEVER generate or guess URLs for the user unless you are confident that the URLs are for helping the user with programming. You may use URLs provided by the user in their messages or local files.",
    },
  },

  reconciliation: {
    comparePolicy: "raw_hash",
    confidence: "exact",
    exactTextExpected: true,
  },
};

export const CLAUDE_CODE_INTRO_OUTPUT_STYLE_RULE: ContextLedgerRule = {
  ruleId: "claude-code.system-prompt-intro.output-style.v1",
  ruleVersion: "2.1.123",
  description:
    "Claude Code system prompt intro 段（Output Style 模式）。" +
    "outputStyleConfig !== null 时注入，以 'according to your \"Output Style\" below' 替换标准措辞。",
  stability: "static",
  sourcemapRef: "restored-src/src/constants/prompts.ts",

  attribution: {
    pattern: "^\\nYou are an interactive agent that helps users according to your \"Output Style\" below",
    matchMode: "regex",
    mechanism: "system_prompt_pattern",
    category: "system_prompt",
    location: {
      section: "system",
      segmentPosition: "segment_start",
    },
  },

  reconstruction: {
    preCondition: "outputStyleConfig !== null（settings.outputStyle 设置为非 default 值）",
    trigger: "always_per_query",
    // contentPattern 随 outputStyleConfig 的 name/prompt 变化，此处只能给结构
    materialization: "normalized_text",
    emits: {
      section: "system",
      category: "system_prompt",
      lifecycle: "session",
      contentPattern: null,  // 依赖运行时 outputStyleConfig，无法静态化
    },
  },

  reconciliation: {
    // 措辞固定但 output style 名称会嵌入，用 normalized_hash 对账
    comparePolicy: "normalized_hash",
    confidence: "exact",
    exactTextExpected: false,
  },
};

// ── # System section ──────────────────────────────────────────────────────────
//
// getSimpleSystemSection() — prompts.ts:186-197
// 完全静态：6 条固定 bullet + getHooksSection() 固定字符串，无条件分支。

export const CLAUDE_CODE_SYSTEM_SECTION_RULE: ContextLedgerRule = {
  ruleId: "claude-code.system-prompt-system-section.v1",
  ruleVersion: "2.1.123",
  description:
    "Claude Code system prompt 的 # System section。" +
    "固定 6 条 bullet，完全静态，无条件分支。",
  stability: "static",
  sourcemapRef: "restored-src/src/constants/prompts.ts:186",

  attribution: {
    pattern: "^# System\\n",
    matchMode: "regex",
    mechanism: "system_prompt_pattern",
    category: "system_prompt",
    location: {
      section: "system",
      segmentPosition: "segment_start",
    },
  },

  reconstruction: {
    trigger: "always_per_query",
    materialization: "exact_text",
    emits: {
      section: "system",
      category: "system_prompt",
      lifecycle: "session",
      contentPattern: null,  // 完整文本较长，由 reconstructor 调用 getSimpleSystemSection() 生成
    },
  },

  reconciliation: {
    comparePolicy: "raw_hash",
    confidence: "exact",
    exactTextExpected: true,
  },
};

// ── # Executing actions with care section ─────────────────────────────────────
//
// getActionsSection() — prompts.ts:255-267
// 完全静态：单一固定字符串，无任何条件分支。

export const CLAUDE_CODE_ACTIONS_SECTION_RULE: ContextLedgerRule = {
  ruleId: "claude-code.system-prompt-actions-section.v1",
  ruleVersion: "2.1.123",
  description:
    "Claude Code system prompt 的 # Executing actions with care section。" +
    "完全静态，单一固定字符串。",
  stability: "static",
  sourcemapRef: "restored-src/src/constants/prompts.ts:255",

  attribution: {
    pattern: "^# Executing actions with care\\n",
    matchMode: "regex",
    mechanism: "system_prompt_pattern",
    category: "system_prompt",
    location: {
      section: "system",
      segmentPosition: "segment_start",
    },
  },

  reconstruction: {
    trigger: "always_per_query",
    materialization: "exact_text",
    emits: {
      section: "system",
      category: "system_prompt",
      lifecycle: "session",
      contentPattern: null,  // 由 reconstructor 调用 getActionsSection() 生成
    },
  },

  reconciliation: {
    comparePolicy: "raw_hash",
    confidence: "exact",
    exactTextExpected: true,
  },
};

// ── # Output efficiency section ───────────────────────────────────────────────
//
// getOutputEfficiencySection() — prompts.ts:403-428
// USER_TYPE !== 'ant' 分支，header 为 "# Output efficiency"（当前 sourcemap 2.1.123）。
// USER_TYPE === 'ant' 分支暂不落地（仅内部用户可见，外部 proxy 不会出现）。

export const CLAUDE_CODE_OUTPUT_EFFICIENCY_EXTERNAL_RULE: ContextLedgerRule = {
  ruleId: "claude-code.system-prompt-output-efficiency.external.v1",
  ruleVersion: "2.1.123",
  description:
    "Claude Code system prompt 的 # Output efficiency section（external / 3P 用户）。" +
    "USER_TYPE !== 'ant' 时注入。",
  stability: "static",
  sourcemapRef: "restored-src/src/constants/prompts.ts:403",

  attribution: {
    pattern: "^# Output efficiency\\n",
    matchMode: "regex",
    mechanism: "system_prompt_pattern",
    category: "system_prompt",
    location: {
      section: "system",
      segmentPosition: "segment_start",
    },
  },

  reconstruction: {
    preCondition: "USER_TYPE !== 'ant'（外部用户，3P provider）",
    trigger: "always_per_query",
    materialization: "exact_text",
    emits: {
      section: "system",
      category: "system_prompt",
      lifecycle: "session",
      contentPattern: null,  // 由 reconstructor 调用 getOutputEfficiencySection() 生成
    },
  },

  reconciliation: {
    comparePolicy: "raw_hash",
    confidence: "exact",
    exactTextExpected: true,
  },
};

// ── # Tone and style section ──────────────────────────────────────────────────
//
// getSimpleToneAndStyleSection() — prompts.ts:430-442
// external 用户：5 条 bullet（含 "Your responses should be short and concise."）
// ant 用户：4 条 bullet（无上述一条）
// 对 external 用户内容确定，可精确匹配。

export const CLAUDE_CODE_TONE_STYLE_EXTERNAL_RULE: ContextLedgerRule = {
  ruleId: "claude-code.system-prompt-tone-style.external.v1",
  ruleVersion: "2.1.123",
  description:
    "Claude Code system prompt 的 # Tone and style section（external / 3P 用户）。" +
    "USER_TYPE !== 'ant' 时注入 5 条 bullet。",
  stability: "static",
  sourcemapRef: "restored-src/src/constants/prompts.ts:430",

  attribution: {
    pattern: "^# Tone and style\\n",
    matchMode: "regex",
    mechanism: "system_prompt_pattern",
    category: "system_prompt",
    location: {
      section: "system",
      segmentPosition: "segment_start",
    },
  },

  reconstruction: {
    preCondition: "USER_TYPE !== 'ant'（外部用户）",
    trigger: "always_per_query",
    materialization: "exact_text",
    emits: {
      section: "system",
      category: "system_prompt",
      lifecycle: "session",
      contentPattern: null,
    },
  },

  reconciliation: {
    comparePolicy: "raw_hash",
    confidence: "exact",
    exactTextExpected: true,
  },
};

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

export const CLAUDE_CODE_TEXT_OUTPUT_SECTION_RULE: ContextLedgerRule = {
  ruleId: "claude-code.system-prompt-text-output-section.v1",
  ruleVersion: "<2.1.123",
  description:
    "Claude Code system prompt 的旧版 output efficiency section。" +
    "header 为 '# Text output (does not apply to tool calls)'，" +
    "当前版本（2.1.123）已更名为 '# Output efficiency'。" +
    "保留用于兼容旧版本 proxy 请求。",
  stability: "static",
  sourcemapRef: "restored-src/src/constants/prompts.ts:403（旧版 header，当前版本已变更）",

  attribution: {
    pattern: "^# Text output",
    matchMode: "regex",
    mechanism: "system_prompt_pattern",
    category: "system_prompt",
    location: {
      section: "system",
      segmentPosition: "segment_start",
    },
  },

  reconstruction: {
    preCondition: "USER_TYPE !== 'ant'（外部用户）— 待 fixture 确认与 output-efficiency rule 的关系",
    trigger: "always_per_query",
    materialization: "exact_text",
    emits: {
      section: "system",
      category: "system_prompt",
      lifecycle: "session",
      contentPattern: null,
    },
  },

  reconciliation: {
    comparePolicy: "raw_hash",
    confidence: "exact",
    exactTextExpected: true,
  },
};

// ── side query rules ──────────────────────────────────────────────────────────
//
// queryHaiku()（claude.ts:3241）发出的内部 side query。
// 特征（sourcemap 确认）：
//   - tools: []（硬编码，claude.ts:3274）
//   - messages: [1条]（只有 userPrompt）
//   - model: getSmallFastModel() = claude-haiku-4-5-20251001
//   - output_config.format.type = "json_schema"（structured output）
//
// queryScope: "side_query"——parser 推断的 queryKind === "side_query" 时才命中。
// 主请求（tools>0）永远不会命中 side_query rule，强约束防止误匹配。

// ── session title generation ───────────────────────────────────────────────────
// generateSessionTitle() — sessionTitle.ts:79
// SESSION_TITLE_PROMPT（sessionTitle.ts:56-68）：硬编码常量，当前版本精确 700 chars。
// Safeguards 团队不拥有这段文本，但实际上非常稳定。
//
// 识别信号组合（三重约束，缺一不可）：
//   1. queryScope = "side_query"（tools=0, messages=1）← 防止主请求误命中
//   2. system[2] 完整文本精确 regex 匹配 ← 防止其他 side query 误命中
//   3. output_config.format.type = "json_schema" ← parser 已存入 snapshot.request.outputFormat

export const CLAUDE_CODE_SIDE_QUERY_SESSION_TITLE_RULE: ContextLedgerRule = {
  ruleId: "claude-code.side-query.session-title.v1",
  ruleVersion: "2.1.123",
  description:
    "Claude Code 自动生成会话标题的 side query（generateSessionTitle）。" +
    "通过 queryHaiku() 发送给 Haiku 模型，tools=0，messages=1，" +
    "output_config=json_schema({title})。" +
    "queryScope=side_query 严格约束，主请求不会命中。",
  stability: "static",
  sourcemapRef: "restored-src/src/utils/sessionTitle.ts:56 + restored-src/src/services/api/claude.ts:3241",
  queryScope: "side_query",

  attribution: {
    // SESSION_TITLE_PROMPT 完整文本精确匹配（sessionTitle.ts:56-68），700 chars 固定常量
    pattern:
      "^Generate a concise, sentence-case title \\(3-7 words\\) that captures the main topic or goal of this coding session\\. " +
      "The title should be clear enough that the user recognizes the session in a list\\. " +
      "Use sentence case: capitalize only the first word and proper nouns\\.\\n\\n" +
      "Return JSON with a single \"title\" field\\.\\n\\n" +
      "Good examples:\\n" +
      "\\{\"title\": \"Fix login button on mobile\"\\}\\n" +
      "\\{\"title\": \"Add OAuth authentication\"\\}\\n" +
      "\\{\"title\": \"Debug failing CI tests\"\\}\\n" +
      "\\{\"title\": \"Refactor API client error handling\"\\}\\n\\n" +
      "Bad \\(too vague\\): \\{\"title\": \"Code changes\"\\}\\n" +
      "Bad \\(too long\\): \\{\"title\": \"Investigate and fix the issue where the login button does not respond on mobile devices\"\\}\\n" +
      "Bad \\(wrong case\\): \\{\"title\": \"Fix Login Button On Mobile\"\\}",
    matchMode: "regex",
    mechanism: "system_prompt_pattern",
    category: "system_prompt",
    location: {
      section: "system",
      segmentPosition: "segment_start",
    },
  },

  reconstruction: {
    preCondition: "generateSessionTitle() 调用时（新会话首条消息之后触发）",
    trigger: "from_harness_state",
    materialization: "exact_text",
    emits: {
      section: "system",
      category: "system_prompt",
      lifecycle: "query",
      contentPattern:
        "Generate a concise, sentence-case title (3-7 words) that captures the main topic or goal of this coding session. " +
        "The title should be clear enough that the user recognizes the session in a list. " +
        "Use sentence case: capitalize only the first word and proper nouns.\n\n" +
        "Return JSON with a single \"title\" field.\n\n" +
        "Good examples:\n" +
        "{\"title\": \"Fix login button on mobile\"}\n" +
        "{\"title\": \"Add OAuth authentication\"}\n" +
        "{\"title\": \"Debug failing CI tests\"}\n" +
        "{\"title\": \"Refactor API client error handling\"}\n\n" +
        "Bad (too vague): {\"title\": \"Code changes\"}\n" +
        "Bad (too long): {\"title\": \"Investigate and fix the issue where the login button does not respond on mobile devices\"}\n" +
        "Bad (wrong case): {\"title\": \"Fix Login Button On Mobile\"}",
    },
  },

  reconciliation: {
    comparePolicy: "raw_hash",
    confidence: "exact",
    exactTextExpected: true,
  },
};

export const CONTEXT_LEDGER_RULES: ContextLedgerRule[] = [
  // ── identity / noise ──────────────────────────────────────────────────────
  CLAUDE_CODE_SYSTEM_PROMPT_IDENTITY_RULE,
  CLAUDE_CODE_BILLING_NOISE_RULE,
  // ── 静态 system prompt body（main session）────────────────────────────────
  CLAUDE_CODE_INTRO_STANDARD_RULE,
  CLAUDE_CODE_INTRO_OUTPUT_STYLE_RULE,
  CLAUDE_CODE_SYSTEM_SECTION_RULE,
  CLAUDE_CODE_ACTIONS_SECTION_RULE,
  CLAUDE_CODE_OUTPUT_EFFICIENCY_EXTERNAL_RULE,
  CLAUDE_CODE_TONE_STYLE_EXTERNAL_RULE,
  CLAUDE_CODE_TEXT_OUTPUT_SECTION_RULE,
  // ── 동적 system prompt sections（main session）────────────────────────────
  CLAUDE_CODE_SESSION_GUIDANCE_RULE,
  CLAUDE_CODE_ENVIRONMENT_SECTION_RULE,
  CLAUDE_CODE_AUTO_MEMORY_SECTION_RULE,
  // ── side query rules ──────────────────────────────────────────────────────
  CLAUDE_CODE_SIDE_QUERY_SESSION_TITLE_RULE,
];

export const CONTEXT_LEDGER_RULE_BY_ID: ReadonlyMap<string, ContextLedgerRule> = new Map(
  CONTEXT_LEDGER_RULES.map((rule) => [rule.ruleId, rule]),
);

export function getContextLedgerRule(ruleId: string): ContextLedgerRule | undefined {
  return CONTEXT_LEDGER_RULE_BY_ID.get(ruleId);
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

# Rule Corpus 重构 + 2.1.150 对齐 — 实施总结

> **2026-05-30 更新 — Piebald 对照层已脱钩(降级)**
> 实测:21 个关注段里只有 2 个(harness/memory)能对齐 Piebald,311+ unexplained 永远 out_of_scope。
> 结论:Piebald 作为"逐段 ground truth 对照"投入产出比失衡(详见 `tmp/*/PIEBALD-ALIGNMENT.md`、
> `EXACT-EXTRACTION.md`)。**单次请求的真正 ground truth = proxy body + cli.js binary**(全、同版本、可 grep)。
> 决策:
>   - **删除**:`check-piebald-drift.ts` / `piebald-snapshot.ts` / `indexer/piebald-source-units.ts` /
>     `supported-versions.ts` / `exclusions/` / `manifests/` / schema 的 `SourceUnit`/`UnitAccounting`/
>     `Exclusions`/`VersionManifest` / `_generated` 的 `GENERATED_EXCLUSIONS`/`GENERATED_MANIFESTS` /
>     `npm run drift`+`piebald:sync`。
>   - **改造**:`version-baseline.ts` 的 baseline 从 manifest → 本地常量 `CORPUS_BASELINE_CCVERSION="2.1.158"`。
>   - **保留**:corpus MD 容器(rules/ 单一真值)+ generator + `_generated.ts` + appliesTo + 展示元数据 +
>     `sourceUnits` 字段(降为可选文档性参考)+ `coverage-report.ts`(proxy 驱动诊断)。
>   - **rule 改为 proxy + cli.js binary 自维护**;Piebald 仅留 CHANGELOG 当版本变更信号(人工偶尔参考,零代码依赖)。
> 下方历史记录保留(描述脱钩前的状态)。

---


**完成阶段**:Phase 1-6 + Codex Review 3 个 P1/P2 修复 + 版本告警机制 **全部完成**
**测试**:`npm test` **231 passed** / 1 skipped(改前 211 → 改后 231)
**system 区覆盖率(tmp/ea0bc205_T2_C4)**:46.6% → **100%**
**rule-registry.ts**:2862 → **914 行**(-68%)
**corpus rules MD**:85 个(全部 rules 单一真值)
**tsup bundle**:`dist/server.js` 518KB,**含全部 corpus 数据**(可直接 npm publish)

## Codex Review 修复(Phase 6 之后追加)

| Finding | 修复 | 验证 |
|---|---|---|
| **P1-1** tsup bundle 丢 corpus(readFileSync 跨 src/ 边界,prod build 失效) | runtime 改 import `_generated.ts`(由 `corpus-sync` 离线生成,入 git);`build:server` 链上挂 sync | dist/server.js 518KB 含全部 corpus ruleId ✓ |
| **P1-2** 嵌套 ``` 截断 tool pattern | loader 改 `## pattern` 后首 fence + 文件末**最后**一个 fence 包夹,允许 pattern 内嵌任意 ``` | SendMessage 48→**1181**;TaskUpdate→**2243**;TeamCreate→**6772** chars ✓ |
| **P2** readdirSync 顺序非确定,catch-all 抢匹配 | schema 加 `priority`(默认 0);catch-all `messages.system-reminder.v1` 显式 `-100`;loader 按 priority 降序+filename tiebreaker | reminder slot 命中具名 rule `user-context.v1`(不再被 catch-all 抢)✓ |

## 版本告警机制(用户选择"加",粗粒度运行时温度计)

- 新增 `rule-corpus/version-baseline.ts`:`checkVersionAgainstBaseline(proxyCcVersion)` 返回 5 档 matchLevel
- 比对 manifest baseline(`2.1.150`)与 proxy 实际 cc_version 的 major.minor(忽略 patch+fingerprint)
- **零热路径成本**:不参与 rule 候选过滤;per-rule `appliesTo` 是精准路由,本机制是粗粒度告警
- 5 档 matchLevel:
  - `exact` / `minor-match` / `minor-mismatch` / `major-mismatch` / `unparseable` / `baseline-missing`
- 实测:
  - `2.1.150.7e6` → exact;`2.1.149` → minor-match;`2.0.99` → minor-mismatch;`3.0.0` → major-mismatch

⚠️ **当前未挂调用点**:函数已可调,但还没接到 audit envelope / attribution-tree endpoint / proxy ingest 任一处。集成点需用户决策。

## 工作流(给用户)

```sh
# 改 corpus *.md
npm run corpus:sync           # 写 _generated.ts(入 git)
git add . && git commit       # MD + _generated.ts 一起 commit

# CI 校验(防漏 sync)
npm run corpus:check          # 重 sync 后 git diff 应空,否则 fail

# 诊断
npm run coverage tmp/<slug>/proxy_request.json   # 真实数据按 slotType 覆盖率
npm run drift                                    # 三差集(孤儿/未解释/漂移)

# 发布
npm run build:server          # 自动 chain corpus:sync → tsup → dist/server.js
# prepack 兜底:npm publish 时自动跑 build
```

## Phase 6 收尾改动(在 Phase 1-5 基础上)

- 用 `dump-rules-to-corpus.ts` 批量生成 **64 条** 余下 corpus MD(tools/MCP/messages/smoosh/side-query/vscode-extension-context)
- 数组 `CONTEXT_LEDGER_RULES` 完全由 `...CORPUS_LEDGER_RULES` spread 接管,**所有 65 个 hand-written const 已删除**
- schema 接受 `matchMode: structural`(legacy 兼容)+ slotId 数组形态(away-summary N:M)
- legacy alias 仅保留 `CLAUDE_CODE_MESSAGES_SKILL_LISTING_V1_RULE`(skill-listing.test.ts 仍 import,后续 PR 改测试 import 即可彻底删)
- 删除 82 个迁移占位注释 + 7 个 dead `*_PREFIX` 常量
- corpus rule 总数:Phase 5 末 21 条 → Phase 6 末 **85 条**

## Codex Review + 版本告警追加的文件清单

**新增**:
- `rule-corpus/_generated.ts` — codegen 产出,入 git,130KB,1854 行
- `rule-corpus/version-baseline.ts` — 运行时版本告警
- `rule-corpus/version-baseline.test.ts` — 8 个 matchLevel 测试
- `scripts/corpus-sync.ts` — codegen 工具(`--check` 模式给 CI)
- `.gitattributes` — `_generated.ts linguist-generated=true`

**修改**:
- `rule-corpus/schema.ts` — 加 `priority` 字段,允许 `matchMode: structural`,slotId 支持数组
- `rule-corpus/index.ts` — loader 用"## pattern 后首 fence + 文件末最后 fence";loadAllRules 按 priority 降序
- `rule-corpus/runtime.ts` — 改 import `_generated`,运行时 0 readFileSync
- `rule-corpus/rules/messages-system-reminder-v1.md` — 加 `priority: -100`(catch-all 标注)
- 根 `package.json` — 加 `corpus:sync` / `corpus:check` / `coverage` / `drift` scripts;`build:server` chain `corpus:sync`

## 新增文件

### 5 层抽象骨架
- `rule-corpus/schema.ts` — zod schemas:`SourceUnit` / `Rule` / `UnitAccounting` /
  `Exclusions` / `VersionManifest` + `SourceRelation`(exact/template/partial/runtime-derived)
- `rule-corpus/index.ts` — `loadCorpus()`:MD frontmatter + fenced code block 解析
- `rule-corpus/generator.ts` — corpus Rule → ContextLedgerRule + ContextRule + SLOT_BINDINGS
- `rule-corpus/runtime.ts` — 模块加载入口,统一暴露 CORPUS_LEDGER_RULES / CORPUS_CONTEXT_RULES /
  CORPUS_SLOT_BINDINGS / CORPUS_LEDGER_RULES_BY_ID

### Corpus 数据(21 条 system rules)
- `rule-corpus/rules/system-prompt.identity.md` — 手写(MVP 第一条迁移)
- `rule-corpus/rules/system-prompt.billing-noise.md` — 手写
- `rule-corpus/rules/system-prompt-*-v1.md` × 15 — 由 `dump-rules-to-corpus.ts` 批量生成
- `rule-corpus/rules/system-prompt-harness-v1.md` — **新(2.1.150 ≥)**
- `rule-corpus/rules/system-prompt-memory-v1.md` — **新(2.1.150 ≥,取代 auto-memory)**
- `rule-corpus/rules/system-prompt-intro-standard-v2.md` — **新(2.1.150 ≥,简化版 intro)**
- `rule-corpus/rules/system-prompt-intro-style-guidance-v1.md` — **新(2.1.150 ≥,sys[3] 新增 prelude)**

### Exclusions / Manifests
- `rule-corpus/exclusions/piebald-2.1.150.md` — UnitAccounting(Phase 5 minimal,待 Phase 6 填全)
- `rule-corpus/manifests/claude-code-2.1.150.md` — VersionManifest(MVP baseline)

### Indexer + 诊断脚本
- `rule-corpus/indexer/piebald-source-units.ts` — 扫 Piebald md → SourceUnit[]
- `scripts/coverage-report.ts` — 真实 proxy_request 覆盖率报告
- `scripts/check-piebald-drift.ts` — 三差集 + relation-aware 校验
- `scripts/dump-rules-to-corpus.ts` — 一次性反向序列化(Phase 2 用,保留)

### 测试
- `rule-corpus/generator.test.ts` — 生成器单测(9 cases)
- `rule-corpus/identity-migration.test.ts` — Phase 2 deep-equal 护栏(3 cases)

## 修改文件

| 文件 | 改动 | 行数变化 |
|---|---|---|
| `server/src/context-ledger/rules/rule-registry.ts` | 删 16 条 system const + 注释;数组改 `...CORPUS_LEDGER_RULES` spread | **2862 → 2286 (-576 行)** |
| `server/src/context-ledger/rules/context-rule-registry.ts` | 删 17 条 hand-written SLOT_BINDINGS;末尾 spread CORPUS_SLOT_BINDINGS | -18 行 |
| `server/src/context-ledger/parser/ast-builder.ts` | 加 `slugifyHeader()` + `splitByH1Headers` slug fallback | +37 行 |
| `server/package.json` | + `gray-matter` + `zod` + `js-yaml` + `@types/js-yaml` | +6 行 |

## 新建的 21 条 corpus rules(总览)

| ruleId | slotId | appliesTo | verifiedFor | sourceUnits |
|---|---|---|---|---|
| billing-noise.v1 | system.billing | — | 2.1.150 | [] (wrapper) |
| system-prompt-identity.v1 | system.identity | — | 2.1.150 | [] (wrapper) |
| system-prompt-intro.standard.v1 | system.main-prompt.section.prelude | ≤2.1.149 | null | [] |
| system-prompt-intro.output-style.v1 | system.main-prompt.section.prelude | ≤2.1.149 | null | [] |
| **system-prompt-intro.standard.v2** | system.main-prompt.section.prelude | **≥2.1.150** | 2.1.150 | [] |
| **system-prompt-intro.style-guidance.v1** | system.main-prompt.section.prelude | **≥2.1.150** | 2.1.150 | [] |
| system-prompt-system-section.v1 | system.main-prompt.section.system | — | null | [] |
| system-prompt-doing-tasks.v1 | system.main-prompt.section.doing-tasks | — | null | [] |
| system-prompt-actions-section.v1 | system.main-prompt.section.actions | — | null | [] |
| system-prompt-using-your-tools.v1 | system.main-prompt.section.using-tools | — | null | [] |
| system-prompt-output-efficiency.external.v1 | system.main-prompt.section.output-efficiency | — | null | [] |
| system-prompt-tone-style.external.v0 | system.main-prompt.section.tone-style | ≤2.1.140 | null | [] |
| system-prompt-tone-style.external.v1 | system.main-prompt.section.tone-style | ≥2.1.141 | null | [] |
| system-prompt-text-output-section.v1 | system.main-prompt.section.text-output | — | null | [] |
| system-prompt-session-guidance.v1 | system.main-prompt.section.session-guidance | — | 2.1.150 | [] |
| system-prompt-auto-memory.v1 | system.main-prompt.section.auto-memory | ≤2.1.149 | null | [] |
| system-prompt-environment.v1 | system.main-prompt.section.environment | — | 2.1.150 | [] |
| system-prompt-context-management.v1 | system.main-prompt.section.context-management | — | 2.1.150 | [] |
| system-prompt-gitstatus.v1 | system.main-prompt.section.context | — | 2.1.150 | [] |
| **system-prompt-harness.v1** | system.main-prompt.section.harness | **≥2.1.150** | 2.1.150 | system-prompt-harness-instructions(partial) |
| **system-prompt-memory.v1** | system.main-prompt.section.memory | **≥2.1.150** | 2.1.150 | system-prompt-memory-instructions(partial) |

## Coverage / Drift Baseline

### Coverage(`tmp/ea0bc205_T2_C4/proxy_request.json` @ cc_version=2.1.150.7e6)
- **system 区:总 7632 chars 已覆盖 7632 chars (100.0%)**
- 改前:46.6% (3556/7632);改后:100% (+4076 chars 被规则识别)

### Drift(三差集)
- ① **孤儿规则:0** ✓
- ② **未解释单元:310**(MVP 范围外:Piebald 313 - 已 covered 3 = 310;系统、tools、agents、skills、data 待 Phase 6 分类到 exclusions)
- ③ **漂移:0** ✓

## Phase 6 待办(彻底废弃 legacy)

按 Task #17 描述:
- 把 ~60 条剩余 hand-written rules(tools.* / messages.* / smoosh.* / side-query.* /
  vscode-extension-context.v1 等)全部迁到 corpus
- 在 exclusions/piebald-2.1.150.md 把 310 个未解释单元分类到 covered / handled_elsewhere /
  out_of_scope / unsupported,直到三差集全空
- 删除 rule-registry.ts 中剩余的 const 定义 + 注释(只保留生成器入口)
- 删除 context-rule-registry.ts 的 SLOT_BINDINGS map(完全由 CORPUS_SLOT_BINDINGS 接管)
- 在 ast-builder 中废弃 template H1 枚举(完全走 slugifyHeader)

## 核心架构决策记录

1. **MD frontmatter + fenced code block**:corpus 文件人读友好,与 Piebald 同源
2. **zod 校验**:运行时 + 类型一致
3. **gray-matter parser**:成熟稳定,不手维护 YAML
4. **生成器双输出**:一份 corpus 同时驱动 legacy ContextLedgerRule 和 AST ContextRule,
   消除"两套 rule 类型"的二元化
5. **slugify fallback**:新 H1(如 # Harness)无需改 template 也能派生 slot id
6. **relation-aware drift**:exact/template/partial/runtime-derived 四态,
   避免 Piebald `${var}` template 产生假阳性
7. **不上 DB,不拆独立 repo**:规则数据化但仍在 git,保留 review/回滚/可复现的免费红利

## 验证清单(运行命令)

```sh
cd server
npm test                                                       # → 223 passed
npx tsx scripts/coverage-report.ts ../tmp/ea0bc205_T2_C4/proxy_request.json  # → system 100%
npx tsx scripts/check-piebald-drift.ts                          # → ①=0 ②=310 ③=0
```

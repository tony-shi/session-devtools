---
ccVersion: "2.1.150"
piebaldRef:
  repo: "Piebald-AI/claude-code-system-prompts"
  tag: "v2.1.150"
  commit: "e7bc5c8"
rulesetVersion: "0.1.0-mvp"
generatedAt: "2026-05-28T07:00:00Z"
coverageBaseline:
  sourceUnitsTotal: 313
  accounted:
    covered: 3
    handled_elsewhere: 0
    out_of_scope: 0
    unsupported: 0
  runtimeFixture:
    path: "tmp/ea0bc205_T2_C4/proxy_request.json"
    chars: 7632
    covered: 7632
---

# Claude Code 2.1.150 VersionManifest(MVP Baseline)

## 状态

**MVP baseline**:首个用 corpus 架构表达的 CC 版本。本轮范围仅 system H1 规则
(15 条迁移自 legacy + 4 条 2.1.150 新增 = 19 条 system rules),tools / messages.inline /
smoosh 等剩余 ~60 条规则待 Phase 6 迁入 corpus。

## 关键指标

- **runtimeFixture(真实 2.1.150 proxy_request)**:system 区 **100% 覆盖**
  (改造前 ~46.6% → 后 100%,+53.4 个百分点)
- **sourceUnits**:Piebald 313 个单元,corpus rule 显式 cover 3 个
  (`system-prompt-memory-instructions` / `system-prompt-harness-instructions` 已 covered;
   sourceUnits=[] 的 wrapper rules 如 identity/billing 不算 cover)
- **drift 三差集**:① orphan 0 / ② unexplained **310**(MVP 范围外,待 Phase 6 分类) / ③ drift 0

## 范围承诺

| 单元类型 | Piebald 数量 | 本 manifest 处理 |
|---|---|---|
| `system-prompt-*` | 66 | 已 cover/对齐 5 个(memory / harness / 已部分 covered 通过其它 rules);其余在 H1 流外 → unexplained |
| `system-reminder-*` | 39 | 待 Phase 6 迁(走 inline 路径,handled_elsewhere) |
| `tool-description-*` | 83 | 待 Phase 6 迁 |
| `agent-prompt-*` | 47 | 多数 out_of_scope(我们 session 不出现 subagent prompts) |
| `skill-*` | 37 | 多数 out_of_scope(skill 内容,仅 skill 触发时出现) |
| `data-*` | 41 | 全部 out_of_scope(参考资料,不被注入) |

## Apply 2.1.150 deltas 清单(本轮)

**新增 rules**(全部 `appliesTo: { minCcVersion: "2.1.150" }`):
- `claude-code.system-prompt-harness.v1` — # Harness 段(610 chars)
- `claude-code.system-prompt-memory.v1` — # Memory 段(2114 chars,合并旧 # auto memory)
- `claude-code.system-prompt-intro.standard.v2` — sys[2] 简化 intro 段
- `claude-code.system-prompt-intro.style-guidance.v1` — sys[3] 新增 prelude 段

**版本收口**(加 `appliesTo: { maxCcVersion: "2.1.149" }`):
- `claude-code.system-prompt-intro.standard.v1`(原 2.1.126 全文 exact)
- `claude-code.system-prompt-intro.output-style.v1`
- `claude-code.system-prompt-auto-memory.v1`(被 2.1.150 # Memory 取代)

**verifiedFor bump 到 "2.1.150"**:
- identity / billing-noise / session-guidance / environment / context-management / gitstatus

## 工作流(下次 CC 新版本来临)

```sh
# 1. 拉取 Piebald 新 tag
git -C resources/piebald-system-prompts fetch --tags
git -C resources/piebald-system-prompts checkout v<NEW>

# 2. 抓一份新版 proxy_request 跑覆盖率
tsx server/scripts/coverage-report.ts tmp/<NEW-SLUG>/proxy_request.json

# 3. 查三差集
tsx server/scripts/check-piebald-drift.ts

# 4. 根据差集:
#    - drift 非空 → 老 rule 加 appliesTo: maxCcVersion;新写一条 appliesTo: minCcVersion
#    - unexplained 非空 → 加 corpus rule 或在 exclusions 中分类
#    - orphan 非空 → rule.sourceUnits 中已不存在的 unitId 删除或更名

# 5. 复跑 coverage-report 验证目标 fixture 覆盖率
# 6. 新增 manifests/claude-code-<NEW>.md
# 7. 提交 PR
```

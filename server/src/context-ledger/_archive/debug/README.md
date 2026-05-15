# Context Char Diff Audit — Gate 3.5

**审计辅助工具。** char-diff 现在被 audit pipeline 复用，定位是把
`ReconciliationReport` 渲染成人可读的字符级对账视图；它不修改任何
reconciliation 结果，也不反写 proxy 内容。

## 用途

对 `reconcileClaudeContext()` 产出的对齐结果进行人工 char 级精度校对，比较
`ExpectedQueryContext` 与 `ProxyQuerySnapshot` 之间的差异。

典型用途：
- proxy 中有多少字符无法被解释（既无 alignment 也无 attribution）？
- expected 与 proxy 的 segment 字符数在哪里出现了偏差？
- 哪些 expected segment 在 proxy 中没有对应项，反之亦然？

## 文件说明

| 文件 | 职责 |
|---|---|
| `char-diff.ts` | 纯逻辑：`computeCharDiff(report)` → `CharDiffReport` |
| `render-char-diff-html.ts` | `renderCharDiffHtml(diff)` → 自包含 HTML 字符串 |
| `char-diff.test.ts` | 单元测试（37 个用例） |
| `README.md` | 本文件 |

## 快速上手

**用真实 src fixture 一条命令运行**（完整调用链：proxy parser → attribution → reconstructor → reconciler）：

```sh
npm run scripts/context-char-diff.ts --fixture single-tool-call
open /tmp/context-char-diff-single-tool-call.html
```

可用的四个 fixture：

```sh
npm run scripts/context-char-diff.ts --fixture single-tool-call
npm run scripts/context-char-diff.ts --fixture large-tool-output
npm run scripts/context-char-diff.ts --fixture multi-turn-human
npm run scripts/context-char-diff.ts --fixture system-tools-overhead
```

指定输出路径：

```sh
npm run scripts/context-char-diff.ts --fixture large-tool-output --out /tmp/audit.html
open /tmp/audit.html
```

查看帮助：

```sh
npm run scripts/context-char-diff.ts --help
```

## 其他模式

**内置 mock**（无需任何外部文件，适合快速验证工具本身）：

```sh
npm run scripts/context-char-diff.ts --mock
open /tmp/context-char-diff-mock.html
```

**已有 JSON 报告**（传入 `reconcileClaudeContext()` 序列化的文件）：

```sh
npm run scripts/context-char-diff.ts /path/to/report.json
```

## 条目类型说明

| 类型 | 含义 |
|---|---|
| `matched` | 已对齐，字符数一致（偏差 ≤1%） |
| `approximate_match` | 已对齐，但字符数存在差异（偏差 >1%） |
| `suspect_match` | 仅由 category / role 启发式对齐，无内容锚点 |
| `expected_only` | expected segment 在 proxy 中没有对应项 |
| `proxy_only` | proxy segment 未被任何 alignment 覆盖 |
| `attribution_only` | proxy segment 仅由 attribution 解释，无对应 expected segment（未实现规则） |
| `server_side_attribution` | `billing_noise` 或其他已知 server-side 开销 |

## CharRange 格式

Range 是各 segment 按 `segment.order` 排序后**平铺拼接**时的字符偏移量，格式为左闭右开区间 `[start…end)`。

```
expected 平铺：[0…100) user_message  [100…300) tool_use  [300…7900) tool_result
proxy 平铺：   [0…90)  user_message  [90…280)  tool_use  [280…7880) tool_result
```

这里的偏移量是**审计坐标**，不对应原始请求体中的字节偏移。

## 约束

- **不修改** `routes.ts` 或任何 client 代码。
- **不将** proxy diff 反写回 `ContextMutation`（合同禁止）。
- 性能不敏感：O(n²) 索引构建对审计场景可接受。

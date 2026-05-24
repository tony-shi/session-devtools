# 前端重构 TODO（UI 层）

> 来源：`session-detail/` 四阶段拆分完成后的一次全量 client 扫描。
> 本文件只记录待办，**尚未动手**。每条都标了 ROI / 风险 / 是否需要决策。
> 验收门槛沿用：`cd client && npm run build`（tsc+vite）+ `npm run lint`（exit 0）+ 手动 smoke。

---

## 优先级总览（建议执行顺序）

1. [ ] **抽 `shared/CopyButton`** — 低风险、高价值，行为零变化
2. [ ] **合并与 canonical 一致的 fmt 副本** — 行为零变化
3. [ ] **拆 `AttributionTreePanel`（1512 行）** — 中等工作量，接缝清晰；高频文件需小心
4. [ ] **统一 divergent `fmtK`（Group B/C）** — ⚠️ 会改数字显示，**需先拍板**
5. [ ] **拆 `ProxyTraffic`（1032 行）** — 较低优先级

---

## A. 冗余逻辑（重复 helper）

### A1. CopyButton — 4 处一模一样 ✅ 干净可统合
"点击复制 + 1.5s ✓ 反馈" 出现在：
- `v2/AttributionTreePanel.tsx`（2 处：line ~731 `setCopied`、~947 `setCopiedAt`）
- `v2/session-detail/call/LlmCallDetailPanel.tsx`（`RawCopyButton`，line ~30）
- `components/ProxyTraffic.tsx`（line ~393）

**TODO**：抽 `v2/shared/CopyButton.tsx`（props: `text`、可选 `size`/`label`），4 处替换。
**风险**：低（同一 UX）。注意各处样式/尺寸略有差异，用 props 兜住。

### A2. fmt helper 重复 — ⚠️ 有行为变体，不是纯重复
canonical 在 `v2/lib/format.ts`。

| helper | 重复文件 | 处理 |
|---|---|---|
| `fmtK` | 见下分组 | 分两批 |
| `fmtPct` | CallLedger / AggregateLedger / LedgerExplainer | 核对后合并（疑似与 canonical 一致）|
| `fmtBytes` | ResponseTreePanel / ProxyTraffic(`formatBytes`) | 核对后合并 |
| `fmtTime` | SessionListV2 / 其它 | 核对 |
| `tryParseJson` | EventUnitCard / 其它 | 核对（疑似一致）|

**`fmtK` 三套行为（关键坑）**：
- **canonical 版**（`≥1M→M`、`≥1k→k`、带 `Math.abs`）：`TurnMinimap` / `shared/CallLedger` / `shared/AggregateLedger` / `shared/LedgerExplainer`
  → 与 `lib/format` **字节一致**，可直接换 import，**零行为变化**（= A2 第一批，安全）
- **"10k 阈值"版**（`<1000→String`、`<10000→x.xk`、`else Math.round/1000+k`、**无 M**）：`AttributionTreePanel` / `DiffPanel` / `CachePanel`
  → 换 canonical 会让 `12345`：`12k → 12.3k`，百万级多出 `M` —— **可见显示变化**
- **无 abs 版**（`n>=1k` 不取绝对值）：`ResponseTreePanel` —— 负数不缩写

**TODO（分两批）**：
- [ ] A2-a：canonical 一致的 4 份 fmtK + fmtPct/fmtBytes/tryParseJson → 改成 `import { fmtK, ... } from "../lib/format"`，删本地定义。**零行为变化**。
- [ ] A2-b（= 优先级 #4）：Group B/C 的 fmtK 统一。**需决策**：以 canonical（带 M、10.x k）为准，还是保留"整数 k"显示？定了再动，会改 attribution/diff/cache 的数字显示。

---

## B. 文件过大（session-detail 之外，本次重构未触及）

| 文件 | 行数 | 性质 / 可拆点 |
|---|---:|---|
| `v2/AttributionTreePanel.tsx` | **1512** | **「primitives 库 + 面板」混装**。已 export 给 Lens/Diff 复用的：`SECTION_META` `leafFill` `sectionOf` `shortSlot` `originLabel` `flattenLeaves` `computeSectionStats` `LeafStrip`(~350) `LeafTable`(~502) `SelectedDetail`(~934)。真正的 `AttributionTreePanel` 组件在 line ~1367 之后，只占 ~145 行。 |
| `v2/DiffPanel.tsx` | 1132 | diff 树视图；`SelectedDiffDetail` 已被 LensPanel 复用 |
| `v2/AttributionTreeLensPanel.tsx` | 1124 | 多 lens 视图，已大量复用 AttributionTreePanel + DiffPanel 的导出 |
| `components/ProxyTraffic.tsx` | 1032 | 列表 + 详情 Sheet + body 查看器（`LazyBody`/`HeaderTable`/`CopyButton`/`VisibilityBadge`），可按这三块拆 |
| `v2/TurnMinimap.tsx` | 718 | 单一职责（echarts minimap），可不动 |
| `v2/shared/EventUnitCard.tsx` | 593 | 单一职责，可不动 |

**TODO**：
- [ ] B1（= 优先级 #3）：拆 `AttributionTreePanel` → 建 `v2/attribution-tree/`：
  - `leaf-helpers.ts`（leafFill/sectionOf/shortSlot/originLabel/flattenLeaves/computeSectionStats/SectionMeta/SectionId）
  - `LeafStrip.tsx` / `LeafTable.tsx` / `SelectedDetail.tsx`
  - `AttributionTreePanel.tsx` 瘦成只剩面板
  - ⚠️ 高频文件、被 Lens/Diff/Response 依赖，改 import 面广，逐个 build+lint。
  - 注意：`fmtK` 也定义在这里（Group B 变体）——拆分时跟 A2-b 一起决策。
- [ ] B2（= 优先级 #5）：拆 `ProxyTraffic` → `proxy-traffic/`：`ProxyTrafficList` / `RequestDetailSheet` / `LazyBody` + `HeaderTable`。先抽 A1 的 CopyButton 再拆更顺。

---

## C. 极度类似 / 可统合

- **CopyButton** —— 见 A1（最干净）。
- **\*TreePanel 家族**：已是「hub（AttributionTreePanel 导出 primitives）+ consumers（Lens/Diff/Response）」模式，**不是裸重复**，无需再合并；需要的是把 hub 文件拆小（见 B1）。
- **3 个 Ledger 组件**（`shared/CallLedger` / `shared/AggregateLedger` / `shared/LedgerExplainer`）：共用 fmtK/fmtPct + 类似的 token bar 渲染。**待评估**是否有可抽的条形渲染原件，优先级低。

---

## 受保护资产（重构时勿破坏）

- `session-detail/` 的单向数据流：`navigate(SessionNav)` 漏斗 → URL → reconciliation effect → `applyNav` 写回 state。
- `buildSessionPath` / `parseSessionNav`、`subAgentParentTurn`（parentCallId 反查）、bare-subagent resolve-then-redirect。
- 多模式渲染的面板（turn / call / subagent / linked）的 context-dependent props（`onSelectCall`/`onClose`/`onSubAgentClick`）是真实变化点，**不要硬塞进 context**。
- ESLint：correctness 规则（`rules-of-hooks`、`no-unused-vars` 等）保持 error；React-Compiler dev-hint（`set-state-in-effect`/`react-refresh/only-export-components`/`static-components`/`purity`）已在 `eslint.config.js` 降为 warn。

// parser/audit/entrypoint：从 snapshot 中提取 cc_entrypoint 并判定是否为 IDE 入口。
//
// 为什么放在 audit 模块下而不是 attribution / parser：
//   - parser 不做"分类判断"——它只按 template 切分，按 rule 命中标 origin。
//   - entrypoint 字段已经被 billing-noise rule 抽成命名捕获组（rule-registry.ts:483）。
//     它就在 snapshot 上，audit 只是"读"它，不参与归因。
//   - 引入 IDE 排除的唯一动机来自 audit：当前 rule 库针对 CLI 入口校准，IDE 入口会
//     给 audit 引入大量 partial / none 噪音。所以判定逻辑天然属于 audit 边界。
//
// 范围：本文件只做"检测 + 分类"，不做 audit 自身的桶计算。
// 未来若新增 IDE-specific rule / template，CLI 与 IDE 走同一套 audit 后这层判定可下线。

import type { ParsedQuerySnapshot } from "../types";

/**
 * CLI 入口的固定值。Claude Code CLI 通过 CLAUDE_CODE_ENTRYPOINT=cli 注入。
 * 其他可观察到的值包括 claude-vscode / claude-jetbrains 等 IDE 集成。
 */
export const CLI_ENTRYPOINT = "cli";

/**
 * billing-noise rule 的稳定 ruleId（见 rule-registry.ts:464）。
 * 这里硬编码字符串而不是 import，避免 audit 反向依赖 rules/ 目录。
 */
const BILLING_NOISE_RULE_ID = "claude-code.billing-noise.v1";

/**
 * detectEntrypoint：扫描 snapshot.index，找到 billing-noise rule 命中的节点，
 * 从其 dynamicFields 中读出 `entrypoint` 值。
 *
 * 返回 undefined 的情况：
 *   - 该请求未注入 billing header（罕见——sourcemap 保证主请求路径每次都注入）
 *   - billing-noise rule 未命中（template/regex 漂移）
 *   - rule 命中但 entrypoint 捕获组缺失（pattern 变更）
 *
 * 任一未知情况都"保留 audit"——少漏比误排更安全。
 */
export function detectEntrypoint(snapshot: ParsedQuerySnapshot): string | undefined {
  for (const node of Object.values(snapshot.index)) {
    const origin = node.origin;
    if (origin.kind !== "rule") continue;
    if (origin.ruleId !== BILLING_NOISE_RULE_ID) continue;
    const fields = origin.dynamicFields;
    if (!fields) continue;
    for (const f of fields) {
      if (f.name === "entrypoint") {
        return f.valuePreview;
      }
    }
  }
  return undefined;
}

/**
 * isNonCliEntrypoint：是否为非 CLI 入口（即 IDE 等集成入口）。
 *
 * 当前阶段策略：除 "cli" 之外的所有 entrypoint 一律视作 IDE 路径并从 audit 排除。
 * 这是 audit 计算阶段的临时方案：rule 库目前针对 CLI 校准，IDE 的 system prompt
 * 形态略有差异，会让 partial / none 桶被大量虚报。
 *
 * 已知的 IDE entrypoint：claude-vscode、claude-jetbrains。
 * 未知 entrypoint（rule 变更产生的新值）也走排除分支——保守取向，避免污染统计。
 *
 * 未来若引入 IDE-specific rule / template，应改为"仅排除明确未支持的 entrypoint"。
 */
export function isNonCliEntrypoint(entrypoint: string | undefined): boolean {
  if (entrypoint === undefined) return false;
  return entrypoint !== CLI_ENTRYPOINT;
}

/**
 * AuditExclusion：audit 结果上的排除标记。
 *
 * - reason: 排除原因码，目前仅 "non-cli-entrypoint" 一种
 * - entrypoint: 触发排除的 entrypoint 值，便于前端/排查时定位
 */
export interface AuditExclusion {
  reason: "non-cli-entrypoint";
  entrypoint: string;
}

/**
 * computeAuditExclusion：从 snapshot 推导是否需要排除 audit。
 * 返回 undefined 表示无需排除（正常计算 audit）。
 */
export function computeAuditExclusion(
  snapshot: ParsedQuerySnapshot,
): AuditExclusion | undefined {
  const entrypoint = detectEntrypoint(snapshot);
  if (!isNonCliEntrypoint(entrypoint)) return undefined;
  return { reason: "non-cli-entrypoint", entrypoint: entrypoint! };
}

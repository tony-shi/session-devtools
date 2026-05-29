// rule-corpus/supported-versions.ts
//
// 单一真值:corpus 支持 / 对照的 Piebald 版本范围。更新 CC 版本时:
//   1. 改这里的 SUPPORTED_PIEBALD_VERSIONS(加新 tag)
//   2. 重跑 `npm run piebald:sync`(物化新版本快照)
//   3. 跑 `npm run drift -- <ccVersion>` 看新版本 drift,按需补 corpus rule
//
// 被 piebald-snapshot / check-piebald-drift / coverage-report 共用,保证版本范围一处定义。

/** 支持的 Piebald 版本快照,按版本号升序。第一个 = baseline,最后一个 = 当前最新。
 *  注:Piebald 跳号(无 151/155),这里只列实际存在的 tag。 */
export const SUPPORTED_PIEBALD_VERSIONS = [
  "v2.1.150",
  "v2.1.152",
  "v2.1.153",
  "v2.1.154",
  "v2.1.156",
] as const;

/** corpus 对齐的 baseline(最早支持版本)。 */
export const BASELINE_PIEBALD_VERSION = SUPPORTED_PIEBALD_VERSIONS[0];

/** 当前最新支持版本。 */
export const LATEST_PIEBALD_VERSION =
  SUPPORTED_PIEBALD_VERSIONS[SUPPORTED_PIEBALD_VERSIONS.length - 1];

/** "v2.1.156" → "2.1.156"(去 v 前缀，对齐 cc_version 的 major.minor.patch）。 */
export function tagToVersion(tag: string): string {
  return tag.replace(/^v/, "");
}

/** 比较两个 "X.Y.Z" 版本三元组：负=a<b，0=相等，正=a>b。忽略第四段 fingerprint。 */
function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  return (pa[0]! - pb[0]!) || (pa[1]! - pb[1]!) || (pa[2]! - pb[2]!);
}

/**
 * proxy cc_version（"2.1.153.abc"）→ 最匹配的快照 tag。
 *
 * 策略:取 ≤ proxy 版本的最大支持版本（"floor" 匹配）。
 *   - proxy=2.1.153 → v2.1.153（精确）
 *   - proxy=2.1.155 → v2.1.154（155 无快照，落到 ≤155 的最大 = 154）
 *   - proxy=2.1.151 → v2.1.150（151 无快照，落到 150）
 *   - proxy=2.1.149 → null（早于 baseline，不在支持范围）
 *   - proxy=2.2.x   → v2.1.156（晚于最新，floor 到最新；调用方可另判 major-mismatch）
 */
export function pickSnapshotForVersion(ccVersion: string | undefined): string | null {
  if (!ccVersion) return null;
  const m = ccVersion.match(/^(\d+\.\d+\.\d+)/);
  if (!m) return null;
  const target = m[1]!;
  let best: string | null = null;
  for (const tag of SUPPORTED_PIEBALD_VERSIONS) {
    if (cmpVersion(tagToVersion(tag), target) <= 0) best = tag;
  }
  return best; // null = proxy 早于 baseline（不支持）
}

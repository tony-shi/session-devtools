// cc_version 语义 + VersionPredicate 比较。
//
// cc_version 格式："X.Y.Z.fingerprint"（如 "2.1.140.453" / "2.1.142.6c2"）。
//   - 前 3 段：semver（major.minor.patch），数值比较。
//   - 第 4 段：build hex fingerprint，无序 hash —— 不参与"先后"比较，仅在
//     exactCcVersions 显式约束时按等值匹配。
//
// 见 rule-registry.ts:CLAUDE_CODE_BILLING_NOISE_RULE 的 pattern 定义协议出处。

export type VersionPredicate =
  | { minCcVersion: string }                  // 含。前 3 段比较
  | { maxCcVersion: string }                  // 含。前 3 段比较
  | { range: [string, string] }               // [lo, hi] 闭区间。前 3 段比较
  | { exactCcVersions: string[] };            // 任一匹配。3 段值忽略 fingerprint；4 段值精确比 fingerprint

interface ParsedCcVersion {
  major: number;
  minor: number;
  patch: number;
  fingerprint?: string;
}

const CC_VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:\.([0-9a-fA-F]+))?$/;

export function parseCcVersion(s: string): ParsedCcVersion | null {
  const m = CC_VERSION_RE.exec(s);
  if (!m) return null;
  const [, major, minor, patch, fingerprint] = m;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    ...(fingerprint ? { fingerprint } : {}),
  };
}

/** semver 前 3 段比较，fingerprint 忽略。返回 -1/0/1。 */
function compareSemver(a: ParsedCcVersion, b: ParsedCcVersion): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

/** 判断 cc 是否满足 predicate。
 *
 *   - min/max/range：仅比较前 3 段（major.minor.patch）。fingerprint 段无序，不参与。
 *     即 minCcVersion:"2.1.142" 接受 "2.1.142.*" 全部 fingerprint。
 *   - exactCcVersions：predicate 元素若含 fingerprint 段，要求 4 段全等；否则只比前 3 段。
 *
 * 不合法的 cc 字符串返回 false（"never satisfies"）。
 */
export function satisfiesCcVersion(cc: string, pred: VersionPredicate): boolean {
  const v = parseCcVersion(cc);
  if (!v) return false;

  if ("minCcVersion" in pred) {
    const p = parseCcVersion(pred.minCcVersion);
    if (!p) return false;
    return compareSemver(v, p) >= 0;
  }

  if ("maxCcVersion" in pred) {
    const p = parseCcVersion(pred.maxCcVersion);
    if (!p) return false;
    return compareSemver(v, p) <= 0;
  }

  if ("range" in pred) {
    const lo = parseCcVersion(pred.range[0]);
    const hi = parseCcVersion(pred.range[1]);
    if (!lo || !hi) return false;
    return compareSemver(v, lo) >= 0 && compareSemver(v, hi) <= 0;
  }

  if ("exactCcVersions" in pred) {
    return pred.exactCcVersions.some((spec) => {
      const p = parseCcVersion(spec);
      if (!p) return false;
      if (v.major !== p.major) return false;
      if (v.minor !== p.minor) return false;
      if (v.patch !== p.patch) return false;
      // predicate 显式给了 fingerprint → 必须 4 段全等
      if (p.fingerprint !== undefined) {
        return v.fingerprint === p.fingerprint;
      }
      // predicate 只给 3 段 → 任意 fingerprint 都通过
      return true;
    });
  }

  return false;
}

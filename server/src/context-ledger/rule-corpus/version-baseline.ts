// rule-corpus/version-baseline.ts
//
// 运行时版本告警(粗粒度,零热路径成本):
//   - 用一个本地常量声明 corpus 当前对齐校对的 cc_version(baseline)
//   - proxy 实际 cc_version 与 baseline 比对 major.minor(忽略 patch + fingerprint)
//   - 不参与 rule 候选过滤(那是 per-rule appliesTo 的职责);仅供 audit / UI 报告
//
// 设计原则:
//   - per-rule appliesTo  = 精准版本路由(已存在,工作正常)
//   - VersionBaseline 比对 = 粗粒度温度计(本模块),让"corpus 完全不适用"在 audit 里立刻可见
//   - 同 minor 内的差异由 appliesTo 处理;跨 minor 才告警
//
// 注:baseline 不再来自 Piebald VersionManifest(已脱钩)。corpus 改为 proxy + cli.js
// binary 自维护后,baseline 就是"我们当前在哪个 cc_version 上校对 rule"——自维护时
// 更新下方常量即可。

import { parseCcVersion } from "../version";

/** corpus 当前对齐校对的 cc_version。自维护 rule 时(在新版本 proxy 上重新校对后)更新这里。 */
export const CORPUS_BASELINE_CCVERSION = "2.1.158";

export type BaselineMatchLevel =
  | "exact"            // major.minor.patch 全等
  | "minor-match"      // major.minor 相同,patch 不同(可接受;per-rule appliesTo 兜底)
  | "minor-mismatch"   // major 同 minor 不同(corpus 大概率有缺漂;严重)
  | "major-mismatch"   // major 不同(corpus 几乎不适用)
  | "unparseable";     // proxy 端 cc_version 解析失败

export interface VersionBaselineReport {
  matchLevel: BaselineMatchLevel;
  baseline: { ccVersion: string } | null;
  proxy: { ccVersion: string; major: number; minor: number; patch: number } | null;
  message: string;  // 人类可读的一句话,可直接放进 audit 报告 / UI tooltip
}

/** 对 proxy 端实际 cc_version 与 corpus baseline 做粗粒度比对。 */
export function checkVersionAgainstBaseline(proxyCcVersion: string | undefined): VersionBaselineReport {
  const baseInfo = { ccVersion: CORPUS_BASELINE_CCVERSION };
  if (!proxyCcVersion) {
    return {
      matchLevel: "unparseable",
      baseline: baseInfo,
      proxy: null,
      message: `proxy 未提供 cc_version(billing header 抽取失败);corpus baseline=${CORPUS_BASELINE_CCVERSION}`,
    };
  }
  const proxyV = parseCcVersion(proxyCcVersion);
  const baseV = parseCcVersion(CORPUS_BASELINE_CCVERSION);
  if (!proxyV || !baseV) {
    return {
      matchLevel: "unparseable",
      baseline: baseInfo,
      proxy: null,
      message: `cc_version 无法解析:proxy="${proxyCcVersion}";corpus baseline=${CORPUS_BASELINE_CCVERSION}`,
    };
  }
  const proxyInfo = { ccVersion: proxyCcVersion, major: proxyV.major, minor: proxyV.minor, patch: proxyV.patch };

  if (proxyV.major !== baseV.major) {
    return {
      matchLevel: "major-mismatch",
      baseline: baseInfo,
      proxy: proxyInfo,
      message:
        `⚠️ MAJOR version 不匹配:proxy=${proxyV.major}.${proxyV.minor}.${proxyV.patch} vs corpus baseline=${CORPUS_BASELINE_CCVERSION}。` +
        `corpus 几乎不适用,归因结果不可信。`,
    };
  }
  if (proxyV.minor !== baseV.minor) {
    return {
      matchLevel: "minor-mismatch",
      baseline: baseInfo,
      proxy: proxyInfo,
      message:
        `⚠️ MINOR version 不匹配:proxy=${proxyV.major}.${proxyV.minor}.${proxyV.patch} vs corpus baseline=${CORPUS_BASELINE_CCVERSION}。` +
        `corpus 大概率有显著漂移,部分 rule 可能失配。建议跑 coverage-report 评估。`,
    };
  }
  if (proxyV.patch !== baseV.patch) {
    return {
      matchLevel: "minor-match",
      baseline: baseInfo,
      proxy: proxyInfo,
      message:
        `同 minor 内 patch 差异:proxy=${proxyV.major}.${proxyV.minor}.${proxyV.patch} vs corpus baseline=${CORPUS_BASELINE_CCVERSION}。` +
        `per-rule appliesTo 处理细节差异,通常工作正常。`,
    };
  }
  return {
    matchLevel: "exact",
    baseline: baseInfo,
    proxy: proxyInfo,
    message: `cc_version 完全匹配 corpus baseline=${CORPUS_BASELINE_CCVERSION}。`,
  };
}

/** baseline 元信息(便于 UI 显示"我们对齐了哪个版本") */
export function getActiveBaseline(): { ccVersion: string } {
  return { ccVersion: CORPUS_BASELINE_CCVERSION };
}

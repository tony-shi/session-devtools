// rule-corpus/version-baseline.ts
//
// 运行时版本告警(粗粒度,零热路径成本):
//   - corpus 的 manifest baseline 声明我们对齐了哪个 cc_version(例 "2.1.150")
//   - proxy 实际 cc_version 与 baseline 比对 major.minor(忽略 patch + fingerprint)
//   - 不参与 rule 候选过滤(那是 per-rule appliesTo 的职责);仅供 audit / UI 报告
//
// 设计原则:
//   - per-rule appliesTo  = 精准版本路由(已存在,工作正常)
//   - VersionBaseline 比对 = 粗粒度温度计(本模块),让"corpus 完全不适用"在 audit 里立刻可见
//   - 同 minor 内的差异由 appliesTo 处理;跨 minor 才告警

import { GENERATED_MANIFESTS } from "./_generated";
import { parseCcVersion } from "../version";

export type BaselineMatchLevel =
  | "exact"            // major.minor.patch 全等
  | "minor-match"      // major.minor 相同,patch 不同(可接受;per-rule appliesTo 兜底)
  | "minor-mismatch"   // major 同 minor 不同(corpus 大概率有缺漂;严重)
  | "major-mismatch"   // major 不同(corpus 几乎不适用)
  | "baseline-missing" // manifests/ 为空,无 baseline 可比对
  | "unparseable";     // proxy 端 cc_version 解析失败

export interface VersionBaselineReport {
  matchLevel: BaselineMatchLevel;
  baseline: { ccVersion: string; piebaldTag: string } | null;
  proxy: { ccVersion: string; major: number; minor: number; patch: number } | null;
  message: string;  // 人类可读的一句话,可直接放进 audit 报告 / UI tooltip
}

// 选择"当前 baseline":若多份 manifest,取最新版本(简化:取数组最后一个;
// 实际场景中 corpus 一次只有一个 active baseline)。
function pickBaseline() {
  if (GENERATED_MANIFESTS.length === 0) return null;
  return GENERATED_MANIFESTS[GENERATED_MANIFESTS.length - 1]!;
}

/** 对 proxy 端实际 cc_version 与 corpus baseline 做粗粒度比对。 */
export function checkVersionAgainstBaseline(proxyCcVersion: string | undefined): VersionBaselineReport {
  const m = pickBaseline();
  if (!m) {
    return {
      matchLevel: "baseline-missing",
      baseline: null,
      proxy: proxyCcVersion ? { ccVersion: proxyCcVersion, major: 0, minor: 0, patch: 0 } : null,
      message: "corpus 无 VersionManifest baseline(manifests/ 目录为空)",
    };
  }
  const baseInfo = { ccVersion: m.ccVersion, piebaldTag: m.piebaldRef.tag };
  if (!proxyCcVersion) {
    return {
      matchLevel: "unparseable",
      baseline: baseInfo,
      proxy: null,
      message: `proxy 未提供 cc_version(billing header 抽取失败);corpus baseline=${m.ccVersion}`,
    };
  }
  const proxyV = parseCcVersion(proxyCcVersion);
  if (!proxyV) {
    return {
      matchLevel: "unparseable",
      baseline: baseInfo,
      proxy: null,
      message: `proxy cc_version 无法解析:"${proxyCcVersion}";corpus baseline=${m.ccVersion}`,
    };
  }
  const baseV = parseCcVersion(m.ccVersion);
  if (!baseV) {
    // manifest 写错了——也归到 baseline-missing 语义
    return {
      matchLevel: "baseline-missing",
      baseline: baseInfo,
      proxy: { ccVersion: proxyCcVersion, major: proxyV.major, minor: proxyV.minor, patch: proxyV.patch },
      message: `manifest baseline 版本号 "${m.ccVersion}" 无法解析`,
    };
  }
  const proxyInfo = { ccVersion: proxyCcVersion, major: proxyV.major, minor: proxyV.minor, patch: proxyV.patch };

  if (proxyV.major !== baseV.major) {
    return {
      matchLevel: "major-mismatch",
      baseline: baseInfo,
      proxy: proxyInfo,
      message:
        `⚠️ MAJOR version 不匹配:proxy=${proxyV.major}.${proxyV.minor}.${proxyV.patch} vs corpus baseline=${m.ccVersion}。` +
        `corpus 几乎不适用,归因结果不可信。`,
    };
  }
  if (proxyV.minor !== baseV.minor) {
    return {
      matchLevel: "minor-mismatch",
      baseline: baseInfo,
      proxy: proxyInfo,
      message:
        `⚠️ MINOR version 不匹配:proxy=${proxyV.major}.${proxyV.minor}.${proxyV.patch} vs corpus baseline=${m.ccVersion}。` +
        `corpus 大概率有显著漂移,部分 rule 可能失配。建议跑 coverage-report 评估。`,
    };
  }
  if (proxyV.patch !== baseV.patch) {
    return {
      matchLevel: "minor-match",
      baseline: baseInfo,
      proxy: proxyInfo,
      message:
        `同 minor 内 patch 差异:proxy=${proxyV.major}.${proxyV.minor}.${proxyV.patch} vs corpus baseline=${m.ccVersion}。` +
        `per-rule appliesTo 处理细节差异,通常工作正常。`,
    };
  }
  return {
    matchLevel: "exact",
    baseline: baseInfo,
    proxy: proxyInfo,
    message: `cc_version 完全匹配 corpus baseline=${m.ccVersion}。`,
  };
}

/** baseline 元信息(便于 UI 显示"我们对齐了哪个版本") */
export function getActiveBaseline() {
  return pickBaseline();
}

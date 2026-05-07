// parser/attribution/coverage：基于 RuleMatchEvidence 的字符级覆盖率桶。
//
// 模块职责（统计层）：
//   - 只读取 SegmentAttribution.match（evidence），不依赖 confidence。
//   - 桶选择规则见 types.ts AttributionCoverage 注释。
//   - 没有 attribution 的节点视作 ruleGap，防止覆盖率虚高。

import type { ParsedQuerySnapshot } from "../types";
import type { AttributionCoverage, SegmentAttribution } from "./types";

export function computeCoverage(
  attributions: SegmentAttribution[],
  snapshot: ParsedQuerySnapshot,
): AttributionCoverage {
  const nodes = Object.values(snapshot.index);
  const totalChars = nodes.reduce((sum, node) => sum + node.charCount, 0);
  const attrByNodeId = new Map(attributions.map((attr) => [attr.nodeId, attr]));

  const coverage: AttributionCoverage = {
    totalNodes: nodes.length,
    totalChars,
    exactChars: 0,
    templateLiteralChars: 0,
    dynamicCapturedChars: 0,
    recognizedUnexplainedChars: 0,
    ruleGapChars: 0,
    ruleGap: { nodes: 0, chars: 0 },
    recognitionRatio: 0,
    evidenceBackedRatio: 0,
    byteReconstructableRatio: 0,
  };

  for (const node of nodes) {
    const chars = node.charCount;
    const attr = attrByNodeId.get(node.id);

    if (!attr || attr.match.mode === "rule_gap") {
      coverage.ruleGap.nodes += 1;
      coverage.ruleGap.chars += chars;
      coverage.ruleGapChars += chars;
      continue;
    }

    const ev = attr.match;

    if (ev.mode === "exact" || ev.mode === "wire_schema") {
      coverage.exactChars += ev.matchedChars;
      coverage.recognizedUnexplainedChars += ev.unmatchedChars;
      continue;
    }

    if (ev.mode === "template") {
      coverage.templateLiteralChars += ev.literalChars;
      coverage.recognizedUnexplainedChars += ev.unmatchedChars;
      continue;
    }

    if (ev.mode === "regex") {
      coverage.templateLiteralChars += ev.literalChars;
      coverage.dynamicCapturedChars += ev.dynamicChars;
      coverage.recognizedUnexplainedChars += ev.unmatchedChars;
      continue;
    }

    // prefix / contains：slot 已识别但内容未解释，整段进 recognizedUnexplained
    coverage.recognizedUnexplainedChars += ev.matchedChars + ev.unmatchedChars;
  }

  if (totalChars > 0) {
    const evidenceBacked =
      coverage.exactChars + coverage.templateLiteralChars + coverage.dynamicCapturedChars;
    coverage.recognitionRatio = (totalChars - coverage.ruleGapChars) / totalChars;
    coverage.evidenceBackedRatio = evidenceBacked / totalChars;
    coverage.byteReconstructableRatio = coverage.exactChars / totalChars;
  }

  return coverage;
}

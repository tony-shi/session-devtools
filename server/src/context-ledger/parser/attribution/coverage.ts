// parser/attribution/coverage：基于 SegmentAttribution.charCoverage 的字符级覆盖率桶。
//
// 模块职责：
//   - 只读取 matchMode / reconstructable / CharCoverage，不依赖 confidence。
//   - 没有 attribution 的节点视作 rule_gap，防止覆盖率虚高。

import type { ParsedQuerySnapshot } from "../types";
import type { AttributionCoverage, SegmentAttribution } from "./types";

function recognizedChars(attr: SegmentAttribution): number {
  return attr.charCoverage.matchedChars + attr.charCoverage.unmatchedChars;
}

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
    const attr = attrByNodeId.get(node.id);

    if (!attr || attr.matchMode === "rule_gap") {
      coverage.ruleGap.nodes += 1;
      coverage.ruleGap.chars += node.charCount;
      coverage.ruleGapChars += node.charCount;
      continue;
    }

    const c = attr.charCoverage;

    if (attr.matchMode === "exact") {
      if (attr.reconstructable) {
        coverage.exactChars += c.literalChars;
        coverage.recognizedUnexplainedChars += Math.max(0, c.matchedChars - c.literalChars) + c.unmatchedChars;
      } else {
        coverage.recognizedUnexplainedChars += recognizedChars(attr);
      }
      continue;
    }

    if (attr.matchMode === "regex") {
      coverage.templateLiteralChars += c.literalChars;
      coverage.dynamicCapturedChars += c.dynamicChars;
      coverage.recognizedUnexplainedChars += c.unmatchedChars;
      continue;
    }

    // prefix：slot 已识别，但内容不参与 exact/template/dynamic 证据。
    coverage.recognizedUnexplainedChars += recognizedChars(attr);
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

// parser/attribution/tree-diff：两棵 ParsedQuerySnapshot 之间的 leaf-level 差异。
//
// 设计取向：
//   - **叶子粒度**。Container 节点本身不参与 diff —— 它们只是结构脚手架，
//     真正的"内容"全在叶子。Container 的子树是否变化由其叶子集合决定。
//   - **rawHash 匹配**。两棵树的叶子 rawHash 相等即视为同一段。位置无关 —— 一段
//     "spawned Turn 1 / Call #1" 文本即使在 messages[] 中被挪到了不同位置，
//     依然算 unchanged。这刚好对应"context 被搬运但内容不变"的常见情形。
//   - **不做内容相似度匹配**。如果文本被截断 / 改写一个字，会被同时报告为
//     removed + added。这是诚实的表达 —— 后续如有需要可再叠加 modify 匹配层。
//
// 输出：
//   - 每个 current 叶子节点的状态：added | unchanged
//   - previous 中独有的叶子：单独列出 (removedFromPrevious)
//   - 摘要：counts

import type { ParsedQuerySnapshot, SegmentNode } from "../types";
import { collectLeaves } from "./invariants";

// ─── 输出类型 ────────────────────────────────────────────────────────────────

export type LeafDiffStatus = "added" | "unchanged";

export interface RemovedLeaf {
  /** previous snapshot 中的 node id（仅供调试/链接，不保证在 current 中存在） */
  nodeId: string;
  slotType: string;
  rawHash: string;
  /** 内容前缀，便于 UI 展示 */
  preview: string;
  charCount: number;
  /** previous 中的 jsonPath，方便定位 */
  jsonPath: string;
}

export interface AttributionTreeDiff {
  /** current snapshot 中每个叶子的状态。key = node.id */
  leafStatus: Record<string, LeafDiffStatus>;
  /** previous snapshot 中存在、current 不存在的叶子列表 */
  removedFromPrevious: RemovedLeaf[];
  /** 汇总：方便 UI 顶部摘要展示 */
  summary: {
    currentLeaves: number;
    addedLeaves: number;
    unchangedLeaves: number;
    removedLeaves: number;
    /** 总字符变化 = sum(added.charCount) - sum(removed.charCount) */
    netCharDelta: number;
    addedChars: number;
    removedChars: number;
  };
}

// ─── 实现 ────────────────────────────────────────────────────────────────────

/**
 * computeTreeDiff：计算 current 相对 previous 的叶子级 diff。
 *
 * previous = null/undefined 时返回 "first call" 形态：所有 current 叶子都标 added，
 * removedFromPrevious 为空。
 */
export function computeTreeDiff(
  current: ParsedQuerySnapshot,
  previous: ParsedQuerySnapshot | null | undefined,
): AttributionTreeDiff {
  const currentLeaves = collectLeaves(current.roots);
  const leafStatus: Record<string, LeafDiffStatus> = {};
  let addedChars = 0;
  let addedLeaves = 0;
  let unchangedLeaves = 0;

  if (!previous) {
    // 首次 call：所有叶子都是新增
    for (const leaf of currentLeaves) {
      leafStatus[leaf.id] = "added";
      addedChars += leaf.charCount;
      addedLeaves += 1;
    }
    return {
      leafStatus,
      removedFromPrevious: [],
      summary: {
        currentLeaves: currentLeaves.length,
        addedLeaves,
        unchangedLeaves: 0,
        removedLeaves: 0,
        netCharDelta: addedChars,
        addedChars,
        removedChars: 0,
      },
    };
  }

  // 建立 previous 叶子的 rawHash 索引（多对一：同 hash 可能多次出现）。
  const prevLeaves = collectLeaves(previous.roots);
  const prevByHash = new Map<string, SegmentNode[]>();
  for (const leaf of prevLeaves) {
    const list = prevByHash.get(leaf.rawHash) ?? [];
    list.push(leaf);
    prevByHash.set(leaf.rawHash, list);
  }

  // 用一个 multiset 计数追踪"还有多少 previous 叶子可用于匹配 current"。
  // 每次 current 叶子在 previous 中找到一个未消费的同 hash 叶子 → unchanged。
  // hash 用完后再出现同 hash 的 current 叶子 → 仍按 added 计（说明本 call 多了一份）。
  const remaining = new Map<string, number>();
  for (const [hash, list] of prevByHash) {
    remaining.set(hash, list.length);
  }

  for (const leaf of currentLeaves) {
    const left = remaining.get(leaf.rawHash) ?? 0;
    if (left > 0) {
      leafStatus[leaf.id] = "unchanged";
      remaining.set(leaf.rawHash, left - 1);
      unchangedLeaves += 1;
    } else {
      leafStatus[leaf.id] = "added";
      addedChars += leaf.charCount;
      addedLeaves += 1;
    }
  }

  // remaining > 0 的 hash 对应"previous 用过但 current 没用上"的叶子 → removed。
  const removedFromPrevious: RemovedLeaf[] = [];
  let removedChars = 0;
  for (const [hash, leftCount] of remaining) {
    if (leftCount <= 0) continue;
    const list = prevByHash.get(hash) ?? [];
    // 取末尾 leftCount 个作为 removed（前面 list.length - leftCount 个被 current 匹配掉了）
    const removedSlice = list.slice(list.length - leftCount);
    for (const leaf of removedSlice) {
      removedFromPrevious.push({
        nodeId: leaf.id,
        slotType: leaf.slotType,
        rawHash: leaf.rawHash,
        preview: previewOf(leaf.rawText),
        charCount: leaf.charCount,
        jsonPath: leaf.jsonPath,
      });
      removedChars += leaf.charCount;
    }
  }

  return {
    leafStatus,
    removedFromPrevious,
    summary: {
      currentLeaves: currentLeaves.length,
      addedLeaves,
      unchangedLeaves,
      removedLeaves: removedFromPrevious.length,
      netCharDelta: addedChars - removedChars,
      addedChars,
      removedChars,
    },
  };
}

function previewOf(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > 120 ? trimmed.slice(0, 117) + "..." : trimmed;
}

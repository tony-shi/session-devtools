// parser/attribution/invariants：终态树的三个不变量。
//
// 这些不变量是新模型的"宪法"。任何归因 pipeline 在出口处都应该跑一遍 assertAllInvariants，
// 一旦违反就立刻抛错而不是默默把错的数据透出去。
//
// 1. assertEveryNodeHasOrigin
//    每个节点都必须有 origin（discriminated union 的 4 个变体之一）。
//
// 2. assertContainerNodesAreStructural
//    有 children 的节点必须 origin.kind === "structural" 且 reason === "container_node"。
//    内容由叶子解释；container 自身只保留结构身份。
//
// 3. assertLeafConcatEqualsWire
//    in-order 遍历所有叶子取 rawText 顺序拼接，必须 byte-equal 原始 wire 的对应字段
//    （system[i].text / messages content / tool description）。
//    这是"叶子拼接 ≡ 请求"的硬约束 —— 一旦失败，说明 ast-builder 在某个层级丢字节了。

import type { ParsedQuerySnapshot, SegmentNode } from "../types";

export class AttributionInvariantError extends Error {
  constructor(public readonly violation: string, message: string) {
    super(`[attribution invariant: ${violation}] ${message}`);
    this.name = "AttributionInvariantError";
  }
}

// ─── Invariant 1: 每个节点都有 origin ────────────────────────────────────────

export function assertEveryNodeHasOrigin(snapshot: ParsedQuerySnapshot): void {
  for (const node of Object.values(snapshot.index)) {
    if (!node.origin) {
      throw new AttributionInvariantError(
        "missing-origin",
        `node "${node.id}" (slot=${node.slotType}) has no origin`,
      );
    }
    const validKinds = new Set(["rule", "jsonl", "structural", "unknown"]);
    if (!validKinds.has(node.origin.kind)) {
      throw new AttributionInvariantError(
        "invalid-origin-kind",
        `node "${node.id}" origin.kind="${(node.origin as { kind: string }).kind}" not in {rule, jsonl, structural, unknown}`,
      );
    }
  }
}

// ─── Invariant 2: container 节点必须是 structural/container_node ────────────

export function assertContainerNodesAreStructural(snapshot: ParsedQuerySnapshot): void {
  for (const node of Object.values(snapshot.index)) {
    if (node.children.length === 0) continue;
    if (node.origin.kind !== "structural" || node.origin.reason !== "container_node") {
      throw new AttributionInvariantError(
        "container-not-structural",
        `node "${node.id}" has ${node.children.length} children but origin=${JSON.stringify(node.origin)} (expected structural/container_node)`,
      );
    }
  }
}

// ─── Invariant 3: 叶子拼接 ≡ wire ────────────────────────────────────────────

/**
 * 收集 in-order 遍历下的叶子节点。
 *
 * 叶子定义：children.length === 0。
 * 顺序：与父节点 children 数组顺序一致（matcher / ast-builder 已保证按 charRange 递增）。
 */
export function collectLeaves(roots: SegmentNode[]): SegmentNode[] {
  const out: SegmentNode[] = [];
  function visit(node: SegmentNode): void {
    if (node.children.length === 0) {
      out.push(node);
      return;
    }
    for (const child of node.children) visit(child);
  }
  for (const root of roots) visit(root);
  return out;
}

/**
 * 检查同一个父节点下，叶子链拼接后是否等于父节点 rawText。
 * 顶层（无 parentId）的多个 root 之间不要求拼接 —— 它们对应不同的 wire 字段
 * （多个 system[i] / tools[i] / messages content[i]），由调用方分别核对。
 */
export function assertLeafConcatEqualsParent(snapshot: ParsedQuerySnapshot): void {
  for (const node of Object.values(snapshot.index)) {
    if (node.children.length === 0) continue;
    const leafConcat = collectLeaves(node.children).map((leaf) => leaf.rawText).join("");
    if (leafConcat !== node.rawText) {
      throw new AttributionInvariantError(
        "leaf-concat-mismatch",
        `node "${node.id}" (slot=${node.slotType}) rawText (${node.rawText.length} chars) ` +
          `≠ leaf concat (${leafConcat.length} chars). 字节丢失或重叠。`,
      );
    }
  }
}

// ─── 顶层入口 ────────────────────────────────────────────────────────────────

/**
 * 一次跑齐 3 个不变量。归因 pipeline 出口必跑。
 * 任一违反立刻抛 AttributionInvariantError。
 */
export function assertAllInvariants(snapshot: ParsedQuerySnapshot): void {
  assertEveryNodeHasOrigin(snapshot);
  assertContainerNodesAreStructural(snapshot);
  assertLeafConcatEqualsParent(snapshot);
}

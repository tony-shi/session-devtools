// parser/attribution/invariants：终态树的三个不变量。
//
// 这些不变量是新模型的"宪法"。任何归因 pipeline 在出口处都应该跑一遍 assertAllInvariants，
// 一旦违反就立刻抛错而不是默默把错的数据透出去。
//
// 1. assertEveryNodeHasOrigin
//    每个节点都必须有 origin（discriminated union 的 4 个变体之一）。
//
// 2. assertContainerNodesAreStructural
//    有 children 的节点默认必须 origin.kind === "structural" 且 reason === "container_node"。
//    内容由叶子解释；container 自身只保留结构身份。
//
//    例外（wire-schema 协议槽白名单）：
//      slotType ∈ { messages.tool_use, messages.tool_result, tools.builtin.* }
//      的 container 允许持有协议级 origin：
//        - kind === "rule" && ruleId.startsWith("wire.")     ← wire fallback 合成
//        - kind === "jsonl" && eventKind ∈ { tool_use, tool_result }  ← jsonl-linker 升级
//      理由：SmooshContent v2 把 tool_result 尾部 SR 段切为 children 后，父节点仍
//      代表"这是 tool_result 协议槽 + 对应 jsonl record"这一独立事实，与 children 的
//      内容归因正交。双重判定（slotType + origin 形态）避免任意 origin 走 wire-slot 捷径。
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

/** wire-schema 协议槽 slotType 白名单（允许 container 持有协议级 origin）。 */
function isWireSchemaContainerSlot(slotType: string): boolean {
  if (slotType === "messages.tool_use") return true;
  if (slotType === "messages.tool_result") return true;
  if (slotType.startsWith("tools.builtin.")) return true;
  return false;
}

/** 协议级 origin 形态白名单（与 slot 白名单组合使用）。 */
function isProtocolLevelOrigin(origin: SegmentNode["origin"]): boolean {
  if (origin.kind === "rule" && origin.ruleId.startsWith("wire.")) return true;
  if (origin.kind === "jsonl" && (origin.eventKind === "tool_use" || origin.eventKind === "tool_result")) {
    return true;
  }
  return false;
}

export function assertContainerNodesAreStructural(snapshot: ParsedQuerySnapshot): void {
  for (const node of Object.values(snapshot.index)) {
    if (node.children.length === 0) continue;
    const origin = node.origin;

    // 默认契约：container 必须是 structural/container_node。
    if (origin.kind === "structural" && origin.reason === "container_node") continue;

    // 例外：wire-schema 协议槽 + 协议级 origin 形态（slotType + origin 双重判定）。
    // SmooshContent v2 切分 tool_result 尾部 SR 段后，tool_result 节点同时是
    // container（有 SR 子段）和协议槽身份载体（wire/jsonl link）。
    if (isWireSchemaContainerSlot(node.slotType) && isProtocolLevelOrigin(origin)) continue;

    throw new AttributionInvariantError(
      "container-not-structural",
      `node "${node.id}" (slot=${node.slotType}) has ${node.children.length} children but origin=${JSON.stringify(origin)} (expected structural/container_node, or wire-schema slot with protocol-level origin)`,
    );
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

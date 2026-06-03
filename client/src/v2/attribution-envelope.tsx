import type { AttributionTreeResult, SerializedNode } from "./attribution-tree-types";
import { shortSlot, type LeafLite } from "./AttributionTreePanel";
import i18n from "../i18n";

// system-reminder 这类 prompt envelope 的分组数据源（collectEnvelopeContainers）。
//   1. 默认 leaf/table 只展示有效内容，rawOnly wrapper 不污染分类。
//   2. "被同一个 <system-reminder> 包裹在一起"这个事实，由 LeafTable 的低强度括号栏表达
//      （开标签=ghost 标题、闭标签=栏尾），贴在被包裹的连续行上，不再另画平行示意图。
//   3. 前端不负责拼接内容，只消费后端给出的 parent raw + child range。

export interface EnvelopeSegment {
  id: string;
  node: SerializedNode;
  label: string;
  size: number;
  rawOnly: boolean;
  leaf?: LeafLite;
}

export interface EnvelopeContainer {
  id: string;
  parent: SerializedNode;
  label: string;
  segments: EnvelopeSegment[];
  visibleLeaves: LeafLite[];
  totalChars: number;
  effectiveChars: number;
  rawOnlyChars: number;
}

function walkSerializedNodes(roots: SerializedNode[], visit: (node: SerializedNode) => void) {
  const stack = [...roots].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    visit(node);
    for (let i = node.children.length - 1; i >= 0; i -= 1) stack.push(node.children[i]);
  }
}

function rangeSizeOf(node: SerializedNode): number {
  if (node.charRange) return Math.max(0, node.charRange.end - node.charRange.start);
  return Math.max(0, node.charCount);
}

function isSystemReminderEnvelope(node: SerializedNode): boolean {
  if (node.slotType !== "messages.inline.system-reminder") return false;
  if (!node.rawText || node.children.length === 0) return false;
  return node.children.some((c) => c.visibility === "rawOnly" || !!c.charRange);
}

export function envelopeNodeLabel(node: Pick<SerializedNode, "slotType" | "ruleMeta" | "labelKey" | "labelKeyBase">): string {
  // 与 leafLabel 同源：rule.<labelKey>.displayName i18n（改 locales 一处即生效）。
  if (node.labelKey) {
    const k = `rule.${node.labelKey}.displayName`;
    if (i18n.exists(k)) return i18n.t(k);
    if (node.labelKeyBase) {
      const kb = `rule.${node.labelKeyBase}.displayName`;
      if (i18n.exists(kb)) return i18n.t(kb);
    }
  }
  if (node.ruleMeta?.displayName) return node.ruleMeta.displayName;
  switch (node.slotType) {
    case "messages.inline.system-reminder":
      return "用户上下文";
    case "messages.inline.system-reminder.wrapper.prefix":
      return "<system-reminder>";
    case "messages.inline.system-reminder.project-instructions":
      return "项目指令";
    case "messages.inline.system-reminder.memory":
      return "自动记忆";
    case "messages.inline.system-reminder.account":
      return "用户信息";
    case "messages.inline.system-reminder.wrapper.suffix":
      return "</system-reminder>";
    default:
      return shortSlot(node.slotType);
  }
}

export function collectEnvelopeContainers(result: AttributionTreeResult, leaves: LeafLite[]): EnvelopeContainer[] {
  if (!result.snapshot) return [];
  const leafById = new Map(leaves.map((leaf) => [leaf.nodeId, leaf]));
  const out: EnvelopeContainer[] = [];

  walkSerializedNodes(result.snapshot.roots, (node) => {
    if (!isSystemReminderEnvelope(node)) return;

    const segments = node.children
      .map((child): EnvelopeSegment => {
        const rawOnly = child.visibility === "rawOnly";
        return {
          id: child.id,
          node: child,
          label: envelopeNodeLabel(child),
          size: rangeSizeOf(child),
          rawOnly,
          leaf: rawOnly ? undefined : leafById.get(child.id),
        };
      })
      .filter((seg) => seg.size > 0 || seg.node.rawText || seg.node.preview);

    if (segments.length === 0) return;
    const visibleLeaves = segments
      .map((seg) => seg.leaf)
      .filter((leaf): leaf is LeafLite => !!leaf);
    const totalChars = node.rawText?.length ?? node.charCount;
    const effectiveChars = visibleLeaves.reduce((sum, leaf) => sum + leaf.charCount, 0);
    const rawOnlyChars = segments
      .filter((seg) => seg.rawOnly)
      .reduce((sum, seg) => sum + seg.size, 0);

    out.push({
      id: node.id,
      parent: node,
      label: envelopeNodeLabel(node),
      segments,
      visibleLeaves,
      totalChars,
      effectiveChars,
      rawOnlyChars,
    });
  });

  return out;
}

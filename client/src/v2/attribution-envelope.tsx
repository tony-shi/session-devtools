import type { AttributionTreeResult, SerializedNode } from "./attribution-tree-types";
import { BRAND } from "./shared/brand";
import { fmtK, leafFill, shortSlot, type LeafLite } from "./AttributionTreePanel";

// system-reminder 这类 prompt envelope 的展示目标:
//   1. 默认 leaf/table 只展示有效内容，rawOnly wrapper 不污染分类。
//   2. 结构壳仍然可见，但只作为位置/大小提示，不作为第三层点击导航。
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

export function envelopeNodeLabel(node: Pick<SerializedNode, "slotType" | "ruleMeta">): string {
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

function envelopeDisplaySegments(envelope: EnvelopeContainer): EnvelopeSegment[] {
  return envelope.segments;
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

export function EnvelopeMiniBar({
  envelope,
  selectedLeafId,
  getColor,
}: {
  envelope: EnvelopeContainer;
  selectedLeafId: string | null;
  getColor?: (leaf: LeafLite) => string;
}) {
  const displaySegments = envelopeDisplaySegments(envelope);
  const displayWrapperChars = displaySegments
    .filter((seg) => seg.rawOnly)
    .reduce((sum, seg) => sum + seg.size, 0);

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "86px minmax(0, 1fr) auto",
      alignItems: "center",
      gap: 8,
      padding: "2px 0",
      minWidth: 0,
      maxWidth: "100%",
    }}>
      <span style={{
        fontSize: 10,
        color: "#64748b",
        fontWeight: 700,
        whiteSpace: "nowrap",
      }}>
        wrapper
      </span>

      <div style={{
        display: "flex",
        height: 10,
        gap: 1,
        minWidth: 0,
        maxWidth: "100%",
        overflow: "hidden",
      }}>
        {displaySegments.map((seg) => {
          const fill = seg.rawOnly
            ? "#e5e7eb"
            : seg.leaf
              ? (getColor ? getColor(seg.leaf) : leafFill(seg.leaf))
              : "#d97706";
          const selected = !seg.rawOnly && selectedLeafId === seg.leaf?.nodeId;
          const title = `${seg.label} · ${fmtK(seg.size)} chars${seg.rawOnly ? " · wrapper" : ""}`;
          return (
            <div
              key={seg.id}
              title={title}
              style={{
                flex: `${Math.max(seg.size, 1)} 1 0`,
                minWidth: 0,
                height: "100%",
                borderRadius: 2,
                border: selected ? `1px solid ${BRAND.indigo500}` : "none",
                background: fill,
                opacity: seg.rawOnly ? 0.7 : 1,
                boxSizing: "border-box",
              }}
            />
          );
        })}
      </div>

      <span
        title={`${envelope.label} · raw ${fmtK(envelope.totalChars)} · 有效 ${fmtK(envelope.effectiveChars)} · wrapper ${fmtK(displayWrapperChars)}`}
        style={{
          fontSize: 10,
          color: "#94a3b8",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          maxWidth: 260,
        }}
      >
        {envelope.label} · raw {fmtK(envelope.totalChars)}
      </span>
    </div>
  );
}

export function EnvelopeStructureHint({
  envelope,
  selectedLeafId,
  getColor,
}: {
  envelope: EnvelopeContainer;
  selectedLeafId: string | null;
  getColor?: (leaf: LeafLite) => string;
}) {
  const displaySegments = envelopeDisplaySegments(envelope);

  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      gap: 4,
      padding: "4px 0 0",
      minWidth: 0,
    }}>
      <EnvelopeMiniBar envelope={envelope} selectedLeafId={selectedLeafId} getColor={getColor} />
      <div style={{
        display: "flex",
        gap: 4,
        alignItems: "center",
        minWidth: 0,
        overflow: "hidden",
      }}>
        {displaySegments.map((seg) => {
          const selected = !seg.rawOnly && selectedLeafId === seg.leaf?.nodeId;
          return (
            <span
              key={seg.id}
              title={`${seg.label} · ${fmtK(seg.size)} chars${seg.rawOnly ? " · wrapper" : ""}`}
              style={{
                minWidth: 0,
                maxWidth: seg.rawOnly ? 110 : 160,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                padding: "1px 4px",
                borderRadius: 3,
                border: selected ? `1px solid ${BRAND.indigo500}` : "1px solid transparent",
                background: selected ? BRAND.indigo50 : "transparent",
                color: seg.rawOnly ? "#94a3b8" : "#475569",
                fontSize: 9,
                fontWeight: selected ? 700 : 600,
              }}
            >
              {seg.label}
            </span>
          );
        })}
      </div>
    </div>
  );
}

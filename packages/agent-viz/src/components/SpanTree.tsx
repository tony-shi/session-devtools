import { useState } from "react";
import type { AgentSpan } from "../types";
import { SpanRow } from "./SpanRow";
import { SpanDetail } from "./SpanDetail";

interface Props {
  spans: AgentSpan[];
  defaultExpanded?: boolean;
}

function collectIds(spans: AgentSpan[]): Set<string> {
  const ids = new Set<string>();
  function walk(s: AgentSpan) {
    ids.add(s.id);
    s.children.forEach(walk);
  }
  spans.forEach(walk);
  return ids;
}

function SpanTreeInner({
  spans,
  depth,
  expanded,
  selected,
  onToggle,
  onSelect,
}: {
  spans: AgentSpan[];
  depth: number;
  expanded: Set<string>;
  selected: string | null;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  return (
    <>
      {spans.map((span) => (
        <div key={span.id}>
          <SpanRow
            span={span}
            depth={depth}
            isExpanded={expanded.has(span.id)}
            isSelected={selected === span.id}
            onToggle={() => onToggle(span.id)}
            onSelect={() => onSelect(span.id)}
          />
          {expanded.has(span.id) && span.children.length > 0 && (
            <SpanTreeInner
              spans={span.children}
              depth={depth + 1}
              expanded={expanded}
              selected={selected}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          )}
        </div>
      ))}
    </>
  );
}

export function SpanTree({ spans, defaultExpanded = true }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    defaultExpanded ? collectIds(spans) : new Set()
  );
  const [selected, setSelected] = useState<string | null>(null);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function select(id: string) {
    setSelected((prev) => (prev === id ? null : id));
  }

  // Find selected span for detail panel
  function findSpan(list: AgentSpan[], id: string): AgentSpan | null {
    for (const s of list) {
      if (s.id === id) return s;
      const found = findSpan(s.children, id);
      if (found) return found;
    }
    return null;
  }

  const selectedSpan = selected ? findSpan(spans, selected) : null;

  if (spans.length === 0) {
    return (
      <div className="text-xs text-gray-400 text-center py-8">
        No spans to display
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      {/* Tree panel */}
      <div className={`overflow-y-auto border-r border-gray-100 ${selectedSpan ? "w-1/2" : "w-full"}`}>
        <SpanTreeInner
          spans={spans}
          depth={0}
          expanded={expanded}
          selected={selected}
          onToggle={toggle}
          onSelect={select}
        />
      </div>

      {/* Detail panel */}
      {selectedSpan && (
        <div className="w-1/2 overflow-y-auto">
          <SpanDetail span={selectedSpan} />
        </div>
      )}
    </div>
  );
}

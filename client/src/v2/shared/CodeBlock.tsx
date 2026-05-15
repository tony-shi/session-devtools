// Shared <pre> wrapper for raw text / JSON / proxy dumps so they share one
// font, padding and color stack across the app.
//
//  - `variant="json"`    → bordered card, 10px monospace, for raw JSON dumps
//                          (JSONL metadata, proxy request body, etc).
//  - `variant="preview"` → soft fill, 11px, for inline text previews
//                          (attribution leaf rawText, diff detail blocks,
//                           tool input/output, response tree).

import React from "react";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

type Variant = "json" | "preview";

export interface CodeBlockProps {
  variant?: Variant;
  /** Force monospace even on preview variant (used for tool-use input). */
  mono?: boolean;
  /** "muted" deepens the bg + lightens the text — used for "no change" blocks. */
  muted?: boolean;
  maxHeight?: number;
  style?: React.CSSProperties;
  children: React.ReactNode;
}

export function CodeBlock({ variant = "preview", mono, muted, maxHeight, style, children }: CodeBlockProps) {
  const base: React.CSSProperties = {
    margin: 0,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    overflowX: "auto",
    overflowY: maxHeight != null ? "auto" : undefined,
    maxHeight,
    lineHeight: 1.5,
  };

  const byVariant: Record<Variant, React.CSSProperties> = {
    json: {
      fontFamily: MONO,
      fontSize: 10,
      color: muted ? "#6b7280" : "#374151",
      background: muted ? "#f9fafb" : "#f9fafb",
      border: "1px solid #e5e7eb",
      borderRadius: 8,
      padding: "10px 12px",
    },
    preview: {
      fontFamily: mono ? MONO : "inherit",
      fontSize: 11,
      color: muted ? "#6b7280" : "#374151",
      background: muted ? "#f9fafb" : "#fafafa",
      borderRadius: 4,
      padding: "8px 10px",
    },
  };

  return <pre style={{ ...base, ...byVariant[variant], ...style }}>{children}</pre>;
}

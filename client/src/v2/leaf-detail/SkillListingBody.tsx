// 特化渲染：Skill 注册 listing（skill-listing.v1/v2）。
//
// body-only：parsed = 技能名/描述网格（含 parseError 行）；raw = 原文 pre。
// 统一详情头由 dispatcher(SelectedDetail) 渲染，本组件接 rawMode 决定 parsed/raw。
import { Fragment } from "react";
import { BRAND } from "../shared/brand";
import type { LeafLite } from "../AttributionTreePanel";

const MONO = "ui-monospace, SFMono-Regular, monospace";

export function SkillListingBody({ leaf, rawMode }: { leaf: LeafLite; rawMode: boolean }) {
  if (leaf.origin.kind !== "rule" || !leaf.origin.payload?.skillListing) return null;
  const sl = leaf.origin.payload.skillListing;
  const fullText = leaf.rawText ?? leaf.preview;

  if (rawMode) {
    return (
      <pre style={{
        margin: 0, padding: "10px 12px",
        background: "#fafafa", border: "1px solid #e5e7eb", borderRadius: 4,
        fontSize: 11.5, fontFamily: MONO, color: "#1f2937",
        whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.55,
      }}>
        {fullText}
      </pre>
    );
  }

  return (
    <div style={{
      display: "grid", gridTemplateColumns: "max-content 1fr",
      columnGap: 16, rowGap: 6, padding: "10px 12px",
      background: "#fafafa", border: "1px solid #e5e7eb", borderRadius: 4,
    }}>
      {sl.entries.map((e, i) => (
        <Fragment key={i}>
          {e.parseError ? (
            <>
              <span style={{ fontFamily: MONO, fontSize: 12, color: "#9ca3af", fontStyle: "italic", whiteSpace: "nowrap" }}>
                ⚠ unparsed
              </span>
              <span
                style={{ fontSize: 12, color: "#9ca3af", fontStyle: "italic", lineHeight: 1.5, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}
                title={e.rawLine}
              >
                {e.rawLine}
              </span>
            </>
          ) : (
            <>
              <span style={{ fontFamily: MONO, fontSize: 12.5, color: BRAND.indigo700, fontWeight: 500, whiteSpace: "nowrap" }}>
                {e.name}
              </span>
              <span
                style={{ fontSize: 12.5, color: e.description ? "#374151" : "#9ca3af", lineHeight: 1.5, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}
                title={e.description ?? "(no description)"}
              >
                {e.description ?? "—"}
              </span>
            </>
          )}
        </Fragment>
      ))}
    </div>
  );
}

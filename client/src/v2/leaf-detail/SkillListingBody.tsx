// 特化渲染：Skill 注册 listing（skill-listing.v1/v2）。
//
// body-only：parsed = 技能名/描述网格（含 parseError 行）；raw = 原文 pre。
// 统一详情头由 dispatcher(SelectedDetail) 渲染，本组件接 rawMode 决定 parsed/raw。
// 视觉统一走 listing-style 共享 token（圆角 / 标识符配色 / 字号与 agent·tools 对齐）。
import { Fragment } from "react";
import {
  LISTING_MONO, LISTING_DESC, LISTING_MUTED,
  listingSurface, listingPre, listingEntityName,
} from "./listing-style";
import type { LeafLite } from "../AttributionTreePanel";

export function SkillListingBody({ leaf, rawMode }: { leaf: LeafLite; rawMode: boolean }) {
  if (leaf.origin.kind !== "rule" || !leaf.origin.payload?.skillListing) return null;
  const sl = leaf.origin.payload.skillListing;
  const fullText = leaf.rawText ?? leaf.preview;

  if (rawMode) {
    return <pre style={listingPre}>{fullText}</pre>;
  }

  return (
    <div style={{ ...listingSurface, display: "grid", gridTemplateColumns: "max-content 1fr", columnGap: 16, rowGap: 6 }}>
      {sl.entries.map((e, i) => (
        <Fragment key={i}>
          {e.parseError ? (
            <>
              <span style={{ fontFamily: LISTING_MONO, fontSize: 12, color: LISTING_MUTED, fontStyle: "italic", whiteSpace: "nowrap" }}>
                ⚠ unparsed
              </span>
              <span
                style={{ fontSize: 12, color: LISTING_MUTED, fontStyle: "italic", lineHeight: 1.5, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}
                title={e.rawLine}
              >
                {e.rawLine}
              </span>
            </>
          ) : (
            <>
              <span style={listingEntityName}>
                {e.name}
              </span>
              <span
                style={{ fontSize: 12, color: e.description ? LISTING_DESC : LISTING_MUTED, lineHeight: 1.5, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}
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

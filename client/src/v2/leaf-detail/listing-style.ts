// 共享：leaf-detail 各 listing 组件（skill registry / agent types / deferred tools / tool 定义）
// 的视觉 style token。以 tools（ToolDefinitionBody）的风格为基准抽出，统一 圆角 / section 标签 /
// 标识符配色 / chip / 表头·行边框，避免各组件就地硬编码导致风格漂移（曾出现 圆角 4 vs 6、
// 标识符 fw500 vs 600、chip 尺寸 1/6/r3 vs 2/7/r4 等不一致）。颜色尽量走 BRAND，去散落 hex。
import type { CSSProperties } from "react";
import { BRAND } from "../shared/brand";

export const LISTING_MONO = "ui-monospace, SFMono-Regular, monospace";
export const LISTING_RADIUS = 6;
export const LISTING_DESC = "#374151"; // 有内容的描述文本
export const LISTING_MUTED = "#9ca3af"; // 缺省 / 占位 / 弱化

// 网格 / 分组容器底色 surface（skill 网格、deferred 分组、tool otherFields）。
export const listingSurface: CSSProperties = {
  padding: "10px 12px", background: "#fafafa",
  border: "1px solid #e5e7eb", borderRadius: LISTING_RADIUS,
};

// 原文 <pre>（rawMode / 解析失败兜底）。
export const listingPre: CSSProperties = {
  ...listingSurface, margin: 0,
  fontSize: 11.5, fontFamily: LISTING_MONO, color: "#1f2937",
  whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.55,
};

// section 标签（统一 uppercase + letterSpacing，同 tools 的 labelStyle）。
export const listingSectionLabel: CSSProperties = {
  fontSize: 11, fontWeight: 700, color: "#6b7280",
  textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 5,
};

// 标识符（skill 名 / agent 名 / 参数名）：统一 indigo700 + fw600 + 12 + mono。
export const listingEntityName: CSSProperties = {
  fontFamily: LISTING_MONO, fontSize: 12,
  color: BRAND.indigo700, fontWeight: 600, whiteSpace: "nowrap",
};

// 表格外框 + 表头 + 行（agent 表 / tool 参数表共用的骨架）。
export const listingTableWrap: CSSProperties = {
  border: "1px solid #e5e7eb", borderRadius: LISTING_RADIUS, overflow: "hidden",
};
export const listingHeadCell: CSSProperties = {
  padding: "6px 10px", fontSize: 11, fontWeight: 700,
  color: "#6b7280", textAlign: "left", background: "#f9fafb",
};
export const listingCell: CSSProperties = {
  padding: "6px 10px", borderTop: "1px solid #eef0f3", verticalAlign: "top",
};

// chip：统一一套 —— indigo 主样式 + 变体（MCP violet / 弱化灰 / 全部绿）。
export const listingChip: CSSProperties = {
  display: "inline-block", padding: "2px 7px", margin: "2px 4px 2px 0",
  fontSize: 11.5, fontFamily: LISTING_MONO,
  background: BRAND.indigo50, color: BRAND.indigo700,
  border: `1px solid ${BRAND.indigo100}`, borderRadius: 4,
};
export const listingChipMcp: CSSProperties = {
  ...listingChip, background: BRAND.violet50, color: BRAND.violet700, borderColor: BRAND.violet100,
};
export const listingChipMuted: CSSProperties = {
  ...listingChip, background: "#f3f4f6", color: "#6b7280", borderColor: "#e5e7eb",
};
export const listingChipAll: CSSProperties = {
  ...listingChip, background: "#ecfdf5", color: "#047857", borderColor: "#d1fae5",
};

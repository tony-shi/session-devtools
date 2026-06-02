// ImageLeafContent —— 图片(messages.block.image)叶子的内容主体特化渲染。
//
// 隔离原因：归因详情卡（SelectedDetail）的「顶部结构 + i/查看原始/复制」基建逻辑
// 对所有 leaf 类型一视同仁、保持不变；唯独图片类型的「内容主体」需要从纯占位符
// 升级为真正把图片画出来。把这段特化逻辑拆到独立组件，避免堆积进 SelectedDetail
// 的大 if-else，职责更清晰。
//
// 数据来源：leaf.rawText 是完整的 image content block JSON（parser 在
// matcher.ts 里原样保留 source.data / source.url，不截断）。
//   - base64 → 拼成 data: URI 直接喂 <img>
//   - url    → 直接用 url
//   - parse 失败 / 无可用 source / <img> 加载失败 → 回退到占位符（fail-safe）

import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { LeafLite } from "./AttributionTreePanel";

interface ImageSource {
  type?: string;
  media_type?: string;
  data?: string;
  url?: string;
}

/** 从 leaf.rawText 解析出 image content block 的 source；非 image / parse 失败 → null。 */
function parseImageSource(rawText: string | undefined): ImageSource | null {
  if (!rawText) return null;
  try {
    const parsed = JSON.parse(rawText) as { type?: string; source?: ImageSource };
    if (parsed?.type !== "image" || !parsed.source) return null;
    return parsed.source;
  } catch {
    return null;
  }
}

/** 把 source 解析成可直接喂 <img src> 的字符串；无法解析 → null。 */
function imageSrcOf(src: ImageSource): string | null {
  if (src.type === "base64" && typeof src.data === "string" && src.data) {
    const mediaType = src.media_type || "image/png";
    return `data:${mediaType};base64,${src.data}`;
  }
  if (src.type === "url" && typeof src.url === "string" && src.url) {
    return src.url;
  }
  return null;
}

/** 渲染失败 / 数据缺失时的占位符（保留原有视觉）。 */
function ImagePlaceholder({ jsonPath }: { jsonPath: string }) {
  const { t } = useTranslation();
  return (
    <div style={{
      padding: "16px",
      background: "#f9fafb",
      border: "1px dashed #d1d5db",
      borderRadius: 6,
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 8,
      color: "#4b5563",
    }}>
      <span style={{ fontSize: 24 }}>🖼️</span>
      <span style={{ fontSize: 12, fontWeight: 600 }}>{t("messages.block.image", { defaultValue: "图片输入" })}</span>
      <span style={{ fontSize: 11, fontFamily: "ui-monospace, SFMono-Regular, monospace", color: "#6b7280" }}>{jsonPath}</span>
    </div>
  );
}

export function ImageLeafContent({ leaf }: { leaf: LeafLite }) {
  const [failed, setFailed] = useState(false);

  // 图片数据只在完整 rawText 里（preview 被截断、对 base64 无用），rawText 缺失则退回 preview，
  // 解析多半会失败 → 落到占位符，安全。
  const source = parseImageSource(leaf.rawText ?? leaf.preview);
  const src = source ? imageSrcOf(source) : null;

  if (!src || failed) {
    return <ImagePlaceholder jsonPath={leaf.jsonPath} />;
  }

  const mediaType = source?.type === "base64" ? (source.media_type || "image/png") : source?.url;

  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 6,
      padding: "12px",
      background: "#f9fafb",
      border: "1px solid #e5e7eb",
      borderRadius: 6,
    }}>
      <img
        src={src}
        alt={leaf.jsonPath}
        onError={() => setFailed(true)}
        style={{
          maxWidth: "100%",
          maxHeight: 480,
          objectFit: "contain",
          borderRadius: 4,
          border: "1px solid #e5e7eb",
          background: "#fff",
        }}
      />
      <span style={{
        fontSize: 10,
        fontFamily: "ui-monospace, SFMono-Regular, monospace",
        color: "#9ca3af",
        maxWidth: "100%",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}>
        {mediaType} · {leaf.jsonPath}
      </span>
    </div>
  );
}

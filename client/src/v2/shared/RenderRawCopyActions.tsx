import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy } from "lucide-react";

export interface RenderRawCopyActionsProps {
  rawMode: boolean;
  onToggleRawMode?: () => void;
  textToCopy: string | (() => string);
  showToggle?: boolean;
  style?: React.CSSProperties;
}

export function RenderRawCopyActions({
  rawMode,
  onToggleRawMode,
  textToCopy,
  showToggle = true,
  style,
}: RenderRawCopyActionsProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const text = typeof textToCopy === "function" ? textToCopy() : textToCopy;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  const textLength = typeof textToCopy === "string" ? textToCopy.length : undefined;
  const titleText = textLength !== undefined
    ? t("attribution.detail.copyRawTitle", { count: textLength })
    : t("attribution.detail.copyRaw");

  const btnBaseStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    height: 24,
    padding: "0 8px",
    fontSize: 10,
    fontWeight: 600,
    borderRadius: 4,
    cursor: "pointer",
    whiteSpace: "nowrap",
    boxSizing: "border-box",
    lineHeight: 1,
    transition: "all 0.12s ease",
  };

  const toggleBtnStyle: React.CSSProperties = {
    ...btnBaseStyle,
    border: "1px solid #d1d5db",
    background: rawMode ? "#f3f4f6" : "#fff",
    color: "#374151",
  };

  const copyBtnStyle: React.CSSProperties = {
    ...btnBaseStyle,
    border: "1px solid",
    borderColor: copied ? "#16a34a" : "#d1d5db",
    background: copied ? "#dcfce7" : "#fff",
    color: copied ? "#15803d" : "#374151",
    transition: "background 0.12s, border-color 0.12s, color 0.12s",
  };

  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6, ...style }}>
      {showToggle && onToggleRawMode && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleRawMode();
          }}
          style={toggleBtnStyle}
        >
          {rawMode ? t("attribution.detail.toggleRender") : t("attribution.detail.toggleRaw")}
        </button>
      )}
      <button
        type="button"
        title={titleText}
        onClick={handleCopy}
        style={copyBtnStyle}
      >
        {copied ? (
          <><Check size={10} strokeWidth={3} /> {t("attribution.detail.copied")}</>
        ) : (
          <><Copy size={10} /> {t("attribution.detail.copyRaw")}</>
        )}
      </button>
    </div>
  );
}

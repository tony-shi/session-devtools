// 代理页面 —— 将「代理流量」与「代理管理」融合为一个内聚面板。
// 顶部 sub-tab 切换，默认展示流量。
import { ProxySetup } from "./ProxySetup";
import { ProxyTraffic } from "./ProxyTraffic";
import { useState } from "react";

type SubTab = "traffic" | "setup";

const T = {
  traffic: { zh: "流量", en: "Traffic" },
  setup:   { zh: "管理", en: "Setup" },
} satisfies Record<SubTab, { zh: string; en: string }>;

function getLang(): "zh" | "en" {
  return localStorage.getItem("lang") === "en" ? "en" : "zh";
}

export function ProxyPanel() {
  const [sub, setSub] = useState<SubTab>("traffic");
  const lang = getLang();

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* Sub-tab bar */}
      <div style={{
        display: "flex",
        gap: 0,
        borderBottom: "1px solid #e5e7eb",
        background: "#fff",
        borderRadius: "10px 10px 0 0",
        paddingLeft: 12,
        flexShrink: 0,
      }}>
        {(["traffic", "setup"] as SubTab[]).map((id) => (
          <button
            key={id}
            onClick={() => setSub(id)}
            style={{
              padding: "9px 16px",
              border: "none",
              background: "none",
              cursor: "pointer",
              fontSize: 13,
              fontWeight: sub === id ? 600 : 400,
              color: sub === id ? "#007aff" : "#6b7280",
              borderBottom: sub === id ? "2px solid #007aff" : "2px solid transparent",
              marginBottom: -1,
            }}
          >
            {T[id][lang]}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{
        background: "#fff",
        borderRadius: "0 0 10px 10px",
        border: "1px solid #e5e7eb",
        borderTop: "none",
        flex: 1,
      }}>
        {sub === "traffic" ? <ProxyTraffic /> : <ProxySetup />}
      </div>
    </div>
  );
}

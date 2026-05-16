import { describe, it, expect } from "vitest";
import { parseQuery, attributeSnapshot } from "../index";
import { detectEntrypoint, isNonCliEntrypoint, computeAuditExclusion } from "./entrypoint";

// 用于构造 system[0] 含 billing-header 的最小 reqBody。
// 入参 entrypoint 替换 cc_entrypoint 字段，其它字段固定。
function reqBodyWithEntrypoint(entrypoint: string) {
  return {
    system: [
      {
        type: "text" as const,
        text: `x-anthropic-billing-header: cc_version=2.1.142.b0b; cc_entrypoint=${entrypoint}; cch=3642b;`,
      },
      {
        type: "text" as const,
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
      },
    ],
    tools: [{ name: "Read", description: "Read a file", input_schema: {} }],
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ],
  };
}

function parseAndAttribute(entrypoint: string) {
  const snap = parseQuery({ reqBody: reqBodyWithEntrypoint(entrypoint), proxyFile: "t.json" });
  attributeSnapshot(snap);
  return snap;
}

describe("audit/entrypoint — billing-noise 正则覆盖 kebab 入口", () => {
  it("cli 入口被 billing-noise rule 命中并抽出 entrypoint=cli", () => {
    const snap = parseAndAttribute("cli");
    expect(detectEntrypoint(snap)).toBe("cli");
    expect(isNonCliEntrypoint("cli")).toBe(false);
    expect(computeAuditExclusion(snap)).toBeUndefined();
  });

  it("claude-vscode（含连字符）能被 rule 命中 —— 防回归 \\w+ 失配", () => {
    // \w+ 不吃连字符；旧 pattern 会让整条 billing-noise rule 失配，
    // 导致 detectEntrypoint 返回 undefined、IDE 流量绕过 audit 排除。
    const snap = parseAndAttribute("claude-vscode");
    expect(detectEntrypoint(snap)).toBe("claude-vscode");
    expect(isNonCliEntrypoint("claude-vscode")).toBe(true);
    const excl = computeAuditExclusion(snap);
    expect(excl?.reason).toBe("non-cli-entrypoint");
    expect(excl?.entrypoint).toBe("claude-vscode");
  });

  it("claude-jetbrains 同样能命中", () => {
    const snap = parseAndAttribute("claude-jetbrains");
    expect(detectEntrypoint(snap)).toBe("claude-jetbrains");
    expect(computeAuditExclusion(snap)?.entrypoint).toBe("claude-jetbrains");
  });
});

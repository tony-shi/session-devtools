// version-baseline.test.ts
//
// 验证 corpus baseline 比对的 5 个 matchLevel 都按预期返回。
// 当前 baseline = 2.1.150(manifests/claude-code-2.1.150.md)。

import { describe, expect, it } from "vitest";
import { checkVersionAgainstBaseline, getActiveBaseline } from "./version-baseline";

describe("VersionBaseline check", () => {
  it("baseline 已存在(corpus 至少有一个 manifest)", () => {
    const b = getActiveBaseline();
    expect(b).not.toBeNull();
    expect(b!.ccVersion).toBe("2.1.150");
  });

  it("exact:proxy = baseline", () => {
    const r = checkVersionAgainstBaseline("2.1.150");
    expect(r.matchLevel).toBe("exact");
  });

  it("exact:proxy 带 fingerprint 仍等同", () => {
    const r = checkVersionAgainstBaseline("2.1.150.7e6");
    expect(r.matchLevel).toBe("exact");
  });

  it("minor-match:同 minor 不同 patch", () => {
    const r = checkVersionAgainstBaseline("2.1.149");
    expect(r.matchLevel).toBe("minor-match");
    expect(r.message).toContain("appliesTo 处理细节差异");
  });

  it("minor-mismatch:major 同 minor 不同(2.1.150 vs 2.2.x)", () => {
    const r = checkVersionAgainstBaseline("2.2.0");
    expect(r.matchLevel).toBe("minor-mismatch");
    expect(r.message).toContain("⚠️");
  });

  it("major-mismatch", () => {
    const r = checkVersionAgainstBaseline("3.0.0");
    expect(r.matchLevel).toBe("major-mismatch");
    expect(r.message).toContain("MAJOR");
  });

  it("unparseable:proxy 字符串异常", () => {
    const r = checkVersionAgainstBaseline("not-a-version");
    expect(r.matchLevel).toBe("unparseable");
  });

  it("unparseable:proxy 未提供", () => {
    const r = checkVersionAgainstBaseline(undefined);
    expect(r.matchLevel).toBe("unparseable");
  });
});

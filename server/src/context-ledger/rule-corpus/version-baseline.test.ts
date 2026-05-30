// version-baseline.test.ts
//
// 验证 corpus baseline 比对的各 matchLevel 都按预期返回。
// baseline = 本地常量 CORPUS_BASELINE_CCVERSION(已脱离 Piebald manifest)。

import { describe, expect, it } from "vitest";
import { checkVersionAgainstBaseline, getActiveBaseline, CORPUS_BASELINE_CCVERSION } from "./version-baseline";

describe("VersionBaseline check", () => {
  it("baseline 来自本地常量", () => {
    const b = getActiveBaseline();
    expect(b.ccVersion).toBe(CORPUS_BASELINE_CCVERSION);
  });

  it("exact:proxy = baseline", () => {
    const r = checkVersionAgainstBaseline(CORPUS_BASELINE_CCVERSION);
    expect(r.matchLevel).toBe("exact");
  });

  it("exact:proxy 带 fingerprint 仍等同", () => {
    const r = checkVersionAgainstBaseline(`${CORPUS_BASELINE_CCVERSION}.7e6`);
    expect(r.matchLevel).toBe("exact");
  });

  it("minor-match:同 major.minor 不同 patch", () => {
    // baseline 2.1.x → 用同 minor 不同 patch 的版本
    const r = checkVersionAgainstBaseline("2.1.1");
    expect(r.matchLevel).toBe("minor-match");
    expect(r.message).toContain("appliesTo 处理细节差异");
  });

  it("minor-mismatch:major 同 minor 不同(2.2.x)", () => {
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

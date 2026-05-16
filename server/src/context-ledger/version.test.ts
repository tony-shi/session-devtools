import { describe, it, expect } from "vitest";
import { parseCcVersion, satisfiesCcVersion } from "./version";

describe("parseCcVersion", () => {
  it("4 段标准形态", () => {
    expect(parseCcVersion("2.1.140.453")).toEqual({ major: 2, minor: 1, patch: 140, fingerprint: "453" });
    expect(parseCcVersion("2.1.142.6c2")).toEqual({ major: 2, minor: 1, patch: 142, fingerprint: "6c2" });
  });

  it("3 段（缺 fingerprint）也允许", () => {
    expect(parseCcVersion("2.1.142")).toEqual({ major: 2, minor: 1, patch: 142 });
  });

  it("非法形态返回 null", () => {
    expect(parseCcVersion("invalid")).toBeNull();
    expect(parseCcVersion("2.1")).toBeNull();
    expect(parseCcVersion("2.1.x.y")).toBeNull();
  });
});

describe("satisfiesCcVersion — min/max/range 仅比前 3 段", () => {
  it("minCcVersion 接受同版本所有 fingerprint", () => {
    expect(satisfiesCcVersion("2.1.142.6c2", { minCcVersion: "2.1.142" })).toBe(true);
    expect(satisfiesCcVersion("2.1.142.abc", { minCcVersion: "2.1.142" })).toBe(true);
    expect(satisfiesCcVersion("2.1.141.999", { minCcVersion: "2.1.142" })).toBe(false);
    expect(satisfiesCcVersion("2.1.140.453", { minCcVersion: "2.1.142" })).toBe(false);
  });

  it("maxCcVersion 含边界", () => {
    expect(satisfiesCcVersion("2.1.141.abc", { maxCcVersion: "2.1.141" })).toBe(true);
    expect(satisfiesCcVersion("2.1.140.453", { maxCcVersion: "2.1.141" })).toBe(true);
    expect(satisfiesCcVersion("2.1.142.6c2", { maxCcVersion: "2.1.141" })).toBe(false);
  });

  it("range 含两端", () => {
    expect(satisfiesCcVersion("2.1.140.453", { range: ["2.1.140", "2.1.141"] })).toBe(true);
    expect(satisfiesCcVersion("2.1.141.def", { range: ["2.1.140", "2.1.141"] })).toBe(true);
    expect(satisfiesCcVersion("2.1.142.6c2", { range: ["2.1.140", "2.1.141"] })).toBe(false);
    expect(satisfiesCcVersion("2.1.139.abc", { range: ["2.1.140", "2.1.141"] })).toBe(false);
  });

  it("数值比较，不走字典序：2.1.9 < 2.1.140", () => {
    expect(satisfiesCcVersion("2.1.140.453", { minCcVersion: "2.1.9" })).toBe(true);
    expect(satisfiesCcVersion("2.1.9.abc", { minCcVersion: "2.1.140" })).toBe(false);
  });
});

describe("satisfiesCcVersion — exactCcVersions", () => {
  it("predicate 含 fingerprint → 4 段全等", () => {
    expect(satisfiesCcVersion("2.1.140.453", { exactCcVersions: ["2.1.140.453"] })).toBe(true);
    expect(satisfiesCcVersion("2.1.140.999", { exactCcVersions: ["2.1.140.453"] })).toBe(false);
  });

  it("predicate 不含 fingerprint → 任意 fingerprint 都接受", () => {
    expect(satisfiesCcVersion("2.1.140.453", { exactCcVersions: ["2.1.140"] })).toBe(true);
    expect(satisfiesCcVersion("2.1.140.6c2", { exactCcVersions: ["2.1.140"] })).toBe(true);
    expect(satisfiesCcVersion("2.1.141.def", { exactCcVersions: ["2.1.140"] })).toBe(false);
  });

  it("多元素：任一命中即可", () => {
    expect(satisfiesCcVersion("2.1.140.453", { exactCcVersions: ["2.1.139", "2.1.140.453", "2.1.142"] })).toBe(true);
  });
});

describe("satisfiesCcVersion — 非法 cc", () => {
  it("不合法的 cc 字符串永远不满足任何谓词", () => {
    expect(satisfiesCcVersion("garbage", { minCcVersion: "0.0.0" })).toBe(false);
    expect(satisfiesCcVersion("garbage", { exactCcVersions: ["garbage"] })).toBe(false);
  });
});

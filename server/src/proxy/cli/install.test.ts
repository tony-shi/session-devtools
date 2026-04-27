// A1.2 单测：§5.3 决策表的 6 行场景，验证 buildEnvPatch 的 settings 写入结果。
import { describe, test, expect } from "bun:test";
import { buildEnvPatch } from "./install";

const PORT = 38421;
const CA = "/home/user/.api-dashboard/proxy/ca.pem";
const OUR_PROXY = `http://127.0.0.1:${PORT}`;

describe("buildEnvPatch —— §5.3 决策表", () => {
  // 行 1：全空（无任何代理）
  test("无 HTTPS_PROXY → 直接写入我们的代理", () => {
    const patch = buildEnvPatch({}, PORT, CA);
    expect(patch.HTTPS_PROXY).toBe(OUR_PROXY);
    expect(patch.HTTP_PROXY).toBe(OUR_PROXY);
    expect(patch.API_DASHBOARD_PROXY_UPSTREAM).toBeUndefined();
    expect(patch.NODE_EXTRA_CA_CERTS).toBe(CA);
    // NO_PROXY 包含最小集（127.0.0.1 已从最小集移除，避免豁免用户自定义网关）
    expect(patch.NO_PROXY).toContain("localhost");
    expect(patch.NO_PROXY).toContain("::1");
  });

  // 行 2：有 http:// 上游
  test("有 http:// HTTPS_PROXY → 迁移到 UPSTREAM，接管 HTTPS_PROXY", () => {
    const patch = buildEnvPatch({ HTTPS_PROXY: "http://corp-proxy:3128" }, PORT, CA);
    expect(patch.HTTPS_PROXY).toBe(OUR_PROXY);
    expect(patch.HTTP_PROXY).toBe(OUR_PROXY);
    expect(patch.API_DASHBOARD_PROXY_UPSTREAM).toBe("http://corp-proxy:3128");
    expect(patch.NODE_EXTRA_CA_CERTS).toBe(CA);
  });

  // 行 3：有带认证的 http:// 上游
  test("有带认证的 HTTPS_PROXY → 完整 URL 迁移到 UPSTREAM", () => {
    const upstream = "http://user:pass@corp-proxy:3128";
    const patch = buildEnvPatch({ HTTPS_PROXY: upstream }, PORT, CA);
    expect(patch.API_DASHBOARD_PROXY_UPSTREAM).toBe(upstream);
    expect(patch.HTTPS_PROXY).toBe(OUR_PROXY);
  });

  // 行 4：重装路径（HTTPS_PROXY 已经指向我们）
  test("HTTPS_PROXY 已指向我们 → 不重复迁移上游", () => {
    const patch = buildEnvPatch({ HTTPS_PROXY: OUR_PROXY }, PORT, CA);
    expect(patch.HTTPS_PROXY).toBe(OUR_PROXY);
    expect(patch.API_DASHBOARD_PROXY_UPSTREAM).toBeUndefined();
  });

  // 行 5：用户已有 NO_PROXY → 合并，不丢失
  test("有用户 NO_PROXY → 合并最小集，保留用户值", () => {
    const patch = buildEnvPatch({ NO_PROXY: "internal.corp,10.0.0.0/8" }, PORT, CA);
    const noProxy = patch.NO_PROXY!.split(",");
    expect(noProxy).toContain("internal.corp");
    expect(noProxy).toContain("10.0.0.0/8");
    expect(noProxy).toContain("localhost");
    expect(noProxy).toContain("::1");
    // 127.0.0.1 不在最小集里，允许用户把自定义网关放在 127.0.0.1:xxxx 并被拦截
    expect(noProxy).not.toContain("127.0.0.1");
  });

  // 行 6：NO_PROXY 去重（用户已有 127.0.0.1）
  test("用户 NO_PROXY 已含最小集 → 不重复", () => {
    const patch = buildEnvPatch({ NO_PROXY: "127.0.0.1,localhost" }, PORT, CA);
    const noProxy = patch.NO_PROXY!.split(",");
    // 不应该出现重复
    const count127 = noProxy.filter((v) => v === "127.0.0.1").length;
    expect(count127).toBe(1);
  });
});

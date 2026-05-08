// fixture-pipeline-coverage.test.ts
// 专为代码覆盖率收集而写的测试文件——不做业务断言，只驱动真实 fixture 跑完整 pipeline。
// 不要加入日常 vitest 套件；只在 context:audit:fixtures:coverage 命令里使用。
//
// 覆盖目标：server/src/context-ledger/ 下所有核心模块（parser、attribution、reconstructor、
//           reconciliation、scorecard、pipeline）在真实 fixture 数据上的执行路径。

import { test, expect } from "vitest";
import { discoverFixtures } from "./discovery";
import { runPipelineWithData } from "./pipeline";

const discovery = discoverFixtures();

// proxy_without_jsonl fixtures（如 side-query-session-title）→ 验证 skip 行为
for (const proxy of discovery.proxyWithoutJsonl) {
  const name = (proxy.raw["_fixtureName"] as string | undefined) ?? proxy.queryKey.sessionId;
  test(`fixture [no-jsonl] ${name}`, () => {
    const { result } = runPipelineWithData({ proxy, jsonlFile: null });
    expect(result.status).toBe("skipped");
    expect(result.skipReason).toBe("proxy_without_jsonl");
  });
}

// 完整 proxy+jsonl fixtures
for (const { proxy, jsonlFile } of discovery.matchedProxyJsonl) {
  const name = (proxy.raw["_fixtureName"] as string | undefined) ?? proxy.queryKey.sessionId;
  test(`fixture [full] ${name}`, () => {
    const { result } = runPipelineWithData({ proxy, jsonlFile });
    expect(result.status).toBe("success");
  });
}

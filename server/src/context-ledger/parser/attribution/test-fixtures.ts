// 共享测试 fixture helper：给合成 reqBody 前置 x-anthropic-billing-header system[0]，
// 让 attribution pipeline 的 pre-pass 产出合法 AttributionContext。
//
// 真实 wire 形态：每个 Claude Code 请求 system[0] 必为 billing header text 块，
// system[1] 才是 identity（"You are Claude Code..."）。测试 fixture 之前直接从
// identity 开始，跳过了 billing 块 —— 这与 cc_version pre-pass 的硬要求冲突，
// 加这个 helper 把 fixture 修正到对齐真实 wire。

export const TEST_DEFAULT_CC_VERSION = "2.1.142.6c2";

export function withBillingHeader<
  T extends Record<string, unknown> & { system?: Array<{ type: string; text: string }> }
>(reqBody: T, ccVersion: string = TEST_DEFAULT_CC_VERSION): T {
  const billing = {
    type: "text" as const,
    text: `x-anthropic-billing-header: cc_version=${ccVersion}; cc_entrypoint=cli; cch=00000;`,
  };
  return {
    ...reqBody,
    system: [billing, ...((reqBody.system as Array<{ type: string; text: string }> | undefined) ?? [])],
  };
}

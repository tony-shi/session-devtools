// AttributionContext：单次归因贯穿的"先验输入"。
//
// 来源：proxy reqBody.system[0] 文本块，Claude Code CLI 在协议层固定注入的
//   "x-anthropic-billing-header: cc_version=...; cc_entrypoint=...; cch=...; [cc_workload=...]"
// 头部行。这是每个请求必有的先验信息，归因管线据此选择版本化的 rule / template。
//
// 该 header 的字段语义和 regex 形态与 CLAUDE_CODE_BILLING_NOISE_RULE 同源 ——
// rule 是给"是否在 system[0] 命中 billing-noise"的归因层用，本 ctx 抽取是给
// "整次归因怎么 dispatch"的元数据层用，二者各取所需，但 pattern 必须一致。

const BILLING_HEADER_RE =
  /^x-anthropic-billing-header: cc_version=(?<version>\d+\.\d+\.\d+\.[0-9a-fA-F]+); cc_entrypoint=(?<entrypoint>[\w-]+);(?: cch=(?<cch>[0-9a-fA-F]+);)?(?: cc_workload=(?<workload>\S+);)?(?:; \w+=[^;]+)*\s*$/;

export interface AttributionContext {
  /** cc_version 完整字符串，"X.Y.Z.fingerprint" 四段（如 "2.1.140.453"）。 */
  ccVersion: string;
  /** cc_entrypoint，CLI 入口标识（"cli" / "claude-vscode" 等 kebab token）。 */
  entrypoint: string;
  /** cch attestation token，hex；NATIVE_CLIENT_ATTESTATION 开启时才有。 */
  cch?: string;
  /** cc_workload tag，cron 等特殊场景才有。 */
  workload?: string;
}

/** AttributionContext 抽取失败的原因，供上层选择如何 surface。 */
export type AttributionContextFailure =
  | { kind: "no_system_block_0" }                       // system 数组缺失或为空
  | { kind: "system_block_0_not_text" }                 // system[0] 不是 text block
  | { kind: "billing_header_not_matched"; text: string }; // 文本不符合 billing-header 形态

/** 单次归因的先验输入结果，挂在 ParsedQuerySnapshot 上贯穿后续 attribution pipeline。 */
export type AttributionContextResult =
  | { ok: true; ctx: AttributionContext }
  | { ok: false; failure: AttributionContextFailure };

/**
 * 从 reqBody.system[0] 抽取 AttributionContext。
 *
 * 协议假设：Claude Code CLI 每次请求 system[0] 必为
 *   { type: "text", text: "x-anthropic-billing-header: cc_version=...; ..." }
 *
 * 不命中 = 归因失败的硬错误（不静默退化）。调用方应把 failure surface 出来，
 * 让我们能第一时间发现 Anthropic 是否改了协议。
 */
export function extractAttributionContext(
  reqBody: {
    system?: Array<{ type?: string; text?: string }>;
  },
): { ok: true; ctx: AttributionContext } | { ok: false; failure: AttributionContextFailure } {
  const sys = reqBody.system ?? [];
  if (sys.length === 0) return { ok: false, failure: { kind: "no_system_block_0" } };
  const blk = sys[0]!;
  if (blk.type !== "text" || typeof blk.text !== "string") {
    return { ok: false, failure: { kind: "system_block_0_not_text" } };
  }
  const m = BILLING_HEADER_RE.exec(blk.text);
  if (!m || !m.groups) {
    return { ok: false, failure: { kind: "billing_header_not_matched", text: blk.text } };
  }
  const { version, entrypoint, cch, workload } = m.groups;
  return {
    ok: true,
    ctx: {
      ccVersion: version!,
      entrypoint: entrypoint!,
      ...(cch ? { cch } : {}),
      ...(workload ? { workload } : {}),
    },
  };
}

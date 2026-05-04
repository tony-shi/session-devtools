import type {
  ContextSegment,
  ExpectedQueryContext,
  HarnessRuntimeSnapshot,
  ProxyQuerySnapshot,
  RequestLevelExact,
  SegmentSourceMap,
  SourceRef,
  TargetMaterialization,
  TargetMessage,
  TargetRequest,
  TargetSegment,
} from "./types";
import { canonicalJson, hashCanonicalJson } from "./request-canonical";

const PLACEHOLDER_PREFIX = "{{target-placeholder:";

type RequestBody = Record<string, unknown>;

interface BuildTargetRequestOptions {
  expected: ExpectedQueryContext;
  snapshot: ProxyQuerySnapshot;
  /** 从 JSONL assistant 行推断的模型名。存在时优先于 proxy snapshot 的 model 字段。 */
  inferredModel?: string;
  // 非 proxy 运行态快照。runtimeSnapshot.inferredModel 优先级高于顶层 inferredModel。
  // proxy snapshot 中的 request scalar 仅作 fallback，且在 metadata 中显式标注。
  runtimeSnapshot?: HarnessRuntimeSnapshot;
}

interface RequestLevelOptions {
  snapshot: ProxyQuerySnapshot;
  targetRequest: TargetRequest;
  proxyRequestBody?: Record<string, unknown>;
  hasSegmentEvidence: boolean;
}

interface TargetBuildResult {
  targetRequest: TargetRequest;
  requestBody: RequestBody;
}

/**
 * 从 ExpectedQueryContext 正向构建 request-level TargetRequest。
 *
 * request 标量字段来源优先级：
 *   1. runtimeSnapshot.inferredModel（HarnessRuntimeSnapshot 中的 JSONL 推断值）
 *   2. inferredModel（调用方直接传入的 JSONL 推断值，与 1 同源，取任一非空值）
 *   3. ProxyQuerySnapshot.request → max_tokens / stream / context_management 等
 *      （proxy_snapshot_fallback）
 *
 * metadata.requestScalarSource 与 proxySnapshotFallbackFields 标注实际来源，
 * 避免 proxy fallback 字段被误认为正向重建结果。
 */
export function buildTargetRequest(options: BuildTargetRequestOptions): TargetRequest {
  return buildTargetRequestWithBody(options).targetRequest;
}

export function buildTargetRequestWithBody(options: BuildTargetRequestOptions): TargetBuildResult {
  const { expected, snapshot, runtimeSnapshot } = options;
  // runtimeSnapshot.inferredModel 优先；顶层 inferredModel 作为兼容保留
  const inferredModel = runtimeSnapshot?.inferredModel ?? options.inferredModel;
  const sourceMap: SegmentSourceMap = {};

  const sortedSegments = [...expected.segments].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const systemSegments = sortedSegments.filter((seg) => seg.section === "system");
  const toolSegments = sortedSegments.filter((seg) => seg.section === "tools");
  const messageSegments = sortedSegments.filter((seg) => seg.section === "messages");

  const system = systemSegments.map((seg, index) =>
    targetSegmentFromContext(seg, `reqBody.system[${index}]`, sourceMap),
  );
  const tools = toolSegments.map((seg, index) =>
    targetSegmentFromContext(seg, `reqBody.tools[${index}]`, sourceMap),
  );
  const messages = buildTargetMessages(messageSegments, sourceMap);

  // model 优先从 JSONL 推断（inferredModel），fallback 到 proxy snapshot
  const request = buildRequestScalars(snapshot, inferredModel);
  const requestBody: RequestBody = { ...request };
  if (messages.length > 0) {
    requestBody.messages = messages.map((msg) => messageToRequestBody(msg, sourceMap));
  }
  if (system.length > 0) {
    requestBody.system = system.map((seg) => segmentToSystemBlock(seg));
  }
  if (tools.length > 0) {
    requestBody.tools = tools.map((seg) => segmentToToolBlock(seg));
  }

  const canonical = canonicalJson(requestBody);
  const unmaterializedRules = Array.isArray(expected.metadata?.unimplementedRules)
    ? expected.metadata.unimplementedRules.filter((x): x is string => typeof x === "string")
    : [];

  return {
    requestBody,
    targetRequest: {
      request,
      system,
      tools,
      messages,
      sourceMap,
      rulesApplied: expected.rulesApplied,
      unmaterializedRules,
      canonicalJson: canonical,
      canonicalHash: hashCanonicalJson(requestBody),
      metadata: {
        // 标注 request 标量字段的实际来源：
        //   model → inferredModel 存在时来自 JSONL assistant 行（"jsonl_inferred"）；否则来自 proxy snapshot
        //   max_tokens / stream 等 → JSONL 暂不暴露，来自 proxy snapshot（"proxy_snapshot_fallback"）
        requestScalarSource: inferredModel ? "jsonl_inferred_model+proxy_snapshot_fallback" : "proxy_snapshot",
        requestScalarSourceReason: inferredModel
          ? "model_from_jsonl_assistant_message"
          : "runtime_state_not_materialized",
        // proxy_snapshot_fallback 字段列表：标注哪些 request scalar 仍依赖 proxy，
        // 不得参与 exact reconstruction 口径的判断。
        proxySnapshotFallbackFields: collectProxyFallbackFields(snapshot, inferredModel),
        exactSegmentCount: [...system, ...tools, ...messages.flatMap((m) => m.content)]
          .filter((seg) => seg.materialization === "exact").length,
        placeholderSegmentCount: [...system, ...tools, ...messages.flatMap((m) => m.content)]
          .filter((seg) => seg.materialization === "placeholder").length,
        ...(runtimeSnapshot !== undefined
          ? { runtimeSnapshotSource: runtimeSnapshot.source }
          : {}),
      },
    },
  };
}

export function computeRequestLevelExact(options: RequestLevelOptions): RequestLevelExact {
  const { snapshot, targetRequest, proxyRequestBody, hasSegmentEvidence } = options;

  // raw exact 只有在 target 也提供 wireHash 时才可比较。当前 TargetRequest 只产出 canonical JSON，
  // 因此不会把 canonical hash 冒充 wire hash。
  const targetWireHash = typeof targetRequest.metadata?.wireHash === "string"
    ? targetRequest.metadata.wireHash
    : undefined;
  const rawExact = !!targetWireHash &&
    !!snapshot.rawRequestBytesHash &&
    snapshot.rawRequestBytesHash === targetWireHash;

  const canonicalExact = !!snapshot.canonicalRequestHash &&
    snapshot.canonicalRequestHash === targetRequest.canonicalHash;

  const structuralExact = proxyRequestBody
    ? structuralEqualsWithPlaceholders(proxyRequestBody, JSON.parse(targetRequest.canonicalJson) as unknown)
    : false;

  const segmentOnly = !rawExact && !canonicalExact && !structuralExact && hasSegmentEvidence;
  const level: RequestLevelExact["level"] = rawExact
    ? "raw"
    : canonicalExact
      ? "canonical"
      : structuralExact
        ? "structural"
        : segmentOnly
          ? "segment-only"
          : "none";

  const reasons: string[] = [];
  if (!targetWireHash) reasons.push("target_wire_hash_unavailable");
  if (!snapshot.canonicalRequestHash) reasons.push("proxy_canonical_hash_unavailable");
  if (!proxyRequestBody) reasons.push("proxy_request_body_unavailable");
  if (targetRequest.unmaterializedRules.length > 0) {
    reasons.push(`unmaterialized_rules:${targetRequest.unmaterializedRules.join(",")}`);
  }

  return { rawExact, canonicalExact, structuralExact, segmentOnly, level, reasons };
}

function buildRequestScalars(snapshot: ProxyQuerySnapshot, inferredModel?: string): TargetRequest["request"] {
  const req = snapshot.request ?? {};
  const request: TargetRequest["request"] = {};
  // model：JSONL 推断优先，fallback 到 proxy snapshot
  const resolvedModel = inferredModel ?? req.model;
  if (resolvedModel !== undefined) request.model = resolvedModel;
  // 以下字段 JSONL 暂未暴露，只能从 proxy snapshot 取（proxy_snapshot_fallback）
  if (req.maxTokens !== undefined) request.max_tokens = req.maxTokens;
  if (req.stream !== undefined) request.stream = req.stream;
  if (req.contextManagement !== undefined) request.context_management = req.contextManagement;
  if (req.outputConfig !== undefined) request.output_config = req.outputConfig;
  if (req.thinking !== undefined) request.thinking = req.thinking;
  if (req.metadata !== undefined) request.metadata = req.metadata;
  return request;
}

// 收集实际上仍从 proxy snapshot 取值的 request scalar 字段名列表。
// 用于在 metadata.proxySnapshotFallbackFields 中明确标注，
// 防止 exact reconstruction 判断误把 proxy fallback 字段算作正向重建。
function collectProxyFallbackFields(
  snapshot: ProxyQuerySnapshot,
  inferredModel: string | undefined,
): string[] {
  const req = snapshot.request ?? {};
  const fallbacks: string[] = [];
  // model 只有在没有 inferredModel 且 proxy 有值时才是 fallback
  if (!inferredModel && req.model !== undefined) fallbacks.push("model");
  // 以下字段目前均无法从 JSONL/runtime 获取，全部标为 fallback
  if (req.maxTokens !== undefined) fallbacks.push("max_tokens");
  if (req.stream !== undefined) fallbacks.push("stream");
  if (req.contextManagement !== undefined) fallbacks.push("context_management");
  if (req.outputConfig !== undefined) fallbacks.push("output_config");
  if (req.thinking !== undefined) fallbacks.push("thinking");
  if (req.metadata !== undefined) fallbacks.push("metadata");
  return fallbacks;
}

function buildTargetMessages(
  segments: ContextSegment[],
  sourceMap: SegmentSourceMap,
): TargetMessage[] {
  const groups = new Map<string, ContextSegment[]>();
  for (const seg of segments) {
    const groupId = typeof seg.metadata?.logicalMessageId === "string"
      ? seg.metadata.logicalMessageId
      : `seg:${seg.id}`;
    const group = groups.get(groupId) ?? [];
    group.push(seg);
    groups.set(groupId, group);
  }

  const messages: TargetMessage[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const first = group[0];
    if (!first) continue;
    const role = first.role === "assistant" ? "assistant" : "user";
    const messageIndex = messages.length;
    const content = group.map((seg, blockIndex) =>
      targetSegmentFromContext(seg, `reqBody.messages[${messageIndex}].content[${blockIndex}]`, sourceMap),
    );
    messages.push({
      role,
      jsonPath: `reqBody.messages[${messageIndex}]`,
      content,
      sourceSegmentIds: group.map((seg) => seg.id),
    });
  }
  return messages;
}

function targetSegmentFromContext(
  seg: ContextSegment,
  jsonPath: string,
  sourceMap: SegmentSourceMap,
): TargetSegment {
  const text = seg.contentRef?.text;
  const hasText = typeof text === "string";
  const materialization: TargetMaterialization = hasText
    ? "exact"
    : (seg.charCount ?? 0) > 0
      ? "placeholder"
      : "unavailable";
  const placeholder = hasText ? undefined : placeholderFor(seg);
  const ruleId = typeof seg.metadata?.ruleId === "string" ? seg.metadata.ruleId : undefined;
  const toolName = typeof seg.metadata?.toolName === "string" ? seg.metadata.toolName : undefined;

  // proxy sourceRef 不允许出现在 sourceMap（全局不变量：TargetRequest.sourceMap 不含 proxy）。
  // expected segments 经 G1 保障通常已洁净，此处过滤作为 builder 层的防御性二次检查。
  const nonProxyRefs = (seg.sourceRefs as SourceRef[]).filter((r) => r.kind !== "proxy");

  sourceMap[jsonPath] = {
    jsonPath,
    segmentIds: [seg.id],
    sourceRefs: nonProxyRefs,
    category: seg.category,
    role: seg.role,
    ...(ruleId ? { ruleIds: [ruleId] } : {}),
    materialization,
  };

  return {
    id: seg.id,
    jsonPath,
    section: seg.section,
    category: seg.category,
    role: seg.role,
    ...(hasText ? { text } : {}),
    ...(placeholder ? { placeholder } : {}),
    ...(seg.rawHash ? { rawHash: seg.rawHash } : {}),
    ...(seg.charCount !== undefined ? { charCount: seg.charCount } : {}),
    ...(seg.toolUseId ? { toolUseId: seg.toolUseId } : {}),
    ...(toolName ? { toolName } : {}),
    sourceSegmentIds: [seg.id],
    materialization,
  };
}

function segmentToSystemBlock(seg: TargetSegment): unknown {
  return { type: "text", text: seg.text ?? seg.placeholder ?? "" };
}

function segmentToToolBlock(seg: TargetSegment): unknown {
  if (seg.text) {
    try {
      const parsed = JSON.parse(seg.text) as unknown;
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // contentRef 只是工具描述文本时不能伪装成完整 tool object，保留 placeholder 暴露缺口。
    }
  }
  return seg.placeholder ?? placeholderForId(seg.id);
}

function messageToRequestBody(message: TargetMessage, sourceMap: SegmentSourceMap): unknown {
  return {
    role: message.role,
    content: message.content.map((seg, index) =>
      segmentToMessageBlock(seg, `${message.jsonPath}.content[${index}]`, sourceMap),
    ),
  };
}

function segmentToMessageBlock(
  seg: TargetSegment,
  jsonPath: string,
  sourceMap: SegmentSourceMap,
): unknown {
  const text = seg.text ?? seg.placeholder ?? "";
  const textPath = `${jsonPath}.text`;

  if (seg.category === "tool_use") {
    const input = seg.text ? parseToolInput(seg.text) : text;
    return {
      type: "tool_use",
      id: seg.toolUseId ?? placeholderForId(`${seg.id}:tool_use_id`),
      name: seg.toolName ?? placeholderForId(`${seg.id}:tool_name`),
      input,
    };
  }

  if (seg.category === "tool_result") {
    return {
      type: "tool_result",
      tool_use_id: seg.toolUseId ?? placeholderForId(`${seg.id}:tool_use_id`),
      content: text,
    };
  }

  if (seg.category === "thinking") {
    return { type: "thinking", thinking: text };
  }

  sourceMap[textPath] = {
    jsonPath: textPath,
    segmentIds: seg.sourceSegmentIds,
    sourceRefs: sourceMap[jsonPath]?.sourceRefs ?? [],
    category: seg.category,
    role: seg.role,
    materialization: seg.materialization,
  };
  return { type: "text", text };
}

function parseToolInput(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function placeholderFor(seg: ContextSegment): string {
  return placeholderForId(seg.id);
}

function placeholderForId(id: string): string {
  return `${PLACEHOLDER_PREFIX}${id}}}`;
}

function isPlaceholder(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(PLACEHOLDER_PREFIX) && value.endsWith("}}");
}

function structuralEqualsWithPlaceholders(proxyValue: unknown, targetValue: unknown): boolean {
  if (isPlaceholder(targetValue)) return typeof proxyValue === "string";
  if (targetValue === null || proxyValue === null) return targetValue === proxyValue;
  if (Array.isArray(targetValue) || Array.isArray(proxyValue)) {
    if (!Array.isArray(targetValue) || !Array.isArray(proxyValue)) return false;
    if (targetValue.length !== proxyValue.length) return false;
    return targetValue.every((item, index) => structuralEqualsWithPlaceholders(proxyValue[index], item));
  }
  if (typeof targetValue === "object" || typeof proxyValue === "object") {
    if (typeof targetValue !== "object" || typeof proxyValue !== "object") return false;
    const targetObj = targetValue as Record<string, unknown>;
    const proxyObj = proxyValue as Record<string, unknown>;
    const targetKeys = Object.keys(targetObj).sort();
    const proxyKeys = Object.keys(proxyObj).sort();
    if (targetKeys.length !== proxyKeys.length) return false;
    for (let i = 0; i < targetKeys.length; i++) {
      if (targetKeys[i] !== proxyKeys[i]) return false;
      if (!structuralEqualsWithPlaceholders(proxyObj[proxyKeys[i]!], targetObj[targetKeys[i]!])) return false;
    }
    return true;
  }
  return Object.is(proxyValue, targetValue);
}

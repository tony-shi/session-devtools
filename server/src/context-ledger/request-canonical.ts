import { createHash } from "crypto";

/**
 * 对 JSON 值做稳定排序，作为 request-level canonical 对账的唯一序列化入口。
 *
 * 原因：`JSON.stringify()` 会保留对象插入顺序，适合旧的 parsedRequestHash 兼容字段，
 * 但不适合作为 canonical exact 的事实口径。这里递归排序 object key，并删除
 * `undefined` 字段，确保语义相同的 request body 得到同一个 canonical hash。
 */
export function canonicalizeJson(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((item) => canonicalizeJson(item));
  if (typeof value !== "object") return value;

  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort()) {
    const next = input[key];
    if (next === undefined) continue;
    output[key] = canonicalizeJson(next);
  }
  return output;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value));
}

export function hashSha256Full(text: string): string {
  return "sha256:" + createHash("sha256").update(text).digest("hex");
}

export function hashCanonicalJson(value: unknown): string {
  return hashSha256Full(canonicalJson(value));
}

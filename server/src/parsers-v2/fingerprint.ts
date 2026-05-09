import { createHash } from "crypto";

export function computeFingerprint(eventTypes: Set<string>): string {
  const sorted = Array.from(eventTypes).sort().join(",");
  return createHash("sha1").update(sorted).digest("hex").slice(0, 12);
}

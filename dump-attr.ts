import { readFileSync } from "fs";
import { parseClaudeProxyRequest } from "./server/src/context-ledger/proxy-snapshot-parser";
import { inferClaudeProxyAttributions } from "./server/src/context-ledger/proxy-attribution";

for (const c of ["system-tools-overhead", "single-tool-call", "multi-turn-human", "large-tool-output"]) {
  const raw = JSON.parse(readFileSync(`server/test/fixtures/context-reconstruction/${c}/proxy-request.json`, "utf8"));
  const snap = parseClaudeProxyRequest(raw, { proxyFile: `f/${c}` });
  console.log(`${c}: before attribution segments=${snap.segments.length}`);
  const snapWithBody = { ...snap, metadata: { rawBody: raw.reqBody } };
  const attrs = inferClaudeProxyAttributions(snapWithBody);
  console.log(`${c}: after attribution segments=${snapWithBody.segments.length} attrs=${attrs.length}`);
  const byCat: Record<string, number> = {};
  for (const s of snapWithBody.segments) byCat[s.category] = (byCat[s.category] ?? 0) + 1;
  console.log("  byCategory:", JSON.stringify(byCat));
}

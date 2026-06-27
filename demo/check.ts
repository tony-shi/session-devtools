// demo/check.ts
//
// Drift guard for the offline demo. The demo's UI is the live client code (zero
// drift on rebuild), but its DATA is a snapshot frozen under a specific
// PARSER_VERSION. If the parser output shape later changes (which bumps
// PARSER_VERSION), the frozen JSON would mis-render against the new client.
//
// This compares the PARSER_VERSION the data was frozen under (stamped into
// demo/data/demo-manifest.json by freeze.ts) against the current source
// constant, and warns loudly when they differ — so "I changed the parser but
// forgot to re-freeze" surfaces at build time instead of as silent breakage.
//
// Runs as a pre-step of `build:demo`. Warns by default (exit 0); pass --strict
// to fail (exit 1) for CI-style enforcement.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const strict = process.argv.includes("--strict");

function fail(msg: string): never {
  console.error(`\n[demo:check] ${msg}\n`);
  process.exit(strict ? 1 : 0);
}

// Current parser version from source (single source of truth).
const parserSrc = readFileSync(join(REPO, "server/src/parsers-v2/index.ts"), "utf8");
const m = /export const PARSER_VERSION\s*=\s*(\d+)/.exec(parserSrc);
if (!m) fail("could not read PARSER_VERSION from server/src/parsers-v2/index.ts");
const current = Number(m![1]);

// Frozen version from the manifest.
let manifest: { parserVersion?: number; generatedAt?: string } | null = null;
try {
  manifest = JSON.parse(readFileSync(join(HERE, "data", "demo-manifest.json"), "utf8"));
} catch {
  fail("no frozen demo data found (demo/data/demo-manifest.json). Run `npm run demo:freeze`.");
}

const frozen = manifest!.parserVersion;
if (frozen == null) {
  fail(`frozen data has no parserVersion stamp (frozen before this guard existed). Re-run \`npm run demo:freeze\` (current PARSER_VERSION=${current}).`);
}

if (frozen !== current) {
  fail(
    `STALE demo data: frozen under PARSER_VERSION=${frozen} but current is ${current}.\n` +
    `  Parser output shape may have changed — the frozen JSON could mis-render.\n` +
    `  Fix: re-run \`npm run demo:freeze\` (with the dev server running).\n` +
    `  Frozen at: ${manifest!.generatedAt ?? "unknown"}`,
  );
}

console.log(`[demo:check] OK — demo data frozen under current PARSER_VERSION=${current}.`);

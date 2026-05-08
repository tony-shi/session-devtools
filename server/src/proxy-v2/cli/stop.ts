// devtools proxy v2 — stop CLI。
//
// 单纯调一次 reconcileToStopped。永不抛错，warnings 进 stderr。
// 用途：
// - start CLI 没干净退出（SIGKILL、断电）后的兜底清理
// - 用户主动从外部清理任何遗留状态
import { reconcileToStopped } from "../reconcile";

const log = (msg: string) => console.log(msg);

async function main() {
  log(`[stop] reconciling to STOPPED...`);
  const result = await reconcileToStopped(log);

  for (const a of result.actions) log(`  ${a}`);

  if (result.actions.length === 0 && result.warnings.length === 0) {
    log(`[stop] ✓ already in STOPPED state, nothing to do`);
    process.exit(0);
  }

  if (result.warnings.length > 0) {
    console.error(`[stop] ⚠ completed with warnings:`);
    for (const w of result.warnings) console.error(`  - ${w.step}: ${w.reason}`);
    process.exit(1);
  }

  log(`[stop] ✓ all clean`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`[stop] fatal: ${err instanceof Error ? err.stack ?? err.message : err}`);
  process.exit(1);
});

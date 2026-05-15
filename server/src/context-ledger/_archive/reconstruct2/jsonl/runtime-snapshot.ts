// reconstruct2 / jsonl / runtime-snapshot
//
// 把 JSONL record 顶层重复写入的运行态事实（permissionMode / cwd / version / ...）
// 摄入到 HarnessRuntimeSnapshot。第一阶段不读 proxy / 不读本地 cli.js，
// 仅消费 JSONL 自身可见字段。
//
// 设计前提：
//   - 字段值缺失时不要默认填业务值；ContextFrame 拍快照时直接保留 undefined。
//   - cwd 出现时同步派生 autoMemoryPath，便于后续 rule materializer 引用。
//
// 字段语义参考：
//   - restored-src/src/services/store.ts                 cwd / version 写入位点
//   - restored-src/src/services/permissions/permissionsRuntime.ts  permissionMode
//   - restored-src/src/services/automemory/index.ts       auto memory path 计算

import { homedir } from "node:os";
import { join } from "node:path";

import type { HarnessRuntimeSnapshot } from "../../types";

interface JsonlRuntimeFactsRecord {
  userType?: string;
  entrypoint?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
}

/** 把单条 JSONL record 的运行态字段并入 facts。
 * 同一 session 多条 record 重复出现这些字段时，后写入的覆盖前者——
 * 与旧 jsonl-mutation-parser absorbRuntimeFacts 一致，方便对比。
 */
export function absorbRuntimeFacts(
  rec: JsonlRuntimeFactsRecord,
  facts: Partial<HarnessRuntimeSnapshot>,
): void {
  if (
    rec.userType === "external" ||
    rec.userType === "ant" ||
    rec.userType === "unknown"
  ) {
    facts.userType = rec.userType;
  }
  if (typeof rec.entrypoint === "string" && rec.entrypoint.length > 0) {
    facts.entrypoint = rec.entrypoint;
  }
  if (typeof rec.cwd === "string" && rec.cwd.length > 0) {
    facts.cwd = rec.cwd;
    facts.autoMemoryPath = defaultAutoMemoryPath(rec.cwd);
    // 2.1.126 external CLI 默认启用 auto memory；若未来 JSONL 暴露显式禁用信号，
    // 应在这里覆盖为 false，避免 materializer 继续生成该 section。
    facts.featureFlags = {
      ...(facts.featureFlags ?? {}),
      "isAutoMemoryEnabled()": true,
    };
  }
  if (typeof rec.version === "string" && rec.version.length > 0) {
    facts.claudeCodeVersion = rec.version;
  }
  // Claude Code 2.1.126 不显式记录默认 output style；缺省即 standard intro。
  // 若未来字段出现，应在这里直接写入而非让 evaluator 猜测。
  const settings = (facts.settings ?? {}) as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(settings, "outputStyleConfig")) {
    settings.outputStyleConfig = null;
  }
  facts.settings = settings;
}

function defaultAutoMemoryPath(cwd: string): string {
  const sanitizedCwd = cwd.replace(/\//g, "-");
  return join(homedir(), ".claude", "projects", sanitizedCwd, "memory") + "/";
}

export interface BuildRuntimeSnapshotInput {
  facts: Partial<HarnessRuntimeSnapshot>;
  sessionId: string;
  jsonlFile: string;
  inferredModel?: string;
  permissionMode?: string;
  firstTimestamp?: string;
}

/** 收尾函数：把 facts 与从 mutation 推断出的字段合并成最终 HarnessRuntimeSnapshot。 */
export function finalizeRuntimeSnapshot(
  input: BuildRuntimeSnapshotInput,
): HarnessRuntimeSnapshot {
  const { facts, sessionId, jsonlFile, inferredModel, permissionMode, firstTimestamp } = input;

  const snap: HarnessRuntimeSnapshot = {
    source: "jsonl",
    ...(inferredModel !== undefined ? { inferredModel } : {}),
    ...(jsonlFile ? { jsonlFile } : {}),
    ...(sessionId && sessionId !== "unknown" ? { sessionId } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(firstTimestamp !== undefined ? { firstTimestamp } : {}),
    ...(facts.claudeCodeVersion !== undefined
      ? { claudeCodeVersion: facts.claudeCodeVersion }
      : {}),
    ...(facts.entrypoint !== undefined ? { entrypoint: facts.entrypoint } : {}),
    ...(facts.cwd !== undefined ? { cwd: facts.cwd } : {}),
    ...(facts.userType !== undefined ? { userType: facts.userType } : {}),
    ...(facts.autoMemoryPath !== undefined ? { autoMemoryPath: facts.autoMemoryPath } : {}),
    ...(facts.settings !== undefined ? { settings: facts.settings } : {}),
    ...(facts.featureFlags !== undefined ? { featureFlags: facts.featureFlags } : {}),
  };
  return snap;
}

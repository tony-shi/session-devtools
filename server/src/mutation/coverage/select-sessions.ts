// Greedy set-cover selector: picks the minimum sessions that cover the
// maximum number of unique event-type keys.
import type { SessionCoverageInfo } from "./types";

export interface SelectionResult {
  selectedSessions: SessionCoverageInfo[];
  coveredKeys: Set<string>;
  uncoveredKeys: string[];
  coveragePercent: number;
}

/**
 * Greedy maximum-coverage selector.
 * At each step picks the session that contributes the most new keys.
 * Stops when `maxSessions` is reached or no new keys can be added.
 */
export function selectCoveringSessions(
  sessions: SessionCoverageInfo[],
  allKnownKeys: string[],
  maxSessions = 10,
): SelectionResult {
  const allKeys = new Set(allKnownKeys);
  const remaining = new Set(allKnownKeys);
  const selected: SessionCoverageInfo[] = [];
  const pool = sessions.slice(); // don't mutate caller's array

  while (selected.length < maxSessions && remaining.size > 0 && pool.length > 0) {
    let bestIdx = -1;
    let bestGain = 0;

    for (let i = 0; i < pool.length; i++) {
      const s = pool[i];
      const sessionKeys = [...s.typesPresent, ...s.subTypesPresent];
      const gain = sessionKeys.filter((k) => remaining.has(k)).length;
      if (gain > bestGain) {
        bestGain = gain;
        bestIdx = i;
      }
    }

    if (bestIdx === -1 || bestGain === 0) break;

    const best = pool.splice(bestIdx, 1)[0];
    selected.push(best);
    for (const k of [...best.typesPresent, ...best.subTypesPresent]) {
      remaining.delete(k);
    }
  }

  const coveredKeys = new Set(
    selected.flatMap((s) => [...s.typesPresent, ...s.subTypesPresent]),
  );
  const uncoveredKeys = allKnownKeys.filter((k) => !coveredKeys.has(k));
  const coveragePercent = allKeys.size > 0 ? (coveredKeys.size / allKeys.size) * 100 : 0;

  return { selectedSessions: selected, coveredKeys, uncoveredKeys, coveragePercent };
}

---
layout: default
title: Session Turn Badges
---

# Session Turn Badges

Badges mark events in a turn that deserve user attention. Each badge has a single canonical meaning.

---

## Turn-level badges (left sidebar)

| Badge | Symbol | Color | Condition | Data source |
|---|---|---|---|---|
| **Compaction** | `C` | Red `#ef4444` | `turn.hasCompaction === true` — context was compacted at least once during this turn | `UserTurn.hasCompaction` |
| **Error** | `E` | Deep red `#dc2626` | `turn.errorCount > 0` — one or more `system:api_error` events occurred | `UserTurn.errorCount` |
| **Sub Agent** | `⎇` | Purple `#7c3aed` | Any call in this turn spawned a sub-agent (`call.subAgents.length > 0`) | `LlmCall.subAgents` |
| **User Command** | `/` | Amber `#d97706` | A `user:command` event (slash command like `/clear`, `/compact`) appeared in this turn's interval events | `IntervalEvent.kind === "user:command"` |
| **Unknown Event** | `?` | Gray `#9ca3af` | A JSONL event could not be classified (`IntervalEvent.kind === "unknown"`) | `IntervalEvent.kind === "unknown"` |

---

## Call-level badges (expanded call list)

| Badge | Symbol | Color | Condition |
|---|---|---|---|
| **Compaction call** | `◆` | Red `#ef4444` | `call.isCompaction === true` — this specific LLM call is the compaction call |

---

## Excluded / intentionally absent

| Candidate | Reason excluded |
|---|---|
| `isSignificant` (blue dot) | Threshold 2 000 tokens is too low — nearly every call triggers it, zero signal |
| `hasUnknownSpike` | Backend always emits `false` in current parser version, dead field |
| `midTurnInjection` | User mid-turn input is contextual, not an anomaly requiring attention |

---

## Semantic contract

- A badge on a turn means **something happened inside that turn worth investigating**.
- Badges are **additive**: a turn can carry `C + E + ⎇` simultaneously.
- Priority order when space is limited (show leftmost first): `C > E > ⎇ > / > ?`
- Colors are consistent with the rest of the UI: red = destructive/compaction, purple = agent hierarchy, amber = user-driven, gray = unknown.

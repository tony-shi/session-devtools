#!/usr/bin/env python3
"""
Analyze proxy traffic dumps to compute the distribution of messages[] array
size per /v1/messages request (i.e. how many messages are sent each API call).

Sources scanned (merged):
  ~/.ourtool/traffic.jsonl
  ~/.api-dashboard/proxy/traffic.jsonl
  ~/.api-dashboard-worktrees/*/proxy/traffic.jsonl
  server/test/fixtures/context-reconstruction/*/proxy-request.json  (fixtures)

Each entry with kind=response, url containing /v1/messages (not count_tokens),
and a parseable reqBody.messages list contributes one data point.

Usage:
  python3 scripts/analyze-message-requests.py [--extra-traffic <file> ...]
"""

import gzip
import json
import math
import sys
import argparse
from pathlib import Path
from collections import defaultdict


# ── stat helpers ──────────────────────────────────────────────────────────────

def percentile(sorted_values: list[int], p: float) -> float:
    if not sorted_values:
        return 0.0
    n = len(sorted_values)
    idx = (p / 100) * (n - 1)
    lo = int(idx)
    hi = lo + 1
    frac = idx - lo
    if hi >= n:
        return float(sorted_values[-1])
    return sorted_values[lo] * (1 - frac) + sorted_values[hi] * frac


def format_bar(value: float, max_value: float, width: int = 32) -> str:
    if max_value == 0:
        return "░" * width
    filled = round(value / max_value * width)
    return "█" * filled + "░" * (width - filled)


def print_histogram(sorted_values: list[int], bins: int = 15) -> None:
    if not sorted_values:
        return
    lo, hi = sorted_values[0], sorted_values[-1]
    if lo == hi:
        print(f"    All requests have exactly {lo} messages")
        return

    bin_size = max(1, math.ceil((hi - lo + 1) / bins))
    buckets: dict[int, int] = defaultdict(int)
    for v in sorted_values:
        buckets[(v - lo) // bin_size] += 1

    max_count = max(buckets.values())
    print(f"    {'Range':<14}  {'Count':>6}  Bar")
    print(f"    {'-'*14}  {'-'*6}  {'-'*32}")
    for b in range(bins):
        if b not in buckets:
            continue
        r_lo = lo + b * bin_size
        r_hi = r_lo + bin_size - 1
        count = buckets[b]
        bar = format_bar(count, max_count)
        print(f"    {r_lo:>5} – {r_hi:<6}  {count:>6}  {bar}")


# ── data collection ───────────────────────────────────────────────────────────

def parse_body(raw) -> dict | None:
    if not raw:
        return None
    if isinstance(raw, dict):
        return raw
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None


def open_traffic(path: Path):
    """Open a traffic file transparently, handling .gz compression."""
    if path.suffix == ".gz":
        return gzip.open(path, "rt", encoding="utf-8")
    return open(path, encoding="utf-8")


def collect_from_traffic_file(path: Path, counts: list[int], sources: list[str]) -> int:
    """Read a traffic.jsonl or traffic.jsonl.gz and collect messages[] sizes. Returns number added."""
    added = 0
    try:
        with open_traffic(path) as f:
            for raw_line in f:
                raw_line = raw_line.strip()
                if not raw_line:
                    continue
                try:
                    obj = json.loads(raw_line)
                except json.JSONDecodeError:
                    continue

                if obj.get("kind") != "response":
                    continue
                url = obj.get("url", "")
                if "/v1/messages" not in url or "count_tokens" in url:
                    continue

                body = parse_body(obj.get("reqBody"))
                if body is None:
                    continue
                msgs = body.get("messages")
                if not isinstance(msgs, list) or len(msgs) == 0:
                    continue

                counts.append(len(msgs))
                sources.append(str(path))
                added += 1
    except (OSError, PermissionError) as e:
        print(f"  [warn] cannot read {path}: {e}", file=sys.stderr)
    return added


def collect_from_proxy_request_json(path: Path, counts: list[int], sources: list[str]) -> int:
    """Read a single proxy-request.json fixture. Returns number added."""
    try:
        with open(path, encoding="utf-8") as f:
            obj = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print(f"  [warn] cannot read {path}: {e}", file=sys.stderr)
        return 0

    body = parse_body(obj.get("reqBody"))
    if body is None:
        return 0
    msgs = body.get("messages")
    if not isinstance(msgs, list) or len(msgs) == 0:
        return 0

    counts.append(len(msgs))
    sources.append(str(path))
    return 1


# ── main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Distribution of messages[] size per /v1/messages request"
    )
    parser.add_argument(
        "--extra-traffic", nargs="*", metavar="FILE",
        help="Additional traffic.jsonl files to include"
    )
    parser.add_argument(
        "--no-fixtures", action="store_true",
        help="Skip server/test/fixtures proxy-request.json files"
    )
    args = parser.parse_args()

    home = Path.home()
    counts: list[int] = []
    sources: list[str] = []
    file_stats: list[tuple[str, int]] = []  # (label, count added)

    # 1. Known traffic.jsonl locations
    def glob_traffic(directory: Path) -> list[Path]:
        """Return all traffic.jsonl and traffic.jsonl.*.gz files under directory."""
        if not directory.exists():
            return []
        files = sorted(directory.glob("traffic.jsonl"))
        files += sorted(directory.glob("traffic.jsonl.*.gz"))
        return files

    worktree_dir = home / ".api-dashboard-worktrees"
    worktree_traffic = []
    if worktree_dir.exists():
        for proxy_dir in sorted(worktree_dir.glob("*/proxy")):
            worktree_traffic.extend(glob_traffic(proxy_dir))

    traffic_files = [
        *glob_traffic(home / ".ourtool"),
        *glob_traffic(home / ".api-dashboard" / "proxy"),
        *worktree_traffic,
    ]
    if args.extra_traffic:
        traffic_files += [Path(p) for p in args.extra_traffic]

    for tf in traffic_files:
        if not tf.exists():
            continue
        before = len(counts)
        collect_from_traffic_file(tf, counts, sources)
        added = len(counts) - before
        file_stats.append((str(tf), added))

    # 2. Fixture proxy-request.json files
    if not args.no_fixtures:
        fixture_root = Path(__file__).parent.parent / "server" / "test" / "fixtures"
        for pf in sorted(fixture_root.rglob("proxy-request.json")):
            before = len(counts)
            collect_from_proxy_request_json(pf, counts, sources)
            added = len(counts) - before
            if added:
                file_stats.append((str(pf.relative_to(fixture_root.parent.parent)), added))

    if not counts:
        print("No /v1/messages requests with a messages[] array found.")
        sys.exit(0)

    counts.sort()
    n = len(counts)
    total = sum(counts)
    avg = total / n
    pct_targets = [50, 75, 90, 95, 99, 99.9]

    print(f"\n{'='*62}")
    print(f"  messages[] Size Distribution  (per /v1/messages request)")
    print(f"{'='*62}")
    print()

    # Source summary
    print(f"  Sources")
    print(f"  {'-'*50}")
    for label, cnt in file_stats:
        if cnt:
            print(f"  {cnt:>4} requests  {label}")
    print()

    p99_val = percentile(counts, 99)

    print(f"  Total requests  : {n}")
    print(f"  Total messages  : {total}")
    print()
    print(f"  ┌─ Key metrics ──────────────────────┐")
    print(f"  │  avg (mean)    : {avg:>8.1f}           │")
    print(f"  │  p99           : {p99_val:>8.1f}           │")
    print(f"  └────────────────────────────────────┘")
    print()
    print(f"  Min             : {counts[0]}")
    print(f"  Max             : {counts[-1]}")
    print()
    print(f"  Full Percentile Distribution")
    print(f"  {'-'*38}")
    for p in pct_targets:
        val = percentile(counts, p)
        label = f"p{p}"
        marker = "  ◀ key" if p == 99 else ""
        print(f"  {label:<8}        : {val:>8.1f}{marker}")
    print()

    print(f"  Histogram")
    print_histogram(counts)
    print()


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""扫描目录下 TODO/FIXME/XXX/HACK 标注，渲染为 HTML 报告并在浏览器打开。"""

import re
import sys
import webbrowser
from html import escape
from pathlib import Path
from collections import Counter

EXTS = {".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java"}
IGNORE = {"node_modules", "dist", ".git", "build", ".venv", "__pycache__"}
PATTERN = re.compile(r"(TODO|FIXME|XXX|HACK)[:\s](.*)")

COLORS = {"TODO": "#3b82f6", "FIXME": "#ef4444", "XXX": "#f59e0b", "HACK": "#a855f7"}


def scan(root: Path):
    hits = []
    for path in root.rglob("*"):
        if any(part in IGNORE for part in path.parts):
            continue
        if not path.is_file() or path.suffix not in EXTS:
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for lineno, line in enumerate(text.splitlines(), 1):
            m = PATTERN.search(line)
            if m:
                hits.append({
                    "file": str(path.relative_to(root)),
                    "line": lineno,
                    "type": m.group(1),
                    "text": m.group(2).strip()[:120],
                })
    return hits


def render(hits, root: Path) -> str:
    counts = Counter(h["type"] for h in hits)
    by_file: dict[str, list] = {}
    for h in hits:
        by_file.setdefault(h["file"], []).append(h)

    badges = "".join(
        f'<span class="badge" style="background:{COLORS.get(t,"#888")}">{t}: {n}</span>'
        for t, n in counts.most_common()
    ) or '<span class="muted">no todos found</span>'

    sections = []
    for fname in sorted(by_file):
        rows = "".join(
            f'<tr><td class="ln">{h["line"]}</td>'
            f'<td><span class="tag" style="background:{COLORS.get(h["type"],"#888")}">{h["type"]}</span></td>'
            f'<td>{escape(h["text"])}</td></tr>'
            for h in by_file[fname]
        )
        sections.append(
            f'<h2>{escape(fname)}</h2>'
            f'<table><thead><tr><th>line</th><th>type</th><th>content</th></tr></thead>'
            f'<tbody>{rows}</tbody></table>'
        )

    body = "".join(sections) or '<p class="muted">No TODO/FIXME/XXX/HACK found.</p>'

    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>TODO Report — {escape(str(root))}</title>
<style>
body {{ font: 14px/1.5 system-ui, sans-serif; margin: 24px; max-width: 1100px; background: #fafafa; color: #222; }}
h1 {{ margin: 0 0 8px 0; }} h2 {{ margin-top: 28px; font-size: 15px; color: #555; font-family: monospace; }}
.summary {{ margin: 12px 0 24px 0; }}
.badge, .tag {{ display: inline-block; color: white; padding: 2px 8px; border-radius: 4px; font-size: 12px; margin-right: 6px; }}
.muted {{ color: #888; }}
table {{ border-collapse: collapse; width: 100%; background: white; }}
th, td {{ text-align: left; padding: 6px 10px; border-bottom: 1px solid #eee; font-size: 13px; }}
th {{ background: #f0f0f0; }}
td.ln {{ color: #888; width: 50px; font-family: monospace; }}
td:last-child {{ font-family: monospace; }}
</style></head><body>
<h1>TODO Report</h1>
<div class="muted">scanned: <code>{escape(str(root))}</code></div>
<div class="summary">{badges}</div>
{body}
</body></html>
"""


def main():
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    if not root.exists():
        print(f"[error] path not found: {root}", file=sys.stderr)
        sys.exit(1)
    hits = scan(root)
    out = Path("todo-report.html").resolve()
    out.write_text(render(hits, root))
    print(f"[ok] {len(hits)} todos found, wrote {out}")
    webbrowser.open(f"file://{out}")


if __name__ == "__main__":
    main()

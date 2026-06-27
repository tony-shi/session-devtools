#!/usr/bin/env bash
#
# Publish the static demo to the `gh-pages` branch via a detached worktree
# force-push. Never touches `main`. The frozen session JSON only exists on your
# machine (it reads ~/.claude), so the site cannot be built in CI — build
# locally, then publish:
#
#   npm run demo:freeze     # (dev server running) freeze sessions -> demo/data
#   npm run build:demo      # build client (mode=demo) -> dist-demo (+ data, 404.html)
#   npm run deploy:demo     # this script: push dist-demo -> gh-pages
#
# Then in GitHub: Settings -> Pages -> Source = gh-pages branch. For a custom
# domain, put the bare domain in demo/CNAME (one line); it is copied into the
# publish. gh-pages is force-pushed each deploy, so its history never grows.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$REPO_ROOT/dist-demo"
BRANCH="gh-pages"
WORKTREE="$(mktemp -d)"

[ -f "$DIST/index.html" ] || { echo "ERROR: $DIST/index.html missing — run 'npm run build:demo' first." >&2; exit 1; }

cd "$REPO_ROOT"

cleanup() { git worktree remove --force "$WORKTREE" 2>/dev/null || true; }
trap cleanup EXIT

# Worktree on gh-pages: reuse remote tip if present, else start a fresh branch.
if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
  git fetch origin "$BRANCH" --quiet
  git worktree add --force -B "$BRANCH" "$WORKTREE" "origin/$BRANCH"
else
  git worktree add --force -B "$BRANCH" "$WORKTREE" HEAD
fi

# Replace tree with the fresh build (keep .git).
find "$WORKTREE" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +
cp -R "$DIST/." "$WORKTREE/"
touch "$WORKTREE/.nojekyll"                                    # serve assets verbatim (no Jekyll)
[ -f "$REPO_ROOT/demo/CNAME" ] && cp "$REPO_ROOT/demo/CNAME" "$WORKTREE/CNAME"

cd "$WORKTREE"
git add -A
if git diff --cached --quiet; then
  echo "No changes to deploy."
else
  git commit -m "deploy demo $(date -u +%Y-%m-%dT%H:%M:%SZ)" --quiet
  git push --force origin "$BRANCH"
  echo "Deployed dist-demo -> $BRANCH"
fi

#!/bin/bash
# Run this script FROM inside the worktree directory.
# It merges the current branch into main, local only.
#
# Usage: /Users/shihuashen/Documents/session-dashboard/scripts/sync-worktree-to-main.sh

set -e

BRANCH="$(git branch --show-current)"
REPO_ROOT="$(git rev-parse --show-toplevel)"
MAIN_REPO="$(git worktree list | grep '\[main\]' | awk '{print $1}')"

if [ -z "$MAIN_REPO" ]; then
  echo "Error: could not find a worktree on [main]"
  exit 1
fi

echo "==> Current branch: $BRANCH"
echo "==> Merging into main at: $MAIN_REPO"

# Rebase onto main first so ff-only always succeeds
MAIN_HEAD="$(git -C "$MAIN_REPO" rev-parse HEAD)"
if ! git merge-base --is-ancestor "$MAIN_HEAD" HEAD; then
  echo "==> Rebasing $BRANCH onto main..."
  git rebase "$MAIN_HEAD"
fi

git -C "$MAIN_REPO" merge --ff-only "$BRANCH"

echo ""
echo "Done: $BRANCH merged into main (local only)."

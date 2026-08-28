#!/bin/sh
# Install repo git hooks into the current checkout (worktrees included —
# hooks live in the shared git dir, so one install covers every worktree).
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
HOOKS_DIR=$(git -C "$ROOT" rev-parse --git-common-dir)/hooks

for hook in "$ROOT"/ops/git-hooks/*; do
  name=$(basename "$hook")
  cp "$hook" "$HOOKS_DIR/$name"
  chmod +x "$HOOKS_DIR/$name"
  echo "installed $name -> $HOOKS_DIR/$name"
done

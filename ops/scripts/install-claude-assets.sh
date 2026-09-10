#!/bin/sh
# Link this checkout's Claude Code assets (.claude/skills, .claude/agents) into
# ~/.claude so every session on this machine gets them, not just sessions
# started inside the repo. Symlinks, not copies: the repo stays the source of
# truth and a `git pull` is the update.
#
# Idempotent. Refuses to replace anything that is not already one of our
# symlinks. `--uninstall` removes only the links this script made.
set -eu

# the main checkout, not a worktree under .claude/worktrees/
GIT_COMMON=$(git rev-parse --path-format=absolute --git-common-dir)
ROOT=$(CDPATH= cd -- "$(dirname -- "$GIT_COMMON")" && pwd)

SRC="$ROOT/.claude"
DEST="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"

uninstall=0
[ "${1:-}" = "--uninstall" ] && uninstall=1

link_one() {
  src=$1
  dest=$2

  if [ "$uninstall" -eq 1 ]; then
    if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$src" ]; then
      rm "$dest"
      echo "removed  $dest"
    fi
    return 0
  fi

  if [ -L "$dest" ]; then
    if [ "$(readlink "$dest")" = "$src" ]; then
      echo "ok       $dest"
      return 0
    fi
    echo "relinked $dest (was -> $(readlink "$dest"))"
    rm "$dest"
  elif [ -e "$dest" ]; then
    echo "SKIP     $dest already exists and is not a link from this checkout" >&2
    echo "         move it aside and re-run if you want the repo's version" >&2
    return 1
  fi

  ln -s "$src" "$dest"
  echo "linked   $dest -> $src"
}

fail=0
linked=0

# skills: one link per skill directory
if [ -d "$SRC/skills" ]; then
  [ "$uninstall" -eq 1 ] || mkdir -p "$DEST/skills"
  for d in "$SRC"/skills/*/; do
    [ -d "$d" ] || continue
    name=$(basename "$d")
    link_one "${d%/}" "$DEST/skills/$name" || fail=1
    linked=$((linked + 1))
  done
fi

# agents: one link per definition file
if [ -d "$SRC/agents" ]; then
  [ "$uninstall" -eq 1 ] || mkdir -p "$DEST/agents"
  for f in "$SRC"/agents/*.md; do
    [ -f "$f" ] || continue
    link_one "$f" "$DEST/agents/$(basename "$f")" || fail=1
    linked=$((linked + 1))
  done
fi

if [ "$linked" -eq 0 ]; then
  echo "claude-assets: nothing found under $SRC — is that branch checked out?" >&2
  exit 1
fi

if [ "$uninstall" -eq 1 ]; then
  echo "claude-assets: uninstalled"
else
  [ "$fail" -eq 0 ] && echo "claude-assets: installed (restart Claude Code sessions to pick them up)"
fi
exit "$fail"

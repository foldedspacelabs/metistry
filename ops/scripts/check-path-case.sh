#!/bin/sh
# Path-case check (plan §4.16): macOS forgives what Linux containers don't.
# 1. No two tracked paths may differ only by case.
# 2. Outside the seed vault tree (seed/vault/ — what `metistry init` stamps
#    at the instance ROOT, which is the Obsidian vault), tracked paths are
#    lowercase (documented exceptions listed below). `.metistry/` is the
#    machinery half of an instance and is lowercase like everything else.
set -eu

fail=0

dupes=$(git ls-files | tr '[:upper:]' '[:lower:]' | sort | uniq -d)
if [ -n "$dupes" ]; then
  echo "paths differing only by case:" >&2
  echo "$dupes" >&2
  fail=1
fi

# Allowed uppercase outside the vault: conventional filenames.
# Note: the Swift helpers' `.app` bundles contain Apple-mandated uppercase
# paths (`Contents/MacOS/…`) that would trip rule 2 — but they never reach
# this check, because a bundle is build output and `git ls-files` does not
# list it (.gitignore). Only the source `helper/Info.plist` is tracked, and
# `Info.plist` is in the allowlist below. If a bundle ever does need to be
# tracked, add `Contents/(MacOS|Resources|_CodeSignature)` here — those names
# are Apple's, not ours, and cannot be lowercased.
#
# `Package.swift` / `Package.resolved` (apps/macos) are the same kind of
# exception: SwiftPM looks for those exact names and there is no way to rename
# them. Everything else under apps/macos IS lowercase — the Swift targets name
# their own `path:` rather than taking SPM's default `Sources/<Target>/`.
#
# The root's CONTRIBUTING, SECURITY and NOTICE, and `.github/`'s CODEOWNERS,
# ISSUE_TEMPLATE/ and PULL_REQUEST_TEMPLATE.md, are names GitHub (and the
# Apache licence, for NOTICE) look for exactly.
allowed='^(seed/vault/|.*/(README|LICENSE|CLAUDE|AGENTS|SKILL|RESULTS|SYNTHESIS|Dockerfile|Info\.plist|PRODUCT|MEMORY|CHANGELOG)[^/]*$|(README|LICENSE|CLAUDE|AGENTS|CONTRIBUTING|SECURITY|NOTICE)[^/]*$|\.github/(CODEOWNERS|ISSUE_TEMPLATE/[a-z0-9_.-]+|PULL_REQUEST_TEMPLATE\.md)$|apps/macos/Package\.(swift|resolved)$|metistry-build-plan\.md$|docs/)'
offenders=$(git ls-files | grep -Ev "$allowed" | grep '[A-Z]' || true)
if [ -n "$offenders" ]; then
  echo "unexpected uppercase outside the seed vault tree (casing rule, CLAUDE.md):" >&2
  echo "$offenders" >&2
  fail=1
fi

[ "$fail" -eq 0 ] && echo "path-case: ok"
exit "$fail"

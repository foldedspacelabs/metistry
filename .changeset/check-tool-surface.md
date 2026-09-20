---
"@foldedspacelabs/metistry-mcp-brain": patch
---

**The definition-token budget is checked in CI, for every bridge.** The
manifest schema has always stated the rule — `discovery: lazy` "is for bridges
past >20 tools / >5k definition tokens" — but only `mcp-brain`'s own test
enforced it, on itself, so a second bridge could cross the line in silence.
`ops/scripts/check-tool-surface.mjs` now measures every bridge manifest under
`apps/` and `packages/` and fails the build past the budget, printing the
per-bridge numbers and the headroom on every run.

A bridge is measured through a `toolSurface()` export on its package entry —
the same instinct as `check()` making `metistry doctor` generic — and
`mcp-brain` ships the reference implementation: it stands up the real server
and reads a real `tools/list`, so the number is production's definitions
rather than a snapshot. A bridge without that export is reported
declared-only. On the tool-count axis the current number is acknowledged
rather than waived, so the **next** tool forces the lazy decision instead of
landing quietly.

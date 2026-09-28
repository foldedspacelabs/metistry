---
"@metistry-apps/console": patch
"@metistry-apps/macos": patch
"@foldedspacelabs/metistry-cli": patch
---

**A routine's Activity subject is its display name, not its raw component id (ruled at the W2 checkpoint, ruling 25, X-21).** `activity_feed`'s `routine_run` subject was `r.component` verbatim — the runner's own slug (`plan-tomorrow`, `knowledge-fold`) — which every client's Title Case pass already left alone, since a hyphenated id reads as an identifier, not composed prose. The runner (`apps/console/src/runner.ts`, `close-day.ts`) now stamps `meta.display_name` on every `routine_run` row from the manifest it already has loaded — the same word Scheduled shows — and the query reads it: `plan-tomorrow` reads `Tomorrow's Plan`, `knowledge-fold` reads `Knowledge Fold`. `actor` is unchanged. A row written before this stamp existed falls back to `initcap(replace(component, '-', ' '))`, the same identifier-to-title transform the console's own `titleOf` gives a New Routine with no manifest.

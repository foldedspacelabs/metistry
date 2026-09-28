---
"@metistry-apps/console": patch
"@metistry-apps/macos": patch
"@foldedspacelabs/metistry-cli": patch
---

**A routine's Activity subject is its display name, not its raw component id (ruled at the W2 checkpoint, ruling 25, X-21).** `activity_feed`'s `routine_run` subject was `r.component` verbatim — the runner's own slug (`plan-tomorrow`, `knowledge-fold`) — which every client's Title Case pass already left alone, since a hyphenated id reads as an identifier, not composed prose. The query now hands back `initcap(replace(component, '-', ' '))` instead: `plan-tomorrow` reads `Plan Tomorrow`, `knowledge-fold` reads `Knowledge Fold`. `actor` is unchanged. `activity_feed` has no manifest to read a routine's actual configured `display_name` from (Postgres carries none), so this is the same identifier-to-title transform the console's own `titleOf` already uses for a routine with no manifest — close enough for every built-in routine but the one or two whose display name reorders its words.

---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/routines": patch
"@metistry-apps/console": patch
---

**One request type table, in core — and `action` reads *action*.** Every
request in Needs You is a `proposals` row with a free-text `kind`; the owner
reads one of twelve types instead (`docs/product/glossary.md`).
`packages/core/src/requests.ts` is now the only place that says which: stored
kind → type, the type's body from the closed set (choices · diff · thread ·
before and after · preview · to-dos · excerpt), its primary verb, Revise and
Decline, and the decisions each stores (`describeRequest`). It replaces the
two copies that had drifted — the CASE in `pending_requests` and the morning
brief's own map, both of which called an agent's `action` a *note* (C80).

The brief imports the table. The query cannot import TypeScript, so it
carries the table's `requestWordSql()` rendering verbatim, and the console's
seed-query tests refuse any other text, run the query over every stored kind
against the table, and read every `INSERT INTO proposals` in the product so a
new writer cannot add a kind the table does not map. A kind the table does
not know reads as a *report* drawn as an excerpt with Dismiss its only answer
— never as the raw kind, and never with an Approve whose meaning nobody
reviewed. `pending_requests`' title fallback now says the owner's word too
(*note request*, not *knowledge request*).

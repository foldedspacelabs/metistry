---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/console": minor
---

The owner's three knowledge reads (T1-6): `GET /api/knowledge/fold?date=` (the newest `Journal/Fold/YYYY-MM-DD.md` on or before a day — newest by the date in its name — and its outgoing links, a link to a draft or conflict dropped), `GET /api/knowledge/drafts?limit=&offset=` (every `status: draft` note, never a conflict) and `GET /api/knowledge/areas` (each area's `<area>/README.md` description, settled page count, last change, and whether the newest fold names it). Each is a new `expose: route` named query — `knowledge_fold_latest`, `knowledge_drafts`, `knowledge_areas` — and each route refuses every principal but the owner itself, before any SQL runs, so a draft is never reachable at the generic `/api/q/<name>` door or through `/mcp`. Core marks the three client-API rows served.

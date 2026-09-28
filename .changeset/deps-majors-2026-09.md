---
"@foldedspacelabs/metistry-connections": patch
---

**Builds against the dependency majors from #386** (`@types/node` 26, vitest 5, chokidar 5, `@simplewebauthn/*` 14). The only source change is a typing one in `connections`: an errno `code` carried onto a stdio child's failure is copied through a local, because `@types/node` 26 no longer lets an optional `code` be assigned to another under `exactOptionalPropertyTypes`. Behaviour is unchanged.

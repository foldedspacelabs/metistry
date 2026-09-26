# The console's API — moved

This document became **[`client-api.md`](client-api.md)** (F-1): one contract
for every client — the Mac app, the PWA and a future phone — with every route's
reach, principals, body, errors, idempotency, cursor and `409` semantics, the
closed action set, what the Mac does outside the API, and the live-changes
catalogue. Its route table is `packages/core/src/client-api.ts` as data, and
tests hold the two together.

Every section that was here moved there, route by route:

| Was here | Is now in `client-api.md` |
| --- | --- |
| `GET /api/identity`, `capabilities` (S1) | Bootstrap |
| Approve-before-enroll (S2), grants, autonomy | Agents — the registry |
| `Idempotency-Key` on `POST /capture` | The agent surface |
| `409` for a settled decision, `if_unchanged`, `accept_as_work`, `allow` on an `action`, `POST /api/proposals/batch` | Needs You |
| A refusal names the field that would permit it | The rules every route keeps — Errors |
| `since` cursors | The rules every route keeps |
| `GET /api/runs/export`, `GET /api/runs/:id` | The ledger |
| `GET /api/instances`, `GET /api/commands` | Registries the clients read |
| The task routes | Work — the board and dispatch |
| `/api/compute*` | Compute |
| `GET /api/q/<name>` | The named queries |
| `/api/knowledge/*` | Knowledge |

Links into this file from older documents and code comments still land here;
follow them one step on.

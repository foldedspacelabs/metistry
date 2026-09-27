---
"@metistry-apps/console": patch
---

C45 at every consequential door of `POST /api/proposals/:id`: an answer whose
consequence is refused or fails — the improvement overlay write, an action's
service call, Approve as Work's `work` row, an enrolment's approval, an access
request's grants write — leaves the request pending with `payload.error =
{code, message, decision, at}`. Before, only the action path wrote the error;
the others left the row pending but silent, and approving an enrolment whose
agent had been revoked settled it `approve` while letting nobody in (now a
`404` that stays pending). A consequence that throws stores `internal` with no
detail. `apps/console/test/c45.integration.test.ts` tests every door.

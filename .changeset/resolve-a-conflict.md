---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/console": minor
"@metistry-apps/reconciler": minor
---

Resolve a conflict (T2-10, plan §2.11). `POST /api/knowledge/conflicts/resolve
{path, keep, seen_sha}` is served: the owner keeps the note as it stands
(`mine`) or takes the sync tool's copy (`theirs`), written as `user` through
the reconciler's new `POST /vault/conflicts/resolve`, for a copy the index has
in `conflict` and nothing else. `seen_sha` is the side being given up, as the
review showed it; a mismatch, or a path not in conflict, is `409 stale` with
the conflict as it stands (`null` when there is none). The side given up is
committed before it is discarded, so history keeps it after the client's
ten-second Undo (C136); a settle refused for any other reason is written on the
conflict's review as `payload.error` (C45). The review clears at its source and
the copy's index row goes at once. The reconcile sweep now commits the deletion
of a conflict copy that history holds. Core gains `knowledgeConflictSource`
(and its two constants), the conflict mirror's subject, which the console and
the reconciler now share.

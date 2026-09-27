-- 0031_prose_feedback — a thumbs up / thumbs down on any piece of GENERATED
-- PROSE, not only a chat reply (design-build-plan §2.9, §3.3, ticket T1-12;
-- B7 of `today-hub-requests.md`, C33, open).
--
-- Why its own table, and why keyed by `runs.id`: `reply_feedback` (0013)
-- keys on `outbound_messages.id`, which only a chat reply has. A meeting
-- briefing, Next Up's one line, a revision explanation and every other
-- surface C103 allows generated prose onto have no row of their own — but
-- every one of them already logs one `runs` row for the turn that wrote it
-- ("Every model turn, bridge call, collector run, escalation, and outbound
-- message logs one row here", 0001_init). `runs.id` is therefore the one id
-- already stable and already present wherever prose is produced, so a
-- sibling table keyed on it is "one feedback signal" (B7) without a second
-- id-minting scheme and without touching `reply_feedback` or the chat route
-- it serves (`docs/ops/reply-feedback.md`). Widening `reply_feedback` itself
-- was the other option B7 named; a sibling was taken because chat's rating
-- stays keyed to the immutable message it judges, unmoved by this ticket.
--
-- DURABLE (invariant 1): the user's hand, not derived state. A rebuild from
-- collectors cannot reconstruct a rating — `runs` rows themselves are
-- operational and not part of the durable set, but the JUDGEMENT on one is,
-- exactly as 0013 reasons for `reply_feedback`. `ON DELETE CASCADE` only
-- follows the ledger row it rates; nothing here widens what `runs` itself
-- promises to keep.
--
-- ADDITIVE: one new table, no existing table touched. `CREATE TABLE IF NOT
-- EXISTS`, so applying the file twice is a no-op.
--
-- ROLLBACK NOTE: dump first (a rating cannot be recomputed) —
--   COPY (SELECT * FROM prose_feedback) TO '…';
-- then, after reverting the route (`POST|DELETE /api/prose/:id/feedback`,
-- `apps/console/src/server.ts`) and its row in `packages/core/src/client-api.ts`:
--   DROP TABLE IF EXISTS prose_feedback;
-- No view, index elsewhere or other table references it.

CREATE TABLE IF NOT EXISTS prose_feedback (
    id        bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    prose_id  bigint      NOT NULL REFERENCES runs (id) ON DELETE CASCADE, -- durable: the `runs` row that produced this prose — the one id every surface already logs
    rating    smallint    NOT NULL CHECK (rating IN (-1, 1)),              -- durable: -1 = 👎, 1 = 👍
    note      text,                                                       -- durable: the user's one line on a 👎
    ts        timestamptz NOT NULL DEFAULT now(),                         -- durable: when it was rated, not when the prose was produced
    UNIQUE (prose_id)
);
CREATE INDEX IF NOT EXISTS prose_feedback_ts_idx ON prose_feedback (ts DESC);
-- a future weekly pass, mirroring the reply-quality one, reads the negatives only
CREATE INDEX IF NOT EXISTS prose_feedback_negative_idx ON prose_feedback (ts DESC) WHERE rating = -1;

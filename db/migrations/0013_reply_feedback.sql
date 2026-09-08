-- 0013_reply_feedback — a thumbs up / thumbs down on any reply the system
-- sent, and the loop that acts on it (docs/ops/reply-feedback.md).
--
-- Its own table on purpose: `outbound_messages` is the record of what was
-- said and stays immutable. Feedback is a later, separate judgement by the
-- user — one per message, revisable, deletable — so it gets its own row
-- with its own timestamp. Durable: this is the user's hand, not derived
-- state; a rebuild from collectors cannot reconstruct it (invariant 1).
CREATE TABLE reply_feedback (
    id                  bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    outbound_message_id bigint      NOT NULL REFERENCES outbound_messages (id) ON DELETE CASCADE, -- durable
    rating              smallint    NOT NULL CHECK (rating IN (-1, 1)),  -- durable: -1 = 👎, 1 = 👍
    note                text,                                            -- durable: the user's one line on a 👎
    ts                  timestamptz NOT NULL DEFAULT now(),              -- durable: when it was rated, not when the reply was sent
    UNIQUE (outbound_message_id)
);
CREATE INDEX reply_feedback_ts_idx ON reply_feedback (ts DESC);
-- the weekly self-heal pass reads the negatives only
CREATE INDEX reply_feedback_negative_idx ON reply_feedback (ts DESC) WHERE rating = -1;

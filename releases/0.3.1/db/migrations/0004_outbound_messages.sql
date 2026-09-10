-- 0004_outbound_messages — replies and proactive sends. The thread view
-- merges inbound + outbound; the console's notifier loop pushes new rows
-- (web push, §4.9). notified_at marks delivery-attempted, not delivered.
CREATE TABLE outbound_messages (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ts          timestamptz NOT NULL DEFAULT now(),
    thread      text        NOT NULL DEFAULT 'default',
    text        text        NOT NULL,
    in_reply_to bigint REFERENCES inbound_messages (id),
    kind        text        NOT NULL DEFAULT 'reply', -- reply | ack | brief | alert
    notified_at timestamptz
);
CREATE INDEX outbound_messages_thread_idx ON outbound_messages (thread, ts DESC);
CREATE INDEX outbound_messages_notify_idx ON outbound_messages (ts) WHERE notified_at IS NULL;

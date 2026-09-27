-- 0034_calendar_events — every calendar source's events in one table, and
-- each source's sync bookkeeping (design-build-plan §2.9, §2.10; ticket
-- T2-11; today-hub-requests A1).
--
-- Today, Next Up and a meeting's note all ask the same question — what is on
-- the owner's calendar, and who is in it — and the answer must not depend on
-- WHICH calendar holds the meeting. So every source syncs here: the eventkit
-- sync now (`collectors/eventkit-calendar`), ICS, CalDAV and Google later
-- (T4-12…T4-14), each under its own `connection`. `day_events` reads one day
-- of it for every source at once; nothing reads a calendar any other way.
--
--   * `calendar_events` — one row per OCCURRENCE: `event_id` is the source's
--     key for this one meeting (for EventKit, the identifier plus the
--     occurrence's original date when it recurs — packages/mcp-eventkit
--     `eventKey`), so a Monday standup's note is that Monday's. `series_id`
--     ties a recurring event's occurrences together ("last time", B3);
--     `ical_uid` is the iCalendar UID the same meeting carries in every
--     source. `attendees` is a JSON array of
--     `{name, email, status, role, type, self}`, the address lowercased with
--     any `mailto:` dropped — the normalisation `people_emails` (0029) stores,
--     so `day_events` joins an attendee to a person page on equality and
--     nothing else. `organizer` is the organizer's address, normalised the
--     same way. `self_status` is the owner's own answer, null when there is
--     nobody to answer.
--   * `all_day` is not in §2.9's column list and is here because the Today
--     fixture (F-7, `get-api-today.json`) serves it on every event and it
--     cannot be derived: an all-day event's instants are midnight in the
--     calendar's zone, which the row does not carry.
--   * `sync_state (connection, key, value)` — whatever a source needs to
--     resume: the window it last read, an ETag, a CalDAV sync-token, a
--     Google `nextSyncToken`. Opaque text per key.
--
-- NOT HERE, deliberately: the invite body (`notes`). It carries dial-in codes
-- and confidential agendas, and the rule is that it never reaches an agent.
-- Postgres is read by every named query, and a column no query selects today
-- is one a query can select tomorrow — so the body has no column, and no sync
-- can store one.
--
-- DURABILITY — DERIVED IN FULL (invariant 1). Every row comes back from the
-- calendars themselves: `docker compose down -v`, rebuild, one pass of each
-- sync, and the window each sync reads is back exactly. What is lost is the
-- past beyond the window (a sync reads forward), which is the "minus
-- historical trend lines" invariant 1 allows — the notes a past meeting has
-- are in the vault, which is the record. `sync_state` is a cache of where
-- each source got to; losing it costs one full read.
--
-- ADDITIVE (CLAUDE.md, migrations are additive-first): two new tables, no
-- column rewritten, no existing row touched. Every statement is
-- `IF NOT EXISTS`, so applying the file twice is a no-op the second time even
-- outside the runner's own bookkeeping.
--
-- ROLLBACK NOTE: `DROP TABLE IF EXISTS calendar_events, sync_state;` — after
-- reverting the eventkit sync (collectors/eventkit-calendar), `day_events`,
-- `calendar_event` and `POST /api/meetings/:event_id/note`'s read of them.
-- Nothing references either table — no foreign key in or out, the reasoning
-- 0029 gives — and the next sync after a re-apply fills both again.
--
-- INVARIANT 3: a sync writes its own rows, as `github-state` writes `work`;
-- every READ is a named query in `seed/queries/` run by `packages/queries`.

CREATE TABLE IF NOT EXISTS calendar_events (
    connection  text        NOT NULL,                     -- derived: the source — `eventkit`, or a connection's name (§2.6)
    event_id    text        NOT NULL,                     -- derived: the source's key for this one occurrence; opaque, case-sensitive
    ical_uid    text,                                     -- derived: the iCalendar UID, shared by every occurrence and every source of one meeting
    series_id   text,                                     -- derived: the recurring series this occurrence belongs to; null for a one-off
    starts_at   timestamptz NOT NULL,                     -- derived: the occurrence's start, as the source has it now (moved or not)
    ends_at     timestamptz NOT NULL,                     -- derived: its end
    all_day     boolean     NOT NULL DEFAULT false,       -- derived: an all-day event (see the header — the F-7 fixture's field)
    title       text        NOT NULL DEFAULT '',          -- derived: the event's title
    location    text,                                     -- derived: where; null when the source says nothing
    organizer   text,                                     -- derived: the organizer's address, lowercased, no mailto:
    attendees   jsonb       NOT NULL DEFAULT '[]'::jsonb  -- derived: [{name, email, status, role, type, self}], email normalised as people_emails'
                CHECK (jsonb_typeof(attendees) = 'array'),
    self_status text                                      -- derived: the owner's own answer; null when there is nobody to answer
                CHECK (self_status IS NULL OR self_status IN ('unknown', 'pending', 'accepted', 'declined', 'tentative', 'delegated', 'completed', 'in_process')),
    updated_at  timestamptz NOT NULL DEFAULT now(),       -- derived: when the sync last CHANGED this row (an unchanged read leaves it)
    PRIMARY KEY (connection, event_id)
);

COMMENT ON TABLE calendar_events IS
  'Derived in full: one row per event occurrence, from every calendar source (plan §2.9, T2-11). Rebuilt by each source''s sync; never holds an invite body. Read only through day_events and calendar_event.';

-- "What is on this day" — every source at once, by time.
CREATE INDEX IF NOT EXISTS calendar_events_starts_idx ON calendar_events (starts_at);
-- "This event, whatever its source" — the meeting note's door has an id and no connection.
CREATE INDEX IF NOT EXISTS calendar_events_event_id_idx ON calendar_events (event_id);

CREATE TABLE IF NOT EXISTS sync_state (
    connection text        NOT NULL,                 -- derived: the source, as calendar_events.connection spells it
    key        text        NOT NULL,                 -- derived: what this value is (`window_start`, `etag`, `sync_token`, …)
    value      text        NOT NULL,                 -- derived: opaque to everything but the sync that wrote it
    updated_at timestamptz NOT NULL DEFAULT now(),   -- derived: when it was written
    PRIMARY KEY (connection, key)
);

COMMENT ON TABLE sync_state IS
  'Derived: where each source''s sync got to — a window, an ETag, a sync token (plan §2.9, T2-11). Losing it costs one full read.';

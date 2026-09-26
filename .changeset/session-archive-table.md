---
"@foldedspacelabs/metistry-cli": minor
"@metistry-apps/console": minor
---

The session archive table (migration `0030_session_archive.sql`, ephemeral — a
30-day cache in Postgres, lost on `docker compose down -v`): one row per turn
of every session, chat included — the system prompt as sent, the messages,
and the tool calls with arguments and results, redacted (the writer is
T3-9). The seed gains `session_detail` (`expose: route`): a session's turns
in full, oldest first, filterable to one `turn_id`, with expired rows never
returned — Run detail's conversation (`GET /api/sessions/:id`, T2-17).

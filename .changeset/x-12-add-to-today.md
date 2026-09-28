---
"@metistry-apps/console": patch
"@foldedspacelabs/metistry-core": patch
---

**`POST /api/today/add` — Add to Today (ruled 2026-09-27, ruling 11; X-12).** A
route for the mirrored `task` request's primary answer (`sends: {door:
"today"}`): `{key, date?}` captures the named work item's task line onto the
owner's current day, through T4-24's own service
(`addIssueToToday`/`collectors/linear/today.ts`) unchanged — a Linear issue is
the one kind wired today. Idempotent by the issue: a second call for the same
key returns the first capture. `date`, left out, is the owner's current day
in `METISTRY_TZ`; given, it must equal that day exactly, or the request is
refused `400` naming the window — this door only ever adds to Today, never an
arbitrary date. Additive; `api_version` stays 1.

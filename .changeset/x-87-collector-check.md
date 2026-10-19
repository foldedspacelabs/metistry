---
"@foldedspacelabs/metistry-cli": minor
"@foldedspacelabs/metistry-connections": minor
"@metistry-apps/collectors": minor
---

X-87: every collector exports `check()`, and `metistry doctor` asks it. The ten
that had none (the Google, ICS, CalDAV and EventKit calendars, Linear, GitHub,
mail, AWS costs, Claude usage and the inbox sort) report cheap, local-first
state: configuration and credential presence, the connection they read opened
through the console's own opener, and — where the shared connection check dials
that kind of connection — its verdict, never a full sync and never a billed
call. Doctor loads each collector's compiled entry (a build or a release pack)
and lays the verdict over that collector's one row; a module that will not
load, or a `check()` that throws, hangs or answers something that is not the
`check()` shape, is a `failed` row and the rest of the report still runs. One
CI test holds the convention for every collector manifest, with no allowlist.
A connection check's refusal now carries its code as `meta.refused`.

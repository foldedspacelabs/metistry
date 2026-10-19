---
"@foldedspacelabs/metistry-cli": minor
"@metistry-apps/console": minor
---

HS-7: `metistry connect --remove <tool>` undoes what `connect` wrote, and a
revoked tool can be connected again. `--remove` revokes the tool's row first
(if the console is down nothing else is touched), puts its config file back
exactly as `connect` found it — `connect` now keeps a copy beside the file the
first time it writes (`<file>.<key>.bak`, same mode), and removal writes those
bytes back, or removes only its own entry if the file has changed since, or
deletes a file it created — then deletes the Keychain item. Other servers in
the file are never touched, and running it twice is safe. `POST /api/agents`
now registers a revoked `external` row again in place (same id and
provenance, a new token, grants, projects and autonomy back at default-deny);
a live row, or a revoked internal or crew row, is still a 409. `connect
<tool>` on a revoked row uses it instead of refusing.

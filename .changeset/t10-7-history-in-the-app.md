---
"@metistry-apps/macos": minor
---

**History in the app (T10-7).** Settings ▸ Instance gains *History*: the vault's sync policy in force, ahead and behind, the last commit, the last push and pull (a failed one with git's own line), any conflict holding the sync — and **Roll Back…**, a sheet that chooses the last commit, one commit or a day, asks in Needs You (`POST /api/vault/rollback`), and names what Approve would undo, commit by commit and file by file. A Knowledge page gains its history — who made each commit, when, what it did, each version on request under the name it had then — and **Restore**, which raises the Needs You request and writes nothing; the request is drawn on the page with the Needs You card itself, so answering it there answers it in Needs You. Restore and Roll Back are reach `local` (ruling 7): neither is drawn, or sent, unless `GET /api/whoami` says this client is the local owner token, and a `local_only` answer takes the control away.

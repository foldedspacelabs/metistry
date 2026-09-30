---
"@foldedspacelabs/metistry-cli": patch
"@metistry-apps/watchdog": patch
---

`metistry connect-repo` now files the push credential with a background-readable Keychain access list every time: it deletes any existing internet-password item for the host and account, then adds with `-A` (never `-U`, which kept the access list of an item `git-credential-osxkeychain` had created — so the supervisor's headless read was refused and every reconciler push failed with "could not read Username"). The token is stored before anything reaches the remote, and connect-repo's own `ls-remote` and push run with `-c credential.helper=` and `GIT_ASKPASS` instead of the osxkeychain helper. The supervisor now tells "no login Keychain item" apart from "item exists but its access list refuses a background read", and `metistry doctor`'s vault sync row names that cause and the fix (`metistry connect-repo <url> --force`).

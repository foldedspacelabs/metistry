---
"@foldedspacelabs/metistry-cli": patch
---

`metistry secrets sync --to env` no longer re-mints `METISTRY_LOCAL_OWNER_TOKEN` or `METISTRY_BRIDGE_TOKEN_RECONCILER_USER` over a running install: when one is missing from the Keychain but `.env` already holds a value — the one the running console or reconciler was started with — it is adopted into the Keychain and the `.env` line is left byte-for-byte; a token is minted only when neither store has one. Whenever a run does change a token a running service holds (a mint, or the Keychain's value replacing a differing line), it probes whether the console/reconciler is up and says `RESTART NEEDED … run \`metistry restart console|reconciler\``, never silently. `metistry doctor`'s console row, on a 401 with `.env`'s owner token, now names the restart as the fix rather than another sync.

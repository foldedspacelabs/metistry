---
"@foldedspacelabs/metistry-cli": minor
"@metistry-apps/reconciler": minor
"@metistry-apps/console": patch
"@foldedspacelabs/metistry-core": patch
---

**The assistant's identity is the owner's to change, and every protected write is on the record (T2-16).** `metistry identity set [--name] [--mention] [--mark] [--dry-run] [--json]` (M10) changes `.metistry/identity.yaml` through the protected write — the reconciler as `user`, with the owner bearer. Every field is validated before anything is read or sent (a one-line name of at most 40 characters with no `{{`/`}}`, an `@kebab` mention, a single-glyph mark), the edited text is read back before it goes, and a refusal writes nothing. Only the changed lines are rewritten, so comments and `voice: >` keep every byte. The mark is the file's existing `icon:` key; a new name brings its mention along when the mention was the one `init` derived. The reconciler now records every protected-path write, delete and rename it accepts as a finished `config_write` run (`meta {path, op, from?, caller, principal, message}`), whichever door made it, and `activity_feed` shows those rows in the `run` group with the principal as actor — so a rename appears in Activity. The fixture recorder seeds one, and `get-api-q-activity_feed.json` is re-recorded.

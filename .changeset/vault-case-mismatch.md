---
"@metistry-apps/reconciler": patch
"@metistry-apps/console": patch
"@foldedspacelabs/metistry-cli": patch
---

**A product file spelled in another case is named, and renamed.** `GET /vault/read` for `Me/profile.md` when the file is `Me/Profile.md` answered `invalid_request`, and the runner logged *could not be read (invalid request)*. Reads stay case-exact, but that is now `404 not_found` with `{"hint": "Me/Profile.md exists — the product's name is Me/profile.md"}`, which the console's client and the runner's log line carry. `metistry update` gains a **vault case** step that renames every `seed/vault/` file the vault has under another case only to the seed's spelling — two renames through a temporary name, each its own commit, through the reconciler as `user` — and `metistry doctor`'s **vault case** row lists any it finds, with the fix.

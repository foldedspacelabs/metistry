---
"@foldedspacelabs/metistry-core": minor
"@foldedspacelabs/metistry-cli": minor
"@foldedspacelabs/metistry-mcp-brain": minor
"@metistry-apps/reconciler": minor
"@metistry-apps/console": minor
"@metistry-apps/assistant": minor
---

**The instance directory is the Obsidian vault.** Open the folder `metistry
init` made and your notes are right there — `Journal/`, `Me/`, `Inbox/`,
`now.md` — with nothing of the machinery in the way. Everything that is not
knowledge moved into `.metistry/`: identity, rules, compute, the config
directories, the lock, and the derived `state/` that holds Postgres, the
`.env` and downloaded models. Obsidian ignores dot-prefixed folders, which is
the whole reason for the dot — the vault root and the install's own files can
finally be the same directory without one of them cluttering the other.

Vault paths lose their prefix with it: a note is `Areas/Fsl/Drey.md`, a
capture is `Inbox/…`, and a read grant covering everything is spelled `/`.

**The protected set became a place rather than a list.** Anything under
`.metistry/` is the user's hand alone — except `.metistry/state/`, which is
derived and nobody's record — plus the root `CLAUDE.md` and `README.md`.
That is one rule the reconciler enforces at the tool, instead of seven
filenames each component had to remember. Neither those two root files nor
`Artifacts/` are indexed as knowledge: your instructions and your bundles are
yours to read, not search results.

This ships the layout for NEW instances. An existing instance keeps working
unchanged and `metistry doctor` now says which shape it is in; the verb that
moves one is the next change.

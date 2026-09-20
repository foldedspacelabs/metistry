---
"@foldedspacelabs/metistry-cli": patch
---

`metistry init` now stamps the daily-flow journal tree — `Journal/` and its
`Plan/`, `Fold/`, `Standup/` and `Meetings/` subfolders, `Templates/` with
the six seeded templates (Daily, Meeting, Plan, Standup, Fold, Weekly), `Me/`
with a `profile.md` and `Working Style.md` carrying honest placeholders, and
empty `People/` and `Projects/` — into every new instance
(`docs/product/daily-flow-spec.md` P1-8). All six templates ship
`source: user`, so the assistant can never overwrite them, and a re-stamp
(`--force` onto an existing instance) never clobbers a template or a `Me/`
page you have since edited: only what is genuinely missing gets filled in.

---
"@foldedspacelabs/metistry-cli": minor
---

`.metistry/state/.env` is derived, never hand-edited (X-124; owner ruling
2026-10-04, "M7 reversed — a self-managing instance"). `metistry up` renders
the whole file from `.metistry/*.yaml` and the login Keychain — once per run,
after every mint and before compose or a launchd job reads it — under a header
carrying the sha256 of its body, and renders the jobs from the same values.
`secrets sync --to env` is that render. Three sections, each sorted:
`derived` (what yaml decides; a differing value the file had is named as
superseded), `keychain` (every secret-shaped variable from this instance's
account — a line the Keychain lacked is adopted into it first, never minted
over — plus the `METISTRY_SECRET_*` deliveries, now computed the same way by
`up` and `sync`), and `carried` (every other line the file held, with the
right-hand side it had, because nothing in `.metistry/*.yaml` decides it yet;
on a host without a Keychain the secret lines are carried too). Two renders
from the same yaml and Keychain are byte-identical. The previous file is kept
beside the render as `state/.env.pre-render` (0600) whenever it was not a
clean render. Doctor gains an `env` row: `pre-render` (a hand-written file
from before this release — `metistry up` derives it), `hand-edited` (the
header's hash no longer matches; the changed, added and removed lines are
named from `state/env-render.json`, which holds names and line hashes, never a
value; the fix is `metistry up`, which adopts an edited secret into the
Keychain, keeps an edited configuration line, brings back a removed line a
store still holds, and names each), and the values a render stopped
honouring. An in-place CLI write (`secrets mint`, the recorder tokens, the
owner bearer, `retire-legacy-env`, `migrate-layout`) re-stamps a rendered
file, so only a hand reaches `hand-edited`. A product checkout's `.env` (an
install with no instance directory) is not derived: it is the deprecated
environment `secrets retire-legacy-env` retires.

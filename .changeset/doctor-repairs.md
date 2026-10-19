---
"@foldedspacelabs/metistry-cli": minor
---

`metistry doctor` repairs what it finds (X-123). Every row is classified in
code — `fixable` (doctor does it), `hand` (the owner does it; the row names
the exact step) or `info` (a fact) — and a bare `doctor` in a terminal applies
every fixable row's fix from a closed table of existing audited services
(`metistry restart`, the migration runner under the advisory lock, `up`'s
render, `update`'s template, vault-case and migrate-scope steps, the cli shim,
`migrate-layout`, `migrate-inbox`), asks once per fix that moves files or
restarts a running service (`--yes` skips the question; never the default),
re-checks once and prints before → after. `--check` is read-only (what `up`,
`update`, CI and the Mac app run; `update`'s child doctor passes it
explicitly), `--fix` repairs without a terminal, and a bare `doctor` with
nobody to ask is `--check`. A restart-class fix is tried once per
`METISTRY_DOCTOR_RESTART_WINDOW_MIN` (30) — the fix log,
`<instance>/.metistry/state/doctor-fixes.jsonl` (0600; names, never a value),
is the evidence. `--json` adds `mode`, per-row `fix` and `fixed`, `repair` on
a fixable row, and `fixes[]`. The migrations row no longer says `pnpm
db:migrate` (a release install has none): doctor applies them. The
local-model default-port scan (LM Studio 1234, Ollama 11434) is skipped once
`compute.yaml` names the instance's own on-machine provider; `compute models
list` still asks for it. The console-401 button is now the restart the row's
own words name, not `secrets sync --to env`.

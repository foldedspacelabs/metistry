---
"@metistry-apps/macos": minor
---

**Settings → Compute, and the local model server in the menu bar.** The Mac app
gains a seventh Settings pane over `metistry compute …` — providers (add from a
template with the API key on **stdin**, test, remove, a non-ZDR badge on
anything off this machine that claims no zero data retention), assignments
(`default`, each tier, each `crew:<name>` — a model picker fed by `compute
models list --provider`, effort as a segmented control), budgets (the
instance's and each provider's: daily, monthly, `allow|stop|critical_only`), and
a local-models section reading doctor's `local:lmstudio|ollama|llamaserver|applefm`
rows with install, load/unload and a RAM figure labelled an estimate. Every
control is one `metistry compute` verb with `--json`; the pane persists nothing
(`compute.yaml` is the record) and re-reads on open. The add-a-provider sheet is
the **wizard's own step 7 model**, so the key's single path to a child process's
stdin is still one function. `assistant: absent` is shown where it can be acted
on, quoting doctor's remediation, with one button — or none, where nothing one
click could do would fix it.

Two menu-bar changes come with it: the supervisor's children (`llamaserver`) are
listed under **Services** with the same Restart · Stop · Start · View Log,
because `metistry restart llamaserver` is the same four verbs a launchd job
gets; and the `apple-fm` bridge row reads `serves foundation-model` once
`compute.yaml` declares a provider that dials it.

No CLI change was needed — every verb already had `--json`. One reader-side
fact did: these verbs narrate through the same stream the JSON goes to, so the
app now reads the **trailing** object out of prose-then-JSON stdout, in one
place with a test. `applefm` joined the app's template list, which the CLI had
had since the Apple FM provider landed.

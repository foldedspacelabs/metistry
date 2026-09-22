---
"@metistry-apps/collectors": patch
"@metistry-apps/console": patch
"@metistry-apps/eval": patch
---

**Captures the rules cannot place are triaged by intent, locally, with the
decision in `rules.yaml`.** `scoreChoice()` lands beside `completeJson()` —
same provider resolution, same money rule, different request fields — and
`inbox-drain` gains a third tier between its rules and its JSON-schema tier:
one scored answer token over the closed intent enum, on-device, with a
confidence. The model supplies a fact; a table in the collector and a threshold
in the owner's own `.metistry/rules.yaml` decide what happens about it. Every
verdict lands on the proposal and in a `runs` row, including the discarded
ones. Both halves must be configured — a model in `compute.yaml`, a threshold
in `rules.yaml` — and with either missing the drain is byte-identical to the
build before this existed, which is a test rather than a promise.
`metistry-eval intents` scores the owner's own labelled messages and **fits**
the threshold to the pre-registered bar instead of anybody choosing one.

---
"@foldedspacelabs/metistry-core": minor
---

**An intent enum and answer-token scoring, both closed and both decided in
code.** `INTENTS` joins `ACTION_KINDS` as a closed list a reviewer can read —
sixteen things a message can *say*, each with the description the model is
actually shown, and one-token letter codes GENERATED from the list rather than
written down beside it. `choice.ts` adds the technique: constrain the answer to
one token, ask for `top_logprobs`, renormalise over the closed alphabet, and
compute TypeSafe's published confidence statistic `(n·peak − 1)/(n − 1)`. It
decides nothing — no tier, no model, no field that could hold one — and the
per-server request shapes it builds were each measured rather than read off a
README. Also here: `intentGuard`, a deterministic out-of-distribution check
that runs *before* any request (an English classifier has been measured at
0.000 accuracy and 0.952 confidence on out-of-script input, so confidence
gating cannot catch it), `rules.yaml`'s `intent:` schema, which fails at LOAD
on a threshold outside [0,1] or an intent this build does not know, and
`assignments.intent` in `compute.yaml`, which is refused at load unless its
provider is on-machine and never falls back to `assignments.default`.

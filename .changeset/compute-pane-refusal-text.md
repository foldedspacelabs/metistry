---
"@metistry-apps/macos": patch
---

The Compute pane's refusal reads the CLI's own reason again. Most `metistry compute …` verbs answer a failure by returning a pretty-printed `--json` object on stdout (`{"ok": false, …, "detail": "<why>"}`) rather than throwing, and the pane's fallback — "the last line of stdout" — was the closing `}` of that object, not the reason. `CLIDegradation.refusalMessage` (`cli-facts.swift`) now reads the trailing JSON first (an `error.message`/`error.code` envelope, or the bare `detail`/`error` string these verbs print) before falling back to the last non-empty line of stderr, then of stdout; `ComputeModel.refusal` and the wizard's `ComputeStepModel.reason` both call it, so a provider test, a model install/load and the wizard's step 7 all show the same thing.

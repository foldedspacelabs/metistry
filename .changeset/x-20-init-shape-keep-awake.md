---
"@foldedspacelabs/metistry-cli": patch
---

**`init --shape` and `--keep-awake`'s contract, written down (X-20, ruling 23).** `metistry init`'s `--shape` now decides the deployment shape THIS
instance targets — `launchd` on macOS, `compose` elsewhere, when it is not given — rather than only shaping the printed `.env` lines while the actual
decision quietly came from the product's own `seed/deployment.yaml`. `--keep-awake`'s answer is now recorded against that same resolved shape, never the
seed's. Because the `compose` shape installs no supervisor to hold a keep-awake assertion, `metistry init --keep-awake` is now refused outright when the
resolved shape is `compose` — recording a setting that can never be honoured would be worse than the honest "not configured" an unanswered question
leaves. Docs updated in `docs/ops/cli.md` and `docs/ops/deployment-shapes.md`.

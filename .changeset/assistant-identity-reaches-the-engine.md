---
"@metistry-apps/assistant": patch
"@metistry-apps/console": patch
"@metistry-apps/reconciler": patch
"@foldedspacelabs/metistry-cli": patch
"@foldedspacelabs/metistry-core": patch
---

**The assistant now uses your `identity.yaml` on the launchd shape, instead
of the seed identity that ships with the product.** Every `*_FILES` overlay
default resolved its instance half relative to the process's working
directory, and every launchd job's working directory is the product
checkout — so `.metistry/identity.yaml`, `rules.yaml` and `compute.yaml`
named the product's own directory, found nothing, and the engine ran on the
seed. `METISTRY_INSTANCE_DIR` was not in the engine's environment allowlist
either, so it could not have resolved them itself.

Fixed at the root: `metistry up` puts `METISTRY_INSTANCE_DIR` and
`METISTRY_SEED_DIR` in every child's environment (the plists' env dicts and
the supervisor's child specs alike), and core's `overlayFiles` resolves every
default against the instance directory through `resolveInstanceLayout` — so
it finds the file whether the instance has run `metistry migrate-layout` or
not. The assistant, the console and the reconciler all read their overlays
through it, which also means the console's router and the engine can no
longer disagree about which `rules.yaml` is in force.

The engine **refuses to start** when neither `METISTRY_INSTANCE_DIR` nor
`METISTRY_IDENTITY_FILES` is set, rather than answering under the seed's
name. `ops/sandbox/assistant.sb` grants read on the four config files by
name (never on the directory holding them, which on an unmigrated instance
is the vault root), so the reads the overlay now performs are permitted and
nothing else in the instance is.

Also: `metistry update --version <x.y.z>` was ignored — `version` was listed
as a boolean flag, so the value never arrived and the latest release was
installed instead. And in git mode `update` wrote the **pre-pull** version
into `metistry.lock`; the version is now read from the checkout after the
pull, so a run that fast-forwards onto a new release pins that release.

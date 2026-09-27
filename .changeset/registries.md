---
"@foldedspacelabs/metistry-core": minor
"@foldedspacelabs/metistry-cli": minor
"@metistry-apps/collectors": minor
"@metistry-apps/routines": minor
"@metistry-apps/console": minor
"@metistry-apps/watchdog": minor
---

**Registries, not lists (§2.7).** Collectors, routines, targets, provider
templates and connection types load through `Registry` — built from
manifests, never from a list in code. Core adds `REGISTRY_KINDS` (the closed
list of kinds, and what an extension may do with each), `loadKind`,
`kindSources`, `extensionsDirFor`/`extensionsDirFromEnv`, `describeExtensions`,
and `unitCode`/`joinCode`: a collector's or routine's code is found in its own
package **by name**, so an extension may replace a product unit's manifest but
never supplies code, and one naming no product unit is skipped with the reason.
A new `provider` manifest kind (`type: provider` and a `provider:` block that is
`providerSchema` itself) turns `seed/compute-templates/<name>.yaml` into
`seed/compute-templates/<name>/manifest.yaml`; `COMPUTE_TEMPLATES` and
`parseTemplate` are gone — `computeTemplates()` is the registry, and
`readTemplate` takes `{ seedDir, instanceDir }`. `collectors` and `routines`
arrays are replaced by `loadCollectors`/`loadRoutines` and
`collectorCode`/`routineCode`; the console's `loadSchedules` takes loaded units,
`TargetRegistry.load(sources)` skips a bad manifest instead of throwing, and the
watchdog's `loadScheduled` reads the same registries. Every product manifest
now carries `schema: 1`. New verb: `metistry extensions list | add | remove`
(M15) — data-only, owner's hand, refused when its registry would skip the unit.
Doctor gains a `registries` row. **Upgrade note:** an owner's
`.metistry/targets/<name>/manifest.yaml` overlay without `schema: 1` is now
skipped (the product's target is in force) until the line is added.

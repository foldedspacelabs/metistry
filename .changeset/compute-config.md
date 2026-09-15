---
"@foldedspacelabs/metistry-core": minor
"@foldedspacelabs/metistry-cli": minor
"@metistry-apps/assistant": patch
"@metistry-apps/console": patch
---

**`compute.yaml` — providers, assignments and budgets in one file.** Where
work runs, what may leave the machine to get there, and what it may cost is
now configuration in the owner's hand rather than a build-time decision: any
OpenAI-compatible endpoint (a local server, OpenRouter, anything with a base
URL) is a provider, each tier and crew is assigned one pinned
`<provider>/<model>`, and a daily or monthly budget can be recorded per
provider and for the instance. A provider is configuration, not a component —
invariant 5 is met by a zod schema in `packages/core` that the CLI, CI and
the app all validate against, so adding one is a command rather than a
directory.

New verbs, all `--json` and all `--dry-run`: `metistry compute show`,
`providers list|add --from <template>|remove|test`, `models list`, `assign`,
`budget`. The file is a §4.7 protected path, so every write goes through the
reconciler as the `user` principal, and the RESULT is validated before it is
written — an edit that would produce a file the engine could not load is
refused and nothing changes. Comments and hand-written blocks survive every
edit. `providers add` reads the API key from stdin into the login Keychain
under the user account and cannot take it as an argument or print it.

Every rule the schema enforces refuses with the field that would permit it: a
model must be one pinned `<provider>/<id>` whose provider is declared in the
same file (no `/auto`, no fallback lists — the router is deterministic), an
off-machine provider must declare a data policy, a budget needs a limit, and
`auth.secret` is a name a pasted key cannot match. The console and the
assistant both hot-reload the file; an invalid save keeps the last good
configuration and writes one `runs` warning row instead of taking a running
install's assignments away.

Nothing dials a provider, counts a token or enforces a budget yet — the
engine is the next change. Until an instance writes `assignments:`,
`rules.yaml`'s `tiers:` is still the live map, and the seed's `compute.yaml`
ships commented out so no existing install routes differently. New:
`docs/ops/compute.md`.

---
"@foldedspacelabs/metistry-cli": patch
---

The release's darwin packs are signed under the Developer ID when the
signing secrets are set: `metistry-runtime-deps` carries Node, Postgres
and git under Folded Space Labs (Node keeps its JIT entitlements minus
`get-task-allow`, and the build proves the signed node starts), so the
supervisor's Login Item on a `metistry update` install is attributed to
Metistry rather than to the Node.js Foundation; and the darwin
`metistry-runtime` pack now includes the Swift TCC helper bundles
(calendar, apple-fm), built and signed in CI, so a release install has
helpers for `metistry up` to pin its bridges at — under the same
certificate and identifiers, so a grant earned by a checkout's build
survives the switch. One composite action (`.github/actions/apple-keychain`)
does the keychain import for all three darwin jobs. Without the secrets
(a fork) nothing changes.

---
"@metistry-apps/macos": minor
---

**The Mac app gains a typed client and a store for everything the owner
surface offers, and the token still never enters the app's own process.**
Phase A's non-visual half (`docs/product/app-ux-plan.md` §6): `ConsoleAPI`,
`InstanceStore`, the wire shapes, and the sidebar's pins. No views, so nothing
on screen changed yet.

**One authenticated surface, and it is still the CLI.** `docs/ops/mac-app.md`
wrote the condition for this before the code existed — "adding it is a CLI
change first: a `metistry console call <METHOD> <path>` keeps the token out of
this process entirely, which a token-printing verb would not" — and
`docs/ops/cli.md` ruled what to do once that verb shipped: "the app … use[s] it
rather than a second HTTP client". So every request is one `metistry console
call`, a request body goes on **stdin** rather than argv, and the local owner
token stays where the CLI found it. `console-sign-in-tests.swift`'s source scan
— one file uses `URLSession`, no file sets a credential header, no file names a
keychain API, no file opens a file — passes unchanged with the whole data layer
in, which is the point: the guard was not relaxed to make room for this.

**Refusals keep the words of the thing that refused.** `ConsoleError` decodes
the standard envelope and adds two cases the CLI door has and HTTP does not —
this install's CLI predating the verb, and no token or a non-loopback console,
each carrying the CLI's own sentence because it already names the fix. A `401`
is **unreachable** and a `403` is not: the console answered, and one route
declined this credential. `namedField(among:)` attributes a refusal to a field
the caller already sent, because the envelope is `{code, message}` and names
its field in prose — nothing is inferred from a sentence's shape.

**The store reports; it never infers.** Four states — loading, loaded, failed,
stale — with the console's own `as_of` beside the value, and a failed refresh
over data already on screen goes *stale and keeps it* rather than blanking a
working pane. A background refresh is a flag rather than a fifth state, so
there is nothing for a view to turn into a spinner (P2). And
`allowsDecisions` is O3 in one place: while a section is unreachable, every
decision, drag and dispatch refuses **before sending**, in a sentence.

**Both reconnect cursors, and they are not the same mechanism.** The feed's
`since` is an inclusive timestamp that de-duplicates on `(ref, ts, kind)`; the
request queue's is an opaque cursor whose page is *everything that changed*, so
a row answered on the phone leaves the queue instead of lingering in it.

**Pins are per instance.** Project, board, page, saved search or agent, in the
order they were dragged, filed in app preferences under
`pinnedItems.<instance_id>` — so the same app against a second instance never
shows the first one's sidebar, and an instance with no id yet holds them in
memory rather than under a shared key. Nothing about pinning reaches the
instance repo, Postgres or the vault.

Fifty new tests against an in-process stub console — every shape decoded from
hand-written fixtures, the envelope read back through the CLI's own stderr
render, `401` vs `403`, both cursor folds, every store transition and the pins'
round trip — with no network and no subprocess, so they run in `swift test` on
CI as they stand.

One limitation, named rather than worked around: `console call` puts the
envelope on stderr for a `>= 400` and does not print the body, so a conflict
`409`'s `reason`, `decision` and row do not survive. Phase A reads nothing that
needs them; the queue's `if_unchanged` repaint does, and the fix is one line in
the CLI rather than a second HTTP client in Swift.

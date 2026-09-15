---
"@foldedspacelabs/metistry-cli": patch
"@metistry-apps/assistant": patch
---

An instance with **no engine credential** now runs everything except the
assistant, cleanly. Under the launchd shape `metistry up` leaves the
assistant out of the supervisor's children instead of starting a process
that can only crash-loop, and prints one line saying so; `metistry doctor`
reports `assistant  absent` with the remediation and stays exit 0; the
watchdog's `assistant-drain` reports `absent` rather than alerting about a
queue nobody is draining. Captures, `inbox-drain`, tasks, search, the
console and the reconciler are unaffected — what waits is the engine's
queue, so the evening fold's turn sits in the inbox until a credential
exists. Add one and re-run `metistry up`: the child is back, with nothing
to hand-edit. The check lives in one function
(`engineCredentialPresent`), so the compute pivot's rename is a one-line
move. The compose shape is unchanged and still requires the variable.

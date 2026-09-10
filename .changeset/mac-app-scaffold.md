---
"@foldedspacelabs/metistry-cli": patch
---

The Mac app ships as a release asset. A signed, notarized `Metistry-<version>.dmg`
and an EdDSA-signed `appcast.xml` now come with every release, so the app can be
downloaded from GitHub Releases and update itself from there. Inside it: a Status
panel that is `metistry doctor` at a glance with a menu-bar glyph for the worst
fault, and a first-run flow that walks the install — locate the runtime, create
the instance, connect a GitHub repo by device flow, sync secrets to the Keychain,
bring the services up — showing the exact `metistry` command before it runs each
one. Nothing in the app talks to Postgres or git: it runs the same CLI the
terminal does.

---
"@foldedspacelabs/metistry-cli": minor
---

Prove the Docker-free macOS shape (decision 15), and settle where a bundled
install's writable product dir lives.

- **`metistry runtime install --from <Metistry.app> [--to <dir>]`** — a signed
  bundle's `Contents/Resources/metistry/` is a SEED; the product dir is a
  writable copy of it at `~/Library/Application Support/Metistry/product/`, so
  `metistry update --channel release` works on an app install exactly as it
  does on a checkout. Idempotent, verified against the pack's own
  `metistry-runtime.json` and `runtime/manifest.json`, whose sha256s land in
  `.metistry-install.json`.
- **`metistry up --namespace`** — a second instance can run on one Mac. One
  file, `<instance>/state/ports.yaml`, allocated once, carries this instance's
  launchd label suffix and an 8-port block; `up`, `doctor`,
  `restart|stop|start`, `logs` and `update` all read it.
- **The launchd jobs exec the bundled Node** when the install has one, rather
  than whatever `$(which node)` found.
- **Five fixes the live trial found**: a space in the install path broke every
  `sh -c` job (the app's default location has one); `up` now refuses a
  `state/.env` whose values `sh` would misread; the assistant's sandbox gained
  a rule for Postgres, without which the engine could never start under this
  shape; `up` waits out `launchctl bootout`'s asynchronous teardown instead of
  racing it; and a namespaced instance's ports now reach the dotenv-sourcing
  jobs and `metistry update`'s migration runner — which would otherwise have
  migrated the default install's database.
- The release runtime pack now ships `ops/sandbox/`, without which the launchd
  shape's assistant job cannot start at all.

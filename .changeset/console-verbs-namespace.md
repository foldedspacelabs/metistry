---
"@foldedspacelabs/metistry-cli": patch
---

`metistry console whoami|call|session`, `agents list|autonomy`, `runs export` and `compute cache-report|route-report` with `--instance <dir>` now reach a namespaced instance's own console port (from `.metistry/state/ports.yaml`) instead of falling back to the default install's `http://127.0.0.1:8080` and sending it this instance's owner token. `metistry update` no longer reports a host job whose kickstart failed as kickstarted.

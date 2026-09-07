---
"@foldedspacelabs/metistry-cli": minor
---

Release pipeline: a `v*` tag now builds the product's versioned artifacts on
GitHub Releases — a runtime pack per os-arch, npm packages with provenance,
container images, and `checksums.txt`. `metistry update` gains a release mode
that resolves a release, verifies its sha256 before unpacking, switches a
`current` symlink and keeps the previous release for `--rollback`;
`metistry init --channel release` writes that mode into `metistry.lock`.

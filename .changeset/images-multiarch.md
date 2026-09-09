---
"@foldedspacelabs/metistry-cli": patch
---

Release images are built for `linux/amd64` and `linux/arm64`. v0.3.0's
`ghcr.io/foldedspacelabs/metistry-*` images were amd64-only, so `metistry
update --channel release` on an Apple-silicon Mac failed at `docker compose
pull` with "no matching manifest for linux/arm64/v8". The Dockerfiles' build
stage now runs natively on the CI host (`--platform=$BUILDPLATFORM`; the
compiled output is pure JS) and only the runtime stage is per-architecture.

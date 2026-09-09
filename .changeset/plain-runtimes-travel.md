---
"@foldedspacelabs/metistry-cli": minor
---

The runtime ships with the product. A release now carries
`metistry-runtime-deps-<version>-darwin-arm64.tar.gz` — Node, a relocatable
Postgres 17 + pgvector built from source, and a minimal git — built by
`ops/release/build-runtime-deps.sh` with every version and source sha256
pinned in one file, and verified from a *moved* copy of the tree before it is
packed. `metistry update --channel release` installs it alongside the runtime
pack, and `metistry up` on the launchd shape fetches it when no Postgres
exists anywhere; both go through the same checksums.txt verification as the
product pack, and `METISTRY_RUNTIME_DEPS=0` keeps them off the network.
`METISTRY_PG_BIN` resolution finds `runtime/postgres/bin` as before, and the
reconciler's launchd job gets `runtime/git/bin` on the front of its PATH — so
a clean Mac needs neither Homebrew nor Xcode Command Line Tools.

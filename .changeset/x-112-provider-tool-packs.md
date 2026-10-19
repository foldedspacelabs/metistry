---
"@foldedspacelabs/metistry-cli": minor
---

Provider tool packs (plan §2.23, X-112). The tools a remote-access provider
needs — Tailscale's `tailscaled` + `tailscale` built from a pinned upstream
tag, the official `cloudflared` binary, the zrok CLI — are each built as their
own release asset by `ops/release/build-remote-packs.sh`: pinned by version
and sha256 in `runtime-versions.env`, cross-checked against what upstream
publishes, the licence shipped beside the binary, every Mach-O signed with
the runtime pack's rule (now one shared function in `pack-lib.sh`) and
checked for the release identity after signing. `metistry remote set
<provider>` fetches only its provider's pack, through the same verify-then-
unpack path as the runtime packs plus the pack's own manifest, into
`<product>/runtime/remote/<tool>/` — a checksum mismatch or a tampered pack
fails `set`, writes nothing and leaves `runtime/remote/` byte-for-byte as it
was; an older release is never swapped in over a newer pack. `metistry
update` moves forward every pack already there and fetches none the owner
never chose; a deps-pack unpack and a seed copy carry `runtime/remote/`
across; `METISTRY_RUNTIME_DEPS=0` keeps it off the network and the adapter
names the manual install. Nothing goes in the DMG. The adapter-facing API
(`findRemotePack`, `ensureRemotePack`, `MANUAL_INSTALL`) is in
`packages/cli/src/remote/packs.ts` for X-106, X-108 and X-113.

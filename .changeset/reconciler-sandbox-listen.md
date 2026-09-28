---
"@foldedspacelabs/metistry-cli": patch
---

**The confined reconciler can listen on macOS 26.** `ops/sandbox/reconciler.sb` granted `network-bind` on its bridge port, and on macOS 26 `listen()` is refused with EPERM unless `network-inbound` names the same address — so the first install that found a real git (and so confined the reconciler instead of running `unconfined.sb`) crash-looped on `listen EPERM 127.0.0.1:7812`. The profile now carries both rules, and `ops/sandbox/bind.test.mjs` runs every profile under a real `sandbox-exec` on a `macos-26` runner (CI when a profile changes, and every release): it must listen on its own port and be refused on any other, and the engine must not listen at all.

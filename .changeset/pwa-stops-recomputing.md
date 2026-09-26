---
"@metistry-apps/console": patch
---

**The PWA stops recomputing what the server already resolved.** The Agents panel prints the effective action table from `scope.autonomy.detailed` — the same table, in the same words, as `metistry agents autonomy` — instead of a local copy of the defaults, ceilings and clamp. The status list keeps all four check states apart: `degraded` is its own amber and `absent` reads *not configured* in grey, never *failed*, under a one-line summary. A task's own title is no longer title-cased on the feed; every tinted fill is its declared `*-quiet` token; agent prose is set in the tokens' serif stack; and every clock time is 12-hour with AM/PM, whatever the device's locale.

---
"@metistry-apps/console": patch
"@metistry-apps/macos": patch
---

**The design tokens drop `affirmative` / `on-affirmative`, and the token check now reads the colours that are actually painted.** Neither role has had a caller since Approve became the one accent fill (C92), so `--mt-color-affirmative` and `MetistryColorRole.affirmative` are gone from the generated CSS and Swift. `node ops/scripts/build-design-tokens.mjs --check` now also fails on a web CSS rule that paints an undeclared ink/ground pair, a hex colour in the web CSS or the design SVGs that is not a token, a quiet fill its own ink does not declare, and anything that maps the pinned accent to the system accent.

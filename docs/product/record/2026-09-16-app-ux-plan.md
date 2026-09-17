- 2026-09-16 — **The interface has a design plan, and an honest inventory of
  why it needed one.** `docs/product/app-ux-plan.md` starts the work of making
  the product manageable rather than merely installable. The inventory is the
  useful half: the Mac app ships **one of the design system's ten
  destinations** (Status), and 2,644 of its 9,763 Swift lines are settings, the
  wizard and first-run — so "verbose settings and a status page" is a
  measurement, not an impression. Sixteen of the seventeen §3 components exist
  in HTML/CSS only; the token pipeline is in better shape than expected
  (`tokens.json` already generates `tokens.css` twice, `design-tokens.swift`
  and the preview page, CI-checked at every PR), and the real drift is at the
  call sites: nine literal px values in the PWA's CSS, four `window.confirm()`
  calls where §3.17 specifies a `<dialog>`, a nav that grew to eleven flat tabs
  in a scrolling strip, a model picker specified and built nowhere, and
  `reply`/`elevation`/`motion` tokens that never reach the Swift. Two
  architecture gaps matter more than any of that: **compute can only be managed
  on the Mac** (no `/api/compute` route at all), and **knowledge — the
  product's first noun — has no client read path**, so captures go into the
  vault and nothing comes back out to any surface. The plan proposes seven
  sections instead of ten destinations, three renderings of them, the
  native-vs-embedded decision laid out with tradeoffs rather than settled, and
  a phase order that makes the window useful at phase A instead of phase F.

- 2026-09-27 — **One command updates everything the owner runs, the app
  included.** `metistry update` used to move the product under the Mac app
  and leave the app itself on whatever Sparkle last installed, so a terminal
  update could leave a new product behind an old front end. On a launchd Mac
  it now installs the same release's DMG too, under the same gate as the
  runtime pack — sha256 against the release's `checksums.txt`, then bundle
  id, version and (signed builds) codesign and Gatekeeper on the exact copy
  that lands — and swaps it in with the previous bundle kept for
  `--rollback`. Safe to leave running because every edge is a refusal with a
  test rather than a prompt: it never escalates privileges, never quits a
  running app unasked, never downgrades, never trades a signed app for an
  unsigned one, and never fails the product update it rides on. Doctor's
  `app` row makes "the app is behind the install" a visible, one-verb fix.

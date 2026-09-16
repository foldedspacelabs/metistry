- 2026-09-17 — **The thing running in the background is Metistry's, and there
  is a switch for it.** macOS shows one background item per launchd agent, and
  an item installed by `launchctl bootstrap` belongs to nobody: it sat in
  System Settings › General › Login Items *beside* the app, and the only way to
  turn it off was a terminal — which, for a product whose whole distribution
  premise is "download a DMG and never open one", is the gap between plausible
  and shippable. Two earlier changes fixed how it *read* (one agent instead of
  five, its program a symlink named `Metistry`, the bundled node signed under
  the Folded Space Labs identity so the attribution is a real company); neither
  could make it the app's. Now the app registers it itself, through
  `SMAppService.agent(plistName:)` on a plist sealed inside the bundle at build
  time: **one row, "Metistry", with the agent nested underneath**, and the same
  switch in two places — System Settings, and Settings → Services → "Run
  Metistry in the background" — meaning the same thing. Two rows, deliberately,
  because the two registrations are constantly confused and each one's sentence
  says which it is: *Start at login* opens a window, *Run in the background*
  runs the install. **The terminal path did not move an inch**, and that is the
  part worth keeping: a CLI-only install still bootstraps the same agent
  itself, both registrars are first-class, and what keeps them from ever
  installing it twice is that `metistry up` asks launchd who owns it before
  doing anything — live state, not a marker file that would go stale the moment
  someone dragged the app to the Trash and leave the install silently not
  running. `metistry doctor` names the owner. The app still installs nothing,
  writes nothing, and runs one `metistry` verb per step; all it gained was the
  right to say on/off about a registration macOS keeps.

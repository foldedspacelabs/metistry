- 2026-09-30 — **A key the Mac app answers is a row in one table, and a
  shortcut in any app registers only when nothing conflicts.** Every
  `.keyboardShortcut`, key handler and hot key in the Mac app's sources is
  listed in a closed table that a test holds to the sources, so no screen can
  grow a key the design does not know; a key the design documents and the
  build does not bind is labelled as unbound, with the reason, on Help ▸
  Keyboard Shortcuts rather than silently doing nothing. Shortcuts in any app
  are off by default; turned on, each of the five is checked against macOS's
  own shortcuts, the app's menus and the other rows, then registered — and a
  registration another app already holds takes back every other, so the
  switch is either fully live or registers nothing. It uses
  `RegisterEventHotKey`, which hears only its own combinations, so no
  Accessibility or Input Monitoring permission is asked for. Every view file
  now has a named accessibility probe that fails on an unlabeled control.

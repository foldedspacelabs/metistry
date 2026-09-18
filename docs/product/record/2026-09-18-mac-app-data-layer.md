- 2026-09-18 — **The desktop app can now read and change everything the
  system holds, and the secret that lets it never enters the app.** Until this,
  the Mac window could ask one question — "am I signed in?" — and everything
  else about your own work lived in the browser. It can now reach all of it:
  what happened, what is waiting on you, the board and its cards, the rooms,
  who is working and under what autonomy, where the money goes, your notes and
  a search across them. The way it reaches them is the part worth keeping: the
  app does not hold your credential. It asks the command line to make each
  request, and the command line is the only thing on the machine that knows
  where the secret lives — so a screenshot of the app, a crash log from it, or
  a copy of its memory contains nothing that would open the door from
  somewhere else. That is checked by a test that reads the app's own source and
  fails if any file sets a credential header, names a keychain, or opens a
  file at all; the test passed before this change and passes unchanged after
  it, which is the difference between a rule and a promise.
- 2026-09-18 — **A pane that cannot reach the system says so and keeps what it
  last knew.** Three habits are now properties of the code rather than notes
  for whoever draws the next screen. A refresh that fails leaves the previous
  answer on screen and marks it old, instead of blanking a working page. A
  background refresh is not allowed to become a spinner — only a first load,
  with nothing to show yet, earns one. And while nothing is answering, every
  button that would decide something refuses in a sentence *before* sending,
  rather than looking live and failing somewhere you cannot see. Reconnecting
  after a gap asks only for what changed, and a request you answered on your
  phone thirty seconds ago leaves the queue rather than sitting in it twice.

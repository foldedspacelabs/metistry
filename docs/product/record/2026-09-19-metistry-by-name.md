- 2026-09-19 — **Typing `metistry` now actually works, once you link it
  once — on every Mac this system runs on, no-Docker shape included.**
  Every release before this one left `metistry` unreachable by name: there
  was no Homebrew formula, no npm global, nothing on your `PATH` at all, so
  running the tool from a terminal — or the Mac app finding it before you
  had opened the app even once — depended on a wrapper only the person who
  built this system had written for themselves. Bringing an install up now
  writes that same kind of wrapper for you, in the one place both the CLI
  and the Mac app already agree to look, and prints the exact one-line
  command that puts it on your `PATH` — never doing that part itself,
  because what is on your `PATH` is your call, not the software's.
  `metistry doctor` now says, plainly, whether typing `metistry` would work
  right now, and hands you that same line back if it would not.

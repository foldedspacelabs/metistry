- 2026-09-19 — **`up` starts it and returns; `down` stops it.** Starting your
  assistant hands the processes to the operating system and gives you your
  terminal straight back — the daemon outlives the window you typed in, which
  is the whole point of it — and stopping it is now one word rather than a
  list of services you have to remember. `metistry down` stops everything and
  then goes and looks, telling you what is actually gone rather than assuring
  you it worked; it stops containers without removing them and never touches
  your data. Starting is also noticeably quicker: the start-up used to ask the
  system sixteen separate questions about jobs that have not existed on a
  migrated install for months, wait a full second at a time for a database
  that comes up in a fraction of one, and run its closing health checks one
  after another when every one of them is independent of the rest. None of the
  checks got weaker — a slow-but-healthy component is still given its full
  time to answer — they just stopped queueing. And the last two lines now say
  where the seconds went, section by section, so "that felt slow" is a thing
  you can read rather than guess at.

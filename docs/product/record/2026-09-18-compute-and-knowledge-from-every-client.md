- 2026-09-18 — **Where your work runs, and what you have written, are now
  reachable from whatever you happen to be holding.** Two of the most useful
  things Metistry knows were stuck on one Mac. Choosing which model answers
  you, setting a spending limit and checking that a provider key still works
  could only be done at a terminal on the machine that holds your notes — so
  from the phone you could see that a reply had cost forty cents and could do
  nothing about it. And your own notes, the whole point of the thing, were
  searchable by the assistant and by the tools you plug in, and by no screen
  of yours: there was no way to search your vault or open a page from the app
  at all. Both are now ordinary parts of the API every client speaks, which
  means the phone, the Mac app and the browser all get them at once rather
  than one at a time. Choosing a model and setting a budget go through exactly
  the same code the command line uses — the same check that the file is still
  valid before a single byte is written, the same hand-written comments left
  untouched, the same "this is your change, in your name" recorded against it
  — so the two ways of doing it cannot quietly come to mean different things,
  and a mistake is refused in the same words wherever you make it. **Keys stay
  where keys belong.** Adding a provider still means typing its key at your
  own machine, never sending one over the network; what the app can see is
  that a key of that name exists, and nothing more. Search tells you the
  truth about itself, too: when the part that understands meaning rather than
  words is unavailable, results come back anyway with a note saying they are
  word matches this time, rather than a spinner or an error. And the app can
  only ever open your actual notes — the machinery folders, your settings
  file, the assistant's own instructions and anything holding a password are
  not notes and cannot be opened as one, from any client, by anyone,
  including you. Finally, the slash-command menu now lists *your* commands
  rather than a hard-coded guess: it is built from your own routing rules, so
  it shows what your instance actually does, and a test checks that every
  command the menu offers is one the system really acts on.

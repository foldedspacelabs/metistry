- 2026-09-20 — **The files that decide how Metistry behaves can no longer be
  written by anything that merely says it is you.** A handful of files in your
  vault are different from your notes: they are the rules the system runs on —
  which agents exist, what they may read, what the assistant is told, which
  version is installed. The promise has always been that those are yours alone
  and no machine changes them. Until now that promise had a soft middle. Every
  request to change a file said, in its own words, who it was from, and the
  part of Metistry that holds your files believed it — so the check was really
  "did this request claim to be the owner", and one shared password reached it.
  Nothing ever abused that. But the whole design of this system is that a rule
  should be something the tools are incapable of breaking, not something
  everything happens to respect, and "nothing does" is a weaker sentence than
  "nothing can". Now the answer comes from *which key* a request arrives with,
  and a request cannot choose its own key. There are two: one the command line
  on your own Mac holds, which is you — it lives in the Mac's Keychain, and
  the command line can reach it because it *is* you, running as you — and one
  everything else holds, which can write your notes, your captures and your
  agents' work, and simply cannot write the rules, no matter what it puts in
  the message. The long-running part of Metistry that faces the network and
  speaks for every agent is deliberately never given the first key; that is
  enforced where its environment is built, not left to good behaviour. Exactly
  two exceptions are written down in the open, and both are things you do on
  screen and would otherwise have to do from a terminal: extending the
  assistant's own instructions when you approve a suggestion, and moving a
  model or a budget from the Compute pane on your phone. Everything else — the
  agent definitions, the access rules, the queries, the installed version, the
  assistant's operating instructions in your repository — is out of reach of
  anything but your own hand, and any attempt is written down with the name of
  what tried. If the key is missing, nothing gets to write those files at all,
  including Metistry's own updater; it fails closed and tells you the one
  command that fixes it. Updating mints the key for you, so an existing
  install needs to do nothing at all.

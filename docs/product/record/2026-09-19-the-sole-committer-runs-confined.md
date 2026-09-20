- 2026-09-19 — **The sole committer runs confined, and every child's egress
  passes one allowlisting door.** One process in Metistry holds your notes as
  actual files and is the only thing allowed to commit them. It is the part
  that would matter most if anything ever went wrong with it, and until now it
  was also the part with the fewest limits: nothing stopped it reading your
  Documents folder or your SSH keys, because nothing had ever told it not to.
  It now runs inside a boundary the operating system enforces rather than one
  the design intends — it can write the vault and a scratch directory and
  literally nothing else on the disk, it can run exactly two programs (the
  runtime and git), and it has no shell at all. The guarantee that "only this
  one process can change your knowledge" stopped being a promise about how the
  code is arranged and became something the kernel refuses to break. The
  assistant has had this since the start; this is the other half. And the
  boundary is honest about what it costs: two ways of authenticating a backup
  push stop working inside it, so the setup says so in plain words when it
  sees them, offers three alternatives, and leaves a single documented switch
  for anyone who would rather have the old arrangement — a visible file that
  says "allow everything", never a silent absence. The second half is about
  where things can *reach*. The confinement macOS offers can say "one port"
  but cannot say "openrouter.ai", so for a year the list of servers Metistry
  was allowed to contact was documentation sitting next to a rule that
  actually permitted any encrypted connection anywhere. There is now one door
  in the wall, and a doorman on it: every outbound connection from a confined
  part of Metistry goes to a single local checkpoint that knows the handful of
  names this install legitimately talks to — your model provider, from your
  own configuration, and your notes' backup remote, from the repository itself
  — and refuses everything else, writing down what was refused and which part
  asked. It never opens the envelope: it learns a destination and passes
  encrypted bytes through untouched, so it can tell you where your data went
  without ever being able to read it. Measured on a real Mac: the permitted
  destination answers normally, an unlisted one is turned away at the door,
  and with the door removed the operating system refuses the connection
  outright.

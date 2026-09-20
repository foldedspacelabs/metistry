- 2026-09-20 — **One scope vocabulary everywhere; the owner is never refused
  their own vault.** What an agent is allowed to see used to be described in
  four different sets of words: the console's Agents panel said one thing, the
  approval card in the queue said another, the tool descriptions an assistant
  reads said a third, and the command line said nothing at all — there was no
  way to ask, from a terminal, what any agent held. There is one set of words
  now, written once and rendered everywhere: a single line reading *role ·
  access · extras*, so "an agent · folders: Areas/Health · queries, autonomy:
  propose" is the same sentence whether you meet it in the panel, in the card
  you are answering, or in `metistry agents list`, which is new. Refusals got
  the same treatment: the system used to say "no" in five different dialects —
  an empty message, a bare "not granted", a sentence naming an environment
  variable, a sentence naming a web route and a command — and now says one
  sentence per kind of refusal, each one naming what would unlock it and who
  decides. The refusals that must stay uninformative — a task in a project you
  are not in, a page you could not already see exists — are now marked as such
  in the code itself, so nobody can make one of them chatty by accident and
  turn a refusal into a way of discovering what is there. And the owner's own
  rule finally has no exception: "the owner has access to everything" used to
  be true in intent and false in two places, where a check written to narrow
  agents was being applied to the person whose vault it is. The fix was to
  separate *what a file is* from *who may see it* — an artifact, the
  machinery, or a note — so a door that does not serve artifacts can say "that
  is an artifact; here is the door that has it" instead of "that does not
  exist". The owner is refused nothing, and a door still only serves what it
  is a door to: asking the knowledge index for the secrets file gets an honest
  answer and not a single byte.

- 2026-09-17 — **One command moves an instance you already have.** The new
  layout was only half the story: an instance created before it still had the
  old shape, and nobody should have to move thirty files by hand to get the
  clean folder. `metistry migrate-layout` does it in one step — and, more to
  the point, shows you the whole thing first. `--dry-run` prints every file it
  would move and every database row it would touch, and runs none of it; the
  real run makes one commit you can read, or undo, like any other. It works
  out the entire plan before it moves a single file, so if anything would
  collide it stops and names both sides while your instance is still exactly
  as it was. It refuses to run over uncommitted work, and if the part of
  Metistry that writes to your instance is still running it says so by name
  rather than quietly racing it. Nothing is restarted behind your back: the
  command finishes by telling you the one line to run when you are ready. It also fixes up the
  definitions of your sub-agents as it goes, so the permissions you gave them
  survive the move rather than quietly reverting the next time the system
  re-reads them — and it edits those files surgically, leaving your own
  comments and formatting exactly as you wrote them. Before it commits, it
  tells you which folders are about to become searchable notes, so nothing
  ends up in your knowledge base that you did not put there. The
  Mac app understands both shapes in the meantime, so an older instance is
  still adopted rather than rejected — it just says, once, which command
  brings it up to date.

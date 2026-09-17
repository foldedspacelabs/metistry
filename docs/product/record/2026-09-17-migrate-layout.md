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
  command finishes by telling you the one line to run when you are ready. The
  Mac app understands both shapes in the meantime, so an older instance is
  still adopted rather than rejected — it just says, once, which command
  brings it up to date.

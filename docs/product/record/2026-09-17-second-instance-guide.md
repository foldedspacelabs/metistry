- 2026-09-17 — **A second instance has a written, end-to-end path now, and it
  runs on zero cloud.** `docs/ops/second-instance.md` is the checklist: install
  from a checkout (v0.8.0, the first release with the compute changes, has not
  cut yet), `init` on the launchd shape, `up` with `assistant: absent` and
  everything model-free still running, then `compute providers add --from
  lmstudio|llamaserver` and `compute assign default` — the second Mac thinks
  with no cloud credential at all, proving §4b W1/W7 as a real sequence rather
  than a claim. Every command in it is grepped against `docs/ops/cli.md` and
  `packages/cli/src/main.ts` rather than invented, and it names two real gaps
  along the way: `metistry init` prints a compose-shaped
  `METISTRY_RECONCILER_URL` and no `METISTRY_ORIGIN` at all on a launchd
  install (`docs/ops/deployment-shapes.md`'s own "still missing" #4), and
  `main.ts`'s printed `--help` for `compute providers add --from` has fallen
  behind `COMPUTE_TEMPLATES` (`llamaserver`, `applefm` are missing from the
  string, present in the code). Connecting Devin, Cursor and OpenCode, and
  Devin's own knowledge-in/dispatch-out round trip, follow the same order the
  plan refresh set: what an operator does with a second Mac is now a document,
  not a memory of one session.

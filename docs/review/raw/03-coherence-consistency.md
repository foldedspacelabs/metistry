Confirmed. Now I have a complete, evidence-backed findings set. Compiling the final report.

## Findings

1. **[critical]** — §4.10 "Scoped escape hatch" vs §4.10 Tier 2 / §4.14 — casing contradiction on the identical example path.
   Line 909: `scope: [Knowledge/areas/drey, Knowledge/areas/fsl]` (lowercase "areas").
   Lines 977 and 1164 (same FSL/Drey example, restated twice): `` `scope: [Knowledge/Areas/fsl]` `` (capital "Areas").
   This is the exact bug class the document itself warns about at line 1371 ("`knowledge/Areas` in one file and `Knowledge/areas` in another works on the Studio and breaks in a container"). Since `Knowledge/` casing is CI-enforced on Linux (invariant 8 / §4.15), one of these two renderings of the same illustrative scope is wrong. **Fix:** normalize all `brain-read` scope examples to `Knowledge/Areas/...`.

2. **[critical]** — Invariant 2 vs §4.6/§4.14/§4.15 — casing violation inside a load-bearing invariant.
   Invariant 2 (line 143-144): "Metis commits freely to `knowledge/`." — lowercase.
   §4.6 "Free — direct commit by Metis": `` `Knowledge/` `` — Areas, People, Decisions, Journal, `now.md` — TitleCase, and §4.15/§4.14 both fix TitleCase as the one casing boundary.
   The same lowercase slip recurs at §4.12 ("`fswatch`/chokidar on `knowledge/`", line 1090) and in the Phase 6 build list ("Obsidian pointed at `knowledge/`", line 572). **Fix:** capitalize `Knowledge/` in invariant 2 and the two other recurrences; this is precisely the case-sensitivity failure mode invariant 8/§4.15 tell readers to watch for.

3. **[critical]** — Duplicate section number "§4.4" — dangling/ambiguous cross-reference.
   Line 762: `### 4.4 Skills`. Line 784: `### 4.4 Named query contract`. Two distinct sections both claim 4.4 (subsequent sections continue correctly at 4.5, 4.6, …), so every citation of "§4.4" downstream (e.g. line 1328's repo-tree annotation `skills/  §4.4`) is ambiguous as to which section it means. **Fix:** renumber one of the two (and cascade downstream section numbers if a full renumber is preferred).

4. **[critical]** — §4.16 header "Six rules" vs 7 enumerated items — count mismatch.
   Line 1467: "**Six rules that keep the option open**" is followed by a numbered list running 1 through 7 (fallback declarations; container-first; no absolute paths; two reconciler triggers; HTTP-first capture; re-briefable sessions; subscription setup-token auth). **Fix:** change the header to "Seven rules" (or fold two items together if seven was never intended).

5. **[major]** — §4.14 "Frontmatter schema" (frozen 2026-08-28) vs §4.14 "Moves and renames" (added 2026-08-29) — schema-freeze/ruling compliance gap.
   The schema block (lines 1192-1206), explicitly "frozen 2026-08-28 with the three prior-art-review additions" and "validated in CI," lists `type`, `status`, `area`, `people`, `decisions`, `created`, `updated`, `tags` — no `id`.
   Line 1281 (added the next day): "**Every note carries an immutable `id`** in frontmatter (assigned at creation, never edited)... `brain-read` resolves either." This makes `id` load-bearing for the durable-reference mechanism, yet it was never folded into the frozen/CI-validated schema block. **Fix:** add `id` to the canonical frontmatter schema (and confirm CI's shape validation covers it) or explicitly note it as a schema amendment.

6. **[major]** — Invariant 5 vs §4.17.B — stale enumeration on a named invariant.
   Invariant 5 (line 154): "Everything is a directory with a manifest. **Bridges, collectors, agents, routines.**" — no "targets."
   §4.17.B (line 1529): "A **target** is a directory with a manifest (**invariant 5**)..." — explicitly claims target manifests fall under invariant 5, and the terminology table / §4.5 manifest-type enum both list `target` as a fifth type. Invariant 5's own enumerated list was never updated when targets were added (2026-08-28). **Fix:** append "targets" to invariant 5's list.

7. **[major]** — §4.6 / §4.15(casing) vs §4.15(repo tree) / §5 — `bridges/` and bare `router/` don't match the actual repo layout.
   §4.6 "Protected — PR required" (line 830): `` `agents/` `bridges/` `collectors/` `router/` `db/migrations/` `ops/` ``. §4.15 casing section (line 1367): "manifests reference `agents/`, `bridges/`, and `skills/` by path."
   But §4.15's actual product-repo tree (lines 1313-1333) has no top-level `bridges/` — MCP bridges live under `packages/mcp-<name>/` — and `router` is one of three sub-apps under `apps/` (`apps/router`), not a top-level dir. §5's own instructions confirm this: "**Add a bridge** → `packages/mcp-<name>/`..." (line 1653). Yet invariant 3, §4.2, §4.4, §4.6, and §4.8 all reference bare `router/queries/` / `router/rules.yaml` as if top-level (6 occurrences). **Fix:** either update the protected-paths list and casing note to say `packages/mcp-*/` and `apps/router/`, or clarify that `router/` and `bridges/` are shorthand and state what they expand to.

8. **[major]** — PoC-12 (§2, still DEFERRED/not run) vs §4.13/§4.14/§4.15 — stale, wrong-cased vault layout.
   Line 439: "Set vault root to `brain/knowledge/`, git root at `brain/`." — lowercase `knowledge`, wrapped in a `brain/` directory.
   §4.13 (line 1102): "Vault root = `<instance>/Knowledge/`. Git root = the instance repo root (§4.15)." — no `brain/` wrapper, TitleCase. Since PoC-12 hasn't been run yet, anyone executing it literally would build the wrong, superseded structure. **Fix:** update the PoC-12 instructions to match the finalized instance-repo layout before it's ever run.

9. **[major]** — §4.18 "audit-not-gate (ruling #1)" applied to a mechanism the ruling didn't describe.
   Working-style ruling (line 125-130): "Knowledge commits flow freely... distillation-produced *facts* land as `status: draft`... an audit affordance... not a gate; nothing blocks on it" — describes Metis's own direct-to-vault commits.
   §4.18 (line 1634): "This is still audit-not-gate (ruling #1): nothing blocks on review; `draft` status marks the unsettled until the user acts." — applied to *proposal* triage from coordinating agents. But §4.10 defines proposals differently: "it can propose knowledge; it can never write it" (line 955) and the terminology table says a Proposal writes to "Inbox; never the vault directly" (line 89) — i.e., proposal content is held out of the vault pending an explicit allow, which is a gate on that content by construction, unlike ruling #1's direct-draft-commit model. Citing "ruling #1" for both blurs a real design distinction (system never blocks vs. content never lands until approved). **Fix:** either scope ruling #1's citation to system non-blocking only, or add a sentence distinguishing "the agent isn't blocked" from "the fact isn't gated."

10. **[minor]** — Build-plan outcomes table vs `docs/poc/RESULTS.md` — rounded-up status.
    Plan line 192: "2 iMessage attachments | **PASS** | Text door + *opportunistic* media door...".
    `docs/poc/RESULTS.md` line 98: "Status | **PARTIAL**" — with no later addendum resolving it to PASS (unlike PoC-6, which does get a "COMPLETED... PASS end to end" update). RESULTS.md's own stated methodology (line 4) explicitly warns: "A partial pass is more useful than a rounded-up pass." **Fix:** either add the missing resolution note to RESULTS.md or soften the plan's table to "PASS (text)/PARTIAL (media)" as it already does in the "what it settled" column.

11. **[minor]** — `docs/product/PRODUCT.md` vs build plan / README — stale PoC count.
    PRODUCT.md line 117: "Phase 0 complete (**14 PoCs**)..." (dated 2026-08-28).
    Build plan outcomes table and README both total **16 PoCs** (11 pass, 2 deferred, 2 fail, 1 split), including PoC-15/16 which post-date PRODUCT.md's initial count. PRODUCT.md has later 2026-08-29 log entries but never corrected the PoC count. **Fix:** update the count or add a log line noting PoC-15/16.

12. **[minor]** — §4.14 daily-flow section — dangling "§2 research" citation.
    Line 1264: "People / Projects / Areas — updated in place (ingest-as-update, **§2 research**)". §2 of this document is "Phase 0 — Proof of concepts," which has nothing about ingest-as-update; the term is only defined in `docs/research/2026-08-prior-art-review.md` (lines 182, 252). **Fix:** cite the research doc, not "§2."

13. **[minor]** — §4.18 "~5 MCP tools" undercounts its own enumeration.
    Line 1601: "**~5 MCP tools** on the existing scoped bridge." The same paragraph (lines 1606-1612) names `work.list_ready`, `work.claim`, `work.heartbeat`, `work.update`, `brief.get`, `report.submit`, plus `knowledge.search`/`knowledge.read` — 7-8 distinct tools. **Fix:** update the approximation to "~7" or note it grew since the estimate was written.

14. **[nit]** — Top-level architecture diagram (§0, line 57) shows a fixed "API — Anthropic / Haiku → Opus" box, not updated for §4.17's flexible-compute model. §4.17.A explicitly reframes this as "tiers are user-configured model bindings with shipped defaults... not hardcoded vendors," and §4.17.B/C add compute targets and swappable engines entirely absent from the diagram. Not wrong (Haiku/Opus are the shipped defaults), but the diagram reads as architecture-fixed rather than configurable, which is the opposite of what §4.17 argues. **Fix:** relabel the box "Model tiers (configurable, default Anthropic Haiku→Opus)" or add a footnote pointing to §4.17.

**Overall assessment:** The document is substantively sound — its invariants, phase gating, and safety rulings (reader/writer separation, invariant-4 gating, external-agent tiering) are internally coherent and none of the explicit user rulings are contradicted outright. The actual built artifacts (`db/migrations/0001_init.sql`, `docker-compose.yml`, `seed/`) track the plan closely and are, if anything, *more* disciplined about casing than the prose. The real damage is concentrated in exactly the failure mode the plan itself calls out as the "sleeper issue": repeated Knowledge/knowledge casing drift (including inside an invariant and inside a single repeated example), a genuine duplicate section number (§4.4 used twice), a header/list count mismatch ("Six rules" / seven items), and a scattering of stale paths and citations left behind by the rapid, in-place amendment process (PoC-12's pre-split layout, the `bridges/`/`router/` top-level assumption, an un-migrated `id` field in a "frozen" schema). None of these are individually fatal, but their concentration in the exact areas the document treats as CI-enforced ground truth (casing, schema freeze, section structure) means a careless pass at Phase 1 implementation could genuinely propagate one of them into code. A renumbering/casing sweep before Phase 1 starts is worth the hour it would take.

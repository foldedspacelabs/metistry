# Aggregation prompt for Opus 4.8

Paste the prompt below into an Opus 4.8 session running in this repo
(`/Users/example/Development/Metistry/.claude/worktrees/metistry-phase-0-poc-12cdbc`).
The four raw reviews are in `docs/review/raw/`.

---

You are aggregating four independent pre-implementation reviews of the Metistry
build plan into ONE readable decision document for the project owner. Do not
re-review the plan yourself and do not add new findings — your job is to
faithfully consolidate, de-duplicate, and organize what the four reviewers said,
preserving their evidence and severity.

Read these four files in full:
- `docs/review/raw/01-security-boundary.md` — security-boundary review (7 trust boundaries; token/XSS/bridge-auth/shell-access findings)
- `docs/review/raw/02-architecture-simplification.md` — staff-level architecture, simplification, interfaces, stack, deployment, phasing
- `docs/review/raw/03-coherence-consistency.md` — internal consistency: casing, numbering, stale references, contradictions
- `docs/review/raw/04-user-voice.md` — the target user's voice: install, daily flow, decision load, abandonment risk

For context (read only as needed to understand a finding, not to re-review):
`metistry-build-plan.md`, `docs/poc/RESULTS.md`, `README.md`,
`docs/product/PRODUCT.md`, `db/migrations/0001_init.sql`.

Produce a single markdown document, `docs/review/SYNTHESIS.md`, with:

1. **Executive summary** (≤250 words): the through-line across all four reviews,
   the go/no-go picture, and the 3–5 things that most change what gets built.

2. **Cross-cutting themes**: findings that ≥2 reviewers raised independently —
   these are the highest-signal items. For each: the theme, who raised it, the
   combined evidence, and why it matters. (Expect overlap around: enforcement-
   by-convention vs at-the-tool, the product/instance split not propagating to
   file layout, review-queue/decision-load accretion, phasing/scope realism,
   and time-to-first-value.)

3. **Unified findings table**, every distinct finding as one row, de-duplicated
   across reviewers, columns: ID | Source review(s) | Severity (reviewer's own:
   critical/major/minor/nit) | Area (security / architecture / consistency / UX /
   ops / scope) | One-line finding | Recommended fix (as stated) | Effort
   (reviewer's estimate if given, else blank). Sort by severity then area. Where
   two reviewers describe the same underlying issue, merge into one row and cite
   both.

4. **Conflicts & tensions**: anywhere the reviews disagree, or a fix one reviewer
   proposes would worsen a concern another raised (e.g. a simplification vs a
   security boundary). Present both sides; do not resolve them — flag for the
   owner.

5. **Owner decision queue**: the specific choices this review surfaces that only
   the owner can make, phrased as decisions (not tasks), each with the finding
   IDs it resolves. Separate "must decide before Phase 1 / core" from "can
   decide later."

Rules: quote sparingly but preserve every reviewer's severity label and their
numbers/evidence verbatim where cited. Do not invent severities. Do not soften
or upgrade a finding. If two reviewers conflict on a fact, show both rather than
picking. Keep it skimmable — this is read once, at a desk, to drive decisions.

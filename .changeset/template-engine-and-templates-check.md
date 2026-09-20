---
"@foldedspacelabs/metistry-core": minor
"@foldedspacelabs/metistry-cli": patch
---

**The daily note is rendered from a template you edit.** `core` gains the
template engine of `docs/product/daily-flow-spec.md` §6 (P1-6):
`renderTemplate(text, ctx)` and `validateTemplate(text)`, plus
`metistry templates check` in the CLI to run the second one from a terminal.

Eight directives and one block form, and the ceiling is the point — a ninth
verb is a product decision, not a config line:

| directive | what it renders |
| --- | --- |
| `{{ date format: "YYYY-MM-DD" offset: 1 }}` | a date in the instance's zone |
| `{{ tasks where: "due <= tomorrow or overdue" order: "priority, due" as: "list" }}` | the vault's `- [ ]` lines, as links to the notes they live on |
| `{{ recurring due: today }}` | §4's recurrence rules |
| `{{ calendar day: tomorrow }}` | the eventkit bridge's events for a day |
| `{{ work where: "blocked or waiting_on_me" }}` | the `work` rows a day needs |
| `{{ requests limit: 5 }}` | what is waiting on the owner |
| `{{ include "Me/Working Style.md#Prioritisation" }}` | a section of a vault file, spliced verbatim |
| `{{ prose "summarise yesterday in three lines" }}` | a slot the fold fills — fold templates only |
| `{{ section "Today" if_empty: "hide" }}` … `{{ /section }}` | a heading that vanishes when nothing is under it |

What the engine cannot do is enforced by its shape rather than asked for in a
comment. `where:`/`order:` go through `compileTaskFilter` and leave as bind
params of one named query, so no directive can put text into SQL (invariant
3); `{{ work where: … }}` is a separate, tiny flag list over `day_work`'s
board states, refused outright on anything outside it, because one vocabulary
stretched over two tables would compile against one and mean nothing against
the other. `prose` never reaches a model here: it produces a bounded request object
the fold routine fulfils on the turn it already takes, and it is refused
outright in a template whose output the assistant may not write (D14).
`include` splices literal text and evaluates nothing inside it, so a template
that includes itself renders a note rather than looping. And a recurring rule
is materialised into a `- [ ] … ^mt-…` line only when the render's `source` is
the user's own hand; every routine gets the same rule as a proposal, because
no routine writes a task into a note you own (D4).

Every failure is visible and none is fatal (§6.4): an unknown directive, a
`where:` the vocabulary refuses, an unreachable calendar, a query that is not
configured — each renders one `> ⚠️ metistry: …` line naming the template and
the line number, and the rest of the file still renders. A day with no plan
because the calendar was down is the worst possible outcome. A missing
template writes nothing at all and is reported as a configuration fact.

Every rendered file ends with a provenance footer — the template, its sha256,
when it was rendered and by which engine — so "why does my plan look like
that" has an answer that names a file. Output is capped
(`METISTRY_TEMPLATE_MAX_BYTES`, 16 KB) and truncates with the fold's own
`…and N more`.

`metistry templates check [<file>]` validates every file in the vault's
`Templates/` and prints each finding as `path:line  message`. It reads nothing
but the files — no database, no calendar, no vault lookups — so it answers on
a laptop with nothing running, which is what §6.5 needs: a template change
takes effect at the next run, and this is how you find out before the run
does.

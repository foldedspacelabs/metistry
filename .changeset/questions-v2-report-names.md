---
"@foldedspacelabs/metistry-core": minor
"@foldedspacelabs/metistry-mcp-brain": minor
"@metistry-apps/console": minor
"@metistry-apps/assistant": minor
"@metistry-apps/macos": minor
---

Questions v2 and both report names (T2-3). **A request can ask several
questions** (1–5, each pick one or pick any, 2–8 options, and — unless it says
`other: no` — ending in *Something else…*): the assistant's ```` ```decision ````
block grows a `question:` / `pick:` / `other:` grammar beside v1's (core's
`parseDecisionBlock`, still hand-rolled and bounded), and every agent asks the
same way through `requests_create` kind `question` with `questions` — no new
tool; the brain's eager surface grows 64 tokens (4,267 → 4,331) and stays at 26
tools. **Answers are stored per question**: `POST /api/proposals/:id
{decision: "answers", answers: [{choices, other?}, …]}` is checked against the
questions as stored (`checkAnswers`) and settles the row `answered`, with
`payload.answers` and the answers' words in `feedback`; free text is `other`
and never executes. Revise on a question is `accept_with_changes`. v1's wire —
the option itself as `decision` — still answers a one-question request.
**`decideProposal` reads F-5's table** (`describeRequest(kind, payload).decisions`)
instead of building its own list: a report is Dismissed (`skip`) and can no
longer be approved, revised or declined; Skip on one row is only a type's own
Decline (Dismiss, Not Mine) — elsewhere it is the batch's (K2). `GET
/api/proposals` serves a question's `request.questions`. **`decided`** is the
report kind for a decision made (C104); `decision` is accepted and stored as
`decided`. The PWA draws each type's own answers from the table, and a
question's questions as its body. MetistryKit sends Send Answers
(`RequestAnswer.answers`).

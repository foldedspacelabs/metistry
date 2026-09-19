# Components 01 — the four states, and the request card (2026-09-19)

> Round C. Two components, chosen in this order because the first is the
> product's largest undrawn gap and the second is its hardest layout.
> Canvas: the **Empty · absent · failed · stale** and **The request card and
> the bell panel** artboards.

---

## 1. Empty, absent, failed, stale

`design-brief.md` §8 asks for all four on every screen and treats them as one
family. **They are not.** The distinction that makes them designable:

| State | Means | Replaces the content? |
| --- | --- | --- |
| **empty** | nothing has happened yet | yes |
| **absent** | never configured — a fact, not a fault | yes |
| **failed** | it answered, and the answer was an error | yes |
| **stale** | it was answering and has not lately | **no — it annotates** |

The first three are **panel states**: there is nothing to show, so the panel
says why instead. Stale is an **annotation**: the reading on screen is still
the last true thing the system knew, and replacing it with an error throws that
away. This is why stale had no visual answer — it was being specified as a
fourth panel state, and it is not one.

### 1.1 Anatomy — the panel state (empty · absent · failed)

Centred in the panel it replaces: glyph (`icon-lg`, 26px) · title
(`headline`, Title Case) · one sentence (`subhead`, sentence case, ≤ 250px
measure) · for **failed** only, the reason verbatim in `mono` on `sunken` ·
one action where there is a sensible one.

| | Glyph tint | Action |
| --- | --- | --- |
| empty | `text-tertiary` | usually none — nothing is wrong |
| absent | `absent` | the thing that configures it |
| failed | `failed` | retry |

**Copy.** Sentence case throughout, per P10. Never an apology, never an
illustration.

| State | The sentence |
| --- | --- |
| empty | "Nothing in the last 24h" / "Activity fills as agents work and collectors run." |
| absent | "Not configured" / "Set `METISTRY_AWS_*` to fill this in." |
| failed | "Could not read spend" / "The collector answered, and the answer was an error." + `over_cap · aws-costs · run 4f21` |

The failed reason is **quoted from the API's own envelope**, not rewritten —
P4, and it is what stops the UI copy and the server's refusal drifting apart.

### 1.2 Anatomy — stale

Two renderings, and neither hides the data.

- **In a row:** a pill after the probe — clock glyph + age (`3d`), in `stale`
  on `stale-quiet`. The row's own state label stays where it is.
- **On a panel:** the same pill in the panel header, with the value below it at
  full size, and `last collected 16 Sep, 04:10` in `footnote` beneath.

**The threshold is per source, not global**, and it belongs to the collector's
manifest rather than to the design: a collector that runs hourly is stale at
three hours; `aws-costs`, which runs daily, is not. The component takes an
`isStale` boolean and an age string and draws them. It never computes staleness
from a timestamp — that would be the inference P5 forbids.

### 1.3 The control that is off because of a fact

O3 (`ios-app-plan.md`): decision controls are **disabled while the instance is
unreachable, never queued**. A greyed button explains nothing, so the pattern
pairs it with the reason directly beneath, in `stale` with a lock glyph:

> the instance is unreachable — decisions are never queued

This is distinct from a control disabled because nothing is selected, which
carries no line at all. **The rule: a control disabled by a fact about the
system always shows that fact; a control disabled by the user's own state does
not.**

### 1.4 Tokens this uses

`text-tertiary` · `absent` / `absent-quiet` · `failed` / `failed-quiet` ·
`stale` / `stale-quiet` · `sunken` for the verbatim reason. All added or
declared in round B; none is new here.

### 1.5 Data sources

| Where | Source |
| --- | --- |
| status rows | `metistry doctor --json` (Mac) · `GET /api/status` (web) |
| spend panel | `spend`, `aws_costs_daily`, `claude_usage_daily` named queries |
| activity empty | `GET /api/q/activity_feed` |
| the age behind `stale` | the collector's last successful `runs` row |

**One gap:** nothing in the wire today marks a row stale. `CheckStatus`
(`apps/macos/sources/kit/doctor-report.swift:17`) is a four-case enum —
`ok · degraded · failed · absent` — and staleness would be a fifth thing, or
better, a separate `lastSuccessAt` field beside the status. **It should be the
field, not a fifth case**: stale is orthogonal to the other four (a row can be
`ok` and stale, which is exactly the `aws-costs` case). Logged for whoever
builds it; not a design decision to make alone.

---

## 2. The request card, and the panel behind the bell

### 2.1 What makes it hard

Six answers, a preview of exactly what will happen, grouping by type, and a
batch bar — inside a **400px popover**. `design-brief.md` calls the board the
hardest layout in the product; I think this is, and round 00 said so.

### 2.2 Anatomy

Card, `surface` on the panel's `bg`, `radius-md`, 16px padding:

1. **Header row** — type glyph + type label (`caption-2`, uppercase,
   `text-secondary`) · spacer · **agent chip** (`mono` on `agent-quiet` in
   `agent`) · relative time. The agent chip carries P1: the request came from
   an agent and is marked as data before the title is read.
2. **Title** — `headline`, agent-sourced, so never case-corrected (P10 §3.2).
3. **Preview** — `sunken` block, headed by what the affirming action would do
   ("FOLDERS IT WOULD READ", "WHERE IT WOULD BE WRITTEN").
4. **Action row** — below.

### 2.3 The preview is data, not a coloured diff

Additions are marked with a `+` in `text-tertiary` and the line set in
`text-primary` at 600; unchanged lines sit in `text-secondary` at 400. **No
green, no red.** Two reasons: what an agent proposes is data (P1), and colour
in this product already buys accent, state, presence and action intent — a
fifth meaning would make the other four less legible. The diff reads as a list
where one line is heavier, which is enough.

### 2.4 Six answers, three weights

The brief's own observation is that six equal buttons is wrong. They are:

| Weight | Answers | Treatment |
| --- | --- | --- |
| **decisions** | Approve · Revise · Decline | the three buttons, leading edge. Approve is `affirmative`, Decline is `destructive`, Revise is secondary |
| **the conditional one** | Approve as Work | **a `▾` on Approve**, not a fourth button. It exists only when the row carries `payload.suggested_work`, so the card has three buttons or three-and-a-menu — never five |
| **dismissals** | Later · Skip | quiet text buttons pushed to the **trailing edge**, visually separated. They are not decisions; they are ways to clear the card, and they are the two that batch |

That split is the whole layout answer: decisions left, dismissals right, the
conditional answer folded into the one it modifies.

### 2.5 States

| State | Rendering |
| --- | --- |
| pending | as drawn |
| previewing | the diff block expanded; the card grows, the panel scrolls |
| deciding | buttons disabled at 55%, **nothing spins** — the working state is the disabled row itself |
| approved / declined / revised | collapses to a one-line receipt: glyph, what happened, what changed, and **Undo where the underlying operation is reversible** and nothing where it is not |
| snoozed (Later) | leaves the list with **no receipt** — Later settled nothing |
| **stale** | the answer was refused `409 reason: "stale"`. The card keeps its border in `stale`, replaces its body with "This moved while the card was open, so nothing was sent. The card below is the current version," and repaints the new row beneath. It never re-sends |

### 2.6 The panel

400px, **opaque `elevated`** (ruling 13 — it holds a diff and a destructive
action, so it does not sit on a vibrant material), elevation 3.

Header: "Needs You · 4 waiting · 1 snoozed" + a type filter as chips.
Body: cards grouped by type, oldest first, on the panel's `bg` so each card
reads as a card.
Footer: the batch bar, pinned, offering **only Later · Skip · Decline** —
the three that need nothing from the individual row.

Over six cards the popover becomes a resizable panel. **That transition is
still undrawn** and is the one thing in this component I would not build from
this spec yet.

### 2.7 Keyboard (Mac)

`⌘9` toggle · `↑ ↓` between cards · `a` approve · `r` revise · `d` decline ·
`l` later · `s` skip · `esc` closes having changed nothing. Every key is also a
button; nothing is keyboard-only.

### 2.8 VoiceOver

Sentences, not tokens, and agent text carries its prefix:

- "from agent drey-dev: access request, read Areas Finance. Approving adds one folder to three. 12 minutes old."
- "aws-costs, stale, last collected 3 days ago"
- "slack-bridge, not configured"

### 2.9 Data sources

| Piece | Source |
| --- | --- |
| the queue | `GET /api/proposals` |
| one answer | `POST /api/proposals/{id}`, carrying `if_unchanged: {seen_at}` |
| the batch | `POST /api/proposals/batch` |
| the count on the bell | the same queue's pending rows |
| Approve as Work | `payload.suggested_work` on the row; absent ⇒ the menu is absent |

The staleness envelope is the shipped one (`app.js`'s `seenAt` map and its 409
repaint) — this design renders the state the wire already produces, which is
the point.

---

## Still open after this round

1. **The popover → panel transition** at more than six cards (§2.6).
2. **`lastSuccessAt` on the doctor row** (§1.5) — a field, not a fifth enum case.
3. **Per-source staleness thresholds** belong in collector manifests; nothing
   defines them today.
4. **A section-scale absent state** — Knowledge with no bridge configured is a
   whole destination that cannot fill itself, and it is drawn here only at panel
   scale.

I've read the plan (all 1,837 lines), README, PRODUCT.md, RESULTS.md (PoC-6/7/8/9/13/14 in detail), and both research docs. Here's the review, in the user's voice.

---

# Metistry — user-voice review

*Persona: staff-engineer/technical-founder. Comfortable with Docker and a terminal. ~30 usable discretionary minutes a day, in fragments. Already runs Obsidian, Apple Notes, Linear, and three Claude sessions. Will abandon anything that becomes a chore.*

---

## 1. Day 1 — `npx metistry init`

**What the plan gives me** (§4.15 install + §4.14 init interview): prompts for the assistant's name, stamps `identity.yaml`/`now.md`/vault starter, writes `metistry.lock`, generates `.env`, `git init`s the instance, brings up compose from pinned images, runs migrations, prints the TCC grants to click, verifies. Then a short question set writes `Knowledge/Me/profile.md`.

**The wow moment is real and it's the first 30 seconds.** "What do you want to call your assistant?" is the single best design decision in the document. It costs nothing and it makes the thing mine. Protect it.

**Then I hit the wall.** Here's what Day 1 actually is, counted honestly from what the plan and the PoC results require:

| Step | Reality |
|---|---|
| Docker installed + pgvector image pull | 5–15 min if Docker isn't already there |
| `claude setup-token` on the host, inject as `CLAUDE_CODE_OAUTH_TOKEN` (§4.16 rule 7) | separate command, separate mental model, and I must *not* set `ANTHROPIC_API_KEY` — a footgun documented in the plan but invisible at the prompt |
| TCC grants for three separate signed binaries (Messages/FDA, EventKit ×2 stores, Apple FM) | System Settings, per binary, and PoC-9 found the prompt only renders under launchd — so the flow is *start the service, then go click* |
| Create a private GitHub remote for the instance repo, push | not mentioned in init at all; §4.15 says `git init`s, nothing about the remote |
| Obsidian: install, point vault at `Knowledge/`, install Linter + Advanced URI + Bases + Templater + QuickAdd + Periodic Notes (§4.14), configure template + attachment locations, gitignore `workspace.json` | 20–40 min of app configuration |
| Obsidian Sync subscription ($5/mo) | a credit card, on day one, for a thing I haven't seen work |
| PWA: enable Serve + HTTPS certs at the *tailnet admin console* (PoC-6's blocker), `tailscale serve --bg`, Safari → Add to Home Screen → open from the **icon** not the tab → Enable notifications → Allow, and the VAPID `sub` must be a real contact | PoC-6's own `IPHONE-STEPS.md` is 6 steps with 4 documented ways to get it subtly wrong |
| Init interview questions | unspecified length — see below |

**Where I give up:** somewhere in the TCC/Obsidian/tailnet stretch, around minute 70, when I still have not seen the system do anything. Realistically this is a 2–4 hour Day 1 for me, and I don't have a 2–4 hour block; I have four 25-minute blocks across a week. Which means Day 1 becomes Week 1, and a half-configured system is a system I don't trust enough to text.

**The structural problem:** the plan's declared wow moment is Phase 2's "you text yourself and get a useful answer" — and that sits behind *the entire native tier*. Messages bridge, TCC, signed binaries, launchd, container auth. Everything that can go wrong on Day 1 sits between me and the only moment that makes me want to continue.

> I would not finish this in one sitting, and a half-finished install is worse than no install.

**Fix:** `metistry init` must end, in under ten minutes and with zero TCC grants, with something working. The pieces already exist: `POST /capture` (PoC-7, passed, no TCC), the router fast path (PoC-8, 0.6 ms), and a local console. So: init brings up compose, seeds the vault, opens `http://localhost:PORT`, and says *"Type something. That's now in your vault, in your git — here's the commit."* Then the native tier is a **progressive** unlock: `metistry doctor` shows a checklist of capabilities with "grant this to enable iMessage," each one adding a capability to a system that already works. Grant-rot recovery (documented three ways in Phase 0) then reuses the same checklist instead of being a mystery.

**On the init interview:** it's the right idea and it's the highest-risk moment in the install. If it's 15 questions at minute 3, I skim, answer badly, and the profile is wrong forever. Cap it at four questions (name, timezone, quiet hours, what am I working on) and let the assistant earn the rest by asking one question a day as a proposal — which the plan's own machinery (§4.14: "profile updates follow the normal proposal/acceptance flow") already supports.

---

## 2. A normal morning — the brief

### First finding: the morning brief has no specification

I grepped the whole repo. The morning brief is referenced **ten times** in the plan and specified **zero** times. There is no content spec, no ordering rule, no length budget, no cap, no owner. It is the single most-consumed artifact in the entire system and it exists only as the place other features send their leftovers.

Here is everything the plan currently routes into it:

| # | Item | Source | Cadence |
|---|---|---|---|
| 1 | Draft facts from distillation, one-tap settle/reject | §0 working style | daily |
| 2 | Inbox proposals from capture classification | §4.11, Phase 3 done-when | daily |
| 3 | External-agent elevation requests | §4.10 | event |
| 4 | Obsidian conflict files | §4.13 | on conflict |
| 5 | Cross-area move notices (permission consequences) | §4.14 moves #4 | on move |
| 6 | Broken-wikilink fix proposals | §4.14 moves #3, nightly sweep | daily |
| 7 | Event-driven proposal pushes (allow/deny/changes) | §4.18 | continuous |
| 8 | Weekly digest of the assistant's commits | §4.6 | weekly |
| 9 | Routing report + miss events | §4.17.D | weekly |
| 10 | Freshness/contradiction/orphan lint findings | research rec #3 | weekly |
| 11 | Stale threads + dead collectors | §5 cadence | weekly |
| 12 | Watchdog alerts | §4.8 / PoC-11 | on failure |
| 13 | Comms action items | §4.11 | **gated — PoC-13** |

Six daily channels, five weekly, two event-driven. Every one of them was individually reasonable. Nobody owns the sum.

### Second finding: PoC-13's gating removes the value and leaves the cost

Row 13 is the only item on that list that tells me something **I didn't already know**. Everything else is either (a) me confirming things I typed yesterday, or (b) the system's own housekeeping. With the reducer gated, the Phase 2–3 brief is:

> "Good morning. Here are 11 facts I extracted from the daily note *you wrote*, please confirm each one. Also two wikilinks broke. Also one file has a sync conflict."

That is a net-negative trade. I did the capture work; now I do the triage work; and the system tells me nothing I didn't put there. `work` is empty until the Phase 4 GitHub collector. Semantic recall is Phase 6.

> This is not an assistant. This is a form.

**Fix (sequencing):** don't ship the morning brief before Phase 4. Before collectors exist, there is no non-me content to brief. What *can* ship earlier and carries real value with zero PoC-13 risk: today's calendar (EventKit already PASSED, PoC-9), what changed in my repos, and spend. Those are three lines I can't get anywhere else in one place.

### Third finding: the brief arrives where I cannot act on it

§4.8 sends proactive messages through the Messages bridge. §4.1 states plainly that iMessage can't render buttons. So the "one-tap settle/reject" that the entire audit-not-gate ruling depends on requires me to switch to the PWA. My real morning is: unlock → read a wall of text in Messages → open the PWA → wait for load → scroll → tap, tap, tap.

> That's two apps and eleven taps before coffee, to confirm things I said yesterday.

**Fix:** every brief line carries a tap-target URL into the PWA at that item. The plan already has the pattern (§4.14: "Metis can text `obsidian://` deep links"). Do the same for proposals.

### Decision-load count

By month two, a normal weekday, honestly estimated: 5–15 draft facts from the evening distillation, 3–8 inbox proposals, 0–2 lint/conflict items, plus whatever agents pushed. **Call it 10–25 decisions per morning.** With a weekly digest, a routing report, and a lint report stacked on Mondays.

Rate the daily decision budget I actually have for a personal tool: **five**. Maybe.

**Fix — the single most important change in this review:**

1. **A hard cap.** The brief shows at most five decisions. Period. Rank by consequence.
2. **Auto-expiry.** Anything not acted on within N days auto-settles to `status: draft, reviewed: never`, stays searchable, and is *never re-surfaced*. This is fully consistent with audit-not-gate — the plan's own ruling is that nothing blocks. Right now the queue re-surfaces forever, which quietly converts an audit into a gate enforced by guilt.
3. **Batch actions.** "Accept all from this source," "reject all matching this shape," "mute this source." The plan's own §4.11 note — "rejections tell you which rules to tighten" — needs an interface, and one-at-a-time isn't it.
4. **A source scorecard.** Track my accept rate per proposal source. When I've rejected 90% from a source for a month, the system should offer to turn it off. Don't make me notice drift; the plan's §5 "on drift" heuristics all assume a self-awareness I won't have at 7am.

---

## 3. Capture on the go

**Grocery store thought.** Best available path today: unlock → Messages → tap the thread → type "/note furnace filters 20x25" → send. Four taps and typing, ~15 seconds. Under the five-second bar? No. Good enough that I'll do it? Yes, because Messages is already open half the time.

The genuinely fast path — one tap, no typing — is Shortcuts, and the plan knows this (§4.1: "The genuinely fast mobile path isn't chat at all"). But it only spec's a `/status` Shortcut. **The `/note` Shortcut is the more valuable one and it isn't there.** What I want shipped: a Capture Shortcut with a Siri phrase, dictation input, bound to the Action Button and available as a back-tap. "Hey Siri, tell Metis" → speak → done. Zero taps, driving-safe. That's the capture story.

**Photo of a whiteboard / a link.** Share sheet → Metistry. PoC-7 passed HTTP with a 25 MB binary byte-identical — good. But note two things the plan glosses: the iOS share-sheet leg is explicitly **deferred/untested**, and iOS Safari does not support Web Share Target, so a PWA can never register as a share destination. The share sheet path *must* be a Shortcut until the native app exists. That means my bearer token lives in a Shortcut on my phone. Worth stating deliberately rather than discovering.

**The thing that will kill capture: silent failure.** Capture is HTTP-first (§4.16 rule 5), the offline queue is explicitly a *premium iOS app* feature, and my phone is frequently not on the tailnet — parking garage, plane, Tailscale toggled off after a work VPN conflict. A Shortcut that POSTs and fails gives me a red banner I'll dismiss while walking.

> One dropped thought and I'm back in Apple Notes forever. That's not a rational reaction, it's just what happens.

**Fix:** the Capture Shortcut writes to a local file on any failure — and the plan already has the destination. §4.16 rule 5 relegates iCloud Drive to "a `local-mac` convenience"; make it the **fallback** instead of a parallel path. HTTP first, iCloud Drive on failure, `inbox-drain` picks it up either way. This costs almost nothing and it's the difference between a capture tool I trust and one I test twice and abandon.

**If I never triage:** inbox files accumulate, drain classifies them into proposals, proposals accumulate in the brief, nothing expires. The plan is admirably firm that todos must never be "markdown lists that rot" (§4.14) — and then builds a proposal queue that rots exactly that way.

---

## 4. A meeting — and a six-meeting day

**What the plan asks:** open Templates, create `Journal/Meetings/2026-08-29 <topic>.md`, fill attendees as wikilinks, a `decisions` list, action items.

**Realistic?** For one important meeting a week, yes — and I'd get real value. For a normal day, no. Two specific frictions:

1. **Attendee wikilinks require People notes to exist.** First meeting with a new person = create a person note = friction at precisely the worst moment. And §4.14's CI validates that `people` values are *actual wikilinks*, so a lazy plain-text entry is a validation failure.
2. **It's post-meeting work in a day with no gaps.** Six back-to-back meetings, 3–5 minutes of note admin each = 20–30 minutes I do not have. I will write notes for the first one and nothing after.

**End-of-day debt on a six-meeting day:** five unwritten meeting notes, no daily note, and therefore an evening distillation that harvests nothing. The system's compounding loop starves on exactly the days I most need it — and those days are the majority.

**Fix (high value, uses machinery that already passed):** the meeting note should exist *before* the meeting. EventKit is a PASS. A collector reads today's calendar, stamps a meeting note per event with topic from the title, attendees pre-wikilinked (matched by email against `People/`, auto-stubbing `status: draft` person notes for unknowns), and an empty decisions/actions section. My job becomes typing three lines into an already-correct file rather than filing. That's the difference between 5 minutes and 30 seconds.

**The gap nobody has named:** there's no audio/transcription path anywhere in the plan. For this persona in 2026, "meeting notes" without transcription is a manual chore against a market of tools that do it for free. The architecture supports it cleanly — a native bridge, on-device model, nothing leaves the Mac, exactly the §4.3/§4.16 shape. But heed the plan's own PoC-13 evidence: auto-*extracting* decisions from a transcript would hit the same precision wall. The honest version is transcript-into-the-vault plus human-marked decisions, not another reducer.

---

## 5. Asking things over iMessage

**Latency, per tier — and the bar is measured at the wrong boundary.** PoC-8's 0.6 ms / 24 ms is server-side. What I experience is send → bridge notices → route → reply delivered. `chat.db` has no change-notification API, so the bridge polls. At a 5-second poll interval, my "sub-200ms fast path" is a ~6-second round trip — and the plan's own justification for the fast path is that *"if it isn't [under 200ms], the fast path won't feel different from a Haiku turn and you'll stop using it."* If the poll interval is 5s and a Haiku turn is 3s, the fast path is **slower** than the model. Measure end-to-end from send to delivery and set the poll interval against that number, or the whole optimization is invisible to me.

**A hard question** goes to adaptive escalation — default tier, deep-tier sub-delegation. Tens of seconds. In iMessage, silence for 20 seconds means I re-send, which creates a duplicate turn and a duplicate cost. **Fix:** any turn expected to exceed ~5 seconds gets an immediate ack naming the tier. "Thinking on this one — deep tier." Cheap; prevents the double-send.

**"What did we decide about X three weeks ago."** This is *the* question. It is the reason a person builds this system. And it is **Phase 6, deliberately last.**

I understand the argument ("semantic search over a thin corpus isn't worth much"). But the plan's own research contradicts the sequencing: *"Keyword search is the strong baseline at personal scale — measured recall@10 = 1.0 keyword vs 0.77 paraphrase"* (prior-art review §1). Keyword search over my vault is ripgrep plus a named query. It is an afternoon of work, not a phase.

> **This is the highest-value reorder in the entire plan.** Ship keyword/FTS recall in Phase 2. It's the one behavior that makes me feel the system is worth having, it's nearly free, and today it's scheduled after everything expensive.

**Will I remember the commands?** No. There are ten (`/status /today /open /spend /queue /runs /note /model /deep /new`) plus `@agent` tags. I will remember `/note` and `/deep`. The plan is right that regex-matched natural language is the real interface.

**Phrasing a fast-path question slightly wrong:** "what's my spend" hits; "what's my burn this week" misses, falls through to the model, costs a turn, returns a differently-shaped answer. This is the *correct* failure mode — fail open to the assistant, exactly what invariant 4 and PoC-14 argued for. Two cheap things missing:

- **Near-miss logging.** When a model turn produces an answer a named query could have served, log it. That's a ready-made "add this regex" list and it feeds §4.17.D's tuning loop for free.
- **`/help` that lists the phrasings currently wired**, generated from `rules.yaml`. Not a manual — the live list.

---

## 6. The multi-agent week

**Grants** are fine mechanically: `POST /api/agents`, mint a token, set tier (none / index / areas). A PWA form, two minutes. Server-side grants on the token (§4.10) is the right call and I'd trust it.

**But the scenario in the prompt is the one the plan forbids.** Pointing my *work* coding agent at my personal hub is exactly what §4.15's IP boundary exists to prevent. So the real version is: install and maintain a **second instance** — second Docker, second Postgres, second vault, second remote, second set of TCC grants — on work hardware that likely has MDM and may not let me grant Full Disk Access at all.

The plan says *"the annoyance is smaller than it sounds."* From here it isn't. It's 2× everything for a person with zero spare maintenance capacity, and the boundary argument is correct, so the honest framing is: **the work instance is a real second project, budget for it as one.** I'd rather see that stated than softened.

**Proposal velocity.** The `metistry` Claude Code plugin "pushes decisions/findings at natural moments" plus a session-end summary hook. A coding agent working an afternoon produces findings continuously. Realistically **5–20 proposals per active agent-day**; two agents on a busy week is 10–40 pushes a day.

**And here's a real gap:** §4.8's guardrails — quiet hours, per-category rate limits, everything logged — govern the *outbound message* path. §4.18's event-driven push path is described without any reference to them. Those limits must be stated as governing §4.18 explicitly, or the well-designed rate limiter simply doesn't apply to the highest-volume channel.

**When do I mute it:** at that volume, inside a week.

**One honest correction on the evidence.** The brief for this review cites "the plan's own research says ~60% of ambient features get disabled in 2 weeks." **That statistic is not in this repo.** I searched both research docs. What's actually documented is *cost* abandonment — "$36/day idle heartbeats, $1.8k–$6k runaways," called the #1 documented abandonment reason — plus two softer claims: §4.8's asserted "an assistant that pings eleven times a day gets muted," and rec #6's "sub-15-min cadence measurably degrades the model's 'should I speak' judgment."

That asymmetry matters more than the missing number: **the plan has strong evidence about the abandonment mode it defends against (money) and weak evidence about the one it will actually hit (attention).** Its architecture generates very little idle cost and a great deal of attention cost. The defenses are aimed at the wrong flank.

**Fix:** event-driven push **off by default**. Batch to at most two digests a day (midday, evening) with a hard item cap. Real-time push only when an agent is genuinely **blocked** — which is self-limiting, because an agent that pings me is an agent that stopped working. That's a natural rate limiter, and it means every interrupt I get has actually earned it.

---

## 7. The two-week vacation

**What degrades gracefully — and this is genuinely well designed:** work leases expire and release their tasks (§4.18). Quiet hours hold. Capture keeps working. Git keeps the record. `docker compose down -v` remains survivable. The watchdog tracks the ~1-year token expiry and warns ahead.

**What doesn't:** everything with a queue. Fourteen morning briefs sitting in a Messages thread. Two weekly digests, two routing reports, two lint reports. Inbox files. Proposals from drain and agents. Draft facts from fourteen nightly distillations. Nothing expires, nothing rolls up, nothing caps.

Back-of-envelope: **150–400 pending decisions.** The 300 in the prompt is about right.

> I would open the PWA once, see the badge, close it, and never open it again. That's not a decision I'd make consciously — it's just what happens when a queue passes the point where finishing it is imaginable.

**The reboot scenario is worse and it's an unresolved question in the plan.** RESULTS.md "Questions" #4 explicitly leaves login-window behavior open: TCC grants and Apple FM are validated only for a logged-in `gui/501` LaunchAgent. A power blip while I'm away, the Mac comes back to the login window, and the entire native tier is down for two weeks. The watchdog is supposed to tell me — but the watchdog is also a `gui/501` LaunchAgent, and it reports **through iMessage**, which is the thing that's down.

**Fix:** an external dead-man's-switch. The watchdog pings a free uptime service every N minutes; if the pings stop, *that* service emails me. It's the only way I learn that the thing that tells me things are broken is broken. Ten minutes of work; it covers the one failure the entire monitoring design cannot see.

**Also:** PoC-6 documented that reinstalling the Home Screen icon invalidates the push subscription and the endpoint starts returning `410 Gone`. So push will silently die at some point and I will conclude nothing is happening. The watchdog should treat a 410 on a push subscription as a real alert.

**Fix (away mode):** an explicit mode — pause distillation, stop briefs, cap queues. On return, exactly **one** artifact: *"14 days away. 62 captures classified into 3 buckets. 9 look time-sensitive — here they are. 0 conflicts. Everything else archived, searchable."* Auto-archive is the whole trick, and the plan already has every mechanism it needs (status in frontmatter, audit-not-gate). It's missing only the policy.

---

## 8. When it breaks — bridge dies, I'm traveling

The watchdog texts me: `eventkit bridge check() failing since 03:12`. I'm in an airport.

**What can I do from my phone?** Nothing the plan provides. The management API (§4.2) covers agents, grants, proposals, projects — no operations. There's no remote `doctor`, no component restart, no status page. `GET /health` exists but nothing acts on it.

The real answer for this persona is SSH from Blink over the tailnet and run `metistry doctor` — which is *fine*, and it's exactly what I'd do, but the plan should say so, because it changes what the watchdog message should contain.

**Fix — make watchdog messages actionable.** Four fields:
1. What failed.
2. **Degraded or dead** — because §4.16's `degrades: absent` means capability-off, not system-broken, and that distinction decides whether I ruin my flight worrying.
3. The exact command that fixes it.
4. What's still working.

**And add one endpoint:** `POST /api/components/:name/restart`, scoped to restartable components, audit-logged like everything else. It's small, it's boring, it fits invariant 8's "small and boring" discipline, and it's the difference between "fixable from a phone" and "waits nine days."

**Protect `degrades: absent`.** It's one of the best ideas in the plan. When the Mac is off, capabilities go absent rather than turns failing. Most systems get this wrong and produce mystery errors instead.

---

## 9. Month 6

**Chores I actually kept up** — the automated ones, and only those:
- Weekly review routine: kept, because it's a routine, not a chore. Correct design.
- Quarterly restore test: kept, because §5 already specifies it as automated. *"An untested backup is a hypothesis"* is the right instinct and the right implementation.

**Chores I dropped:**
- Monthly token-spend check against subscription headroom: never did it once. But `/spend` makes it a 3-second question — so make it a **monthly push**, not a monthly chore. One line: "August: $X, tier split, vs July."
- §5's "on drift" heuristics ("if you find yourself hand-editing `now.md` often…", "if you stop checking the dashboard…"): I will not notice either. Instrument them. Track panel views and per-source accept rates, and let the weekly review *propose* deletions — the plan already permits routines to propose and forbids them applying.

**What I stopped reading, in order:** the weekly digest of the assistant's commits (week 3 — it's a diff list, and I trusted the sole-writer property by then anyway); the routing report (read once, fascinating, never again); every dashboard panel but one.

**What would make me abandon it,** ranked by how likely each is to actually happen:
1. The queue crosses ~5 items/day, I skip a morning, then a week, then the badge becomes a source of guilt and I stop opening the PWA. **Most likely by a wide margin.**
2. Capture drops one thought and I notice.
3. An OS or toolchain update rots a TCC grant (documented **three** distinct ways in Phase 0 — Homebrew's Cellar path, the `claude` CLI's versioned path, ad-hoc cdhash) and I lose an evening re-granting. Twice and I'm done. The stable-signing-identity decision is the right mitigation; it's also a notarization step on every release, maintained by one person.
4. The work instance's second maintenance burden simply never gets paid, so the whole work half never exists — and half the pitch quietly evaporates.
5. Cost runaway — **well defended.** Deterministic routing, fast paths, per-tier budgets, watchdog cost-baseline alerting. This is genuinely the strongest part of the design.

**What makes it indispensable:** one behavior. I text "what did we decide about the pricing model back in June" and four seconds later I get the answer with a link to the note. That single capability is worth the entire system. Everything else is scaffolding around it — and today it's scheduled last.

---

# Synthesis

## (a) Top pains, ranked by abandonment risk

1. **Review-queue accretion with no owner and no cap.** Thirteen features independently decided "surface it in the morning brief." 10–25 decisions a day against a real budget of five. Audit-not-gate becomes a gate enforced by guilt.
2. **Capture has no failure fallback.** HTTP-first with no offline queue until a premium app that doesn't exist. One silent drop ends the trust.
3. **Time-to-first-value is hours, and the wow moment sits behind the entire native tier.** Everything that can go wrong on Day 1 is between me and the reason to continue.
4. **Recall — the killer capability — is Phase 6.** The reason to keep going is scheduled after everything expensive, against the plan's own evidence that keyword search is the strong baseline.
5. **The compounding loop depends on me writing prose on my busiest days.** Six meetings, zero notes, empty distillation. The system starves exactly when I need it most.
6. **Native-tier fragility.** Three documented grant-rot variants; consent prompts that only render under launchd; status reads that lie from the wrong process tree.
7. **The work instance doubles maintenance** for a person with none spare — and the plan calls this "smaller than it sounds."
8. **Nothing is fixable from a phone.** Failures wait for the Mac.
9. **`gui/501` LaunchAgents + a watchdog that reports through the tier it monitors.** One reboot to the login window and the system is silently dead, including its own alarm.

## (b) Missing features, ranked by daily value

1. **Keyword/FTS recall in Phase 2, not Phase 6.** Highest value per hour of work in the entire plan.
2. **A shipped Capture Shortcut** — Siri phrase, dictation, Action Button, share sheet — **with a local-file fallback on failure.**
3. **Calendar-driven meeting-note pre-creation**, attendees pre-wikilinked, unknown people auto-stubbed as `draft`.
4. **A morning-brief spec**: hard decision cap (5), auto-expiry, consequence-ranked ordering, one owner.
5. **Batch proposal actions + a per-source accept-rate scorecard** with an offer to mute low performers.
6. **An ack with tier name** on any turn over ~5 seconds.
7. **Away mode + a "while you were gone" rollup** with auto-archive.
8. **Ops endpoints**: remote `doctor`, scoped component restart, actionable watchdog messages, external dead-man's-switch.
9. **Near-miss logging + generated `/help`** for fast-path phrasings.
10. **Local meeting transcription** — transcript into the vault, human-marked decisions, explicitly *no* auto-extraction (PoC-13's lesson).

## (c) Cumbersome flows, with fixes

| Flow | Now | Fix |
|---|---|---|
| Install | 2–4 hours, no value until the end | 10-minute core (compose + capture + fast path, zero TCC) → progressive capability unlock via `doctor` checklist |
| Init interview | unbounded question set at minute 3 | 4 questions; the rest arrive as one proposal a day |
| Morning triage | wall of text in Messages, actions in the PWA, 11+ taps | per-item deep links from the brief; cap at 5; batch actions; auto-expire the rest |
| Meeting notes | template + manual attendee wikilinks, post-meeting | pre-created from the calendar; auto-stub People notes |
| Agent proposals | continuous event-driven pushes | off by default; 2 digests/day; real-time only when an agent is *blocked*; §4.8 limits explicitly govern §4.18 |
| Return from vacation | 150–400 pending items | away mode; one rollup; auto-archive |
| Bridge failure while traveling | an alert I can't act on | degraded-vs-dead + the fix command + a restart endpoint |
| Fast-path miss | silent fallthrough | log the near-miss; generate `/help` from live rules |

## (d) Delighters worth protecting

- **Naming the assistant on first run.** The cheapest emotional win available, and it's already there.
- **Freshness stamps on every fast-path answer** ("as of 14 min ago"). Small, and it's why I'd trust the number.
- **`degrades: absent`.** Capability-off instead of mystery-error. Rare and correct.
- **Sole-writer vault via a restricted commit tool.** The thing that makes an AI-written vault trustworthy at all.
- **Audit-not-gate as a philosophy.** Right instinct — it just needs a cap and an expiry policy to stay true in practice.
- **The model-free watchdog.** Something that isn't the assistant can tell me the assistant is broken.
- **Leases that expire on their own.** The one queue in the system that degrades gracefully with zero attention. Make everything else work like this.
- **Deterministic router failing open to the model.** PoC-14 was run honestly and the invariant held. That discipline shows.
- **`metistry doctor` from a generic `check()` interface**, defined in Phase 1 before it ships.
- **The product/instance repo split.** Costly, and right.

## (e) Would this persona still be using Metistry in month 6?

Honestly: **not as designed — I'd be at maybe 30%, and the failure would be quiet rather than dramatic.** Nothing in the plan is wrong; the cost architecture is the best-defended I've seen and the security thinking is genuinely rare. What kills it is arithmetic nobody did. Thirteen features each reasonably chose "surface it in the morning brief," the one feature that would have put *new* information in that brief got gated by PoC-13, and the one capability that would make the whole thing indispensable — "what did we decide about X three weeks ago" — is scheduled dead last against the project's own evidence that keyword search would nearly cover it. So month 3 is a system that asks me for twelve confirmations a day and answers questions I could have answered myself. I wouldn't uninstall it. I'd just stop opening the PWA, and six weeks later notice the collectors had been dead for a month.

**The one change:** give the daily review a hard budget — **five decisions, auto-expiry on the rest, batch actions, and one owner for the total** — and make every feature that wants a slot compete for it. That converts the system from a chore into a tool, and it's the precondition for everything else mattering. (The close second, and the one that makes month 6 worth reaching: ship keyword recall in Phase 2. It's an afternoon of work, the research already argues for it, and it's the only behavior on the roadmap I'd genuinely miss.)

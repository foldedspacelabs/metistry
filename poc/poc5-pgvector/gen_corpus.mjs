#!/usr/bin/env node
// Synthetic PARA-style vault generator for PoC-5 (embed -> store -> retrieve mechanics test).
// Entirely fictional content: no real people, no real accounts, no real addresses.
// Run: node gen_corpus.mjs   (writes into ./corpus/, overwriting)

import { mkdirSync, writeFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(__dirname, "corpus");

if (existsSync(CORPUS_DIR)) {
  for (const f of readdirSync(CORPUS_DIR)) {
    if (f.endsWith(".md")) rmSync(join(CORPUS_DIR, f));
  }
} else {
  mkdirSync(CORPUS_DIR, { recursive: true });
}

const notes = []; // { slug, type, area, created, title, tags, body }

function add(slug, type, area, created, title, tags, body) {
  notes.push({ slug, type, area, created, title, tags, body: body.trim() });
}

function fm(n) {
  return `---
type: ${n.type}
area: ${n.area}
created: ${n.created}
tags: [${n.tags.join(", ")}]
---

# ${n.title}

`;
}

// ============================================================
// AREA NOTES (20) — 4 per area
// ============================================================

add("area-home-overview", "area", "home-maintenance", "2026-01-05",
  "Home Systems Overview", ["home", "reference"], `
Reference note for the house at 14 Aldergrove Court. Built 1998, single-family,
two-story, unfinished basement. Main systems: forced-air gas furnace (Trane
XR80, installed 2011) paired with a Trane XR13 AC condenser, a 50-gallon gas
water heater, asphalt shingle roof (last replaced 2016, expect 20-25 year
life), vinyl gutters with leaf guards added 2024, and a sump pump in the
basement crawlspace corner installed by the previous owner, age unknown.

Electrical panel is 200A, updated 2019 when the kitchen was rewired. Water
service is municipal, shutoff valve is in the basement utility room behind the
water heater. Gas shutoff is on the exterior wall near the meter, south side.

This note is the index — see the seasonal checklist for recurring tasks, and
individual system notes (water heater, HVAC) for service history and
model-specific details. Big-ticket replacement decisions live under their own
project notes rather than here.
`);

add("area-home-water-heater", "area", "home-maintenance", "2026-01-05",
  "Water Heater: Specs & Service History", ["home", "water-heater", "reference"], `
Current unit: Rheem Performance Platinum, 50-gallon, natural gas, installed by
Aldergrove Plumbing (Priya Larsen) in March 2016. Serial tag is on the side
panel above the gas control valve. Anode rod was checked and found intact at
the 2022 service; due for another check in 2027 per the 5-year rule of thumb.

Service history: annual flush every November since 2018 (skipped 2020).
Pressure relief valve tested and cycled cleanly at the November 2025 flush.
Recommended operating temperature is 120°F to balance scald risk against
Legionella risk; currently set to 118°F.

This unit is now 10 years old. Rheem's warranty on this model was 9 years on
the tank, 6 years on parts, both expired. Typical lifespan for a well-maintained
gas water heater in this water hardness range (moderately hard, per the last
municipal water report) is 10-13 years, so replacement planning should start
now even though there's no active fault. See the water heater replacement
project note for the actual decision and vendor quotes — this note is just the
specs and maintenance log for the unit currently installed.
`);

add("area-home-hvac-overview", "area", "home-maintenance", "2026-01-06",
  "HVAC System Overview", ["home", "hvac", "reference"], `
Forced-air system: Trane XR80 gas furnace (80,000 BTU, installed 2011) and a
matched Trane XR13 outdoor AC condenser. Ductwork is original to the house
(1998), insulated in the accessible basement runs but not in the attic
crossover — a known inefficiency, not currently budgeted to fix.

Thermostat is an ecobee (installed 2021), set to a schedule: 68°F weekday
mornings, 71°F evenings, 65°F overnight, with a vacation hold used for travel.

Filter size is 16x25x1 (MERV 11). Filters are changed on a schedule — see the
HVAC filter replacement technique note for the actual cadence and reasoning,
since it's more of a routine-habit thing than a reference fact. Annual
professional tune-up is scheduled every spring (AC check) and fall (furnace
check) with the same HVAC contractor that services the neighborhood, generally
in March and October.

The furnace is now 15 years old against a typical 15-20 year lifespan, so it's
on the same "start planning, not yet urgent" watch list as the water heater,
just not urgent enough for its own project note yet.
`);

add("area-home-seasonal-checklist", "area", "home-maintenance", "2026-01-06",
  "Seasonal Maintenance Checklist", ["home", "checklist", "reference"], `
Spring (March-April): AC tune-up, clean gutters after the last hard freeze,
check exterior caulking and re-caulk any cracked seams, inspect roof from the
ground with binoculars for lifted shingles, test sump pump by pouring a bucket
of water into the pit, flip and rotate mattresses.

Summer (June-July): check attic ventilation isn't blocked, inspect deck
boards for rot or popped fasteners, trim vegetation away from the AC
condenser and the foundation, check for wasp nests under the eaves.

Fall (September-November): furnace tune-up, flush the water heater, clean
gutters again after leaf drop, disconnect and drain exterior hose bibs before
first frost, check weatherstripping on exterior doors, replace HVAC filter.

Winter (December-February): monitor for ice dams after heavy snow, keep
cabinet doors under exterior-wall sinks open during cold snaps, test carbon
monoxide detectors monthly (year-round habit, listed here as a reminder
anchor), check for drafts around windows with a candle-flame test on a windy
day.
`);

add("area-finance-overview", "area", "personal-finance", "2026-01-08",
  "Personal Finance Overview", ["finance", "reference"], `
Index note for the personal finance area. Income is salaried plus occasional
freelance design work. Fixed monthly obligations: mortgage, one auto loan
(paid off projected mid-2027), utilities, insurance premiums (auto, home,
umbrella). No credit card debt carried month to month — cards are used for
points and paid in full via autopay.

Overall approach: automate savings first, budget the rest loosely rather than
tracking every category to the dollar. See the account map for where money
actually lives, the emergency fund policy for the cash-cushion rules, and the
two budgeting-method technique notes (zero-based vs envelope) which were both
tried at different points — the zero-based method is the one currently in use,
envelope is kept as a note for reference in case it's revisited.

Annual financial checkpoints: rebalance investment allocation each January
(see the 2026 rebalancing project), review insurance coverage each summer,
and do a full net-worth snapshot every December.
`);

add("area-finance-emergency-fund", "area", "personal-finance", "2026-01-08",
  "Emergency Fund Policy", ["finance", "savings", "reference"], `
Target: 6 months of essential fixed expenses (mortgage, utilities, insurance,
groceries, minimum debt payments), calculated at roughly $4,200/month,
so the target balance is $25,200. Current balance as of the last check
(January 2026) is $24,600 — effectively at target.

Held entirely in a single high-yield savings account at Northfield Credit
Union, currently earning 4.35% APY, chosen after the comparison documented in
the HYS account comparison note. The policy is to keep the whole emergency
fund in one liquid account rather than splitting it across a savings account
and a short-term CD ladder, on the reasoning that the marginal yield from
laddering isn't worth the loss of same-day liquidity for something whose whole
purpose is being available instantly.

Replenishment rule: if the fund is drawn down for an actual emergency, the
next three months of "extra" savings (anything beyond retirement
contributions) go entirely to refilling it before any other savings goal,
including the rebalancing or house-project funds, gets anything.
`);

add("area-finance-accounts", "area", "personal-finance", "2026-01-09",
  "Account Map: Banks & Brokerages", ["finance", "reference"], `
Checking: Meridian Bank, primary transaction account, direct deposit lands
here, autopay for fixed bills draws from here.

Savings: Northfield Credit Union high-yield savings, holds the emergency fund
(see emergency fund policy) plus a rotating "house projects" sinking fund,
currently around $8,000 earmarked for the kitchen remodel.

Brokerage: Fenwick Harbor Investments taxable brokerage account, opened 2019,
holds a three-fund-style portfolio (total US market, total international,
bond index) plus a small legacy position in a single tech stock from an old
employee stock purchase plan that hasn't been sold yet for tax reasons.

Retirement: employer 401(k) through the same Fenwick Harbor platform,
contributing enough to get the full 5% employer match; separate Roth IRA also
at Fenwick Harbor, maxed most years.

The brokerage account's target allocation and the reasoning behind the current
rebalance are covered in the 2026 rebalancing project notes, not here — this
note is purely "what account is where."
`);

add("area-finance-hys-comparison", "area", "personal-finance", "2026-01-10",
  "High-Yield Savings Account Comparison", ["finance", "savings", "research"], `
Compared four options before settling on Northfield Credit Union for the
emergency fund in late 2025:

Northfield Credit Union: 4.35% APY, no minimum balance, six free
transfers/month, insured via NCUA, existing relationship (checking is
elsewhere but an old auto loan was through them so the account was easy to
open with prior history).

Meridian Bank "Premier Save": 3.10% APY, but the checking account is already
there so transfers are same-institution instant.

Harborline Digital Bank: 4.50% APY, highest rate found, but online-only with
no phone support and mixed reviews about withdrawal delays during high-volume
periods.

Coastal Federal: 4.20% APY, required $10,000 minimum to avoid a monthly fee.

Decision was Northfield over Harborline despite the 0.15% rate gap, trading a
small amount of yield for support responsiveness on an account that's supposed
to be the "break glass in an actual emergency" fund — not the place to
optimize for an extra fifteen basis points if it comes with any withdrawal
friction risk.
`);

add("area-cartograph-overview", "area", "product-cartograph", "2026-01-12",
  "Cartograph Product Overview", ["cartograph", "product", "reference"], `
Cartograph is a personal knowledge-mapping app — think networked notes plus a
visual canvas for connecting them, aimed at researchers, writers, and grad
students who outgrow flat note-taking apps but find pure graph-database tools
too fiddly. Solo side project turned small paid product, currently pre-revenue
in its v2 rebuild, with v1 having run as a free beta for about a year.

Core loop: capture a note, link it to other notes with typed connections
("supports", "contradicts", "example-of"), and view any note's neighborhood as
a graph. The canvas view is the differentiator against plain-text tools like
Obsidian; the typed-link model is the differentiator against generic
whiteboard tools like Miro.

Team is two people: this note's author (product + backend) and Ana Ferreira
(design + frontend), working part-time alongside day jobs. See the user
personas, competitive landscape, and metrics notes for more detail on each of
those areas, and the v1 retro / v2 launch project notes for the actual product
decisions and their history.
`);

add("area-cartograph-users", "area", "product-cartograph", "2026-01-13",
  "Cartograph User Personas", ["cartograph", "product", "personas"], `
Three personas emerged from the v1 beta's ~40 active users:

"The Synthesizer" — grad students and researchers building a literature map
for a thesis or paper. Highest engagement, most typed links per note, most
likely to complain about performance on large graphs (500+ notes). Ingrid
Solberg (beta advisor) is a good proxy for this persona.

"The Serial Journaler" — daily-note habit, wants Cartograph mainly for the
canvas view of how their journal entries connect over time. Lower link
density, higher note count, most sensitive to capture friction (how fast can
they get a thought down).

"The Dabbler" — signed up, imported a handful of notes, never came back.
Roughly 60% of v1 signups. Not a target for v2 prioritization, but worth
understanding the drop-off point (usually: never made their first link).

V2 prioritization has been "Synthesizer" and "Serial Journaler" retention,
explicitly deprioritizing Dabbler activation for now.
`);

add("area-cartograph-competitors", "area", "product-cartograph", "2026-01-14",
  "Cartograph Competitive Landscape", ["cartograph", "product", "competitors"], `
Direct-ish competitors, in order of how often they come up in user interviews:

Obsidian — the most common prior tool among Synthesizer-persona users.
Strength: huge plugin ecosystem, local-first files. Weakness cited by our
users: graph view is a byproduct, not a first-class typed-link canvas; no
native way to say a link "supports" vs "contradicts" something.

Roam Research — bidirectional links pioneer, strong among the same audience a
few years back, but users cite reliability concerns and a stalled roadmap.

Tana — closest philosophical competitor (structured, typed data), but steeper
learning curve and no real canvas view.

Miro / Whimsical — used by some Serial Journaler-persona users for the visual
side, paired with a separate notes app for the writing side. Our pitch to
these users is consolidating both into one tool.

See the pricing project note for how this landscape fed into the pricing
model decision — short version: undercut Tana, price above Obsidian's free
tier but justify it with the canvas.
`);

add("area-cartograph-metrics", "area", "product-cartograph", "2026-01-15",
  "Cartograph Key Metrics Dashboard Notes", ["cartograph", "product", "metrics"], `
Metrics tracked weekly during the v1 beta, kept here as a reference for what
"good" looked like before the v2 rebuild reset most numbers to zero:

Activation: % of signups who create at least one typed link within 7 days.
V1 baseline settled around 38% by the end of the beta after onboarding
tweaks (started around 22%).

W4 retention: % of activated users still creating notes in week 4. V1
baseline ~51%.

Graph size at churn: median note count when a user went inactive was 12 —
suggests the "aha moment" of a genuinely useful graph needs more like 30-40
notes, and most churned users never got there.

Performance complaint threshold: canvas rendering complaints started
appearing consistently above ~400 notes in a single graph on typical beta-user
hardware, which directly informed the v2 rendering-performance requirement.

V2 doesn't have real numbers yet (see the v2 launch status note for where
that stands) — this note will get a fresh set of baselines once v2 has beta
users again.
`);

add("area-health-overview", "area", "health-fitness", "2026-01-18",
  "Health & Fitness Overview", ["health", "fitness", "reference"], `
General health baseline as of early 2026: resting heart rate around 54 bpm,
blood pressure last checked at 116/74 (well within normal), no chronic
conditions. Primary care physician is Dr. Elena Vasquez; see her person note
for visit history.

Fitness split roughly into three threads: running (currently training for a
marathon, see that project), general strength training twice a week
(bodyweight plus a home dumbbell set, following a progressive-overload
approach), and mobility work a few times a week, partly motivated by the
tennis elbow flare-up from last year.

Sleep and nutrition are tracked loosely rather than rigorously — see the
sleep tracking and nutrition baseline notes respectively. The overall
philosophy is "good enough consistency beats perfect tracking that burns out
in six weeks," which is a lesson from two prior attempts at more rigorous
tracking that both fizzled after about two months.
`);

add("area-health-sleep", "area", "health-fitness", "2026-01-19",
  "Sleep Tracking Notes", ["health", "sleep", "reference"], `
Tracked via a wrist wearable since late 2024. Baseline average is 7h10m of
total sleep, with average sleep efficiency around 89%. Typical bedtime drifts
between 10:45pm and 11:30pm depending on the day; wake time is fairly fixed at
6:30am on weekdays for the marathon training runs.

Clear pattern in the data: nights following a hard interval run session show
noticeably more deep sleep (often 20-30% more than baseline) but slightly
worse sleep efficiency, likely from mild soreness causing more overnight
movement.

Caffeine cutoff of 2pm was tested against no cutoff for about six weeks each
in late 2025 — the cutoff period showed meaningfully better sleep efficiency
(92% vs 86%), which is the main reason the 2pm rule stuck. Alcohol shows the
expected effect: any evening with more than one drink correlates with
reduced deep sleep and higher resting heart rate overnight, consistently
enough in the personal data to just treat it as a rule rather than
re-litigate it each time. See the sleep hygiene technique note for the actual
habits, this note is the tracking data and observations.
`);

add("area-health-nutrition", "area", "health-fitness", "2026-01-19",
  "Nutrition Baseline Notes", ["health", "nutrition", "reference"], `
No formal calorie tracking currently — tried it twice (2023, 2024) and both
attempts fizzled within two months due to the logging friction. Current
approach is simpler: protein target of roughly 120-140g/day tracked loosely
by counting protein-dense meals rather than logging grams, and a "plants at
every meal" habit rather than macro tracking for anything else.

Meal prep happens most Sundays (see the meal prep technique note) which
covers lunches for the work week. Breakfast is usually consistent (oats,
yogurt, fruit) and doesn't need planning. Dinners are the least structured
meal and the most likely to be takeout on a long training week.

During marathon training blocks, carbohydrate intake is deliberately bumped
up on long-run days (Saturdays), informally rather than with precise
carb-loading protocols — that level of precision has been judged not worth
it for a recreational marathon goal versus a competitive one.
`);

add("area-health-injury-log", "area", "health-fitness", "2026-01-20",
  "Injury & Recovery Log", ["health", "injury", "reference"], `
Running log of injuries and recovery status, most recent first:

Right knee, mild patellar tendon irritation — flagged during week 6 of
marathon training (see that project's status note), managed with reduced
mileage for one week and extra calf/quad mobility work, resolved without
missing a long run.

Left shoulder impingement — started spring 2025 from poor desk posture during
a heavy work stretch, addressed through a structured PT plan with Dr. Naomi
Chen over about 10 weeks, mostly resolved by summer 2025, occasional stiffness
remains if a work week involves unusually long screen sessions without
breaks.

Right elbow (tennis elbow / lateral epicondylitis) — onset late 2024,
unrelated to actually playing tennis, more likely from a combination of
keyboard/mouse ergonomics and an overenthusiastic return to strength training
after a long break. Recovered over about 4 months with eccentric wrist
extensor exercises and a temporary reduction in upper-body pressing volume.
Full detail in the separate person/journal notes referencing Dr. Chen's PT
plans for both the shoulder and elbow issues.
`);

add("area-travel-overview", "area", "travel", "2026-01-22",
  "Travel Overview & Preferences", ["travel", "reference"], `
Roughly two trips a year: one bigger international trip, one smaller
domestic or short-haul trip, budget permitting. Preference is for
mid-range accommodation (not hostels, not luxury), self-guided exploration
over group tours, and at least one full "no plans" day per week of travel to
avoid the itinerary turning into a second job.

Booking approach: flights booked 2-4 months out watching for price drops,
accommodations booked closer to departure once the day-by-day rough plan is
set, activities mostly booked on arrival except for anything with limited
capacity (specific museum timed-entry tickets, popular restaurant
reservations).

Travel rewards points are tracked separately (see that note) and used
opportunistically rather than chased — no active pursuit of a specific credit
card's minimum spend bonus, more "use points if a trip happens to line up
with what's available."

Current active planning: two trips being compared/planned for later this
year, Japan and Portugal — see their respective project notes.
`);

add("area-travel-passport-docs", "area", "travel", "2026-01-22",
  "Passport & Travel Documents", ["travel", "reference"], `
Passport renewed 2023, valid through 2033. No visa requirements currently
relevant to the two trips under consideration (Japan, Portugal) for a
short-stay tourist visit on this passport.

Travel insurance is purchased per-trip rather than as an annual policy,
generally through the same comparison site, prioritizing medical evacuation
coverage over trip-cancellation coverage since the trips are usually flexible
enough to eat a cancellation cost if needed, but medical evacuation abroad
would be a genuinely large expense without coverage.

International driving permit obtained ahead of past trips that involved
renting a car; not expected to be needed for either the Japan or Portugal
trip currently being planned since both plans lean on train/transit and
walking rather than a rental car.

Standard document-copies routine before any international trip: photograph
passport and any ID cards, store encrypted copies accessible offline, leave a
physical photocopy with a family member.
`);

add("area-travel-points", "area", "travel", "2026-01-23",
  "Travel Rewards & Points Tracking", ["travel", "reference"], `
Two active points programs: an airline miles program through the carrier used
most for domestic trips (currently around 42,000 miles), and a flexible
travel-bank points program tied to a rewards credit card (currently around
118,000 points).

Redemption philosophy: flexible points get used for whichever trip needs the
most help affordability-wise that year, airline miles get used on that
specific airline's routes when convenient rather than hoarded, since airline
miles tend to devalue over time faster than flexible points do.

For the trips currently being planned, the flexible points balance is large
enough to meaningfully offset either the Japan or Portugal flights but not
both — this is one of the inputs into whichever trip gets chosen and booked
first, discussed in more detail in the budget/constraints notes for each trip
project.

Points expiration: airline miles expire after 24 months of no account
activity; flexible points don't expire as long as the card account stays
open.
`);

add("area-travel-packing-base", "area", "travel", "2026-01-23",
  "Base Packing List", ["travel", "reference"], `
Baseline packing list that gets adapted per-trip rather than rebuilt from
scratch each time (see the packing list technique note for the actual method
of adapting it):

Documents pouch: passport, ID, printed/offline copies of confirmations,
one physical credit card as backup to the primary card.

Electronics: phone + charger, a compact charging brick with two USB-C ports,
a universal adapter (only needed for non-North-American plugs), earbuds,
a paperback or e-reader for flights.

Clothing base: built around a limited color palette so everything mixes,
one layer for weather variance, one "presentable" outfit for any nicer
dinner, comfortable walking shoes broken in well before departure — never
new shoes on a trip, a lesson learned the hard way on a past trip that ended
in blisters by day two.

Toiletries: travel-sized only, refilled from full-size bottles at home
rather than buying new travel bottles each trip.
`);

// ============================================================
// PROJECT NOTES (32) — decisions/constraints/status per project
// ============================================================

// --- Cartograph v2 launch ---
add("proj-cartograph-v2-decision-search-backend", "project", "product-cartograph", "2026-02-02",
  "Cartograph v2 Decision: Search Backend", ["cartograph", "decision", "v2"], `
Decision: for Cartograph v2, semantic search over notes will run on Postgres
with the pgvector extension, not a dedicated vector database (evaluated
Pinecone and Weaviate) and not Elasticsearch with a dense-vector field
(which is what a prototype briefly used).

Reasoning: v2's whole data layer is already moving to a single managed
Postgres instance to simplify ops for a two-person team, and pgvector's HNSW
index (added in pgvector 0.5) closes most of the recall/latency gap against
dedicated vector DBs at the scale Cartograph actually operates at — the
largest beta user's graph was under 3,000 notes. Running one database instead
of two also means one thing to back up, one thing to monitor, and one
connection pool to reason about.

Trade-off accepted: if a future large-enterprise tier ever needs
tens-of-millions-of-vectors scale, this decision would need revisiting — but
that's explicitly not the problem being solved in 2026. Embedding model
chosen: a local/self-hostable embedding model so per-note embedding cost
doesn't scale with an external API bill as the user base grows.
`);

add("proj-cartograph-v2-constraints", "project", "product-cartograph", "2026-02-03",
  "Cartograph v2 Constraints", ["cartograph", "constraints", "v2"], `
Hard constraints for the v2 rebuild, agreed with Ana before scoping began:

Team capacity: both of us are part-time on this (evenings/weekends around day
jobs), so the v2 scope has to fit roughly 10-12 hours/week combined for an
estimated 4-month build. Anything that doesn't fit that budget gets cut, not
deferred-with-a-plan-to-somehow-still-do-it.

Performance: canvas view must stay smooth (target 30fps interaction) up to
1,000 notes in a single graph on mid-range hardware — set based on the v1
metrics note showing complaints starting around 400 notes, giving headroom.

Explicitly cut from v2 scope: real-time collaborative editing (multiple users
editing the same graph simultaneously) — big engineering lift, and the user
research showed the Synthesizer and Serial Journaler personas are both
fundamentally solo-use cases. Also cut: mobile native apps, v2 ships
web-only with a responsive layout, native apps revisited only if there's
real retention data justifying the investment.

Budget: no paid infrastructure beyond a single small managed Postgres
instance and static hosting until there's paying revenue.
`);

add("proj-cartograph-v2-status", "project", "product-cartograph", "2026-08-10",
  "Cartograph v2 Status Update", ["cartograph", "status", "v2"], `
As of August 2026: core canvas rendering and the typed-link model are done
and stable. Semantic search over notes (the pgvector-backed feature) is
implemented and working in dev, currently being tuned for relevance — early
internal testing shows keyword-shaped queries work well but natural-phrasing
questions sometimes surface a topically-related note instead of the most
directly relevant one, which matches expectations for embedding-based
retrieval and just needs a bit of chunking/prompt tuning before opening back
up to beta users.

Not yet started: the onboarding flow rebuild (v1's 22%-to-38% activation
improvement came from onboarding tweaks, and v2's onboarding is currently
just a blank canvas, worse than v1's starting point).

Timeline: original estimate was a 4-month build starting February 2026,
currently tracking about 6 weeks behind that, mostly due to the search
relevance tuning taking longer than scoped. Revised target for reopening a
private beta is October 2026.
`);

// --- Cartograph v1 retro ---
add("proj-cartograph-v1-decision-search-backend", "project", "product-cartograph", "2025-09-10",
  "Cartograph v1 Decision: Search Backend", ["cartograph", "decision", "v1"], `
Decision made during v1's build (mid-2025): search over notes would be plain
Postgres full-text search (tsvector/tsquery with a GIN index), not semantic
search at all. Semantic/vector search was explicitly deferred to a later
version.

Reasoning at the time: v1 was scoped as a fast beta to validate the core
typed-link canvas concept, and full-text search is close to zero additional
infrastructure on top of the Postgres database v1 already needed — no new
extension, no embedding model to run, no embedding cost or latency. The bet
was that early beta users would tolerate keyword search while the actual
differentiator (the canvas) got validated.

That bet mostly paid off — search quality was rarely cited as a complaint in
v1 beta feedback, "can't find that note I know I wrote" was mentioned by a
handful of Synthesizer-persona users with large graphs, which became one of
the inputs into prioritizing real semantic search (via pgvector) for v2. See
the v2 search backend decision note for what replaced this.
`);

add("proj-cartograph-v1-retro", "project", "product-cartograph", "2026-01-30",
  "Cartograph v1 Retro & Learnings", ["cartograph", "retro", "v1"], `
Retro written at the close of the v1 beta, feeding into v2 scoping.

What worked: the typed-link canvas was the clear differentiator and got
consistently positive reaction in interviews — nobody asked "why not just use
Obsidian" once they'd tried linking two notes with a typed relationship.
Full-text search (see that decision note) was an acceptable v1 shortcut.

What didn't work: onboarding had a rough start (22% activation) before
tweaks got it to 38% — the early version required users to understand the
typed-link concept before their first action, and simplifying the first note
to "just write something" before introducing links fixed most of the
drop-off. Performance degraded noticeably above ~400 notes per graph,
becoming the top complaint from the highest-value Synthesizer users.

Biggest learning for v2 scoping: build for the Synthesizer and Serial
Journaler personas specifically rather than trying to also fix Dabbler
activation — the data didn't support Dabbler churn being fixable with product
changes, it looked more like an audience-fit issue.
`);

add("proj-cartograph-v1-status-final", "project", "product-cartograph", "2026-01-31",
  "Cartograph v1 Final Status", ["cartograph", "status", "v1"], `
V1 beta formally closed January 2026 after roughly 13 months running. Final
numbers: 104 total signups, 40 activated (created a typed link within 7
days), 38% activation rate matching the metrics note baseline. Beta was free
throughout, no monetization attempted in v1 by design.

All beta users were emailed about the v2 rebuild and told search/performance
issues were being addressed; roughly a third replied with interest in being
re-invited when v2 reopens. The beta environment stays up in read-only mode
(no new signups, existing users can still view/export their data) through the
v2 build so nobody loses access to their graph.

This note marks v1 as closed; v2's status lives in its own status-update
note and gets updated as the rebuild progresses, this one won't be touched
again except to link the eventual v2 launch announcement.
`);

// --- Cartograph pricing ---
add("proj-cartograph-pricing-decision", "project", "product-cartograph", "2026-03-05",
  "Cartograph Pricing Model Decision", ["cartograph", "decision", "pricing"], `
Decision: Cartograph v2 launches with a single paid tier at $8/month or
$72/year (25% discount for annual), no free tier beyond a 14-day trial. No
usage-based metering (e.g. per-note or per-graph pricing) — flat subscription
regardless of graph size, at least until there's real data on whether large
graphs meaningfully increase infrastructure cost per user.

Reasoning: the competitive analysis showed Tana priced around $10-12/month
for comparable functionality and Obsidian's core app is free with paid sync
around $4-8/month depending on tier. Landing at $8/month positions Cartograph
below Tana (justified by Tana's steeper learning curve being a real cost to
users) while asking a premium over Obsidian's free core, justified by the
canvas being the actual differentiator rather than a bolt-on.

Rejected alternative: freemium with a note-count cap. Rejected because it
would specifically penalize the highest-value Synthesizer persona (large
graphs) right when they're most engaged, which is the opposite of what
retention data says to optimize for.
`);

add("proj-cartograph-pricing-competitor-analysis", "project", "product-cartograph", "2026-03-01",
  "Cartograph Competitor Pricing Analysis", ["cartograph", "research", "pricing"], `
Pricing research done ahead of the v2 pricing decision:

Obsidian: core app free forever (local-first), optional Sync add-on
$4/month (or $8/month for a higher-tier plan with version history), optional
Publish add-on separate. No forced subscription for core functionality —
sets a strong free anchor in this market.

Roam Research: subscription-only, no meaningful free tier, historically
around $15/month or a discounted annual plan — priced high relative to
current market expectations, cited by several interviewed users as a reason
they left.

Tana: freemium with a low free-tier cap, paid tier around $10-12/month for
individuals, higher for team plans with real-time collaboration (which
Cartograph v2 explicitly isn't building, see the v2 constraints note).

Miro: not a direct competitor but relevant as the "visual canvas" price
anchor for some users — free tier plus paid tiers starting around $8-10/month
per user for a full-featured plan.

This research is the direct input to the pricing decision note — see that
note for where Cartograph landed and why.
`);

add("proj-cartograph-pricing-status", "project", "product-cartograph", "2026-03-10",
  "Cartograph Pricing Status", ["cartograph", "status", "pricing"], `
Pricing page copy drafted, not yet live since v2 hasn't reopened for beta
signups. Plan is to launch pricing simultaneously with the v2 private beta
reopening (targeted October 2026 per the v2 status note), not before.

Billing implementation: decided to use a standard third-party billing
provider for subscription management rather than building custom billing
logic, to avoid spending the limited part-time engineering budget (see v2
constraints) on payments infrastructure instead of the product itself.

Open question, not yet decided: whether v1 beta users who reply with
interest get a discount or an extended trial when v2 reopens, versus paying
full price like new signups. Leaning toward a modest loyalty discount but
this isn't finalized and doesn't need to be until closer to the October
target.
`);

// --- Home office renovation ---
add("proj-homeoffice-decision-layout", "project", "home-maintenance", "2026-04-02",
  "Home Office Renovation: Layout Decision", ["home", "renovation", "decision"], `
Decision: the spare bedroom (currently used as a half-office, half-storage
room) will be converted into a dedicated home office, with the desk
positioned along the north wall (away from the window) rather than facing
the window, based on video-call lighting and avoiding afternoon glare on the
monitor.

Storage currently in that room is being redistributed: seasonal decorations
move to a basement shelving unit, off-season clothing moves to the primary
bedroom closet's top shelf, and only office-relevant material stays in the
room. A wall-mounted shelving unit replaces the current freestanding
bookshelf to free up floor space, since the room is on the smaller side
(roughly 10x11 feet).

Flooring stays as-is (existing carpet in acceptable condition), paint gets
refreshed from the current builder-beige to a warmer neutral. This project
is scoped as cosmetic/furniture-level, not structural — no electrical or
plumbing work involved, unlike the kitchen remodel project running roughly
in parallel.
`);

add("proj-homeoffice-constraints-budget", "project", "home-maintenance", "2026-04-02",
  "Home Office Renovation: Budget & Constraints", ["home", "renovation", "constraints"], `
Budget cap: $2,500 total, funded out of general savings rather than the
house-projects sinking fund (that fund is earmarked for the kitchen remodel).
Rough allocation: $600 paint and prep, $900 desk and shelving, $500
lighting (a proper desk lamp plus fixing the room's single weak overhead
fixture), $500 buffer.

Timeline constraint: needs to be done in a single weekend push (not spread
across weeks) since the room needs to be unusable for at most 2-3 days to
avoid too much disruption to actual work-from-home days — this rules out
anything requiring a contractor with a multi-week lead time, so it's a DIY
project.

No structural, electrical, or plumbing changes in scope — if the overhead
lighting fix turns out to need actual electrical work beyond a fixture swap,
that gets punted to a future project rather than expanding this one's scope.
This is a firm rule after past experience with the kitchen remodel's permit
delays on a project that was originally supposed to be simple.
`);

add("proj-homeoffice-status-progress", "project", "home-maintenance", "2026-05-18",
  "Home Office Renovation: Progress Update", ["home", "renovation", "status"], `
Week 3 update: painting done (two coats, the warmer neutral color reads
well in both morning and evening light, good call moving away from the
builder-beige). Old freestanding bookshelf removed and donated. Storage
redistribution from the layout-decision note is complete — basement shelving
now holds the seasonal decorations, closet holds the off-season clothing.

Desk and wall-mounted shelving ordered, delivery expected next week. Lighting
fix turned out to be simple (existing fixture just needed a different bulb
type and a dimmer switch swap, no electrical work beyond that), so the
"punt to a future project" contingency in the constraints note wasn't
needed.

Currently tracking under budget: roughly $1,800 spent against the $2,500 cap
so far, with desk/shelving delivery being the last major expense expected.
On pace to finish within the single-weekend-disruption constraint once
furniture arrives — assembly weekend is tentatively set for early June.
`);

// --- Kitchen remodel ---
add("proj-kitchen-decision-cabinets", "project", "home-maintenance", "2026-03-20",
  "Kitchen Remodel: Cabinet Decision", ["home", "renovation", "decision"], `
Decision: reface existing cabinet boxes with new shaker-style doors and new
hardware, rather than a full cabinet replacement. The existing boxes are
solid (checked for water damage and structural soundness, none found) and a
full replacement quote came back around $18,000 versus roughly $6,500 for a
quality refacing job, for a kitchen where the layout itself isn't changing.

Countertop decision (bundled into the same contract): quartz replacing the
current laminate, since quartz was preferred over both granite (more
maintenance, needs periodic sealing) and butcher block (not durable enough
around the sink area) after comparing samples in the kitchen's actual light.

Layout is staying the same — no wall removal, no moving the sink or range.
This keeps the project out of the territory that would require significant
plumbing/electrical rework, which matters given the permit delay experience
described in the permit constraints note.
`);

add("proj-kitchen-constraints-permit", "project", "home-maintenance", "2026-03-22",
  "Kitchen Remodel: Permit & Constraints", ["home", "renovation", "constraints"], `
Budget: $22,000 total, funded from the house-projects sinking fund
(currently around $8,000, topped up with savings across the project) plus a
small home-improvement loan for the remainder.

Permit situation: the county requires a permit for the electrical work
involved in adding two additional outlets and upgrading under-cabinet
lighting, even though the overall project avoids moving plumbing or gas
lines. Permit application submitted early March, approval took nearly 5
weeks (longer than the contractor's usual 1-2 week estimate) due to a county
backlog — this delay is the direct source of the "no scope creep into
permit-requiring territory" rule now applied to the home office project.

Contractor is licensed and the same one used for the water heater install
originally, chosen partly on that existing trust relationship rather than a
fresh three-quote comparison, which in hindsight might have been worth doing
given how the permit timeline went.
`);

add("proj-kitchen-status-progress", "project", "home-maintenance", "2026-05-20",
  "Kitchen Remodel: Progress Update", ["home", "renovation", "status"], `
Week 3 of active construction (after the ~5-week permit delay pushed the
actual start later than planned): cabinet boxes refaced and doors installed,
reading well against the quartz samples chosen earlier. Electrical rough-in
for the two new outlets and under-cabinet lighting passed inspection.

Quartz countertop template was taken this week; fabrication typically runs
10-14 days, so installation is expected in about two weeks. Kitchen is
currently non-functional (no countertops, sink disconnected) — using a
temporary setup in the dining room for basic meal prep, which is the kind of
prolonged disruption the home office project was specifically designed to
avoid by keeping to a single weekend.

Budget tracking close to plan: roughly $14,000 spent of the $22,000 cap so
far, on pace to land within budget assuming no surprises during countertop
install or final electrical inspection.
`);

// --- Water heater replacement ---
add("proj-waterheater-decision-replace", "project", "home-maintenance", "2026-06-01",
  "Water Heater Replacement Decision", ["home", "water-heater", "decision"], `
Decision: replace the current 10-year-old Rheem gas water heater proactively
this summer rather than waiting for it to fail, and upgrade to a Rheem
Performance Platinum hybrid heat pump water heater (still 50-gallon) rather
than a like-for-like gas tank replacement.

Reasoning: per the water heater reference note, this unit is at the edge of
its typical 10-13 year lifespan with no active fault, but replacing on a
schedule avoids the classic "fails on a Sunday, water damage while waiting
for an emergency plumber" scenario. Priya Larsen (the plumber who installed
the original unit) quoted $2,400 for a like-for-like gas replacement versus
$3,800 for the heat pump model after a $600 utility rebate; the heat pump
option was chosen despite the higher upfront cost because Northfield's
electricity rates plus the projected efficiency gain pencil out to roughly a
5-year payback versus the gas option, and it also drops one more gas
appliance from the house ahead of a possible future full electrification
project.
`);

add("proj-waterheater-status", "project", "home-maintenance", "2026-06-15",
  "Water Heater Replacement Status", ["home", "water-heater", "status"], `
Installed June 12, 2026 by Aldergrove Plumbing (Priya Larsen), same
contractor as the original 2016 install and the kitchen remodel. Old unit
was drained and hauled away same day, no issues found on removal that would
have suggested imminent failure — replacement really was proactive rather
than reactive, consistent with the decision note's reasoning.

New unit needs about 3 feet of clearance for airflow (heat pump water
heaters pull ambient heat from the surrounding air), which required moving a
storage shelf in the basement utility room — minor, unplanned but cheap
adjustment, not worth its own project note.

Utility rebate paperwork submitted, $600 expected to process within 6-8
weeks. First utility bill under the new unit not yet available to compare
against the gas-heater baseline; that comparison will get added here once a
full billing cycle has passed, to sanity-check the 5-year payback estimate
from the decision note.
`);

// --- Marathon training block ---
add("proj-marathon-plan", "project", "health-fitness", "2026-04-10",
  "Marathon Training Block: Plan", ["health", "running", "training"], `
16-week training block for a full marathon, following a standard
three-runs-plus-one-long-run-per-week structure: one interval/speed session,
one tempo run, one easy recovery run, and the long run on Saturdays,
building from 8 miles up to a 20-mile peak long run around week 14 before a
3-week taper.

Weekly mileage progresses from roughly 25 miles/week at the start to a peak
around 45 miles/week, following a standard 10%-ish weekly increase with a
cutback week every fourth week. Coach Sarah Ilves reviewed and adjusted the
plan template, mainly to account for the shoulder-impingement and tennis
elbow history by keeping strength training to twice a week rather than three
times during the peak-mileage weeks.

Race chosen after comparing two options (see the race-choice decision note)
— an early-fall flat road marathon was picked over a hillier one specifically
picked as a good first-marathon course given the goal is finishing strong
rather than chasing a specific time.
`);

add("proj-marathon-decision-race", "project", "health-fitness", "2026-04-08",
  "Marathon Training: Race Choice Decision", ["health", "running", "decision"], `
Decision: registered for the early-fall flat road marathon rather than the
hillier trail-adjacent option that was also under consideration. Reasoning:
this is a first marathon, and the goal is a strong, injury-free finish over a
fast or scenic course. The flat course also better matches the training
routes available locally, which are mostly flat river-path miles, so
race-day terrain will closely match training terrain — the hillier option
would have meant most training runs not resembling race conditions at all.

Secondary factor: the flat marathon's date lines up better with the existing
travel plans under consideration (see the Japan and Portugal trip notes) —
whichever trip gets booked, the race date doesn't conflict with either
option's likely travel window, whereas the hillier race's date would have
overlapped with the Portugal trip's most likely timing.
`);

add("proj-marathon-status-week8", "project", "health-fitness", "2026-06-05",
  "Marathon Training: Week 8 Status", ["health", "running", "status"], `
Halfway through the 16-week block. Mileage on track, currently around 35
miles/week against the plan's roughly 36-mile target for this week. Long
runs have been consistent — last Saturday's 14-miler felt comfortable at
the planned easy pace.

One flag: mild right knee patellar tendon irritation noticed after the week 6
long run (logged in the injury log). Addressed with a slightly reduced week
7 mileage and extra calf/quad mobility work rather than a full rest week;
resolved cleanly, no recurrence in week 8's runs. Coach Sarah adjusted week
9's speed session slightly as a precaution (swapped one interval session for
a hill-repeat session, lower impact per the physio-adjacent research she
cited).

Sleep data (per the sleep tracking note) continues to show the expected
pattern of better deep sleep but slightly lower efficiency after hard
sessions — nothing concerning, consistent with the established baseline.
`);

// --- Half-marathon training block (separate, earlier, smaller race) ---
add("proj-halfmarathon-plan", "project", "health-fitness", "2025-11-01",
  "Half-Marathon Training Block: Plan", ["health", "running", "training"], `
12-week training block for a half-marathon, run in late 2025 as a tune-up
before deciding whether to commit to the full marathon training block that
followed in spring 2026. Structure: two quality sessions per week (one
speed, one tempo) plus a long run building from 6 miles to a 11-mile peak
around week 10, with a 2-week taper.

Weekly mileage progressed from about 18 miles/week to a peak around 30
miles/week. This block predates working with coach Sarah Ilves — training
plan was self-designed from a standard template rather than coached, partly
as a lower-stakes way to test whether structured training was sustainable
before paying for coaching on the bigger marathon commitment.

Explicit goal for this block was completion and enjoyment, not time — no
specific finish-time target was set, deliberately, to keep the tune-up
low-pressure.
`);

add("proj-halfmarathon-decision-taper", "project", "health-fitness", "2025-12-20",
  "Half-Marathon Training: Taper Adjustment Decision", ["health", "running", "decision"], `
Decision made during week 10 of the half-marathon block: shorten the taper
from the originally planned 2 weeks to an effective 10 days, because the peak
long run (11 miles, week 10) felt notably easier than expected and there was
concern that a full 2-week taper would lead to feeling flat or sluggish on
race day rather than sharp.

This was a self-coached, somewhat improvised call (again, before coach Sarah
was involved) based on how previous non-running fitness blocks had responded
to over-long tapers — a pattern noticed anecdotally rather than from
running-specific data, since this was the first structured running block.
In hindsight, logged as a "worked out fine but was more improvisation than
principled decision" note, and taper planning was handed over to Sarah's
judgment for the subsequent marathon block rather than repeating the
improvisation.
`);

add("proj-halfmarathon-status-final", "project", "health-fitness", "2026-01-05",
  "Half-Marathon: Final Status", ["health", "running", "status"], `
Race completed early January 2026, finished comfortably, no injuries, met
the "completion and enjoyment, not time" goal set in the plan note. Finish
time was solidly mid-pack, not tracked precisely as a personal metric since
that was never the goal.

Recovery was straightforward — back to easy running within a week, no
lingering issues that carried into the subsequent marathon training block
(which started roughly three months later in April, after an off-season base
period not otherwise logged in detail).

This block's main output wasn't the race itself but the decision it enabled:
confirmed that structured training was sustainable and enjoyable enough to
justify committing to coach Sarah Ilves and a full marathon block next, which
is documented in the marathon project's own plan and decision notes.
`);

// --- Japan trip planning ---
add("proj-japan-decision-itinerary", "project", "travel", "2026-05-01",
  "Japan Trip: Itinerary Decision", ["travel", "japan", "decision"], `
Decision: if the Japan trip is the one that gets booked (still being weighed
against Portugal, see that trip's equivalent note and the shared budget
comparison), the itinerary will be Tokyo (5 nights) plus Kyoto (4 nights)
plus a day trip to Nara, skipping a third city like Osaka or Hiroshima to
keep the pace closer to the "no plans" day-per-week travel preference from
the travel overview note.

Reasoning: this would be a first trip to Japan, and the research strongly
suggested that trying to cover three-plus cities in under two weeks leads to
the itinerary becoming the second job the travel preferences explicitly try
to avoid. Tokyo and Kyoto alone offer enough contrast (dense modern city vs.
historic/temple-focused) to feel like a complete trip without overreaching.

Travel between Tokyo and Kyoto would be by shinkansen rather than domestic
flight — faster overall once airport time is factored in, and part of the
experience itself.
`);

add("proj-japan-constraints-budget", "project", "travel", "2026-05-01",
  "Japan Trip: Budget & Constraints", ["travel", "japan", "constraints"], `
Estimated total budget if this trip is chosen: roughly $4,800 for two
people, 9 nights, covering flights (~$1,800 using a mix of cash and the
flexible travel-bank points balance), accommodation (~$1,600, mid-range
hotels and one traditional ryokan night in Kyoto), and the remainder for
food, transit (JR rail pass), and activities.

Timing constraint: needs to avoid overlapping with the marathon race date
(see the race-choice decision note, which confirmed no conflict for either
trip option) and ideally lands in a shoulder season for weather and crowd
reasons — spring cherry blossom season was ruled out early as both far more
expensive and far more crowded than the trip preferences call for.

Points usage: the flexible travel-bank points balance (~118,000 points per
the points-tracking note) would cover a meaningful chunk of the flight cost
for this trip specifically, which is one factor in the head-to-head
comparison against Portugal — see that trip's budget note for the
comparison the other direction.
`);

add("proj-japan-status-booked", "project", "travel", "2026-07-01",
  "Japan Trip: Booking Status", ["travel", "japan", "status"], `
Decision made: Japan was chosen over Portugal (see the trip-choice reasoning
in the Portugal status note, which documents both sides of that comparison).
Flights booked early July for a trip in late October, using roughly 90,000
of the flexible travel-bank points plus cash for taxes/fees, landing close
to the ~$1,800 flight budget estimated in the constraints note once points
value is factored in.

Tokyo hotel booked (5 nights), Kyoto accommodations booked including the one
ryokan night, both within the ~$1,600 estimate. JR rail pass not yet
purchased — waiting until closer to departure per usual booking approach
(activities/passes close to departure, per the travel overview note).

Late October timing avoids marathon-race-week entirely and lands well
outside cherry blossom season as intended, with good odds of clear autumn
weather in both cities based on historical patterns checked during
planning.
`);

// --- Portugal trip planning ---
add("proj-portugal-decision-itinerary", "project", "travel", "2026-04-25",
  "Portugal Trip: Itinerary Decision", ["travel", "portugal", "decision"], `
Decision: if the Portugal trip is the one that gets booked (weighed against
Japan, see that trip's note), the itinerary will be Lisbon (4 nights) plus
Porto (3 nights) plus 3 nights based in the Algarve for a slower beach-focused
close to the trip — a deliberate mix of city and downtime that fits the
"no plans" day preference better than an all-city itinerary would.

Reasoning: Portugal is a smaller country than Japan with easier
inter-city travel (train between Lisbon and Porto is under 3 hours), which
made adding the Algarve leg feel low-risk logistically compared to adding a
third city to the Japan plan, which was explicitly avoided there. This trip
leans more toward relaxation, the Japan option leans more toward dense
cultural exploration — a real difference in trip character that's part of
the head-to-head comparison, not just a scheduling detail.
`);

add("proj-portugal-constraints-budget", "project", "travel", "2026-04-25",
  "Portugal Trip: Budget & Constraints", ["travel", "portugal", "constraints"], `
Estimated total budget if this trip is chosen: roughly $3,600 for two
people, 10 nights — meaningfully cheaper than the Japan estimate (~$4,800),
covering flights (~$1,400), accommodation (~$1,300, mid-range throughout
including the Algarve stay), and the remainder for food, trains, and
activities.

Timing constraint: same as Japan, must avoid the marathon race date (already
confirmed clear for both options) and land in a good-weather shoulder
season — Portugal's shoulder season (spring or early fall) avoids peak
summer heat and the more expensive/crowded high season along the Algarve
coast.

Points usage: the flexible travel-bank points balance would stretch further
toward covering this trip's smaller flight cost outright, versus only
partially offsetting the Japan trip's larger flight cost — a real point in
Portugal's favor purely on the points-efficiency angle, even though the
overall cash budget is lower for Portugal either way.
`);

add("proj-portugal-status-booked", "project", "travel", "2026-06-28",
  "Portugal Trip: Decision Not Taken", ["travel", "portugal", "status"], `
Final call: Portugal was not booked. Japan was chosen instead (see the Japan
booking status note) primarily because this was judged a better "first big
trip together" given the once-in-a-while nature of the bigger annual trip,
and Portugal's lower cost and easier logistics actually became a reason to
save it for a future, potentially longer or more spontaneous trip rather
than using this year's slot on the "easier" option.

This project note is being kept rather than deleted, since the itinerary and
budget research is solid and directly reusable — Portugal is now the
leading candidate for next year's trip, pending nothing else displacing it
between now and then. No bookings were made for this trip; the ~$3,600
budget estimate and the Lisbon/Porto/Algarve itinerary stand as ready
research for whenever it gets picked up again.
`);

// --- Investment rebalancing 2026 ---
add("proj-rebalance-decision-allocation", "project", "personal-finance", "2026-01-15",
  "2026 Investment Rebalancing: Allocation Decision", ["finance", "investing", "decision"], `
Decision: shift target allocation in the Fenwick Harbor taxable brokerage and
401(k)/Roth IRA from the prior 80/20 stock/bond split to 75/25, and within
the stock portion, increase international allocation from 25% to 30% of the
stock sleeve, on the reasoning that the prior international weighting had
drifted down purely from US outperformance rather than any deliberate
choice, and a modest rebalance back toward target diversification made sense
at the routine January review rather than waiting for a bigger drift.

The legacy single-stock position from the old employee stock purchase plan
(mentioned in the account map note) is being trimmed gradually — 25% of the
position sold in this rebalance, with the rest planned for roughly equal
sales in the next three annual reviews, to spread the capital-gains tax hit
across multiple tax years rather than realizing it all at once.
`);

add("proj-rebalance-constraints-tax", "project", "personal-finance", "2026-01-16",
  "2026 Investment Rebalancing: Tax Constraints", ["finance", "investing", "constraints", "taxes"], `
Constraint driving the rebalancing approach: all trades within the 401(k)
and Roth IRA are tax-free events and were rebalanced immediately and fully
to the new 75/25 target. The taxable brokerage account is a different story
— selling appreciated positions there triggers capital gains, so the
rebalance in the taxable account is being done gradually rather than all at
once.

The legacy single-stock position specifically has a large embedded gain
(cost basis is roughly 20% of current value), so the decision to spread its
sale across four years (see the allocation decision note) is purely a tax
constraint, not an investment-timing view — there's no belief that the stock
will do better or worse in any given year, this is entirely about not
pushing one year's income into a much higher capital-gains bracket.

See the tax-loss-harvesting technique note for the complementary strategy
used on the non-legacy part of the taxable account during down months.
`);

add("proj-rebalance-status-executed", "project", "personal-finance", "2026-01-20",
  "2026 Investment Rebalancing: Execution Status", ["finance", "investing", "status"], `
401(k) and Roth IRA rebalanced to the 75/25 target on January 16, same-day,
no tax consequence. Taxable brokerage: sold 25% of the legacy single-stock
position on January 18, proceeds redirected into the international index
fund to move that sleeve toward its new 30% target; realized capital gain
from this sale will be handled at tax time with Felix Nakamura (accountant)
early next year.

Full portfolio now sits at approximately 75.4% stock / 24.6% bond, and
within stocks roughly 71% US / 29% international — close enough to the
75/25 and 70/30 targets that no further immediate action is needed. Next
scheduled touchpoint is the routine January 2027 review, unless a major
market move causes drift significant enough to warrant an off-schedule
check before then.
`);

// ============================================================
// PEOPLE NOTES (20)
// ============================================================

add("person-priya-larsen", "person", "home-maintenance", "2026-01-10",
  "Priya Larsen — Plumber", ["people", "contractor", "home"], `
Owner-operator of Aldergrove Plumbing, licensed and insured, servicing the
neighborhood for over 15 years. Installed the current water heater in March
2016 and did the 2026 hybrid heat pump water heater replacement. Also did the
plumbing rough-in check during the kitchen remodel (confirmed no plumbing
lines needed to move given the layout decision to keep sink/range in place).

Responsive by text, usually replies within a day, sometimes same-day for
anything urgent. Pricing is straightforward and itemized rather than a vague
lump sum, which has made comparing her quotes against alternatives (like the
water heater replacement decision) easy to do fairly.

Generally the default call for anything plumbing-related given the long
track record, though the kitchen remodel's permit-delay experience was a
reminder to still get a second quote on bigger jobs rather than defaulting to
her purely on relationship trust, even though her work itself has never been
the issue.
`);

add("person-tomas-reyes", "person", "home-maintenance", "2026-01-11",
  "Tomas Reyes — Electrician", ["people", "contractor", "home"], `
Licensed electrician, runs a small two-person outfit, brought in for the
kitchen remodel's electrical rough-in (two new outlets, under-cabinet
lighting) since Priya's plumbing outfit doesn't do electrical work.

Was not the source of the kitchen remodel's permit delay — the county permit
office backlog was the bottleneck, not scheduling or paperwork on his end;
he actually submitted the permit application promptly and followed up twice
during the 5-week wait.

Passed the electrical rough-in inspection on the first attempt for the
kitchen project. Also did a quick consult on the home office renovation's
lighting fix, correctly diagnosing it as a bulb-type/dimmer-compatibility
issue rather than anything requiring an actual rewiring job, which kept that
project within its "no electrical work" constraint as planned.

Good candidate for future electrical panel questions if the aging 200A panel
(installed 2019, so not urgent) ever needs attention.
`);

add("person-naomi-chen", "person", "health-fitness", "2026-01-12",
  "Dr. Naomi Chen — Physical Therapist", ["people", "health", "pt"], `
Physical therapist who ran the structured ~10-week PT plan for the left
shoulder impingement (spring 2025) documented in the injury log, and was
consulted again for guidance on the tennis elbow / lateral epicondylitis
recovery (late 2024 through early 2025), specifically the eccentric wrist
extensor exercise protocol that ended up resolving it over about 4 months.

Approach is heavy on home-exercise programs with in-person check-ins roughly
every 2 weeks rather than requiring frequent in-clinic sessions, which fit
well around a work schedule. Consistently emphasizes addressing root cause
(desk ergonomics for the shoulder, keyboard/mouse setup plus strength-training
volume for the elbow) rather than only treating symptoms.

Not a running-specific specialist, but was looped in informally when the
mild patellar tendon irritation came up during marathon training week 6 —
confirmed it looked like normal training-load irritation rather than
anything needing a full treatment plan, which matched how the coach Sarah
Ilves handled it.
`);

add("person-elena-vasquez", "person", "health-fitness", "2026-01-13",
  "Dr. Elena Vasquez — Primary Care Physician", ["people", "health", "pcp"], `
Primary care physician, annual physical each January, most recent one
showing the baseline numbers logged in the health overview note (resting
heart rate ~54, blood pressure 116/74). Practice is straightforward and
not overly eager to order unnecessary tests, which is appreciated after a
prior PCP (before moving to this area) who leaned toward over-testing.

Was the referral source for Dr. Naomi Chen's physical therapy practice for
the shoulder impingement in 2025, and generally the first call for anything
health-related that isn't obviously a specialist-only issue, including a
quick sanity-check conversation before starting the marathon training block
about ramping mileage safely given the injury history.

Annual physical scheduling is the main recurring touchpoint; no ongoing
chronic condition requiring more frequent visits currently.
`);

add("person-ben-okafor", "person", "personal-finance", "2026-01-14",
  "Ben Okafor — Financial Advisor", ["people", "finance"], `
Fee-only financial advisor, engaged on an as-needed hourly basis rather than
an ongoing AUM-percentage arrangement, consulted roughly once a year around
the January portfolio review rather than managing the accounts directly —
all actual trades are self-directed through Fenwick Harbor.

Provided a second opinion on the 2026 rebalancing decision (the shift to
75/25 and the increased international allocation) before it was executed,
generally agreeing with the reasoning but suggesting the legacy single-stock
position sale be spread across four years rather than two, which is the
version that ended up in the final tax-constraints note.

Also consulted informally on the water heater replacement's payback-period
math (the heat pump vs. gas comparison), mostly to sanity-check the 5-year
payback assumption rather than as core financial planning — a good example
of using the hourly relationship for occasional cross-domain sanity checks
rather than only formal portfolio topics.
`);

add("person-sarah-ilves", "person", "health-fitness", "2026-04-05",
  "Sarah Ilves — Running Coach", ["people", "health", "running"], `
Running coach, engaged starting with the marathon training block (spring
2026) after the self-coached half-marathon block the previous winter proved
that structured training was sustainable and worth investing in coaching
for. Works with a small roster of recreational runners, communicates weekly
via a shared training log plus a monthly video call.

Adjusted the standard marathon plan template specifically around the injury
history (shoulder impingement, tennis elbow) by capping strength training
at twice weekly during peak-mileage weeks, and handled the week 6-7 knee
irritation flag by trimming mileage for one week rather than a full stop,
which resolved it without disrupting the overall block.

Takes a notably more conservative approach to tapering than the improvised
10-day taper used in the earlier self-coached half-marathon block — full
2-week taper planned for the marathon, explicitly citing the earlier
improvisation as "fine, but not a repeatable method."
`);

add("person-dev-patel", "person", "product-cartograph", "2026-01-16",
  "Dev Patel — Cartograph Advisor", ["people", "cartograph"], `
Former colleague, now an informal advisor to the Cartograph project — not a
co-founder or equity holder, more of a monthly sounding-board relationship
built on having worked together on a previous product at a past job.

Pushed back hard, and usefully, on the initial instinct to build real-time
collaborative editing into v2, which is part of what led to that being
explicitly cut in the v2 constraints note — his argument was that a
two-person part-time team building sync/collaboration infrastructure from
scratch was a multi-month distraction from the actual differentiator (the
canvas), and the user research backed that up once actually checked instead
of assumed.

Also the person who first suggested pgvector over a dedicated vector
database for the semantic search decision, based on having used it
successfully on a project at his current job at a similar scale to
Cartograph's realistic near-term user base.
`);

add("person-ana-ferreira", "person", "product-cartograph", "2026-01-17",
  "Ana Ferreira — Cartograph Co-founder (Design/Frontend)", ["people", "cartograph"], `
Cartograph's other half — handles design and frontend, working part-time
alongside a full-time design job, same arrangement as the product/backend
side. Designed the canvas interaction model that became the product's core
differentiator, and led the v1-to-v2 onboarding-flow diagnosis (identifying
that requiring users to understand typed links before their first action was
the main activation blocker).

Primary voice on the "keep v2 scope realistic for a 10-12 hour/week combined
budget" constraint — most scope cuts in the v2 constraints note (mobile
apps, real-time collaboration) were her call as much as a joint one, coming
from direct experience of how her day job's larger team still struggles to
ship collaborative-editing features well.

Currently owns the v2 onboarding rebuild, which the August 2026 status note
flags as not yet started — next major piece of work once search relevance
tuning wraps up.
`);

add("person-marcus-webb", "person", "personal-finance", "2026-01-18",
  "Marcus Webb — College Friend / Book Club", ["people", "friends"], `
College friend, stayed close since graduation, runs a monthly book club that
meets in rotating houses. Works in software but at a large company, in a
different domain than Cartograph, so mostly a sounding board for
work-life-balance perspective on the side project rather than technical
advice.

Was actually the person who suggested tracking travel rewards points more
deliberately, after comparing notes on a trip he'd taken that was
substantially offset by points he almost let expire — indirectly the origin
of the current points-tracking habit documented in the travel rewards note.

Not involved in any of the house projects, finance decisions, or health
plans directly — kept here mainly as a personal/social relationship note
rather than a project-adjacent one, though book club discussions have
occasionally turned into informal sounding-board conversations about the
Japan vs. Portugal trip decision.
`);

add("person-grace-lindqvist", "person", "personal-finance", "2026-01-19",
  "Grace Lindqvist — Sister", ["people", "family"], `
Younger sister, lives a few hours away, sees each other every few months plus
holidays. Went through her own kitchen renovation about two years ago, which
was a useful reference point during the kitchen remodel planning — her
experience with a permit delay on an electrical addition was part of why the
5-week permit wait wasn't a total surprise, even though it still ran longer
than the contractor's estimate.

Holds a copy of the passport/travel-document photocopies as the
family-member backup described in the passport & documents note, and is the
emergency contact on file for both the Japan trip and general household
matters.

Not involved in the Cartograph project or investment decisions specifically,
though she's aware of both in general terms as a sibling would be, rather
than as an active advisor the way Ben Okafor or Dev Patel are.
`);

add("person-owen-michaud", "person", "personal-finance", "2026-01-20",
  "Owen Michaud — Father", ["people", "family"], `
Father, retired, was the source of the original "always get three quotes on
anything over a couple thousand dollars" advice that gets referenced (and
occasionally not followed closely enough, per the kitchen remodel contractor
note) throughout the home project notes.

Handled his own home's HVAC replacement a few years back and was a useful
sounding board when the HVAC system overview note's "start planning, not yet
urgent" framing was being worked out — his experience was that waiting until
outright failure led to a much more stressful, rushed decision than his
own proactive replacement did, which is part of the same reasoning applied
to the water heater replacement decision.

Occasional financial-history perspective too (lived through several market
cycles), though Ben Okafor is the actual advisor consulted for the formal
rebalancing decisions rather than family advice being treated as a
substitute.
`);

add("person-ruth-michaud", "person", "health-fitness", "2026-01-20",
  "Ruth Michaud — Mother", ["people", "family"], `
Mother, semi-retired, lives with Owen Michaud. Ran recreationally for
decades and was an early source of encouragement to try the half-marathon
block, having done several herself years ago, though her advice was mostly
motivational rather than technical since running training methodology has
shifted since her competitive years.

Was consulted casually about family history relevant to the annual physical
with Dr. Elena Vasquez — nothing concerning noted, no chronic conditions
running in the immediate family that change the baseline health monitoring
approach.

Also the person who most consistently asks about the Cartograph project's
progress despite not being technical, mostly out of general supportive
interest rather than any specific input into product decisions.
`);

add("person-jules-bennett", "person", "product-cartograph", "2026-01-21",
  "Jules Bennett — Best Friend, Early Cartograph Tester", ["people", "friends", "cartograph"], `
Best friend since college, not in tech professionally (works in
healthcare administration), but was one of the very first v1 beta testers
specifically because being a non-technical, high-volume note-taker made
them a good stand-in for whether the product could work beyond a
technical-early-adopter audience.

Fits the "Serial Journaler" persona from the user personas note almost
exactly — daily journaling habit, lower link density, cared most about
capture speed. Feedback about the early typed-link-first onboarding being
confusing (before it required "just write something first") came directly
from watching them get stuck during an early test session, which was a
concrete, memorable data point behind that onboarding fix.

Outside of Cartograph, a regular travel-planning sounding board, having
taken a similar Portugal-leaning trip a couple of years back that fed some
of the itinerary research for the Portugal trip project.
`);

add("person-lena-novak", "person", "home-maintenance", "2026-01-22",
  "Lena Novak — Housemate", ["people", "housemate"], `
Housemate, splits the mortgage-adjacent living costs on an informal
arrangement (not on the deed, pays a set monthly amount that roughly
approximates a fair market rent for the arrangement). Was consulted on the
home office renovation decisions since the room adjoins a shared hallway,
mainly around noise/timeline (the single-weekend-disruption constraint
partly accounts for not disrupting her routine for too long either).

Not involved in the kitchen remodel financially (that's funded solely from
personal accounts, not shared), but obviously affected day-to-day by the
kitchen being non-functional during the remodel, and was part of the
decision to set up the temporary dining-room meal prep station mentioned in
that project's status update.

Has her own separate finances, investments, and health providers, not
otherwise referenced in this vault.
`);

add("person-carlos-mendoza", "person", "health-fitness", "2026-01-23",
  "Carlos Mendoza — Personal Trainer", ["people", "health", "strength"], `
Personal trainer, seen roughly twice a month for form checks and program
adjustments on top of the twice-weekly self-directed strength sessions
described in the health overview note. Designed the progressive-overload
program currently being followed with the home dumbbell set.

Was directly involved in adjusting the program after the tennis elbow
diagnosis — reduced upper-body pressing volume temporarily and substituted
alternative movements during the roughly 4-month recovery window, working
in coordination with Dr. Naomi Chen's PT-side recommendations rather than
independently.

Not involved in the running-specific training (that's coach Sarah Ilves'
domain), though the two occasionally cross-reference when total weekly
training load needs balancing during peak marathon-mileage weeks, mostly
informally via the athlete relaying context rather than the coaches talking
directly.
`);

add("person-ingrid-solberg", "person", "product-cartograph", "2026-01-24",
  "Ingrid Solberg — Cartograph Beta Advisor", ["people", "cartograph"], `
Graduate student (comparative literature), one of the most engaged v1 beta
users and now an informal advisor consulted before major v2 product
decisions. Far and away the best real-world example of the "Synthesizer"
persona from the user personas note — her thesis-research graph grew past
600 notes during the beta, making her the direct source of the
canvas-performance complaints that became the v2 performance constraint
(30fps target up to 1,000 notes).

Gave early feedback that search quality (full-text only, in v1) was the
single biggest gap for her workflow, directly cited in the v1 retro as a key
input to prioritizing real semantic search for v2. Has agreed to be one of
the first re-invited users when the v2 private beta reopens, expected around
October 2026 per the current status note.
`);

add("person-felix-nakamura", "person", "personal-finance", "2026-01-25",
  "Felix Nakamura — Accountant (CPA)", ["people", "finance", "taxes"], `
CPA, handles annual tax filing and is consulted on any transaction with real
tax complexity before it happens rather than only at filing time — notably
the 2026 rebalancing's legacy stock sale, where his input confirmed the
four-year gradual sale approach (from the tax constraints note) would keep
each year's capital gains within a reasonable bracket rather than causing a
one-year tax spike.

Also handles the modest freelance design income reported alongside salaried
income, including the relevant estimated quarterly tax payments, and advised
on treating Cartograph as a pass-through hobby/side-project for tax purposes
for now, revisiting that treatment only once (if) it generates real
revenue post-launch.

Relationship is annual-filing-plus-occasional-consult rather than ongoing
bookkeeping — no involvement in day-to-day budgeting, which stays entirely
self-managed per the finance overview note.
`);

add("person-rosa-delgado", "person", "travel", "2026-01-26",
  "Rosa Delgado — Travel-Planning Friend", ["people", "friends", "travel"], `
Friend from a former job, now works adjacent to travel (corporate travel
coordination, not a licensed travel agent, but has planned enough
complex multi-city trips to be a genuinely useful sounding board). Reviewed
both the Japan and Portugal itinerary drafts and flagged that the original
Japan plan had briefly included a third city (Osaka) before it got cut for
pacing reasons — her pushback on itinerary density was a direct input into
the "skip a third city" decision documented in the Japan itinerary note.

Has been to Portugal twice and provided most of the specific
Lisbon/Porto/Algarve pacing suggestions baked into that trip's itinerary
decision, including the recommendation that the Algarve leg works better as
a slower 3-night close to the trip than a rushed 2-night stop.

Not consulted on the final Japan-vs-Portugal choice itself — that comparison
was made independently using the budget and character factors in each
trip's own notes.
`);

add("person-yusuf-karimi", "person", "product-cartograph", "2026-01-27",
  "Yusuf Karimi — Former Manager, Mentor", ["people", "mentor", "cartograph"], `
Former manager from an earlier job, stayed in touch as an informal mentor,
consulted a few times a year on career and side-project strategy questions
rather than anything domain-specific to Cartograph's product decisions. Main
contribution was pressure-testing the pricing decision — specifically
asking whether $8/month was defensible against the free alternative
(Obsidian) clearly enough, which prompted writing out the fuller reasoning
now captured in the pricing decision note rather than just picking a number
that felt roughly right.

Generally counsels patience on the "should this go full-time" question,
consistently advising against leaving the day job until there's at least
6-12 months of revenue data post-launch, which lines up with the
deliberately conservative "no paid infrastructure until there's paying
revenue" constraint already in the v2 constraints note.
`);

add("person-chloe-winters", "person", "home-maintenance", "2026-01-28",
  "Chloe Winters — Neighbor", ["people", "neighbor"], `
Next-door neighbor, mainly a mutual-favor relationship (mail/package
watching during travel, borrowing tools occasionally). Was the one who
first mentioned Tomas Reyes as an electrician after having good experience
with him on her own home's panel work, which is how he ended up as the
electrician contacted for the kitchen remodel's rough-in work.

Also useful as a second data point on neighborhood contractor experiences
generally — her water heater is a similar age and she's been through a
similar "proactive replacement vs. wait for failure" consideration, though
she hasn't made a final decision on hers yet as of early 2026, unlike the
water heater replacement project here which went ahead with the proactive
heat-pump replacement in June.

Will be one of the people watching the house (mail, occasional check-in)
during the Japan trip in October.
`);

// ============================================================
// TECHNIQUE NOTES (20)
// ============================================================

add("technique-hvac-filter-schedule", "technique", "home-maintenance", "2026-02-01",
  "Technique: HVAC Filter Replacement Schedule", ["home", "hvac", "technique"], `
Cadence settled on after some trial and error: replace the 16x25x1 MERV 11
filter every 60 days during heavy-use months (summer AC season, winter
furnace season) and every 90 days during shoulder-season months when the
system runs less. This replaced an earlier "just replace it every 90 days
year-round" habit that left filters visibly dirty by the end of peak summer
and winter months.

Practical trick that makes the cadence stick: a recurring reminder tied to
the first of the month rather than trying to remember an exact 60/90-day
interval, checking the filter's actual condition against the light-test
(hold it up to a light — if you can't see light through it clearly, replace
it regardless of what the calendar says) rather than trusting the schedule
blindly.

Buy filters in a 6-pack rather than one at a time — cheaper per-unit and
removes the "forgot to buy one, skip this cycle" failure mode that was the
main reason the old ad-hoc approach kept slipping.
`);

add("technique-budget-zero-based", "technique", "personal-finance", "2026-02-02",
  "Technique: Zero-Based Budgeting", ["finance", "budgeting", "technique"], `
Current budgeting method (switched to this from the envelope method in
2024, see that note for the comparison). Every dollar of monthly income gets
assigned a job before the month starts — fixed bills, savings transfers
(emergency fund, house-projects fund, retirement), discretionary categories,
and anything left over gets explicitly assigned too (extra debt payment,
extra investing, or a deliberate "slush" category) rather than sitting
unassigned.

Tooling: a spreadsheet rather than a dedicated budgeting app, rebuilt fresh
each month from a template rather than trying to maintain one continuously
rolling sheet, which turned out to reduce the "this got messy and I gave up"
failure mode significantly compared to earlier attempts.

Why this replaced envelopes: zero-based budgeting handles variable months
(irregular freelance income, occasional large expenses like the home office
or kitchen projects) more gracefully than physical or digital envelopes did,
since it's fundamentally about planning against actual expected income each
month rather than maintaining fixed category balances.
`);

add("technique-budget-envelope", "technique", "personal-finance", "2023-11-10",
  "Technique: Envelope Budgeting (Retired Method)", ["finance", "budgeting", "technique"], `
Previous budgeting method, used from roughly 2021 to 2024 before switching
to zero-based budgeting (see that note). Digital "envelopes" via a budgeting
app, each discretionary spending category (groceries, dining out,
entertainment, personal spending) got a fixed monthly allocation, and
overspending one envelope meant borrowing from another rather than going
into debt.

Worked well during the period of steady salaried-only income with
predictable expenses. Started breaking down once freelance income became a
regular but irregular part of monthly income (harder to allocate envelopes
against income that varies month to month) and once bigger irregular
expenses (house projects) started needing planning that didn't fit neatly
into a fixed-envelope model.

Kept as a reference note rather than deleted, since the underlying
discipline (assign money a job in advance) is really the same principle
zero-based budgeting uses, just implemented differently — worth remembering
if income ever goes back to being simpler and steadier.
`);

add("technique-sleep-hygiene", "technique", "health-fitness", "2026-02-03",
  "Technique: Sleep Hygiene Habits", ["health", "sleep", "technique"], `
Habits currently in place, informed by the patterns observed in the sleep
tracking note: caffeine cutoff at 2pm (tested against no cutoff, meaningful
improvement in sleep efficiency), no more than one alcoholic drink on
weeknights and ideally none the night before a hard training session (data
showed a clear negative effect on deep sleep and overnight heart rate),
and a wind-down routine starting around 10pm — phone goes on a charger
outside the bedroom, lights dim, either reading or light stretching.

Bedroom kept cool (thermostat set lower overnight per the HVAC schedule) and
dark (blackout curtains added in 2024 after noticing early-summer sunrise
was cutting sleep short). Wake time is kept consistent even on non-training
days, which was a bigger improvement to overall sleep quality than any
single other change, based on before/after comparison in the tracking data.

This is the "habits" note — the "data and observations" side of sleep lives
in the separate sleep tracking area note.
`);

add("technique-packing-list", "technique", "travel", "2026-02-04",
  "Technique: Adapting the Base Packing List Per Trip", ["travel", "technique"], `
Method for turning the base packing list into a trip-specific one: start
from the base list document, then run through three filters — climate
(add/remove layers based on destination weather for the actual travel
dates), activity mix (any specific gear for planned activities, e.g. hiking
shoes if a trip includes trail time), and trip length (a rule of thumb of
packing for 7 days of clothing max regardless of trip length, laundry
covers anything longer, which keeps luggage from scaling linearly with trip
length).

Packing happens over two passes: a rough lay-out 3-4 days before departure
to catch anything that needs buying or borrowing, then final packing the
night before. Never packing same-day-as-departure only, after one past
trip's forgotten-charger incident that a buffer day would have caught.

For the Japan and Portugal trip planning specifically, this method is what
will generate the actual packing lists once one trip is booked — neither
trip has a trip-specific packing list yet since neither had been fully
committed to before Japan's July booking.
`);

add("technique-travel-budgeting", "technique", "travel", "2026-02-04",
  "Technique: Trip Budget Estimation Method", ["travel", "finance", "technique"], `
Method used to produce the budget estimates seen in both the Japan and
Portugal trip constraint notes: start with flights (researched first since
they're the most variable cost and often the deciding factor in trip
timing), then accommodation (estimated per-night rate times nights,
sourced from a quick search of realistic options rather than the cheapest
possible option, to avoid under-budgeting), then a daily food/activity/local
transit estimate multiplied by trip length, then add 10-15% buffer on top
of the total for the inevitable unplanned expense.

Points and miles get factored in as a final step, converting a
points-redemption estimate into an equivalent cash value to compare
apples-to-apples against a cash-only budget, rather than treating points as
"free" and excluding them from the comparison entirely — this is what made
the Japan-vs-Portugal points-efficiency comparison possible in the first
place.

This method was refined between the Japan and Portugal estimates — the
Portugal estimate benefited from lessons on daily-estimate accuracy learned
while researching Japan's costs first.
`);

add("technique-pomodoro", "technique", "product-cartograph", "2026-02-05",
  "Technique: Modified Pomodoro for Cartograph Work Sessions", ["technique", "productivity", "cartograph"], `
Used specifically for the limited weekly Cartograph work windows (part of
the 10-12 hour/week combined budget from the v2 constraints note): 45-minute
focused blocks rather than the classic 25-minute Pomodoro, with a 10-minute
break, because context-switching cost into this particular kind of deep
backend/product work is high enough that 25 minutes barely allows getting
into flow before the timer interrupts.

Session planning happens the night before rather than at the start of the
session — a short list of what the session is for, written the prior
evening, so the limited weekly time isn't spent deciding what to work on.

Not used for the day job or for household/admin tasks — this technique is
specifically reserved for Cartograph sessions where sustained focus matters
most and where the time is genuinely scarce enough to be worth protecting
deliberately, versus other task types where a looser approach works fine.
`);

add("technique-timeboxing", "technique", "personal-finance", "2026-02-06",
  "Technique: Timeboxing Admin & Financial Tasks", ["technique", "productivity", "finance"], `
Weekly 30-minute timebox, usually Sunday evening, for routine financial
admin: reviewing the past week's spending against the zero-based budget,
paying any bills not on autopay, and a quick glance at account balances.
Strict 30-minute cap — if something needs more time (like actual
rebalancing research), it gets scheduled as its own separate task rather
than blowing through the weekly timebox.

This is distinct from the annual January rebalancing review (a much bigger,
separately-scheduled task) and from the emergency-fund or house-projects
sinking-fund transfers, which are automated and don't need manual weekly
attention at all — the timebox is specifically for the stuff that isn't
worth automating but also isn't worth letting pile up.

Adopted this after noticing financial admin was the task category most
likely to get skipped entirely during busy weeks (kitchen remodel decision
points, marathon training peak weeks) when it didn't have a protected time
slot.
`);

add("technique-weekly-review", "technique", "product-cartograph", "2026-02-07",
  "Technique: Weekly Review Ritual", ["technique", "productivity"], `
Sunday evening ritual, roughly 20 minutes, run through each active area:
Cartograph (what shipped this week, what's next), house projects (whichever
of home office/kitchen/water heater is active), health/fitness (training
status if in a training block), finance (handled by the separate
timeboxing technique so just a quick check here), travel (only relevant
during active trip planning).

The output isn't a formal document — it's really just a mental/light-note
pass to catch anything that's stalled or been silently dropped, which is
specifically how the home office lighting's "punt if it needs electrical
work" contingency got caught and confirmed unnecessary in real time rather
than discovered later.

This ritual predates most of the individual project notes in this vault —
it's the reason there's a habit of writing status-update notes for active
projects at all, since the weekly review naturally produces "what changed
this week" content that's worth capturing.
`);

add("technique-zettelkasten-notetaking", "technique", "product-cartograph", "2026-02-08",
  "Technique: Note-Linking Habits (Zettelkasten-Adjacent)", ["technique", "notetaking", "cartograph"], `
The note-taking habit behind this very vault, and not coincidentally close
to the mental model behind Cartograph's typed-link feature — every note
that references a decision, person, or project links back to the relevant
source note rather than restating context, on the theory that duplication
drifts out of sync while links stay accurate as long as the target note
gets updated.

Not a strict Zettelkasten system (no unique ID scheme, no formal
atomic-note-per-idea discipline) — looser, more like "PARA-organized folders
with liberal cross-referencing," closer to how the Serial Journaler persona
actually uses Cartograph than to the more rigorous Synthesizer-persona
graphs like Ingrid Solberg's.

Direct product feedback loop: friction points noticed in this personal
note-taking practice (e.g., wanting to quickly see "everything that
references this person") are a running source of feature ideas for
Cartograph, since the author is effectively also a Serial-Journaler-persona
user of their own product.
`);

add("technique-progressive-overload", "technique", "health-fitness", "2026-02-09",
  "Technique: Progressive Overload Program Structure", ["health", "strength", "technique"], `
Program structure used with Carlos Mendoza for the twice-weekly strength
sessions: track working weight and reps for each core movement every
session, aim to add either weight or a rep roughly every 2-3 sessions rather
than every single session, which turned out to be more sustainable than an
earlier attempt at every-session progression that led to stalling and
frustration within a few weeks.

Deload built in every 5th or 6th week (reduced weight/volume, not a full
rest) rather than waiting for a stall to force one, which has meaningfully
reduced how often plateaus happen compared to the pre-Carlos self-directed
approach.

Adjusted temporarily during the tennis elbow recovery (reduced pressing
volume, substitute movements) and again lightly during peak marathon
mileage weeks (capped at twice weekly per coach Sarah's request) — the
program is explicitly designed to flex around these other training demands
rather than being treated as untouchable.
`);

add("technique-couch-to-5k", "technique", "health-fitness", "2024-08-15",
  "Technique: Couch-to-5K Method (Historical)", ["health", "running", "technique"], `
The run-walk interval method used back in 2024 to build an initial running
base from essentially no running background — alternating short run and
walk intervals over 9 weeks, gradually increasing the run intervals until
running continuously for 30 minutes became comfortable.

Kept as a historical reference note rather than an active technique — by
the time of the 2025 half-marathon block this base had long since been
built on top of, but it's referenced occasionally when thinking about how
to advise someone else starting from zero, and it's the actual origin point
of the running habit that eventually led to coach Sarah Ilves and the
marathon training block.

Nothing about current training (marathon or half-marathon block structure)
uses run-walk intervals anymore — this is purely a "how the running habit
started" reference, distinct from the active training plan notes.
`);

add("technique-meal-prep-sunday", "technique", "health-fitness", "2026-02-10",
  "Technique: Sunday Meal Prep Routine", ["health", "nutrition", "technique"], `
Roughly 90-minute Sunday routine (often paired back-to-back with the weekly
review and financial timeboxing sessions, all part of the same "Sunday
admin block"): prep lunches for the work week, usually a grain base plus a
protein plus roasted vegetables, made in large batches and portioned into
containers.

This is the main lever for hitting the loose protein target described in
the nutrition baseline note without formal tracking — pre-portioning protein
into each lunch container removes the need to think about it during the
actual work week.

During marathon training weeks, portions get scaled up roughly 20% to match
the increased training load, and an extra carb-heavy prepped item gets added
specifically for the day after the Saturday long run, tying back to the
informal carb-timing approach described in the nutrition note.
`);

add("technique-negotiating-contractor-quotes", "technique", "home-maintenance", "2026-02-11",
  "Technique: Getting and Comparing Contractor Quotes", ["home", "technique", "contractors"], `
Standard approach (not always followed as strictly as it should be, per the
kitchen remodel contractor note's admission): get three quotes for anything
over roughly $2,000, request itemized breakdowns rather than lump sums so
quotes are actually comparable line by line, and always ask each contractor
directly whether there's anything the others might have missed or done
differently — often surfaces useful information even from the quotes not
chosen.

For the water heater replacement, this worked well: Priya's itemized
gas-vs-heat-pump quotes made the payback-period comparison in the decision
note straightforward. For the kitchen remodel, the "always get three quotes"
rule was skipped in favor of the existing trusted relationship with Priya's
electrical-adjacent recommendation — reasonable in hindsight given her work
quality, but the permit-delay experience is a reminder that quote-comparison
would specifically have surfaced timeline expectations better, not just
price.
`);

add("technique-decluttering-kondo-ish", "technique", "home-maintenance", "2026-02-12",
  "Technique: Room-by-Room Decluttering Pass", ["home", "technique", "organizing"], `
Loose method (inspired by, not strictly following, well-known
decluttering methodologies) used ahead of both the home office renovation
and the kitchen remodel: go through everything in the room being touched by
the project, sort into keep/relocate/donate/discard, and specifically for
"relocate" items, decide the actual destination immediately rather than
creating a floating pile that never gets dealt with — a failure mode from
past decluttering attempts that left boxes sitting in the basement for over
a year.

For the home office, this produced the specific relocations documented in
that project's layout-decision note (seasonal decorations to basement
shelving, off-season clothing to the primary closet). For the kitchen,
scope was narrower since cabinets were refaced rather than replaced, so this
pass focused mainly on the "actually use this moment to get rid of
duplicate/broken kitchen tools" opportunity rather than a full reorganization.
`);

add("technique-cold-email-followup", "technique", "product-cartograph", "2026-02-13",
  "Technique: Following Up with Beta Users", ["technique", "cartograph"], `
Method used for the v1-beta-closure outreach described in the v1 final
status note: personalized rather than templated emails to the ~40 activated
users specifically (not the full 104 signups), referencing something
specific from their actual usage where possible ("noticed your graph grew to
over 500 notes" for Ingrid, for instance), with a single clear ask (reply if
interested in v2 re-invite) rather than multiple asks.

Follow-up cadence: one initial email, one follow-up after two weeks to
non-responders, then stop — based on watching open/response rates drop off
sharply after a second touch in past outreach attempts for other things, no
reason to expect beta users would be different.

Roughly a third of the ~40 replied with interest, which the v1 status note
already covers — this note is specifically about the outreach method, kept
separate so the method is reusable for the actual v2 relaunch outreach later
this year.
`);

add("technique-user-interview-script", "technique", "product-cartograph", "2026-02-14",
  "Technique: Cartograph User Interview Script Structure", ["technique", "cartograph", "research"], `
Loose structure used for the v1 beta user interviews that produced the
persona definitions and competitive-landscape notes: start with open-ended
"walk me through how you used it this week" rather than leading with
specific feature questions, only introduce specific probes (search quality,
performance, canvas usability) once something related comes up naturally or
about halfway through if it hasn't.

Deliberately avoided asking "would you pay for this" directly (known to
produce unreliable yes-answers) in favor of "what have you tried instead"
and "what's the actual annoying part of your current workflow" — the
pricing research and competitive landscape notes both draw more from these
indirect questions than from direct willingness-to-pay questions.

Interviews ran roughly 30 minutes, recorded with permission, and the
personas note was synthesized from patterns across roughly 15 of these
interviews rather than all ~40 activated users, prioritizing the most
engaged users for interview time.
`);

add("technique-git-commit-hygiene", "technique", "product-cartograph", "2026-02-15",
  "Technique: Commit Hygiene for the Cartograph Side Project", ["technique", "cartograph", "engineering"], `
Small-team-of-two convention adopted for the Cartograph codebase: commits
scoped to one logical change each, commit messages stating what changed and
why rather than just what changed, and a lightweight rule that any commit
touching the search/embedding pipeline gets a short note in the commit body
about what was measured or tested, given how easy it is for retrieval
quality regressions to go unnoticed without an explicit before/after check.

Branching is simple — short-lived feature branches merged after the other
person reviews, no elaborate release-branch process, appropriate for a
two-person part-time team where a heavier process would just be overhead.

This convention became more important once the pgvector-backed search
feature (see the v2 search backend decision) started being actively tuned
for relevance — the discipline of noting what was tested in each
search-related commit is what made it possible to track why relevance
tuning was taking longer than the original schedule, per the August status
note.
`);

add("technique-tax-loss-harvesting", "technique", "personal-finance", "2026-02-16",
  "Technique: Tax-Loss Harvesting on Down Months", ["finance", "investing", "technique", "taxes"], `
Applied to the non-legacy portion of the taxable brokerage account (the
legacy single-stock position is handled separately via the planned
four-year gradual sale, see the rebalancing tax-constraints note): during
any month where the broad index funds are down meaningfully from their
purchase price, sell the losing lots and immediately buy a similar-but-not-
identical fund (different index provider, same broad market exposure) to
avoid the wash-sale rule while staying invested.

Harvested losses offset realized gains elsewhere in the portfolio first
(including gains from the legacy stock's gradual sale), then up to $3,000
against ordinary income if losses exceed available gains, with any excess
carried forward to future years per the standard rule Felix Nakamura
explained when this technique was first adopted.

Checked monthly during the financial timeboxing session rather than
constantly monitored — down months don't happen often enough to need daily
attention, and chasing every small dip would generate more transaction
complexity than the tax benefit is worth.
`);

add("technique-gutter-cleaning-schedule", "technique", "home-maintenance", "2026-02-17",
  "Technique: Gutter Cleaning Schedule & Method", ["home", "technique"], `
Twice-yearly cleaning (spring after the last hard freeze, fall after leaf
drop) per the seasonal checklist, done personally with a ladder and a
gutter scoop rather than hiring it out, given the house's modest two-story
height and straightforward roofline without excessive tree cover directly
overhanging the gutters.

Leaf guards added in 2024 reduced debris buildup noticeably — the fall 2024
cleaning after leaf-guard installation took about a third of the time the
fall 2023 cleaning did, based on rough before/after comparison, though guards
don't eliminate the need for cleaning entirely since fine grit and shingle
granules still accumulate over time.

Downspout check is part of the same pass: run a hose at each downspout
opening to confirm water flows through freely, catching any blockage before
it becomes a problem during the next heavy rain rather than discovering it
during one.
`);

// ============================================================
// JOURNAL ENTRIES (28)
// ============================================================

add("journal-2026-02-08", "journal", "product-cartograph", "2026-02-08",
  "Journal — Feb 8, 2026", ["journal"], `
Good focused session on Cartograph tonight using the new 45-minute work-block
technique. Made real progress sketching the pgvector schema for v2 search —
settled on storing the embedding model name and dimension count per row
rather than assuming a single fixed model for the whole table, mostly
because Dev's advice about pgvector made me realize the embedding model
itself is a decision we might want to revisit later, and the schema should
make that reversible rather than baking in an assumption.

Ana's still heads-down on the canvas interaction polish. We're both feeling
the time crunch of the 10-12 hour/week budget already, even this early in
the v2 build — going to need real discipline about scope creep given how
February is going.
`);

add("journal-2026-02-15", "journal", "home-maintenance", "2026-02-15",
  "Journal — Feb 15, 2026", ["journal"], `
Spent the weekend admin block going through contractor quotes for the
kitchen remodel. The cabinet refacing vs. full replacement numbers were
starker than expected — $6,500 vs $18,000 for essentially the same visual
result given the boxes are sound. Feels like an easy call once it's laid out
like that.

Also started thinking seriously about the home office room now that the
kitchen planning is underway — don't want to run both projects at the same
overlapping intensity, but the room's storage situation has been bugging me
for months and doing the redistribution planning now, even if the actual
work waits, seems smart.
`);

add("journal-2026-03-08", "journal", "product-cartograph", "2026-03-08",
  "Journal — Mar 8, 2026", ["journal"], `
Pricing conversation with Yusuf today was more useful than expected — his
question about defensibility against Obsidian's free tier made me realize I
hadn't actually written down the reasoning, just felt like $8/month was
"about right." Spent tonight's session writing the actual decision note
instead of just deciding informally, which is going to make this easier to
explain to Ana and eventually to users too.

Also nervous about the search relevance work. Full-text was so much simpler
than this. The embedding-based approach clearly works better on the kind of
fuzzy natural-language questions we want to support, but tuning it feels
much less deterministic than tsvector ever did.
`);

add("journal-2026-03-25", "journal", "home-maintenance", "2026-03-25",
  "Journal — Mar 25, 2026", ["journal"], `
Kitchen remodel contract signed today. Went with Priya's electrical
recommendation (Tomas) rather than getting three separate quotes like I
know I should have — partly time pressure, partly just trusting the
relationship at this point given how well the water heater install went
years ago. Noted it in the constraints note as a real trade-off, not
pretending it wasn't one.

Permit application goes in this week. Hoping it's faster than Grace's was
when she did her kitchen, but bracing for it to take a while based on what
she described.
`);

add("journal-2026-04-05", "journal", "health-fitness", "2026-04-05",
  "Journal — Apr 5, 2026", ["journal"], `
First real conversation with Sarah about coaching the marathon block. Good
feeling about her — asked a lot of questions about the shoulder and elbow
history before saying anything about the plan itself, which is a good sign
after the fairly improvised half-marathon block. She's already talking about
capping strength training during peak weeks, which lines up with what
Carlos and I had been planning anyway.

Registered for the fall marathon this week too. Flat course, matches our
usual river-path routes, feels like the right first-marathon choice over the
hillier option.
`);

add("journal-2026-04-12", "journal", "home-maintenance", "2026-04-12",
  "Journal — Apr 12, 2026", ["journal"], `
Home office layout finally decided — desk against the north wall, away from
the window glare that's been annoying on video calls for months. Feels good
to have this settled after mentally circling it since February. Budget is
tight at $2,500 but doable if I'm disciplined about not upgrading the desk
beyond what's actually needed.

Kitchen demo is close. Nervous about how disruptive it'll actually be once
it starts — the dining-room-as-temporary-kitchen plan sounds fine in theory.
`);

add("journal-2026-04-20", "journal", "travel", "2026-04-20",
  "Journal — Apr 20, 2026", ["journal"], `
Spent a chunk of tonight's admin block on trip research instead of the
usual finance timebox — Japan vs Portugal is a genuinely hard call. Rosa's
feedback on the Japan itinerary (cut the third city) made real sense once
she explained it; the original three-city plan was clearly overreaching
for a first Japan trip.

Portugal is cheaper and the points stretch further there, but there's
something about Japan feeling like the "bigger" trip that keeps pulling me
that direction. Not deciding yet, want both itineraries fully fleshed out
before comparing properly.
`);

add("journal-2026-05-02", "journal", "personal-finance", "2026-05-02",
  "Journal — May 2, 2026", ["journal"], `
Sold the second chunk of the legacy stock position today as part of the
four-year gradual sell-down plan. Still feels a little strange selling
something that's been sitting there since the old job, but Felix's tax
math is clear and Ben's original suggestion to spread it over four years
rather than two was clearly the right call once I saw this year's numbers.

International allocation is basically at the 30% target now. Feels good to
have the rebalancing actually executed rather than just decided.
`);

add("journal-2026-05-10", "journal", "product-cartograph", "2026-05-10",
  "Journal — May 10, 2026", ["journal"], `
Rough week for Cartograph time — house projects ate almost the whole
budget. Only managed one work session, and it was mostly just triaging
which search-relevance experiments to run next rather than actually running
them. Feeling the tension between the 10-12 hour budget and how much is
happening on the house side right now (home office assembly, kitchen
electrical rough-in) at the same time.

Ana's making steady progress on the onboarding diagnosis independent of my
slower week, which is a relief — glad this isn't a single point of failure
right now.
`);

add("journal-2026-05-18", "journal", "home-maintenance", "2026-05-18",
  "Journal — May 18, 2026", ["journal"], `
Home office is basically done except for the desk/shelving delivery next
week. The paint color turned out great — genuinely relieved since paint
colors always look different on the wall than the swatch. Lighting fix was
a total non-event, which is a nice contrast to how much the kitchen's
electrical work has turned into an ordeal.

Under budget so far too, which almost never happens on a house project in
my experience. Small win.
`);

add("journal-2026-05-20", "journal", "home-maintenance", "2026-05-20",
  "Journal — May 20, 2026", ["journal"], `
Kitchen is a disaster zone right now in the best possible way — cabinets
look genuinely great with the new doors on, quartz template got taken today.
Living out of the dining room for meals is as annoying as expected but
bearable knowing it's temporary. Two more weeks until countertops are in,
hopefully.

Funny contrast writing this right after re-reading the home office update
from a couple days ago — same general "week 3 progress" shape, completely
different disruption level. Scope really was the right call to keep those
separate.
`);

add("journal-2026-06-01", "journal", "home-maintenance", "2026-06-01",
  "Journal — Jun 1, 2026", ["journal"], `
Decided to go ahead with the water heater replacement now rather than
waiting for it to actually fail. Ten years feels early to replace something
that's working fine, but the Sunday-failure horror stories are real and Dad's
HVAC experience keeps rattling around in my head as the cautionary tale.
Going with the heat pump option despite the higher upfront cost — the
payback math Ben helped sanity check makes it feel like the right call, not
just an expensive upgrade for its own sake.
`);

add("journal-2026-06-05", "journal", "health-fitness", "2026-06-05",
  "Journal — Jun 5, 2026", ["journal"], `
Halfway through marathon training and feeling good about where things
stand, knee thing from a couple weeks back resolved cleanly. Sarah's
approach of trimming mileage instead of forcing a full rest week for a
minor niggle seems to be exactly right so far — very different vibe from
how improvised the taper decision was back in the half-marathon block.

Sleep data's been showing the usual post-long-run pattern, deep sleep up,
efficiency down a bit. At this point it barely registers as noteworthy,
just the expected shape of a hard training week.
`);

add("journal-2026-06-15", "journal", "home-maintenance", "2026-06-15",
  "Journal — Jun 15, 2026", ["journal"], `
New water heater installed, no drama. Priya's crew was in and out in about
half a day. Had to shuffle a storage shelf for clearance, minor annoyance,
not worth stressing about. Weird to think the old unit that's been quietly
doing its job since 2016 is just gone now, hauled away like it was nothing.

Rebate paperwork submitted. Curious to see the actual electricity bill
impact once a full cycle's gone by — will believe the 5-year payback number
more once there's real data instead of just Ben's estimate.
`);

add("journal-2026-06-28", "journal", "travel", "2026-06-28",
  "Journal — Jun 28, 2026", ["journal"], `
Made the call: Japan it is. Portugal was genuinely tempting, especially on
budget and the points-efficiency angle, but in the end it felt like the
kind of trip that'll still be a great option next year, whereas the pull
toward Japan as the "big" trip this year was strong enough that saving
Portugal for later felt like the right sequencing rather than a loss.

A little sad to shelve the Algarve research Rosa helped with, but glad the
itinerary work isn't wasted — it's just... later.
`);

add("journal-2026-07-01", "journal", "travel", "2026-07-01",
  "Journal — Jul 1, 2026", ["journal"], `
Booked the Japan flights tonight, used a big chunk of the flexible points
balance which felt satisfying after years of just letting them sit mostly
unused. Late October timing worked out clean against both the marathon
(well before race week) and against cherry blossom season pricing.

Hotel booking next, though probably not until closer to the trip per usual
habit. Excited. This is going to be a very different kind of trip than
anything we've done before given the scale of the itinerary.
`);

add("journal-2026-07-10", "journal", "product-cartograph", "2026-07-10",
  "Journal — Jul 10, 2026", ["journal"], `
Long overdue Cartograph session tonight, finally got back into the search
relevance tuning after weeks of house-project distraction. Chunking
strategy seems to matter more than I expected — splitting notes at heading
boundaries is giving noticeably better results than the fixed-size chunks
I started with, especially for longer reference-style notes.

Still behind the original v2 timeline, probably need to just accept October
as the realistic beta-reopen target rather than keep hoping to catch up to
the original schedule.
`);

add("journal-2026-07-20", "journal", "personal-finance", "2026-07-20",
  "Journal — Jul 20, 2026", ["journal"], `
Quick timebox session tonight, mostly routine. Did catch a small tax-loss
harvesting opportunity in the international fund after a rough couple of
weeks in that market — sold and rebought the alternative fund per the usual
method, small thing but it's satisfying when the system just works
automatically without needing to think hard about it.

Nothing else notable, which after this spring's intensity (kitchen, home
office, water heater, trip booking all at once) is honestly a nice change
of pace.
`);

add("journal-2026-07-28", "journal", "health-fitness", "2026-07-28",
  "Journal — Jul 28, 2026", ["journal"], `
Peak mileage week coming up per Sarah's plan. Slightly nervous about the
20-miler in a couple weeks — biggest long run I'll have ever done. Feeling
generally good physically, elbow and shoulder both fully quiet, no
recurrence of either issue through this whole block so far, which after
last year's back-to-back injuries feels like real progress from the PT and
strength-program adjustments Naomi and Carlos put in place.
`);

add("journal-2026-08-02", "journal", "product-cartograph", "2026-08-02",
  "Journal — Aug 2, 2026", ["journal"], `
Search relevance is finally in a place I'm happy with internally. Natural
questions like "what did we decide about pricing" now reliably surface the
pricing decision note near the top rather than some tangentially related
note. Keyword-style queries were never really the problem; it was always
the more conversational phrasing that needed the chunking and embedding
tuning to actually pay off.

Next up is handing this to Ana so she can start wiring the onboarding flow
around a working search feature instead of a stub.
`);

add("journal-2026-08-10", "journal", "product-cartograph", "2026-08-10",
  "Journal — Aug 10, 2026", ["journal"], `
Wrote up the full v2 status note tonight — good to step back and see the
whole picture. Six weeks behind original schedule but for a good reason
(relevance quality is genuinely better than v1 ever was, not just
"technically shipped"). October beta-reopen target feels realistic now, not
just hopeful.

Told Ingrid we're on track for an October re-invite when I ran into her
context switching between the vault and messaging — she's excited, still
has that 600+ note graph from the v1 beta apparently.
`);

add("journal-2026-08-15", "journal", "health-fitness", "2026-08-15",
  "Journal — Aug 15, 2026", ["journal"], `
20-miler done. Tough but manageable, exactly the kind of "hard but under
control" I was hoping for at this stage. Taper starts soon per Sarah's
more conservative plan than the improvised half-marathon taper from last
winter — trusting the process this time rather than second-guessing based
on how one long run felt, which is what led to shortening the taper
impulsively last time.
`);

add("journal-2026-08-20", "journal", "home-maintenance", "2026-08-20",
  "Journal — Aug 20, 2026", ["journal"], `
Fall seasonal checklist prep starting early this year since the marathon
and Japan trip are both going to eat October. Getting ahead on the gutter
cleaning and furnace tune-up scheduling now rather than trying to squeeze
it in later. HVAC filter is due for its 60-day-cadence swap too, noted for
this weekend.
`);

add("journal-2026-05-25", "journal", "product-cartograph", "2026-05-25",
  "Journal — May 25, 2026", ["journal"], `
Talked through the collaborative-editing question with Dev again tonight,
mostly just to make sure cutting it from v2 still feels right months later
rather than being a knee-jerk scope cut. It does — nobody in the beta
interviews asked for it unprompted, and the engineering lift would have
eaten the entire remaining budget for this build. Glad we wrote the
reasoning down in the constraints note instead of just remembering the
gut feeling, easier to revisit properly like this.
`);

add("journal-2026-06-22", "journal", "personal-finance", "2026-06-22",
  "Journal — Jun 22, 2026", ["journal"], `
Annual insurance review happened this week (per the finance overview note's
summer checkpoint). Nothing changed materially, premiums ticked up
slightly across the board, unremarkable. More notable: emergency fund
balance is now slightly above the $25,200 target after a couple of light
spending months, first time it's been comfortably over target in a while.
`);

add("journal-2026-03-15", "journal", "product-cartograph", "2026-03-15",
  "Journal — Mar 15, 2026", ["journal"], `
Interviewed two more beta users tonight for the retro writeup, both
strongly Synthesizer-persona. Both independently brought up wanting to ask
Cartograph something like a real question ("what did I conclude about X")
rather than typing keywords — validates the whole direction toward semantic
search pretty concretely, nice to hear it from users rather than just
assuming it from the v1 metrics.
`);

add("journal-2026-07-15", "journal", "health-fitness", "2026-07-15",
  "Journal — Jul 15, 2026", ["journal"], `
Meal prep got scaled up this week per the marathon-training adjustment to
the Sunday routine — extra carb-heavy container specifically for the day
after Saturday's long run. Small thing but noticeably better energy on
Sunday's easy run compared to weeks without the adjustment. Simple habit,
real payoff.
`);

add("journal-2026-04-28", "journal", "travel", "2026-04-28",
  "Journal — Apr 28, 2026", ["journal"], `
Both trip budget estimates are basically done now — Portugal at roughly
$3,600, Japan at roughly $4,800, both for two people. The gap is bigger
than I expected before actually running the numbers. Going to sit with both
itineraries for a couple more weeks before deciding; no rush yet since
neither has a booking deadline pressing.
`);

// ============================================================
// Write files
// ============================================================

let count = 0;
for (const n of notes) {
  const content = fm(n) + n.body + "\n";
  writeFileSync(join(CORPUS_DIR, `${n.slug}.md`), content, "utf8");
  count++;
}

console.log(`Wrote ${count} notes to ${CORPUS_DIR}`);

// Sanity: report type/area breakdown
const byType = {};
const byArea = {};
for (const n of notes) {
  byType[n.type] = (byType[n.type] || 0) + 1;
  byArea[n.area] = (byArea[n.area] || 0) + 1;
}
console.log("By type:", byType);
console.log("By area:", byArea);

if (count !== 120) {
  console.error(`WARNING: expected 120 notes, got ${count}`);
  process.exit(1);
}

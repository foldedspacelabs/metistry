# The wave schedule — a checklist

Generated from `docs/product/design-build-plan.md` by `ops/scripts/tickets.mjs`. A ticket is ticked when its file says `status: merged`; the coordinator ticks each checkpoint (§3.1) by hand below the generated list.

**144 tickets · 6 waves · ≈ 457 agent-days · critical path 35 agent-days** (F-3 → T4-1 → T4-2 → T4-8a → T4-8b → T4-9 → T4-10 → T4-11)

## W0 — 19 tickets, 38 agent-days

- [x] [F-0](f/f-0.md) · Conventions: the ratified wording · S · sonnet
- [x] [F-1](f/f-1.md) · Client API contract v1 · L · opus high
- [x] [F-2](f/f-2.md) · The actor model · M · opus high
- [x] [F-3](f/f-3.md) · Connection and extension model · M · opus high
- [x] [F-4](f/f-4.md) · The Scheduled model · M · opus high
- [x] [F-5](f/f-5.md) · The request type table · M · opus high
- [x] [F-6](f/f-6.md) · Migration numbering · S · opus high
- [ ] [F-7](f/f-7.md) · MetistryKit store interface and fixtures · M · opus high · after F-1
- [x] [F-8](f/f-8.md) · Dynamic router spec · M · opus high
- [x] [F-9](f/f-9.md) · PWA manifest, icons, `ICON_PNG` · S · sonnet
- [x] [F-10](f/f-10.md) · The `--check` extension · M · opus
- [x] [F-11](f/f-11.md) · `console call` prints the error body · S · sonnet
- [ ] [F-12](f/f-12.md) · The Mac session transport · M · opus · after F-11
- [ ] [F-13](f/f-13.md) · The reach gate · M · opus · after F-1
- [x] [F-14](f/f-14.md) · Copy and the answer set · S · sonnet
- [x] [T1-4](t1/t1-4.md) · Routine outcome · S · sonnet
- [x] [T1-5](t1/t1-5.md) · `collector_health` · S · sonnet
- [x] [T7-1](t7/t7-1.md) · Stop recomputing · M · opus
- [x] [T8-1](t8/t8-1.md) · The TCC enum · S · sonnet

- [ ] **W0 checkpoint** — merged, main green, scratch-instance upgrade, conformance test, Mac smoke, release

## W1 — 44 tickets, 119.5 agent-days

- [ ] [T1-1](t1/t1-1.md) · `work.description` · M · opus · after F-6
- [ ] [T1-2](t1/t1-2.md) · The board query · M · opus
- [ ] [T1-3](t1/t1-3.md) · The activity query · M · opus · after T1-4
- [ ] [T1-6](t1/t1-6.md) · Knowledge reads · M · opus
- [ ] [T1-7](t1/t1-7.md) · The Needs You count · S · sonnet · after F-1
- [ ] [T1-8](t1/t1-8.md) · Groups and sources · M · opus · after F-6
- [ ] [T1-9](t1/t1-9.md) · Today's order · S · sonnet · after F-6
- [ ] [T1-11](t1/t1-11.md) · The session archive table · S · sonnet · after F-6
- [ ] [T1-12](t1/t1-12.md) · Prose feedback · S · sonnet · after F-6
- [ ] [T1-14](t1/t1-14.md) · Areas · S · sonnet
- [ ] [T1-15](t1/t1-15.md) · Small queries · S · sonnet
- [ ] [T2-1](t2/t2-1.md) · Captures from the apps · S · sonnet
- [ ] [T2-2](t2/t2-2.md) · Access hardening · M · opus
- [ ] [T2-4](t2/t2-4.md) · The Tick door · M · opus · after F-13
- [ ] [T2-5](t2/t2-5.md) · The Defer door · M · opus · after T2-4
- [ ] [T2-6](t2/t2-6.md) · The section operation · L · opus high
- [ ] [T2-15](t2/t2-15.md) · C45, tested per door · M · opus
- [ ] [T2-16](t2/t2-16.md) · Identity and the config record · M · opus
- [ ] [T2-17](t2/t2-17.md) · Turn progress and sessions · S · sonnet · after T1-11, T1-15
- [ ] [T2-18](t2/t2-18.md) · Live events · L · opus high · after F-1, F-6
- [ ] [T3-1](t3/t3-1.md) · The scheduler · L · opus high · after F-4
- [ ] [T3-2](t3/t3-2.md) · The overlay · M · opus · after F-4, T3-1
- [ ] [T3-4](t3/t3-4.md) · Profile facts and the standup move · M · opus · after F-4, T1-8
- [ ] [T3-9](t3/t3-9.md) · Writing the session archive · M · opus · after T1-11
- [ ] [T4-1](t4/t4-1.md) · Per-instance secrets · L · opus high · after F-3
- [ ] [T4-2](t4/t4-2.md) · Egress guard and redaction · M · opus · after T4-1
- [ ] [T4-3](t4/t4-3.md) · Migrating the shared scope · M · opus · after T4-1
- [ ] [T4-4](t4/t4-4.md) · Variables · M · opus · after F-3
- [ ] [T4-5](t4/t4-5.md) · Registries · L · opus high · after F-3
- [ ] [T4-6](t4/t4-6.md) · Actors · L · opus high · after F-2
- [ ] [T4-20](t4/t4-20.md) · Keep awake and the lid · M · opus
- [ ] [T4-21](t4/t4-21.md) · Doctor for the Services pane · S · sonnet
- [ ] [T5-1](t5/t5-1.md) · The stores · L · opus high · after F-7, F-12
- [ ] [T5-2](t5/t5-2.md) · The shell · L · opus high · after F-7
- [ ] [T5-3](t5/t5-3.md) · Shared components · L · opus high · after F-7
- [ ] [T7-2](t7/t7-2.md) · The shell · L · opus high · after F-9
- [ ] [T9-1](t9/t9-1.md) · Decisions, in shadow · M · opus · after F-8
- [ ] [T10-1](t10/t10-1.md) · One commit per act · M · opus
- [ ] [T10-3](t10/t10-3.md) · Integrate before pushing · L · opus high · after T10-1
- [ ] [T10-2](t10/t10-2.md) · Sync policy and status · M · opus · after F-6
- [ ] [X-2](x/x-2.md) · `hasDb` needs the scratch name · S · sonnet
- [ ] [X-3](x/x-3.md) · A password test that a path can break · S · sonnet
- [ ] [X-4](x/x-4.md) · PWA maskable icon and dark manifest colours · S · sonnet
- [ ] [X-5](x/x-5.md) · The PWA reads F-5's table · M · opus · after F-5, F-14

- [ ] **W1 checkpoint** — merged, main green, scratch-instance upgrade, conformance test, Mac smoke, release

## W2 — 35 tickets, 128.5 agent-days

- [ ] [T1-10](t1/t1-10.md) · Meeting refs and people emails · M · opus · after F-6
- [ ] [T1-13](t1/t1-13.md) · Project grants table · S · sonnet · after F-6
- [ ] [T2-3](t2/t2-3.md) · Questions v2 and both report names · L · opus high · after F-5
- [ ] [T2-7](t2/t2-7.md) · Today routes and order · L · opus high · after T1-9, T2-4, T2-11
- [ ] [T2-8](t2/t2-8.md) · Close the Day · M · opus · after T2-5, T2-6
- [ ] [T2-9](t2/t2-9.md) · Events become requests · M · opus · after T1-8, F-5
- [ ] [T2-10](t2/t2-10.md) · Resolve a conflict · M · opus · after T2-9
- [ ] [T2-11](t2/t2-11.md) · Calendar fields and the meeting note · L · opus high · after T1-10
- [ ] [T2-14](t2/t2-14.md) · Stale requests · M · opus · after T1-8
- [ ] [T3-3](t3/t3-3.md) · Scheduled routes and doors · M · opus · after T3-1, T3-2, F-13
- [ ] [T3-5](t3/t3-5.md) · The Standup routine · M · opus · after T3-1
- [ ] [T3-6](t3/t3-6.md) · The Morning Brief · L · opus high · after T2-6, T3-5
- [ ] [T3-7](t3/t3-7.md) · Tomorrow's Plan after the fold · M · opus · after T3-1
- [ ] [T3-12](t3/t3-12.md) · Three strikes and a Stop limit · M · opus · after T2-9
- [ ] [T4-7](t4/t4-7.md) · Project grants inherited · M · opus · after T4-6, T1-13
- [ ] [T4-8a](t4/t4-8a.md) · Connections P1: registry and client · L · opus high · after T4-1, T4-2, T4-5
- [ ] [T4-8b](t4/t4-8b.md) · Connections P1: the lazy pair · L · opus high · after T4-8a
- [ ] [T4-24](t4/t4-24.md) · Linear: the connection and its sync · L · opus high · after T4-8a, T4-2, T1-8
- [ ] [T4-18](t4/t4-18.md) · Compute · L · opus high · after T4-1
- [ ] [T5-4a](t5/t5-4a.md) · Needs You: the list · L · opus high · after T5-2, T5-3
- [ ] [T5-4b](t5/t5-4b.md) · Needs You: the bodies · L · opus high · after T5-3
- [ ] [T5-5](t5/t5-5.md) · The capture composer · M · opus · after T5-1
- [ ] [T5-6](t5/t5-6.md) · The Usage popover · M · opus · after T5-1, T1-15
- [ ] [T5-7](t5/t5-7.md) · Live events on the Mac · M · opus · after F-12, T2-18
- [ ] [T6-1a](t6/t6-1a.md) · Today: the spine · L · opus high · after T5-3, T2-7
- [ ] [T6-1b](t6/t6-1b.md) · Today: brief, Next Up, close · L · opus high · after T5-3, T2-8, T3-6
- [ ] [T6-2](t6/t6-2.md) · Chat · L · opus high · after T5-3, T2-17
- [ ] [T6-3](t6/t6-3.md) · Activity · M · opus · after T5-3, T1-3
- [ ] [T7-3a](t7/t7-3a.md) · Today and Needs You · L · opus high · after T7-2
- [ ] [T7-3b](t7/t7-3b.md) · Work, Knowledge, More · L · opus high · after T7-2
- [ ] [T7-7](t7/t7-7.md) · Live events in the PWA · M · opus · after T2-18, T7-2
- [ ] [T9-2](t9/t9-2.md) · The policy · L · opus high · after T9-1
- [ ] [T10-4](t10/t10-4.md) · File history · M · opus · after T10-1
- [ ] [T10-5](t10/t10-5.md) · Restore a file · M · opus · after T10-4, T1-8
- [ ] [T10-6](t10/t10-6.md) · Roll back · L · opus high · after T10-3, T10-4

- [ ] **W2 checkpoint** — merged, main green, scratch-instance upgrade, conformance test, Mac smoke, release

## W3 — 28 tickets, 105 agent-days

- [ ] [T2-12](t2/t2-12.md) · Move a meeting · M · opus · after T2-11
- [ ] [T2-13](t2/t2-13.md) · Pull requests · L · opus high · after T1-8, T4-1
- [ ] [T3-8](t3/t3-8.md) · Agent routines · L · opus high · after T4-6, T3-3
- [ ] [T3-10](t3/t3-10.md) · The session fold · L · opus high · after T3-9
- [ ] [T3-11](t3/t3-11.md) · Routine suggestions · M · opus · after T3-3
- [ ] [T4-9](t4/t4-9.md) · Connections P2: Ask · L · opus high · after T4-8b
- [ ] [T4-12](t4/t4-12.md) · Calendar: ICS feeds · M · opus · after T2-11, T4-8a
- [ ] [T4-13](t4/t4-13.md) · Calendar: CalDAV with replies · L · opus high · after T4-12
- [ ] [T4-19](t4/t4-19.md) · Spending limits data · M · opus · after T4-18
- [ ] [T4-22](t4/t4-22.md) · Defer and report · M · opus · after T4-9
- [ ] [T4-23](t4/t4-23.md) · Mirrors and secret failures · M · opus · after T1-8, T4-1
- [ ] [T4-25](t4/t4-25.md) · Linear: a task becomes an issue · M · opus · after T4-24, T2-5
- [ ] [T4-26](t4/t4-26.md) · Linear: completion both ways · M · opus · after T4-24, T2-4
- [ ] [T6-4](t6/t6-4.md) · Knowledge · L · opus high · after T1-6, T2-10, T1-5
- [ ] [T6-5](t6/t6-5.md) · Agents · L · opus high · after T4-6
- [ ] [T6-6](t6/t6-6.md) · Scheduled · L · opus high · after T3-3
- [ ] [T6-7](t6/t6-7.md) · Board and card detail · L · opus high · after T1-1, T1-2
- [ ] [T6-8](t6/t6-8.md) · Projects · M · opus · after T4-7
- [ ] [T6-9](t6/t6-9.md) · Artifacts · L · opus high · after T5-3
- [ ] [T6-10](t6/t6-10.md) · Run detail · M · opus · after T2-17
- [ ] [T6-11](t6/t6-11.md) · The Settings window · L · opus high · after T5-1, T4-20, T4-21, T2-16
- [ ] [T7-4](t7/t7-4.md) · Offline · L · opus high · after T2-4
- [ ] [T7-5](t7/t7-5.md) · Push and enrolment · M · opus
- [ ] [T8-2a](t8/t8-2a.md) · The recorder: audio · L · opus high · after T8-1
- [ ] [T8-2b](t8/t8-2b.md) · The recorder: the session · L · opus high · after T8-2a
- [ ] [T8-6](t8/t8-6.md) · The private tier · M · opus · after T4-18
- [ ] [T9-3](t9/t9-3.md) · The confirmatory eval · M · opus · after T9-2
- [ ] [T10-7](t10/t10-7.md) · History in the app · M · opus · after T10-2, T10-4, T5-3

- [ ] **W3 checkpoint** — merged, main green, scratch-instance upgrade, conformance test, Mac smoke, release

## W4 — 17 tickets, 65 agent-days

- [ ] [T4-10](t4/t4-10.md) · Connections P3: HTTP, OAuth, generated tools · L · opus high · after T4-9
- [ ] [T4-11](t4/t4-11.md) · Targets and syncs as connections · L · opus high · after T4-10
- [ ] [T4-14](t4/t4-14.md) · Google Calendar through Metistry's client · L · opus high · after T4-10, T4-12
- [ ] [T4-15](t4/t4-15.md) · Mail: IMAP · L · opus high · after T4-8a
- [ ] [T4-17](t4/t4-17.md) · Invitation and message requests · M · opus · after T4-12, T4-15, T1-8
- [ ] [T6-12](t6/t6-12.md) · Compute · L · opus high · after T4-18, T4-19
- [ ] [T6-13a](t6/t6-13a.md) · Connections: list and detail · L · opus high · after T4-8a
- [ ] [T6-13b](t6/t6-13b.md) · Connections: add and configure · L · opus high · after T4-10
- [ ] [T6-14](t6/t6-14.md) · Secrets and Variables · M · opus · after T4-1, T4-4
- [ ] [T6-15](t6/t6-15.md) · Live Capture and Sessions · M · opus · after T8-4, T3-9
- [ ] [T6-16](t6/t6-16.md) · Hot keys and the audit · M · opus · after T5-2
- [ ] [T7-6](t7/t7-6.md) · Settings · M · opus · after F-13
- [ ] [T8-3](t8/t8-3.md) · Screen and window · L · opus high · after T8-2a
- [ ] [T8-4](t8/t8-4.md) · Retention and re-review · M · opus · after T8-2b, F-6
- [ ] [T8-5](t8/t8-5.md) · The bar · L · opus high · after T8-2a, T5-5
- [ ] [T8-7](t8/t8-7.md) · Meeting groups and anchors · M · opus · after T1-8, T8-2b
- [ ] [T9-4](t9/t9-4.md) · Wire the composer · M · opus · after T9-3, F-0

- [ ] **W4 checkpoint** — merged, main green, scratch-instance upgrade, conformance test, Mac smoke, release

## W5 — 1 tickets, 1 agent-days

- [ ] [X-1](x/x-1.md) · The document sweep · S · sonnet

- [ ] **W5 checkpoint** — merged, main green, scratch-instance upgrade, conformance test, Mac smoke, release

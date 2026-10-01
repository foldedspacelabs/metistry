# The wave schedule — a checklist

Generated from `docs/product/design-build-plan.md` by `ops/scripts/tickets.mjs`. A ticket is ticked when its file says `status: merged`; the coordinator ticks each checkpoint (§3.1) by hand below the generated list.

**167 tickets · 6 waves · ≈ 487.5 agent-days · critical path 35 agent-days** (F-3 → T4-1 → T4-2 → T4-8a → T4-8b → T4-9 → T4-10 → T4-11)

## W0 — 19 tickets, 38 agent-days

- [x] [F-0](f/f-0.md) · Conventions: the ratified wording · S · sonnet
- [x] [F-1](f/f-1.md) · Client API contract v1 · L · opus high
- [x] [F-2](f/f-2.md) · The actor model · M · opus high
- [x] [F-3](f/f-3.md) · Connection and extension model · M · opus high
- [x] [F-4](f/f-4.md) · The Scheduled model · M · opus high
- [x] [F-5](f/f-5.md) · The request type table · M · opus high
- [x] [F-6](f/f-6.md) · Migration numbering · S · opus high
- [x] [F-7](f/f-7.md) · MetistryKit store interface and fixtures · M · opus high · after F-1
- [x] [F-8](f/f-8.md) · Dynamic router spec · M · opus high
- [x] [F-9](f/f-9.md) · PWA manifest, icons, `ICON_PNG` · S · sonnet
- [x] [F-10](f/f-10.md) · The `--check` extension · M · opus
- [x] [F-11](f/f-11.md) · `console call` prints the error body · S · sonnet
- [x] [F-12](f/f-12.md) · The Mac session transport · M · opus · after F-11
- [x] [F-13](f/f-13.md) · The reach gate · M · opus · after F-1
- [x] [F-14](f/f-14.md) · Copy and the answer set · S · sonnet
- [x] [T1-4](t1/t1-4.md) · Routine outcome · S · sonnet
- [x] [T1-5](t1/t1-5.md) · `collector_health` · S · sonnet
- [x] [T7-1](t7/t7-1.md) · Stop recomputing · M · opus
- [x] [T8-1](t8/t8-1.md) · The TCC enum · S · sonnet

- [ ] **W0 checkpoint** — merged, main green, scratch-instance upgrade, conformance test, Mac smoke, release

## W1 — 44 tickets, 119.5 agent-days

- [x] [T1-1](t1/t1-1.md) · `work.description` · M · opus · after F-6
- [x] [T1-2](t1/t1-2.md) · The board query · M · opus
- [x] [T1-3](t1/t1-3.md) · The activity query · M · opus · after T1-4
- [x] [T1-6](t1/t1-6.md) · Knowledge reads · M · opus
- [x] [T1-7](t1/t1-7.md) · The Needs You count · S · sonnet · after F-1
- [x] [T1-8](t1/t1-8.md) · Groups and sources · M · opus · after F-6
- [x] [T1-9](t1/t1-9.md) · Today's order · S · sonnet · after F-6
- [x] [T1-11](t1/t1-11.md) · The session archive table · S · sonnet · after F-6
- [x] [T1-12](t1/t1-12.md) · Prose feedback · S · sonnet · after F-6
- [x] [T1-14](t1/t1-14.md) · Areas · S · sonnet
- [x] [T1-15](t1/t1-15.md) · Small queries · S · sonnet
- [x] [T2-1](t2/t2-1.md) · Captures from the apps · S · sonnet
- [x] [T2-2](t2/t2-2.md) · Access hardening · M · opus
- [x] [T2-4](t2/t2-4.md) · The Tick door · M · opus · after F-13
- [x] [T2-5](t2/t2-5.md) · The Defer door · M · opus · after T2-4
- [x] [T2-6](t2/t2-6.md) · The section operation · L · opus high
- [x] [T2-15](t2/t2-15.md) · C45, tested per door · M · opus
- [x] [T2-16](t2/t2-16.md) · Identity and the config record · M · opus
- [x] [T2-17](t2/t2-17.md) · Turn progress and sessions · S · sonnet · after T1-11, T1-15
- [x] [T2-18](t2/t2-18.md) · Live events · L · opus high · after F-1, F-6
- [x] [T3-1](t3/t3-1.md) · The scheduler · L · opus high · after F-4
- [x] [T3-2](t3/t3-2.md) · The overlay · M · opus · after F-4, T3-1
- [x] [T3-4](t3/t3-4.md) · Profile facts and the standup move · M · opus · after F-4, T1-8
- [x] [T3-9](t3/t3-9.md) · Writing the session archive · M · opus · after T1-11
- [x] [T4-1](t4/t4-1.md) · Per-instance secrets · L · opus high · after F-3
- [x] [T4-2](t4/t4-2.md) · Egress guard and redaction · M · opus · after T4-1
- [x] [T4-3](t4/t4-3.md) · Migrating the shared scope · M · opus · after T4-1
- [x] [T4-4](t4/t4-4.md) · Variables · M · opus · after F-3
- [x] [T4-5](t4/t4-5.md) · Registries · L · opus high · after F-3
- [x] [T4-6](t4/t4-6.md) · Actors · L · opus high · after F-2
- [x] [T4-20](t4/t4-20.md) · Keep awake and the lid · M · opus
- [x] [T4-21](t4/t4-21.md) · Doctor for the Services pane · S · sonnet
- [x] [T5-1](t5/t5-1.md) · The stores · L · opus high · after F-7, F-12
- [x] [T5-2](t5/t5-2.md) · The shell · L · opus high · after F-7
- [x] [T5-3](t5/t5-3.md) · Shared components · L · opus high · after F-7
- [x] [T7-2](t7/t7-2.md) · The shell · L · opus high · after F-9
- [x] [T9-1](t9/t9-1.md) · Decisions, in shadow · M · opus · after F-8
- [x] [T10-1](t10/t10-1.md) · One commit per act · M · opus
- [x] [T10-3](t10/t10-3.md) · Integrate before pushing · L · opus high · after T10-1
- [x] [T10-2](t10/t10-2.md) · Sync policy and status · M · opus · after F-6
- [x] [X-2](x/x-2.md) · `hasDb` needs the scratch name · S · sonnet
- [x] [X-3](x/x-3.md) · A password test that a path can break · S · sonnet
- [x] [X-4](x/x-4.md) · PWA maskable icon and dark manifest colours · S · sonnet
- [x] [X-5](x/x-5.md) · The PWA reads F-5's table · M · opus · after F-5, F-14

- [ ] **W1 checkpoint** — merged, main green, scratch-instance upgrade, conformance test, Mac smoke, release

## W2 — 35 tickets, 128.5 agent-days

- [x] [T1-10](t1/t1-10.md) · Meeting refs and people emails · M · opus · after F-6
- [x] [T1-13](t1/t1-13.md) · Project grants table · S · sonnet · after F-6
- [x] [T2-3](t2/t2-3.md) · Questions v2 and both report names · L · opus high · after F-5
- [x] [T2-7](t2/t2-7.md) · Today routes and order · L · opus high · after T1-9, T2-4, T2-11
- [x] [T2-8](t2/t2-8.md) · Close the Day · M · opus · after T2-5, T2-6
- [x] [T2-9](t2/t2-9.md) · Events become requests · M · opus · after T1-8, F-5
- [x] [T2-10](t2/t2-10.md) · Resolve a conflict · M · opus · after T2-9
- [x] [T2-11](t2/t2-11.md) · Calendar fields and the meeting note · L · opus high · after T1-10
- [x] [T2-14](t2/t2-14.md) · Stale requests · M · opus · after T1-8
- [x] [T3-3](t3/t3-3.md) · Scheduled routes and doors · M · opus · after T3-1, T3-2, F-13
- [x] [T3-5](t3/t3-5.md) · The Standup routine · M · opus · after T3-1
- [x] [T3-6](t3/t3-6.md) · The Morning Brief · L · opus high · after T2-6, T3-5
- [x] [T3-7](t3/t3-7.md) · Tomorrow's Plan after the fold · M · opus · after T3-1
- [x] [T3-12](t3/t3-12.md) · Three strikes and a Stop limit · M · opus · after T2-9
- [x] [T4-7](t4/t4-7.md) · Project grants inherited · M · opus · after T4-6, T1-13
- [x] [T4-8a](t4/t4-8a.md) · Connections P1: registry and client · L · opus high · after T4-1, T4-2, T4-5
- [x] [T4-8b](t4/t4-8b.md) · Connections P1: the lazy pair · L · opus high · after T4-8a
- [x] [T4-24](t4/t4-24.md) · Linear: the connection and its sync · L · opus high · after T4-8a, T4-2, T1-8
- [x] [T4-18](t4/t4-18.md) · Compute · L · opus high · after T4-1
- [x] [T5-4a](t5/t5-4a.md) · Needs You: the list · L · opus high · after T5-2, T5-3
- [x] [T5-4b](t5/t5-4b.md) · Needs You: the bodies · L · opus high · after T5-3
- [x] [T5-5](t5/t5-5.md) · The capture composer · M · opus · after T5-1
- [x] [T5-6](t5/t5-6.md) · The Usage popover · M · opus · after T5-1, T1-15
- [x] [T5-7](t5/t5-7.md) · Live events on the Mac · M · opus · after F-12, T2-18
- [x] [T6-1a](t6/t6-1a.md) · Today: the spine · L · opus high · after T5-3, T2-7
- [x] [T6-1b](t6/t6-1b.md) · Today: brief, Next Up, close · L · opus high · after T5-3, T2-8, T3-6
- [x] [T6-2](t6/t6-2.md) · Chat · L · opus high · after T5-3, T2-17
- [x] [T6-3](t6/t6-3.md) · Activity · M · opus · after T5-3, T1-3
- [x] [T7-3a](t7/t7-3a.md) · Today and Needs You · L · opus high · after T7-2
- [x] [T7-3b](t7/t7-3b.md) · Work, Knowledge, More · L · opus high · after T7-2
- [x] [T7-7](t7/t7-7.md) · Live events in the PWA · M · opus · after T2-18, T7-2
- [x] [T9-2](t9/t9-2.md) · The policy · L · opus high · after T9-1
- [x] [T10-4](t10/t10-4.md) · File history · M · opus · after T10-1
- [x] [T10-5](t10/t10-5.md) · Restore a file · M · opus · after T10-4, T1-8
- [x] [T10-6](t10/t10-6.md) · Roll back · L · opus high · after T10-3, T10-4

- [ ] **W2 checkpoint** — merged, main green, scratch-instance upgrade, conformance test, Mac smoke, release

## W3 — 46 tickets, 127.5 agent-days

- [x] [T2-12](t2/t2-12.md) · Move a meeting · M · opus · after T2-11
- [x] [T2-13](t2/t2-13.md) · Pull requests · L · opus high · after T1-8, T4-1
- [x] [T3-8](t3/t3-8.md) · Agent routines · L · opus high · after T4-6, T3-3
- [x] [T3-10](t3/t3-10.md) · The session fold · L · opus high · after T3-9
- [x] [T3-11](t3/t3-11.md) · Routine suggestions · M · opus · after T3-3
- [x] [T4-9](t4/t4-9.md) · Connections P2: Ask · L · opus high · after T4-8b
- [x] [T4-12](t4/t4-12.md) · Calendar: ICS feeds · M · opus · after T2-11, T4-8a
- [x] [T4-13](t4/t4-13.md) · Calendar: CalDAV with replies · L · opus high · after T4-12
- [x] [T4-19](t4/t4-19.md) · Spending limits data · M · opus · after T4-18
- [x] [T4-22](t4/t4-22.md) · Defer and report · M · opus · after T4-9
- [x] [T4-23](t4/t4-23.md) · Mirrors and secret failures · M · opus · after T1-8, T4-1
- [x] [T4-25](t4/t4-25.md) · Linear: a task becomes an issue · M · opus · after T4-24, T2-5
- [x] [T4-26](t4/t4-26.md) · Linear: completion both ways · M · opus · after T4-24, T2-4
- [x] [T6-4](t6/t6-4.md) · Knowledge · L · opus high · after T1-6, T2-10, T1-5
- [x] [T6-5](t6/t6-5.md) · Agents · L · opus high · after T4-6
- [x] [T6-6](t6/t6-6.md) · Scheduled · L · opus high · after T3-3
- [x] [T6-7](t6/t6-7.md) · Board and card detail · L · opus high · after T1-1, T1-2
- [x] [T6-8](t6/t6-8.md) · Projects · M · opus · after T4-7
- [x] [T6-9](t6/t6-9.md) · Artifacts · L · opus high · after T5-3
- [x] [T6-10](t6/t6-10.md) · Run detail · M · opus · after T2-17
- [x] [T6-11](t6/t6-11.md) · The Settings window · L · opus high · after T5-1, T4-20, T4-21, T2-16
- [x] [T7-4](t7/t7-4.md) · Offline · L · opus high · after T2-4
- [x] [T7-5](t7/t7-5.md) · Push and enrolment · M · opus
- [x] [T8-2a](t8/t8-2a.md) · The recorder: audio · L · opus high · after T8-1
- [x] [T8-2b](t8/t8-2b.md) · The recorder: the session · L · opus high · after T8-2a
- [x] [T8-6](t8/t8-6.md) · The private tier · M · opus · after T4-18
- [x] [T9-3](t9/t9-3.md) · The confirmatory eval · M · opus · after T9-2
- [x] [T10-7](t10/t10-7.md) · History in the app · M · opus · after T10-2, T10-4, T5-3
- [x] [X-6](x/x-6.md) · `/vault/log` is the owner's · S · sonnet · after T10-4
- [x] [X-7](x/x-7.md) · A provider key's grantee, and compute through the egress guard · M · opus · after T4-18, T4-2
- [x] [X-8](x/x-8.md) · An agent's connection grants persist · S · sonnet · after T4-8b
- [x] [X-9](x/x-9.md) · Restore is the Mac's · S · sonnet · after T10-5
- [x] [X-10](x/x-10.md) · A report is acknowledged; an agent reads its answer · M · opus · after T2-3
- [x] [X-11](x/x-11.md) · The routine folders take a create again · S · sonnet · after T3-6
- [x] [X-12](x/x-12.md) · Add to Today · S · sonnet · after T2-7, T4-24
- [x] [X-13](x/x-13.md) · A budget refusal is a report · S · sonnet · after T3-12
- [x] [X-14](x/x-14.md) · The `where:` grammar reaches Slipping and Owed · M · opus · after T2-7, T6-1a
- [x] [X-15](x/x-15.md) · Run Now after 23:00 re-renders the plan · S · sonnet · after T3-7
- [x] [X-16](x/x-16.md) · `{{ calendar }}` sanitises its titles · S · sonnet · after T3-6
- [x] [X-17](x/x-17.md) · A snooze that expires is an event · S · sonnet · after T5-7
- [x] [X-18](x/x-18.md) · `GET /api/messages` carries `turn_id` · S · sonnet · after T6-2
- [x] [X-19](x/x-19.md) · The offline capture queue is persisted · S · sonnet · after T5-5
- [x] [X-20](x/x-20.md) · `init --shape` and `--keep-awake` · S · sonnet
- [x] [X-21](x/x-21.md) · A routine's display name on Activity · S · sonnet · after T1-3, T6-3
- [x] [X-22](x/x-22.md) · The Mac reads `request.questions` · S · sonnet · after T5-4b
- [x] [X-23](x/x-23.md) · `connection_call` on Activity and turn progress · S · sonnet · after T1-3, T2-17, T4-8b

- [ ] **W3 checkpoint** — merged, main green, scratch-instance upgrade, conformance test, Mac smoke, release

## W4 — 22 tickets, 73 agent-days

- [x] [X-24](x/x-24.md) · Plan-tomorrow's test runs on its own clock · S · sonnet · after X-15
- [x] [X-29](x/x-29.md) · Main's Mac fixtures match the recorder · M · opus
- [x] [X-31](x/x-31.md) · The recorder's seeds are pinned to its clock · S · sonnet
- [x] [X-32](x/x-32.md) · A push carries Needs You only, and no text · M · opus
- [x] [X-41](x/x-41.md) · An owner-door secret refuses a connection or agent grant · S · sonnet · after T2-13
- [x] [T4-10](t4/t4-10.md) · Connections P3: HTTP, OAuth, generated tools · L · opus high · after T4-9
- [x] [T4-11](t4/t4-11.md) · Targets and syncs as connections · L · opus high · after T4-10
- [x] [T4-14](t4/t4-14.md) · Google Calendar through Metistry's client · L · opus high · after T4-10, T4-12
- [x] [T4-15](t4/t4-15.md) · Mail: IMAP · L · opus high · after T4-8a
- [x] [T4-17](t4/t4-17.md) · Invitation and message requests · M · opus · after T4-12, T4-15, T1-8
- [x] [T6-12](t6/t6-12.md) · Compute · L · opus high · after T4-18, T4-19
- [x] [T6-13a](t6/t6-13a.md) · Connections: list and detail · L · opus high · after T4-8a
- [x] [T6-13b](t6/t6-13b.md) · Connections: add and configure · L · opus high · after T4-10
- [x] [T6-14](t6/t6-14.md) · Secrets and Variables · M · opus · after T4-1, T4-4
- [x] [T6-15](t6/t6-15.md) · Live Capture and Sessions · M · opus · after T8-4, T3-9
- [x] [T6-16](t6/t6-16.md) · Hot keys and the audit · M · opus · after T5-2
- [x] [T7-6](t7/t7-6.md) · Settings · M · opus · after F-13
- [x] [T8-3](t8/t8-3.md) · Screen and window · L · opus high · after T8-2a
- [x] [T8-4](t8/t8-4.md) · Retention and re-review · M · opus · after T8-2b, F-6
- [x] [T8-5](t8/t8-5.md) · The bar · L · opus high · after T8-2a, T5-5
- [x] [T8-7](t8/t8-7.md) · Meeting groups and anchors · M · opus · after T1-8, T8-2b
- [ ] [T9-4](t9/t9-4.md) · Wire the composer · M · opus · after T9-3, F-0 · **in-review**

- [ ] **W4 checkpoint** — merged, main green, scratch-instance upgrade, conformance test, Mac smoke, release · waiting on T9-4 (in-review)

## W5 — 1 tickets, 1 agent-days

- [ ] [X-1](x/x-1.md) · The document sweep · S · sonnet

- [ ] **W5 checkpoint** — merged, main green, scratch-instance upgrade, conformance test, Mac smoke, release

## W4 candidates — 90 tickets, 158.5 agent-days, no wave yet

Follow-ups specified in the plan (§3.2's *Candidates* row) that nobody has scheduled. The owner assigns each one a wave at a checkpoint; until then none is dispatched.

- [ ] [X-25](x/x-25.md) · DB-backed suites survive file parallelism · M · opus
- [ ] [X-26](x/x-26.md) · Linear's sync reads in a stable order · S · sonnet · after T4-26
- [ ] [X-27](x/x-27.md) · The router-policy test has no wall-clock bound · S · sonnet
- [ ] [X-28](x/x-28.md) · The chat viewport test is deterministic · S · sonnet
- [ ] [X-30](x/x-30.md) · The recorder checks the values a contract depends on · M · opus · after X-29
- [ ] [X-33](x/x-33.md) · The PWA's last browser dialogs · S · sonnet
- [ ] [X-34](x/x-34.md) · Ask First raises one card per subject · M · opus · after T4-9
- [ ] [X-35](x/x-35.md) · Approve re-checks the agent · S · sonnet · after T4-9
- [ ] [X-36](x/x-36.md) · Run detail shows connection calls · S · sonnet · after T6-10, X-23
- [ ] [X-37](x/x-37.md) · A crew keeps its caller's interactivity · S · sonnet · after T3-8
- [ ] [X-38](x/x-38.md) · The owner sees an actor's connections in its scope · S · sonnet
- [ ] [X-39](x/x-39.md) · A revoked connection grant refuses the next call · S · sonnet · after X-8
- [ ] [X-40](x/x-40.md) · A failed connection call in turn progress · S · sonnet · after X-23
- [ ] [X-42](x/x-42.md) · An owner door is a grantee kind · M · opus · after X-41
- [ ] [X-43](x/x-43.md) · `private` is a reserved tier name · S · sonnet · after T8-6
- [ ] [X-44](x/x-44.md) · Every compute call goes through the egress guard · M · opus · after X-7
- [ ] [X-45](x/x-45.md) · A secret too short to redact safely is refused when stored · S · sonnet · after X-7
- [ ] [X-46](x/x-46.md) · A provider refusal is one request per secret · S · sonnet · after T4-23
- [ ] [X-47](x/x-47.md) · `secrets sync` restarts only what changed · M · opus
- [ ] [X-48](x/x-48.md) · Doctor's sandbox row reports what runs · S · sonnet
- [ ] [X-49](x/x-49.md) · The brain's eager surface has headroom · M · opus
- [ ] [X-50](x/x-50.md) · Session-purge is quiet while the Session Fold is paused · S · sonnet · after T3-10
- [ ] [X-51](x/x-51.md) · A routine's dated file the assistant created · S · sonnet · after X-11
- [ ] [X-52](x/x-52.md) · The weekly review counts only the owner's decisions · S · sonnet
- [ ] [X-53](x/x-53.md) · The meeting note reads `METISTRY_TZ` only · S · sonnet
- [ ] [X-54](x/x-54.md) · Calendar location and name chips are sanitised · S · sonnet · after X-16
- [ ] [X-55](x/x-55.md) · Moving a meeting someone else organised · S · sonnet · after T2-12
- [ ] [X-56](x/x-56.md) · An iCloud CalDAV account needs no second step · M · opus · after T4-13
- [ ] [X-57](x/x-57.md) · CalDAV's own-event write has a door · M · opus · after T4-13
- [ ] [X-58](x/x-58.md) · Add to Today for GitHub tasks · S · sonnet · after X-12, T4-23
- [ ] [X-59](x/x-59.md) · Linear's Close offer and Done chip in the clients · M · opus · after T4-26
- [ ] [X-60](x/x-60.md) · The PWA does not count the assistant as a project member · S · sonnet
- [ ] [X-61](x/x-61.md) · Add to Today on the Mac · S · sonnet · after X-12
- [ ] [X-62](x/x-62.md) · The Mac names a connection call · S · sonnet · after X-23
- [ ] [X-63](x/x-63.md) · SavedTaskView reads Slipping and Owed · S · sonnet · after X-14
- [ ] [X-64](x/x-64.md) · The Mac's receipt knows "acknowledged" · S · sonnet · after X-10
- [ ] [X-65](x/x-65.md) · A route for collector health · S · sonnet · after T6-4
- [ ] [X-66](x/x-66.md) · Run detail carries its route and a routine run's session · M · opus · after T6-10
- [ ] [X-67](x/x-67.md) · The board row carries why it is blocked, and one task has a route · M · opus · after T6-7
- [ ] [X-68](x/x-68.md) · The artifacts list says what each one is · M · opus · after T6-9
- [ ] [X-69](x/x-69.md) · Settings can name a release and count doctor's checks · M · opus · after T6-11
- [ ] [X-70](x/x-70.md) · A session's fold items are served · S · sonnet · after T3-10, T6-10
- [ ] [X-71](x/x-71.md) · `init` resolves the shape before it asks about keep-awake · S · sonnet · after X-20
- [ ] [X-72](x/x-72.md) · The recorder's sockets live under the instance · S · sonnet · after T8-2b
- [ ] [X-73](x/x-73.md) · Transcripts land where the ruling says · S · sonnet · after T8-2b
- [ ] [X-74](x/x-74.md) · CI's Swift-helper filter is anchored · S · sonnet
- [ ] [X-80](x/x-80.md) · `metistry up` mints the recorder's control token · S · sonnet · after T8-5
- [ ] [X-81](x/x-81.md) · Kept recordings have a list route · S · sonnet · after T6-15, T8-4
- [ ] [X-82](x/x-82.md) · The Mac's meeting group decodes `group_id` · S · sonnet · after T8-7
- [ ] [X-83](x/x-83.md) · The activity feed's capture subject reads the title only · S · sonnet · after T8-6
- [ ] [X-84](x/x-84.md) · `POST /message` carries a session-turn marker · M · opus · after T8-6, T6-15
- [ ] [X-85](x/x-85.md) · The targets shim comes out · S · sonnet · after T4-11
- [ ] [X-86](x/x-86.md) · The Mac's Secrets pane hides Grant for an owner-door secret · S · sonnet · after X-41, T6-14
- [ ] [X-87](x/x-87.md) · The calendar collectors export `check()` · S · sonnet · after T4-14
- [ ] [X-88](x/x-88.md) · The workspace test script isolates each package's database · M · opus
- [ ] [X-89](x/x-89.md) · A request raised while the console is down still pushes · S · sonnet · after X-32
- [ ] [X-90](x/x-90.md) · The hot-key and accessibility audits see what they miss · S · sonnet · after T6-16
- [ ] [X-91](x/x-91.md) · The three-pointers test tolerates the device-local keys · S · sonnet · after T6-16, T6-15
- [ ] [X-92](x/x-92.md) · Dispatch's `REPO_RE` has a misuse test · S · sonnet · after T4-11
- [ ] [X-93](x/x-93.md) · `socketDestination` keeps IMAP's port · S · sonnet · after T4-15
- [ ] [X-94](x/x-94.md) · The wizard's copy templates the configured name · S · sonnet · after T6-12
- [ ] [X-95](x/x-95.md) · The Mac's loopback set matches core's · S · sonnet · after T6-13a
- [ ] [X-96](x/x-96.md) · A connection's detail says who uses it and when it was checked · S · sonnet · after T6-13a
- [ ] [X-97](x/x-97.md) · Variables: when it was set, the preview an agent sees, and a key's expiry · S · sonnet · after T6-14
- [ ] [X-98](x/x-98.md) · Agents and Compute: the model line, the key note and the download · S · sonnet · after T6-12, T6-5
- [ ] [X-99](x/x-99.md) · The phone's writable rows have controls · S · sonnet · after T7-6
- [ ] [X-100](x/x-100.md) · The "held to core" Swift tests cannot drift · S · sonnet · after T6-14, T6-5
- [ ] [X-101](x/x-101.md) · Bare `metistry doctor` resolves the product directory it runs from · S · sonnet
- [ ] [X-102](x/x-102.md) · The recorder leaves no fixed-id rows behind · S · sonnet · after X-31
- [ ] [X-75](x/x-75.md) · `metistry enroll` — an enrolment code minted on this Mac · M · opus high
- [ ] [X-76](x/x-76.md) · Removing a device revokes its passkey · M · opus high
- [ ] [X-77](x/x-77.md) · Settings ▸ Devices and the Add a Phone sheet · L · opus high · after X-75, X-76
- [ ] [X-78](x/x-78.md) · The phone's half: enrol, install, sign in · M · opus
- [ ] [X-79](x/x-79.md) · The phone guide, and the website's copy re-checked · S · sonnet · after X-75, X-76, X-77, X-78
- [ ] [X-103](x/x-103.md) · The console's proxy listener — the local owner token never crosses a tunnel · M · opus
- [ ] [X-104](x/x-104.md) · Passkeys per origin — the rpID follows the request · M · opus
- [ ] [X-105](x/x-105.md) · `metistry remote` — the record, the adapter interface, and None · M · opus · after X-103, X-104
- [ ] [X-106](x/x-106.md) · The Tailscale adapter — Funnel by default, tailnet as the alternative · L · opus high · after X-105, X-111, X-112
- [ ] [X-107](x/x-107.md) · Set Up Remote Access — the guided flow, the wizard step and Settings ▸ Remote Access · L · opus high · after X-105, X-106, X-112, X-77
- [ ] [X-108](x/x-108.md) · The Cloudflare Tunnel adapter · L · opus high · after X-105, X-111, X-112
- [ ] [X-109](x/x-109.md) · The ngrok adapter · M · opus · after X-105, X-111
- [ ] [X-110](x/x-110.md) · The port-forwarding adapter · L · opus high · after X-105, X-111
- [ ] [X-111](x/x-111.md) · A console on the internet — rate limits and headers on the proxy listener · M · opus · after X-103
- [ ] [X-112](x/x-112.md) · Provider tool packs — pinned, signed, fetched on choice · M · opus · after X-105
- [ ] [X-113](x/x-113.md) · The zrok adapter · M · opus · after X-105, X-111, X-112
- [ ] [X-114](x/x-114.md) · Add a Phone sees the phone arrive — *Opened on your phone* · S · sonnet · after X-75, X-77, X-103
- [ ] [X-115](x/x-115.md) · Metistry Relay data plane — the PoC, then the instance · L · opus high · after X-112
- [ ] [X-116](x/x-116.md) · Metistry Relay control plane — CDK, Lambda, DynamoDB, the ACME helper · L · opus high · after X-115
- [ ] [X-117](x/x-117.md) · The Metistry Relay adapter — client, certificate, allowance · M · opus · after X-105, X-111, X-112, X-116
- [ ] [X-118](x/x-118.md) · `u.metistry.app` on the Public Suffix List · S · sonnet

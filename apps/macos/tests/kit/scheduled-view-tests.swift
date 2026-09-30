// Scheduled (T6-6). Built against the recorded fixtures first — T3-3's
// doors as the console served them, `GET /api/runs/:id` and `GET /api/whoami`
// — and a scripted console where a fixture cannot say it (a routine that
// ticked silently all day, a remote client, a sync that stopped, a console
// that stops answering).
//
// The ticket's two bold tests are the first two: **a silent tick is not an
// occurrence**, and **the assignment editor calls the `local` route and is
// absent on a remote client**. Then the list, the week, the detail, the
// sync, the states, and §2.18. macOS only, as the accessibility probe is.

#if os(macOS)
import AppKit
import Foundation
import SwiftUI
import Testing

@testable import MetistryKit

// MARK: - The ticket's two

@MainActor
@Test func aSilentTickIsNotAnOccurrence() async throws {
    let console = try ScheduledConsole()
    // Morning Brief ticked every hour of the night and did nothing each time;
    // Inbox Sort ticked every five minutes the same way.
    let silent = (0..<12).map { i in run(id: 100 + i, at: String(format: "2026-09-26T%02d:00:00.000Z", 12 + i), ok: true, outcome: "silent") }
    console.serve("GET", "/api/scheduled", try listing { name, fields in
        if name == "morning-brief" || name == "inbox-drain" { fields["last_run"] = silent[0] }
    })
    var brief = try detailBody("morning-brief")
    brief["history"] = .array(silent)
    console.serve("GET", "/api/scheduled/routines/morning-brief", .object(brief))
    let (model, session) = scheduledModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.refreshIfDue()

    // The rows are the schedule's: Morning Brief acts once before Tuesday — Monday at 7:00 — and twelve ticks add nothing.
    let rows = model.routineBands.flatMap(\.rows)
    let briefRows = rows.filter { $0.name == "morning-brief" }
    #expect(briefRows.map(\.kind) == [.occurrence(WireTime.date("2026-09-28T11:00:00.000Z")!)], "\(briefRows)")
    // An interval routine is one row, in its own band, never an occurrence.
    let throughout = try #require(model.routineBands.first)
    #expect(throughout.title == ScheduledWords.throughoutTheDay)
    #expect(throughout.rows.map(\.name) == ["inbox-drain", "session-fold", "claude-usage"])
    #expect(rows.filter { $0.name == "inbox-drain" }.map(\.kind) == [.throughout])
    // The week counts what the schedule places: five working days of the brief, whatever ticked.
    let week = model.week
    let weekRuns: [WeekAxis.Run] = week.days.flatMap(\.runs)
    let briefMarks = weekRuns.filter { $0.title == "Morning Brief" }.count
    #expect(briefMarks == 5)
    #expect(!weekRuns.contains { $0.title == "Inbox Sort" })

    // A silent run is *Nothing to do* — never *Succeeded*, never "silent".
    let row = try #require(model.presentation(briefRows[0], assistantName: "Aide"))
    #expect(row.spoken == "7:00 AM, Morning Brief, default, run by Aide, working days at 7 AM. Nothing to do", "\(row.spoken)")
    #expect(!row.spoken.localizedCaseInsensitiveContains("silent"))
    #expect(row.glyph == nil, "nothing to do is not a state that needs a mark")

    // History is where the ticks are — all twelve, each said in words.
    model.selection = briefRows[0].id
    await model.loadSelection()
    let history = try #require(model.routineDetails["morning-brief"]?.value?.history)
    #expect(history.count == 12)
    #expect(history.allSatisfy { $0.result == .nothingToDo && $0.result.word == "Nothing to do" })
    #expect(model.routineBands.flatMap(\.rows).count == rows.count, "reading history added no rows")
}

@MainActor
@Test func theAssignmentEditorCallsTheLocalRouteAndIsAbsentOnARemoteClient() async throws {
    // The route is `local` in the client API's own table.
    let table = try String(contentsOf: repoRoot().appendingPathComponent("packages/core/src/client-api.ts"), encoding: .utf8)
    let row = try #require(table.split(separator: "\n").first { $0.contains("\"PUT\", \"/api/scheduled/routines/:name/assignment\"") })
    #expect(row.contains("reach: [\"local\"]"), "\(row)")

    // On this Mac — `whoami` says the local owner token — the editor is there, and saving calls that route.
    let local = try ScheduledConsole()
    local.serve("GET", "/api/scheduled/routines/weekly-digest", try weeklyDigestDetail())
    let (model, session) = scheduledModel(local)
    defer { withExtendedLifetime(session) {} }
    await model.refreshIfDue()
    #expect(model.reach == .local)
    model.selection = ScheduledRow(name: "weekly-digest", kind: .inactive).id
    await model.loadSelection()
    let here = try await AccessibilityProbe.snapshot(detail(model).frame(width: 640, height: 1400))
    #expect(here.controlNames.contains("Edit Task"), "controls: \(here.controlNames)")
    here.close()
    local.reset()
    let saved = await model.saveAssignment(routine: "weekly-digest", actor: "researcher", task: "Summarise the week's Projects/ changes.", reads: ["Projects"])
    #expect(saved)
    let put = try #require(local.calls.first { $0.method == "PUT" })
    #expect(put.path == "/api/scheduled/routines/weekly-digest/assignment")
    #expect(put.servedBy == "put-api-scheduled-routines-name-assignment")
    #expect(put.body == .object([
        "actor": .string("researcher"),
        "task": .string("Summarise the week's Projects/ changes."),
        "grants": .object(["read": .array([.string("Projects")])]),
        "schedule": .object(["days": .array([.string("fri")]), "at": .array([.string("15:00")])]),
    ]), "\(String(describing: put.body))")

    // A remote client — a passkey session — never sees the editor, and the model sends nothing.
    let remote = try ScheduledConsole()
    remote.serve("GET", "/api/whoami", .object(["principal": .string("user"), "via": .string("passkey_session"), "management": .bool(true)]))
    remote.serve("GET", "/api/scheduled/routines/weekly-digest", try weeklyDigestDetail())
    let (away, awaySession) = scheduledModel(remote)
    defer { withExtendedLifetime(awaySession) {} }
    await away.refreshIfDue()
    #expect(away.reach == .remote(via: "passkey_session"))
    away.selection = ScheduledRow(name: "weekly-digest", kind: .inactive).id
    await away.loadSelection()
    let there = try await AccessibilityProbe.snapshot(detail(away).frame(width: 640, height: 1400))
    defer { there.close() }
    #expect(!there.controlNames.contains("Edit Task"), "controls: \(there.controlNames)")
    #expect(!there.controlNames.contains(ScheduledWords.newRoutine))
    #expect((there.labels + there.texts).contains(ScheduledWords.onlyTheMac))
    // The task is still read — only the change is the Mac's.
    #expect((there.labels + there.texts).contains("Summarise the week's Areas/ changes."))
    remote.reset()
    let refused = await away.saveAssignment(routine: "weekly-digest", actor: "researcher", task: "Anything", reads: [])
    #expect(!refused)
    #expect(remote.calls.isEmpty, "nothing was sent: \(remote.calls)")
    #expect(away.notes["weekly-digest"]?.text == ScheduledWords.onlyTheMac)

    // And the console's own `local_only` answer takes the editor away.
    let refusing = try ScheduledConsole()
    refusing.serve("GET", "/api/scheduled/routines/weekly-digest", try weeklyDigestDetail())
    refusing.fail("PUT", "/api/scheduled/routines/weekly-digest/assignment", .http(status: 403, envelope: ConsoleErrorEnvelope(code: "local_only", message: "PUT /api/scheduled/routines/:name/assignment is the Mac app's alone")))
    let (told, toldSession) = scheduledModel(refusing)
    defer { withExtendedLifetime(toldSession) {} }
    await told.refreshIfDue()
    #expect(told.reach == .local)
    let answer = await told.saveAssignment(routine: "weekly-digest", actor: "researcher", task: "Anything", reads: [])
    #expect(!answer)
    #expect(!told.reach.changesWhatRuns)
}

// MARK: - The list

@MainActor
@Test func theListIsOrderedByWhatRunsNextInDayBands() async throws {
    let (model, _, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    let bands = model.routineBands
    // The New Routine runs since T3-8: it sits on the day it next acts, and nothing is inactive.
    #expect(bands.map(\.title) == [ScheduledWords.throughoutTheDay, "Today", "Tomorrow · Monday", "Friday · 2 Oct"], "\(bands.map(\.title))")
    let today = try #require(bands.first { $0.title == "Today" })
    let titles = { (band: ScheduledBand) in band.rows.compactMap { model.presentation($0, assistantName: "Aide").map { "\($0.when) \($0.title)" } } }
    #expect(titles(today) == ["4:00 AM Session Purge", "6:00 AM Update Check", "6:00 PM Weekly Review", "9:00 PM Knowledge Fold", "11:00 PM Reply Review", "11:00 PM Tomorrow's Plan"], "\(titles(today))")
    let monday = try #require(bands.first { $0.title == "Tomorrow · Monday" })
    #expect(titles(monday) == ["4:00 AM Session Purge", "6:00 AM Update Check", "7:00 AM Morning Brief", "8:00 AM Standup", "9:00 PM Knowledge Fold", "11:00 PM Reply Review", "11:00 PM Tomorrow's Plan"], "\(titles(monday))")
    // A daily routine appears under each day; a weekly one once.
    let allRows: [ScheduledRow] = bands.flatMap(\.rows)
    let folds = allRows.filter { $0.name == "knowledge-fold" }.count
    let reviews = allRows.filter { $0.name == "weekly-review" }.count
    #expect(folds == 2)
    #expect(reviews == 1)
    // A New Routine appears once, on the day it next acts, run by its crew — not held (T3-8).
    let friday = try #require(bands.last)
    #expect(friday.rows.map(\.name) == ["weekly-digest"])
    #expect(!bands.contains { $0.title == ScheduledWords.inactive })
    let digest = try #require(model.presentation(friday.rows[0], assistantName: "Aide"))
    #expect(digest.when == "3:00 PM")
    #expect(digest.runBy == "researcher" && digest.runByIsAgent)
    #expect(digest.glyph == nil, "it has not run yet")
    #expect(digest.detail == nil, "nothing holds it")
    // The tabs' counts: the recorder seeds twelve routines and eight syncs.
    #expect(model.count(.routines) == 12)
    #expect(model.count(.syncs) == 8)
}

@MainActor
@Test func aHeldRoutineSitsInInactiveWithWhy() async throws {
    // The recorded New Routine runs (T3-8); a console whose runner has no crew queue still holds one, and says why.
    let why = "a New Routine runs as one crew run, and this console's runner was started without the crew queue — it is kept, listed, and not run here (docs/ops/scheduled.md)"
    let console = try ScheduledConsole()
    console.serve("GET", "/api/scheduled", try listing { name, fields in
        if name == "weekly-digest" { fields["held"] = .string(why); fields["next_run"] = .null }
    })
    let (model, session) = scheduledModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.refreshIfDue()
    let inactive = try #require(model.routineBands.last)
    #expect(inactive.title == ScheduledWords.inactive)
    #expect(inactive.rows.map(\.name) == ["weekly-digest"])
    let digest = try #require(model.presentation(inactive.rows[0], assistantName: "Aide"))
    #expect(digest.when == "—")
    #expect(digest.runBy == "researcher" && digest.runByIsAgent)
    #expect(digest.glyph == .absent)
    #expect(digest.detail == why)
}

@MainActor
@Test func aRowSpeaksTheSpokenTableAndAFailureInItsOwnInk() async throws {
    let (model, _, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    let rows = model.routineBands.flatMap(\.rows)
    func spoken(_ name: String) -> ScheduledRowPresentation? { rows.first { $0.name == name }.flatMap { model.presentation($0, assistantName: "Aide") } }
    #expect(spoken("standup")?.spoken == "8:00 AM, Standup, default, run by Aide, working days at 8 AM. Succeeded", "the recorder seeds a standup run")
    #expect(spoken("plan-tomorrow")?.spoken == "11:00 PM, Tomorrow's Plan, default, run by Aide, evenings before working days at 11 PM. Succeeded")
    let fold = try #require(spoken("knowledge-fold"))
    #expect(fold.spoken == "9:00 PM, Knowledge Fold, default, run by Aide, every day at 9 PM. Failed, vault bridge unreachable", "\(fold.spoken)")
    #expect(fold.glyph == .failed && fold.glyphInk == .failed)
    #expect(fold.detail == "vault bridge unreachable" && fold.detailInk == .failed, "the error verbatim, in the failed ink")
    #expect(fold.recurrence == "Every day at 9:00 PM")
    let sort = try #require(spoken("inbox-drain"))
    #expect(sort.spoken == "Inbox Sort, default, run by Aide, every 5 minutes. Hasn't run yet")
    // Until the name is known, no name — never the principal id.
    let unnamed = try #require(rows.first { $0.name == "standup" }.flatMap { model.presentation($0, assistantName: nil) })
    #expect(unnamed.runBy == nil)
    #expect(!unnamed.spoken.localizedCaseInsensitiveContains("assistant"))
}

@MainActor
@Test func theWeekSpeaksOneSentenceAndOffersItsTable() async throws {
    let (model, _, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    let week = model.week
    #expect(week.days.count == 7)
    #expect(week.days.map(\.label) == ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"])
    // Four every day, the brief and the standup on five, the plan on five eves, the review once — and the New Routine on Friday (T3-8).
    #expect(week.count == 45)
    #expect(week.duringTheDay == 6, "the standup at 8:00 and the New Routine's Friday 3:00 PM are the runs in the working day")
    #expect(week.sentence == "This week: 45 runs, 6 between 7 AM and 6 PM")
    #expect(week.days[0].summary.hasPrefix("6 runs: Session Purge at 4:00 AM"), "\(week.days[0].summary)")
    #expect(week.days.allSatisfy { $0.marks.allSatisfy { (0...1).contains($0) } })

    // Only the before-and-after routines: the sentence the design was drawn for.
    let quiet = WeekAxis(days: [], count: 39, duringTheDay: 0)
    #expect(quiet.sentence == "This week: 39 runs, all by 7 AM or after 6 PM")
    #expect(WeekAxis(days: [], count: 0, duringTheDay: 0).sentence == "This week: nothing runs at a set time")

    let tree = try await AccessibilityProbe.snapshot(WeekAxisView(week: week, showsTable: .constant(false)).frame(width: 420))
    defer { tree.close() }
    let image = try #require(tree.nodes.first { $0.name == week.sentence }, "labels: \(tree.labels)")
    #expect(image.role == "AXImage", "\(image)")
    #expect(tree.controlNames.contains("Show as Table"))
    let table = try await AccessibilityProbe.snapshot(WeekAxisView(week: week, showsTable: .constant(true)).frame(width: 420))
    defer { table.close() }
    #expect(table.labels.contains { $0.hasPrefix("Sunday 27 Sep, 6 runs: Session Purge at 4:00 AM") }, "\(table.labels)")
}

@MainActor
@Test func occurrencesFollowTheRoutinesZoneAcrossDST() throws {
    // 1 Nov 2026 is when New York leaves daylight time: 7:00 AM stays 7:00 AM on the wall.
    let routine = try #require(ScheduledRoutine(json: routineJSON("brief", days: ["sun", "mon"], at: ["07:00"], tz: "America/New_York")))
    let from = WireTime.date("2026-10-31T12:00:00.000Z")!
    let to = WireTime.date("2026-11-03T12:00:00.000Z")!
    let times = ScheduledCalendar.occurrences(of: routine, from: from, to: to, fallbackZone: TimeZone(identifier: "UTC")!)
    #expect(times == [WireTime.date("2026-11-01T12:00:00.000Z")!, WireTime.date("2026-11-02T12:00:00.000Z")!], "\(times)")
    // Paused: nothing is placed, and it says so rather than going quiet.
    let paused = try #require(ScheduledRoutine(json: routineJSON("brief", days: ["sun"], at: ["07:00"], paused: true)))
    #expect(ScheduledCalendar.occurrences(of: paused, from: from, to: to, fallbackZone: .current).isEmpty)
    #expect(paused.isInactive)
}

@Test func recurrenceIsTheRuleInWords() {
    #expect(ScheduledWords.recurrence(.timeOfDay(days: .workingDays, at: ["07:00"], tz: nil)) == "Working days at 7:00 AM")
    #expect(ScheduledWords.recurrence(.timeOfDay(days: .weekdays(["sun"]), at: ["18:00"], tz: nil)) == "Sundays at 6:00 PM")
    #expect(ScheduledWords.recurrence(.timeOfDay(days: .weekdays(["mon", "wed", "fri"]), at: ["06:30", "12:00"], tz: nil)) == "Mon, Wed, Fri at 6:30 AM and 12:00 PM")
    #expect(ScheduledWords.recurrence(.timeOfDay(days: .weekdays(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]), at: ["00:15"], tz: nil)) == "Every day at 12:15 AM")
    #expect(ScheduledWords.recurrence(.interval("1h")) == "Every hour")
    #expect(ScheduledWords.recurrence(.interval("15m"), spoken: true) == "every 15 minutes")
    #expect(ScheduledWords.cadences.map(ScheduledWords.cadence) == ["5 min", "15 min", "Hour", "6 hours"])
    #expect(FieldOrigin.allCases.map(\.label) == ["default", "from your profile", "yours"])
}

// MARK: - A routine

@MainActor
@Test func aRoutinesDetailShowsWhereEachFieldCameFromAndHistoryOpenToItsSteps() async throws {
    let (model, console, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    model.selection = try #require(model.routineBands.flatMap(\.rows).first { $0.name == "morning-brief" }).id
    await model.loadSelection()
    let reading = try #require(model.routineDetails["morning-brief"]?.value)
    #expect(reading.routine.days?.origin == .profile)
    #expect(reading.routine.schedule.origin == .default)
    #expect(reading.routine.timeZone == Sourced(value: "America/New_York", origin: .profile))
    #expect(reading.routine.config == [ScheduledConfigField(key: "template", value: "Templates/Brief.md", origin: .default)])
    // The latest run is read for its steps — the one the recorded list names.
    let latest = try #require(routineFromListing("morning-brief")["last_run"]?["run_id"]?.stringValue.flatMap { Int($0) })
    #expect(console.calls.contains { $0.method == "GET" && $0.path == "/api/runs/\(latest)" })
    let steps = try #require(model.steps[latest]?.value)
    #expect(steps.model == "gemma")

    let tree = try await AccessibilityProbe.snapshot(detail(model).frame(width: 640, height: 1600))
    defer { tree.close() }
    #expect(tree.unlabeledControls.isEmpty, "unlabeled: \(tree.unlabeledControls)")
    for heading in ["Schedule", "What It's Asked to Do", "Reads and Writes", "History"] {
        #expect(tree.headings.contains(heading), "no \(heading): \(tree.headings)")
    }
    let said = tree.labels + tree.texts
    #expect(said.contains("Days · Working days, from your profile"), "\(said)")
    #expect(said.contains("Time zone · America/New_York, from your profile"), "\(said)")
    #expect(said.contains("Template, Templates/Brief.md, default"), "\(said)")
    #expect(said.contains { $0.hasPrefix("Model call · gemma · 900 in, 120 out · 2.3s") }, "\(said)")
    #expect(said.contains { $0.hasPrefix("knowledge_search") }, "the run's calls: \(said)")
    #expect(said.contains(ScheduledWords.productFoot))
    for control in ["Run Now, ⌘R", "Pause, ⌥⌘P", "Reset to Default"] {
        #expect(tree.controlNames.contains(control) || control == "Reset to Default", "controls: \(tree.controlNames)")
    }
    // A routine at its default has nothing to reset.
    #expect(!tree.controlNames.contains(ScheduledWords.resetToDefault))
    #expect(said.contains("It's at its default."))
}

@MainActor
@Test func theScheduleEditorSendsTheDaysItShowsAndANamedSetStaysNamed() async throws {
    let (model, console, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    let fixture = try ConsoleFixture.load("put-api-scheduled-routines-name-schedule")
    console.reset()
    await model.setSchedule(routine: "morning-brief", .timeOfDay(days: ["mon", "tue", "wed", "thu", "fri"], at: ["06:30"], tz: nil))
    let put = try #require(console.calls.first { $0.method == "PUT" })
    #expect(put.path == fixture.pathOnly)
    #expect(put.body == fixture.body, "\(String(describing: put.body))")
    // The answer is the routine as it now stands: the owner's layer.
    let routine = try #require(model.routineDetails["morning-brief"]?.value?.routine)
    #expect(routine.schedule.origin == .yours && routine.days?.origin == .yours)
    #expect(!routine.isDefault)
    #expect(console.calls.contains { $0.method == "GET" && $0.path == "/api/scheduled" }, "the list is asked again")

    // A set left alone is sent by its name, so it keeps following the profile.
    #expect(RoutineSchedule.timeOfDay(days: DaySet.workingDays.wire, at: ["07:00"], tz: nil).json["days"] == .string("working_days"))
    #expect(RoutineScheduleEditor.hhmm(RoutineScheduleEditor.date("23:05")) == "23:05")

    // Reset to Default is the DELETE, and asks nothing.
    console.reset()
    await model.resetToDefault(routine: "morning-brief")
    #expect(console.calls.first?.method == "DELETE")
    #expect(console.calls.first?.path == "/api/scheduled/routines/morning-brief")
    #expect(model.routineDetails["morning-brief"]?.value?.routine.isDefault == true)
    #expect(model.notes["morning-brief"]?.text == "Back to its default.")
}

@MainActor
@Test func runNowAndPauseAreTheItemMenusAndARefusalIsSaid() async throws {
    let console = try ScheduledConsole()
    console.serve("POST", "/api/scheduled/routines/standup/run", .object(["ok": .bool(false), "name": .string("standup"), "run_id": .null, "started": .bool(false), "refused": .object(["reason": .string("paused"), "message": .string("Standup is paused — Resume it first")])]))
    let (model, session) = scheduledModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.refreshIfDue()
    #expect(model.itemActions().isEmpty, "no selection, nothing to run")
    model.selection = try #require(model.routineBands.flatMap(\.rows).first { $0.name == "morning-brief" }).id
    let actions = model.itemActions()
    #expect(Set(actions.keys) == [.runNow, .pause])
    #expect(Set(actions.answerable(by: .item).keys) == [.runNow, .pause], "both are Item's to answer")

    console.reset()
    await model.runNow(routine: "morning-brief")
    #expect(console.calls.first.map { "\($0.method) \($0.path)" } == "POST /api/scheduled/routines/morning-brief/run")
    #expect(console.calls.first?.body == .object([:]))
    #expect(model.notes["morning-brief"]?.kind == .done)
    await model.runNow(routine: "standup")
    #expect(model.notes["standup"] == ScheduledNote(kind: .refused, text: "Not started — Standup is paused — Resume it first"))

    console.reset()
    await model.togglePause(routine: "morning-brief")
    #expect(console.calls.first.map { "\($0.method) \($0.path)" } == "POST /api/scheduled/routines/morning-brief/pause")
    #expect(model.routine("morning-brief")?.isPaused == true)
}

@MainActor
@Test func aRoutineNotRunYetSaysSoWithItsFirstRunAndRunNow() async throws {
    let console = try ScheduledConsole()
    var standup = try detailBody("morning-brief")
    var routine = try routineFromListing("standup").objectFields
    // its first run after this screen's clock: Monday 8:00 in New York (the
    // recording's own next_run is its wall clock's, X-29)
    routine["next_run"] = .string("2026-09-28T12:00:00.000Z")
    standup["routine"] = .object(routine)
    standup["history"] = .array([])
    console.serve("GET", "/api/scheduled/routines/standup", .object(standup))
    let (model, session) = scheduledModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.refreshIfDue()
    model.selection = try #require(model.routineBands.flatMap(\.rows).first { $0.name == "standup" }).id
    await model.loadSelection()
    let tree = try await AccessibilityProbe.snapshot(detail(model).frame(width: 640, height: 1400))
    defer { tree.close() }
    let said = tree.labels + tree.texts
    #expect(said.contains("Hasn't run yet."))
    #expect(said.contains("Its first run is 28 Sep, 8:00 AM. Run Now runs it sooner."), "\(said)")
    #expect(tree.controlNames.contains("Run Now, ⌘R"))
    #expect(said.contains("Next runs, 28 Sep, 8:00 AM · 29 Sep, 8:00 AM · 30 Sep, 8:00 AM"), "\(said)")
}

// MARK: - A sync

@MainActor
@Test func aSyncsCadenceAndRaiseTogglesAreItsDoorAndNeverItsConnection() async throws {
    let (model, console, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    model.tab = .syncs
    #expect(model.syncRows.map(\.name) == ["aws-costs", "caldav-calendar", "eventkit-calendar", "ics-calendar", "devin-knowledge", "devin-sessions", "github-state", "linear"])
    let github = try #require(model.presentation(ScheduledRow(name: "github-state", kind: .sync), assistantName: "Aide"))
    #expect(github.spoken == "GitHub, from github, every 15 minutes, raises assigned, review requested. Hasn't run yet", "\(github.spoken)")
    let unconnected = try #require(model.presentation(ScheduledRow(name: "aws-costs", kind: .sync), assistantName: "Aide"))
    #expect(unconnected.glyph == .absent && unconnected.spoken.hasSuffix("Not connected"))

    let fixture = try ConsoleFixture.load("put-api-scheduled-syncs-name")
    console.reset()
    await model.setEvery(sync: "github-state", "1h")
    #expect(console.calls.first?.body == .object(["every": .string("1h")]))
    await model.setRaise(sync: "github-state", rule: "review_requested", false)
    let raise = try #require(console.calls.last { $0.method == "PUT" })
    #expect(raise.path == fixture.pathOnly)
    #expect(raise.body == .object(["raise": .object(["review_requested": .bool(false)])]))
    #expect(!console.calls.contains { $0.body?["connection"] != nil }, "a sync's connection is never sent")
    let sync = try #require(model.sync("github-state"))
    #expect(sync.every == Sourced(value: "1h", origin: .yours))
    #expect(sync.raise.first { $0.rule == "review_requested" }?.on == Sourced(value: false, origin: .yours))

    console.reset()
    await model.runNow(sync: "github-state")
    #expect(console.calls.first.map { "\($0.method) \($0.path)" } == "POST /api/scheduled/syncs/github-state/run")

    // A sync with no connection offers nothing its door would refuse.
    model.selection = ScheduledRow(name: "aws-costs", kind: .sync).id
    let tree = try await AccessibilityProbe.snapshot(SyncDetailView(model: model, name: "aws-costs", onGoToNeedsYou: nil).frame(width: 600, height: 900))
    defer { tree.close() }
    #expect((tree.labels + tree.texts).contains { $0.contains("metistry connections add") })
    #expect(tree.unlabeledControls.isEmpty, "unlabeled: \(tree.unlabeledControls)")
}

@MainActor
@Test func aSyncFailingThreeTimesStopsAndSaysWhereItsRequestWaits() async throws {
    let console = try ScheduledConsole()
    var body = try ConsoleFixture.load("get-api-scheduled-syncs-name").replyJSON!.objectFields
    let failures = (0..<3).map { run(id: 90 - $0, at: "2026-09-27T0\(3 - $0):00:00.000Z", ok: false, error: "401 Bad credentials") }
    body["history"] = .array(failures)
    console.serve("GET", "/api/scheduled/syncs/github-state", .object(body))
    let (model, session) = scheduledModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.refreshIfDue()
    model.tab = .syncs
    model.selection = ScheduledRow(name: "github-state", kind: .sync).id
    await model.loadSelection()
    let history = try #require(model.syncDetails["github-state"]?.value?.history)
    #expect(model.isStopped(history))
    #expect(!model.isStopped(Array(history.prefix(2))), "two is not a stop")
    var wentToNeedsYou = false
    let tree = try await AccessibilityProbe.snapshot(SyncDetailView(model: model, name: "github-state", onGoToNeedsYou: { wentToNeedsYou = true }).frame(width: 600, height: 1000))
    defer { tree.close() }
    let said = tree.labels + tree.texts
    #expect(said.contains("Failed. Stopped after 3 failures in a row. One request waits in Needs You; Sync Now checks a fix."), "\(said)")
    #expect(said.contains { $0.contains("Failed — 401 Bad credentials") })
    #expect(tree.controlNames.contains("Go to Needs You"))
    _ = wentToNeedsYou
}

// MARK: - States

@MainActor
@Test func unreachableTurnsEveryDecisionOffAndSaysWhy() async throws {
    let (model, _, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    model.selection = try #require(model.routineBands.flatMap(\.rows).first { $0.name == "morning-brief" }).id
    await model.loadSelection()
    // The console stops answering: the next read says so.
    let down = ScheduledDown()
    session.adopt(transport: down, management: nil)
    await model.refresh()
    #expect(!model.allowsDecisions)
    #expect(model.itemActions().isEmpty)
    #expect(model.decisionsUnavailableReason?.hasPrefix(StateWords.unreachable) == true)
    // The instance switch dropped the list: the failed panel, the error verbatim.
    #expect(model.listing == nil)
    #expect(model.reach == .unknown, "an unanswered whoami is not local")
}

@MainActor
@Test func theFirstLoadFailedAndStaleStatesAreTheScreensOwn() async throws {
    let down = ScheduledDown()
    let (model, session) = scheduledModel(down)
    defer { withExtendedLifetime(session) {} }
    await model.refreshIfDue()
    guard case .failed(let why) = FirstPaint.paint(model.list.section, loadingSince: nil, ageLimit: ScheduledModel.ageLimit, waitingFor: "", now: model.now()) else {
        Issue.record("not the failed panel: \(model.list.section.state)")
        return
    }
    #expect(why.contains("ECONNREFUSED"))
    let tree = try await AccessibilityProbe.snapshot(ScheduledView(model: model, assistantName: "Aide", tick: .seconds(3600)).frame(width: 900, height: 600))
    defer { tree.close() }
    #expect((tree.labels + tree.texts).contains("Couldn't Read Scheduled"))
    #expect(tree.controlNames.contains(StateWords.tryAgain))
}

@MainActor
@Test func anInstanceSwitchDropsTheSchedule() async throws {
    let (model, _, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    model.tab = .syncs
    model.selection = ScheduledRow(name: "github-state", kind: .sync).id
    await model.loadSelection()
    #expect(model.syncDetails["github-state"]?.value != nil)
    session.adopt(transport: try FixtureConsole.recorded(), management: nil)
    #expect(model.tab == .routines && model.selection == nil)
    #expect(model.syncDetails.isEmpty && model.routineDetails.isEmpty && model.steps.isEmpty)
    #expect(model.reach == .unknown)
}

// MARK: - §2.18

@MainActor
@Test func scheduledSpeaksEveryRowAndEveryControl() async throws {
    let (model, _, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    model.selection = try #require(model.routineBands.flatMap(\.rows).first { $0.name == "knowledge-fold" }).id
    await model.loadSelection()
    let tree = try await AccessibilityProbe.snapshot(ScheduledView(model: model, assistantName: "Aide", tick: .seconds(3600)).frame(width: 1100, height: 1400))
    defer { tree.close() }
    #expect(tree.unlabeledControls.isEmpty, "unlabeled: \(tree.unlabeledControls)")
    let said = tree.labels + tree.texts
    #expect(said.contains("7:00 AM, Morning Brief, default, run by Aide, working days at 7 AM. Nothing to do"), "\(said)")
    #expect(said.contains(model.week.sentence))
    #expect(said.contains("Tomorrow · Monday") || said.contains("TOMORROW · MONDAY"), "the band header")
    for control in ["Show as Table", "Run Now, ⌘R", "Pause, ⌥⌘P"] {
        #expect(tree.controlNames.contains(control), "controls: \(tree.controlNames)")
    }
    #expect(tree.controlNames.contains { $0.hasPrefix("Routines 12") || $0 == "Show" }, "the tabs: \(tree.controlNames)")
    // the principal id is never a name on this screen
    #expect(!said.contains { $0.localizedCaseInsensitiveContains("run by assistant") }, "said: \(said)")
}

@MainActor
@Test func aRowAndTheDetailGrowLongerNeverWiderAtTheLargestText() async throws {
    let (model, _, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    let failed = try #require(model.routineBands.flatMap(\.rows).first { $0.name == "knowledge-fold" })
    let digest = try #require(model.routineBands.flatMap(\.rows).first { $0.name == "weekly-digest" })
    let pieces: [(String, AnyView, CGFloat)] = [
        ("failed row", AnyView(ScheduledRowView(model.presentation(failed, assistantName: "Aide")!)), 320),
        ("New Routine row", AnyView(ScheduledRowView(model.presentation(digest, assistantName: "Aide")!)), 320),
        ("week", AnyView(WeekAxisView(week: model.week, showsTable: .constant(true))), 360),
        ("stopped", AnyView(StoppedNote(onGoToNeedsYou: {}, retry: ScheduledWords.syncNow)), 360),
    ]
    for (name, view, width) in pieces {
        var heights: [DynamicTypeSize: CGFloat] = [:]
        for size in [DynamicTypeSize.large, .accessibility5] {
            let renderer = ImageRenderer(content: view.environment(\.dynamicTypeSize, size))
            renderer.proposedSize = ProposedViewSize(width: width, height: nil)
            renderer.scale = 1
            let image = try #require(renderer.cgImage, "\(name) did not render")
            #expect(CGFloat(image.width) <= width, "\(name) is \(image.width) wide at \(size), offered \(width)")
            heights[size] = CGFloat(image.height)
        }
        #expect((heights[.accessibility5] ?? 0) > (heights[.large] ?? 0), "\(name) did not grow at the largest text")
    }
}

@MainActor
@Test func openingScheduledNeverRaisesTheWindowsMinimum() async throws {
    let (model, _, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    model.selection = try #require(model.routineBands.flatMap(\.rows).first { $0.name == "morning-brief" }).id
    await model.loadSelection()
    let window = try await ShellProbe.acrossTheSwitch { ScheduledView(model: model, assistantName: "Aide", tick: .seconds(3600)) }
    #expect(window.after.minimum.height <= max(window.before.minimum.height, 460), "opening Scheduled raised the window's minimum to \(window.after.minimum)")
    #expect(window.after.frame == window.before.frame, "the window moved: \(window.before.frame) → \(window.after.frame)")
    let (waiting, waitingSession) = scheduledModel(try FixtureConsole.recorded())
    let (failed, failedSession) = scheduledModel(ScheduledDown())
    defer { withExtendedLifetime([waitingSession, failedSession]) {} }
    await failed.refreshIfDue()
    let probe = MinimumProbe()
    for (name, panel) in [("list", model), ("waiting", waiting), ("failed", failed)] {
        let size = probe.minimum(of: ScheduledView(model: panel, assistantName: "Aide", tick: .seconds(3600)))
        #expect(size.height <= 460, "\(name) asks for \(size) at the least")
    }
}

@MainActor
@Test func everyScheduledInkIsReadableOnItsGround() {
    for scheme in [ColorScheme.light, .dark] {
        for ink in [MetistryColorRole.failed, .absent, .textSecondary, .textPrimary, .degraded] {
            #expect(Contrast.ratio(ink, .surface, scheme) >= 4.5, "\(ink.rawValue) on surface in \(scheme)")
        }
        #expect(Contrast.ratio(.textSecondary, .sunken, scheme) >= 4.5, "the default tag in \(scheme)")
        #expect(Contrast.ratio(.failed, .failedQuiet, scheme) >= 4.5, "the stop in \(scheme)")
        #expect(Contrast.ratio(.accent, .surface, scheme) >= 3, "the week's marks in \(scheme)")
    }
}

@Test func noStringInScheduledsSourceSaysAssistantOrNamesOne() throws {
    let kit = repoRoot().appendingPathComponent("apps/macos/sources/kit")
    var literals: [String] = []
    for file in ["scheduled-view.swift", "routine-detail-view.swift", "scheduled-model.swift"] {
        let text = try String(contentsOf: kit.appendingPathComponent(file), encoding: .utf8)
        // §2.18.4: nothing on the screen slides, so Reduce Motion has nothing to stop
        #expect(!text.contains("withAnimation") && !text.contains(".animation(") && !text.contains(".transition("), "\(file)")
        // ⌘R and ⌥⌘P are the Item menu's; no key is bound outside the closed table (C119)
        #expect(!text.contains(".keyboardShortcut("), "\(file)")
        for line in text.split(separator: "\n") where !line.trimmingCharacters(in: .whitespaces).hasPrefix("//") {
            let parts = line.split(separator: "\"", omittingEmptySubsequences: false)
            literals += stride(from: 1, to: parts.count, by: 2).map { String(parts[$0]) }
        }
    }
    #expect(literals.count > 60, "the scan found almost nothing")
    for literal in literals {
        #expect(!literal.localizedCaseInsensitiveContains("assistant"), "\"\(literal)\"")
        #expect(literal.range(of: #"\bMetis\b"#, options: .regularExpression) == nil, "\"\(literal)\"")
        // the wire's own word is read, never said (§3: "Silent is gone")
        #expect(literal == "silent" || !literal.localizedCaseInsensitiveContains("silent"), "\"\(literal)\"")
    }
}

// MARK: - Helpers

/// Sunday 27 Sep 2026, 00:18 in New York — the list's `as_of` when it was
/// first recorded. The screen places each routine by its rule from this clock,
/// so it stays put when a re-record moves the fixture's `as_of` (X-29).
private let recordedNow = WireTime.date("2026-09-27T04:18:49.905Z")!

private func repoRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

@MainActor
private func scheduledModel(_ console: any ConsoleCallTransport) -> (ScheduledModel, ConsoleSession) {
    let session = ConsoleSession(transport: console, management: nil)
    return (ScheduledModel(session: session, timeZone: TimeZone(identifier: "UTC")!, now: { recordedNow }), session)
}

@MainActor
private func fixtureModel() async throws -> (ScheduledModel, ScheduledConsole, ConsoleSession) {
    let console = try ScheduledConsole()
    let (model, session) = scheduledModel(console)
    await model.refreshIfDue()
    #expect(model.listing?.routines.count == 12, "the recorded list")
    return (model, console, session)
}

@MainActor
private func detail(_ model: ScheduledModel) -> some View {
    let name = model.selectedTarget?.name ?? ""
    return RoutineDetailView(model: model, name: name, assistantName: "Aide", onOpenPath: { _ in }, onGoToAgents: {}, onGoToNeedsYou: {})
}

private func run(id: Int, at: String, ok: Bool, outcome: String? = nil, error: String? = nil) -> JSONValue {
    .object([
        "run_id": .string(String(id)), "at": .string(at), "ok": .bool(ok),
        "outcome": outcome.map(JSONValue.string) ?? .null, "cost_usd": .null,
        "error": error.map(JSONValue.string) ?? .null, "steps": .number(0), "trigger": .null,
    ])
}

private func routineJSON(_ name: String, days: [String], at: [String], tz: String? = nil, paused: Bool = false) -> JSONValue {
    .object([
        "name": .string(name), "title": .string(name), "kind": .string("routine"), "source": .string("product"),
        "schedule": .object(["value": .object(["days": .array(days.map(JSONValue.string)), "at": .array(at.map(JSONValue.string))]), "origin": .string("default")]),
        "paused": .object(["value": .bool(paused), "origin": .string(paused ? "yours" : "default")]),
        "days": .object(["value": .array(days.map(JSONValue.string)), "origin": .string("default")]),
        "time_zone": tz.map { .object(["value": .string($0), "origin": .string("profile")]) } ?? .null,
        "next_run": .null, "is_default": .bool(true), "held": .null,
    ])
}

/// The recorded list, one routine's fields changed.
private func listing(_ change: (String, inout [String: JSONValue]) -> Void) throws -> JSONValue {
    var body = try ConsoleFixture.load("get-api-scheduled").replyJSON!.objectFields
    body["routines"] = .array((body["routines"]?.arrayValue ?? []).map { routine in
        var fields = routine.objectFields
        change(routine.string("name") ?? "", &fields)
        return .object(fields)
    })
    return .object(body)
}

private func routineFromListing(_ name: String) throws -> JSONValue {
    try #require(ConsoleFixture.load("get-api-scheduled").replyJSON?["routines"]?.arrayValue?.first { $0.string("name") == name })
}

private func detailBody(_ name: String) throws -> [String: JSONValue] {
    var body = try ConsoleFixture.load("get-api-scheduled-routines-name").replyJSON!.objectFields
    if name != "morning-brief" { body["routine"] = try routineFromListing(name) }
    return body
}

/// The recorded detail fixture is Morning Brief's; the New Routine's is the list's own entry.
private func weeklyDigestDetail() throws -> JSONValue {
    var body = try detailBody("weekly-digest")
    body["history"] = .array([])
    return .object(body)
}

private extension JSONValue {
    var objectFields: [String: JSONValue] {
        if case .object(let o) = self { return o }
        return [:]
    }
}

/// The recorded fixtures, with the answers a test names in front of them.
final class ScheduledConsole: ConsoleCallTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var answers: [String: Result<JSONValue, ConsoleError>] = [:]
    private var log: [FixtureCall] = []
    private let fixtures: FixtureConsole

    init() throws {
        fixtures = try FixtureConsole.recorded()
    }

    var calls: [FixtureCall] { lock.withLock { log } }
    func reset() { lock.withLock { log.removeAll() } }
    func serve(_ method: String, _ path: String, _ json: JSONValue) { lock.withLock { answers["\(method) \(path)"] = .success(json) } }
    func fail(_ method: String, _ path: String, _ error: ConsoleError) { lock.withLock { answers["\(method) \(path)"] = .failure(error) } }

    func call(_ method: String, _ path: String, body: Data?, idempotencyKey: String?) async -> Result<Data, ConsoleError> {
        let sent = body.flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) }
        let scripted = lock.withLock { answers["\(method) \(path)"] }
        let served = scripted == nil ? fixtures.match(method, path)?.stem : "scripted"
        lock.withLock { log.append(FixtureCall(method: method, path: path, body: sent, idempotencyKey: idempotencyKey, lastEventID: nil, servedBy: served)) }
        switch scripted {
        case .success(let json)?: return .success((try? JSONEncoder().encode(json)) ?? Data())
        case .failure(let error)?: return .failure(error)
        case nil: return await fixtures.call(method, path, body: body, idempotencyKey: idempotencyKey)
        }
    }
}

/// A console that does not answer.
final class ScheduledDown: ConsoleCallTransport, @unchecked Sendable {
    func call(_ method: String, _ path: String, body: Data?, idempotencyKey: String?) async -> Result<Data, ConsoleError> {
        .failure(.transport("connect ECONNREFUSED 127.0.0.1:1"))
    }
}
#endif

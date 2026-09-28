// Today's top (T6-1b): the Morning Brief, Next Up, calendar help, Close the
// Day. Built against the recorded fixtures first — `GET /api/today`,
// `POST /api/today/close`, the move preview, the meeting note — and a
// scripted console where a fixture cannot say it (a brief file, a profile,
// a refusal, a morning whose run failed).
//
// The ticket's three come first: **at most one expanded wash**, **at most
// three predictions**, and **Close with broken markers shows the request, not
// a success**. Then the brief, Next Up, calendar help, the close, words and
// §2.18. macOS only, as the accessibility probe is.

#if os(macOS)
import AppKit
import Foundation
import SwiftUI
import Testing

@testable import MetistryKit

// MARK: - The ticket's three

@MainActor
@Test func atMostOneExpandedWash() async throws {
    // every combination of the three things that could each want a voice open
    for briefProse in [true, false] {
        for nextUpWritten in [true, false] {
            for closing in [false, true] {
                let console = TodayConsole(day: busyDay(), pages: pages(brief: briefFile(prosePending: !briefProse, nextUpPending: !nextUpWritten)))
                let (model, session) = todayModel(console, at: closing ? at("17:05") : at("13:31"))
                defer { withExtendedLifetime(session) {} }
                await model.load()
                let open = model.expandedWash
                // at first open the brief, if it has words; else Next Up's line; never both
                if closing {
                    #expect(open != .brief, "Close the Day holds the top: the brief is its line")
                } else if briefProse {
                    #expect(open == .brief)
                } else {
                    #expect(open == (nextUpWritten ? .nextUp : nil))
                }
                // opening Next Up's line folds the brief
                model.openNextUpLine()
                #expect(model.expandedWash != .brief)
                model.openBrief()
                if briefProse && !closing { #expect(model.expandedWash == .brief) }

                // and on screen: at most one wash says who wrote it
                let tree = try await AccessibilityProbe.snapshot(TodayView(model: model, assistantName: "Aide", tick: .seconds(3600)).frame(width: 820, height: 1600))
                defer { tree.close() }
                let washes = tree.labels.filter { $0.hasPrefix("Aide wrote") }
                #expect(washes.count <= 1, "brief \(briefProse) nextUp \(nextUpWritten) closing \(closing): \(washes)")
            }
        }
    }
}

@MainActor
@Test func atMostThreePredictions() async throws {
    let candidates = (1...5).map { TodayPrediction(act: .draftAgenda(eventID: "e\($0)"), label: "Draft the Agenda", reason: "\($0) open items with Jim") }
    #expect(TodayPredictions.page(candidates).count == 3)
    #expect(TodayPredictions.page(candidates).map(\.id) == ["agenda:e1", "agenda:e2", "agenda:e3"], "in the order offered")
    #expect(TodayPredictions.page([candidates[0], candidates[0], nil, candidates[1]]).count == 2, "each once; a missing one is no prediction")

    // the fragmented day with the Lease Call in Next Up: Draft the Agenda, and Move the Design Review…
    let console = TodayConsole(day: fragmentedDay(), pages: pages())
    let (model, session) = todayModel(console, at: at("12:31"))
    defer { withExtendedLifetime(session) {} }
    await model.load()
    #expect(model.predictions.map(\.label) == ["Draft the Agenda", "Move the Design Review…"], "\(model.predictions)")
    #expect(model.predictions.count <= TodayPredictions.perPage)

    let tree = try await AccessibilityProbe.snapshot(TodayView(model: model, assistantName: "Aide", tick: .seconds(3600)).frame(width: 820, height: 1600))
    defer { tree.close() }
    let drawn = tree.controlNames.filter { $0.hasPrefix("Draft the Agenda") || $0.hasPrefix("Move the ") && $0.contains("…") }
    #expect(drawn.count == 2 && drawn.count <= 3, "controls: \(tree.controlNames)")
    #expect(drawn.contains("Draft the Agenda, 1 open item with Jim"), "\(drawn)")
}

@MainActor
@Test func closeWithBrokenMarkersShowsTheRequestNotASuccess() async throws {
    let console = TodayConsole(day: busyDay(), pages: pages())
    console.close = .failure(.http(status: 409, envelope: ConsoleErrorEnvelope(json: json("""
    {"error": {"code": "section_missing", "message": "the daily note's metistry:day markers are not one clean pair"},
     "reason": "unpaired", "at_line": 14, "day": "2026-09-28", "path": "Journal/2026-09-28.md", "request_id": 4121,
     "plan": {"enqueued": true, "routine": "plan-tomorrow"}}
    """))))
    let (model, session) = todayModel(console, at: at("17:05"))
    defer { withExtendedLifetime(session) {} }
    await model.load()
    #expect(model.closePanelShown, "thirty minutes before 5:30 PM the top is Close the Day")
    model.closeLine = "Recorder next."
    await model.closeDay()

    let sent = try #require(console.calls.last { $0.path == "/api/today/close" })
    #expect(sent.body == json(#"{"day": "2026-09-28", "line": "Recorder next."}"#))
    guard case .noteNotWritten(let missing) = model.close else {
        Issue.record("a section_missing close is the request, not \(model.close)")
        return
    }
    #expect(missing.requestID == 4121)
    #expect(missing.sentence.contains("Nothing was written into your note"))
    #expect(missing.sentence.contains("unpaired, line 14"))
    #expect(missing.sentence.contains("Tomorrow's plan is still being written"))
    #expect(!model.closePanelShown, "the panel gives way to the request")

    var wentToNeedsYou = false
    let tree = try await AccessibilityProbe.snapshot(TodayView(model: model, assistantName: "Aide", tick: .seconds(3600), onGoToNeedsYou: { wentToNeedsYou = true }).frame(width: 820, height: 1600))
    defer { tree.close() }
    let said = tree.labels + tree.texts
    #expect(said.contains(NoteNotWritten.title), "said: \(said)")
    #expect(tree.controlNames.contains("Open the Request, number 4121"), "controls: \(tree.controlNames)")
    #expect(!said.contains { $0.hasPrefix("Day closed") }, "never a success line: \(said)")
    #expect(!wentToNeedsYou)
}

// MARK: - Against the recorded fixtures (U9)

@MainActor
@Test func theRecordedDayReadsWhole() async throws {
    let console = try FixtureConsole.recorded()
    let (model, session) = todayModel(console, at: at("13:10"))
    defer { withExtendedLifetime(session) {} }
    await model.load()
    let day = try #require(model.day)
    #expect(day.date == "2026-09-28")
    #expect(day.tasks.map(\.text) == ["Send Dana the fixture format"])
    #expect(day.events.map(\.title) == ["Standup"])
    #expect(day.events.first?.others.map(\.displayName) == ["Dana"])
    #expect(day.brief == "Journal/Brief/2026-09-28.md")
    #expect(console.calls.first?.path == "/api/today", "no date: the console's today")
    // 13:10 is twenty minutes before the standup: Next Up, two lines and nothing to predict
    guard case .card(let card) = model.nextUp else { Issue.record("\(model.nextUp)"); return }
    #expect(card.isStandup && card.minutes == 20 && card.prediction == nil)
}

@Test func theRecordedCloseAndMoveAndNoteDecode() throws {
    let close = try ConsoleFixture.load("post-api-today-close")
    let closeReply = try #require(close.replyJSON)
    let closed = try #require(ClosedDay(json: closeReply))
    #expect(closed.path.hasPrefix("Journal/") && closed.path.hasSuffix(".md"))
    #expect(closed.day == closed.path.dropFirst("Journal/".count).dropLast(3).description)

    let move = try ConsoleFixture.load("post-api-calendar-events-id-move")
    let request = EventMove(start: "2026-09-28T14:00:00.000Z", end: "2026-09-28T14:15:00.000Z")
    let moveReply = try #require(move.replyJSON)
    let warning = try #require(MoveWarning(preview: moveReply, request: request))
    #expect(warning.people == ["Dana"] && warning.token == "fixture-token-not-a-secret" && warning.title == "Standup")
    let clock = ClockTime(timeZone: utc)
    let confirm = try #require(warning.confirmation(clock: clock))
    #expect(confirm.title == "Move the Standup to 2:00–2:15 PM?")
    #expect(confirm.costs == ["Dana"], "who the calendar will tell, by name (C90)")
    #expect(confirm.confirm == "Move the Meeting" && !confirm.destructive, "neutral: moving a meeting is not a fault")
}

// MARK: - The brief

@Test func theBriefFileReadsAsItsRoutineWritesIt() {
    let doc = BriefDocument.parse(briefFile())
    #expect(doc.prose == "Four things today; the lease comparables are the one that moved. Jim is waiting on the Q4 scope.")
    #expect(doc.meetings.map(\.title) == ["Standup", "Lease Call"])
    #expect(doc.meetings.map(\.written) == ["Two blockers to raise.", "Jim will ask about the comparables; the scope is still open."])
    #expect(doc.foldedLine == "Morning Brief — Four things today; the lease comparables are the one that moved.")

    // a pending slot is not a line yet — never the placeholder
    let pending = BriefDocument.parse(briefFile(prosePending: true, nextUpPending: true))
    #expect(pending.prose == nil)
    #expect(pending.meetings.allSatisfy { $0.written == nil })
    #expect(pending.foldedLine == "Morning Brief")
    #expect(BriefText.withoutTitle(standupFile()) == "**Yesterday:** froze the store interface.\n**Today:** the recorder.")
}

@MainActor
@Test func theBriefFoldsToALineOnTheNextOpenOnceRead() async throws {
    let defaults = try #require(UserDefaults(suiteName: "today-brief-\(UUID().uuidString)"))
    let console = TodayConsole(day: busyDay(), pages: pages())
    let session = ConsoleSession(transport: console, management: nil)
    defer { withExtendedLifetime(session) {} }
    let model = TodayModel(session: session, timeZone: utc, defaults: defaults, now: { at("08:52") })
    await model.load()
    #expect(model.expandedWash == .brief, "the first open is the brief")
    model.opened()
    #expect(model.expandedWash == .brief, "reading it does not fold it under the reader")
    model.briefWasRead()
    #expect(model.expandedWash == .brief)
    model.opened()
    #expect(model.expandedWash != .brief, "the next open is its line")
    model.openBrief()
    #expect(model.expandedWash == .brief, "a click reopens it")

    // the page's foot names the file and does not repeat the plan
    #expect(TodayBriefFoot.text(planned: 7, carried: 2, path: briefPath) == "The plan is the day below · 7 tasks, 2 carried · Journal/Brief/2026-09-28.md")
}

@MainActor
@Test func aMissingBriefSaysWhyAndThatTheDayIsComplete() async throws {
    // absent: no working days
    let none = TodayConsole(day: busyDay(brief: nil), pages: [WorkingProfile.path: "---\nsource: user\n---\n# Me\n"])
    let (a, s1) = todayModel(none, at: at("08:52"))
    defer { withExtendedLifetime(s1) {} }
    await a.load()
    #expect(a.brief == .noWorkingDays)

    // failed: today's run failed — when, and when next
    let failed = TodayConsole(day: busyDay(brief: nil), pages: [WorkingProfile.path: profileFile()])
    failed.routine = json(#"{"routine": {"name": "morning-brief", "next_run": "2026-09-29T07:00:00.000Z", "last_run": {"at": "2026-09-28T07:00:04.000Z", "ok": false}}}"#)
    let (b, s2) = todayModel(failed, at: at("08:52"))
    defer { withExtendedLifetime(s2) {} }
    await b.load()
    #expect(b.brief == .runFailed(at: WireTime.date("2026-09-28T07:00:04.000Z"), next: WireTime.date("2026-09-29T07:00:00.000Z")))

    // named, but not written yet (404): not yet
    let early = TodayConsole(day: busyDay(), pages: [WorkingProfile.path: profileFile()])
    early.routine = json(#"{"routine": {"name": "morning-brief", "next_run": "2026-09-28T07:00:00.000Z", "last_run": null}}"#)
    let (c, s3) = todayModel(early, at: at("06:40"))
    defer { withExtendedLifetime(s3) {} }
    await c.load()
    #expect(c.brief == .notYet(next: WireTime.date("2026-09-28T07:00:00.000Z")))

    for model in [a, b, c] {
        let tree = try await AccessibilityProbe.snapshot(TodayView(model: model, assistantName: "Aide", tick: .seconds(3600)).frame(width: 820, height: 1200))
        defer { tree.close() }
        let said = (tree.labels + tree.texts).joined(separator: " | ")
        #expect(said.contains(BriefWords.dayIsComplete), "\(said)")
    }
}

// MARK: - Next Up

@MainActor
@Test func nextUpFromThirtyMinutesBeforeWithWhatYouOweThem() async throws {
    let console = TodayConsole(day: busyDay(), pages: pages())
    var now = at("13:29")
    let session = ConsoleSession(transport: console, management: nil)
    defer { withExtendedLifetime(session) {} }
    let model = TodayModel(session: session, timeZone: utc, now: { now })
    await model.load()
    #expect(model.nextUp == .none, "31 minutes before the Lease Call: not yet")

    now = at("13:31")
    guard case .card(let card) = model.nextUp else { Issue.record("\(model.nextUp)"); return }
    #expect(card.event.title == "Lease Call" && card.minutes == 29)
    #expect(card.owed.map(\.text) == ["Send Jim the revised Q4 scope"], "the person facet names someone in it — and waiting lines are not owed")
    #expect(card.written == "Jim will ask about the comparables; the scope is still open.")
    #expect(card.prediction?.spoken == "Draft the Agenda, 1 open item with Jim")
    #expect(card.lead == "Next Up · in 29 min" && card.spokenLead == "Next Up, in 29 minutes")

    // after the last meeting: said, not silent
    now = at("16:00")
    #expect(model.nextUp == .calendarDone)
}

@MainActor
@Test func recordWaitsForTheCaptureBarAndOpenNotesAsksForTheNote() async throws {
    let console = TodayConsole(day: busyDay(), pages: pages())
    let (model, session) = todayModel(console, at: at("13:31"))
    defer { withExtendedLifetime(session) {} }
    await model.load()
    guard case .card(let card) = model.nextUp else { Issue.record("\(model.nextUp)"); return }

    let tree = try await AccessibilityProbe.snapshot(TodayView(model: model, assistantName: "Aide", tick: .seconds(3600)).frame(width: 820, height: 1600))
    defer { tree.close() }
    #expect(tree.controlNames.contains("Record Lease Call"), "\(tree.controlNames)")
    #expect(tree.controlNames.contains("Open Notes, Lease Call"))

    // the note: asked of the console, which names the file
    let path = await model.meetingNote(card.event)
    #expect(path == "Journal/Meetings/2026-09-28-standup.md", "the recorded note fixture answers — the door slugs the topic (T2-11)")
    #expect(console.calls.contains { $0.method == "POST" && $0.path == "/api/meetings/evt-lease/note" })

    // Draft the Agenda: one message, naming the meeting and what is owed
    await model.draftAgenda(card)
    let message = try #require(console.calls.last { $0.path == "/message" })
    let text = message.body?["text"]?.stringValue ?? ""
    #expect(text.contains("Lease Call") && text.contains("Jim Fallon") && text.contains("- Send Jim the revised Q4 scope"), "\(text)")
    #expect(model.agenda["evt-lease"] == .asked)
}

@MainActor
@Test func tickingAnOwedLineUsesTheTickDoorAndAChangedLineWritesNothing() async throws {
    let console = TodayConsole(day: busyDay(), pages: pages())
    let (model, session) = todayModel(console, at: at("13:31"))
    defer { withExtendedLifetime(session) {} }
    await model.load()
    guard case .card(let card) = model.nextUp, let task = card.owed.first else { Issue.record("\(model.nextUp)"); return }

    console.check = .failure(.http(status: 409, envelope: ConsoleErrorEnvelope(json: json(#"{"error": {"code": "conflict", "message": "the line changed"}, "reason": "stale", "line": "- [ ] Send Jim the revised Q4 scope and the SOW"}"#))))
    await model.tick(task, checked: true)
    let sent = try #require(console.calls.last { $0.path.hasSuffix("/check") })
    #expect(sent.path == "/api/vault-tasks/mt-jim/check")
    #expect(sent.body == json(#"{"checked": true, "seen_text": "Send Jim the revised Q4 scope"}"#))
    #expect(sent.idempotencyKey?.hasPrefix("tick-") == true)
    #expect(model.notes["mt-jim"] == .stale(line: "- [ ] Send Jim the revised Q4 scope and the SOW"))

    console.check = nil
    await model.tick(task, checked: true)
    #expect(model.notes["mt-jim"] == .ticked(path: "Journal/2026-09-28.md"))
    // spoken as components-02 §3 has it
    #expect(task.spoken(today: "2026-09-28", note: nil) == "Send Jim the revised Q4 scope. Priority 2, 45 minutes, second day")
    #expect(task.spoken(today: "2026-09-28", note: .ticked(path: "Journal/2026-09-28.md")) == "Send Jim the revised Q4 scope, done. Written to today's note. Undo available")
}

// MARK: - Calendar help

@MainActor
@Test func calendarHelpOffersOneMoveAndWarnsNamingWhoIsTold() async throws {
    let console = TodayConsole(day: fragmentedDay(), pages: pages())
    let (model, session) = todayModel(console, at: at("12:31"))
    defer { withExtendedLifetime(session) {} }
    await model.load()
    let help = try #require(model.calendarHelp, "four 30-minute meetings leave no 90-minute stretch")
    #expect(help.event.title == "Design Review", "the Lease Call is in 14 minutes: too soon to offer")
    #expect(model.clock.range(help.start, help.end) == "3:45–4:15 PM")
    #expect(help.line(clock: model.clock) == "No stretch of 1h 30m is left in your day. Moving the Design Review to 3:45–4:15 PM leaves 2h free.")

    await model.beginMove(help)
    let preview = try #require(console.calls.last { $0.path == "/api/calendar/events/evt-review/move" })
    #expect(preview.body?["confirm_token"] == nil || preview.body?["confirm_token"] == .null, "the first ask is the preview")
    guard case .confirming(let warning) = model.move else { Issue.record("\(model.move)"); return }
    #expect(warning.people == ["Dana"])
    #expect(warning.confirmation(clock: model.clock)?.title == "Move the Design Review to 3:45–4:15 PM?")
    #expect(console.calls.filter { $0.path.hasSuffix("/move") }.count == 1, "nothing moves before the warning is answered")

    await model.confirmMove(warning)
    let confirm = try #require(console.calls.last { $0.path == "/api/calendar/events/evt-review/move" })
    #expect(confirm.body?["confirm_token"]?.stringValue == "token-evt-review")
    #expect(model.move == .moved("Moved the Design Review to 3:45–4:15 PM — your calendar tells Dana."))
}

@MainActor
@Test func theOwnersOwnMeetingMovesWithoutTheWarningAndNotTodayMeansToday() async throws {
    let console = TodayConsole(day: fragmentedDay(reviewWithOthers: false), pages: pages())
    let (model, session) = todayModel(console, at: at("12:31"))
    defer { withExtendedLifetime(session) {} }
    await model.load()
    let help = try #require(model.calendarHelp)
    await model.beginMove(help)
    let moves = console.calls.filter { $0.path.hasSuffix("/move") }
    #expect(moves.count == 2, "preview, then the token — no warning between")
    #expect(moves.last?.body?["confirm_token"]?.stringValue == "token-evt-review")
    #expect(model.move == .moved("Moved the Design Review to 3:45–4:15 PM."))

    model.dismissCalendarHelp()
    #expect(model.calendarHelp == nil)

    // an unfragmented day offers nothing
    let calm = TodayConsole(day: busyDay(), pages: pages())
    let (quiet, s2) = todayModel(calm, at: at("12:31"))
    defer { withExtendedLifetime(s2) {} }
    await quiet.load()
    #expect(quiet.calendarHelp == nil)
}

// MARK: - Close the Day

@MainActor
@Test func closeTheDayIsOnTopFromThirtyMinutesBeforeTheDayEnds() async throws {
    for (time, due) in [("16:59", false), ("17:00", true), ("17:45", true)] {
        let console = TodayConsole(day: busyDay(), pages: pages())
        let (model, session) = todayModel(console, at: at(time))
        defer { withExtendedLifetime(session) {} }
        await model.load()
        #expect(model.closeIsDue == due, "\(time)")
        #expect(model.closePanelShown == due, "\(time)")
    }
    // no working_hours: never on its own — one quiet control away instead
    let console = TodayConsole(day: busyDay(), pages: [briefPath: briefFile(), WorkingProfile.path: "---\nworking_days: [mon]\n---\n"])
    let (model, session) = todayModel(console, at: at("23:00"))
    defer { withExtendedLifetime(session) {} }
    await model.load()
    #expect(!model.closePanelShown)
    let tree = try await AccessibilityProbe.snapshot(TodayView(model: model, assistantName: "Aide", tick: .seconds(3600)).frame(width: 820, height: 1400))
    defer { tree.close() }
    #expect(tree.controlNames.contains("Close the Day early"), "\(tree.controlNames)")
    model.openClose()
    #expect(model.closePanelShown)
}

@MainActor
@Test func closingDefersThroughTheDoorAndFoldsToALineNamingWhatItWrote() async throws {
    let console = TodayConsole(day: busyDay(), pages: pages())
    let (model, session) = todayModel(console, at: at("17:05"))
    defer { withExtendedLifetime(session) {} }
    await model.load()
    let plan = try #require(model.closePlan)
    #expect(plan.done.map(\.text) == ["Sign the SOW"])
    #expect(plan.owed.map(\.text) == ["Send Jim the revised Q4 scope"], "owed items are tasks with a person facet (C102)")
    #expect(plan.stillOpen.map(\.text) == ["Hear back from Ana", "Draft the lease comparison"], "waiting on Ana is not owed to her")
    #expect(model.deferChoices.map(\.0) == [.tomorrow, .thisWeek, .someday], "Monday: Friday is after tomorrow")
    #expect(model.tomorrow?.date == "2026-09-29", "tomorrow's shape is read when the panel shows")
    #expect(model.tomorrow?.sentence(clock: model.clock) == "1 meeting, the first at 10:00 AM · 1 task planned")

    let lease = try #require(plan.stillOpen.first { $0.key == "mt-lease" })
    await model.deferTask(lease, to: .thisWeek)
    let sent = try #require(console.calls.last { $0.path.hasSuffix("/schedule") })
    #expect(sent.path == "/api/vault-tasks/mt-lease/schedule")
    #expect(sent.body == json(#"{"do": "2026-10-02", "seen_text": "Draft the lease comparison"}"#))
    #expect(sent.idempotencyKey?.hasPrefix("defer-") == true)
    #expect(model.notes["mt-lease"] == .deferred(.thisWeek))

    await model.closeDay()
    guard case .closed(let closed) = model.close else { Issue.record("\(model.close)"); return }
    #expect(closed.foldedLine(tomorrow: model.tomorrowDate, clock: model.clock) == "Day closed at 5:14 PM · 6 done · 3 to tomorrow · 1 this week · 1 someday")
    #expect(!model.closePanelShown)
    let tree = try await AccessibilityProbe.snapshot(TodayView(model: model, assistantName: "Aide", tick: .seconds(3600)).frame(width: 820, height: 1400))
    defer { tree.close() }
    let said = tree.labels + tree.texts
    #expect(said.contains("Written to Journal/2026-09-28.md"), "\(said)")
    #expect(tree.controlNames.contains("Reopen Close the Day"))
}

@MainActor
@Test func aRefusedCloseKeepsThePanelAndSaysWhy() async throws {
    let stale = CloseOutcome.of(.failure(.http(status: 409, envelope: ConsoleErrorEnvelope(json: json(#"{"error": {"code": "conflict", "message": "stale"}, "reason": "stale", "today": "2026-09-29"}"#)))), day: "2026-09-28")
    #expect(stale == .refused("Today was drawn for 2026-09-28, and it is now 2026-09-29. Nothing was written — close the day that is showing after it reloads."))
    let noNote = CloseOutcome.of(.failure(.http(status: 404, envelope: ConsoleErrorEnvelope(code: "not_found", message: "no note"))), day: "2026-09-28")
    guard case .refused(let why) = noNote else { Issue.record("\(noNote)"); return }
    #expect(why.contains("closing never creates your note"))

    let console = TodayConsole(day: busyDay(), pages: pages())
    console.close = .failure(.http(status: 404, envelope: ConsoleErrorEnvelope(code: "not_found", message: "no note")))
    let (model, session) = todayModel(console, at: at("17:05"))
    defer { withExtendedLifetime(session) {} }
    await model.load()
    await model.closeDay()
    #expect(model.closePanelShown, "nothing folds on a refusal")
}

@Test func theWorkingProfileReadsLikeTheRoutinesReadIt() {
    #expect(WorkingProfile.parse(profileFile()) == WorkingProfile(workingDays: ["mon", "tue", "wed", "thu", "fri"], dayStart: 540, dayEnd: 1050))
    #expect(WorkingProfile.parse("---\nworking_days:\n  - Mon\n  - wed\n# working_hours: \"09:00-17:30\"\n---\n") == WorkingProfile(workingDays: ["mon", "wed"]))
    #expect(WorkingProfile.parse("---\nworking_hours: 17:30-09:00\n---\n").dayEnd == nil, "an end before its start is unreadable, not guessed")
    #expect(WorkingProfile.parse("# no frontmatter\nworking_hours: 09:00-17:00") == WorkingProfile())
}

// MARK: - §2.18

@MainActor
@Test func everyControlOnTheTopSpeaksItsName() async throws {
    for time in ["08:52", "13:31", "17:05"] {
        let console = TodayConsole(day: busyDay(), pages: pages())
        let (model, session) = todayModel(console, at: at(time))
        defer { withExtendedLifetime(session) {} }
        await model.load()
        let tree = try await AccessibilityProbe.snapshot(TodayView(model: model, assistantName: "Aide", tick: .seconds(3600)).frame(width: 820, height: 1800))
        defer { tree.close() }
        #expect(tree.unlabeledBesidesFields.isEmpty, "\(time) unlabeled: \(tree.unlabeledBesidesFields)")
        #expect(tree.fieldsWithoutAPrompt.isEmpty, "\(time): a field that would say nothing")
        #expect(tree.saysAssistant.isEmpty, "\(time): \(tree.saysAssistant)")
        if time == "17:05" {
            #expect(tree.fieldPrompts == [TodayWords.linePrompt], "\(tree.fieldPrompts)")
            for name in ["Close the Day", "Move Draft the lease comparison to tomorrow", "Move Draft the lease comparison to this week", "Move Draft the lease comparison to someday"] {
                #expect(tree.controlNames.contains(name), "\(name) in \(tree.controlNames)")
            }
            let box = try #require(tree.controls.first { $0.name.hasPrefix("Send Jim the revised Q4 scope") })
            #expect(box.role == "AXCheckBox")
            #expect(box.name.hasPrefix("Send Jim the revised Q4 scope. Priority 2"), "\(box.name)")
        }
    }
}

@MainActor
@Test func theTopGrowsLongerNeverWiderAtTheLargestText() async throws {
    let doc = BriefDocument.parse(briefFile())
    let day = TodayDay(json: busyDay())
    let plan = CloseDayPlan(day)
    let missing = try #require(NoteNotWritten(.http(status: 409, envelope: ConsoleErrorEnvelope(code: "section_missing", message: "x", details: ["path": .string("Journal/2026-09-28.md"), "request_id": .number(9)]))))
    let pieces: [(String, AnyView)] = [
        ("brief", AnyView(TodayBriefOpen(document: doc, standup: standupFile(), path: briefPath, planned: 4, carried: 1, assistantName: "Aide", clock: ClockTime(timeZone: utc), onCopyStandup: { _ in }))),
        ("close", AnyView(TodayClosePanel(plan: plan, choices: DeferChoice.available(today: "2026-09-28", profile: nil, calendar: utcCalendar), today: "2026-09-28", tomorrow: nil, clock: ClockTime(timeZone: utc), notes: [:], closing: false, refusal: nil, line: .constant(""), onDefer: { _, _ in }, onTick: { _, _ in }, onClose: {}))),
        ("request", AnyView(TodayNoteNotWrittenView(missing: missing, onOpenRequest: {}, onReopen: {}))),
    ]
    let width: CGFloat = 360
    for (name, view) in pieces {
        var heights: [DynamicTypeSize: CGFloat] = [:]
        for size in [DynamicTypeSize.large, .accessibility5] {
            let renderer = ImageRenderer(content: view.frame(width: width).environment(\.dynamicTypeSize, size))
            renderer.proposedSize = ProposedViewSize(width: width, height: nil)
            renderer.scale = 1
            let image = try #require(renderer.cgImage, "\(name) did not render")
            #expect(CGFloat(image.width) <= width, "\(name) is \(image.width) wide at \(size)")
            heights[size] = CGFloat(image.height)
        }
        #expect((heights[.accessibility5] ?? 0) > (heights[.large] ?? 0), "\(name) did not grow at the largest text: \(heights)")
    }
}

@Test func noStringInTheScreensSourcesSaysAssistantOrNamesOne() throws {
    let kit = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("sources/kit")
    var literals: [String] = []
    for file in ["today-view.swift", "today-brief-view.swift", "today-model.swift"] {
        let text = try String(contentsOf: kit.appendingPathComponent(file), encoding: .utf8)
        // §2.18.4: nothing here slides, so Reduce Motion has nothing to stop; no bare key outside the menu table (C119)
        #expect(!text.contains("withAnimation") && !text.contains(".animation(") && !text.contains(".transition("), "\(file)")
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
    }
}


// MARK: - The spine (T6-1a) — the ticket's two first

@MainActor
@Test func aTickOnAChangedLineShowsTheCurrentLineAndWritesNothing() async throws {
    let console = TodayConsole(day: busyDay(), pages: pages())
    let (model, session) = todayModel(console, at: at("11:00"))
    defer { withExtendedLifetime(session) {} }
    await model.load()
    let spine = try #require(model.spine)
    guard case .task(let lease)? = spine.placeable.first(where: { $0.key == "mt-lease" }) else { Issue.record("\(spine.placeable)"); return }

    console.check = .failure(.http(status: 409, envelope: ConsoleErrorEnvelope(json: json(#"{"error": {"code": "conflict", "message": "the line changed"}, "reason": "stale", "line": "- [ ] Draft the lease comparison for Jim"}"#))))
    let before = console.calls.count
    let written = await model.tick(lease, checked: true)
    #expect(!written)

    // one call, the Tick door, and nothing after it: no retry, no reload, no order
    let after = Array(console.calls.dropFirst(before))
    #expect(after.map(\.path) == ["/api/vault-tasks/mt-lease/check"], "\(after.map(\.path))")
    #expect(after.first?.body == json(#"{"checked": true, "seen_text": "Draft the lease comparison"}"#))
    #expect(model.notes["mt-lease"] == .stale(line: "- [ ] Draft the lease comparison for Jim"))
    // the row keeps its place, open, with the line as it now stands beneath it
    #expect(model.spine?.placeable.map(\.key) == spine.placeable.map(\.key))
    guard case .task(let still)? = model.spine?.placeable.first(where: { $0.key == "mt-lease" }) else { Issue.record("gone"); return }
    #expect(!still.checked)

    let tree = try await AccessibilityProbe.snapshot(TodayView(model: model, assistantName: "Aide", tick: .seconds(3600)).frame(width: 820, height: 2000))
    defer { tree.close() }
    let said = tree.labels + tree.texts
    #expect(said.contains { $0.contains("This line changed in your note since it was shown. Nothing was written.") }, "\(said)")
    #expect(said.contains { $0.contains("- [ ] Draft the lease comparison for Jim") }, "the current line is shown: \(said)")
    #expect(!said.contains { $0.hasPrefix("Ticked in") }, "never a receipt for a write that did not happen")
    let box = try #require(tree.controls.first { $0.role == "AXCheckBox" && $0.name.hasPrefix("Draft the lease comparison") })
    #expect(box.value == "0" || box.value.isEmpty, "the box stays open: \(box)")
}

@MainActor
@Test func dragOrderSurvivesAReload() async throws {
    let day = dayJSON(tasks: [
        task("mt-a", "Answer the lease email", size: "s"),
        task("mt-b", "Book the walkthrough", size: "s"),
        task("mt-c", "Call the dentist", size: "s"),
    ], events: [], work: [workRow("41", "Pick the fixture redaction", waitsOn: "Answer the lease email")])
    let console = TodayConsole(day: day, pages: pages())
    let (model, session) = todayModel(console, at: at("10:00"))
    defer { withExtendedLifetime(session) {} }
    await model.load()
    #expect(model.spine?.isList == true, "no meeting: the plain list (§12.4)")
    #expect(model.spine?.list.map(\.key) == ["mt-a", "mt-b", "mt-c", "work:41"], "no order yet: as served")

    // a drag: Call the dentist dropped on Answer the lease email takes its place
    await model.move("mt-c", onto: "mt-a")
    let put = try #require(console.calls.last { $0.method == "PUT" })
    #expect(put.path == "/api/today/order")
    #expect(put.body == json(#"{"date": "2026-09-28", "task_keys": ["mt-c", "mt-a", "mt-b", "work:41"]}"#))
    #expect(model.spine?.list.map(\.key) == ["mt-c", "mt-a", "mt-b", "work:41"])
    // Move Down: the keyboard's and VoiceOver's drag
    await model.move("work:41", by: -1)
    #expect(model.spine?.list.map(\.key) == ["mt-c", "mt-a", "work:41", "mt-b"])

    // the reload: the same model, and a fresh one — the order is the console's now
    await model.load()
    #expect(model.orderOverride == nil, "the day carries the stored order")
    #expect(model.spine?.list.map(\.key) == ["mt-c", "mt-a", "work:41", "mt-b"])
    let (fresh, freshSession) = todayModel(console, at: at("15:00"))
    defer { withExtendedLifetime(freshSession) {} }
    await fresh.load()
    #expect(fresh.spine?.list.map(\.key) == ["mt-c", "mt-a", "work:41", "mt-b"])

    // a refused order puts the rows back and says so
    console.orderRefusal = .http(status: 400, envelope: ConsoleErrorEnvelope(code: "invalid_request", message: "this key is not on 2026-09-28: mt-b"))
    await fresh.move("mt-b", onto: "mt-c")
    #expect(fresh.spine?.list.map(\.key) == ["mt-c", "mt-a", "work:41", "mt-b"])
    #expect(fresh.orderNote?.hasPrefix("Not moved") == true)
}

@MainActor
@Test func thePageOpensAtNow() async throws {
    let console = TodayConsole(day: busyDay(), pages: pages())
    let (model, session) = todayModel(console, at: at("13:31"))
    defer { withExtendedLifetime(session) {} }
    await model.load()
    let spine = try #require(model.spine)
    #expect(spine.now == at("13:31"))
    // the morning is one line above NOW
    #expect(spine.earlier.meetings.map(\.title) == ["Standup"])
    #expect(spine.earlier.done.map(\.title) == ["Sign the SOW"])
    #expect(spine.earlier.summary == "1 done · 1 meeting · 1 carried forward")
    #expect(!model.pastOpen)
    // what is left, in time order: the gap before the Lease Call, the call, the afternoon
    #expect(spine.entries.map(\.id) == ["gap:\(Int(at("13:31").timeIntervalSince1970))", "meeting:evt-lease", "gap:\(Int(at("14:30").timeIntervalSince1970))"])

    let tree = try await AccessibilityProbe.snapshot(TodayView(model: model, assistantName: "Aide", tick: .seconds(3600)).frame(width: 820, height: 2000))
    defer { tree.close() }
    let names = tree.nodes.map(\.name)
    #expect(names.contains("Now, 1:31 PM"), "\(names)")
    #expect(names.contains { $0.hasPrefix("Earlier today: 1 done, 1 meeting, 1 carried forward") }, "the morning, one line: \(names)")
    // what is left is under NOW, in its gaps
    let placed = spine.entries.flatMap { entry -> [String] in if case .gap(let g) = entry { return g.items.map(\.key) } else { return [] } }
    #expect(placed == ["mt-jim", "mt-ana", "mt-lease"], "\(placed)")
    #expect(!tree.controlNames.contains { $0.hasPrefix("Sign the SOW") }, "a line done this morning is in the fold, not on the page")
    #expect(tree.headings.contains("Now, 1:31 PM"), "NOW is a heading, so the rotor finds it: \(tree.headings)")

    model.togglePast()
    let open = try await AccessibilityProbe.snapshot(TodayView(model: model, assistantName: "Aide", tick: .seconds(3600)).frame(width: 820, height: 2200))
    defer { open.close() }
    #expect(open.controlNames.contains { $0.hasPrefix("Sign the SOW, done") }, "expanded in place: \(open.controlNames)")
}

// MARK: - The spine, laid out

@Test func rowsGoInTheGapsInTheOwnersOrderAndWhatDoesNotFitIsShownNotRefused() throws {
    // 9:00–17:30; meetings 10:00–12:00 with Dana and 13:00–17:00 with Jim; a focus block 12:00–12:45
    let day = TodayDay(json: dayJSON(tasks: [
        task("mt-l", "Write the settings brief", size: "l"),
        task("mt-s", "Renew the parking permit", size: "s"),
        task("mt-m", "Read the migration notes", size: "m"),
        task("mt-x", "Plan the offsite", size: "l"),
        task("mt-none", "Water the plants"),
    ], events: [
        event("e1", "Design Review", "10:00", "12:00", with: [("Dana", nil)]),
        event("focus", "Deep work", "12:00", "12:45"),
        event("e2", "Vendor Day", "13:00", "17:00", with: [("Jim", nil)]),
    ]))
    let profile = WorkingProfile(workingDays: ["mon"], dayStart: 540, dayEnd: 1050)
    let spine = TodaySpine.build(day, order: ["mt-s", "mt-l"], kept: [], now: at("08:40"), profile: profile, calendar: utcCalendar, sizes: TaskFacets.defaultSizeMinutes)

    // the page opens at 8:40 but the day at 9:00; the owner's two first, then as served
    #expect(spine.arranged.map(\.key) == ["mt-s", "mt-l", "mt-m", "mt-x", "mt-none"])
    #expect(spine.placeable.map(\.key) == ["mt-s", "mt-m", "mt-none", "mt-l", "mt-x"], "as drawn: the gaps, then what doesn't fit")
    let gaps = spine.entries.compactMap { entry -> TodaySpine.Gap? in if case .gap(let g) = entry { return g } else { return nil } }
    #expect(gaps.map(\.label) == ["1h free", "Focus — Deep work", "15m free", "30m free"])
    // 9:00–10:00: 15m and 45m fit, and the line with no size; neither 90m row fits anywhere left
    #expect(gaps[0].items.map(\.key) == ["mt-s", "mt-m", "mt-none"])
    #expect(gaps[0].fits == "all 3 fit · 1 has no size")
    #expect(gaps[1].items.isEmpty, "the 90m rows do not fit 45m")
    #expect(spine.doesNotFit.map(\.key) == ["mt-l", "mt-x"], "shown under Doesn't fit, and they hold up nothing after them")
    // a row is never drawn above one the owner put before it
    let later = TodaySpine.build(day, order: ["mt-m", "mt-s"], kept: [], now: at("09:30"), profile: profile, calendar: utcCalendar, sizes: TaskFacets.defaultSizeMinutes)
    let laterGaps = later.entries.compactMap { entry -> TodaySpine.Gap? in if case .gap(let g) = entry { return g } else { return nil } }
    #expect(laterGaps.first?.items.map(\.key) == [], "30m before the review: the 45m row does not fit")
    #expect(laterGaps[1].items.map(\.key) == ["mt-m"], "it goes to the focus block")
    #expect(laterGaps[2].items.map(\.key) == ["mt-s", "mt-none"], "and the 15m row follows it rather than jumping ahead into 9:30")
    #expect(TodayWords.doesNotFit(spine.dayEnd.map(ClockTime(timeZone: utc).time)) == "Doesn’t fit before 5:30 PM")

    // with no working_hours there is no end: the afternoon is open and everything fits
    let open = TodaySpine.build(day, order: [], kept: [], now: at("08:40"), profile: nil, calendar: utcCalendar, sizes: TaskFacets.defaultSizeMinutes)
    #expect(open.doesNotFit.isEmpty)
    #expect(open.dayEnd == nil)

    // a line with no size fits anywhere, and the gap says it has none
    let unsized = TodaySpine.build(day, order: ["mt-none"], kept: [], now: at("08:40"), profile: profile, calendar: utcCalendar, sizes: TaskFacets.defaultSizeMinutes)
    guard case .gap(let first)? = unsized.entries.first else { Issue.record("\(unsized.entries)"); return }
    #expect(first.items.first?.key == "mt-none")
    #expect(first.fits.contains("1 has no size"))
}

@Test func aLineTickedHereKeepsItsPlaceAndTheSizesAreTheProfiles() throws {
    let day = TodayDay(json: dayJSON(tasks: [
        task("mt-a", "Answer the lease email", checked: true, size: "s"),
        task("mt-b", "Book the walkthrough", size: "s"),
    ], events: [event("e1", "Lease Call", "14:00", "14:30", with: [("Jim", nil)])]))
    let profile = WorkingProfile.parse("---\nworking_hours: \"09:00-17:30\"\ntask_size_minutes: { s: 20, m: 50, l: 100 }\n---\n")
    #expect(profile.sizeMinutes == ["s": 20, "m": 50, "l": 100])
    #expect(WorkingProfile.parse("---\ntask_size_minutes:\n  s: 10\n  l: 80\n---\n").sizeMinutes == ["s": 10, "l": 80])
    #expect(WorkingProfile.parse("---\n# task_size_minutes: { s: 15 }\n---\n").sizeMinutes == nil, "commented out: the profile does not say")

    let kept = TodaySpine.build(day, order: ["mt-a", "mt-b"], kept: ["mt-a"], now: at("10:00"), profile: profile, calendar: utcCalendar, sizes: profile.sizeMinutes!)
    #expect(kept.placeable.map(\.key) == ["mt-a", "mt-b"], "ticked a moment ago: struck, where it was (P9)")
    #expect(kept.earlier.done.isEmpty)
    let later = TodaySpine.build(day, order: ["mt-a", "mt-b"], kept: [], now: at("10:00"), profile: profile, calendar: utcCalendar, sizes: profile.sizeMinutes!)
    #expect(later.earlier.done.map(\.key) == ["mt-a"], "on the next open it is the morning's")
    guard case .gap(let gap)? = later.entries.first else { Issue.record("\(later.entries)"); return }
    #expect(gap.used == 20, "size s is the profile's 20 minutes")
}

@Test func theDayBarMeasuresTheWorkingDayAndRefusesNothing() throws {
    let day = TodayDay(json: dayJSON(tasks: [
        task("mt-l", "Write the settings brief", size: "l"),
        task("mt-s", "Renew the parking permit", size: "s"),
    ], events: [
        event("e1", "Design Review", "10:00", "11:00", with: [("Dana", nil)]),
        event("e2", "Overlapping Sync", "10:30", "11:30", with: [("Jim", nil)]),
        event("focus", "Deep work", "15:00", "16:30"),
    ]))
    let profile = WorkingProfile(dayStart: 540, dayEnd: 1080)
    let sizes = TaskFacets.defaultSizeMinutes
    let spine = TodaySpine.build(day, order: [], kept: [], now: at("09:00"), profile: profile, calendar: utcCalendar, sizes: sizes)
    let bar = try #require(DayBar.of(day, spine: spine, profile: profile, calendar: utcCalendar, sizes: sizes))
    #expect(bar.value(.meetings) == 90, "two overlapping meetings are one stretch, counted once")
    #expect(bar.value(.focus) == 90)
    #expect(bar.value(.travel) == 0)
    #expect(bar.value(.fits) == 105)
    #expect(bar.value(.doesNotFit) == 0)
    #expect(bar.line == "3h committed of 9h · everything planned fits")
    #expect(bar.sentence == "The day: 3 hours committed of 9 hours; everything planned fits")
    #expect(DayBar.Segment.allCases.map(\.rawValue) == ["Meetings", "Travel", "Focus Blocked", "Tasks That Fit", "Doesn’t Fit"])
    #expect(DayBar.Segment.allCases.map(TodayDayBarView.ink) == [.chart1, .chart2, .chart3, .chart4, .degraded], "a chart: the ramp, never the facet channels")

    // at 5:00 PM an hour is left: the 90-minute line doesn't fit, and the bar says so
    let late = TodaySpine.build(day, order: [], kept: [], now: at("17:00"), profile: profile, calendar: utcCalendar, sizes: sizes)
    let lateBar = try #require(DayBar.of(day, spine: late, profile: profile, calendar: utcCalendar, sizes: sizes))
    #expect(lateBar.value(.doesNotFit) == 90)
    #expect(lateBar.line == "3h committed of 9h · 1h 30m doesn’t fit")
    #expect(DayBar.of(day, spine: spine, profile: WorkingProfile(), calendar: utcCalendar, sizes: sizes) == nil, "no working_hours: none assumed")
}

// MARK: - All

@MainActor
@Test func allRunsTheBoxThroughTheOneLanguageAndSaysARefusalInTheParsersWords() async throws {
    let console = TodayConsole(day: busyDay(), pages: pages())
    let (model, session) = todayModel(console, at: at("10:00"))
    defer { withExtendedLifetime(session) {} }
    await model.load()
    #expect(model.mode == .today)
    model.toggleMode()
    #expect(model.mode == .all, "View ▸ Today / All")

    model.whereText = "due <= 2026-09-28"
    await model.runWhere()
    let asked = try #require(console.calls.last { $0.path.hasPrefix("/api/vault-tasks") })
    #expect(asked.method == "GET")
    #expect(URLComponents(string: "http://x\(asked.path)")?.queryItems == [URLQueryItem(name: "where", value: "due <= 2026-09-28")])
    guard case .rows(let rows, let filter, _) = model.allTasks else { Issue.record("\(model.allTasks)"); return }
    #expect(filter == "due <= 2026-09-28")
    #expect(!rows.isEmpty, "the recorded rows decode")

    // Waiting on Others is a stored where: string, loaded into the box as it is
    let waiting = try #require(SavedTaskView.all.first { $0.name == "Waiting on Others" })
    await model.apply(waiting)
    #expect(model.whereText == "waiting")
    #expect(console.calls.last?.path == "/api/vault-tasks?where=waiting")
    // Slipping and Owed are drawn and dimmed, saying why — nothing is guessed at
    #expect(SavedTaskView.all.map(\.name) == ["Slipping", "Owed", "Waiting on Others"])
    for name in ["Slipping", "Owed"] {
        let view = try #require(SavedTaskView.all.first { $0.name == name })
        #expect(view.filter == nil && view.unavailableBecause != nil)
        let calls = console.calls.count
        await model.apply(view)
        #expect(console.calls.count == calls, "\(name) asks nothing")
    }

    // a filter outside the grammar: the parser's own message
    let refusing = RefusingVaultTasks(inner: console)
    let (other, otherSession) = todayModel(refusing, at: at("10:00"))
    defer { withExtendedLifetime(otherSession) {} }
    other.whereText = "due <= friday; drop table"
    await other.runWhere()
    #expect(other.allTasks == .refused("where: character \";\" is not allowed — the filter language has no quotes, semicolons or parentheses"))

    // ⌘F is All's box
    model.setMode(.today)
    model.askForTheBox()
    #expect(model.mode == .all)
    #expect(model.takeBoxRequest())
    #expect(!model.takeBoxRequest(), "answered once")
}

@MainActor
@Test func theRecordedDayKeepsTheStoredOrderAndItsWorkRows() async throws {
    let console = try FixtureConsole.recorded()
    let (model, session) = todayModel(console, at: at("12:00"))
    defer { withExtendedLifetime(session) {} }
    await model.load()
    let day = try #require(model.day)
    #expect(!day.order.isEmpty)
    let spine = try #require(model.spine)
    #expect(Array(spine.placeable.map(\.key).prefix(day.order.count)) == day.order, "the stored order leads")
    #expect(!day.work.isEmpty && spine.placeable.contains { if case .work = $0 { return true } else { return false } })
    let order = try ConsoleFixture.load("put-api-today-order")
    #expect(order.replyJSON?["order"]?.arrayValue?.isEmpty == false)
}

// MARK: - The spine's §2.18

@MainActor
@Test func everyControlOnTheSpineAndInAllSpeaksItsName() async throws {
    let day = dayJSON(tasks: [
        task("mt-jim", "Send Jim the revised Q4 scope", assigned: "Jim", priority: 2, size: "m", carried: 2),
        task("mt-lease", "Draft the lease comparison", priority: 3, size: "l"),
        task("mt-sow", "Sign the SOW", checked: true),
    ], events: [
        event("evt-standup", "Standup", "09:30", "09:45", with: [("Dana", "People/Dana.md")]),
        event("focus", "Deep work", "15:00", "16:00"),
    ], work: [workRow("41", "Pick the fixture redaction", waitsOn: "Send Jim the revised Q4 scope")])
    let console = TodayConsole(day: day, pages: pages())
    let (model, session) = todayModel(console, at: at("11:00"))
    defer { withExtendedLifetime(session) {} }
    await model.load()
    let tree = try await AccessibilityProbe.snapshot(TodayView(model: model, assistantName: "Aide", tick: .seconds(3600)).frame(width: 820, height: 2200))
    defer { tree.close() }
    #expect(tree.unlabeledBesidesFields.isEmpty, "unlabeled: \(tree.unlabeledBesidesFields)")
    #expect(tree.saysAssistant.isEmpty, "\(tree.saysAssistant)")
    let said = tree.labels + tree.texts
    #expect(said.contains { $0.hasPrefix("The day: ") }, "the day bar speaks one sentence: \(said)")
    #expect(said.contains("Pick the fixture redaction. Work #41, blocked, waiting on you: Send Jim the revised Q4 scope. An agent's row — Open it on the Board"), "\(said)")
    #expect(said.contains { $0.hasPrefix("Focus — Deep work") }, "a focus block is a place for rows: \(said)")
    #expect(tree.controlNames.contains { $0.hasPrefix("Send Jim the revised Q4 scope. Priority 2, 45 minutes, second day") }, "\(tree.controlNames)")
    #expect(tree.controls.contains { $0.role == "AXSegmentedControl" || $0.name == TodayWords.todayOrAllSpoken || $0.name == "Today" }, "\(tree.controlNames)")

    model.setMode(.all)
    let all = try await AccessibilityProbe.snapshot(TodayView(model: model, assistantName: "Aide", tick: .seconds(3600)).frame(width: 820, height: 1400))
    defer { all.close() }
    #expect(all.unlabeledBesidesFields.isEmpty, "unlabeled: \(all.unlabeledBesidesFields)")
    #expect(all.fieldsWithoutAPrompt.isEmpty)
    for name in ["Saved view, Slipping", "Saved view, Owed", "Saved view, Waiting on Others", TodayWords.copyWhere] {
        #expect(all.controlNames.contains { $0.hasPrefix(name) }, "\(name) in \(all.controlNames)")
    }
}

@MainActor
@Test func theSpineGrowsLongerNeverWiderAtTheLargestText() async throws {
    let bar = DayBar(minutes: [.meetings: 162, .travel: 0, .focus: 90, .fits: 65, .doesNotFit: 0], workingMinutes: 540)
    let gap = TodaySpine.Gap(start: at("10:00"), end: at("10:35"), focus: nil, items: [], used: 25, unsized: 0)
    let work = try #require(TodayWork(json: json(workRow("41", "Pick the fixture redaction", waitsOn: "Send Dana the fixture format"))))
    let clock = ClockTime(timeZone: utc)
    let pieces: [(String, AnyView)] = [
        ("bar", AnyView(TodayDayBarView(bar: bar))),
        ("gap", AnyView(TodayGapHeader(gap: gap, clock: clock))),
        ("work", AnyView(TodayWorkRow(work: work, onMoveUp: nil, onMoveDown: nil))),
        ("earlier", AnyView(TodayEarlierLine(summary: "3 done · 1 meeting · 2 carried forward", open: false, onToggle: {}))),
        ("now", AnyView(TodayNowRule(time: "1:31 PM"))),
    ]
    let width: CGFloat = 360
    for (name, view) in pieces {
        var heights: [DynamicTypeSize: CGFloat] = [:]
        for size in [DynamicTypeSize.large, .accessibility5] {
            let renderer = ImageRenderer(content: view.frame(width: width).environment(\.dynamicTypeSize, size))
            renderer.proposedSize = ProposedViewSize(width: width, height: nil)
            renderer.scale = 1
            let image = try #require(renderer.cgImage, "\(name) did not render")
            #expect(CGFloat(image.width) <= width, "\(name) is \(image.width) wide at \(size)")
            heights[size] = CGFloat(image.height)
        }
        #expect((heights[.accessibility5] ?? 0) > (heights[.large] ?? 0), "\(name) did not grow at the largest text: \(heights)")
    }
}

// MARK: - The window's minimum

// 0.14.1, as Activity's and Needs You's: the window's minimum is SwiftUI's
// answer for the whole window at no size at all, and Today answered with its
// content's at no width — 1,127–1,440 pt with a day on screen, 1,841 when the
// console did not answer — so opening it grew the window. Its minimum is the
// shell's, in every panel.
@MainActor
@Test func openingTodayNeverRaisesTheWindowsMinimum() async throws {
    let console = TodayConsole(day: busyDay(), pages: pages(brief: briefFile()))
    let (model, session) = todayModel(console, at: at("13:31"))
    defer { withExtendedLifetime(session) {} }
    await model.load()
    #expect(model.day != nil)

    let window = try await ShellProbe.acrossTheSwitch { TodayView(model: model, assistantName: "Aide", tick: .seconds(3600)) }
    #expect(window.after.minimum.height <= max(window.before.minimum.height, 460), "opening Today raised the window's minimum to \(window.after.minimum)")
    #expect(window.after.frame == window.before.frame, "the window moved: \(window.before.frame) → \(window.after.frame)")

    // every panel: waiting, the day, All, failed
    let (waiting, waitingSession) = todayModel(TodayConsole(day: busyDay(), pages: pages()), at: at("13:31"))
    let (failed, failedSession) = todayModel(UnreachableConsole(), at: at("13:31"))
    defer { withExtendedLifetime([waitingSession, failedSession]) {} }
    await failed.load()
    let probe = MinimumProbe()
    var sizes = [
        ("waiting", probe.minimum(of: TodayView(model: waiting, assistantName: "Aide", tick: .seconds(3600)))),
        ("the day", probe.minimum(of: TodayView(model: model, assistantName: "Aide", tick: .seconds(3600)))),
        ("failed", probe.minimum(of: TodayView(model: failed, assistantName: "Aide", tick: .seconds(3600)))),
    ]
    model.setMode(.all)
    sizes.append(("all", probe.minimum(of: TodayView(model: model, assistantName: "Aide", tick: .seconds(3600)))))
    for (name, size) in sizes {
        #expect(size.height <= 460, "\(name) asks for \(size) at the least")
    }
}

// MARK: - Helpers

private let utc = TimeZone(identifier: "UTC")!
private var utcCalendar: Calendar { var c = Calendar(identifier: .gregorian); c.timeZone = utc; return c }
private let briefPath = "Journal/Brief/2026-09-28.md"
private let standupPath = "Journal/Standup/2026-09-28.md"

/// A time on Monday 28 September 2026, UTC.
private func at(_ hhmm: String) -> Date { WireTime.date("2026-09-28T\(hhmm):00.000Z")! }

private func json(_ text: String) -> JSONValue {
    try! JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
}

@MainActor
private func todayModel(_ console: any ConsoleCallTransport, at now: Date) -> (TodayModel, ConsoleSession) {
    let session = ConsoleSession(transport: console, management: nil)
    return (TodayModel(session: session, timeZone: utc, now: { now }), session)
}

private func profileFile() -> String {
    "---\nsource: user\nworking_days: [mon, tue, wed, thu, fri]\nworking_hours: \"09:00-17:30\"\n---\n# Me\n"
}

private func standupFile() -> String {
    "---\nsource: standup\n---\n# Standup — 2026-09-28\n\n**Yesterday:** froze the store interface.\n**Today:** the recorder.\n"
}

private func briefFile(prosePending: Bool = false, nextUpPending: Bool = false) -> String {
    let pending = "<!-- metistry:prose 1 --> _pending — written on this file's one assistant turn_"
    let prose = prosePending ? pending : "Four things today; the lease comparables are the one that moved. Jim is waiting on the Q4 scope. <!-- metistry:written 1 -->"
    let standup = nextUpPending ? "  - <!-- metistry:prose 2 --> _pending — written on this file's one assistant turn_" : "  - Two blockers to raise. <!-- metistry:written 2 -->"
    let lease = nextUpPending ? "  - <!-- metistry:prose 3 --> _pending — written on this file's one assistant turn_" : "  - Jim will ask about the comparables; the scope is still open. <!-- metistry:written 3 -->"
    return """
    ---
    source: morning-brief
    type: resource
    ---
    # Morning Brief — 2026-09-28

    \(prose)

    ## Standup

    ![[Journal/Standup/2026-09-28]]

    ## Next Up

    - 9:30–9:45 AM · Standup · with Dana
    \(standup)
    - 2:00–2:30 PM · Lease Call · with Jim Fallon
    \(lease)

    The plan is the day below — [[Journal/Plan/2026-09-28]]
    """
}

private func pages(brief: String? = nil) -> [String: String] {
    [briefPath: brief ?? briefFile(), standupPath: standupFile(), WorkingProfile.path: profileFile()]
}

private func task(_ key: String, _ text: String, checked: Bool = false, waiting: Bool = false, assigned: String? = nil, priority: Int? = nil, size: String? = nil, carried: Int = 0) -> String {
    let who = assigned.map { "\"\($0)\"" } ?? "null"
    return """
    {"path": "Journal/2026-09-28.md", "task_key": "\(key)", "text": "\(text)", "checked": \(checked), "dropped": false, "waiting": \(waiting),
     "assigned": \(who), "priority": \(priority.map(String.init) ?? "null"), "size": \(size.map { "\"\($0)\"" } ?? "null"),
     "carried_days": \(carried), "row_flags": \(carried > 0 ? "[\"carried\"]" : "[]")}
    """
}

private func event(_ id: String, _ title: String, _ from: String, _ to: String, with people: [(String, String?)] = []) -> String {
    var attendees = people.map { name, page in #"{"name": "\#(name)", "email": null, "person": \#(page.map { "\"\($0)\"" } ?? "null"), "self": false}"# }
    attendees.append(#"{"name": "Me", "email": null, "person": null, "self": true}"#)
    return """
    {"event_id": "\(id)", "title": "\(title)", "start": "2026-09-28T\(from):00.000Z", "end": "2026-09-28T\(to):00.000Z", "all_day": false,
     "location": null, "attendees": [\(attendees.joined(separator: ","))], "note": null}
    """
}

private func dayJSON(date: String = "2026-09-28", tasks: [String], events: [String], brief: String? = briefPath, work: [String] = []) -> JSONValue {
    json("""
    {"date": "\(date)", "tasks": [\(tasks.joined(separator: ","))], "work": [\(work.joined(separator: ","))], "order": [], "events": [\(events.joined(separator: ","))],
     "brief": \(brief.map { "\"\($0)\"" } ?? "null"), "standup": "\(standupPath)", "plan": "Journal/Plan/\(date).md", "as_of": "2026-09-28T23:59:00.000Z"}
    """)
}

/// A `day_work` row: blocked on a line of the owner's.
private func workRow(_ id: String, _ title: String, waitsOn: String?) -> String {
    """
    {"id": "\(id)", "title": "\(title)", "kind": "task", "status": "blocked", "blocked_by_task": \(waitsOn.map { "\"\($0)\"" } ?? "null"),
     "blocked_by_task_open": \(waitsOn != nil), "row_flags": ["waiting_on_me", "blocked", "open"]}
    """
}

/// Answers `GET /api/vault-tasks` with the parser's refusal; everything else as the console it wraps.
private final class RefusingVaultTasks: ConsoleCallTransport, @unchecked Sendable {
    let inner: any ConsoleCallTransport
    init(inner: any ConsoleCallTransport) { self.inner = inner }

    func call(_ method: String, _ path: String, body: Data?, idempotencyKey: String?) async -> Result<Data, ConsoleError> {
        if path.hasPrefix("/api/vault-tasks?") {
            return .failure(.http(status: 400, envelope: ConsoleErrorEnvelope(code: "invalid_request", message: "where: character \";\" is not allowed — the filter language has no quotes, semicolons or parentheses")))
        }
        return await inner.call(method, path, body: body, idempotencyKey: idempotencyKey)
    }
}

/// A Monday: a standup, the Lease Call with Jim, one line owed to him, one waiting on Ana, one of the owner's own, one done.
private func busyDay(brief: String? = briefPath) -> JSONValue {
    dayJSON(tasks: [
        task("mt-jim", "Send Jim the revised Q4 scope", assigned: "Jim", priority: 2, size: "m", carried: 2),
        task("mt-ana", "Hear back from Ana", waiting: true, assigned: "Ana"),
        task("mt-lease", "Draft the lease comparison", priority: 3),
        task("mt-sow", "Sign the SOW", checked: true),
    ], events: [
        event("evt-standup", "Standup", "09:30", "09:45", with: [("Dana", "People/Dana.md")]),
        event("evt-lease", "Lease Call", "14:00", "14:30", with: [("Jim Fallon", "People/Jim Fallon.md")]),
    ], brief: brief)
}

/// Four half-hour meetings from 12:45, 45 minutes apart: no 90-minute stretch left.
private func fragmentedDay(reviewWithOthers: Bool = true) -> JSONValue {
    dayJSON(tasks: [
        task("mt-jim", "Send Jim the revised Q4 scope", assigned: "Jim", priority: 2),
    ], events: [
        event("evt-lease", "Lease Call", "12:45", "13:15", with: [("Jim Fallon", "People/Jim Fallon.md")]),
        event("evt-review", "Design Review", "14:00", "14:30", with: reviewWithOthers ? [("Dana", nil)] : []),
        event("evt-vendor", "Vendor Sync", "15:15", "15:45", with: [("Ana", nil)]),
        event("evt-one", "Planning", "16:30", "17:00", with: [("Dana", nil)]),
    ])
}

/// A console that serves the day, pages and the doors a test scripts; everything else from the recorded fixtures.
private final class TodayConsole: ConsoleCallTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _day: JSONValue
    private var _pages: [String: String]
    private var _calls: [FixtureCall] = []
    private var _close: Result<JSONValue, ConsoleError>?
    private var _check: Result<JSONValue, ConsoleError>?
    private var _routine: JSONValue?
    private var _order: [String]?
    private var _orderRefusal: ConsoleError?
    private let fallback = try? FixtureConsole.recorded()

    init(day: JSONValue, pages: [String: String]) {
        _day = day
        _pages = pages
    }

    var pages: [String: String] { get { lock.withLock { _pages } } set { lock.withLock { _pages = newValue } } }
    var calls: [FixtureCall] { lock.withLock { _calls } }
    var close: Result<JSONValue, ConsoleError>? { get { lock.withLock { _close } } set { lock.withLock { _close = newValue } } }
    var check: Result<JSONValue, ConsoleError>? { get { lock.withLock { _check } } set { lock.withLock { _check = newValue } } }
    var routine: JSONValue? { get { lock.withLock { _routine } } set { lock.withLock { _routine = newValue } } }
    /// The order `PUT /api/today/order` stored, served back in the day.
    var order: [String]? { get { lock.withLock { _order } } set { lock.withLock { _order = newValue } } }
    var orderRefusal: ConsoleError? { get { lock.withLock { _orderRefusal } } set { lock.withLock { _orderRefusal = newValue } } }

    private func encode(_ value: JSONValue) -> Result<Data, ConsoleError> { .success(try! JSONEncoder().encode(value)) }

    func call(_ method: String, _ path: String, body: Data?, idempotencyKey: String?) async -> Result<Data, ConsoleError> {
        let sent = body.flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) }
        let scripted: Result<Data, ConsoleError>? = lock.withLock {
            _calls.append(FixtureCall(method: method, path: path, body: sent, idempotencyKey: idempotencyKey, lastEventID: nil, servedBy: nil))
            let bare = String(path.split(separator: "?").first ?? "")
            let query = URLComponents(string: "http://x\(path)")?.queryItems ?? []
            let q = Dictionary(query.map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
            switch (method, bare) {
            case ("GET", "/api/today"):
                if let date = q["date"], date != "2026-09-28" {
                    return encode(dayJSON(date: date, tasks: [task("mt-t", "Tomorrow's line")], events: [event("evt-t", "Kickoff", "10:00", "10:30")]))
                }
                if let stored = _order, case .object(var fields) = _day {
                    fields["order"] = .array(stored.map(JSONValue.string))
                    return encode(.object(fields))
                }
                return encode(_day)
            case ("PUT", "/api/today/order"):
                if let refusal = _orderRefusal { return .failure(refusal) }
                let keys = sent?["task_keys"]?.arrayValue?.compactMap(\.stringValue) ?? []
                _order = keys
                return encode(.object(["ok": .bool(true), "date": sent?["date"] ?? .null, "order": .array(keys.map(JSONValue.string))]))
            case ("GET", "/api/knowledge/page"):
                guard let p = q["path"], let content = _pages[p] else {
                    return .failure(.http(status: 404, envelope: ConsoleErrorEnvelope(code: "not_found", message: "no such page")))
                }
                return encode(.object(["path": .string(p), "content": .string(content)]))
            case ("GET", "/api/scheduled/routines/morning-brief"):
                return _routine.map(encode)
            case ("POST", "/api/today/close"):
                if let close = _close { return close.flatMap(encode) }
                return encode(json(#"{"ok": true, "day": "2026-09-28", "path": "Journal/2026-09-28.md", "appended": false, "closed_at": "2026-09-28T17:14:03.000Z", "done": 6, "moved": {"2026-09-29": 3, "2026-10-02": 1, "someday": 1}, "line": null, "plan": {"enqueued": true, "routine": "plan-tomorrow"}}"#))
            case ("POST", let p) where p.hasSuffix("/check"):
                if let check = _check { return check.flatMap(encode) }
                return encode(json(#"{"ok": true}"#))
            case ("POST", let p) where p.hasSuffix("/schedule"):
                return encode(json(#"{"ok": true}"#))
            case ("POST", let p) where p.hasPrefix("/api/calendar/events/") && p.hasSuffix("/move"):
                let id = p.dropFirst("/api/calendar/events/".count).dropLast("/move".count)
                if let token = sent?["confirm_token"]?.stringValue, token == "token-\(id)" {
                    return encode(json(#"{"moved": true}"#))
                }
                let row = (_day["events"]?.arrayValue ?? []).first { $0.string("event_id") == String(id) }
                return encode(.object([
                    "preview": .object([
                        "event_id": .string(String(id)), "title": row?["title"] ?? .null,
                        "to": .object(["start": sent?["start"] ?? .null, "end": sent?["end"] ?? .null]),
                        "attendees": row?["attendees"] ?? .array([]),
                    ]),
                    "confirm_token": .string("token-\(id)"), "moved": .bool(false),
                ]))
            case ("POST", "/message"):
                return encode(json(#"{"message_id": "77", "reply": null}"#))
            default:
                return nil
            }
        }
        if let scripted { return scripted }
        guard let fallback else { return .failure(.transport("no fixtures")) }
        return await fallback.call(method, path, body: body, idempotencyKey: idempotencyKey)
    }
}

/// A console that is not there: every request fails as a refused connection.
private struct UnreachableConsole: ConsoleCallTransport {
    func call(_ method: String, _ path: String, body: Data?, idempotencyKey: String?) async -> Result<Data, ConsoleError> {
        .failure(.transport("connect ECONNREFUSED 127.0.0.1:1"))
    }
}
#endif

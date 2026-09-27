// Activity (T6-3). Built against the recorded fixtures first — `GET
// /api/q/activity_feed` and `GET /api/runs/:id` as the console served them —
// and a scripted console where the fixture cannot say it (rows arriving while
// the list is read, a routine's run and its file, a console that stops
// answering).
//
// The ticket's two bold tests are the first two: **new rows are held and
// counted, never inserted**, and **a failed row's glyph takes `failed`**.
// Then turns, routines, chips, the three empties, words, and §2.18. macOS
// only, as the accessibility probe is (shell-accessibility-tests.swift).

#if os(macOS)
import AppKit
import Foundation
import SwiftUI
import Testing

@testable import MetistryKit

// MARK: - The ticket's two

@MainActor
@Test func newRowsAreHeldAndCountedNeverInserted() async throws {
    let console = ActivityConsole(rows: [
        feedRow("2026-09-27T03:10:00.000Z", "capture", ref: "inbox:1"),
        feedRow("2026-09-27T03:15:00.000Z", "proposal_created", ref: "proposals:2"),
    ])
    let (model, session) = activityModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.load()
    let painted = model.rows
    #expect(painted.map(\.ref) == ["proposals:2", "inbox:1"])

    // three rows land while the list is being read
    console.rows += [
        feedRow("2026-09-27T03:16:00.000Z", "tool", ref: "runs:7"),
        feedRow("2026-09-27T03:17:00.000Z", "alert", ref: "outbound_messages:3"),
        feedRow("2026-09-27T03:18:00.000Z", "work_history", ref: "work:9"),
    ]
    await model.poll()
    let asked = try #require(console.feedCalls.last)
    #expect(asked["since"] == "2026-09-27T03:15:00.000Z", "since is the newest ts painted: \(asked)")
    #expect(model.rows == painted, "nothing was inserted into the painted list")
    #expect(model.pendingCount == 3)
    #expect(model.pill?.label == "↓ 3 new")
    #expect(model.pill?.spoken == "3 new rows")

    // the same rows come back again (since is inclusive): still three, counted once
    await model.poll()
    #expect(model.feedCallsSince(console) == "2026-09-27T03:18:00.000Z", "the cursor moves over held rows too")
    #expect(model.pendingCount == 3)
    #expect(model.rows == painted)

    // taking the pill paints them, in one step, at the top
    model.showPending()
    #expect(model.pendingCount == 0)
    #expect(model.pill == nil)
    #expect(model.rows.map(\.ref) == ["work:9", "outbound_messages:3", "runs:7", "proposals:2", "inbox:1"])

    // a filter change is a different question: no cursor, no buffer
    console.rows.append(feedRow("2026-09-27T03:19:00.000Z", "capture", ref: "inbox:4"))
    await model.poll()
    #expect(model.pendingCount == 1)
    await model.setChip(.capture)
    #expect(model.pendingCount == 0)
    let fresh = try #require(console.feedCalls.last)
    #expect(fresh["since"] == nil, "a new filter asks from nothing: \(fresh)")
    #expect(fresh["kind"] == "capture")
}

@MainActor
@Test func aFailedRowsGlyphTakesFailed() async throws {
    let (model, _, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    let failed = try #require(model.rows.first { $0.ok == false }, "the recorded feed has a failed routine")
    let bad = model.presentation(failed, assistantName: "Aide")
    #expect(bad.glyphInk == .failed)
    #expect(bad.state == .failed)
    #expect(bad.glyphSymbol == MetistryGlyph.failed.rawValue, "failed has its own mark, never colour alone")
    // the glyph, not the row: the words keep their own inks
    #expect(bad.subject.ink == .textPrimary)
    #expect(bad.detail?.ink == .textSecondary)
    #expect(bad.spoken.contains("routine, failed"), "\(bad.spoken)")

    // `true` and `null` never draw it — and neither does prose that reads like failure
    for row in model.rows where row.ok != false {
        let p = model.presentation(row, assistantName: "Aide")
        #expect(p.glyphInk != .failed, "\(row.kind) \(row.ok as Any)")
        #expect(p.glyphSymbol == ActivityKind.symbol(row.kind))
    }
    let prose = feedRow("2026-09-27T03:10:00.000Z", "dispatch", detail: "dispatched to x refused: nope", ok: true)
    #expect(model.presentation(prose, assistantName: "Aide").glyphInk == .textSecondary, "failure is a column, not English in detail (C19)")
}

// MARK: - Turns

@MainActor
@Test func aTurnsCallsFoldUnderItAndOpeningAsksByTurnID() async throws {
    let (model, console, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    let items = model.items
    let turn = try #require(items.first { if case .turn = $0 { return true } else { return false } })
    guard case .turn(let head, let turnID, let calls) = turn else { return }
    #expect(turnID == "turn-izC79FgJ")
    #expect(calls.map(\.subject) == ["tasks_update", "knowledge_search"])
    // the calls are not rows of their own
    #expect(!items.contains { $0.head.kind == "tool" })
    #expect(items.count == model.rows.count - 2)

    // before its run answers, the turn says what the feed says; after, its model and cost (§6 fault 3)
    #expect(model.presentation(turn, assistantName: "Aide").subject.text == "turn")
    await model.readRun(try #require(head.runID))
    let read = model.presentation(turn, assistantName: "Aide")
    #expect(read.subject.text == "gemma")
    #expect(read.detail?.text == "2.3s · $0.0042 · 1020 tokens · 2 tools", "\(read.detail?.text ?? "")")
    #expect(read.spoken == "Aide, gemma, turn, 2.3 seconds, 0.4 cents, 1020 tokens, 2 tools collapsed, 2 minutes ago", "\(read.spoken)")

    // opening it asks the query by turn_id, so it holds every call — not only the window's
    console.reset()
    await model.setExpanded(turn, true)
    let asked = try #require(console.calls.first { $0.path.hasPrefix("/api/q/activity_feed") })
    #expect(query(asked.path)["turn_id"] == "turn-izC79FgJ", "\(asked.path)")
    #expect(model.presentation(turn, assistantName: "Aide").spoken.contains("expanded"))
    #expect(!model.calls(of: turn).rows.contains { $0.kind == "turn" }, "the turn is the disclosure, not one of its calls")
}

@MainActor
@Test func aTurnWhoseCallsFellPastTheWindowSaysHowManyAreShown() async throws {
    let console = ActivityConsole(rows: [
        feedRow("2026-09-27T03:10:00.000Z", "turn", ref: "runs:1", turnID: "t1", ok: true),
        feedRow("2026-09-27T03:10:01.000Z", "tool", ref: "runs:2", turnID: "t1", ok: true),
    ])
    console.runs[1] = run(id: 1, kind: "turn", toolCallsTotal: 4)
    console.failTurn = true
    let (model, session) = activityModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.load()
    let turn = try #require(model.items.first)
    await model.readRun(1)
    #expect(model.presentation(turn, assistantName: nil).detail?.text.hasSuffix("4 tools") == true, "the run's own count, not the window's")
    await model.setExpanded(turn, true)
    let shown = model.calls(of: turn)
    #expect(shown.rows.count == 1)
    #expect(shown.note?.hasPrefix("4 tools, 1 shown") == true, "\(shown.note ?? "")")
}

// MARK: - Routines (§12)

@MainActor
@Test func aRoutineThatWroteCarriesTheSparkAndOpensItsProse() async throws {
    let console = ActivityConsole(rows: [
        feedRow("2026-09-27T03:10:00.000Z", "routine_run", actor: "plan-tomorrow", subject: "plan-tomorrow", detail: "Journal/Plan/2026-09-28.md", ref: "runs:6", ok: true, group: "routine"),
        feedRow("2026-09-27T03:11:00.000Z", "routine_run", actor: "standup-draft", subject: "standup-draft", detail: "skipped: no_vault — no vault configured", ref: "runs:8", ok: true, group: "routine"),
    ])
    console.runs[6] = run(id: 6, kind: "routine_run", meta: ["outcome": .string("acted"), "path": .string("Journal/Plan/2026-09-28.md")])
    console.runs[8] = run(id: 8, kind: "routine_run", meta: ["outcome": .string("skipped:no_vault"), "why": .string("no vault configured")])
    console.pages["Journal/Plan/2026-09-28.md"] = "Nine tasks, two meetings, forty-five minutes left empty."
    let (model, session) = activityModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.load()
    let wrote = try #require(model.items.first { $0.head.runID == 6 })
    let skipped = try #require(model.items.first { $0.head.runID == 8 })
    guard case .routine = wrote else { Issue.record("an ok routine is expandable"); return }

    // no spark until the run says it wrote something — the feed's detail is not read for it
    #expect(model.presentation(wrote, assistantName: "Aide").spark == nil)
    await model.readRun(6)
    await model.readRun(8)
    let p = model.presentation(wrote, assistantName: "Aide")
    #expect(p.spark?.glyph == .spark)
    #expect(p.spoken.contains("routine, written"), "\(p.spoken)")

    // a routine that could not run is absent, never failed (§12.3)
    let s = model.presentation(skipped, assistantName: "Aide")
    #expect(s.glyphInk == .absent)
    #expect(s.glyphSymbol == MetistryGlyph.absent.rawValue)
    #expect(s.spark == nil)
    #expect(s.detail?.text == "didn't run: no_vault — no vault configured")

    // opening reads the file the run names, whole
    await model.setExpanded(wrote, true)
    #expect(console.calls.contains { $0.path.hasPrefix("/api/knowledge/page") && query($0.path)["path"] == "Journal/Plan/2026-09-28.md" })
    #expect(model.prose[6]?.value?.content == "Nine tasks, two meetings, forty-five minutes left empty.")
}

// MARK: - The chips, the controls

@MainActor
@Test func theEightChipsPassTheirValueStraightThrough() async throws {
    #expect(ActivityChip.allCases.map(\.label) == ["All", "Captures", "Proposals", "Decisions", "Work", "Runs", "Messages", "Routines"])
    #expect(ActivityChip.allCases.map(\.kind) == [nil, "capture", "proposal", "decision", "work", "run", "message", "routine"])
    let console = ActivityConsole(rows: [])
    let (model, session) = activityModel(console)
    defer { withExtendedLifetime(session) {} }
    for chip in ActivityChip.allCases.dropFirst() {
        await model.setChip(chip)
        #expect(console.feedCalls.last?["kind"] == chip.rawValue)
    }
    await model.setWindow(.week)
    await model.setAgent("devin")
    await model.setProject("metistry")
    let last = try #require(console.feedCalls.last)
    #expect(last["hours"] == "168" && last["agent"] == "devin" && last["project"] == "metistry" && last["kind"] == "routine", "\(last)")
}

// MARK: - The three empties (§5), and stale

@MainActor
@Test func theThreeEmptiesAreNotTheSame() async throws {
    let console = ActivityConsole(rows: [])
    let (model, session) = activityModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.load()
    guard case .state(let empty) = model.panel else { Issue.record("\(model.panel)"); return }
    #expect(empty.kind == .empty && empty.title == "Nothing in the Last 24 Hours" && empty.action == "Widen to 7 Days")
    await model.takeEmptyAction()
    #expect(model.filter.window == .week)
    #expect(console.feedCalls.last?["hours"] == "168")

    await model.setChip(.capture)
    guard case .state(let filtered) = model.panel else { Issue.record("\(model.panel)"); return }
    #expect(filtered.title == "No Captures in the Last 7 Days" && filtered.action == "Clear the Filter")
    await model.takeEmptyAction()
    #expect(model.filter == ActivityFilter(window: .week))

    console.down = "connect ECONNREFUSED 127.0.0.1:1"
    await model.setWindow(.day)
    guard case .state(let failed) = model.panel else { Issue.record("\(model.panel)"); return }
    #expect(failed.kind == .failed && failed.title == "Couldn't Load Activity")
    #expect(failed.reason?.contains("ECONNREFUSED") == true, "the error verbatim")
    #expect(failed.action == StateWords.tryAgain)

    // with rows on screen, a failed refresh keeps them and says when they are from
    console.down = nil
    console.rows = [feedRow("2026-09-27T03:10:00.000Z", "capture", ref: "inbox:1")]
    await model.load()
    console.down = "gone"
    await model.poll()
    guard case .list(let staleSince) = model.panel else { Issue.record("\(model.panel)"); return }
    #expect(staleSince != nil)
    #expect(model.rows.count == 1)
}

// MARK: - Words

@Test func titleCaseOnlyForSubjectsTheConsoleComposed() {
    #expect(ActivityTitleCase.subject("collector run failed for the day", kind: "collector_run") == "Collector Run Failed for the Day")
    #expect(ActivityTitleCase.subject("the github-state collector", kind: "alert") == "The github-state Collector")
    #expect(ActivityTitleCase.subject("mode: hybrid via knowledge_search", kind: "project_mode") == "mode: Hybrid via knowledge_search", "the token rule, as the web app has it")
    // authored text is never case-corrected (C18, P1)
    #expect(ActivityTitleCase.subject("Migrate the settings pane to tokens", kind: "work_history") == "Migrate the settings pane to tokens")
    #expect(ActivityTitleCase.subject("ask about the renewal", kind: "capture") == "ask about the renewal")
    #expect(ActivityTitleCase.subject("tasks_update", kind: "tool") == "tasks_update")
    #expect(!ActivityTitleCase.kinds.contains("work_history"))
}

@Test func theActorChipSaysTheNameOrNothing() {
    let agents: Set<String> = ["devin", "fixtures"]
    #expect(ActivityActor.of("assistant", agents: agents, assistantName: "Aide") == .agent(.assistant(named: "Aide")))
    #expect(ActivityActor.of("assistant", agents: agents, assistantName: nil) == nil, "left out, never the principal id")
    #expect(ActivityActor.of("devin", agents: agents, assistantName: "Aide")?.isAgent == true)
    #expect(ActivityActor.of("crew:fixtures", agents: agents, assistantName: nil)?.isAgent == true)
    #expect(ActivityActor.of("imessage", agents: agents, assistantName: "Aide") == .neutral("imessage"))
    let neutral = ActivityActor.neutral("console").mark(on: .surface)
    #expect(neutral.plate == .absentQuiet && neutral.ink == .textPrimary)
    #expect(ActivityActor.of("devin", agents: agents, assistantName: nil)?.mark(on: .surface).ink == .agent)
}

@Test func aRowGoesWhereItsRefSays() {
    #expect(ActivityDestination(ref: "inbox:1") == .capture(1))
    #expect(ActivityDestination(ref: "proposals:6") == .request(6))
    #expect(ActivityDestination(ref: "work:4") == .work(4))
    #expect(ActivityDestination(ref: "outbound_messages:2") == .message(2))
    #expect(ActivityDestination(ref: "runs:3") == .run(3))
    #expect(ActivityDestination(ref: "runs:3")?.isOpenable == false, "run detail is not drawn yet (§6 fault 2)")
    #expect(ActivityDestination(ref: "vault:x") == nil)
    #expect(ActivityDestination(ref: nil) == nil)
}

@Test func timeBandsAreStretchesOfTime() {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = utc
    let now = WireTime.date("2026-09-27T15:00:00Z")!
    #expect(ActivityBand.of(now.addingTimeInterval(-600), now: now, calendar: calendar) == .justNow)
    #expect(ActivityBand.of(now.addingTimeInterval(-3600), now: now, calendar: calendar) == .earlierToday)
    #expect(ActivityBand.of(now.addingTimeInterval(-86_400), now: now, calendar: calendar) == .yesterday)
    let older = ActivityBand.of(now.addingTimeInterval(-3 * 86_400), now: now, calendar: calendar)
    #expect(older.title(calendar: calendar) == "Thursday 24 Sep")
    #expect(ActivityTime.short(30) == "now" && ActivityTime.short(150) == "2m" && ActivityTime.short(7200) == "2h")
}

@MainActor
@Test func anInstanceSwitchDropsEverything() async throws {
    let (model, _, session) = try await fixtureModel()
    await model.setChip(.run)
    #expect(!model.rows.isEmpty)
    session.adopt(transport: ActivityConsole(rows: []), management: nil)
    #expect(model.rows.isEmpty)
    #expect(model.filter == ActivityFilter())
    #expect(model.runs.isEmpty && model.pending.isEmpty)
}

// MARK: - §2.18: contrast, VoiceOver, the largest text

@MainActor
@Test func everyInkOnTheScreenClearsItsGroundInBothSchemes() async throws {
    let (model, _, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    await model.readRun(1)
    var marks = model.items.flatMap { model.presentation($0, assistantName: "Aide").marks }
    marks.append(ActivityBandHeader.mark("Earlier today"))
    marks.append(ActivityActor.neutral("console").mark(on: .surface))
    let glyphInks: [MetistryColorRole] = [.textSecondary, .failed, .absent]
    for scheme in [ColorScheme.light, .dark] {
        for mark in marks {
            let floor = mark.text.isEmpty ? 3.0 : 4.5
            let ratio = Contrast.ratio(mark.ink, mark.ground, scheme)
            #expect(ratio >= floor, "\(mark.ink.rawValue) on \(mark.ground.rawValue) is \(ratio) in \(scheme) — \(mark.text)")
        }
        for ink in glyphInks {
            #expect(Contrast.ratio(ink, ActivityRowPresenter.ground, scheme) >= 3, "glyph \(ink.rawValue) in \(scheme)")
        }
        // a chosen chip's words on accent-quiet, an unchosen one's outline
        #expect(Contrast.ratio(.textPrimary, .accentQuiet, scheme) >= 4.5)
        #expect(Contrast.ratio(.borderControl, .surface, scheme) >= 3)
    }
}

@MainActor
@Test func theScreenSpeaksEveryRowAndEveryControl() async throws {
    let console = try FixtureConsole.recorded()
    let (model, session) = activityModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.load()
    await model.loadContext()
    await model.readRun(1)
    let view = ActivityView(model: model, assistantName: "Aide", tick: .seconds(3600), onOpen: { _ in })
    let tree = try await AccessibilityProbe.snapshot(view.frame(width: 900, height: 700))
    defer { tree.close() }
    #expect(tree.unlabeledControls.isEmpty, "unlabeled: \(tree.unlabeledControls)")
    let said = tree.labels + tree.texts
    // the principal id is never an actor; an agent's own words may still say "assistant" (P1: data)
    #expect(!said.contains { $0.lowercased().hasPrefix("assistant") }, "said: \(said)")
    // <actor>, <subject>, <kind said in words>, <detail>, <time> (§9)
    #expect(said.contains("app, Ask Dana about the fixture format on Thursday., capture, app, new, 2 minutes ago"), "said: \(said)")
    #expect(said.contains("knowledge-fold, knowledge-fold, routine, failed, routine failed vault bridge unreachable, 2 minutes ago"), "said: \(said)")
    #expect(said.contains { $0.hasPrefix("Aide, gemma, turn,") && $0.contains("2 tools collapsed") }, "said: \(said)")
    #expect(said.contains("Just now"), "the band header")
    let controls = tree.controlNames
    for name in ["All", "Captures", "Proposals", "Decisions", "Work", "Runs", "Messages", "Routines"] {
        #expect(controls.contains(name), "controls: \(controls)")
    }
}

@MainActor
@Test func thePillSaysHowManyAndWhatItDoes() async throws {
    let console = ActivityConsole(rows: [feedRow("2026-09-27T03:10:00.000Z", "capture", ref: "inbox:1")])
    let (model, session) = activityModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.load()
    console.rows += (0..<12).map { feedRow("2026-09-27T03:11:\(String(format: "%02d", $0)).000Z", "tool", ref: "runs:\($0 + 10)") }
    await model.poll()
    let tree = try await AccessibilityProbe.snapshot(ActivityView(model: model, assistantName: "Aide", tick: .seconds(3600)).frame(width: 700, height: 500))
    defer { tree.close() }
    let pill = try #require(tree.controls.first { $0.name == "12 new rows" }, "controls: \(tree.controlNames)")
    #expect(pill.role == "AXButton")
    #expect(model.rows.count == 1, "drawing the pill inserted nothing")
}

@MainActor
@Test func aRowGrowsLongerNeverWiderAtTheLargestText() async throws {
    let (model, _, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    let long = model.rows.first { ($0.detail?.count ?? 0) > 150 }!
    let pieces: [(String, AnyView, CGFloat)] = [
        ("row", AnyView(ActivityRowView(model.presentation(long, assistantName: "Aide"))), 360),
        ("header", AnyView(ActivityHeader(model: model)), 360),
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

// 0.14.1: the window's minimum is SwiftUI's answer for the whole window at no
// size at all, and Activity answered with its chips a character per line —
// 1,117 pt — so opening it grew the window, or slid the sidebar's rows off the
// top of one that could not grow. Its minimum is the shell's, in every panel.
@MainActor
@Test func openingActivityNeverRaisesTheWindowsMinimum() async throws {
    var rows = [feedRow("2026-09-27T03:19:00.000Z", "turn", ref: "runs:1", turnID: "t1")]
    rows += (0..<30).map { feedRow(String(format: "2026-09-27T03:19:%02d.000Z", $0 + 1), "tool", subject: "knowledge_search", ref: "runs:\($0 + 2)", turnID: "t1", ok: $0 % 9 != 4) }
    rows += (0..<40).map { feedRow(String(format: "2026-09-2%dT%02d:10:00.000Z", 6 + $0 % 2, $0 % 24), "capture", subject: "A thought long enough to wrap its row", ref: "inbox:\($0 + 1)") }
    let (model, session) = activityModel(ActivityConsole(rows: rows))
    defer { withExtendedLifetime(session) {} }
    await model.load()
    #expect(model.rows.count == rows.count)

    let window = try await ShellProbe.acrossTheSwitch { ActivityView(model: model, assistantName: "Aide", tick: .seconds(3600)) }
    #expect(window.after.minimum.height <= max(window.before.minimum.height, 460), "opening Activity raised the window's minimum to \(window.after.minimum)")
    #expect(window.after.frame == window.before.frame, "the window moved: \(window.before.frame) → \(window.after.frame)")

    // every other panel too: waiting, failed, empty
    let probe = MinimumProbe()
    let down = ActivityConsole(rows: [])
    down.down = "connect ECONNREFUSED 127.0.0.1:1"
    let (failed, failedSession) = activityModel(down)
    let (empty, emptySession) = activityModel(ActivityConsole(rows: []))
    let (waiting, waitingSession) = activityModel(ActivityConsole(rows: []))
    defer { withExtendedLifetime([failedSession, emptySession, waitingSession]) {} }
    await failed.load()
    await empty.load()
    for (name, panelModel) in [("list", model), ("failed", failed), ("empty", empty), ("waiting", waiting)] {
        let size = probe.minimum(of: ActivityView(model: panelModel, assistantName: "Aide", tick: .seconds(3600)))
        #expect(size.height <= 460, "\(name): \(panelModel.panel) asks for \(size) at the least")
    }
}

@Test func noStringInTheScreensSourceSaysAssistantOrNamesOne() throws {
    let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("sources/kit/activity-view.swift")
    let text = try String(contentsOf: file, encoding: .utf8)
    var literals: [String] = []
    for line in text.split(separator: "\n") where !line.trimmingCharacters(in: .whitespaces).hasPrefix("//") && !line.trimmingCharacters(in: .whitespaces).hasPrefix("///") {
        let parts = line.split(separator: "\"", omittingEmptySubsequences: false)
        literals += stride(from: 1, to: parts.count, by: 2).map { String(parts[$0]) }
    }
    #expect(literals.count > 40, "the scan found almost nothing")
    // §2.18.4: nothing on the screen slides, so Reduce Motion has nothing to stop
    #expect(!text.contains("withAnimation") && !text.contains(".animation(") && !text.contains(".transition("))
    // the chips and the pill are controls; no bare key is bound outside the menu table (C119)
    #expect(!text.contains(".keyboardShortcut("))
    for literal in literals {
        #expect(!literal.localizedCaseInsensitiveContains("assistant"), "\"\(literal)\"")
        #expect(literal.range(of: #"\bMetis\b"#, options: .regularExpression) == nil, "\"\(literal)\"")
        #expect(!literal.localizedCaseInsensitiveContains("feed"), "Activity is the noun: \"\(literal)\"")
    }
}

// MARK: - Helpers

private let utc = TimeZone(identifier: "UTC")!
/// Two minutes after the recorded feed's `as_of`.
private let recordedNow = WireTime.date("2026-09-27T03:21:35.215Z")!

@MainActor
private func activityModel(_ console: any ConsoleCallTransport) -> (ActivityModel, ConsoleSession) {
    let session = ConsoleSession(transport: console, management: nil)
    return (ActivityModel(session: session, timeZone: utc, now: { recordedNow }), session)
}

@MainActor
private func fixtureModel() async throws -> (ActivityModel, FixtureConsole, ConsoleSession) {
    let console = try FixtureConsole.recorded()
    let (model, session) = activityModel(console)
    await model.load()
    #expect(model.rows.count == 39, "the recorded feed")
    return (model, console, session)
}

private func query(_ path: String) -> [String: String] {
    var out: [String: String] = [:]
    for item in URLComponents(string: "http://x\(path)")?.queryItems ?? [] { out[item.name] = item.value }
    return out
}

private func feedRow(_ ts: String, _ kind: String, actor: String? = "console", subject: String? = "subject", detail: String? = "detail", ref: String? = nil, turnID: String? = nil, ok: Bool? = nil, group: String? = nil) -> ActivityFeedRow {
    ActivityFeedRow(ts: ts, kind: kind, group: group, actor: actor, subject: subject, detail: detail, ref: ref ?? "runs:\(abs(ts.hashValue % 10_000))", turnID: turnID, ok: ok)
}

private func run(id: Int, kind: String, toolCallsTotal: Int = 0, meta: [String: JSONValue] = [:]) -> JSONValue {
    .object([
        "run": .object([
            "id": .string(String(id)), "ts": .string("2026-09-27T03:10:00.000Z"), "component": .string("assistant"), "kind": .string(kind),
            "ok": .bool(true), "model": .string("gemma"), "meta": .object(meta),
            "tool_calls": .array([]), "tool_calls_total": .number(Double(toolCallsTotal)), "tool_calls_failed": .number(0),
        ]),
        "as_of": .string("2026-09-27T03:19:35.215Z"),
    ])
}

private extension ActivityModel {
    /// The `since` the scripted console was last asked with.
    func feedCallsSince(_ console: ActivityConsole) -> String? { console.feedCalls.last?["since"] }
}

/// The shell's shape, as small as it gets: a sidebar and a detail that is the
/// screen under test once `shown` is set. Shared with Needs You's and Today's
/// tests, as `MinimumProbe` is.
@MainActor
@Observable
final class ShellProbe {
    var shown = false
}

struct ShellProbeView<Screen: View>: View {
    let probe: ShellProbe
    @ViewBuilder let screen: () -> Screen

    var body: some View {
        NavigationSplitView {
            List { ForEach(["Today", "Chat", "Activity", "Knowledge", "Agents", "Scheduled"], id: \.self) { Text(verbatim: $0) } }
        } detail: {
            if probe.shown {
                screen()
            } else {
                Text(verbatim: "Elsewhere")
            }
        }
    }
}

extension ShellProbe {
    /// Mounts `screen` in the shell's shape in a 980 × 640 window, switches to
    /// it, and answers the window's frame and minimum on either side.
    static func acrossTheSwitch<Screen: View>(@ViewBuilder to screen: @escaping () -> Screen) async throws -> (before: (frame: NSRect, minimum: NSSize), after: (frame: NSRect, minimum: NSSize)) {
        let probe = ShellProbe()
        let host = NSHostingView(rootView: ShellProbeView(probe: probe, screen: screen))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 980, height: 640), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.orderFront(nil)
        defer { window.orderOut(nil); window.close() }
        try await Task.sleep(for: .milliseconds(300))
        let before = (frame: window.frame, minimum: window.contentMinSize)
        probe.shown = true
        try await Task.sleep(for: .milliseconds(500))
        return (before, (frame: window.frame, minimum: window.contentMinSize))
    }
}

/// What a view answers when asked for no size at all — the question a
/// hosting view asks to set its window's minimum.
@MainActor
final class MinimumProbe {
    private final class Box: @unchecked Sendable { var size: CGSize? }

    private struct Measure: Layout {
        let box: Box
        func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
            if box.size == nil { box.size = subviews.first?.sizeThatFits(.zero) }
            return subviews.first?.sizeThatFits(proposal) ?? .zero
        }
        func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
            subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(bounds.size))
        }
    }

    func minimum<V: View>(of view: V) -> CGSize {
        let box = Box()
        let host = NSHostingView(rootView: Measure(box: box) { view })
        host.frame = NSRect(x: 0, y: 0, width: 900, height: 700)
        host.layoutSubtreeIfNeeded()
        return box.size ?? .zero
    }
}

/// A console that serves the rows it holds the way `activity_feed` does —
/// `since` inclusive, `kind` by kind or group, `turn_id` — plus the runs and
/// pages a test gives it; everything else from the recorded fixtures.
private final class ActivityConsole: ConsoleCallTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _rows: [ActivityFeedRow]
    private var _calls: [FixtureCall] = []
    private var _down: String?
    private var _runs: [Int: JSONValue] = [:]
    private var _pages: [String: String] = [:]
    private var _failTurn = false
    private let fallback = try? FixtureConsole.recorded()

    init(rows: [ActivityFeedRow]) { _rows = rows }

    var rows: [ActivityFeedRow] { get { lock.withLock { _rows } } set { lock.withLock { _rows = newValue } } }
    var calls: [FixtureCall] { lock.withLock { _calls } }
    var down: String? { get { lock.withLock { _down } } set { lock.withLock { _down = newValue } } }
    var runs: [Int: JSONValue] { get { lock.withLock { _runs } } set { lock.withLock { _runs = newValue } } }
    var pages: [String: String] { get { lock.withLock { _pages } } set { lock.withLock { _pages = newValue } } }
    var failTurn: Bool { get { lock.withLock { _failTurn } } set { lock.withLock { _failTurn = newValue } } }
    var feedCalls: [[String: String]] { calls.filter { $0.path.hasPrefix("/api/q/activity_feed") }.map { query($0.path) } }

    func call(_ method: String, _ path: String, body: Data?, idempotencyKey: String?) async -> Result<Data, ConsoleError> {
        let scripted: Result<Data, ConsoleError>? = lock.withLock {
            _calls.append(FixtureCall(method: method, path: path, body: nil, idempotencyKey: idempotencyKey, lastEventID: nil, servedBy: nil))
            if let down = _down { return .failure(.transport(down)) }
            let bare = String(path.split(separator: "?").first ?? "")
            let q = query(path)
            if bare == "/api/q/activity_feed" {
                if q["turn_id"] != nil, _failTurn { return .failure(.http(status: 500, envelope: ConsoleErrorEnvelope(code: "internal", message: "query failed"))) }
                let rows = _rows.filter { row in
                    (q["since"].map { row.ts >= $0 } ?? true)
                        && (q["kind"].map { row.kind == $0 || row.group == $0 } ?? true)
                        && (q["turn_id"].map { row.turnID == $0 } ?? true)
                }.sorted { $0.ts > $1.ts }
                return .success(try! JSONEncoder().encode(ActivityFeed(rows: rows, asOf: "2026-09-27T03:19:35.215Z")))
            }
            if bare.hasPrefix("/api/runs/"), let id = Int(bare.dropFirst("/api/runs/".count)), let run = _runs[id] {
                return .success(try! JSONEncoder().encode(run))
            }
            if bare == "/api/knowledge/page", let p = q["path"], let content = _pages[p] {
                return .success(try! JSONEncoder().encode(JSONValue.object(["path": .string(p), "content": .string(content)])))
            }
            return nil
        }
        if let scripted { return scripted }
        guard let fallback else { return .failure(.transport("no fixtures")) }
        return await fallback.call(method, path, body: body, idempotencyKey: idempotencyKey)
    }
}
#endif

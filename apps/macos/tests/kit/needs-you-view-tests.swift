// Needs You: the list (T5-4a). Built against the recorded fixtures first —
// `GET /api/proposals` as the console serves it, `request` reading and all —
// and a scripted console where the fixture cannot say it (a partial batch, a
// queue of 120, a console that stops answering).
//
// The ticket's two bold tests are the first two: **bulk never offers
// Approve**, and **decisions disabled while unreachable**. Then the partial
// band, the page cap, the grouping and filters, the words, and §2.18. macOS
// only, as the accessibility probe is (shell-accessibility-tests.swift).

#if os(macOS)
import AppKit
import Foundation
import SwiftUI
import Testing

@testable import MetistryKit

// MARK: - The ticket's two

@MainActor
@Test func bulkNeverOffersApprove() async throws {
    // The closed list itself: three verbs, each one the batch route takes, and
    // no case that could send allow, accept_with_changes or accept_as_work.
    #expect(BulkVerb.allCases.map(\.label) == ["Later", "Skip", "Decline"])
    #expect(BulkVerb.allCases.map { $0.answer(reason: "because").wire } == ["later", "skip", "deny"])
    for verb in BulkVerb.allCases {
        #expect(verb.answer().isBatchable, "\(verb) is not a verb the batch route takes")
        #expect(![RequestAnswer.approve, .approveAsWork].contains(verb.answer()))
    }

    let (model, console, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    model.selectAllOnPage()
    #expect(model.isBulk)
    // what the selection is offered, on screen and in the Item menu
    #expect(model.bulkControls.map(\.label) == ["Later", "Skip", "Decline"])
    let menu = model.itemActions { _ in [.approve: {}, .revise: {}] }
    #expect(Set(menu.keys) == [.later, .decline], "the Item menu for a selection: \(menu.keys)")

    // what the selection sends
    console.reset()
    let outcome = try #require(await model.answerSelection(.decline))
    let sent = try #require(console.calls.first { $0.method == "POST" })
    #expect(sent.path == "/api/proposals/batch")
    #expect(sent.body?["decision"]?.stringValue == "deny", "Decline is deny, always (R15)")
    #expect(outcome.asked.count == 4)

    // and what VoiceOver finds on the bulk panel: the three, and no Approve
    let tree = try await AccessibilityProbe.snapshot(NeedsYouBulkPanel(model: selectedModel(model)).frame(width: 520))
    defer { tree.close() }
    #expect(tree.unlabeledControls.filter { $0.role != "AXTextField" }.isEmpty, "unlabeled: \(tree.unlabeledControls)")
    #expect(textFieldLabels(in: tree.window) == ["Reason for Decline"], "Decline's reason field says what it is")
    let controls = tree.controlNames
    for verb in ["Later, L", "Skip", "Decline, D"] { #expect(controls.contains(verb), "controls: \(controls)") }
    #expect(!controls.contains { $0.hasPrefix("Approve") || $0.hasPrefix("Revise") || $0.hasPrefix("Send") }, "controls: \(controls)")
}

@MainActor
@Test func decisionsDisabledWhileUnreachable() async throws {
    let console = QueueConsole(rows: try recordedRows())
    let (model, session) = queueModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.refresh()
    model.selectAllOnPage()
    #expect(model.allowsDecisions)
    #expect(model.bulkControls.allSatisfy { $0.isEnabled })
    #expect(!model.itemActions().isEmpty)

    // the console stops answering; the next read says so, and the gate hears it
    console.down = "connect ECONNREFUSED 127.0.0.1:8080"
    await model.refresh()
    #expect(!model.allowsDecisions)
    #expect(model.rows.count == 4, "a stale list keeps what it had (P5)")
    #expect(model.staleSince != nil, "…and says when it is from")

    // every verb off, each with the fact under it — the gate's own sentence
    let reason = try #require(model.decisionsUnavailableReason)
    #expect(reason.contains(ReachabilityGate.decisionsNeedTheConnection))
    #expect(model.bulkControls.allSatisfy { $0.disabledBecause == reason })
    // the Item menu's L and D are gone, not merely dimmed-and-live
    #expect(model.itemActions().isEmpty)
    // and a verb that raced the menu sends nothing — not even to the gate
    let before = console.calls.count
    #expect(await model.answerSelection(.decline) == nil)
    #expect(await model.answerSelection(.later) == nil)
    #expect(console.calls.count == before, "sent while unreachable: \(console.calls.suffix(2))")

    // the bulk panel prints the fact
    let tree = try await AccessibilityProbe.snapshot(NeedsYouBulkPanel(model: model).frame(width: 520))
    defer { tree.close() }
    #expect(tree.labels.contains { $0.contains(ReachabilityGate.decisionsNeedTheConnection) }, "labels: \(tree.labels)")

    // Retry on a band is a decision too
    console.down = nil
    await model.refresh()
    console.batch = { ids, _ in ids.map { .init(id: $0, ok: false, reason: nil, message: "the console could not write the row") } }
    model.selectAllOnPage()
    let outcome = try #require(await model.answerSelection(.skip))
    #expect(outcome.retryable.count == 4)
    console.down = "connect ECONNREFUSED 127.0.0.1:8080"
    await model.refresh()
    let retry = try #require(outcome.presentation(disabledBecause: model.decisionsUnavailableReason).controls.first)
    #expect(retry.label == "Retry 4")
    #expect(!retry.isEnabled)
    let sentBefore = console.calls.count
    #expect(await model.retry() == nil)
    #expect(console.calls.count == sentBefore)
}

// MARK: - Partial success is the normal outcome (§3.1)

@MainActor
@Test func aPartialBatchIsABandAndKeepsExactlyTheRowsStillPendingSelected() async throws {
    let console = QueueConsole(rows: try recordedRows())
    let (model, session) = queueModel(console)
    defer { withExtendedLifetime(session) {} }
    var heard: [String] = []
    model.announce = { heard.append($0) }
    var counted = 0
    model.onQueueChanged = { counted += 1 }
    await model.refresh()
    model.selection = [1, 2, 3] // the question with three parts (5) stays out of it
    model.declineReason = "  not this week  "

    // 3 applied, 2 answered on the phone first, 1 refused and still pending
    console.batch = { ids, _ in
        [.init(id: ids[0], ok: true), .init(id: ids[1], ok: false, reason: "already_decided", message: "already decided"),
         .init(id: ids[2], ok: false, reason: nil, message: "the revoke failed: registry busy")]
    }
    console.keepPending = [1]
    let outcome = try #require(await model.answerSelection(.decline))

    let body = try #require(console.calls.last { $0.method == "POST" }?.body)
    #expect(body["feedback"]?.stringValue == "not this week", "one reason, given once")
    #expect(outcome.applied == [3])
    #expect(outcome.elsewhere == [2])
    #expect(outcome.retryable == [1])
    #expect(model.selection == [1], "the unapplied row keeps its selection")
    #expect(model.outcome == outcome)
    #expect(model.declineReason.isEmpty)

    let band = outcome.presentation()
    #expect(band.headline.text == "1 of 3 declined.")
    #expect(band.headline.glyph == .degraded, "the colour sits on the glyph")
    #expect(band.headline.ink == .textPrimary, "…and the words stay text-primary")
    #expect(band.lines.map(\.text) == [
        "One was answered somewhere else while this was open.",
        "One couldn't be declined: the revoke failed: registry busy",
        "It is still selected — nothing was lost and nothing was re-sent.",
    ])
    #expect(band.controls.map(\.label) == ["Retry 1", "Dismiss"])
    #expect(heard == [band.spoken], "announced once")
    #expect(counted == 1, "the shell's count is asked again")

    // Retry acts on exactly it
    console.batch = nil
    console.keepPending = []
    let again = try #require(await model.retry())
    let retried = try #require(console.calls.last { $0.method == "POST" }?.body)
    #expect(retried["ids"]?.arrayValue?.compactMap(\.intValue) == [1])
    #expect(retried["decision"]?.stringValue == "deny")
    #expect(again.isComplete)
    #expect(retried["feedback"]?.stringValue == "not this week", "Retry re-sends the same answer, reason and all")
    #expect(again.presentation().headline.text == "1 declined.")
    model.dismissOutcome()
    #expect(model.outcome == nil)
}

@MainActor
@Test func aLaterThatWentThroughLeavesNoReceiptAndABatchThatFailedSaysNothingWasDone() async throws {
    let console = QueueConsole(rows: try recordedRows())
    let (model, session) = queueModel(console)
    defer { withExtendedLifetime(session) {} }
    model.announce = { _ in }
    await model.refresh()
    model.selection = [1, 2]
    let later = try #require(await model.answerSelection(.later))
    #expect(later.isComplete)
    #expect(model.outcome == nil, "Later settled nothing (components-01 §2.5)")
    #expect(model.rows.map(\.id) == [3, 5])

    console.failBatch = .http(status: 500, envelope: ConsoleErrorEnvelope(code: "internal", message: "database unavailable"))
    console.rows = try recordedRows()
    await model.refresh()
    model.selection = [2, 3]
    let failed = try #require(await model.answerSelection(.skip))
    #expect(failed.applied.isEmpty)
    #expect(failed.retryable == [3, 2])
    #expect(model.selection == [2, 3])
    let band = failed.presentation()
    #expect(band.headline.text == "Nothing was skipped.")
    #expect(band.headline.glyph == .failed)
    #expect(band.controls.first?.label == "Retry 2")
}

// MARK: - A page is at most 100

@MainActor
@Test func selectAllMeansThisPageAndNeverMoreThanTheBatchTakes() async throws {
    let rows = (1...120).map { i in
        row(id: i, ts: "2026-09-27T01:\(String(format: "%02d", i % 60)):00.000Z", type: "note", word: "note", title: "Note \(i)")
    }
    let console = QueueConsole(rows: rows)
    let (model, session) = queueModel(console)
    defer { withExtendedLifetime(session) {} }
    model.announce = { _ in }
    await model.refresh()
    #expect(model.rows.count == 120)
    model.selectAllOnPage()
    #expect(model.selection.count == NeedsYouModel.pageLimit)
    // even a selection made some other way is answered a page at a time
    model.selection = Set(1...120)
    #expect(model.bulkIDs.count == 100)
    _ = await model.answerSelection(.skip)
    let body = try #require(console.calls.last { $0.method == "POST" }?.body)
    #expect(body["ids"]?.arrayValue?.count == 100)
}

// MARK: - The list: words, grouping, order, filters

@MainActor
@Test func eachRowReadsTheConsolesWordNeverTheStoredKind() async throws {
    let (model, _, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    let rows = model.rowModels(assistantName: "Aide")
    // the fixture: a report, a `knowledge` row, two `decision` rows — newest first
    #expect(rows.map(\.id) == [3, 2, 1, 5])
    #expect(rows.map(\.word) == ["report", "note", "question", "question"])
    #expect(!rows.contains { $0.word == "knowledge" || $0.word == "decision" })
    #expect(rows.map(\.title) == ["Nightly fold finished", "Add the store list to the roadmap", "Which fixture format?", "Three things before I open the fixtures PR"])
    #expect(rows[1].spoken == "from Aide: note, Add the store list to the roadmap. 5 minutes old.")
    #expect(rows[1].presentation().word.uppercase, "the type label is the small all-caps style")
    // with the name not known yet, it is left out — never "assistant"
    let unnamed = model.rowModels(assistantName: nil)
    #expect(unnamed[1].spoken == "note, Add the store list to the roadmap. 5 minutes old.")
    #expect(unnamed.allSatisfy { $0.chip == nil })
    #expect(!unnamed.contains { $0.spoken.localizedCaseInsensitiveContains("assistant") })
}

@MainActor
@Test func rowsAreGroupedTodayAndEarlierNewestFirst() async throws {
    let rows = [
        row(id: 7, ts: "2026-09-27T02:30:00.000Z", type: "question", word: "question", title: "Which pane?"),
        row(id: 6, ts: "2026-09-27T00:10:00.000Z", type: "access", word: "access", title: "Read Areas/Finance", agent: "drey-dev", trust: "external"),
        row(id: 5, ts: "2026-09-26T21:00:00.000Z", type: "report", word: "report", title: "Inbox Triage didn't run"),
        row(id: 4, ts: "2026-09-24T09:00:00.000Z", type: "task", word: "task", title: "Migrate the backup job", agent: "linear-sync",
            source: ["kind": "linear", "external_ref": "LIN-41", "person": "Jim"]),
    ]
    let (model, session) = queueModel(QueueConsole(rows: rows))
    defer { withExtendedLifetime(session) {} }
    await model.refresh()
    let groups = model.groups(assistantName: "Aide")
    #expect(groups.map(\.title) == ["Today · 2", "Earlier · 2"])
    #expect(groups.map { $0.rows.map(\.id) } == [[7, 6], [5, 4]])
    #expect(groups[0].rows.map(\.age) == ["7m", "2h"])
    #expect(groups[1].rows.map(\.age) == ["5h", "2d"])
    // an agent's row, its provenance neutral; a mirror's, its source and person
    let access = groups[0].rows[1]
    #expect(access.spoken == "from agent drey-dev, external: access, Read Areas/Finance. 2 hours old.")
    let chips = access.presentation().chips
    #expect(chips.map(\.text) == ["drey-dev", "external"])
    #expect(chips[1].ink == .textSecondary && chips[1].plate == .sunken, "external is a grey chip, not the warning tint (C22)")
    let task = groups[1].rows[1]
    #expect(task.spoken == "from Linear, Jim: task, Migrate the backup job. 2 days old.")
    #expect(task.presentation().chips.map(\.text) == ["Linear", "Jim"])
    // the first row is selected for the detail
    #expect(model.selection == [7])
}

@MainActor
@Test func filtersShowOnlyWhatIsPresentAndTheSelectionFollowsThem() async throws {
    let rows = [
        row(id: 9, ts: "2026-09-27T02:30:00.000Z", type: "question", word: "question", title: "A"),
        row(id: 8, ts: "2026-09-27T02:20:00.000Z", type: "pull_request", word: "pull request", title: "B", agent: "drey-dev"),
        row(id: 7, ts: "2026-09-27T02:10:00.000Z", type: "pull_request", word: "pull request", title: "C", agent: "github-state",
            source: ["kind": "github", "external_ref": "gh:o/r#41", "person": "jim"]),
        row(id: 6, ts: "2026-09-27T02:00:00.000Z", type: "access", word: "access", title: "D", agent: "drey-dev"),
    ]
    let console = QueueConsole(rows: rows)
    let (model, session) = queueModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.refresh()

    let chips = model.typeChips
    #expect(chips.map(\.label) == ["All", "Pull Requests", "Questions", "Access"], "most first, then as they came")
    #expect(chips.map(\.count) == [4, 2, 1, 1])
    #expect(model.fromOptions(assistantName: "Aide").map(\.label) == ["Everyone", "Aide", "Agents", "GitHub"])
    #expect(model.fromOptions(assistantName: nil).map(\.label) == ["Everyone", "Agents", "GitHub"], "no name, no bucket — its rows stay under Everyone")

    model.selection = [9, 8, 6]
    model.filter(type: "pull_request")
    #expect(model.visibleRows.map(\.id) == [8, 7])
    #expect(model.selection == [8], "a selection never holds a row the list no longer shows")
    model.filter(from: .source("github"))
    #expect(model.visibleRows.map(\.id) == [7])
    #expect(model.selection == [7])
    model.filter(type: nil)
    model.filter(from: .agents)
    #expect(model.visibleRows.map(\.id) == [8, 6])

    // a filter whose last row left goes back to all
    console.rows = [rows[0]]
    await model.refresh()
    #expect(model.fromFilter == nil)
    #expect(model.visibleRows.map(\.id) == [9])
}

@MainActor
@Test func theRowThatTakesAnAnsweredOnesPlaceIsSelectedNext() async throws {
    let rows = (1...4).reversed().map { row(id: $0, ts: "2026-09-27T02:0\($0):00.000Z", type: "note", word: "note", title: "N\($0)") }
    let console = QueueConsole(rows: rows)
    let (model, session) = queueModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.refresh()
    #expect(model.visibleRows.map(\.id) == [4, 3, 2, 1])
    model.selection = [3]
    await model.refresh()
    // answered elsewhere: it leaves, and the next one down is selected
    console.rows.removeAll { $0["id"]?.stringValue == "3" }
    await model.refresh()
    #expect(model.selection == [2])
    // an Esc'd selection is left alone
    model.clearSelection()
    await model.refresh()
    #expect(model.selection.isEmpty)
}

@MainActor
@Test func landingOnARequestSelectsItAndClearsAFilterThatHidesIt() async throws {
    let (model, _, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    model.filter(type: "note")
    #expect(model.visibleRows.map(\.id) == [2])
    model.focus(on: 1)
    #expect(model.typeFilter == nil)
    #expect(model.selectedRow?.id == 1)
    #expect(!model.isBulk)
}

@MainActor
@Test func anInstanceSwitchDropsTheSelectionTheFiltersAndTheBand() async throws {
    let (model, _, session) = try await fixtureModel()
    model.filter(type: "note")
    model.selection = [2]
    model.declineReason = "x"
    session.adopt(transport: try FixtureConsole.recorded(), management: nil)
    #expect(model.typeFilter == nil)
    #expect(model.selection.isEmpty)
    #expect(model.declineReason.isEmpty)
    #expect(model.outcome == nil)
    #expect(model.queue.section.value == nil)
}

@MainActor
@Test func nothingWaitingIsTheQueueSayingSoOrBeforeItHasTheCount() async throws {
    let console = QueueConsole(rows: [])
    let (model, session) = queueModel(console)
    defer { withExtendedLifetime(session) {} }
    #expect(model.isEmpty(waiting: 0))
    #expect(!model.isEmpty(waiting: 3), "before the queue answers, the count decides")
    #expect(!model.isEmpty(waiting: nil))
    await model.refresh()
    #expect(model.isEmpty(waiting: 3), "the queue answered: nothing waits, whatever the count last said")
}

// 0.14.1, as Activity's: the window's minimum is SwiftUI's answer for the
// whole window at no size at all, and Needs You answered with its content's
// at no width — 878–1,078 pt — so opening it grew the window, or slid the
// sidebar's rows off the top of one that could not grow. Its minimum is the
// shell's, in every panel.
@MainActor
@Test func openingNeedsYouNeverRaisesTheWindowsMinimum() async throws {
    let (model, _, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    func screen(_ model: NeedsYouModel, waiting: Int?) -> some View {
        NeedsYouView(model: model, waiting: waiting, assistantName: "Aide", onGoToToday: {}) { row in
            ScrollView { NeedsYouRequestSummary(row, assistantName: "Aide", consoleURL: nil, now: fixtureNow, calendar: model.calendar) }
        }
    }

    let window = try await ShellProbe.acrossTheSwitch { screen(model, waiting: 4) }
    #expect(window.after.minimum.height <= max(window.before.minimum.height, 460), "opening Needs You raised the window's minimum to \(window.after.minimum)")
    #expect(window.after.frame == window.before.frame, "the window moved: \(window.before.frame) → \(window.after.frame)")

    // every panel: waiting, the list, one request, several, failed, nothing waiting
    let down = QueueConsole(rows: [])
    down.down = "connect ECONNREFUSED 127.0.0.1:1"
    let (failed, failedSession) = queueModel(down)
    let (empty, emptySession) = queueModel(QueueConsole(rows: []))
    let (waiting, waitingSession) = queueModel(QueueConsole(rows: try recordedRows()))
    defer { withExtendedLifetime([failedSession, emptySession, waitingSession]) {} }
    await failed.refresh()
    await empty.refresh()
    let probe = MinimumProbe()
    var sizes = [
        ("waiting", probe.minimum(of: screen(waiting, waiting: 4))),
        ("list", probe.minimum(of: screen(model, waiting: 4))),
        ("failed", probe.minimum(of: screen(failed, waiting: 4))),
        ("nothing waiting", probe.minimum(of: screen(empty, waiting: 0))),
    ]
    model.selection = [model.rows[0].id]
    sizes.append(("one", probe.minimum(of: screen(model, waiting: 4))))
    model.selection = [model.rows[0].id, model.rows[1].id]
    sizes.append(("several", probe.minimum(of: screen(model, waiting: 4))))
    for (name, size) in sizes {
        #expect(size.height <= 460, "\(name) asks for \(size) at the least")
    }
}

// MARK: - Glyphs and words

@Test func aTypesGlyphIsNeverOneAComponentAlreadyGivesAMeaning() {
    let taken = Set(MetistryGlyph.allCases.flatMap { [$0.rawValue, $0.selectedName] })
        .union(ShellSection.allCases.map(\.symbolName))
        .union([Destination.needsYou, .board, .projects, .artifacts].map(\.symbolName))
    let used = Array(NeedsYouTypeGlyph.symbols.values) + [NeedsYouTypeGlyph.other]
    #expect(Set(used).count == used.count, "two types share a glyph")
    for symbol in used { #expect(!taken.contains(symbol), "\(symbol) already means something else (amendments §8.3)") }
    #expect(NeedsYouTypeGlyph.symbols.count == 12, "the twelve types")
}

@Test func aFilterReadsTheConsolesWordPluralised() {
    #expect(NeedsYouTypeChip.label(for: "pull request") == "Pull Requests")
    #expect(NeedsYouTypeChip.label(for: "access") == "Access")
    #expect(NeedsYouTypeChip.label(for: "question") == "Questions")
    #expect(NeedsYouSources.name("github") == "GitHub")
    #expect(NeedsYouSources.name("jira") == "jira", "a source this build does not know is printed as the wire spells it")
}

@Test func noStringInTheListsSourceSaysAssistantOrNamesOne() throws {
    let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("sources/kit/needs-you-view.swift")
    let text = try String(contentsOf: file, encoding: .utf8)
    var literals: [String] = []
    for line in text.split(separator: "\n") where !line.trimmingCharacters(in: .whitespaces).hasPrefix("//") {
        let parts = line.split(separator: "\"", omittingEmptySubsequences: false)
        literals += stride(from: 1, to: parts.count, by: 2).map { String(parts[$0]) }
    }
    #expect(literals.count > 20, "the scan found almost nothing")
    // §2.18.4: nothing in the list moves, so Reduce Motion has nothing to stop
    #expect(!text.contains("withAnimation") && !text.contains(".animation(") && !text.contains(".transition("))
    for literal in literals {
        #expect(!literal.localizedCaseInsensitiveContains("assistant"), "\"\(literal)\"")
        #expect(literal.range(of: #"\bMetis\b"#, options: .regularExpression) == nil, "\"\(literal)\"")
    }
}

@MainActor
@Test func everyInkInTheListClearsItsGroundInBothSchemes() async throws {
    let (model, _, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    var presentations: [Any] = model.rowModels(assistantName: "Aide").map { $0.presentation() }
    let partial = BulkOutcome(verb: .decline, asked: [1, 2, 3], result: .success(batch([(1, true, nil), (2, false, "already_decided"), (3, false, nil)])), stillPending: [3])
    presentations.append(partial.presentation())
    presentations.append(partial.presentation(disabledBecause: StateWords.unreachable))
    presentations.append(BulkOutcome(verb: .skip, asked: [1], result: .failure(.transport("gone")), stillPending: [1]).presentation())
    for presentation in presentations {
        for mark in collect(presentation).marks {
            for scheme in [ColorScheme.light, .dark] {
                let floor = mark.text.isEmpty ? 3.0 : 4.5
                let ratio = Contrast.ratio(mark.ink, mark.ground, scheme)
                #expect(ratio >= floor, "\(mark.ink.rawValue) on \(mark.ground.rawValue) is \(ratio) in \(scheme) — \(mark.text)")
                if let glyphInk = mark.glyphInk, mark.glyph != nil {
                    #expect(Contrast.ratio(glyphInk, mark.ground, scheme) >= 3, "glyph \(glyphInk.rawValue) on \(mark.ground.rawValue)")
                }
            }
        }
    }
}

// MARK: - §2.18: VoiceOver, the largest text

@MainActor
@Test func theListSpeaksEveryRowAndEveryControl() async throws {
    let (model, _, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    let view = NeedsYouView(model: model, waiting: 4, assistantName: "Aide", onGoToToday: {}) { row in
        NeedsYouRequestSummary(row, assistantName: "Aide", consoleURL: URL(string: "http://127.0.0.1:1/"), now: fixtureNow, calendar: model.calendar)
    }
    let tree = try await AccessibilityProbe.snapshot(view.frame(width: 1000, height: 640))
    defer { tree.close() }
    #expect(tree.unlabeledControls.isEmpty, "unlabeled: \(tree.unlabeledControls)")
    #expect(tree.saysAssistant.isEmpty, "says assistant: \(tree.saysAssistant)")
    let said = tree.labels + tree.texts
    #expect(said.contains("from Aide: note, Add the store list to the roadmap. 5 minutes old."), "said: \(said)")
    #expect(said.contains("from Aide: question, Which fixture format?. 5 minutes old."), "said: \(said)")
    // the filters say what they are and how many
    let controls = tree.controlNames
    #expect(controls.contains("All, 4"), "controls: \(controls)")
    #expect(controls.contains("Reports, 1"), "controls: \(controls)")
    #expect(controls.contains("Select All on This Page"), "controls: \(controls)")
    // the group is a heading, and the selected request is beside the list
    #expect(tree.labels.contains("TODAY · 4"), "labels: \(tree.labels)")
    #expect(tree.labels.contains("Nightly fold finished"), "labels: \(tree.labels)")
}

@MainActor
@Test func theListGrowsLongerNeverWiderAtTheLargestText() async throws {
    let (model, _, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    let row = try #require(model.rowModels(assistantName: "Aide").first { $0.id == 2 })
    let partial = BulkOutcome(verb: .decline, asked: [1, 2, 3], result: .success(batch([(1, true, nil), (2, false, "already_decided"), (3, false, nil)])), stillPending: [3])
    let pieces: [(String, AnyView, CGFloat)] = [
        ("row", AnyView(NeedsYouRowView(row.presentation())), 340),
        ("band", AnyView(NeedsYouOutcomeBand(outcome: partial, disabledBecause: nil, onRetry: {}, onDismiss: {})), 640),
        ("summary", AnyView(NeedsYouRequestSummary(model.rows[1], assistantName: "Aide", consoleURL: nil, now: fixtureNow, calendar: model.calendar).frame(height: 900, alignment: .top)), 560),
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
        if name != "summary" {
            #expect((heights[.accessibility5] ?? 0) > (heights[.large] ?? 0), "\(name) did not grow at the largest text")
        }
    }
}

// MARK: - Helpers

private let utc = TimeZone(identifier: "UTC")!
/// The clock the scripted queues are read at.
private let recordedNow = WireTime.date("2026-09-27T02:37:12.911Z")!
/// Five minutes after the recorded queue's newest rows were raised — read from
/// the fixture, since every recording raises them at its own wall clock (X-29).
private let fixtureNow: Date = {
    let rows = (try? ConsoleFixture.load("get-api-proposals"))?.replyJSON?["proposals"]?.arrayValue ?? []
    let newest = rows.compactMap { $0["ts"]?.stringValue.flatMap(WireTime.date) }.max()
    return newest!.addingTimeInterval(5 * 60)
}()

/// What every text field in a window says it is. The probe reads AppKit's
/// attribute form, where a SwiftUI text field's label does not appear (its
/// cell answers `accessibilityLabel()` instead — which is what VoiceOver
/// reads), so a text field is held to its label here rather than there.
@MainActor
private func textFieldLabels(in window: NSWindow) -> [String] {
    func fields(_ view: NSView) -> [NSTextField] {
        ((view as? NSTextField).map { $0.isEditable ? [$0] : [] } ?? []) + view.subviews.flatMap(fields)
    }
    return (window.contentView.map(fields) ?? []).map { $0.cell?.accessibilityLabel() ?? $0.accessibilityLabel() ?? "" }
}

/// A model over a scripted console. The session is the caller's to keep: the
/// model holds it weakly, as the app's `AppModel` owns it.
@MainActor
private func queueModel(_ console: any ConsoleCallTransport, now: Date = recordedNow) -> (NeedsYouModel, ConsoleSession) {
    let session = ConsoleSession(transport: console, management: nil)
    let model = NeedsYouModel(session: session, timeZone: utc, now: { now })
    model.announce = { _ in }
    return (model, session)
}

/// The recorded queue, over a session: the model as the app holds it.
@MainActor
private func fixtureModel() async throws -> (NeedsYouModel, FixtureConsole, ConsoleSession) {
    let console = try FixtureConsole.recorded()
    let (model, session) = queueModel(console, now: fixtureNow)
    await model.refresh()
    #expect(model.rows.count == 4, "the recorded queue")
    return (model, console, session)
}

/// A fresh model over the same recorded queue with two rows selected, for a view.
@MainActor
private func selectedModel(_ model: NeedsYouModel) -> NeedsYouModel {
    model.selection = [1, 2]
    return model
}

/// The recorded `GET /api/proposals` rows, as the console served them.
private func recordedRows() throws -> [JSONValue] {
    try #require(ConsoleFixture.load("get-api-proposals").replyJSON?["proposals"]?.arrayValue)
}

private func row(id: Int, ts: String, type: String, word: String, title: String, agent: String = "assistant", trust: String = "internal", source: [String: String]? = nil) -> JSONValue {
    var object: [String: JSONValue] = [
        "id": .string(String(id)), "ts": .string(ts), "kind": .string(type), "source_agent": .string(agent), "trust": .string(trust),
        "payload": .object(["title": .string(title)]), "decision": .string("pending"), "decided_at": .null, "work_id": .null, "snoozed_until": .null,
        "request": .object(["type": .string(type), "word": .string(word), "body": .string("preview"), "grouped": .bool(false), "decisions": .array([])]),
    ]
    if let source { object["source"] = .object(source.mapValues(JSONValue.string)) }
    return .object(object)
}

private func batch(_ rows: [(Int, Bool, String?)]) -> RequestBatchResult {
    let json = rows.map { id, ok, reason -> [String: Any] in
        var r: [String: Any] = ["id": id, "ok": ok]
        if let reason { r["reason"] = reason }
        if !ok { r["error"] = ["code": "conflict", "message": reason ?? "refused"] }
        return r
    }
    let data = try! JSONSerialization.data(withJSONObject: ["results": json])
    return try! JSONDecoder().decode(RequestBatchResult.self, from: data)
}

/// A console that serves a queue it holds, answers a batch the way the route
/// does (or as a test scripts it), and can stop answering.
private final class QueueConsole: ConsoleCallTransport, @unchecked Sendable {
    struct BatchRow {
        let id: Int
        let ok: Bool
        var reason: String?
        var message: String?
    }

    private let lock = NSLock()
    private var _rows: [JSONValue]
    private var _calls: [FixtureCall] = []
    private var _down: String?
    private var _batch: (@Sendable ([Int], String) -> [BatchRow])?
    private var _keepPending: Set<Int> = []
    private var _failBatch: ConsoleError?

    init(rows: [JSONValue]) { _rows = rows }

    var rows: [JSONValue] { get { lock.withLock { _rows } } set { lock.withLock { _rows = newValue } } }
    var calls: [FixtureCall] { lock.withLock { _calls } }
    /// Set: every request fails as a connection that is not there.
    var down: String? { get { lock.withLock { _down } } set { lock.withLock { _down = newValue } } }
    /// Set: the batch's per-row results, instead of every row applied.
    var batch: (@Sendable ([Int], String) -> [BatchRow])? { get { lock.withLock { _batch } } set { lock.withLock { _batch = newValue } } }
    /// Rows a refused answer leaves pending.
    var keepPending: Set<Int> { get { lock.withLock { _keepPending } } set { lock.withLock { _keepPending = newValue } } }
    /// Set: the batch request itself fails.
    var failBatch: ConsoleError? { get { lock.withLock { _failBatch } } set { lock.withLock { _failBatch = newValue } } }

    func call(_ method: String, _ path: String, body: Data?, idempotencyKey: String?) async -> Result<Data, ConsoleError> {
        let sent = body.flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) }
        return lock.withLock {
            _calls.append(FixtureCall(method: method, path: path, body: sent, idempotencyKey: idempotencyKey, lastEventID: nil, servedBy: nil))
            if let down = _down { return .failure(.transport(down)) }
            let route = "\(method) \(path.split(separator: "?").first ?? "")"
            switch route {
            case "GET /api/proposals":
                return .success(encode(["proposals": .array(_rows), "cursor": .string("c"), "more": .bool(false)]))
            case "POST /api/proposals/batch":
                if let failure = _failBatch { return .failure(failure) }
                let ids = sent?["ids"]?.arrayValue?.compactMap(\.intValue) ?? []
                let decision = sent?["decision"]?.stringValue ?? ""
                let results = _batch?(ids, decision) ?? ids.map { BatchRow(id: $0, ok: true) }
                // what the route does to the queue: an applied row leaves it, and so
                // does one somebody else answered first; a refused one stays
                let leaving = Set(results.filter { $0.ok || $0.reason == "already_decided" }.map(\.id)).subtracting(_keepPending)
                _rows.removeAll { leaving.contains($0["id"]?.stringValue.flatMap { Int($0) } ?? $0["id"]?.intValue ?? -1) }
                let json: [JSONValue] = results.map { r in
                    var o: [String: JSONValue] = ["id": .number(Double(r.id)), "ok": .bool(r.ok)]
                    if let reason = r.reason { o["reason"] = .string(reason) }
                    if !r.ok { o["error"] = .object(["code": .string("conflict"), "message": .string(r.message ?? "refused")]) }
                    return .object(o)
                }
                return .success(encode(["results": .array(json)]))
            case "GET /api/needs-you/count":
                return .success(encode(["waiting": .number(Double(_rows.count)), "oldest_ts": .null]))
            default:
                return .failure(.http(status: 404, envelope: ConsoleErrorEnvelope(code: "not_found", message: "no script for \(route)")))
            }
        }
    }

    private func encode(_ object: [String: JSONValue]) -> Data {
        (try? JSONEncoder().encode(JSONValue.object(object))) ?? Data()
    }
}
#endif

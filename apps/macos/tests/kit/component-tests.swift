// The shared components' rules, one test each (T5-3). The snapshots
// (component-snapshot-tests.swift) pin what each draws; these pin WHY — the
// rules from the design record that a snapshot would only show by example.

import Foundation
import SwiftUI
import Testing

#if canImport(AppKit)
import AppKit
#endif

@testable import MetistryKit

private let repoRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent()
private let componentsDirectory = repoRoot.appendingPathComponent("apps/macos/sources/kit/components")

private func componentSources() throws -> [(name: String, text: String)] {
    try FileManager.default.contentsOfDirectory(atPath: componentsDirectory.path).sorted().filter { $0.hasSuffix(".swift") }.map {
        ($0, try String(contentsOf: componentsDirectory.appendingPathComponent($0), encoding: .utf8))
    }
}

/// Source lines with the comments stripped — a rule about code is not broken by a comment quoting it.
private func codeLines(_ text: String) -> [String] {
    text.components(separatedBy: "\n").map { line in
        guard let r = line.range(of: "//") else { return line }
        return String(line[..<r.lowerBound])
    }
}

// MARK: - 12-hour times (amendments §8.1, facets §7.5)

private let ny = ClockTime(timeZone: TimeZone(identifier: "America/New_York")!)
private func at(_ iso: String) -> Date { WireTime.date(iso)! }

@Test func clockTimesAreTwelveHourWithTheMeridiem() {
    #expect(ny.time(at("2026-09-28T17:02:00Z")) == "1:02 PM")
    #expect(ny.time(at("2026-09-28T04:00:00Z")) == "12:00 AM")
    #expect(ny.time(at("2026-09-28T16:00:00Z")) == "12:00 PM")
    #expect(ny.time(at("2026-09-28T13:05:00Z")) == "9:05 AM")
}

@Test func aRangeCarriesTheMeridiemOnceWhenBothEndsShareIt() {
    #expect(ny.range(at("2026-09-28T13:30:00Z"), at("2026-09-28T14:00:00Z")) == "9:30–10:00 AM")
    #expect(ny.range(at("2026-09-28T15:30:00Z"), at("2026-09-28T16:30:00Z")) == "11:30 AM–12:30 PM")
}

@Test func aMomentNamesTheDayOnlyWhenItIsNotToday() {
    let now = at("2026-09-28T13:05:00Z")
    #expect(ny.moment(at("2026-09-28T12:14:00Z"), now: now) == "8:14 AM")
    #expect(ny.moment(at("2026-09-27T13:14:00Z"), now: now) == "27 Sep, 9:14 AM")
}

@Test func aDurationSaysItIsOneAndCannotBeReadAsATime() {
    #expect(ClockTime.duration(252) == "4m 12s")
    #expect(ClockTime.duration(7500) == "2h 5m")
    #expect(ClockTime.duration(45) == "45s")
    #expect(ClockTime.duration(3600) == "1h")
    #expect(ClockTime.duration(93_600) == "1d 2h")
    #expect(ClockTime.age(40 * 60) == "40 minutes ago")
    #expect(ClockTime.age(3600) == "1 hour ago")
    #expect(ClockTime.age(2 * 86_400) == "2 days ago")
    #expect(ClockTime.age(20) == "just now")
}

// MARK: - The agent chip and agent prose (C88, C69, C103)

@Test func noChipEverSaysAssistantItSaysTheConfiguredName() async throws {
    let identity = try await ConsoleStores(transport: try FixtureConsole.recorded()).identity().get()
    #expect(identity.name == "Aide", "the fixture's configured name — not the default, so a hardcoded default would show")
    let requests = try await ConsoleStores(transport: try FixtureConsole.recorded()).requests().get().proposals
    #expect(requests.allSatisfy { $0.sourceAgent == AgentChipModel.assistantPrincipal }, "the fixture's requests are the assistant's")
    let chips = requests.map { AgentChipModel(agentID: $0.sourceAgent!, assistantName: identity.name) } + [AgentChipModel.assistant(named: identity.name)]
    for chip in chips {
        #expect(chip.label == "Aide")
        #expect(chip.isAssistant)
        #expect(!chip.spoken.lowercased().contains("assistant"))
    }
    let agent = AgentChipModel(agentID: "cursor", assistantName: identity.name)
    #expect(agent.label == "cursor")
    #expect(agent.spoken == "from agent cursor")
    // A default routine's request (trust internal) says what its row says — the routine's id — never a guess.
    #expect(AgentChipModel(agentID: "plan-tomorrow", assistantName: identity.name).label == "plan-tomorrow")
    // One tinted pill in the agent hue, the id in mono; never accent, never grey; no glyph on its own hue (C73).
    let mark = agent.mark(on: .surface)
    #expect(mark.ink == .agent && mark.plate == .agentQuiet && mark.design == .mono && mark.shape == .chip && mark.glyph == nil)
}

@Test func agentProseTakesTheRuleInATranscriptAndTheWashEverywhereElse() {
    let author = AgentChipModel.assistant(named: "Aide")
    let rule = AgentProseModel(treatment: .rule, author: author, text: "x").presentation(on: .bg, clock: ny)
    let wash = AgentProseModel(treatment: .wash, author: author, text: "x").presentation(on: .surface, clock: ny)
    #expect(rule.rule == .agent && rule.wash == nil && rule.body.on == .bg)
    #expect(wash.wash == .agentQuiet && wash.rule == nil && wash.body.on == .agentQuiet)
    for p in [rule, wash] {
        #expect(p.body.design == .serif, "agent prose is set in the serif (C32)")
        #expect(p.attribution[0].glyph == .spark && p.attribution[0].text == "Aide")
    }
}

@Test func proseIsRateableOnlyWithAnIdAndPressingTheLitRatingClearsIt() {
    let author = AgentChipModel.assistant(named: "Aide")
    #expect(AgentProseModel(treatment: .wash, author: author, text: "x").presentation(on: .surface, clock: ny).controls.isEmpty)
    let rated = AgentProseModel(treatment: .wash, author: author, text: "x", generated: true, proseID: "brief-2026-09-28", rating: .up)
    let p = rated.presentation(on: .surface, clock: ny)
    #expect(p.controls.map(\.spoken) == ["Good", "Bad"])
    #expect(p.controls[0].selected && !p.controls[1].selected)
    #expect(p.attribution.contains { $0.text == AgentProseModel.generatedNote })
    #expect(rated.rating(afterPressing: .up) == nil)
    #expect(rated.rating(afterPressing: .down) == .down)
}

// MARK: - The facet row (facets §2, §7.1, §8.1, §8.2; C134)

private let monday = TaskDay("2026-09-28")!

private func kinds(_ f: TaskFacets) -> [String] {
    FacetRowModel(f, today: monday).presentation().marks.map(\.text)
}

@Test func facetsAreInTheOneOrderAndTheDoDateReadsPlanned() {
    let f = TaskFacets(priority: 2, due: TaskDay("2026-09-30"), planned: TaskDay("2026-09-29"), estimateMinutes: 45, people: ["Dana"], links: [.project("metistry")], states: [.waiting])
    #expect(kinds(f) == ["P2", "Wed", "Planned Tomorrow", "~45m", "Dana", "metistry", "Waiting"])
}

@Test func unsetPriorityRendersNothingAndPriorityIsWeightNeverHue() {
    #expect(kinds(TaskFacets(due: TaskDay("2026-09-28"))) == ["Today"])
    #expect(kinds(TaskFacets(priority: 0)) == [] && kinds(TaskFacets(priority: 5)) == [])
    let marks = (1...4).map { FacetRowModel(TaskFacets(priority: $0), today: monday).presentation().marks[0] }
    #expect(marks.allSatisfy { $0.shape == .badge }, "one shape for all four steps")
    #expect(marks[0].plate == .textPrimary && marks[0].ink == .bg, "P1 is the solid badge")
    #expect(marks.dropFirst().allSatisfy { $0.outline == .borderControl && $0.plate == nil })
    #expect(marks.map(\.ink) == [.bg, .textPrimary, .textSecondary, .textTertiary])
    let stateRoles: Set<MetistryColorRole> = [.failed, .degraded, .ok, .stale, .absent]
    #expect(marks.allSatisfy { !stateRoles.contains($0.ink) }, "priority is never red (C31)")
}

@Test func anOverdueDueEscalatesIntoTheTintedChipAndOnlyTheServerSaysOverdue() {
    let reported = FacetRowModel(TaskFacets(due: TaskDay("2026-09-25"), states: [.overdue]), today: monday).presentation().marks
    #expect(reported.count == 1)
    #expect(reported[0].shape == .chip && reported[0].ink == .degraded && reported[0].glyph == .due)
    // A past date the server did not flag is drawn as a date: P5, state reported and never inferred.
    let unflagged = FacetRowModel(TaskFacets(due: TaskDay("2026-09-25")), today: monday).presentation().marks
    #expect(unflagged[0].shape == .text && unflagged[0].ink == .textSecondary)
}

@Test func atMostThreeChipsAndOneTintTheRestFoldIntoPlusNAndAreStillSpoken() {
    let f = TaskFacets(people: ["Jim Fallon", "Dana"], links: [.note("Lease Renewal"), .work(418)], states: [.failed, .waiting, .stale])
    let p = FacetRowModel(f, today: monday).presentation()
    let chips = p.marks.filter { $0.shape == .chip }
    #expect(chips.count == FacetRowModel.maxChips)
    let tints: Set<MetistryColorRole> = [.failed, .degraded, .stale, .presenceBlocked]
    #expect(chips.filter { tints.contains($0.ink) }.count == 1, "one state tint")
    #expect(chips.contains { $0.text == "Failed" }, "the most serious state is the one that stays")
    #expect(chips.last?.text == "+5")
    for word in ["Jim Fallon", "Dana", "Lease Renewal", "work 418", "failed", "waiting", "stale"] {
        #expect(p.spoken.contains(word), "\(word) is still said")
    }
}

@Test func carriedOverClimbsTheLadderAndIsNeverFailed() {
    func mark(_ days: Int) -> Mark? { FacetRowModel(TaskFacets(states: [.carried(days: days)]), today: monday).presentation().marks.first }
    #expect(mark(1) == nil)
    #expect(mark(2)?.plate == .absentQuiet)
    #expect(mark(3)?.plate == .degradedQuiet && mark(3)?.glyph == nil)
    #expect(mark(5)?.ink == .degraded && mark(5)?.glyph == .degraded)
    #expect((1...30).compactMap(mark).allSatisfy { $0.ink != .failed })
}

@Test func theTodayFixturesTaskReadsItsFacetsFromTheWire() async throws {
    let reply = try await ConsoleStores(transport: try FixtureConsole.recorded()).today(date: nil).get()
    let task = reply["tasks"]!.arrayValue![0]
    let facets = TaskFacets(vaultTask: task)
    #expect(facets.priority == 2)
    #expect(facets.due == TaskDay("2026-09-28"))
    #expect(facets.estimateMinutes == 15, "size s is ~15 minutes")
    #expect(facets.links == [.project("metistry")])
    #expect(kinds(facets) == ["P2", "Today", "~15m", "metistry"])
}

// MARK: - The permissions table (C58; amendments §3; decisions-log ruling (b))

@Test func thePermissionWordsLiveInOnePlace() throws {
    let words = [PermissionWords.allow, PermissionWords.ask, PermissionWords.never]
    #expect(words == ["Allow", "Ask First", "Never"], "the CLI's words (packages/cli/src/agents.ts MODE_LABEL) until the owner rules")
    for (name, text) in try componentSources() where name != "permissions-table.swift" {
        for word in words {
            #expect(!codeLines(text).joined(separator: "\n").contains("\"\(word)\""), "\(name) spells \(word) itself — use PermissionWords")
        }
    }
    #expect(PermissionWords.mode("allow") == "Allow" && PermissionWords.mode("propose") == "Ask First" && PermissionWords.mode("deny") == "Never")
    #expect(PermissionWords.mode("ask") == nil, "an unknown mode is never guessed")
}

@Test func anEffectiveLineIsTheCLIsWordForWord() {
    // The same strings apps/console/test/pwa-reads.test.ts and packages/cli/test/agents.test.ts hold the CLI to.
    #expect(PermissionWords.line(AgentActionEntry(mode: "propose", source: "defaulted", ceiling: "propose"), level: "propose") == "Ask First (default for propose)")
    #expect(PermissionWords.line(AgentActionEntry(mode: "propose", source: "clamped", asked: "allow", ceiling: "propose"), level: "propose") == "Ask First (asked Allow — propose's ceiling is Ask First)")
    #expect(PermissionWords.line(AgentActionEntry(mode: "propose", source: "set", asked: "propose", ceiling: "allow"), level: "act_within_scope") == "Ask First")
}

@Test func absenceIsTheDenialAndBaseAccessCarriesNoMarker() throws {
    let rows = try JSONDecoder().decode([PermissionRow].self, from: Data(drawnPermissionRows.utf8))
    let p = PermissionsTableModel(rows: rows).presentation()
    let knowledge = p.rows[0]
    #expect(knowledge.write.map(\.text) == [PermissionWords.emptyCell])
    #expect(knowledge.write[0].voice == "not granted")
    #expect(knowledge.read.map(\.text) == ["Areas/Ops", "·", "Areas/Finance", "Approved in Needs You · #311"], "base is unmarked; approved is")
    let work = p.rows[1]
    #expect(work.write.last?.glyph == .asksFirst && work.write.last?.glyphAfter == true, "one glyph marks a verb that asks first")
    #expect(work.write.filter { $0.glyph == .asksFirst }.count == 1)
    #expect(p.rows[3].write.map(\.text).contains("during Morning Brief only"))
    #expect(p.rows[4].resource.glyph == .relay, "a connection is reached through Metistry")
    #expect(p.legend.map(\.text).contains(PermissionWords.notGranted))
    #expect(p.legend.contains { $0.text.hasPrefix(PermissionWords.ask) && $0.glyph == .asksFirst })
    #expect(p.controls.isEmpty, "Edit only where the caller can edit")
    #expect(PermissionsTableModel(rows: rows, editable: true).presentation().controls.map(\.label) == ["Edit"])
}

@Test func aProvenanceTheWireAddsLaterReadsAsBaseRatherThanFailing() throws {
    let entry = try JSONDecoder().decode(PermissionEntry.self, from: Data(#"{"key":"k","label":"L","asks":false,"provenance":{"kind":"through_metistry"}}"#.utf8))
    #expect(entry.provenance.marker == nil)
}

// MARK: - The request body blocks (screen 3 §12.2; requests.ts)

@Test func theBodyBlocksAreExactlyCoresClosedSet() throws {
    let source = try String(contentsOf: repoRoot.appendingPathComponent("packages/core/src/requests.ts"), encoding: .utf8)
    let line = try #require(source.components(separatedBy: "\n").first { $0.contains("export const REQUEST_BODIES") })
    let names = line.components(separatedBy: "\"").enumerated().filter { $0.offset % 2 == 1 }.map(\.element)
    #expect(names == RequestBodyKind.allCases.map(\.rawValue))
}

@Test func everyQuestionEndsInSomethingElseAndItsWordsGoInAField() {
    let body = ChoicesBody(prompt: "Which?", options: ["a", "b"], step: 2, of: 3)
    let p = RequestBodyBlock.choices(body).presentation(today: monday, now: Date(), clock: ny)
    #expect(p.controls.map(\.label) == ["a", "b", ChoicesBody.somethingElse])
    #expect(p.controls.map(\.spoken) == ["a. 1 of 3", "b. 2 of 3", "Something else. 3 of 3"])
    #expect(p.heading[0].text == "Question 2 of 3")
    #expect(p.otherField == nil)
    var typing = body
    typing.chosen = [body.somethingElseIndex]
    typing.other = "neither"
    #expect(RequestBodyBlock.choices(typing).presentation(today: monday, now: Date(), clock: ny).otherField == "neither")
    var multi = body
    multi.multi = true
    #expect(RequestBodyBlock.choices(multi).presentation(today: monday, now: Date(), clock: ny).controls.allSatisfy { $0.glyph == .checkbox })
}

@Test func aDiffIsCollapsedToItsCountsUntilOpenedAndNeverColourAlone() {
    let lines = [DiffLine(.context, "a"), DiffLine(.removed, "b"), DiffLine(.added, "c"), DiffLine(.added, "d")]
    let closed = RequestBodyBlock.diff(DiffBody(title: "x.md", lines: lines)).presentation(today: monday, now: Date(), clock: ny)
    #expect(closed.lines.count == 1 && closed.detail.isEmpty)
    #expect(closed.lines[0][0].text == "x.md  +2 −1")
    #expect(closed.controls.map(\.label) == ["Show 4 Lines"])
    let open = RequestBodyBlock.diff(DiffBody(title: "x.md", lines: lines, expanded: true)).presentation(today: monday, now: Date(), clock: ny)
    #expect(open.detail.count == 4)
    #expect(open.detail[1][0].glyph == .removed && open.detail[2][0].glyph == .added, "+ and − carry it in greyscale")
    #expect(open.detail[2][0].glyphInk == .ok && open.detail[1][0].glyphInk == .failed)
}

@Test func beforeAndAfterLeadsWithTheChangeAndMarksWhatIsNew() {
    let body = BeforeAfterBody(heading: "What Approve Does", content: .sets(before: ["A", "B"], after: ["A", "B", "C"], total: "It would then read 3 folders"))
    let closed = RequestBodyBlock.beforeAfter(body).presentation(today: monday, now: Date(), clock: ny)
    #expect(closed.lines.map { $0.map(\.text) } == [["Adds", "C"]])
    #expect(closed.detail.isEmpty)
    var open = body
    open.expanded = true
    let p = RequestBodyBlock.beforeAfter(open).presentation(today: monday, now: Date(), clock: ny)
    #expect(p.detail.map { $0.map(\.text) } == [["A"], ["B"], ["C", "new"]])
    // Still no green and red: the outcome is a word, not a hue (components-01 §2.3).
    #expect(p.lines.flatMap { $0 }.allSatisfy { ![.ok, .failed].contains($0.ink) })
}

@Test func anAgentsWordsInAPreviewAreOnTheWashInTheSerif() {
    let p = RequestBodyBlock.preview(PreviewBody(heading: "What Approve Posts", text: "Moved to Friday.", agentWords: true)).presentation(today: monday, now: Date(), clock: ny)
    #expect(p.plate == .agentQuiet && p.lines[0][0].design == .serif)
    let q = RequestBodyBlock.preview(PreviewBody(heading: "Where It Would Be Written", path: "a.md", text: "x")).presentation(today: monday, now: Date(), clock: ny)
    #expect(q.plate == .sunken)
}

@Test func aProposedToDoIsNeverACheckboxAndCarriesItsFacets() {
    let p = RequestBodyBlock.todos([TodoItem("Send Kessler the scope", facets: TaskFacets(due: TaskDay("2026-09-30"), people: ["Kessler"]))]).presentation(today: monday, now: Date(), clock: ny)
    #expect(p.lines[0].map(\.text) == ["Send Kessler the scope", "Wed", "Kessler"])
    #expect(p.lines[0][0].glyph == .proposed)
    #expect(![MetistryGlyph.checkbox, .checkboxOn].contains(p.lines[0][0].glyph!))
}

@Test func aFailedExcerptCarriesBothTimestamps() {
    let now = at("2026-09-28T13:05:00Z")
    let p = RequestBodyBlock.excerpt(ExcerptBody(text: "12 pages touched", source: "Nightly fold", failedAt: at("2026-09-28T11:00:00Z"), lastSucceeded: at("2026-09-26T11:00:00Z"), reason: "token expired")).presentation(today: monday, now: now, clock: ny)
    #expect(p.lines.last?.first?.text == "Failed 7:00 AM · last succeeded 2 days ago · token expired")
}

// MARK: - The states (components-01 §1; C28; C64)

@Test func threeStatesReplaceTheContentAndTwoAnnotateIt() {
    #expect(ContentState.allCases.filter(\.replacesContent) == [.empty, .absent, .failed])
    #expect(ContentState.allCases.filter { !$0.replacesContent } == [.stale, .partial])
}

@Test func onlyAFailureQuotesItsReasonAndItsLastSuccess() {
    let now = at("2026-09-28T13:05:00Z")
    let empty = StatePanelModel(.empty, title: "Nothing Yet", sentence: "s", reason: "x", lastSucceeded: now).presentation(now: now, clock: ny)
    #expect(empty.reason == nil && empty.lastSucceeded == nil)
    let failed = StatePanelModel(.failed, title: "Couldn't Read Spend", sentence: "s", reason: "over_cap · aws-costs", lastSucceeded: at("2026-09-26T08:10:00Z"), action: StateWords.tryAgain).presentation(now: now, clock: ny)
    #expect(failed.reason?.text == "over_cap · aws-costs" && failed.reason?.design == .mono && failed.reason?.plate == .sunken)
    #expect(failed.lastSucceeded?.text == "Last succeeded 2 days ago · 26 Sep, 4:10 AM")
    #expect(failed.controls.map(\.label) == ["Try Again"])
    #expect(failed.glyph.glyph == .failed && failed.glyph.ink == .failed)
    let absent = StatePanelModel(.absent, title: "Not Configured", sentence: "s").presentation(now: now, clock: ny)
    #expect(absent.glyph.glyph == .absent && absent.glyph.ink == .absent, "absent is a fact, in its own grey, not a fault")
}

@Test func partialSaysWhyTheRestIsMissingAndTheFactNoteIsTheDesignsSentence() {
    #expect(PartialNoteModel.parseWarning(token: "every weekdy").text == "couldn't read `every weekdy` — the rest of the line is fine")
    #expect(PartialNoteModel("x").mark(on: .surface).ink == .degraded)
    #expect(FactNoteModel.unreachable.fact == "the instance is unreachable — decisions are never queued")
    #expect(FactNoteModel.unreachable.fact == ReachabilityGate.decisionsNeedTheConnection, "one sentence, the gate's")
    #expect(FactNoteModel.unreachable.mark(on: .surface).glyph == .lock)
}

// MARK: - Stale and first paint (C135)

@Test func thePillDrawsNothingUnlessToldTheRowIsStale() {
    #expect(StalePillModel(isStale: false, age: "3 days ago").mark(on: .surface) == nil)
    let mark = StalePillModel(isStale: true, age: "3 days ago").mark(on: .surface)
    #expect(mark?.voice == "stale, 3 days ago")
    #expect(mark?.ink == .stale, "staleness is neutral, not a fault tint")
}

@Test func theBandSaysWhenTheDataIsFrom() {
    let now = at("2026-09-28T13:05:00Z")
    #expect(StaleBandModel("Showing the board", asOf: at("2026-09-28T12:14:00Z")).presentation(now: now, clock: ny).text.text == "Showing the board as of 8:14 AM")
    #expect(StaleBandModel("Showing the board", asOf: at("2026-09-27T13:14:00Z")).presentation(now: now, clock: ny).text.text == "Showing the board as of 27 Sep, 9:14 AM")
    #expect(StaleBandModel("Spend", asOf: now.addingTimeInterval(-2400), when: .age).presentation(now: now, clock: ny).text.text == "Spend as of 40 minutes ago")
    // Its action is plain, never outlined: `border-control` does not clear 3:1 on `stale-quiet`.
    #expect(StaleBandModel("Showing the board", asOf: now, action: "Sync Now").presentation(now: now, clock: ny).controls.map(\.role) == [.plain])
}

@Test func firstPaintShowsTheLastDataAtOnceAndPlaceholdersOnlyOnTheFirstLoad() {
    let now = at("2026-09-28T13:05:00Z")
    #expect(FirstPaint.paint(asOf: now.addingTimeInterval(-60), loadingSince: now, ageLimit: 300, waitingFor: "w", now: now) == .content(staleSince: nil))
    let old = now.addingTimeInterval(-600)
    #expect(FirstPaint.paint(asOf: old, loadingSince: nil, ageLimit: 300, waitingFor: "w", now: now) == .content(staleSince: old))
    #expect(FirstPaint.paint(asOf: nil, loadingSince: now.addingTimeInterval(-0.5), ageLimit: 300, waitingFor: "Reading your vault", now: now) == .placeholders(waitingFor: nil))
    #expect(FirstPaint.paint(asOf: nil, loadingSince: now.addingTimeInterval(-1.5), ageLimit: 300, waitingFor: "Reading your vault", now: now) == .placeholders(waitingFor: "Reading your vault"), "a wait over one second says what it waits for")
}

@Test func firstPaintReadsAStoreSectionTheSameWay() {
    let now = at("2026-09-28T13:05:00Z")
    var section = Section<Int>()
    #expect(FirstPaint.paint(section, loadingSince: now.addingTimeInterval(-2), ageLimit: 300, waitingFor: "Reading the board", now: now) == .placeholders(waitingFor: "Reading the board"))
    section.failed(.transport("connection refused"), at: now)
    #expect(FirstPaint.paint(section, loadingSince: nil, ageLimit: 300, waitingFor: "w", now: now) == .failed(section.state.detail!))
    let asOf = now.addingTimeInterval(-60)
    section.loaded(3, asOf: asOf, at: now)
    #expect(FirstPaint.paint(section, loadingSince: nil, ageLimit: 300, waitingFor: "w", now: now) == .content(staleSince: nil))
    // A failed refresh keeps what is on screen, and says when it is from.
    section.failed(.transport("connection refused"), at: now)
    #expect(FirstPaint.paint(section, loadingSince: nil, ageLimit: 300, waitingFor: "w", now: now) == .content(staleSince: asOf))
}

// MARK: - Undo, and confirm naming the cost (C136; P3)

@Test func undoIsOfferedForTenSecondsAndThenIsGone() {
    let acted = at("2026-09-28T13:05:00Z")
    let w = UndoWindow("Declined 5 requests", actedAt: acted)
    #expect(w.isOpen(at: acted) && w.isOpen(at: acted.addingTimeInterval(9.9)))
    #expect(!w.isOpen(at: acted.addingTimeInterval(10)) && !w.isOpen(at: acted.addingTimeInterval(-1)))
    #expect(w.presentation(at: acted.addingTimeInterval(3)).controls.map(\.label) == ["Undo"])
    #expect(w.presentation(at: acted.addingTimeInterval(10)).controls.isEmpty)
    #expect(w.presentation(at: acted.addingTimeInterval(3)).receipt.voice == "Declined 5 requests. Undo available")
}

@Test func aConfirmationThatNamesNoCostOrWhoseButtonIsNotTheActCannotBeMade() {
    #expect(CostConfirmation(title: "Purge?", costHeading: "h", costs: [], confirm: "Purge Now") == nil)
    #expect(CostConfirmation(title: "Purge?", costHeading: "h", costs: ["  ", ""], confirm: "Purge Now") == nil)
    for bare in ["OK", "Yes", "Confirm", "Continue", "ok", " Proceed ", ""] {
        #expect(CostConfirmation(title: "Purge?", costHeading: "h", costs: ["Standup"], confirm: bare) == nil, "\(bare)")
    }
    let purge = CostConfirmation(title: "Purge 1 Session Now?", costHeading: "Not folded yet:", costs: ["Standup"], confirm: "Purge Now", alternative: "Fold First")!
    let p = purge.presentation()
    #expect(p.controls.map(\.label) == ["Fold First", "Cancel", "Purge Now"])
    #expect(p.controls.map(\.role) == [.secondary, .secondary, .destructive], "the act is the one filled destructive button")
    #expect(p.controls[1].shortcut == "Return", "Cancel is the default (P3)")
    let widen = CostConfirmation(title: "Widen Access?", costHeading: "It could then:", costs: ["dispatch without asking"], confirm: "Widen", destructive: false)!
    #expect(widen.presentation().controls.last?.role == .primary)
}

// MARK: - Glyphs, type, and what the sources may not do

#if canImport(AppKit)
@Test func everyGlyphIsASymbolThisMacHas() {
    for glyph in MetistryGlyph.allCases {
        #expect(NSImage(systemSymbolName: glyph.rawValue, accessibilityDescription: nil) != nil, "\(glyph) → \(glyph.rawValue)")
        #expect(NSImage(systemSymbolName: glyph.selectedName, accessibilityDescription: nil) != nil, "\(glyph) → \(glyph.selectedName)")
        #expect(!glyph.spoken.isEmpty)
    }
}
#endif

@Test func theTypeGrowsWithTheTextSizeOnTheMacAndIsTheSystemsAtTheStandardSize() {
    for style in MetistryTextStyle.allCases {
        #expect(MetistryType.pointSize(style, .large) == style.macPointSize)
        #expect(MetistryType.pointSize(style, .accessibility5) > style.macPointSize * 3)
    }
    #expect(MetistryType.pointSize(.body, .accessibility5) == 41)
}

@Test func controlsClearEveryGroundTheyAreDrawnOn() {
    // A control sits on a component's ground or on a block's plate. The stale
    // band's plate takes no outlined control — `border-control` is under 3:1
    // on it — which is pinned below.
    let grounds: [MetistryColorRole] = [.bg, .surface, .elevated, .sunken, .staleQuiet]
    for scheme in [ColorScheme.light, .dark] {
        for ground in grounds {
            #expect(Contrast.ratio(.textPrimary, ground, scheme) >= 4.5, "secondary button words on \(ground)")
            #expect(Contrast.ratio(.textSecondary, ground, scheme) >= 4.5, "plain button words on \(ground)")
            if ground != .staleQuiet {
                #expect(Contrast.ratio(.borderControl, ground, scheme) >= 3, "an outline on \(ground)")
            }
            #expect(Contrast.ratio(.focusRing, ground, scheme) >= 3, "the focus ring on \(ground)")
        }
        #expect(Contrast.ratio(.borderControl, .staleQuiet, scheme) < 3)
        #expect(Contrast.ratio(.onAccent, .accent, scheme) >= 4.5)
        #expect(Contrast.ratio(.onDestructive, .destructive, scheme) >= 4.5)
    }
}

@Test func theComponentsNeverClipNeverHardcodeANameAndTakeEveryColourFromARole() throws {
    for (name, text) in try componentSources() {
        let code = codeLines(text).joined(separator: "\n")
        // Nothing clips at the largest text: no line limit, no truncation (§2.18.5).
        #expect(!code.contains(".lineLimit("), "\(name) limits lines")
        #expect(!code.contains(".truncationMode("), "\(name) truncates")
        // The assistant's name lives only in identity.yaml (CLAUDE.md).
        #expect(!code.contains("\"Metis"), "\(name) hardcodes the assistant's name")
        // A disabled or recessive mark takes a dimmer ink at full opacity, never opacity (C63).
        #expect(!code.contains(".opacity("), "\(name) dims with opacity")
        // Every colour is a role.
        for literal in ["Color(red", "Color(hue", "Color(white", "Color.red", "Color.green", "Color.gray", "Color.black", "Color.white", "Color.accentColor", ".foregroundColor("] {
            #expect(!code.contains(literal), "\(name) paints \(literal)")
        }
    }
}

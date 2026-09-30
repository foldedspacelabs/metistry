// Knowledge (T6-4). Built against the recorded fixtures first — the fold, the
// drafts, the areas, the queue, the syncs, a page and its links, search — and a
// scripted console where a fixture cannot say it (a draft asked about, a
// conflict, a refusal).
//
// The ticket's two bold tests are the first two: the sources line says
// **freshness unknown until `collector_health` answers**, and **a draft never
// appears in an agent-facing fixture**. Then the fold, Needs your eye, the
// conflict and its held Undo, areas, a page, search, and §2.18. macOS only,
// as the accessibility probe is (shell-accessibility-tests.swift).

#if os(macOS)
import AppKit
import Foundation
import SwiftUI
import Testing

@testable import MetistryKit

// MARK: - The ticket's two

@MainActor
@Test func theSourcesLineSaysFreshnessUnknownUntilCollectorHealthAnswers() async throws {
    let (model, _, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    // The recorded syncs, and no door serving collector_health: unknown, folded.
    let line = try #require(model.sourcesLine)
    let n = try recordedSyncCount()
    #expect(line.rows.count == n, "one row per recorded sync")
    #expect(line.text == "\(n) sources · freshness unknown")
    #expect(!line.faulted)
    #expect(!model.sourcesExpanded, "a line with no fault stays folded until clicked")
    #expect(line.rows.allSatisfy { $0.state == .unknown }, "\(line.rows)")
    #expect(!line.text.contains("current"))

    let sources = try #require(model.sources.section.value)
    let ok = CollectorHealth(lastOK: recordedNow.addingTimeInterval(-120), streak: 0)
    // All but one answering is not "all current": one unanswered source is unknown.
    var three: [String: CollectorHealth] = [:]
    for s in sources.dropLast() { three[s.name] = ok }
    #expect(SourcesLine.make(sources, health: three, now: recordedNow).text == "\(n) sources · freshness unknown")

    // Every source answering, each checked within its cadence: now it may say current.
    var all = three
    all[sources.last!.name] = ok
    let current = SourcesLine.make(sources, health: all, now: recordedNow)
    #expect(current.text == "\(n) sources, all current")
    #expect(current.rows.allSatisfy { $0.state == .current })

    // A fault opens the line by itself, and failed carries two timestamps (§6).
    var failing = all
    failing["devin-sessions"] = CollectorHealth(lastOK: recordedNow.addingTimeInterval(-2 * 86_400), lastFailure: recordedNow.addingTimeInterval(-3600), lastError: "token expired", streak: 3)
    failing["aws-costs"] = CollectorHealth(lastOK: recordedNow.addingTimeInterval(-3 * 86_400), streak: 0)
    let faulted = SourcesLine.make(sources, health: failing, now: recordedNow)
    #expect(faulted.text == "\(n) sources · 2 behind")
    #expect(faulted.faulted)
    let devin = try #require(faulted.rows.first { $0.name == "devin-sessions" })
    #expect(devin.state == .failed)
    #expect(devin.detail == "last succeeded 2 days ago · token expired", "never 'failed an hour ago' alone")
    let aws = try #require(faulted.rows.first { $0.name == "aws-costs" })
    #expect(aws.state == .stale)
    #expect(aws.detail == "checked 3 days ago · 3d old", "stale annotates; the age rides the name")
    #expect(aws.spoken == "AWS Costs, stale, checked 3 days ago · 3d old", "the state is said in words")
}

@Test func aDraftNeverAppearsInAnAgentFacingFixture() throws {
    let fixtures = try ConsoleFixture.loadAll()
    let drafts = try #require(fixtures.first { $0.route == "GET /api/knowledge/drafts" })
    let draftPaths = (drafts.replyJSON?["drafts"]?.arrayValue ?? []).compactMap { $0.string("path") }
    #expect(!draftPaths.isEmpty, "the recorded drafts name a draft, so this test has teeth")

    // Agent-facing: the generic door an agent with `queries: true` could be
    // handed (`/api/q/:name`), and the four reads that mirror an agent's
    // `/mcp` knowledge tools (search, read, list, links).
    let agentFacing: Set<String> = [
        "GET /api/q/:name", "GET /api/knowledge/search", "GET /api/knowledge/page",
        "GET /api/knowledge/pages", "GET /api/knowledge/links",
    ]
    let facing = fixtures.filter { agentFacing.contains($0.route) }
    #expect(facing.count >= 5, "\(facing.map(\.stem))")
    for fixture in facing {
        let bytes = String(decoding: fixture.reply, as: UTF8.self)
        for path in draftPaths {
            #expect(!bytes.contains(path), "\(fixture.stem) serves the draft \(path)")
            let stem = String(path.dropLast(3))
            #expect(!bytes.contains("[[\(stem)"), "\(fixture.stem) links the draft \(path)")
        }
    }
    // The drafts come from one door only, and it is the owner's.
    #expect(!agentFacing.contains(drafts.route))
}

@MainActor
@Test func aDraftReachesTheScreenOnlyThroughTheOwnersDraftsRoute() async throws {
    let (model, console, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    let draft = "Areas/Health/Sleep.md"
    #expect(model.eye.contains { $0.kind == .draft && $0.path == draft })
    let asked = console.calls.filter { $0.path.contains("drafts") }
    #expect(asked.allSatisfy { $0.path.hasPrefix("/api/knowledge/drafts") }, "\(asked)")
    // The page lists behind an area and search are the index, which never holds a draft.
    await model.go(to: .area("Areas/Health"))
    #expect(model.areaPages?.value?.contains { $0.path == draft } != true)
    model.query = "store"
    await model.submitSearch()
    #expect(model.search?.value?.hits.contains { $0.path == draft } != true)
}

// MARK: - The fold

@Test func theFoldReadsItsSectionsAndLeavesAPendingSlotUnwritten() {
    let md = """
    ---
    source: assistant
    type: journal
    ---
    # Fold — 2026-09-28

    ## What happened

    Sleep moved again; see [[Areas/Health/Sleep|the taper]] and [[Projects/Metistry/Roadmap]]. <!-- metistry:written 1 -->

    ## What was decided

    <!-- metistry:prose "list anything decided today" -->

    ## Tasks found

    - ![[Areas/Ops/lease.png]]
    """
    let doc = FoldDocument.parse(md)
    #expect(doc.parts.map(\.heading) == ["What happened", "What was decided", "Tasks found"])
    #expect(doc.parts[0].text == "Sleep moved again; see [[Areas/Health/Sleep|the taper]] and [[Projects/Metistry/Roadmap]].")
    #expect(doc.parts[1].text == nil, "a pending slot is not words")
    #expect(!doc.plain.contains("metistry:"), "no marker is ever read aloud")
    #expect(doc.plain.contains("see the taper and Roadmap."), "\(doc.plain)")

    let text = doc.parts[0].text!
    #expect(FoldText.links(in: text) == ["Areas/Health/Sleep.md", "Projects/Metistry/Roadmap.md"])
    #expect(FoldText.links(in: doc.parts[2].text!) == ["Areas/Ops/lease.png"], "an embed keeps its extension")
    // A page name is a link the view opens in place — and only that.
    let attributed = FoldText.attributed(text)
    let urls = attributed.runs.compactMap(\.link)
    #expect(urls.count == 2)
    #expect(urls.compactMap(FoldText.path(from:)) == ["Areas/Health/Sleep.md", "Projects/Metistry/Roadmap.md"])
    #expect(String(attributed.characters).contains("the taper"))
    #expect(FoldText.path(from: URL(string: "https://example.com")!) == nil)
}

@MainActor
@Test func theFoldIsReadFromItsRouteThenItsOwnFile() async throws {
    let (model, console, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    let fold = try #require(model.fold.section.value ?? nil)
    #expect(fold.path == "Journal/Fold/2026-09-28.md")
    #expect(fold.links.map(\.path) == ["Projects/Metistry/Roadmap.md"])
    #expect(fold.document != nil, "the words are the file's")
    let reads = console.calls.map(\.path)
    #expect(reads.contains("/api/knowledge/fold"))
    #expect(reads.contains { $0.hasPrefix("/api/knowledge/page?path=Journal%2FFold%2F2026-09-28.md") }, "\(reads)")

    // Earlier Folds asks for the newest on or before the day before.
    console.reset()
    await model.earlierFold()
    #expect(console.calls.first?.path == "/api/knowledge/fold?date=2026-09-27", "\(console.calls.map(\.path))")
    #expect(model.foldDate == "2026-09-27")
    console.reset()
    await model.newestFold()
    #expect(console.calls.first?.path == "/api/knowledge/fold")
}

@Test func theFoldsRuleTemplatesTheConfiguredName() {
    #expect(KnowledgeWords.foldRule("Aide").hasPrefix("Aide writes here, in its own voice, as its own commit."))
    #expect(!KnowledgeWords.foldRule(nil).contains("Metis"))
}

// MARK: - Needs your eye

@MainActor
@Test func needsYourEyeHoldsTheThreeKindsAndCountsInItsHeader() async throws {
    let console = KnowledgeConsole()
    console.proposals = [conflictRow(id: 40), draftRow(id: 41, path: "Areas/Health/Sleep.md"), suggestionRow(id: 42)]
    let (model, session) = knowledgeModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.load()
    let items = model.eye
    // Drafts, then conflicts, then suggestions; a draft already asked about is its request's row, once.
    #expect(items.map(\.kind) == [.draft, .conflict, .suggestion])
    #expect(items.filter { $0.path == "Areas/Health/Sleep.md" }.count == 1)
    #expect(items[0].request?.id == 41)
    #expect(items[0].spoken == "Draft, Areas/Health/Sleep.md, The taper, rewritten. Review")
    #expect(items[1].spoken == "Conflict, Areas/Health/2026/sleep.md, Two versions of this note — a sync kept both. Resolve")
    #expect(items[2].spoken == "Suggestion, Projects/Metistry/Roadmap.md, fourteen domain stores, one per screen family. Read")
    // Nothing else in the queue is Knowledge's.
    #expect(model.requests.section.value?.map(\.id) == [40, 41, 42])
}

@MainActor
@Test func answeringADraftHereIsTheSameAnswerNeedsYouSends() async throws {
    let console = KnowledgeConsole()
    console.proposals = [draftRow(id: 41, path: "Areas/Health/Sleep.md")]
    let (model, session) = knowledgeModel(console)
    defer { withExtendedLifetime(session) {} }
    var told = 0
    model.onQueueChanged = { told += 1 }
    await model.load()
    let item = try #require(model.eye.first)
    await model.go(to: .item(item.id))
    let card = try #require(model.cards(assistantName: "Aide")).card(for: try #require(item.request))
    // Approve · Revise · Decline — the served words (amendments §8.1).
    #expect(card.reading.shape.primary?.label == "Approve")
    #expect(card.reading.shape.revise?.label == "Revise")
    #expect(card.reading.shape.decline?.label == "Decline")
    console.reset()
    await card.press(.primary)
    let sent = try #require(console.calls.first { $0.method == "POST" })
    #expect(sent.path == "/api/proposals/41")
    #expect(sent.body?["decision"]?.stringValue == "allow")
    #expect(card.isSettled)
    await model.answered()
    #expect(told == 1, "the shell's count hears it")
}

@MainActor
@Test func aDraftNothingHasAskedAboutSaysSoRatherThanOfferingAnAnswer() async throws {
    let (model, session) = knowledgeModel(KnowledgeConsole())
    defer { withExtendedLifetime(session) {} }
    await model.load()
    let item = try #require(model.eye.first { $0.kind == .draft })
    #expect(item.request == nil)
    #expect(item.why == "the taper")
    await model.go(to: .item(item.id))
    let detail = try await AccessibilityProbe.snapshot(knowledgeView(model).frame(width: 820, height: 1200))
    defer { detail.close() }
    let said = detail.labels + detail.texts
    #expect(said.contains(KnowledgeWords.notAskedYet), "said: \(said)")
    #expect(detail.controls.contains { $0.name.hasPrefix("Approve") }, "\(detail.controlNames)")
}

// MARK: - A conflict, resolved in place

@MainActor
@Test func keepMineIsHeldTenSecondsAndUndoSendsNothing() async throws {
    let console = KnowledgeConsole()
    console.proposals = [conflictRow(id: 40)]
    let (model, session) = knowledgeModel(console, hold: .seconds(3600))
    defer { withExtendedLifetime(session) {} }
    await model.load()
    let item = try #require(model.eye.first { $0.kind == .conflict })
    await model.go(to: .item(item.id))
    let r = try #require(model.conflicts[40])
    #expect(ConflictResolution.label(.mine, row: item.request) == "Keep Mine")
    #expect(ConflictResolution.label(.theirs, row: item.request) == "Take the Other", "the served word, not one this build invents")
    console.reset()

    r.choose(.mine)
    #expect(r.isHolding)
    #expect(r.undoWindow?.receipt == "Keeping your version")
    #expect(r.undoWindow?.presentation(at: recordedNow.addingTimeInterval(1)).controls.map(\.label) == ["Undo"])
    #expect(UndoWindow.seconds == 10)
    #expect(console.calls.isEmpty, "held, not sent")
    r.undo()
    #expect(r.phase == .open)
    try await Task.sleep(for: .milliseconds(50))
    #expect(console.calls.isEmpty, "Undo sent nothing, and nothing is sent later")

    // Chosen again and the window runs out: now it is sent, giving up the other side's hash.
    r.choose(.mine)
    await r.send()
    let sent = try #require(console.calls.first)
    #expect(sent.method == "POST" && sent.path == "/api/knowledge/conflicts/resolve")
    #expect(sent.body == .object(["path": .string(copyPath), "keep": .string("mine"), "seen_sha": .string(otherSHA)]))
    #expect(r.phase == .settled("Kept your version of \(originalPath)"), "\(r.phase)")
}

@MainActor
@Test func takeTheOtherGivesUpMineAndIsSentWhenTheWindowCloses() async throws {
    let console = KnowledgeConsole()
    console.proposals = [conflictRow(id: 40)]
    let (model, session) = knowledgeModel(console, hold: .milliseconds(30))
    defer { withExtendedLifetime(session) {} }
    await model.load()
    await model.go(to: .item(try #require(model.eye.first { $0.kind == .conflict }).id))
    let r = try #require(model.conflicts[40])
    console.reset()
    r.choose(.theirs)
    for _ in 0..<50 where !console.calls.contains(where: { $0.method == "POST" }) { try await Task.sleep(for: .milliseconds(20)) }
    let sent = try #require(console.calls.first { $0.method == "POST" })
    #expect(sent.body?["keep"]?.stringValue == "theirs")
    #expect(sent.body?["seen_sha"]?.stringValue == mineSHA)
}

@MainActor
@Test func aStaleSettleRepaintsAndOneSettledElsewhereSaysSo() async throws {
    let console = KnowledgeConsole()
    console.proposals = [conflictRow(id: 40)]
    let (model, session) = knowledgeModel(console, hold: .seconds(3600))
    defer { withExtendedLifetime(session) {} }
    await model.load()
    await model.go(to: .item(try #require(model.eye.first { $0.kind == .conflict }).id))
    let r = try #require(model.conflicts[40])

    // 409 stale carrying the conflict as it stands: the hashes move, nothing was written.
    console.resolve = (409, .object([
        "error": .object(["code": .string("conflict"), "message": .string("the conflict changed after you saw it")]),
        "reason": .string("stale"),
        "conflict": .object(["path": .string(copyPath), "original": .string(originalPath), "sha256": .string("new-other"), "original_sha256": .string(mineSHA)]),
    ]))
    r.choose(.mine)
    await r.send()
    #expect(r.repainted)
    #expect(r.conflict.otherSHA == "new-other")
    guard case .refused = r.phase else { Issue.record("\(r.phase)"); return }
    #expect(r.conflict.seenSHA(keeping: .mine) == "new-other", "the next answer claims what is there now")

    // 409 stale with nothing in conflict: settled from another device.
    console.resolve = (409, .object([
        "error": .object(["code": .string("conflict"), "message": .string("not in conflict")]),
        "reason": .string("stale"), "conflict": .null,
    ]))
    r.choose(.mine)
    await r.send()
    #expect(r.phase == .gone("Already settled elsewhere — nothing changed from here"))

    // Any other refusal is the console's own words, and the verbs stay.
    let r2 = ConflictResolution(try #require(KnowledgeConflict(conflictRow(id: 40))), store: session.stores, hold: .seconds(3600))
    console.resolve = (503, .object(["error": .object(["code": .string("not_available"), "message": .string("the vault bridge is not configured")])]))
    r2.choose(.theirs)
    await r2.send()
    #expect(r2.phase == .refused("the vault bridge is not configured"))
    #expect(KnowledgeConflictView.canChoose(r2.phase))
}

@Test func theDiffMarksYoursMinusAndTheOthersPlus() {
    let lines = ConflictDiff.lines(mine: "# Sleep\nBed at 10.\nNo coffee.", other: "# Sleep\nBed at 11.\nNo coffee.")
    #expect(lines == [DiffLine(.context, "# Sleep"), DiffLine(.removed, "Bed at 10."), DiffLine(.added, "Bed at 11."), DiffLine(.context, "No coffee.")])
    #expect(ConflictDiff.lines(mine: "a", other: "a") == [DiffLine(.context, "a")])
}

@Test func theConflictSaysWhoseIsWhichFromTheRequestAlone() throws {
    let c = try #require(KnowledgeConflict(conflictRow(id: 40)))
    #expect(c.copy == copyPath)
    #expect(c.original == originalPath)
    let words = KnowledgeConflictView.whoWrote(c, clock: ClockTime(timeZone: utc), now: recordedNow)
    #expect(words == "Yours is \(originalPath). A sync kept the other version beside it as \(copyPath). Found 3:19 AM.", "\(words)")
    // Not a conflict: a review about anything else is not Knowledge's.
    #expect(KnowledgeConflict(row(["id": 9, "kind": "review", "payload": ["path": "x"]])) == nil)
}

// MARK: - Areas, a page, search

@MainActor
@Test func areasAreDescribedNotCountedAndSayWhyTheyAreHere() async throws {
    let (model, _, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    let rows = try #require(model.areas.section.value)
    let health = try #require(rows.first { $0.area == "Areas/Health" })
    #expect(health.line == "Sleep, labs, and the protein blend")
    #expect(health.provenance(now: recordedNow) == "Changed 6 days ago")
    let projects = try #require(rows.first { $0.area == "Projects" })
    #expect(projects.provenance(now: recordedNow) == "Named by the latest fold")
    let journal = try #require(rows.first { $0.area == "Journal" })
    #expect(journal.line == KnowledgeAreaRow.noLine, "no line yet is said, not left blank (C68)")
    #expect(!projects.spoken(now: recordedNow).contains("2"), "a count is not the answer: \(projects.spoken(now: recordedNow))")
}

@MainActor
@Test func aPageShowsItsWordsAndBothDirectionsOfLinks() async throws {
    let (model, console, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    console.reset()
    await model.open(path: "Projects/Metistry/Roadmap.md")
    #expect(model.place == .page("Projects/Metistry/Roadmap.md"))
    let page = try #require(model.page?.value)
    #expect(page.title == "Roadmap")
    #expect(page.outgoing.map(\.path) == ["Projects/Metistry/Design.md"])
    // the recorded fold names the roadmap, so the roadmap links back to it
    #expect(page.incoming.map(\.path) == ["Journal/Fold/2026-09-28.md"])
    #expect(KnowledgePageRead.spoken(page.outgoing[0]) == "Design, link, Projects/Metistry/Design.md")
    #expect(console.calls.map(\.path).contains { $0.hasPrefix("/api/knowledge/links?path=Projects%2FMetistry%2FRoadmap.md") })
    await model.back()
    #expect(model.place == .home)
    #expect(!model.canGoBack)
}

@MainActor
@Test func searchSaysNothingMatchesInItsOwnWords() async throws {
    let console = KnowledgeConsole()
    console.searchHits = []
    let (model, session) = knowledgeModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.load()
    model.askForTheBox()
    #expect(model.wantsSearchFocus)
    model.query = "zebra"
    await model.submitSearch()
    #expect(model.place == .search("zebra"))
    #expect(model.search?.value?.hits.isEmpty == true)
    #expect(KnowledgeWords.noMatch("zebra") == "Nothing matches “zebra”")
    let tree = try await AccessibilityProbe.snapshot(knowledgeView(model).frame(width: 820, height: 900))
    defer { tree.close() }
    #expect((tree.labels + tree.texts).contains { $0.contains("Nothing matches “zebra”") }, "\(tree.labels + tree.texts)")
    model.query = ""
    await model.submitSearch()
    #expect(model.place == .home)
}

@MainActor
@Test func aVaultThatIsNotThereOffersChooseFolder() async throws {
    let console = KnowledgeConsole()
    console.down = (503, "vault not found at /tmp/x")
    let (model, session) = knowledgeModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.load()
    guard case .failed(let state) = model.panel else { Issue.record("\(model.panel)"); return }
    #expect(state.title == "Vault Not Found")
    #expect(state.action == KnowledgeWords.chooseFolder)
    #expect(state.reason?.contains("vault not found at /tmp/x") == true, "the console's own words: \(state.reason ?? "")")
}

// MARK: - §2.18

@MainActor
@Test func knowledgeSpeaksEveryRowAndEveryControl() async throws {
    let console = KnowledgeConsole()
    console.proposals = [conflictRow(id: 40), suggestionRow(id: 42)]
    let (model, session) = knowledgeModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.load()
    let tree = try await AccessibilityProbe.snapshot(knowledgeView(model).frame(width: 820, height: 1800))
    defer { tree.close() }
    // The search box's AppKit cell is read without SwiftUI's label, as every screen's field is (chat, capture, Needs You).
    #expect(tree.unlabeledControls.filter { $0.role != "AXTextField" }.isEmpty, "unlabeled: \(tree.unlabeledControls)")
    let said = tree.labels + tree.texts
    #expect(said.contains("Needs Your Eye, 3 waiting"), "the count, in the heading: \(said)")
    #expect(said.contains("Draft, Areas/Health/Sleep.md, the taper. Review"), "said: \(said)")
    #expect(said.contains("Conflict, Areas/Health/2026/sleep.md, Two versions of this note — a sync kept both. Resolve"), "said: \(said)")
    #expect(said.contains("Sources, \(try recordedSyncCount()) sources · freshness unknown, collapsed"), "said: \(said)")
    #expect(said.contains { $0.hasPrefix("Areas/Health, Sleep, labs, and the protein blend, Changed") }, "said: \(said)")
    #expect(said.contains("Aide wrote"), "the fold's author, templated")
    #expect(said.contains(KnowledgeWords.foldRule("Aide")))
    let headings = tree.headings
    for h in ["Knowledge", "The Fold, Journal/Fold/2026-09-28.md", "Areas"] {
        #expect(headings.contains(h), "headings: \(headings)")
    }
    let controls = tree.controlNames
    for name in [KnowledgeWords.openFold, KnowledgeWords.earlierFolds] {
        #expect(controls.contains { $0.hasPrefix(name) }, "controls: \(controls)")
    }
    // The badge is Needs You's alone (P2): nothing here draws one.
    #expect(!said.contains { $0.hasSuffix(" new") })
}

@MainActor
@Test func theConflictViewSpeaksItsVerbsAndTheUndo() async throws {
    let console = KnowledgeConsole()
    console.proposals = [conflictRow(id: 40)]
    let (model, session) = knowledgeModel(console, hold: .seconds(3600))
    defer { withExtendedLifetime(session) {} }
    await model.load()
    await model.go(to: .item(try #require(model.eye.first { $0.kind == .conflict }).id))
    let tree = try await AccessibilityProbe.snapshot(knowledgeView(model).frame(width: 820, height: 1400))
    defer { tree.close() }
    // The search box's AppKit cell is read without SwiftUI's label, as every screen's field is (chat, capture, Needs You).
    #expect(tree.unlabeledControls.filter { $0.role != "AXTextField" }.isEmpty, "unlabeled: \(tree.unlabeledControls)")
    let controls = tree.controlNames
    for name in ["Keep Mine", "Take the Other", KnowledgeWords.mergeInObsidian, KnowledgeWords.back] {
        #expect(controls.contains { $0.hasPrefix(name) }, "controls: \(controls)")
    }
    #expect(!controls.contains { $0.hasPrefix("Decline") }, "no fourth verb (§4)")
    let said = tree.labels + tree.texts
    #expect(said.contains { $0.contains("removed: Bed at 10.") }, "\(said)")
    #expect(said.contains { $0.contains("added: Bed at 11.") }, "\(said)")

    try #require(model.conflicts[40]).choose(.mine)
    let held = try await AccessibilityProbe.snapshot(knowledgeView(model).frame(width: 820, height: 1400))
    defer { held.close() }
    #expect((held.labels + held.texts).contains("Keeping your version. Undo available"), "\(held.labels + held.texts)")
    #expect(held.controlNames.contains { $0.hasPrefix("Undo") })
    try #require(model.conflicts[40]).undo()
}

@MainActor
@Test func aKnowledgeRowGrowsLongerNeverWiderAtTheLargestText() async throws {
    let item = KnowledgeEyeItem(kind: .draft, path: "Areas/Health/2026/a-rather-long-name-for-a-note.md", why: "A long reason that wraps its row at any width, then again at the largest text size macOS offers", request: nil)
    let area = KnowledgeAreaRow(area: "Areas/Health", description: "Sleep, labs, the protein blend, and the long tail of every appointment", lastChange: recordedNow.addingTimeInterval(-7200))
    let line = SourcesLine.make([KnowledgeSource(name: "a", title: "AWS Costs", every: "6h"), KnowledgeSource(name: "b", title: "Devin Sessions", every: "5m")], health: ["b": CollectorHealth(lastOK: recordedNow.addingTimeInterval(-86_400 * 2), lastError: "token expired and the key must be replaced", streak: 2)], now: recordedNow)
    let pieces: [(String, AnyView)] = [
        ("eye row", AnyView(KnowledgeEyeRow(item: item) {})),
        ("area row", AnyView(KnowledgeAreaRowView(row: area, now: recordedNow) {})),
        ("sources", AnyView(KnowledgeSourcesView(line: line, expanded: true) {})),
        ("rule", AnyView(KnowledgeRule(text: KnowledgeWords.conflictRule))),
    ]
    let width: CGFloat = 360
    for (name, view) in pieces {
        var heights: [DynamicTypeSize: CGFloat] = [:]
        for size in [DynamicTypeSize.large, .accessibility5] {
            let renderer = ImageRenderer(content: view.frame(width: width).environment(\.dynamicTypeSize, size))
            renderer.proposedSize = ProposedViewSize(width: width, height: nil)
            renderer.scale = 1
            let image = try #require(renderer.cgImage, "\(name) did not render")
            #expect(CGFloat(image.width) <= width, "\(name) is \(image.width) wide at \(size), offered \(width)")
            heights[size] = CGFloat(image.height)
        }
        #expect((heights[.accessibility5] ?? 0) > (heights[.large] ?? 0), "\(name) did not grow at the largest text: \(heights)")
    }
}

@MainActor
@Test func openingKnowledgeNeverRaisesTheWindowsMinimum() async throws {
    let console = KnowledgeConsole()
    console.proposals = [conflictRow(id: 40), suggestionRow(id: 42)]
    let (model, session) = knowledgeModel(console)
    let down = KnowledgeConsole()
    down.down = (503, "connect ECONNREFUSED 127.0.0.1:1")
    let (failed, failedSession) = knowledgeModel(down)
    let (waiting, waitingSession) = knowledgeModel(KnowledgeConsole())
    defer { withExtendedLifetime([session, failedSession, waitingSession]) {} }
    await model.load()
    await failed.load()
    let window = try await ShellProbe.acrossTheSwitch { knowledgeView(model) }
    #expect(window.after.minimum.height <= max(window.before.minimum.height, 460), "opening Knowledge raised the window's minimum to \(window.after.minimum)")
    #expect(window.after.frame == window.before.frame)
    let probe = MinimumProbe()
    for (name, m) in [("page", model), ("failed", failed), ("waiting", waiting)] {
        let size = probe.minimum(of: knowledgeView(m))
        #expect(size.height <= 460, "\(name): \(m.panel) asks for \(size) at the least")
    }
}

@MainActor
@Test func everyInkOnKnowledgeClearsItsGround() {
    let pairs: [(MetistryColorRole, MetistryColorRole, Double)] = [
        (.textPrimary, .agentQuiet, 4.5), (.textSecondary, .agentQuiet, 4.5), (.agent, .agentQuiet, 4.5),
        (.textPrimary, .elevated, 4.5), (.textSecondary, .elevated, 4.5), (.accent, .elevated, 4.5),
        (.textSecondary, .surface, 4.5), (.failed, .surface, 4.5), (.degraded, .elevated, 3), (.stale, .surface, 3), (.ok, .surface, 3),
    ]
    for scheme in [ColorScheme.light, .dark] {
        for (ink, ground, floor) in pairs {
            let ratio = Contrast.ratio(ink, ground, scheme)
            #expect(ratio >= floor, "\(ink.rawValue) on \(ground.rawValue) is \(ratio) in \(scheme)")
        }
    }
}

@Test func noStringInKnowledgesSourceSaysAssistantOrNamesOne() throws {
    let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("sources/kit")
    for file in ["knowledge-view.swift", "knowledge-model.swift"] {
        let text = try String(contentsOf: dir.appendingPathComponent(file), encoding: .utf8)
        var literals: [String] = []
        for line in text.split(separator: "\n") where !line.trimmingCharacters(in: .whitespaces).hasPrefix("//") {
            let code = line.components(separatedBy: " // ").first ?? String(line)
            let parts = code.split(separator: "\"", omittingEmptySubsequences: false)
            literals += stride(from: 1, to: parts.count, by: 2).map { String(parts[$0]) }
        }
        #expect(literals.count > 30, "\(file): the scan found almost nothing")
        // §2.18.4: nothing on the screen moves, so Reduce Motion has nothing to stop.
        #expect(!text.contains("withAnimation") && !text.contains(".animation(") && !text.contains(".transition("), "\(file)")
        // No bare key outside the menu table (C119).
        #expect(!text.contains(".keyboardShortcut("), "\(file)")
        for literal in literals {
            #expect(!literal.localizedCaseInsensitiveContains("assistant"), "\(file): \"\(literal)\"")
            #expect(literal.range(of: #"\bMetis\b"#, options: .regularExpression) == nil, "\(file): \"\(literal)\"")
        }
    }
}

// MARK: - Helpers

private let utc = TimeZone(identifier: "UTC")!
/// A day after the recorded knowledge fixtures.
private let recordedNow = WireTime.date("2026-09-27T03:21:35.215Z")!

/// How many syncs the recorded `GET /api/scheduled` lists — the sources line's
/// count. The recorder's seed decides it, so it is read, not written here (X-29).
private func recordedSyncCount() throws -> Int {
    try #require(ConsoleFixture.load("get-api-scheduled").replyJSON?["syncs"]?.arrayValue).count
}
private let copyPath = "Areas/Health/2026/sleep.sync-conflict-20260927-031200-7QX2LMA.md"
private let originalPath = "Areas/Health/2026/sleep.md"
private let mineSHA = String(repeating: "a", count: 64)
private let otherSHA = String(repeating: "b", count: 64)

@MainActor
private func knowledgeModel(_ console: any ConsoleCallTransport, hold: Duration = .seconds(3600)) -> (KnowledgeModel, ConsoleSession) {
    let session = ConsoleSession(transport: console, management: nil)
    return (KnowledgeModel(session: session, timeZone: utc, conflictHold: hold, now: { recordedNow }), session)
}

@MainActor
private func fixtureModel() async throws -> (KnowledgeModel, FixtureConsole, ConsoleSession) {
    let console = try FixtureConsole.recorded()
    let (model, session) = knowledgeModel(console)
    await model.load()
    return (model, console, session)
}

@MainActor
private func knowledgeView(_ model: KnowledgeModel) -> KnowledgeView {
    KnowledgeView(model: model, assistantName: "Aide", tick: .seconds(3600), onOpenInObsidian: { _ in }, onChooseFolder: {})
}

private func row(_ fields: [String: Any]) -> RequestRow {
    var f = fields
    f["ts"] = f["ts"] ?? "2026-09-27T03:19:34.940Z"
    f["decision"] = f["decision"] ?? "pending"
    let data = try! JSONSerialization.data(withJSONObject: f)
    return try! JSONDecoder().decode(RequestRow.self, from: data)
}

private func noteShape() -> [String: Any] { [
    "type": "note", "word": "note", "body": "preview",
    "primary": ["label": "Approve", "sends": ["decision": "allow"]],
    "revise": ["label": "Revise", "sends": ["decision": "accept_with_changes"], "carries": "feedback"],
    "decline": ["label": "Decline", "sends": ["decision": "deny"]],
    "grouped": false, "decisions": ["allow", "accept_with_changes", "deny"],
] }

private func draftRow(id: Int, path: String) -> RequestRow {
    row(["id": id, "kind": "draft_settle", "payload": ["path": path, "title": "The taper, rewritten", "summary": "The taper, rewritten"], "request": noteShape()])
}

private func suggestionRow(id: Int) -> RequestRow {
    row(["id": id, "kind": "knowledge", "payload": ["path": "Projects/Metistry/Roadmap.md", "title": "Add the store list to the roadmap", "summary": "fourteen domain stores, one per screen family"], "request": noteShape()])
}

private func conflictRow(id: Int) -> RequestRow {
    row([
        "id": id, "kind": "review", "source_agent": "reconciler",
        "ts": "2026-09-27T03:19:00.000Z",
        "payload": [
            "title": "Sync conflict: sleep.md", "event": "knowledge_conflict",
            "body": [
                "kind": "before_after", "heading": originalPath,
                "before": ["label": "Mine", "path": originalPath, "text": "# Sleep\nBed at 10.\nNo coffee.", "sha256": mineSHA, "truncated": false],
                "after": ["label": "The Other", "path": copyPath, "text": "# Sleep\nBed at 11.\nNo coffee.", "sha256": otherSHA, "truncated": false],
            ],
            "conflict": ["path": copyPath, "original": originalPath, "sha256": otherSHA, "original_sha256": mineSHA],
            "refs": [copyPath, originalPath],
        ],
        "request": [
            "type": "review", "word": "review", "body": "before_after",
            "primary": ["label": "Keep Mine", "sends": ["door": "resolve_conflict"]],
            "revise": ["label": "Take the Other", "sends": ["door": "resolve_conflict"]],
            "decline": ["label": "Decline", "sends": ["decision": "deny"]],
            "grouped": false, "decisions": ["deny"],
        ],
    ])
}

/// The recorded fixtures, with the queue, search and the conflict door
/// scripted where a test needs them to say something else — and a console
/// that is down.
private final class KnowledgeConsole: ConsoleCallTransport, @unchecked Sendable {
    private let lock = NSLock()
    private let fallback = try! FixtureConsole.recorded()
    private var _proposals: [RequestRow]?
    private var _searchHits: [JSONValue]?
    private var _resolve: (Int, JSONValue)?
    private var _down: (Int, String)?
    private var _calls: [FixtureCall] = []

    var proposals: [RequestRow]? { get { lock.withLock { _proposals } } set { lock.withLock { _proposals = newValue } } }
    var searchHits: [JSONValue]? { get { lock.withLock { _searchHits } } set { lock.withLock { _searchHits = newValue } } }
    var resolve: (Int, JSONValue)? { get { lock.withLock { _resolve } } set { lock.withLock { _resolve = newValue } } }
    var down: (Int, String)? { get { lock.withLock { _down } } set { lock.withLock { _down = newValue } } }
    var calls: [FixtureCall] { lock.withLock { _calls } }
    func reset() { lock.withLock { _calls.removeAll() } }

    func call(_ method: String, _ path: String, body: Data?, idempotencyKey: String?) async -> Result<Data, ConsoleError> {
        let sent = body.flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) }
        lock.withLock { _calls.append(FixtureCall(method: method, path: path, body: sent, idempotencyKey: idempotencyKey, lastEventID: nil, servedBy: nil)) }
        let bare = String(path.split(separator: "?", maxSplits: 1).first ?? "")
        if let (status, message) = down {
            return .failure(.http(status: status, envelope: ConsoleErrorEnvelope(code: "not_available", message: message)))
        }
        if method == "GET", bare == "/api/proposals", let rows = proposals {
            let data = try! JSONEncoder().encode(RequestPage(proposals: rows))
            return .success(data)
        }
        if method == "GET", bare == "/api/knowledge/search", let hits = searchHits {
            return .success(try! JSONEncoder().encode(JSONValue.object(["q": .string("zebra"), "mode": .string("keyword"), "hits": .array(hits), "as_of": .string("2026-09-27T03:19:35.215Z")])))
        }
        if method == "POST", bare == "/api/knowledge/conflicts/resolve" {
            if let (status, json) = resolve, !(200..<300).contains(status) {
                return .failure(.http(status: status, envelope: ConsoleErrorEnvelope(json: json)))
            }
            return .success(try! JSONEncoder().encode(JSONValue.object(["ok": .bool(true), "path": .string(originalPath), "kept": sent?["keep"] ?? .null, "sha": .string(mineSHA)])))
        }
        return await fallback.call(method, path, body: body, idempotencyKey: idempotencyKey)
    }
}
#endif

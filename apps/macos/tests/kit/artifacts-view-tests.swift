// Work ▸ Artifacts (T6-9). Built against the recorded fixtures first — the
// list, the rooms, the versions, a file, a version's threads, the diff — and a
// scripted console where a fixture cannot say it (threads on an older
// version, a file replaced on disk, an empty list, a console that is down).
//
// The ticket's bold test is the first: **a thread on a changed line stays on
// its version.** Then the diff as git writes it, the margin's collision rule
// by measurement, the list, the rail, the states, and §2.18. macOS only, as
// the accessibility probe is (shell-accessibility-tests.swift).

#if os(macOS)
import AppKit
import Foundation
import SwiftUI
import Testing

@testable import MetistryKit

// MARK: - The ticket's test

@MainActor
@Test func aThreadOnAChangedLineStaysOnItsVersion() async throws {
    let console = ArtifactsConsole()
    // A thread written on v1, about its third line — the line v2 rewrote.
    console.threads = [v1: [threadJSON("cmt_01M3FYT8NVNX3ZGBZH481KTHG1", version: v1, line: 3, body: "Say which domain.")]]
    let (model, session) = artifactsModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.load()
    await model.open(artifactID)

    // It opens on the latest, and v2's threads do not include v1's.
    #expect(model.shown?.label == "v2")
    #expect(model.threads?.value?.map(\.id) == [], "a thread never moves to a later version")
    #expect(model.marginThreads.isEmpty)

    await model.beginCompare()
    let c = try #require(model.comparison)
    #expect(model.version(c.from)?.label == "v1" && model.version(c.to)?.label == "v2", "from the version before the one on screen, to it")
    #expect(model.comparison?.diff.value?.changed(path: "notes.md", line: 3) == true)
    let staying = try #require(model.staying)
    #expect(staying.sentence == "1 thread on v1 is about a line v2 changed. It stays on v1.")
    #expect(staying.action == "Open on v1 →")
    #expect(staying.threads.map(\.id) == ["cmt_01M3FYT8NVNX3ZGBZH481KTHG1"])

    // …and said so on screen, with the way back to it.
    let tree = try await AccessibilityProbe.snapshot(artifactsView(model).frame(width: 1100, height: 800))
    let said = tree.labels + tree.texts
    #expect(said.contains(staying.sentence), "\(said)")
    #expect(tree.controlNames.contains("Open on v1 →"), "\(tree.controlNames)")
    #expect(tree.headings.contains("Compare v1 and v2"), "\(tree.headings)")
    tree.close()

    // Open on v1 → shows v1, and there the thread is — asked for by its version.
    await model.show(version: staying.versionID)
    #expect(model.comparison == nil)
    #expect(model.shown?.label == "v1")
    #expect(model.threads?.value?.map(\.id) == ["cmt_01M3FYT8NVNX3ZGBZH481KTHG1"])
    #expect(console.calls.contains { $0.path.hasSuffix("/comments?version=\(v1)") })
    #expect(!console.calls.contains { $0.method != "GET" }, "comparing and reading change nothing")
}

@Test func aThreadOnALineTheDiffLeftAloneIsNotSaidToHaveMoved() {
    let diff = ArtifactDiffReading(diff: gitDiff, pathPrefix: "Artifacts/metistry/plan")
    let from = ArtifactVersionRecord(id: "ver_A", number: 2, author: "user", message: "", createdAt: nil, pathPrefix: "Artifacts/metistry/plan", files: [])
    let to = ArtifactVersionRecord(id: "ver_B", number: 3, author: "user", message: "", createdAt: nil, pathPrefix: "Artifacts/metistry/plan", files: [])
    let untouched = ArtifactThreadRecord(id: "cmt_1", versionID: "ver_A", path: "notes.md", line: 5, body: "fine")
    let changed = ArtifactThreadRecord(id: "cmt_2", versionID: "ver_A", path: "notes.md", line: 3, body: "reword")
    let resolved = ArtifactThreadRecord(id: "cmt_3", versionID: "ver_A", path: "notes.md", line: 3, body: "done", state: "resolved")
    let elsewhere = ArtifactThreadRecord(id: "cmt_4", versionID: "ver_A", path: "notes.md", line: 12, body: "far down")
    #expect(ArtifactStayingThreads(threads: [untouched], diff: diff, from: from, to: to) == nil)
    let s = try? #require(ArtifactStayingThreads(threads: [untouched, changed, resolved, elsewhere], diff: diff, from: from, to: to))
    #expect(s?.threads.map(\.id) == ["cmt_2"], "open threads on a changed line, and only those")
    #expect(s?.sentence == "1 thread on v2 is about a line v3 changed. It stays on v2.")
    #expect(s?.action == "Open on v2 →")
    let two = ArtifactStayingThreads(threads: [changed, ArtifactThreadRecord(id: "cmt_5", versionID: "ver_A", path: "notes.md", line: 11, body: "x")], diff: diff, from: from, to: to)
    #expect(two?.sentence == "2 threads on v2 are about lines v3 changed. They stay on v2.")
}

// MARK: - The diff, as git writes it and as the fixture recorded it

@Test func gitsUnifiedDiffIsReadForTheLinesItChangedPerFile() {
    let d = ArtifactDiffReading(diff: gitDiff, pathPrefix: "Artifacts/metistry/plan")
    #expect(d.files.map(\.path) == ["notes.md", "data.json"], "paths inside the artifact")
    let notes = d.files[0]
    #expect(notes.changedFromLines == [3, 11], "the hunks' own line numbers: -1,5 and -10,3")
    #expect(notes.added == 2 && notes.removed == 2)
    #expect(notes.lines.first == ArtifactDiffLine(.hunk, "@@ -1,5 +1,5 @@"))
    #expect(notes.lines.contains(ArtifactDiffLine(.context, "Line five.", fromLine: 5)))
    #expect(d.files[1].changedFromLines.isEmpty, "a new file changed nothing of the old version")
    #expect(d.files[1].added == 1)
    #expect(!d.changed(path: "notes.md", line: 5))
    #expect(!d.isEmpty)
}

@Test func theRecordedDiffWithNoHunkLineStartsAtLineOne() throws {
    let fixture = try ConsoleFixture.load("get-api-artifacts-id-diff")
    let text = try #require(fixture.replyJSON?["diff"]?.stringValue)
    let d = ArtifactDiffReading(diff: text, pathPrefix: "Artifacts/metistry/store-interface")
    #expect(d.files.map(\.path) == ["notes.md"])
    #expect(d.files[0].changedFromLines == [1, 2, 3, 4])
    #expect(d.files[0].lines.filter { $0.kind == .added }.map(\.text).first == "# Store interface")
    #expect(ArtifactDiffReading(diff: "", pathPrefix: "x").isEmpty)
}

// MARK: - The margin

@Test func twoThreadsThatWouldCollideTheLowerMovesDownEightPointsBelow() {
    // The screen's measurement: the first sits at 0 from its line, the pushed
    // one 35 below its own, 8 between the cards.
    let ys = ThreadMarginPlacement.place(wants: [0, 22], heights: [49, 30])
    #expect(ys == [0, 57])
    #expect(ys[0] - 0 == 0)
    #expect(ys[1] - 22 == 35)
    #expect(ys[1] - (ys[0] + 49) == ThreadMarginPlacement.gap)
    #expect(ThreadMarginPlacement.gap == 8)
    // Room enough: each stays level with its line.
    #expect(ThreadMarginPlacement.place(wants: [0, 120, 130], heights: [40, 40, 40]) == [0, 120, 168])
}

@MainActor
@Test func theMarginLaysCardsOutLevelWithTheirLinesByMeasurement() async throws {
    let box = FrameBox()
    let view = ThreadMarginLayout(wants: [0, 22]) {
        Color.red.frame(height: 49).measured(0, box)
        Color.red.frame(height: 30).measured(1, box)
        MarginLeader().stroke(.black).measured(10, box)
        MarginLeader().stroke(.black).measured(11, box)
    }
    .frame(width: 280)
    .coordinateSpace(name: FrameBox.space)
    let host = NSHostingView(rootView: view.fixedSize(horizontal: false, vertical: true))
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = host
    host.layoutSubtreeIfNeeded()
    try await Task.sleep(for: .milliseconds(200))
    defer { window.close() }
    let first = try #require(box.frames[0]), pushed = try #require(box.frames[1])
    #expect(first.minY == 0, "the first card sits at 0 from its line")
    #expect(pushed.minY - 22 == 35, "the pushed card is 35 below its line: \(pushed)")
    #expect(pushed.minY - first.maxY == 8, "8 between the cards")
    #expect(first.minX == ThreadMarginLayout.leaderWidth && first.width == 280 - ThreadMarginLayout.leaderWidth)
    // The pushed card's leader runs from its line down to it; the level one's draws nothing.
    let leader = try #require(box.frames[11])
    #expect(leader.minY == 22 && leader.height == 35 + ThreadMarginLayout.leaderDrop + 1, "\(leader)")
    #expect(MarginLeader().path(in: CGRect(x: 0, y: 0, width: 12, height: ThreadMarginLayout.leaderDrop + 1)).isEmpty)
    #expect(!MarginLeader().path(in: CGRect(x: 0, y: 0, width: 12, height: 46)).isEmpty)
}

@MainActor
@Test func theVersionOnScreenPutsItsThreadsOnTheirLinesAndTheRestBelow() async throws {
    let console = ArtifactsConsole()
    console.threads = [v2: [
        threadJSON("cmt_B", version: v2, line: 3, body: "Second on three", at: "2026-09-26T22:55:00.000Z"),
        threadJSON("cmt_A", version: v2, line: 3, body: "First on three", at: "2026-09-26T22:54:00.000Z"),
        threadJSON("cmt_C", version: v2, line: 1, body: "On the title"),
        threadJSON("cmt_D", version: v2, line: nil, body: "On the whole version"),
        threadJSON("cmt_E", version: v2, line: 40, body: "Past the end"),
        threadJSON("cmt_F", version: v2, line: 2, body: "Another file", path: "other.md"),
    ]]
    let (model, session) = artifactsModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.load()
    await model.open(artifactID)
    #expect(model.text?.value?.lines == ["# Store interface", "", "One protocol per domain, one method per route."])
    #expect(model.marginThreads.map(\.id) == ["cmt_C", "cmt_A", "cmt_B"], "line order, then oldest first")
    #expect(model.threadLines == [1, 3])
    #expect(Set(model.otherThreads.map(\.id)) == ["cmt_D", "cmt_E", "cmt_F"])
}

// MARK: - The list

@MainActor
@Test func theListReadsTheArtifactsAndCountsOpenThreadsAcrossVersionsInOneRead() async throws {
    let (model, console, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    #expect(model.list.map(\.slug) == ["store-interface"])
    let a = try #require(model.artifact(artifactID))
    let row = ArtifactRowWords(a, openThreads: model.openThreadCount(a.id), now: recordedNow)
    #expect(row.facts == "metistry · markdown · updated 1 hour ago")
    #expect(row.threads == "1 open thread", "the rooms query's artifact rows, counted")
    #expect(row.spoken == "store-interface, metistry, markdown, 1 open thread, updated 1 hour ago")
    // One read for the list, one for every open thread — never one per artifact.
    let asked = console.calls.map { String($0.path.split(separator: "?").first ?? "") }
    #expect(Set(asked) == ["/api/artifacts", "/api/q/rooms"], "\(asked)")
    #expect(console.calls.contains { $0.path.contains("anchor=artifact") && $0.path.contains("state=open") })
    #expect(ArtifactsWords.openThreads(.init(n: 500, atLeast: true)) == "500+ open threads", "a capped read says *at least*")
    #expect(ArtifactsWords.openThreads(.init(n: 0, atLeast: false)) == "No open threads")
}

@MainActor
@Test func anEmptyListSaysNoArtifactsYet() async throws {
    let console = ArtifactsConsole()
    console.artifacts = []
    let (model, session) = artifactsModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.load()
    let tree = try await AccessibilityProbe.snapshot(artifactsView(model).frame(width: 820, height: 600))
    defer { tree.close() }
    let said = tree.labels + tree.texts
    #expect(said.contains { $0.contains(ArtifactsWords.emptyTitle) }, "\(said)")
    #expect(said.contains { $0.contains(ArtifactsWords.emptySentence) }, "\(said)")
}

@MainActor
@Test func aConsoleWithNoVaultBridgeIsTheFailedPanelInItsOwnWords() async throws {
    let console = ArtifactsConsole()
    console.down = (503, "artifacts are not configured in this deployment")
    let (model, session) = artifactsModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.load()
    guard case .failed(let why) = model.paint else { Issue.record("\(model.paint)"); return }
    #expect(why.contains("artifacts are not configured in this deployment"), "the console's own words: \(why)")
    let tree = try await AccessibilityProbe.snapshot(artifactsView(model).frame(width: 820, height: 600))
    defer { tree.close() }
    #expect(tree.controlNames.contains(StateWords.tryAgain), "\(tree.controlNames)")
}

// MARK: - An artifact

@MainActor
@Test func theRailNumbersTheVersionsAndSaysWhoMadeEach() async throws {
    let (model, _, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    await model.open(artifactID)
    #expect(model.versionList.map(\.label) == ["v2", "v1"], "newest first, numbered from the oldest")
    let v2 = try #require(model.version(artifactV2))
    let row = VersionRowWords(v2, latest: true, openThreads: model.openThreadCount(version: v2.id), assistantName: "Aide", now: recordedNow)
    #expect(row.title == "v2 · latest")
    #expect(row.byline == "You · 1 hour ago")
    #expect(row.message == "second cut (ver_01M3FYT8NB0W22G5J1H3A71PTY)")
    #expect(row.threads == "1 open thread")
    #expect(row.spoken == "v2, latest, You, 1 hour ago, second cut (ver_01M3FYT8NB0W22G5J1H3A71PTY), 1 open thread")
    // The recorded thread is on v2, line 3 — in the margin.
    #expect(model.shownPath == "notes.md")
    #expect(model.marginThreads.map(\.line) == [3])
    #expect(model.obsidianPath == "Artifacts/metistry/store-interface/notes.md")
    #expect(ArtifactsWords.author(AgentChipModel.assistantPrincipal, assistantName: "Aide") == "Aide", "the configured name, never the internal word")
    #expect(ArtifactsWords.author("cursor", assistantName: "Aide") == "cursor")
}

@MainActor
@Test func aVersionReplacedOnDiskSaysSoOffersTheLatestAndListsItsThreads() async throws {
    let console = ArtifactsConsole()
    console.unreadable = [v1]
    console.threads = [v1: [threadJSON("cmt_old", version: v1, line: 3, body: "About the old line")], v2: []]
    let (model, session) = artifactsModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.load()
    await model.open(artifactID)
    await model.show(version: v1)
    guard case .failed(_, let code)? = model.text else { Issue.record("\(String(describing: model.text))"); return }
    #expect(code == "not_available")
    #expect(model.fallbackVersion?.label == "v2")
    #expect(model.marginThreads.isEmpty && model.otherThreads.map(\.id) == ["cmt_old"], "no line to sit on, so listed — never placed")
    let tree = try await AccessibilityProbe.snapshot(artifactsView(model).frame(width: 1100, height: 800))
    defer { tree.close() }
    let said = tree.labels + tree.texts
    #expect(said.contains { $0.contains("Couldn't Show v1") }, "\(said)")
    #expect(said.contains { $0.contains(ArtifactsWords.replaced("notes.md", model.shown!)) }, "\(said)")
    #expect(tree.controlNames.contains("Show v2"), "components-03: a version unreadable · Show v2 — \(tree.controlNames)")
    #expect(said.contains { $0.contains("About the old line") }, "\(said)")
}

@Test func theWaitSaysWhatItOpensAndHowBig() {
    let v3 = ArtifactVersionRecord(id: "ver_3", number: 3, author: "user", message: "", createdAt: nil, pathPrefix: "", files: [ArtifactFileEntry(path: "summary.md", kind: "markdown", bytes: 2_100_000)])
    #expect(ArtifactsWords.opening("vendor-summary", v3, bytes: v3.bytes) == "Opening vendor-summary · v3 · 2.1 MB")
}

@MainActor
@Test func repliesFoldToACountAndOpenInPlace() async throws {
    let console = ArtifactsConsole()
    let replies: [JSONValue] = [
        threadJSON("cmt_r1", version: v2, line: nil, body: "Agreed, will do.", author: "cursor", kind: "agent"),
        threadJSON("cmt_r2", version: v2, line: nil, body: "Thanks.", author: "user", kind: "human"),
    ]
    console.threads = [v2: [threadJSON("cmt_root", version: v2, line: 3, body: "Name the owning ticket.", replies: replies)]]
    let (model, session) = artifactsModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.load()
    await model.open(artifactID)
    let folded = try await AccessibilityProbe.snapshot(artifactsView(model).frame(width: 1100, height: 800))
    #expect(folded.controlNames.contains("Show 2 replies"), "\(folded.controlNames)")
    #expect(!(folded.labels + folded.texts).contains { $0.contains("Agreed, will do.") })
    folded.close()
    model.toggleReplies("cmt_root")
    let open = try await AccessibilityProbe.snapshot(artifactsView(model).frame(width: 1100, height: 800))
    defer { open.close() }
    #expect(open.controlNames.contains("Hide 2 replies"), "\(open.controlNames)")
    #expect((open.labels + open.texts).contains { $0.hasPrefix("cursor, ") && $0.hasSuffix(": Agreed, will do.") }, "\(open.labels)")
}

// MARK: - §2.18

@MainActor
@Test func theListAndAnArtifactSpeakEveryRowLineAndControl() async throws {
    let (model, _, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    let list = try await AccessibilityProbe.snapshot(artifactsView(model).frame(width: 820, height: 600))
    #expect(list.unlabeledControls.isEmpty, "unlabeled: \(list.unlabeledControls)")
    #expect(list.headings.contains("Artifacts"), "\(list.headings)")
    #expect((list.labels + list.texts).contains("store-interface, metistry, markdown, 1 open thread, updated 1 hour ago"), "\(list.labels)")
    list.close()

    await model.open(artifactID)
    let page = try await AccessibilityProbe.snapshot(artifactsView(model).frame(width: 1100, height: 800))
    defer { page.close() }
    #expect(page.unlabeledControls.isEmpty, "unlabeled: \(page.unlabeledControls)")
    for h in ["store-interface", ArtifactsWords.versions] {
        #expect(page.headings.contains(h), "headings: \(page.headings)")
    }
    for name in ["Back to Artifacts", ArtifactsWords.compare] {
        #expect(page.controlNames.contains { $0.hasPrefix(name) }, "controls: \(page.controlNames)")
    }
    let said = page.labels + page.texts
    #expect(said.contains { $0.hasPrefix("v2, latest, You, 1 hour ago") }, "\(said)")
    #expect(said.contains("One protocol per domain, one method per route. Line 3, 1 thread"), "a highlighted line says it has a thread: \(said)")
    #expect(said.contains("You, 10:54 PM, Line 3: Name the owning ticket beside each placeholder."), "\(said)")
    #expect(page.saysAssistant.isEmpty, "the configured name, never the internal word: \(page.saysAssistant)")
}

@MainActor
@Test func anArtifactsRowsAndCardsGrowLongerNeverWiderAtTheLargestText() throws {
    let a = ArtifactRecord(id: "art_1", project: "metistry", slug: "a-rather-long-artifact-slug-that-wraps", kind: "markdown", updatedAt: recordedNow.addingTimeInterval(-7200))
    let v = ArtifactVersionRecord(id: "ver_1", number: 12, author: "cursor", message: "Rewrote the section on rollbacks after review", createdAt: recordedNow.addingTimeInterval(-600), pathPrefix: "", files: [])
    let t = ArtifactThreadRecord(id: "cmt_1", versionID: "ver_1", path: "notes.md", line: 14, body: "This paragraph says two things; split it so each can be answered.", at: recordedNow)
    let pieces: [(String, AnyView, CGFloat)] = [
        ("row", AnyView(ArtifactRowView(row: ArtifactRowWords(a, openThreads: .init(n: 3, atLeast: false), now: recordedNow))), 320),
        ("version", AnyView(VersionRowView(row: VersionRowWords(v, latest: true, openThreads: .init(n: 1, atLeast: false), assistantName: "Aide", now: recordedNow))), ArtifactPage.railWidth),
        ("card", AnyView(ThreadCard(thread: t, unfolded: false, assistantName: "Aide", now: recordedNow, clock: ClockTime(timeZone: utc), onToggle: {})), ReadingView.marginWidth),
    ]
    for (name, view, width) in pieces {
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
@Test func openingArtifactsNeverRaisesTheWindowsMinimum() async throws {
    let (model, _, session) = try await fixtureModel()
    let down = ArtifactsConsole()
    down.down = (503, "connect ECONNREFUSED 127.0.0.1:1")
    let (failed, failedSession) = artifactsModel(down)
    let (waiting, waitingSession) = artifactsModel(ArtifactsConsole())
    defer { withExtendedLifetime([session, failedSession, waitingSession]) {} }
    await failed.load()
    let window = try await ShellProbe.acrossTheSwitch { artifactsView(model) }
    #expect(window.after.minimum.height <= max(window.before.minimum.height, 460), "opening Artifacts raised the window's minimum to \(window.after.minimum)")
    #expect(window.after.frame == window.before.frame)
    let probe = MinimumProbe()
    for (name, m) in [("list", model), ("failed", failed), ("waiting", waiting)] {
        let size = probe.minimum(of: artifactsView(m))
        #expect(size.height <= 460, "\(name) asks for \(size) at the least")
    }
    await model.open(artifactID)
    #expect(probe.minimum(of: artifactsView(model)).height <= 460, "an artifact asks too much at the least")
    await model.beginCompare()
    #expect(probe.minimum(of: artifactsView(model)).height <= 460, "Compare asks too much at the least")
}

@MainActor
@Test func everyInkOnArtifactsClearsItsGround() {
    // The highlighted line, the cards, the agent rule, Compare's bands and note.
    let pairs: [(MetistryColorRole, MetistryColorRole, Double)] = [
        (.textPrimary, .surface, 4.5), (.textSecondary, .surface, 4.5), (.textPrimary, .accentQuiet, 4.5),
        (.textPrimary, .elevated, 4.5), (.textSecondary, .elevated, 4.5), (.agent, .elevated, 4.5), (.agent, .surface, 3),
        (.textPrimary, .okQuiet, 4.5), (.ok, .okQuiet, 3), (.textPrimary, .failedQuiet, 4.5), (.failed, .failedQuiet, 3),
        (.textSecondary, .sunken, 4.5), (.textPrimary, .sunken, 4.5), (.borderControl, .surface, 3),
    ]
    for scheme in [ColorScheme.light, .dark] {
        for (ink, ground, floor) in pairs {
            let ratio = Contrast.ratio(ink, ground, scheme)
            #expect(ratio >= floor, "\(ink.rawValue) on \(ground.rawValue) is \(ratio) in \(scheme)")
        }
    }
}

@Test func noStringInArtifactsSourceSaysAssistantOrNamesOne() throws {
    let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("sources/kit")
    for file in ["artifacts-view.swift", "artifacts-model.swift"] {
        let text = try String(contentsOf: dir.appendingPathComponent(file), encoding: .utf8)
        var literals: [String] = []
        for line in text.split(separator: "\n") where !line.trimmingCharacters(in: .whitespaces).hasPrefix("//") && !line.trimmingCharacters(in: .whitespaces).hasPrefix("///") {
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
private let artifactID = "art_01M3FYT8N8HRG4S2W4Q0GN28F1"
private let artifactV2 = "ver_01M3FYT8NB0W22G5J1H3A71PTY"
private let v2 = artifactV2
private let v1 = "ver_01M3FYT8N761CDC5HKE1J3H2NZ"
/// An hour after the recorded artifacts.
private let recordedNow = WireTime.date("2026-09-26T23:54:20.000Z")!

/// `git diff` of two versions, as the reconciler runs it: two files, the
/// second new, the first changed in two hunks.
private let gitDiff = """
diff --git a/Artifacts/metistry/plan/notes.md b/Artifacts/metistry/plan/notes.md
index 3013d73..7e01f64 100644
--- a/Artifacts/metistry/plan/notes.md
+++ b/Artifacts/metistry/plan/notes.md
@@ -1,5 +1,5 @@
 # Plan

-Old line three.
+New line three.

 Line five.
@@ -10,3 +10,3 @@
 Line ten.
-Line eleven.
+Line eleven, reworded.
 Line twelve.
diff --git a/Artifacts/metistry/plan/data.json b/Artifacts/metistry/plan/data.json
new file mode 100644
index 0000000..9e26dfe
--- /dev/null
+++ b/Artifacts/metistry/plan/data.json
@@ -0,0 +1 @@
+{}

"""

@MainActor
private func artifactsModel(_ console: any ConsoleCallTransport, now: Date = recordedNow) -> (ArtifactsModel, ConsoleSession) {
    let session = ConsoleSession(transport: console, management: nil)
    return (ArtifactsModel(session: session, timeZone: utc, now: { now }), session)
}

@MainActor
private func fixtureModel() async throws -> (ArtifactsModel, FixtureConsole, ConsoleSession) {
    let console = try FixtureConsole.recorded()
    let (model, session) = artifactsModel(console)
    await model.load()
    return (model, console, session)
}

@MainActor
private func artifactsView(_ model: ArtifactsModel) -> ArtifactsView {
    ArtifactsView(model: model, assistantName: "Aide", tick: .seconds(3600), onOpenInObsidian: { _ in })
}

private func threadJSON(_ id: String, version: String, line: Int?, body: String, path: String = "notes.md", author: String = "user", kind: String = "human", at: String = "2026-09-26T22:54:15.227Z", replies: [JSONValue] = []) -> JSONValue {
    .object([
        "id": .string(id), "artifact_id": .string(artifactID), "version_id": .string(version), "work_id": .null,
        "path": .string(path), "anchor": line.map { .object(["line": .number(Double($0))]) } ?? .null,
        "body": .string(body), "state": .string("open"), "author_principal": .string(author), "author_kind": .string(kind),
        "resolved_by": .null, "resolved_at": .null, "parent_id": .null, "created_at": .string(at), "replies": .array(replies),
    ])
}

/// Frames reported from inside a layout, in its own coordinate space.
@MainActor
private final class FrameBox {
    static let space = "margin-probe"
    var frames: [Int: CGRect] = [:]
}

private extension View {
    @MainActor
    func measured(_ key: Int, _ box: FrameBox) -> some View {
        onGeometryChange(for: CGRect.self) { $0.frame(in: .named(FrameBox.space)) } action: { box.frames[key] = $0 }
    }
}

/// The recorded fixtures, with what a test needs said differently: a
/// version's threads, a version whose file was replaced on disk, the list,
/// and a console that is down.
private final class ArtifactsConsole: ConsoleCallTransport, @unchecked Sendable {
    private let lock = NSLock()
    private let fallback = try! FixtureConsole.recorded()
    private var _artifacts: [JSONValue]?
    private var _threads: [String: [JSONValue]]?
    private var _unreadable: Set<String> = []
    private var _down: (Int, String)?
    private var _calls: [FixtureCall] = []

    var artifacts: [JSONValue]? { get { lock.withLock { _artifacts } } set { lock.withLock { _artifacts = newValue } } }
    var threads: [String: [JSONValue]]? { get { lock.withLock { _threads } } set { lock.withLock { _threads = newValue } } }
    var unreadable: Set<String> { get { lock.withLock { _unreadable } } set { lock.withLock { _unreadable = newValue } } }
    var down: (Int, String)? { get { lock.withLock { _down } } set { lock.withLock { _down = newValue } } }
    var calls: [FixtureCall] { lock.withLock { _calls } }

    func call(_ method: String, _ path: String, body: Data?, idempotencyKey: String?) async -> Result<Data, ConsoleError> {
        let sent = body.flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) }
        lock.withLock { _calls.append(FixtureCall(method: method, path: path, body: sent, idempotencyKey: idempotencyKey, lastEventID: nil, servedBy: nil)) }
        let bare = String(path.split(separator: "?", maxSplits: 1).first ?? "")
        let query = ConsoleFixture.query(of: path)
        if let (status, message) = down {
            return .failure(.http(status: status, envelope: ConsoleErrorEnvelope(code: "not_available", message: message)))
        }
        if method == "GET", bare == "/api/artifacts", let rows = artifacts {
            return .success(try! JSONEncoder().encode(JSONValue.object(["artifacts": .array(rows), "as_of": .string("2026-09-26T22:54:15.214Z")])))
        }
        if method == "GET", bare.hasSuffix("/comments"), let threads, let version = query["version"] {
            return .success(try! JSONEncoder().encode(JSONValue.object(["threads": .array(threads[version] ?? [])])))
        }
        if method == "GET", bare.hasSuffix("/file"), bare.split(separator: "/").contains(where: { unreadable.contains(String($0)) }) {
            return .failure(.http(status: 503, envelope: ConsoleErrorEnvelope(code: "not_available", message: "this version's content has been superseded on the working tree; use diff")))
        }
        return await fallback.call(method, path, body: body, idempotencyKey: idempotencyKey)
    }
}
#endif

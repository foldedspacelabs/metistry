// History in the app (T10-7): Settings ▸ Instance ▸ History and a Knowledge
// page's history with Restore. Built against the recorded fixtures first —
// the vault status, a page's history and one version, the restore and the
// rollback — and a scripted console where a fixture cannot say it (a remote
// client, a stale file, a local_only refusal, a restorable history).
//
// The ticket's own test is the first: **Roll Back names what it will undo**.
// Then the accept line moved here from T10-5: **Knowledge shows a restore
// request inline, and answering it there answers it in Needs You**. Then
// ruling 7 at the tool — **neither Restore nor Roll Back is drawn, or sent,
// for a remote client** — and §2.18.

#if os(macOS)
import AppKit
import Foundation
import SwiftUI
import Testing

@testable import MetistryKit

// MARK: - The ticket's own

@MainActor
@Test func rollBackNamesWhatItWillUndo() async throws {
    let console = HistoryConsole()
    let (model, session) = historyModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.refreshIfDue()
    #expect(model.reach == .local)

    // Before anything is sent, the choice names what it is.
    model.openRollback()
    #expect(model.rollbackOpen)
    #expect(model.choice == .lastCommit)
    #expect(model.targetLine(assistantName: "Aide") == "Undo 4c1d2e3 “Tick 1 task” by You.")
    #expect(model.target == .commit("4c1d2e3f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d"))

    model.choice = .commit
    model.commitText = "HEAD~1"
    #expect(model.target == nil, "only a commit id is ever sent")
    #expect(model.targetProblem == "A commit id is 7 to 64 hex characters.")
    model.commitText = "9ab8c7d6"
    #expect(model.target == .commit("9ab8c7d6"))

    console.reset()
    await model.requestRollback()
    let sent = try #require(console.calls.first { $0.method == "POST" })
    #expect(sent.path == "/api/vault/rollback")
    #expect(sent.body == .object(["commit": .string("9ab8c7d6")]))

    // The answer changes nothing; it names what Approve would undo.
    guard case .raised(let preview) = model.rollback else { Issue.record("not raised: \(model.rollback)"); return }
    #expect(preview.proposalID == 7)
    #expect(preview.summary == "Undoes 1 commit and puts back 1 file.")
    #expect(preview.commitLines(assistantName: "Aide", clock: model.clock) == ["9ab8c7d “Fold: the store interface” — by Aide, 28 Sep"])
    #expect(preview.files == ["Projects/Metistry/Roadmap.md"])
    #expect(preview.skippedConfig == [".metistry/compute.yaml"])
    #expect(preview.base?.subject == "Start the plan")

    // …and the sheet says it, commit by commit and file by file.
    let tree = try await AccessibilityProbe.snapshot(RollbackSheet(model: model, assistantName: "Aide").frame(width: 520, height: 700))
    defer { tree.close() }
    let said = tree.labels + tree.texts
    for line in ["9ab8c7d “Fold: the store interface” — by Aide, 28 Sep", "Projects/Metistry/Roadmap.md", VaultHistoryWords.waitingInNeedsYou, "Undoes 1 commit and puts back 1 file."] {
        #expect(said.contains(line), "said: \(said)")
    }
    #expect(tree.headings.contains("What Approve Undoes"), "\(tree.headings)")
    #expect(tree.unlabeledControls.isEmpty, "unlabeled: \(tree.unlabeledControls)")
}

// MARK: - The accept: a restore request, inline

@MainActor
@Test func knowledgeShowsARestoreRequestInlineAndAnsweringItThereAnswersItInNeedsYou() async throws {
    let console = HistoryConsole()
    console.commits = restorableHistory
    let (model, session) = knowledgePageModel(console)
    defer { withExtendedLifetime(session) {} }
    var told = 0
    model.onQueueChanged = { told += 1 }
    await model.load()
    await model.go(to: .page(roadmap))

    let commits = try #require(model.history?.value)
    #expect(commits.map(\.short) == ["4c1d2e3", "9ab8c7d"])
    #expect(model.restoreOffer(commits[0], isNewest: true, on: roadmap) == .current)
    #expect(model.restoreOffer(commits[1], isNewest: false, on: roadmap) == .offered(disabledBecause: nil))

    // Restore asks — with the hash of the page as it was drawn — and writes nothing.
    console.reset()
    await model.restore(commits[1])
    let asked = try #require(console.calls.first { $0.method == "POST" })
    #expect(asked.path == "/api/knowledge/restore")
    #expect(asked.body == .object(["path": .string(roadmap), "sha": .string(commits[1].sha), "seen_sha": .string(pageSHA)]))
    #expect(console.calls.filter { $0.method == "POST" }.count == 1, "no write rides the ask")
    #expect(told == 1, "the shell's count hears the new request")

    // The request is Needs You's; the page finds it by payload.restore.path.
    let row = try #require(model.restoreRequest(for: roadmap))
    #expect(row.id == 6)
    #expect(model.restoreOffer(commits[1], isNewest: false, on: roadmap) == .offered(disabledBecause: VaultHistoryWords.restoreWaiting), "one restore waits at a time")
    let tree = try await AccessibilityProbe.snapshot(knowledgeHistoryView(model).frame(width: 820, height: 2400))
    #expect(tree.headings.contains { $0.hasPrefix(KnowledgeWords.restoreWaiting) }, "\(tree.headings)")
    let said = tree.labels + tree.texts
    #expect(said.contains(KnowledgeWords.answeredThere), "\(said)")
    for verb in ["Approve", "Revise", "Decline"] {
        #expect(tree.controlNames.contains { $0.hasPrefix(verb) }, "controls: \(tree.controlNames)")
    }
    tree.close()

    // Approve here is the same POST Needs You sends, on the same row.
    let card = try #require(model.cards(assistantName: "Aide")).card(for: row)
    console.reset()
    await card.press(.primary)
    let answered = try #require(console.calls.first { $0.method == "POST" })
    #expect(answered.path == "/api/proposals/6")
    #expect(answered.body?["decision"]?.stringValue == "allow")
    #expect(card.isSettled)
    console.proposals = []
    await model.restoreAnswered(roadmap)
    #expect(model.restoreRequest(for: roadmap) == nil)
    #expect(console.calls.contains { $0.path.hasPrefix("/api/knowledge/page?") }, "the page Approve changed is read again")
    #expect(told >= 2, "the shell's count hears the answer")
}

@MainActor
@Test func thePagesRecordedHistoryReadsAcrossTheRenameAndShowsAnOldVersion() async throws {
    let console = HistoryConsole()
    let (model, session) = knowledgePageModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.load()
    await model.go(to: .page(roadmap))
    let commits = try #require(model.history?.value)
    #expect(commits.count == 3)
    #expect(commits.map(\.change) == ["renamed", "modified", "added"])
    // The door restores a page under its own name: a commit that knew it by
    // an earlier one offers no Restore, and says why.
    #expect(model.restoreOffer(commits[0], isNewest: true, on: roadmap) == .current)
    #expect(model.restoreOffer(commits[1], isNewest: false, on: roadmap) == .renamed)
    #expect(commits[1].spoken(assistantName: "Aide", clock: model.clock, now: recorded) == "Fold: the store interface, by Aide, 3:00 AM, modified, 9ab8c7d")
    #expect(commits[1].spoken(assistantName: nil, clock: model.clock, now: recorded) == "Fold: the store interface, 3:00 AM, modified, 9ab8c7d", "no name known: no author, never a default")

    // Show This Version asks for it under the name it had then.
    console.reset()
    await model.toggleVersion(commits[1])
    let read = try #require(console.calls.first)
    #expect(read.path == "/api/knowledge/version?path=Projects%2FMetistry%2FPlan.md&sha=9ab8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0")
    #expect(model.versions[commits[1].sha]?.value == "# Plan\n\nShip the store interface.\n")
    await model.toggleVersion(commits[1])
    #expect(model.versions[commits[1].sha] == nil, "Hide This Version")
}

// MARK: - Ruling 7, at the tool

@MainActor
@Test func aRemoteClientIsNeverDrawnRestoreOrRollBackAndSendsNeither() async throws {
    let console = HistoryConsole()
    console.via = "passkey_session"
    console.commits = restorableHistory

    let (page, pageSession) = knowledgePageModel(console)
    let (settings, settingsSession) = historyModel(console)
    defer { withExtendedLifetime([pageSession, settingsSession]) {} }
    await page.load()
    await page.go(to: .page(roadmap))
    await settings.refreshIfDue()
    #expect(page.reach == .remote(via: "passkey_session"))
    #expect(settings.reach == .remote(via: "passkey_session"))

    let commits = try #require(page.history?.value)
    #expect(page.restoreOffer(commits[1], isNewest: false, on: roadmap) == .notHere)
    console.reset()
    await page.restore(commits[1])
    settings.openRollback()
    #expect(!settings.rollbackOpen)
    await settings.requestRollback()
    #expect(console.calls.filter { $0.method == "POST" }.isEmpty, "nothing was sent: \(console.calls)")
    #expect(settings.rollback == .refused(VaultHistoryWords.onlyTheMac))
    #expect(page.restoreNote?.phase == .refused(VaultHistoryWords.onlyTheMac))

    let pageTree = try await AccessibilityProbe.snapshot(knowledgeHistoryView(page).frame(width: 820, height: 2000))
    defer { pageTree.close() }
    #expect(!pageTree.controlNames.contains { $0.hasPrefix(VaultHistoryWords.restore) }, "\(pageTree.controlNames)")
    #expect((pageTree.labels + pageTree.texts).contains(VaultHistoryWords.onlyTheMac))

    let paneTree = try await AccessibilityProbe.snapshot(InstanceHistorySection(model: settings, assistantName: "Aide").frame(width: 600))
    defer { paneTree.close() }
    #expect(!paneTree.controlNames.contains { $0.hasPrefix("Roll Back") }, "\(paneTree.controlNames)")
    #expect((paneTree.labels + paneTree.texts).contains(VaultHistoryWords.onlyTheMac))
}

@MainActor
@Test func aLocalOnlyAnswerTakesRestoreAndRollBackAway() async throws {
    let console = HistoryConsole()
    console.commits = restorableHistory
    let localOnly = JSONValue.object(["error": .object(["code": .string("local_only"), "message": .string("this door is the local owner's alone")])])
    console.restoreAnswer = (403, localOnly)
    console.rollbackAnswer = (403, localOnly)

    let (page, pageSession) = knowledgePageModel(console)
    let (settings, settingsSession) = historyModel(console)
    defer { withExtendedLifetime([pageSession, settingsSession]) {} }
    await page.load()
    await page.go(to: .page(roadmap))
    await settings.refreshIfDue()
    let commits = try #require(page.history?.value)
    #expect(page.reach == .local)

    await page.restore(commits[1])
    #expect(page.reach == .remote(via: "local_only"))
    #expect(page.restoreOffer(commits[1], isNewest: false, on: roadmap) == .notHere)

    settings.openRollback()
    await settings.requestRollback()
    #expect(settings.reach == .remote(via: "local_only"))
    #expect(settings.rollback == .refused(VaultHistoryWords.onlyTheMac))
}

@MainActor
@Test func aStaleRestoreSaysSoAndReadsThePageAgainRaisingNothing() async throws {
    let console = HistoryConsole()
    console.commits = restorableHistory
    console.restoreAnswer = (409, .object([
        "error": .object(["code": .string("conflict"), "message": .string("Projects/Metistry/Roadmap.md changed after you saw it")]),
        "reason": .string("stale"),
        "file": .object(["path": .string(roadmap), "sha256": .string(String(repeating: "d", count: 64)), "bytes": .number(90)]),
    ]))
    let (model, session) = knowledgePageModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.load()
    await model.go(to: .page(roadmap))
    let commits = try #require(model.history?.value)
    console.reset()
    await model.restore(commits[1])
    guard case .refused(let why)? = model.restoreNote?.phase else { Issue.record("\(String(describing: model.restoreNote))"); return }
    #expect(why.hasPrefix("This page changed after you read it"))
    #expect(console.calls.contains { $0.path.hasPrefix("/api/knowledge/page?") }, "the page is read again")
    #expect(model.page?.value != nil, "what was on screen stayed while it was read")
    #expect(model.restoreRequest(for: roadmap) == nil)
}

@MainActor
@Test func restoreIsADecisionAndWaitsForTheConnection() async throws {
    let console = HistoryConsole()
    console.commits = restorableHistory
    let (model, session) = knowledgePageModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.load()
    await model.go(to: .page(roadmap))
    let commits = try #require(model.history?.value)
    #expect(ConsoleAct.of("POST", "/api/knowledge/restore") == .decision)
    #expect(ConsoleAct.of("POST", "/api/vault/rollback") == .decision)
    console.down = true
    await model.readPage(roadmap, quietly: true)
    #expect(!model.allowsDecisions)
    #expect(model.restoreOffer(commits[1], isNewest: false, on: roadmap) == .offered(disabledBecause: StateWords.unreachable))
}

// MARK: - Settings ▸ Instance ▸ History

@Test func theRecordedStatusReadsEveryFactTheSectionShows() throws {
    let fixture = try ConsoleFixture.load("get-api-vault-status")
    let sync = VaultSyncRead.from(try #require(fixture.replyJSON))
    let clock = ClockTime(timeZone: utc)
    #expect(sync.push == VaultHistoryWords.afterEveryCommit)
    #expect(sync.pull == "Every 5m")
    #expect(sync.branch == "main")
    #expect(sync.aheadBehind == "2 ahead · 0 behind origin")
    #expect(sync.aheadBehindSpoken == "2 commits not yet pushed to origin, 0 commits from origin not yet here")
    #expect(sync.lastCommit?.short == "4c1d2e3")
    #expect(sync.lastPushFailed)
    #expect(sync.pushLine(clock: clock, now: recorded) == "Failed 12:58 PM — fatal: unable to access 'https://github.com/example/vault.git/': Could not resolve host: github.com")
    #expect(sync.pullLine(clock: clock, now: recorded) == "Pulled 1:00 PM")
    #expect(sync.conflict == nil)

    // The other shapes the route serves, said rather than worked out.
    let other = VaultSyncRead.from(.object([
        "branch": .string("main"), "remote": .null, "ahead": .null, "behind": .null,
        "conflict": .object(["paths": .array([.string("Areas/Plan.md")])]),
        "policy": .object(["push": .object(["every": .string("15m")]), "pull": .object(["every": .string("1h")]), "push_override": .string("30m")]),
    ]))
    #expect(other.aheadBehind == VaultHistoryWords.noRemote)
    #expect(other.push == "Every 15m")
    #expect(other.pull == "Every 1h")
    #expect(other.pushOverride == "30m")
    #expect(other.conflict == ["Areas/Plan.md"])
    #expect(other.pushLine(clock: clock, now: recorded) == VaultHistoryWords.notSinceStart)
    #expect(VaultSyncRead.cadence(.string("manual"), words: "") == VaultHistoryWords.manual)
}

@MainActor
@Test func theHistorySectionSpeaksEveryFactAndNamesEveryControl() async throws {
    let console = HistoryConsole()
    let (model, session) = historyModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.refreshIfDue()
    let tree = try await AccessibilityProbe.snapshot(InstanceHistorySection(model: model, assistantName: "Aide").frame(width: 600))
    defer { tree.close() }
    #expect(tree.unlabeledControls.isEmpty, "unlabeled: \(tree.unlabeledControls)")
    #expect(tree.controlNames.contains { $0.hasPrefix("Roll Back") }, "\(tree.controlNames)")
    let said = tree.labels + tree.texts
    for line in [
        "Ahead and behind, 2 commits not yet pushed to origin, 0 commits from origin not yet here",
        "Push, After every commit", "Pull, Every 5m", "Conflict, None",
    ] {
        #expect(said.contains(line), "said: \(said)")
    }
    #expect(said.contains { $0.hasPrefix("Last push, Failed") }, "\(said)")
    #expect(tree.saysAssistant.isEmpty, "\(tree.saysAssistant)")
}

@MainActor
@Test func aHistoryRowGrowsLongerNeverWiderAtTheLargestText() async throws {
    let console = HistoryConsole()
    console.commits = restorableHistory
    let (model, session) = knowledgePageModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.load()
    await model.go(to: .page(roadmap))
    let commit = try #require(model.history?.value?.last)
    // Settings' facts are the system text styles, which the Settings window
    // sizes itself: they must wrap inside the pane (§2.18.5, "longer, never
    // wider"); Knowledge's type is the product's own and grows as well.
    let pieces: [(String, AnyView, grows: Bool)] = [
        ("commit row", AnyView(KnowledgeCommitRow(model: model, commit: commit, offer: .offered(disabledBecause: VaultHistoryWords.restoreWaiting), assistantName: "Aide")), true),
        ("fact", AnyView(HistoryFact("Last push", "Failed 12:58 PM — fatal: unable to access 'https://github.com/example/vault.git/': Could not resolve host: github.com")), false),
        ("rule", AnyView(KnowledgeRule(text: VaultHistoryWords.restoreRule)), true),
    ]
    let width: CGFloat = 360
    for (name, view, grows) in pieces {
        var heights: [DynamicTypeSize: CGFloat] = [:]
        for size in [DynamicTypeSize.large, .accessibility5] {
            let renderer = ImageRenderer(content: view.frame(width: width).environment(\.dynamicTypeSize, size))
            renderer.proposedSize = ProposedViewSize(width: width, height: nil)
            renderer.scale = 1
            let image = try #require(renderer.cgImage, "\(name) did not render")
            #expect(CGFloat(image.width) <= width, "\(name) is \(image.width) wide at \(size), offered \(width)")
            heights[size] = CGFloat(image.height)
        }
        if grows {
            #expect((heights[.accessibility5] ?? 0) > (heights[.large] ?? 0), "\(name) did not grow at the largest text: \(heights)")
        } else {
            #expect((heights[.large] ?? 0) > 40, "\(name) wraps rather than widening: \(heights)")
        }
    }
}

@MainActor
@Test func aPagesHistorySpeaksEachRowAsOneAndNamesItsVerbs() async throws {
    let console = HistoryConsole()
    console.commits = restorableHistory
    let (model, session) = knowledgePageModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.load()
    await model.go(to: .page(roadmap))
    let tree = try await AccessibilityProbe.snapshot(knowledgeHistoryView(model).frame(width: 820, height: 2000))
    defer { tree.close() }
    #expect(tree.unlabeledControls.filter { $0.role != "AXTextField" }.isEmpty, "unlabeled: \(tree.unlabeledControls)")
    #expect(tree.headings.contains("History, 2"), "\(tree.headings)")
    let said = tree.labels + tree.texts
    #expect(said.contains("Fold: the store interface, by Aide, 3:00 AM, modified, 9ab8c7d"), "\(said)")
    #expect(tree.controlNames.contains { $0.hasPrefix(VaultHistoryWords.restore) }, "\(tree.controlNames)")
    #expect(tree.controlNames.contains { $0.hasPrefix(VaultHistoryWords.showVersion) }, "\(tree.controlNames)")
}

@Test func theHistoryFilesBindNoKeyMoveNothingAndNameNoAssistant() throws {
    let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("sources/kit")
    for file in ["settings-panes/instance-pane.swift", "vault-history-model.swift"] {
        let text = try String(contentsOf: dir.appendingPathComponent(file), encoding: .utf8)
        // §2.18.4: nothing moves, so Reduce Motion has nothing to stop.
        #expect(!text.contains("withAnimation") && !text.contains(".animation(") && !text.contains(".transition("), "\(file)")
        // No bare key outside the menu table (C119).
        #expect(!text.contains(".keyboardShortcut("), "\(file)")
        #expect(text.range(of: #"\bMetis\b"#, options: .regularExpression) == nil, "\(file)")
    }
}

@Test func whoMadeACommitIsTheConfiguredNameAndNeverADefault() {
    #expect(VaultWho.name(source: "user", author: "Metistry user", assistantName: "Aide") == "You")
    #expect(VaultWho.name(source: "assistant", author: nil, assistantName: "Aide") == "Aide")
    #expect(VaultWho.name(source: "assistant", author: nil, assistantName: nil) == nil)
    #expect(VaultWho.name(source: nil, author: "Metistry assistant", assistantName: "Aide") == "Aide")
    #expect(VaultWho.name(source: "crew:scout", author: nil, assistantName: "Aide") == "crew:scout")
    #expect(VaultWho.name(source: nil, author: "Matt", assistantName: "Aide") == "Matt")
}

// MARK: - Helpers

private let utc = TimeZone(identifier: "UTC")!
private let recorded = WireTime.date("2026-09-28T13:05:00.000Z")!
private let roadmap = "Projects/Metistry/Roadmap.md"
/// `GET /api/knowledge/page`'s recorded hash for the roadmap.
private let pageSHA = "c31a1846c78fc9467423d751eb50c09895c3fcead1f3a6abdf2548453c86d901"

/// Two commits under the page's own name — the recorded history crosses a
/// rename, so no older commit in it is restorable under this name.
private let restorableHistory: [JSONValue] = [
    .object(["sha": .string("4c1d2e3f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d"), "path": .string(roadmap), "change": .string("modified"), "subject": .string("Tick 1 task"), "author": .string("Metistry user"), "source": .string("user"), "runs": .array([]), "turns": .array([]), "at": .string("2026-09-28T12:58:01.000Z")]),
    .object(["sha": .string("9ab8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0"), "path": .string(roadmap), "change": .string("modified"), "subject": .string("Fold: the store interface"), "author": .string("Metistry assistant"), "source": .string("assistant"), "runs": .array([.string("4107")]), "turns": .array([]), "at": .string("2026-09-28T03:00:00.000Z")]),
]

@MainActor
private func historyModel(_ console: any ConsoleCallTransport) -> (VaultHistoryModel, ConsoleSession) {
    let session = ConsoleSession(transport: console, management: nil)
    return (VaultHistoryModel(session: session, timeZone: utc, now: { recorded }), session)
}

@MainActor
private func knowledgePageModel(_ console: any ConsoleCallTransport) -> (KnowledgeModel, ConsoleSession) {
    let session = ConsoleSession(transport: console, management: nil)
    return (KnowledgeModel(session: session, timeZone: utc, conflictHold: .seconds(3600), now: { recorded }), session)
}

@MainActor
private func knowledgeHistoryView(_ model: KnowledgeModel) -> KnowledgeView {
    KnowledgeView(model: model, assistantName: "Aide", tick: .seconds(3600), onOpenInObsidian: { _ in }, onChooseFolder: {})
}

/// The recorded fixtures, with who this client is, the queue, a page's
/// history and the two asks scripted where a test needs them to say
/// something else — and a console that is down.
private final class HistoryConsole: ConsoleCallTransport, @unchecked Sendable {
    private let lock = NSLock()
    private let fallback = try! FixtureConsole.recorded()
    private var _via = "local_owner_token"
    private var _proposals: [RequestRow]?
    private var _commits: [JSONValue]?
    private var _restore: (Int, JSONValue)?
    private var _rollback: (Int, JSONValue)?
    private var _down = false
    private var _calls: [FixtureCall] = []

    var via: String { get { lock.withLock { _via } } set { lock.withLock { _via = newValue } } }
    var proposals: [RequestRow]? { get { lock.withLock { _proposals } } set { lock.withLock { _proposals = newValue } } }
    var commits: [JSONValue]? { get { lock.withLock { _commits } } set { lock.withLock { _commits = newValue } } }
    var restoreAnswer: (Int, JSONValue)? { get { lock.withLock { _restore } } set { lock.withLock { _restore = newValue } } }
    var rollbackAnswer: (Int, JSONValue)? { get { lock.withLock { _rollback } } set { lock.withLock { _rollback = newValue } } }
    var down: Bool { get { lock.withLock { _down } } set { lock.withLock { _down = newValue } } }
    var calls: [FixtureCall] { lock.withLock { _calls } }
    func reset() { lock.withLock { _calls.removeAll() } }

    func call(_ method: String, _ path: String, body: Data?, idempotencyKey: String?) async -> Result<Data, ConsoleError> {
        let sent = body.flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) }
        lock.withLock { _calls.append(FixtureCall(method: method, path: path, body: sent, idempotencyKey: idempotencyKey, lastEventID: nil, servedBy: nil)) }
        if down { return .failure(.transport("connect ECONNREFUSED 127.0.0.1:1")) }
        let bare = String(path.split(separator: "?", maxSplits: 1).first ?? "")
        func encode(_ json: JSONValue) -> Result<Data, ConsoleError> { .success(try! JSONEncoder().encode(json)) }
        func refuse(_ status: Int, _ json: JSONValue) -> Result<Data, ConsoleError> { .failure(.http(status: status, envelope: ConsoleErrorEnvelope(json: json))) }
        switch (method, bare) {
        case ("GET", "/api/whoami"):
            return encode(.object(["principal": .string("user"), "via": .string(via), "management": .bool(via == "local_owner_token")]))
        case ("GET", "/api/proposals"):
            if let rows = proposals { return .success(try! JSONEncoder().encode(RequestPage(proposals: rows))) }
        case ("GET", "/api/knowledge/history"):
            if let commits { return encode(.object(["path": .string(roadmap), "commits": .array(commits), "limit": .number(50), "as_of": .string("2026-09-28T13:05:00.000Z")])) }
        case ("POST", "/api/knowledge/restore"):
            if let (status, json) = restoreAnswer { return refuse(status, json) }
            // Raised: from now on the queue holds the request the recorded answer carries.
            let reply = try! ConsoleFixture.load("post-api-knowledge-restore")
            let row = try! JSONDecoder().decode(RequestRow.self, from: JSONEncoder().encode(reply.replyJSON!["proposal"]!))
            proposals = [row]
            return .success(reply.reply)
        case ("POST", "/api/vault/rollback"):
            if let (status, json) = rollbackAnswer { return refuse(status, json) }
        default:
            break
        }
        return await fallback.call(method, path, body: body, idempotencyKey: idempotencyKey)
    }
}
#endif

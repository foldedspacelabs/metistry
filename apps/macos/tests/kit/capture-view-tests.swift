// The capture composer (T5-5). Built against the recorded `POST /capture`
// fixture first, then a scripted console that can do what the fixture cannot:
// lose a reply after writing, stop answering, refuse, and replay a key the way
// `apps/console/src/server.ts` does (the ORIGINAL response, never a new row).
//
// The ticket's two bold tests come first: **a retry reuses the key**, and **a
// replay renders as the same capture**. Then the draft on Esc, the queue, the
// line, an instance switch, and §2.18. The view tests are macOS only, as the
// accessibility probe is (shell-accessibility-tests.swift).

import Foundation
import SwiftUI
import Testing
#if os(macOS)
import AppKit
#endif

@testable import MetistryKit

// MARK: - The ticket's two

@MainActor
@Test func aRetryReusesTheKey() async throws {
    // Offline: the console gives no answer, then comes back.
    let console = CaptureConsole(script: [.down, .answer])
    let (model, session, scheduled) = composer(console)
    defer { withExtendedLifetime(session) {} }

    model.draft = "Call the landlord about the lease"
    await model.capture()
    #expect(model.draft.isEmpty, "the words left the field for the pending capture")
    #expect(model.line == .queued(count: 1))
    #expect(scheduled.delays == [CaptureComposerModel.retryPolicy.interval], "a resend is scheduled, not spun")

    await scheduled.runAll()
    let keys = console.calls.map(\.key)
    #expect(keys.count == 2)
    #expect(keys[0] != nil && keys[0] == keys[1], "the queue's resend carries the key minted on Capture: \(keys)")
    #expect(console.calls.allSatisfy { $0.body?["note"]?.stringValue == "Call the landlord about the lease" })

    // Refused: Retry — the line's, or Capture pressed again on the unchanged words — reuses it too.
    let refusing = CaptureConsole(script: [.refuse(500, "internal", "inbox write failed"), .refuse(500, "internal", "inbox write failed"), .answer])
    let (again, session2, _) = composer(refusing)
    defer { withExtendedLifetime(session2) {} }
    again.draft = "Book the dentist"
    await again.capture()
    #expect(again.line == .failed(reason: "inbox write failed"))
    #expect(again.draft == "Book the dentist", "the words come back into the field")
    await again.retry()
    #expect(again.draft == "Book the dentist", "a second refusal leaves them there")
    await again.capture()
    let retried = refusing.calls.map(\.key)
    #expect(retried.count == 3 && Set(retried).count == 1, "Retry and Capture-on-unchanged-words both reuse the key: \(retried)")
    #expect(again.line.text.hasPrefix("captured → inbox #"))

    // A NEW capture is a new key, and never one already used.
    again.draft = "Something else"
    await again.capture()
    #expect(refusing.calls.last?.key != retried.first!, "a new capture mints its own key")
}

@MainActor
@Test func aReplayRendersAsTheSameCapture() async throws {
    // The first attempt reaches the console and is written — then the reply is
    // lost. The resend with the same key gets the ORIGINAL response back.
    let console = CaptureConsole(script: [.lose, .answer])
    let (model, session, scheduled) = composer(console)
    defer { withExtendedLifetime(session) {} }

    model.draft = "Pick up the dry cleaning"
    await model.capture()
    #expect(model.line == .queued(count: 1), "no answer is a queue, not a failure")
    #expect(console.written.count == 1, "…although the console did write it")

    await scheduled.runAll()
    #expect(console.written.count == 1, "the resend was a replay, not a second row")
    #expect(console.replays == 1)
    let original = try #require(console.written.first)
    #expect(model.lastReceipt == original, "the receipt is the original row's")
    #expect(model.line == .captured(original))
    #expect(model.line.text == "captured → inbox #\(original.id) · \(original.path)")
    #expect(model.captures.isEmpty, "one capture, resolved — not two")
}

// MARK: - Against the recorded fixture (U9)

@MainActor
@Test func aCaptureSendsTheNoteWithAKeyAndShowsTheRecordedReceipt() async throws {
    let fixture = try ConsoleFixture.load("post-capture")
    let console = FixtureConsole([fixture])
    let session = ConsoleSession(transport: console, management: nil)
    let model = CaptureComposerModel(session: session)
    var heard: [String] = []
    model.announce = { heard.append($0) }
    defer { withExtendedLifetime(session) {} }

    let note = try #require(fixture.body?["note"]?.stringValue)
    #expect(!model.canCapture, "nothing to send in an empty field")
    model.draft = "   \n  "
    #expect(!model.canCapture, "…or a blank one")
    model.draft = note
    await model.capture()

    let call = try #require(console.calls.first)
    #expect(call.method == "POST" && call.path == "/capture" && call.servedBy == "post-capture")
    #expect(call.body == .fields(["note": .string(note)]), "a note, and nothing else: no title, no classification")
    let key = try #require(call.idempotencyKey)
    #expect(!key.isEmpty && key.count <= 200, "the console's key ceiling")

    let receipt = try #require(model.lastReceipt)
    #expect(receipt.id == fixture.replyJSON?["id"]?.intValue)
    #expect(receipt.path == fixture.replyJSON?["path"]?.stringValue)
    #expect(model.line.text == "captured → inbox #\(receipt.id) · \(receipt.path)", "the id and the path, because those are what came back")
    #expect(heard == ["Captured, inbox \(receipt.id), \(receipt.path)"], "announced once")
}

// MARK: - The draft

@MainActor
@Test func escKeepsTheDraftUntilItIsSent() async throws {
    let console = CaptureConsole(script: [.answer])
    let (model, session, _) = composer(console)
    defer { withExtendedLifetime(session) {} }

    model.present()
    model.draft = "half a thought"
    model.dismiss()
    #expect(!model.isPresented)
    #expect(model.draft == "half a thought", "Esc closes; it never discards")
    model.present()
    #expect(model.draft == "half a thought")
    #expect(console.calls.isEmpty, "opening and closing sends nothing")

    await model.capture()
    #expect(model.draft.isEmpty, "sent, so gone from the field")
}

// MARK: - The queue

@MainActor
@Test func aQueuedCaptureGoesThroughTheGateWhileDecisionsAreHeld() async throws {
    let console = CaptureConsole(script: [.down, .down, .answer])
    let (model, session, scheduled) = composer(console)
    defer { withExtendedLifetime(session) {} }

    model.draft = "water the plants"
    await model.capture()
    #expect(!session.allowsDecisions, "the gate heard no answer")
    #expect(model.line.text == CaptureLine.queuedWords)

    // O3: a capture is an append — the resend is SENT, never refused before it goes.
    await scheduled.runAll()
    #expect(console.calls.count == 2, "the resend went on the wire")
    #expect(model.line == .queued(count: 1))
    #expect(scheduled.delays == [10, 20], "backing off while nothing answers")

    await scheduled.runAll()
    #expect(console.calls.count == 3)
    #expect(model.line.text.hasPrefix("captured → inbox #"))
    #expect(session.allowsDecisions)
}

@MainActor
@Test func openingTheComposerTriesTheQueue() async throws {
    let console = CaptureConsole(script: [.down, .answer])
    let (model, session, _) = composer(console)
    defer { withExtendedLifetime(session) {} }

    model.draft = "renew the passport"
    await model.capture()
    #expect(model.line == .queued(count: 1))
    model.dismiss()
    model.present()
    try await waitUntil { console.calls.count == 2 }
    try await waitUntil { model.lastReceipt != nil }
    #expect(Set(console.calls.map(\.key)).count == 1)
}

// MARK: - The line

@MainActor
@Test func theLineShowsTheOldestUnresolvedWithACountAndAFailureWins() {
    #expect(CaptureLine.sending(count: 1).text == "capturing… you can close this")
    #expect(CaptureLine.sending(count: 2).text == "capturing… (2)")
    #expect(CaptureLine.queued(count: 1).text == "queued — will send when the instance is reachable")
    #expect(CaptureLine.queued(count: 3).text == "queued — will send when the instance is reachable (3)")
    let receipt = CaptureReceipt(id: 418, path: "Inbox/2026-09-20-note.md", sha256: "x")
    #expect(CaptureLine.captured(receipt).text == "captured → inbox #418 · Inbox/2026-09-20-note.md")
    #expect(CaptureLine.captured(receipt).spoken == "Captured, inbox 418, Inbox/2026-09-20-note.md")

    // Neither the queued chip nor a failure differs from the rest by colour alone.
    let queued = CaptureLine.queued(count: 1).mark(on: .elevated)
    #expect(queued?.glyph == .degraded && queued?.shape == .chip)
    #expect(CaptureLine.failed(reason: "no").mark(on: .elevated)?.glyph == .failed)
    #expect(CaptureLine.none.mark(on: .elevated) == nil)
}

@MainActor
@Test func twoInFlightReadAsOneLineAndAFailureTakesIt() async throws {
    let console = CaptureConsole(script: [.hold, .hold, .answer])
    let (model, session, _) = composer(console)
    defer { withExtendedLifetime(session) {} }

    model.draft = "first"
    let first = Task { await model.capture() }
    try await waitUntil { console.calls.count == 1 }
    #expect(model.line == .sending(count: 1))
    model.draft = "second"
    let second = Task { await model.capture() }
    try await waitUntil { console.calls.count == 2 }
    #expect(model.line.text == "capturing… (2)")

    console.release(.refuse(400, "invalid_request", "the note is empty"))
    await first.value
    #expect(model.line == .failed(reason: "the note is empty"), "a failure always wins the line")
    #expect(model.offersRetry)
    #expect(model.draft == "first", "the refused words are back")
    console.release(.answer)
    await second.value
    #expect(model.line == .failed(reason: "the note is empty"), "…until it is dealt with")

    // Edited words are a new capture: the refused one was never written.
    model.draft = "first, fixed"
    await model.capture()
    #expect(!model.offersRetry)
    #expect(model.captures.isEmpty)
}

// MARK: - An instance switch

@MainActor
@Test func aSwitchNeverSendsAQueuedCaptureToTheOtherInstance() async throws {
    let console = CaptureConsole(script: [.down])
    let (model, session, scheduled) = composer(console)
    defer { withExtendedLifetime(session) {} }

    model.draft = "for the first instance"
    await model.capture()
    #expect(model.line == .queued(count: 1))
    model.draft = "and a thought after it"

    let other = CaptureConsole(script: [.answer])
    session.adopt(transport: other, management: nil)
    await scheduled.runAll()
    #expect(other.calls.isEmpty, "nothing written for one instance lands in another")
    #expect(model.captures.isEmpty)
    #expect(model.draft == "and a thought after it\n\nfor the first instance", "the words are back, and nothing was typed twice")
    #expect(model.notice == "Not sent — the instance changed. The words are back in the field.")
    #expect(model.line == .none)
}

// MARK: - The queue file survives a relaunch (X-19, ruling 19)

@MainActor
@Test func aCaptureQueuedOfflineSurvivesARelaunchAndIsSentExactlyOnce() async throws {
    let (store, dir) = try tempQueueStore()
    defer { try? FileManager.default.removeItem(at: dir) }

    // Before the relaunch: offline, so the capture is queued and written to disk.
    let console = CaptureConsole(script: [.down, .answer])
    let session = ConsoleSession(transport: console, management: nil)
    let model = CaptureComposerModel(session: session, queueStore: store)
    model.announce = { _ in }
    model.currentInstanceID = { "instance-a" }
    model.draft = "Renew the passport"
    await model.capture()
    #expect(model.line == .queued(count: 1))
    let mintedKey = try #require(console.calls.first?.key)
    let onDisk = store.load()
    #expect(onDisk.count == 1 && onDisk[0].idempotencyKey == mintedKey && onDisk[0].text == "Renew the passport" && onDisk[0].instanceID == "instance-a")

    // The relaunch: a fresh model over the same store (and the same console,
    // standing in for the same server) reads the file back and resends.
    let restarted = CaptureComposerModel(session: session, queueStore: store)
    restarted.announce = { _ in }
    restarted.currentInstanceID = { "instance-a" }
    let scheduled = Scheduled()
    restarted.scheduleRetry = { scheduled.add($0, $1) }
    restarted.loadPersistedQueue()
    #expect(restarted.captures.count == 1 && restarted.line == .queued(count: 1), "the loaded item is queued, exactly as it was")
    #expect(scheduled.delays == [CaptureComposerModel.retryPolicy.interval], "a resend is scheduled, same as any other queued capture")

    await scheduled.runAll()
    #expect(console.calls.count == 2 && console.calls.last?.key == mintedKey, "the resend carries the key minted before the relaunch")
    #expect(restarted.captures.isEmpty, "sent exactly once")
    #expect(store.load().isEmpty, "a sent capture is never left in the file")
}

@MainActor
@Test func aReplayAfterARelaunchReusesTheKeyAndRendersTheOriginalRow() async throws {
    let (store, dir) = try tempQueueStore()
    defer { try? FileManager.default.removeItem(at: dir) }

    // The console writes the row, but the reply never reaches this launch.
    let console = CaptureConsole(script: [.lose, .answer])
    let session = ConsoleSession(transport: console, management: nil)
    let model = CaptureComposerModel(session: session, queueStore: store)
    model.announce = { _ in }
    model.currentInstanceID = { "instance-a" }
    model.draft = "Pick up the prescription"
    await model.capture()
    #expect(console.written.count == 1, "the console did write it, even though this launch never heard back")

    // The relaunch resends the same key; the console answers with the ORIGINAL
    // row. `CaptureComposerModel` holds its session weakly (`AppModel` is the
    // strong owner in production), so the test keeps this one alive itself.
    let restartedSession = ConsoleSession(transport: console, management: nil)
    defer { withExtendedLifetime(restartedSession) {} }
    let restarted = CaptureComposerModel(session: restartedSession, queueStore: store)
    restarted.announce = { _ in }
    restarted.currentInstanceID = { "instance-a" }
    restarted.loadPersistedQueue()
    await restarted.flushQueue()

    #expect(console.replays == 1, "a replay, not a second row")
    let original = try #require(console.written.first)
    #expect(restarted.lastReceipt == original)
    #expect(restarted.captures.isEmpty)
    #expect(store.load().isEmpty)
}

@MainActor
@Test func aCorruptQueueFileIsIgnoredNotFatal() async throws {
    let (_, dir) = try tempQueueStore()
    defer { try? FileManager.default.removeItem(at: dir) }
    let url = dir.appendingPathComponent("capture-queue.json")
    try "not json at all — a crash mid-write, or an older version's file".write(to: url, atomically: true, encoding: .utf8)

    let store = JSONCaptureQueueStore(url: url)
    #expect(store.load().isEmpty, "corrupt is an empty queue, never a crash")

    // The store still works afterwards: a write replaces the corrupt file cleanly.
    store.replace(instanceID: "instance-a", with: [PersistedCapture(text: "a note", idempotencyKey: "key-1", instanceID: "instance-a", createdAt: Date())])
    #expect(store.load().map(\.idempotencyKey) == ["key-1"])
}

@MainActor
@Test func anInstanceSwitchLeavesOtherInstancesQueuedItemsOnDisk() async throws {
    let (store, dir) = try tempQueueStore()
    defer { try? FileManager.default.removeItem(at: dir) }

    // A second instance already has something queued from an earlier launch.
    let untouched = PersistedCapture(text: "for instance C", idempotencyKey: "key-c", instanceID: "instance-c", createdAt: Date())
    store.replace(instanceID: "instance-c", with: [untouched])

    let console = CaptureConsole(script: [.down])
    let session = ConsoleSession(transport: console, management: nil)
    let model = CaptureComposerModel(session: session, queueStore: store)
    model.announce = { _ in }
    model.currentInstanceID = { "instance-a" }
    model.draft = "for instance A"
    await model.capture()
    #expect(store.load().count == 2, "instance A's queued capture landed beside instance C's")

    // The switch: A's queued capture is no longer queued (it is back in the
    // field), so its bucket clears — C's is never even read for this.
    session.adopt(transport: CaptureConsole(script: []), management: nil)

    #expect(store.load() == [untouched], "instance C's entry is exactly what it was")
}

/// A fresh, empty queue file under a scratch directory this test owns —
/// never the real Application Support (`JSONCaptureQueueStore.defaultURL()`
/// is never called here). Returns the directory too, so the caller can clean
/// up everything this test wrote in one `removeItem`.
private func tempQueueStore() throws -> (JSONCaptureQueueStore, URL) {
    let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("metistry-capture-queue-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return (JSONCaptureQueueStore(url: dir.appendingPathComponent("capture-queue.json")), dir)
}

// MARK: - The shell's +

@MainActor
@Test func thePlusAndCommandNOpenTheComposer() async throws {
    let name = "com.foldedspacelabs.metistry.tests.capture.\(UUID().uuidString)"
    let model = AppModel(bundleResourceURL: nil, runner: ShellNoopRunner(), defaults: UserDefaults(suiteName: name)!)
    #expect(model.shell.canPerform(.newCapture), "New Capture is lit")
    #expect(!model.shell.canPerform(.note) && !model.shell.canPerform(.startRecording), "the bar's items stay dimmed (#253)")
    model.shell.perform(.newCapture)
    #expect(model.composer.isPresented)
}

// MARK: - §2.18

#if os(macOS)
@MainActor
@Test func theComposerSpeaksEveryControl() async throws {
    let console = CaptureConsole(script: [.refuse(413, "payload_too_large", "the capture is larger than 10 MB")])
    let (model, session, _) = composer(console)
    defer { withExtendedLifetime(session) {} }
    model.draft = "a draft"

    var tree = try await AccessibilityProbe.snapshot(CaptureComposerView(model: model))
    #expect(tree.unlabeledControls.filter { !["AXTextField", "AXTextArea"].contains($0.role) }.isEmpty, "unlabeled: \(tree.unlabeledControls)")
    #expect(tree.saysAssistant.isEmpty)
    #expect(tree.controlNames.contains("Capture, Command-Return"), "controls: \(tree.controlNames)")
    #expect(composerFieldLabels(in: tree.window) == ["Note"], "the field says what it is")
    #expect(composerFieldValues(in: tree.window) == ["a draft"], "a reopened composer shows the kept draft")
    tree.close()

    await model.capture()
    tree = try await AccessibilityProbe.snapshot(CaptureComposerView(model: model))
    defer { tree.close() }
    #expect(tree.controlNames.contains("Retry"), "controls: \(tree.controlNames)")
    #expect(tree.labels.contains("Capture failed: the capture is larger than 10 MB"), "labels: \(tree.labels)")
    #expect(tree.unlabeledControls.filter { !["AXTextField", "AXTextArea"].contains($0.role) }.isEmpty)
}

@MainActor
@Test func theLargestTextGrowsTheComposerLongerNeverWider() async throws {
    let console = CaptureConsole(script: [])
    let (model, session, _) = composer(console)
    defer { withExtendedLifetime(session) {} }
    model.draft = "a thought long enough to wrap onto a second line at the largest text size macOS offers"
    func size(_ type: DynamicTypeSize) -> CGSize {
        NSHostingView(rootView: CaptureComposerView(model: model).environment(\.dynamicTypeSize, type)).fittingSize
    }
    let standard = size(.large)
    let largest = size(.accessibility5)
    #expect(standard.width == CaptureComposerView.width && largest.width == CaptureComposerView.width, "\(standard) → \(largest)")
    #expect(largest.height > standard.height)
}

/// What each editable field in the window says it is (the probe reads
/// AppKit's attribute form, where a SwiftUI field's label lives on its cell).
@MainActor
private func composerFieldLabels(in window: NSWindow) -> [String] {
    composerFields(in: window).map { $0.cell?.accessibilityLabel() ?? $0.accessibilityLabel() ?? "" }
}

@MainActor
private func composerFieldValues(in window: NSWindow) -> [String] {
    composerFields(in: window).map(\.stringValue)
}

@MainActor
private func composerFields(in window: NSWindow) -> [NSTextField] {
    func fields(_ view: NSView) -> [NSTextField] {
        ((view as? NSTextField).map { $0.isEditable ? [$0] : [] } ?? []) + view.subviews.flatMap(fields)
    }
    return window.contentView.map(fields) ?? []
}
#endif

// MARK: - Helpers

/// Resends the model asked for, held until the test runs them.
@MainActor
private final class Scheduled {
    var delays: [TimeInterval] = []
    private var pending: [@MainActor () async -> Void] = []

    func add(_ delay: TimeInterval, _ work: @escaping @MainActor () async -> Void) {
        delays.append(delay)
        pending.append(work)
    }

    /// Runs what is due now; anything they schedule waits for the next call.
    func runAll() async {
        let due = pending
        pending.removeAll()
        for work in due { await work() }
    }
}

@MainActor
private func composer(_ console: CaptureConsole) -> (CaptureComposerModel, ConsoleSession, Scheduled) {
    let session = ConsoleSession(transport: console, management: nil)
    let model = CaptureComposerModel(session: session)
    let scheduled = Scheduled()
    model.announce = { _ in }
    model.scheduleRetry = { scheduled.add($0, $1) }
    return (model, session, scheduled)
}

@MainActor
private func waitUntil(_ condition: @MainActor () -> Bool) async throws {
    for _ in 0..<200 where !condition() { try await Task.sleep(for: .milliseconds(5)) }
    #expect(condition(), "timed out")
}

/// `POST /capture` as the console behaves: a key it has written answers with
/// the original row (`idempotency-replayed`), a new key writes a new row. Each
/// call takes the next scripted outcome.
private final class CaptureConsole: ConsoleCallTransport, @unchecked Sendable {
    enum Outcome: Sendable {
        /// Written, and answered.
        case answer
        /// Written — and the reply never arrives.
        case lose
        /// Nothing reached it.
        case down
        /// It answered with a refusal; nothing written.
        case refuse(Int, String, String)
        /// Parked until `release` says what happens.
        case hold
    }

    struct Call: Sendable {
        let key: String?
        let body: JSONValue?
    }

    private let lock = NSLock()
    private var script: [Outcome]
    private var _calls: [Call] = []
    private var rows: [String: CaptureReceipt] = [:]
    private var _written: [CaptureReceipt] = []
    private var _replays = 0
    private var held: [CheckedContinuation<Outcome, Never>] = []

    init(script: [Outcome]) { self.script = script }

    var calls: [Call] { lock.withLock { _calls } }
    var written: [CaptureReceipt] { lock.withLock { _written } }
    var replays: Int { lock.withLock { _replays } }

    /// Resolves the oldest held call.
    func release(_ outcome: Outcome) {
        let next = lock.withLock { held.isEmpty ? nil : held.removeFirst() }
        next?.resume(returning: outcome)
    }

    func call(_ method: String, _ path: String, body: Data?, idempotencyKey: String?) async -> Result<Data, ConsoleError> {
        let sent = body.flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) }
        var outcome: Outcome = lock.withLock {
            _calls.append(Call(key: idempotencyKey, body: sent))
            return script.isEmpty ? .down : script.removeFirst()
        }
        if case .hold = outcome {
            outcome = await withCheckedContinuation { c in lock.withLock { held.append(c) } }
        }
        switch outcome {
        case .down, .hold:
            return .failure(.transport("connect ECONNREFUSED 127.0.0.1:8080"))
        case .refuse(let status, let code, let message):
            return .failure(.http(status: status, envelope: ConsoleErrorEnvelope(code: code, message: message)))
        case .answer, .lose:
            let receipt = write(idempotencyKey)
            if case .lose = outcome { return .failure(.transport("the session closed before the reply")) }
            return .success(try! JSONEncoder().encode(receipt))
        }
    }

    private func write(_ key: String?) -> CaptureReceipt {
        lock.withLock {
            if let key, let row = rows[key] {
                _replays += 1
                return row
            }
            let id = 400 + _written.count + 1
            let row = CaptureReceipt(id: id, path: "Inbox/2026-09-26-note-\(id).md", sha256: String(repeating: "a", count: 64))
            if let key { rows[key] = row }
            _written.append(row)
            return row
        }
    }
}

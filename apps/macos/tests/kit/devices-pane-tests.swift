// Settings ▸ Devices and the Add a Phone sheet (design-build-plan §2.22, X-77).
//
// The ticket's bold tests: THE SHEET NEVER DRAWS A QR FOR A REFUSED ORIGIN, and
// CLOSING IT IN ANY STATE CANCELS A LIVE CODE. Then the QR decodes (CIDetector)
// to exactly the verb's URL; the countdown reaches Expired on an injected
// clock; and the pane's one door — Remove and Sign Out Everywhere are both
// `POST /api/devices/:id/revoke`, told apart by scope — with its misuse tests:
// presenting a confirm sends nothing, Cancel sends nothing, Remove posts the
// device's id with the route's default body, Sign Out Everywhere posts
// `{scope: "sessions"}` once per signed-in device with the caller's own last.
// Every read is the recorded fixtures (U9); `metistry enroll` is a scripted
// runner answering what the CLI prints — no console, no CLI, no network.

#if os(macOS)
import CoreImage
import Foundation
import SwiftUI
import Testing

@testable import MetistryKit

// MARK: - What the CLI prints

private let mintedURL = "https://assistant.example/#enroll=Qm9yZWFsaXNUZXN0Q29kZQ"
private let t0 = WireTime.date("2026-10-19T14:42:10.000Z")!

/// An instant as the console prints it.
private func iso(_ date: Date) -> String {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.string(from: date)
}

/// `metistry enroll --json` on a mint: exactly one document (docs/ops/cli.md, "Adding a phone").
private func mintedJSON(codeID: Int = 42, expiresAt: Date = t0.addingTimeInterval(600)) -> String {
    #"{"url":"\#(mintedURL)","code_id":\#(codeID),"origin":"https://assistant.example","expires_at":"\#(iso(expiresAt))"}"#
}

/// `metistry enroll --json` on a fresh install: the loopback refusal, verbatim from `packages/cli/src/enroll.ts`, exit 1.
private let loopbackRefusal = CommandResult(
    exitCode: 1,
    stdout: #"{"refused":{"case":"loopback","message":"Your phone can't reach this Mac yet: Metistry only answers on this Mac. Choose how your phone reaches it in Settings ▸ Remote Access (`metistry remote set`).","origin":"http://127.0.0.1:8080","fix":"Choose how your phone reaches this Mac in Settings ▸ Remote Access (`metistry remote` in a terminal); docs/ops/auth.md (\"Passkeys: origins\") says what METISTRY_ORIGIN has to be."}}"# + "\n",
    stderr: "metistry enroll: refused — Your phone can't reach this Mac yet: Metistry only answers on this Mac. Choose how your phone reaches it in Settings ▸ Remote Access (`metistry remote set`).\n"
)

private let unreachableRefusal = CommandResult(
    exitCode: 1,
    stdout: #"{"refused":{"case":"unreachable","message":"https://assistant.example doesn't answer from this Mac, so your phone won't reach it either. Settings ▸ Remote Access shows what your remote-access provider reports.","origin":"https://assistant.example","fix":"Choose how your phone reaches this Mac in Settings ▸ Remote Access (`metistry remote` in a terminal); docs/ops/auth.md (\"Passkeys: origins\") says what METISTRY_ORIGIN has to be.","detail":"GET https://assistant.example/health: no answer within 5 s"}}"# + "\n",
    stderr: ""
)

/// `metistry enroll --status <id> --json` (docs/ops/cli.md): the code's state and what the console stamped on it.
private func statusResult(codeID: Int, openedVia: String?, provider: String? = "tailscale") -> CommandResult {
    let opened = openedVia.map { #""opened_at":"2026-10-19T14:44:02.511Z","opened_via":"\#($0)""# } ?? #""opened_at":null,"opened_via":null"#
    let who = provider.map { #""\#($0)""# } ?? "null"
    return CommandResult(exitCode: 0, stdout: #"{"code_id":\#(codeID),"state":"live","expires_at":"2026-10-19T14:52:10.000Z",\#(opened),"provider":\#(who)}"# + "\n", stderr: "")
}

/// `metistry enroll` as the sheet drives it: records every command, answers a
/// mint with what the test scripted, and can hold a mint open so a test can
/// close the sheet while it is Checking.
private final class EnrollRunner: ManagementRunner, @unchecked Sendable {
    private let lock = NSLock()
    private var _commands: [ManagementCommand] = []
    private var _mint: CommandResult
    var cancelAnswer = CommandResult(exitCode: 0, stdout: #"{"code_id":42,"outcome":"cancelled","cancelled":true}"# + "\n", stderr: "")
    /// What `metistry enroll --status` answers: not opened yet, unless a test says otherwise.
    var statusAnswer = statusResult(codeID: 42, openedVia: nil)
    /// Held before a mint is answered.
    var mintDelay: Duration?

    init(mint: CommandResult) { _mint = mint }

    var commands: [ManagementCommand] { lock.withLock { _commands } }
    var mint: CommandResult { get { lock.withLock { _mint } } set { lock.withLock { _mint = newValue } } }
    /// The argument arrays, after `metistry`.
    var argv: [[String]] { commands.map(\.arguments) }
    var cancels: [[String]] { argv.filter { $0.starts(with: ["enroll", "--cancel"]) } }
    var statusReads: [[String]] { argv.filter { $0.starts(with: ["enroll", "--status"]) } }

    func plannedArguments(_ command: ManagementCommand) -> [String] { ["metistry"] + command.arguments }

    func run(_ command: ManagementCommand, onOutput: @escaping @Sendable (OutputLine) -> Void) async throws -> CommandResult {
        lock.withLock { _commands.append(command) }
        if command.arguments.starts(with: ["enroll", "--cancel"]) { return cancelAnswer }
        if command.arguments.starts(with: ["enroll", "--status"]) { return lock.withLock { statusAnswer } }
        if let mintDelay { try? await Task.sleep(for: mintDelay) }
        return mint
    }
}

/// A console whose answers can change under a running sheet: the recorded
/// fixtures, then — once the phone "arrives" — the same fixtures with a new
/// device in `GET /api/devices`.
private final class SwappableConsole: ConsoleCallTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _inner: FixtureConsole

    init(_ inner: FixtureConsole) { _inner = inner }

    var inner: FixtureConsole { get { lock.withLock { _inner } } set { lock.withLock { _inner = newValue } } }

    func call(_ method: String, _ path: String, body: Data?, idempotencyKey: String?) async -> Result<Data, ConsoleError> {
        await inner.call(method, path, body: body, idempotencyKey: idempotencyKey)
    }
}

/// The recorded `GET /api/devices` with its body edited.
private func devicesFixtures(_ edit: (inout [[String: Any]]) -> Void) throws -> [ConsoleFixture] {
    try ConsoleFixture.loadAll().map { f in
        guard f.stem == "get-api-devices" else { return f }
        var body = try JSONSerialization.jsonObject(with: f.reply) as? [String: Any] ?? [:]
        var devices = body["devices"] as? [[String: Any]] ?? []
        edit(&devices)
        body["devices"] = devices
        return try f.replacingReply(body)
    }
}

@MainActor
private func sheet(mint: CommandResult, console: FixtureConsole? = nil) throws -> (AddPhoneModel, EnrollRunner, ConsoleSession) {
    let runner = EnrollRunner(mint: mint)
    let fixtures = try console ?? FixtureConsole.recorded()
    let session = ConsoleSession(transport: fixtures, management: runner)
    let model = AddPhoneModel(management: runner, session: session)
    model.now = { t0 }
    model.pollInterval = .seconds(3600) // the poll is the stream's fallback; these tests ask directly
    return (model, runner, session)
}

// MARK: - The bold tests

@MainActor
@Test func theSheetNeverDrawsAQRForARefusedOrigin() async throws {
    let (model, runner, session) = try sheet(mint: loopbackRefusal)
    defer { withExtendedLifetime(session) {} }
    await model.open()

    // the CLI refused before minting (§2.22): its own words, no code, no QR
    guard case .refused(let refusal) = model.phase else {
        Issue.record("expected refused, got \(model.phase)")
        return
    }
    #expect(refusal.kind == "loopback")
    #expect(refusal.message.hasPrefix("Your phone can't reach this Mac yet"))
    #expect(refusal.origin == "http://127.0.0.1:8080")
    #expect(refusal.fix.contains("Settings ▸ Remote Access"))
    #expect(model.qr == nil)
    #expect(model.liveCode == nil)

    // the view agrees: no image named for VoiceOver, the refusal's words, Learn How and Done
    let tree = try await AccessibilityProbe.snapshot(AddPhoneSheet(model: model, onDone: {}))
    defer { tree.close() }
    #expect(!tree.nodes.contains { $0.name == AddPhoneWords.qrLabel }, "a QR was drawn for a refused origin")
    #expect(!tree.nodes.contains { $0.role == "AXImage" }, "an image was drawn for a refused origin: \(tree.nodes.filter { $0.role == "AXImage" })")
    #expect(tree.nodes.contains { $0.name.hasPrefix("Your phone can't reach this Mac yet") }, "\(tree.nodes.map(\.name).filter { !$0.isEmpty })")
    #expect(tree.controlNames.contains(AddPhoneWords.learnHow))
    #expect(tree.controlNames.contains(AddPhoneWords.done))
    #expect(!tree.controlNames.contains(AddPhoneWords.makeANewCode), "nothing to make new: nothing was minted")
    #expect(tree.unlabeledBesidesFields.isEmpty, "unlabeled: \(tree.unlabeledBesidesFields)")

    // nothing was minted, so closing cancels nothing
    await model.close()
    #expect(runner.argv == [["enroll", "--json"]])

    // the fourth refusal carries the failing probe, shown under the words
    let (unreachable, _, session2) = try sheet(mint: unreachableRefusal)
    defer { withExtendedLifetime(session2) {} }
    await unreachable.open()
    guard case .refused(let why) = unreachable.phase else {
        Issue.record("expected refused, got \(unreachable.phase)")
        return
    }
    #expect(why.detail == "GET https://assistant.example/health: no answer within 5 s")
    #expect(unreachable.qr == nil)
}

@MainActor
@Test func closingTheSheetInAnyStateCancelsALiveCode() async throws {
    // READY: the code is live; Done kills it by id, once
    let (ready, readyRunner, s1) = try sheet(mint: CommandResult(exitCode: 0, stdout: mintedJSON() + "\n", stderr: ""))
    defer { withExtendedLifetime(s1) {} }
    await ready.open()
    guard case .ready(let code) = ready.phase else {
        Issue.record("expected ready, got \(ready.phase)")
        return
    }
    #expect(code.codeID == 42)
    #expect(ready.liveCode == code)
    await ready.close()
    #expect(readyRunner.cancels == [["enroll", "--cancel", "42", "--json"]])
    #expect(ready.liveCode == nil)
    await ready.close()
    #expect(readyRunner.cancels.count == 1, "a second close sends nothing")
    // the id, never the code, is on argv
    for command in readyRunner.commands { #expect(!command.arguments.joined(separator: " ").contains("Qm9yZWFsaXNUZXN0Q29kZQ")) }

    // CHECKING: closed while the verb is still running — the code it mints is dead on arrival
    let (checking, checkingRunner, s2) = try sheet(mint: CommandResult(exitCode: 0, stdout: mintedJSON(codeID: 43) + "\n", stderr: ""))
    defer { withExtendedLifetime(s2) {} }
    checkingRunner.mintDelay = .milliseconds(400)
    let opening = Task { await checking.open() }
    try await Task.sleep(for: .milliseconds(100))
    #expect(checking.phase == .checking)
    await checking.close()
    await opening.value
    #expect(checkingRunner.cancels == [["enroll", "--cancel", "43", "--json"]])
    #expect(checking.qr == nil)

    // ADDED: a phone arrived (maybe with another code); ours is still live, so Done kills it
    let base = try FixtureConsole(devicesFixtures { _ in })
    let swappable = SwappableConsole(base)
    let addedRunner = EnrollRunner(mint: CommandResult(exitCode: 0, stdout: mintedJSON(codeID: 44) + "\n", stderr: ""))
    let addedSession = ConsoleSession(transport: swappable, management: addedRunner)
    let added = AddPhoneModel(management: addedRunner, session: addedSession)
    added.now = { t0 }
    added.pollInterval = .seconds(3600)
    var heard: [String] = []
    added.onAdded = { heard.append($0) }
    await added.open()
    guard case .ready = added.phase else {
        Issue.record("expected ready, got \(added.phase)")
        return
    }
    await added.checkArrival()
    #expect(added.phase != .added(label: "iPhone"), "nothing new yet: the baseline is the list the sheet opened on")
    swappable.inner = try FixtureConsole(devicesFixtures { devices in
        devices.insert([
            "id": "9", "passkey_id": "fixture-new-phone", "label": "Matt's iPhone", "rp_id": "assistant.example",
            "added": iso(t0.addingTimeInterval(30)), "last_seen": iso(t0.addingTimeInterval(30)), "this_device": false,
            "sessions": [["id": "9", "created_at": iso(t0.addingTimeInterval(30)), "last_seen_at": iso(t0.addingTimeInterval(30)), "absolute_expires_at": iso(t0.addingTimeInterval(86_400)), "revoked": false, "push": false]],
        ], at: 0)
    })
    await added.checkArrival()
    #expect(added.phase == .added(label: "Matt's iPhone"))
    #expect(heard == ["Matt's iPhone"])
    #expect(added.qr == nil, "Added replaces the QR")
    await added.close()
    #expect(addedRunner.cancels == [["enroll", "--cancel", "44", "--json"]])

    // EXPIRED: the ten minutes ran out, so there is no live code to cancel
    let (expired, expiredRunner, s3) = try sheet(mint: CommandResult(exitCode: 0, stdout: mintedJSON(codeID: 45) + "\n", stderr: ""))
    defer { withExtendedLifetime(s3) {} }
    await expired.open()
    expired.tick(now: t0.addingTimeInterval(600))
    guard case .expired = expired.phase else {
        Issue.record("expected expired, got \(expired.phase)")
        return
    }
    #expect(expired.liveCode == nil)
    await expired.close()
    #expect(expiredRunner.cancels.isEmpty, "an expired code is not live")

    // MAKE A NEW CODE cancels the old one first, then mints again
    let (renew, renewRunner, s4) = try sheet(mint: CommandResult(exitCode: 0, stdout: mintedJSON(codeID: 46) + "\n", stderr: ""))
    defer { withExtendedLifetime(s4) {} }
    await renew.open()
    renewRunner.mint = CommandResult(exitCode: 0, stdout: mintedJSON(codeID: 47) + "\n", stderr: "")
    await renew.makeNewCode()
    #expect(renewRunner.argv == [["enroll", "--json"], ["enroll", "--cancel", "46", "--json"], ["enroll", "--json"]])
    #expect(renew.liveCode?.codeID == 47)
    await renew.close()
    #expect(renewRunner.cancels.last == ["enroll", "--cancel", "47", "--json"])
}

// MARK: - Opened on your phone (X-114)

@MainActor
@Test func theSheetTurnsToOpenedOnYourPhoneOnlyForTheProxyListener() async throws {
    let (model, runner, session) = try sheet(mint: CommandResult(exitCode: 0, stdout: mintedJSON() + "\n", stderr: ""))
    defer { withExtendedLifetime(session) {} }
    await model.open()
    guard case .ready(let code) = model.phase else {
        Issue.record("expected ready, got \(model.phase)")
        return
    }

    // not opened: still Ready
    await model.checkOpened()
    #expect(model.phase == .ready(code))
    #expect(runner.statusReads == [["enroll", "--status", "42", "--json"]], "asked by the id, never the code")

    // opened on THIS Mac's own listener (the owner clicked the link): recorded by the console, never shown as the phone
    runner.statusAnswer = statusResult(codeID: 42, openedVia: "main")
    await model.checkOpened()
    #expect(model.phase == .ready(code))
    #expect(!model.phoneReachedMac)

    // an answer for another code (a stale reply) is not this code's
    runner.statusAnswer = statusResult(codeID: 41, openedVia: "proxy")
    await model.checkOpened()
    #expect(model.phase == .ready(code))

    // a CLI older than the flag, or one that cannot answer: nothing changes
    runner.statusAnswer = CommandResult(exitCode: 2, stdout: "", stderr: "unknown flag\n")
    await model.checkOpened()
    #expect(model.phase == .ready(code))

    // through the proxy listener: the proof from outside
    runner.statusAnswer = statusResult(codeID: 42, openedVia: "proxy")
    await model.checkOpened()
    #expect(model.phase == .openedOnPhone(code, provider: "Tailscale"))
    #expect(model.phoneReachedMac)
    #expect(model.qr == nil, "Opened replaces the QR")
    #expect(model.liveCode == code, "the code is still live until the phone uses it")
    let tree = try await AccessibilityProbe.snapshot(AddPhoneSheet(model: model, onDone: {}))
    defer { tree.close() }
    let names = tree.nodes.map(\.name).filter { !$0.isEmpty }
    #expect(tree.nodes.contains { $0.name.contains(AddPhoneWords.openedTitle) }, "\(names)")
    #expect(tree.nodes.contains { $0.name.contains("Your phone reached this Mac through Tailscale.") }, "\(names)")
    #expect(!tree.nodes.contains { $0.name == AddPhoneWords.qrLabel })
    #expect(tree.controlNames.contains(AddPhoneWords.makeANewCode))
    #expect(tree.controlNames.contains(AddPhoneWords.done))
    #expect(tree.unlabeledBesidesFields.isEmpty, "unlabeled: \(tree.unlabeledBesidesFields)")

    // …then the phone is added: Opened goes on to Added
    let reads = runner.statusReads.count
    await model.checkOpened()
    #expect(runner.statusReads.count == reads, "once opened there is nothing more to ask")
    #expect(model.phase == .openedOnPhone(code, provider: "Tailscale"))

    // closing from Opened still kills the live code
    await model.close()
    #expect(runner.cancels == [["enroll", "--cancel", "42", "--json"]])
}

@MainActor
@Test func openedOnYourPhoneGoesOnToAddedWhenThePhoneArrives() async throws {
    let base = try FixtureConsole(devicesFixtures { _ in })
    let swappable = SwappableConsole(base)
    let runner = EnrollRunner(mint: CommandResult(exitCode: 0, stdout: mintedJSON() + "\n", stderr: ""))
    let session = ConsoleSession(transport: swappable, management: runner)
    let model = AddPhoneModel(management: runner, session: session)
    model.now = { t0 }
    model.pollInterval = .seconds(3600)
    await model.open()
    runner.statusAnswer = statusResult(codeID: 42, openedVia: "proxy", provider: nil)
    await model.checkOpened()
    guard case .openedOnPhone(let code, let provider) = model.phase else {
        Issue.record("expected openedOnPhone, got \(model.phase)")
        return
    }
    #expect(provider == nil)
    #expect(AddPhoneWords.opened(through: provider) == "Your phone reached this Mac from outside.")
    swappable.inner = try FixtureConsole(devicesFixtures { devices in
        devices.insert([
            "id": "9", "passkey_id": "fixture-new-phone", "label": "Matt's iPhone", "rp_id": "assistant.example",
            "added": iso(t0.addingTimeInterval(30)), "last_seen": iso(t0.addingTimeInterval(30)), "this_device": false,
            "sessions": [["id": "9", "created_at": iso(t0.addingTimeInterval(30)), "last_seen_at": iso(t0.addingTimeInterval(30)), "absolute_expires_at": iso(t0.addingTimeInterval(86_400)), "revoked": false, "push": false]],
        ], at: 0)
    })
    await model.checkArrival()
    #expect(model.phase == .added(label: "Matt's iPhone"))
    _ = code
    await model.close()
}

@MainActor
@Test func aCodeThatExpiresWithoutAProxyOpenSaysThePhoneDidNotReachTheOrigin() async throws {
    // never opened: the sentence, naming the origin
    let (never, _, s1) = try sheet(mint: CommandResult(exitCode: 0, stdout: mintedJSON(codeID: 42) + "\n", stderr: ""))
    defer { withExtendedLifetime(s1) {} }
    await never.open()
    never.tick(now: t0.addingTimeInterval(600))
    guard case .expired = never.phase else {
        Issue.record("expected expired, got \(never.phase)")
        return
    }
    #expect(!never.phoneReachedMac)
    #expect(AddPhoneWords.notReached("https://assistant.example") == "Your phone didn't reach https://assistant.example. Open it in Safari on your phone with Wi-Fi off to see what it says.")
    let tree = try await AccessibilityProbe.snapshot(AddPhoneSheet(model: never, onDone: {}))
    defer { tree.close() }
    #expect(tree.nodes.contains { $0.name == AddPhoneWords.notReached("https://assistant.example") }, "\(tree.nodes.map(\.name).filter { !$0.isEmpty })")
    await never.close()

    // opened on this Mac's own listener only: that is not the phone reaching it, so the sentence stands
    let (mainOnly, mainRunner, s2) = try sheet(mint: CommandResult(exitCode: 0, stdout: mintedJSON(codeID: 42) + "\n", stderr: ""))
    defer { withExtendedLifetime(s2) {} }
    await mainOnly.open()
    mainRunner.statusAnswer = statusResult(codeID: 42, openedVia: "main")
    await mainOnly.checkOpened()
    mainOnly.tick(now: t0.addingTimeInterval(600))
    #expect(!mainOnly.phoneReachedMac)
    let t2 = try await AccessibilityProbe.snapshot(AddPhoneSheet(model: mainOnly, onDone: {}))
    defer { t2.close() }
    #expect(t2.nodes.contains { $0.name == AddPhoneWords.notReached("https://assistant.example") })
    await mainOnly.close()

    // the phone reached it but never finished: Expired, and no claim that it never got there
    let (reached, reachedRunner, s3) = try sheet(mint: CommandResult(exitCode: 0, stdout: mintedJSON(codeID: 42) + "\n", stderr: ""))
    defer { withExtendedLifetime(s3) {} }
    await reached.open()
    reachedRunner.statusAnswer = statusResult(codeID: 42, openedVia: "proxy")
    await reached.checkOpened()
    reached.tick(now: t0.addingTimeInterval(600))
    guard case .expired = reached.phase else {
        Issue.record("expected expired, got \(reached.phase)")
        return
    }
    #expect(reached.phoneReachedMac)
    let t3 = try await AccessibilityProbe.snapshot(AddPhoneSheet(model: reached, onDone: {}))
    defer { t3.close() }
    #expect(t3.nodes.contains { $0.name == AddPhoneWords.expired })
    #expect(!t3.nodes.contains { $0.name.contains("didn't reach") })
    #expect(reachedRunner.cancels.isEmpty, "an expired code is not live")
    // a new code starts over: the old one's open does not carry to it
    reachedRunner.statusAnswer = statusResult(codeID: 43, openedVia: nil)
    reachedRunner.mint = CommandResult(exitCode: 0, stdout: mintedJSON(codeID: 43) + "\n", stderr: "")
    await reached.makeNewCode()
    #expect(reached.phase == .ready(EnrollmentCode(url: mintedURL, codeID: 43, origin: "https://assistant.example", expiresAt: t0.addingTimeInterval(600))))
    #expect(!reached.phoneReachedMac)
    await reached.close()
}

/// Steps the poll one wake at a time: `sleep` parks until `release()`, and
/// `untilParked()` returns once the loop is parked again — so a test knows the
/// wake it released has been fully handled. No clock, no real sleeping.
private final class Signals: @unchecked Sendable {
    private let stream: AsyncStream<Void>
    private let continuation: AsyncStream<Void>.Continuation
    private var iterator: AsyncStream<Void>.Iterator

    init() {
        (stream, continuation) = AsyncStream<Void>.makeStream()
        iterator = stream.makeAsyncIterator()
    }

    func send() { continuation.yield() }
    /// Returns when a signal arrives — or at once, with nothing, if the awaiting task is cancelled.
    func next() async { _ = await iterator.next() }
}

@MainActor
private final class PollGate {
    private let wakes = Signals()
    private let parks = Signals()
    private(set) var entered = 0
    private(set) var intervals: [Duration] = []

    func sleep(_ interval: Duration) async {
        entered += 1
        intervals.append(interval)
        parks.send()
        await wakes.next()
    }

    func release() { wakes.send() }
    func untilParked() async { await parks.next() }
}

@MainActor
@Test func theArrivalPollRunsOnlyWhileTheStreamIsDownAndEndsWhenTheSheetCloses() async throws {
    let runner = EnrollRunner(mint: CommandResult(exitCode: 0, stdout: mintedJSON() + "\n", stderr: ""))
    let console = try FixtureConsole.recorded()
    let session = ConsoleSession(transport: console, management: runner)
    let model = AddPhoneModel(management: runner, session: session)
    model.now = { t0 }
    let gate = PollGate()
    model.sleep = { await gate.sleep($0) }
    var live = false
    model.streamIsLive = { live }
    let devicesReads = { console.calls.filter { $0.method == "GET" && $0.path == "/api/devices" }.count }

    await model.open() // the baseline read, then the mint
    await gate.untilParked() // the loop is waiting out its first interval
    #expect(gate.intervals == [.seconds(5)], "the poll is the 5 s fallback")
    let baseline = devicesReads()
    #expect(runner.statusReads.isEmpty)

    // the stream is down: a wake asks both questions — the devices route and the code's status
    gate.release()
    await gate.untilParked()
    #expect(devicesReads() == baseline + 1)
    #expect(runner.statusReads.count == 1)

    // the stream comes up: it says when to look, so a wake asks nothing
    live = true
    gate.release()
    await gate.untilParked()
    gate.release()
    await gate.untilParked()
    #expect(devicesReads() == baseline + 1, "no poll while the stream is live")
    #expect(runner.statusReads.count == 1)

    // …and when it drops, the poll asks again
    live = false
    gate.release()
    await gate.untilParked()
    #expect(devicesReads() == baseline + 2)
    #expect(runner.statusReads.count == 2)

    // closing ends the poll: close() waits for the loop to finish, and a late wake does nothing
    let parked = gate.entered
    await model.close()
    gate.release()
    gate.release()
    #expect(gate.entered == parked, "the loop did not sleep again after close")
    #expect(devicesReads() == baseline + 2)
    #expect(runner.statusReads.count == 2)
    await model.pollTick()
    #expect(devicesReads() == baseline + 2, "a tick after close asks nothing")
    #expect(runner.statusReads.count == 2)
    #expect(runner.cancels == [["enroll", "--cancel", "42", "--json"]])
}

@MainActor
@Test func aSheetWhoseWindowGoesAwayStillCancelsItsLiveCode() async throws {
    // The Settings window or the wizard closing under an open sheet never calls the presenter's binding setter
    // (only Done, Esc and a dismissal do), so the view going away has to ask for the close itself.
    let (model, runner, session) = try sheet(mint: CommandResult(exitCode: 0, stdout: mintedJSON() + "\n", stderr: ""))
    defer { withExtendedLifetime(session) {} }
    await model.open()
    var done = 0
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 600), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = NSHostingView(rootView: AddPhoneSheet(model: model, onDone: { done += 1 }))
    window.orderFront(nil)
    window.contentView?.layoutSubtreeIfNeeded()
    try await Task.sleep(for: .milliseconds(300)) // the view appears; the harness has no hook for that
    #expect(done == 0, "an open sheet asks for nothing")
    window.contentView = nil // the window's content going away is what closing it does to the sheet
    for _ in 0..<500 where done == 0 { try await Task.sleep(for: .milliseconds(4)) }
    #expect(done == 1, "the presenter was asked to close the sheet")
    window.close()
    await model.close() // what the presenter's close then does
    #expect(runner.cancels == [["enroll", "--cancel", "42", "--json"]])

    // …and a sheet already closed by Done does not ask again
    let (closed, _, s2) = try sheet(mint: CommandResult(exitCode: 0, stdout: mintedJSON(codeID: 50) + "\n", stderr: ""))
    defer { withExtendedLifetime(s2) {} }
    await closed.open()
    await closed.close()
    var again = 0
    let w2 = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 600), styleMask: [.titled], backing: .buffered, defer: false)
    w2.isReleasedWhenClosed = false
    w2.contentView = NSHostingView(rootView: AddPhoneSheet(model: closed, onDone: { again += 1 }))
    w2.orderFront(nil)
    try await Task.sleep(for: .milliseconds(300))
    w2.contentView = nil
    try await Task.sleep(for: .milliseconds(300))
    #expect(again == 0)
}

// MARK: - The QR

@Test func theQRDecodesToExactlyTheVerbsURL() throws {
    let image = try #require(EnrollmentQR.image(for: mintedURL))
    // integer pixels: the symbol's modules at `scale` each, plus the quiet zone on every side
    #expect(image.width % EnrollmentQR.scale == 0 && image.height % EnrollmentQR.scale == 0)
    #expect(image.width == image.height)
    #expect(image.width / EnrollmentQR.scale > 2 * EnrollmentQR.quietZone + 20)
    let detector = try #require(CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh]))
    let features = detector.features(in: CIImage(cgImage: image)).compactMap { $0 as? CIQRCodeFeature }
    #expect(features.count == 1)
    #expect(features.first?.messageString == mintedURL)
    // dark on light: the corner of the quiet zone is white, whatever the appearance
    let data = try #require(image.dataProvider?.data)
    let bytes = CFDataGetBytePtr(data)!
    #expect(bytes[0] > 200 && bytes[1] > 200 && bytes[2] > 200, "the quiet zone is light")
}

@MainActor
@Test func aReadySheetSpeaksTheQRsLabelAndTheURL() async throws {
    let (model, _, session) = try sheet(mint: CommandResult(exitCode: 0, stdout: mintedJSON() + "\n", stderr: ""))
    defer { withExtendedLifetime(session) {} }
    await model.open()
    #expect(model.qr != nil)
    var copied: [String] = []
    model.copyText = { copied.append($0) }
    let tree = try await AccessibilityProbe.snapshot(AddPhoneSheet(model: model, onDone: {}))
    defer { tree.close() }
    // VoiceOver reads the image as "QR code for adding a phone" and the URL is its value (§2.18)
    let qr = try #require(tree.nodes.first { $0.name == AddPhoneWords.qrLabel || $0.label == AddPhoneWords.qrLabel }, "the QR is named: \(tree.nodes.map(\.name).filter { !$0.isEmpty })")
    #expect(qr.value == mintedURL || tree.nodes.contains { $0.name.contains(mintedURL) }, "the URL is the accessible alternative: \(qr)")
    #expect(tree.nodes.contains { $0.name.contains("Your phone must be able to open assistant.example.") }, "\(tree.nodes.map(\.name).filter { !$0.isEmpty })")
    #expect(tree.nodes.contains { $0.name.hasPrefix("Expires in ") })
    #expect(tree.controlNames.contains(AddPhoneWords.copyLink))
    #expect(tree.controlNames.contains(AddPhoneWords.makeANewCode))
    #expect(tree.controlNames.contains(AddPhoneWords.done))
    #expect(tree.unlabeledBesidesFields.isEmpty, "unlabeled: \(tree.unlabeledBesidesFields)")
    #expect(tree.headings.contains(AddPhoneWords.title))
    model.copyLink()
    #expect(copied == [mintedURL])
    await model.close()
}

// MARK: - The countdown

@MainActor
@Test func theCountdownReachesExpiredOnAnInjectedClock() async throws {
    let (model, _, session) = try sheet(mint: CommandResult(exitCode: 0, stdout: mintedJSON() + "\n", stderr: ""))
    defer { withExtendedLifetime(session) {} }
    await model.open()
    guard case .ready(let code) = model.phase else {
        Issue.record("expected ready, got \(model.phase)")
        return
    }
    #expect(code.expiresAt == t0.addingTimeInterval(600))
    #expect(code.countdown(at: t0) == "Expires in 10:00")
    #expect(code.countdown(at: t0.addingTimeInterval(19)) == "Expires in 9:41")
    #expect(code.countdown(at: t0.addingTimeInterval(599.2)) == "Expires in 0:01")
    #expect(code.countdown(at: t0.addingTimeInterval(700)) == "Expires in 0:00")
    #expect(code.host == "assistant.example")

    // a second before: still ready, still live
    model.tick(now: t0.addingTimeInterval(599))
    #expect(model.phase == .ready(code))
    #expect(model.liveCode == code)
    // the moment itself: Expired — the QR is replaced, the code is no longer live
    model.tick(now: t0.addingTimeInterval(600))
    #expect(model.phase == .expired(code))
    #expect(model.qr == nil)
    #expect(model.liveCode == nil)
    let tree = try await AccessibilityProbe.snapshot(AddPhoneSheet(model: model, onDone: {}))
    defer { tree.close() }
    #expect(tree.nodes.contains { $0.name == AddPhoneWords.expired }, "\(tree.nodes.map(\.name).filter { !$0.isEmpty })")
    #expect(!tree.nodes.contains { $0.name == AddPhoneWords.qrLabel })
    #expect(tree.controlNames.contains(AddPhoneWords.makeANewCode))
    // a tick after Expired changes nothing
    model.tick(now: t0.addingTimeInterval(601))
    #expect(model.phase == .expired(code))
    await model.close()
}

@MainActor
@Test func aCLIThatCannotAnswerIsSaidInItsOwnWords() async throws {
    // a CLI older than the verb
    let (old, _, s1) = try sheet(mint: CommandResult(exitCode: 2, stdout: "", stderr: "unknown command: enroll\n"))
    defer { withExtendedLifetime(s1) {} }
    await old.open()
    #expect(old.phase == .unavailable(CLIDegradation.message(verb: "enroll")))
    #expect(old.qr == nil)
    // no database: the CLI's own last line
    let (noDB, _, s2) = try sheet(mint: CommandResult(exitCode: 2, stdout: "", stderr: "metistry enroll: no database configured (METISTRY_DB_PASSWORD is unset) — run from the install's environment\n"))
    defer { withExtendedLifetime(s2) {} }
    await noDB.open()
    #expect(noDB.phase == .unavailable("metistry enroll: no database configured (METISTRY_DB_PASSWORD is unset) — run from the install's environment"))
    // no runtime at all
    let none = AddPhoneModel(management: nil, session: nil)
    await none.open()
    guard case .unavailable(let why) = none.phase else {
        Issue.record("expected unavailable, got \(none.phase)")
        return
    }
    #expect(why.contains("No metistry runtime located"))
    await none.close()
}

// MARK: - The pane: one door, two scopes

@MainActor
private func devicesReading(_ edit: (inout [[String: Any]]) -> Void = { _ in }) throws -> (DevicesModel, FixtureConsole, ConsoleSession) {
    let console = try FixtureConsole(devicesFixtures(edit))
    let session = ConsoleSession(transport: console, management: EnrollRunner(mint: loopbackRefusal))
    let pane = DevicesModel(session: session)
    pane.now = { t0 }
    pane.clock = ClockTime(timeZone: TimeZone(identifier: "UTC")!)
    return (pane, console, session)
}

@MainActor
@Test func thePaneReadsADevicePerPasskeyWithItsSessions() async throws {
    let (pane, console, session) = try devicesReading()
    defer { withExtendedLifetime(session) {} }
    await pane.refresh()
    #expect(pane.phase == .read)
    #expect(console.calls.map(\.servedBy) == ["get-api-devices"])
    #expect(pane.devices.map(\.label) == ["iPad", "iPhone"])
    let iphone = try #require(pane.devices.last)
    #expect(iphone.id == 2, "the row id, as the console's bigint text")
    #expect(iphone.passkeyID == "fixture-7yD5-xgL")
    #expect(iphone.rpID == "127.0.0.1")
    #expect(iphone.sessions.map(\.id) == [2, 1])
    #expect(iphone.sessionsLine == "2 sessions")
    #expect(!iphone.thisDevice, "this Mac has no device row: it signs in with the local owner token")
    #expect(pane.signedIn.map(\.label) == ["iPad", "iPhone"])
    #expect(pane.signOutUnavailableReason == nil)
}

@MainActor
@Test func removeConfirmsNamingTheDeviceAndPostsTheDefaultScopeOnce() async throws {
    let (pane, console, session) = try devicesReading()
    defer { withExtendedLifetime(session) {} }
    await pane.refresh()
    let ipad = try #require(pane.devices.first)
    console.reset()

    // pressing Remove: the confirm names the device, and nothing is sent
    pane.proposeRemove(ipad)
    let confirm = try #require(pane.confirmation)
    #expect(confirm.title == "Remove “iPad”?")
    #expect(confirm.confirm == DevicesWords.remove)
    #expect(confirm.destructive)
    #expect(confirm.alternative == nil)
    // the fixture's `added` is the same (UTC) day as the test's clock, so the moment is the time alone
    #expect(confirm.costs == ["iPad — added 1:35 AM: its passkey is revoked and its session ends"], "\(confirm.costs)")
    #expect(confirm.presentation().controls.map(\.label) == [CostConfirmation.cancel, DevicesWords.remove])
    #expect(console.calls.isEmpty, "presenting the confirm sent nothing")

    // Cancel sends nothing
    await pane.choose(.cancel)
    #expect(pane.confirmation == nil)
    #expect(console.calls.isEmpty, "\(console.calls)")

    // Remove posts the device's id with the route's default body — the fixture's own request
    pane.proposeRemove(ipad)
    await pane.choose(.confirm)
    let posts = console.calls.filter { $0.method == "POST" }
    #expect(posts.map(\.path) == ["/api/devices/3/revoke"])
    #expect(posts.first?.body == .object([:]))
    #expect(posts.first?.servedBy == "post-api-devices-id-revoke")
    #expect(pane.note?.kind == .done)
    #expect(pane.note?.text == "Removed “iPad” — its passkey is revoked and 1 session ended.")
    // and the list is re-read
    #expect(console.calls.last?.servedBy == "get-api-devices")
}

@MainActor
@Test func signOutEverywhereListsEveryDeviceAndTellsTheCallersOwnLast() async throws {
    // the iPad is the caller's own device, so it is told last
    let (pane, console, session) = try devicesReading { devices in
        devices[0]["this_device"] = true
    }
    defer { withExtendedLifetime(session) {} }
    await pane.refresh()
    #expect(pane.signedIn.map(\.label) == ["iPhone", "iPad"])
    console.reset()

    pane.proposeSignOutEverywhere()
    let confirm = try #require(pane.confirmation)
    #expect(confirm.title == "Sign Out Everywhere?")
    #expect(confirm.confirm == DevicesWords.signOutEverywhere)
    #expect(confirm.costs == ["iPhone · 2 sessions", "iPad · 1 session"])
    #expect(console.calls.isEmpty, "presenting the confirm sent nothing")

    await pane.choose(.confirm)
    let posts = console.calls.filter { $0.method == "POST" }
    #expect(posts.map(\.path) == ["/api/devices/2/revoke", "/api/devices/3/revoke"], "others first, the caller's own last")
    #expect(posts.allSatisfy { $0.body == .object(["scope": .string("sessions")]) }, "sessions only — every passkey is kept: \(posts)")
    #expect(pane.note?.kind == .done)
    #expect(pane.note?.text.hasPrefix("Signed out 2 devices") == true, "\(String(describing: pane.note))")

    // with nobody signed in there is nothing to confirm, and the button says why
    let (empty, _, s2) = try devicesReading { devices in
        for i in devices.indices {
            devices[i]["sessions"] = ((devices[i]["sessions"] as? [[String: Any]]) ?? []).map { var s = $0; s["revoked"] = true; return s }
        }
    }
    defer { withExtendedLifetime(s2) {} }
    await empty.refresh()
    #expect(empty.signOutUnavailableReason == DevicesWords.nothingSignedIn)
    empty.proposeSignOutEverywhere()
    #expect(empty.confirmation == nil)
}

@MainActor
@Test func addAPhoneOpensTheSheetAndClosingItCancelsAndReReads() async throws {
    let (pane, console, session) = try devicesReading()
    defer { withExtendedLifetime(session) {} }
    await pane.refresh()
    let runner = EnrollRunner(mint: CommandResult(exitCode: 0, stdout: mintedJSON() + "\n", stderr: ""))
    pane.makeAddPhone = { [session] in
        let model = AddPhoneModel(management: runner, session: session)
        model.now = { t0 }
        model.pollInterval = .seconds(3600)
        return model
    }
    var copied: [String] = []
    pane.copyText = { copied.append($0) }
    console.reset()

    pane.beginAddPhone()
    let sheet = try #require(pane.addPhone)
    // Checking → Ready: the verb ran, nothing was asked of the console but the baseline
    while sheet.phase == .checking { try await Task.sleep(for: .milliseconds(20)) }
    #expect(runner.argv == [["enroll", "--json"]])
    #expect(console.calls.map(\.servedBy) == ["get-api-devices"])
    guard case .ready = sheet.phase else {
        Issue.record("expected ready, got \(sheet.phase)")
        return
    }
    // the sheet's Copy Link is the pane's pasteboard
    sheet.copyLink()
    #expect(copied == [mintedURL])
    pane.beginAddPhone()
    #expect(pane.addPhone === sheet, "one sheet at a time")

    // Done: the sheet is gone at once, the code is cancelled, and the list is re-read
    pane.closeAddPhone()
    #expect(pane.addPhone == nil)
    while runner.cancels.isEmpty { try await Task.sleep(for: .milliseconds(20)) }
    #expect(runner.cancels == [["enroll", "--cancel", "42", "--json"]])
    while console.calls.count < 2 { try await Task.sleep(for: .milliseconds(20)) }
    #expect(console.calls.last?.servedBy == "get-api-devices")
}

// MARK: - §2.18

@MainActor
@Test func thePaneSpeaksEveryControlAndGrowsLongerAtTheLargestText() async throws {
    let (pane, _, session) = try devicesReading()
    defer { withExtendedLifetime(session) {} }
    await pane.refresh()
    let tree = try await AccessibilityProbe.snapshot(DevicesPaneBody(pane: pane).frame(width: SettingsLayout.pane))
    defer { tree.close() }
    #expect(tree.unlabeledBesidesFields.isEmpty, "unlabeled: \(tree.unlabeledBesidesFields)")
    #expect(tree.headings.contains(AddPhoneWords.title))
    #expect(tree.headings.contains("Devices"))
    #expect(tree.headings.contains(DevicesWords.signOutEverywhere))
    #expect(tree.controlNames.contains(AddPhoneWords.addAPhone))
    #expect(tree.controlNames.contains("Remove iPad") && tree.controlNames.contains("Remove iPhone"), "\(tree.controlNames)")
    #expect(tree.controlNames.contains { $0.hasPrefix(DevicesWords.signOutEverywhere) })
    #expect(tree.saysAssistant.isEmpty)

    var heights: [DynamicTypeSize: CGFloat] = [:]
    for size in [DynamicTypeSize.large, .accessibility5] {
        let renderer = ImageRenderer(content: VStack(alignment: .leading, spacing: MetistrySpace.s5) { DevicesPaneBody(pane: pane) }
            .padding(MetistrySpace.s5)
            .frame(width: SettingsLayout.pane)
            .environment(\.dynamicTypeSize, size))
        renderer.proposedSize = ProposedViewSize(width: SettingsLayout.pane, height: nil)
        renderer.scale = 1
        let image = try #require(renderer.cgImage)
        #expect(CGFloat(image.width) <= SettingsLayout.pane, "\(image.width) wide at \(size)")
        heights[size] = CGFloat(image.height)
    }
    #expect((heights[.accessibility5] ?? 0) > (heights[.large] ?? 0), "did not grow at the largest text: \(heights)")
}

// MARK: - The wizard's step 6 opens the same sheet

@MainActor
@Test func stepSixOpensTheSheetAndAnAddedPhoneSatisfiesTheDoor() async throws {
    let steps = FirstRunModel(cli: nil, resolution: RuntimeResolution(runtime: nil, attempts: []))
    let runner = EnrollRunner(mint: CommandResult(exitCode: 0, stdout: mintedJSON() + "\n", stderr: ""))
    steps.makeAddPhone = {
        let model = AddPhoneModel(management: runner, session: nil)
        model.now = { t0 }
        return model
    }
    let wizard = WizardModel(steps: steps)
    steps.doorPlan = .otherDevices
    // every install today: the console's own flow, not a native ceremony
    steps.passkey.adopt(consoleURL: "http://127.0.0.1:8080")
    #expect(steps.passkey.route?.isNative == false)
    #expect(!wizard.isSatisfied(.door))

    steps.beginAddPhone()
    let sheet = try #require(steps.addPhone)
    while sheet.phase == .checking { try await Task.sleep(for: .milliseconds(20)) }
    #expect(runner.argv == [["enroll", "--json"]])
    // the step never shows a command to copy any more
    let tree = try await AccessibilityProbe.snapshot(PasskeyStepView(steps: steps).frame(width: 640))
    defer { tree.close() }
    #expect(!tree.nodes.contains { $0.name.contains("enroll.mjs") }, "\(tree.nodes.map(\.name).filter { !$0.isEmpty })")
    #expect(tree.controlNames.contains(AddPhoneWords.addAPhone), "\(tree.controlNames)")
    #expect(tree.unlabeledBesidesFields.isEmpty, "unlabeled: \(tree.unlabeledBesidesFields)")

    // Added satisfies the step: it is the same door, opened for the phone
    sheet.onAdded("Matt's iPhone")
    #expect(steps.phoneAdded == "Matt's iPhone")
    #expect(wizard.isSatisfied(.door))
    steps.closeAddPhone()
    #expect(steps.addPhone == nil)
    while runner.cancels.isEmpty { try await Task.sleep(for: .milliseconds(20)) }
    #expect(runner.cancels == [["enroll", "--cancel", "42", "--json"]])
}
#endif

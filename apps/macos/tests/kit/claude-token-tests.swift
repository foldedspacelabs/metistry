// Step 7: the watch, and the promise it is built around.
//
// The promise is that the app never handles the token's value. There is no test
// that can prove a negative, but there is one that keeps the surface small
// enough to check by reading: everything this model knows about the secret comes
// from `metistry secrets list --json`, whose reply carries a name, a scope and
// two booleans.

import Foundation
import Testing

@testable import MetistryKit

@MainActor
private func model(
    stdout: String = "[]",
    exitCode: Int32 = 0,
    stderr: String = "",
    terminal: (any TerminalOpener)? = nil,
    binary: URL? = URL(fileURLWithPath: "/Users/you/.local/bin/claude")
) -> ClaudeTokenModel {
    let cli = MetistryCLI(
        runtime: MetistryRuntime(source: .path, executable: URL(fileURLWithPath: "/usr/local/bin/metistry")),
        runner: ScriptedRunner(result: CommandResult(exitCode: exitCode, stdout: stdout, stderr: stderr))
    )
    return ClaudeTokenModel(cli: cli, terminal: terminal, claudeBinary: binary)
}

private let tokenSet = """
[{ "name": "CLAUDE_CODE_OAUTH_TOKEN", "scope": "user", "inKeychain": true, "foundUnder": "user", "inEnv": true }]
"""
private let tokenAbsent = """
[{ "name": "METISTRY_DB_PASSWORD", "scope": "instance", "inKeychain": true, "foundUnder": "instance", "inEnv": true }]
"""

@MainActor
@Test func withNoClaudeBinaryTheStepSaysWhereItLookedAndStops() {
    let m = model(binary: nil)
    #expect(m.phase == .unavailable(ClaudeCodeLocator.notFoundReason))
    #expect(m.setupCommand == nil)
    #expect(ClaudeCodeLocator.notFoundReason.contains("~/.local/bin"))
    #expect(ClaudeCodeLocator.notFoundReason.contains("node_modules/.bin"))
}

@MainActor
@Test func theCommandShownIsTheCommandThatWillRun() {
    let m = model()
    #expect(m.setupCommand == "/Users/you/.local/bin/claude setup-token")
}

@MainActor
@Test func aTokenAlreadySetIsReportedWithItsScopeAndNothingElse() async {
    let m = model(stdout: tokenSet)
    let found = await m.check()
    #expect(found)
    #expect(m.isSet)
    // Scope, not value: user-scoped is one Claude login per Mac.
    guard case .set(let scope) = m.phase else { Issue.record("expected .set"); return }
    #expect(scope.contains("one per Mac"))
    #expect(m.listing?.name == ClaudeTokenModel.variable)
    // The command that produced the answer is on screen like every other one.
    #expect(m.lastCommand?.contains("secrets list --json") == true)
}

@MainActor
@Test func aTokenThatIsNotThereNamesTheImportCommand() async {
    let m = model(stdout: tokenAbsent)
    let found = await m.check()
    #expect(!found)
    guard case .notSet(let why) = m.phase else { Issue.record("expected .notSet"); return }
    #expect(why.contains(ClaudeTokenModel.importCommand))
    #expect(ClaudeTokenModel.importCommand == "metistry secrets sync --to keychain")
}

@MainActor
@Test func aCliWithoutTheJsonListingSaysSoRatherThanNotSet() async {
    let stale = model(stdout: "", exitCode: 2, stderr: "unknown command: secrets\n")
    await stale.check()
    // "not set" would be a wrong answer, not a missing one.
    #expect(stale.phase == .failed(
        "this CLI has no `secrets list` verb yet — update it (metistry update, or Check for Updates…)"
    ))
}

@MainActor
@Test func signingInOpensATerminalOnTheCommandAndThenWatches() async {
    let terminal = RecordingTerminal()
    let m = model(stdout: tokenSet, terminal: terminal)
    await m.signIn(sleep: { _ in })
    #expect(terminal.opened.count == 1)
    #expect(terminal.opened.first?.command == "/Users/you/.local/bin/claude setup-token")
    // The two are one action: a login the app was not watching for is a login
    // the person has to come back and announce.
    #expect(m.isSet)
    #expect(m.polls == 1)
}

@MainActor
@Test func theWatchKeepsAskingUntilTheNameAppears() async {
    // Not set, not set, then set — the shape of a real OAuth round trip.
    let cli = MetistryCLI(
        runtime: MetistryRuntime(source: .path, executable: URL(fileURLWithPath: "/usr/local/bin/metistry")),
        runner: ScriptedRunner(sequence: [
            CommandResult(exitCode: 0, stdout: tokenAbsent, stderr: ""),
            CommandResult(exitCode: 0, stdout: tokenAbsent, stderr: ""),
            CommandResult(exitCode: 0, stdout: tokenSet, stderr: ""),
        ])
    )
    let m = ClaudeTokenModel(cli: cli, terminal: RecordingTerminal(), claudeBinary: URL(fileURLWithPath: "/bin/claude"))
    await m.signIn(sleep: { _ in })
    #expect(m.isSet)
    #expect(m.polls == 3)
}

@MainActor
@Test func theWatchGivesUpOutLoudRatherThanQuietlyStopping() async {
    let m = model(stdout: tokenAbsent)
    // Drive `watch` directly with an instant sleep: a step that stopped watching
    // without saying so would look like one still watching.
    await m.watch(sleep: { _ in })
    #expect(m.polls == ClaudeTokenModel.pollLimit)
    guard case .notSet(let why) = m.phase else { Issue.record("expected .notSet"); return }
    #expect(why.contains("Stopped watching"))
    #expect(why.contains(ClaudeTokenModel.importCommand))
}

@MainActor
@Test func aWatchThatHitsAFailureStopsRatherThanSpinning() async {
    let m = model(stdout: "", exitCode: 2, stderr: "unknown command: secrets\n")
    await m.watch(sleep: { _ in })
    #expect(m.polls == 1)
    guard case .failed = m.phase else { Issue.record("expected .failed"); return }
}

@Test func theBinaryIsLookedForWherePeopleActuallyHaveIt() {
    let home = URL(fileURLWithPath: "/Users/you")
    let dirs = ClaudeCodeLocator.candidateDirectories(home: home, productDir: URL(fileURLWithPath: "/product"))
        .map(\.path)
    #expect(dirs.first == "/Users/you/.local/bin")
    #expect(dirs.contains("/Users/you/.claude/local"))
    #expect(dirs.contains("/opt/homebrew/bin"))
    // The product's own copy is LAST: a Claude login belongs to the person, and
    // CLAUDE_CODE_OAUTH_TOKEN is user-scoped for the same reason.
    #expect(dirs.last == "/product/node_modules/.bin")
}

@Test func theStepsPromiseIsWrittenDownWhereItCanBeChecked() {
    #expect(ClaudeTokenModel.note.contains("never sees the token"))
    #expect(ClaudeTokenModel.note.contains("secrets list --json"))
    #expect(ClaudeTokenModel.variable == "CLAUDE_CODE_OAUTH_TOKEN")
}

/// Answers a scripted sequence, then repeats the last one — so a watch can be
/// walked through "not yet, not yet, there it is" without a real clock.
private final class ScriptedRunner: CommandRunner, @unchecked Sendable {
    private let lock = NSLock()
    private nonisolated(unsafe) var sequence: [CommandResult]
    private let fallback: CommandResult

    init(result: CommandResult) {
        self.sequence = []
        self.fallback = result
    }

    init(sequence: [CommandResult]) {
        self.sequence = sequence
        self.fallback = sequence.last ?? CommandResult(exitCode: 0, stdout: "[]", stderr: "")
    }

    func run(
        executable: URL, arguments: [String], environment: [String: String],
        currentDirectory: URL?, onOutput: @escaping @Sendable (OutputLine) -> Void
    ) async throws -> CommandResult {
        lock.withLock {
            sequence.isEmpty ? fallback : sequence.removeFirst()
        }
    }
}

private final class RecordingTerminal: TerminalOpener, @unchecked Sendable {
    struct Opened: Sendable { let command: String; let title: String }
    private(set) var opened: [Opened] = []

    func open(command: String, title: String) throws {
        opened.append(Opened(command: command, title: title))
    }
}

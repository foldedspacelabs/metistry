// The five answers `metistry console whoami --json` can give, and the one path
// the app is allowed to ask them down.
//
// The five states are the whole contract of console-sign-in.swift, and each one
// has to be distinguishable from the others by the CLI's own output alone —
// there is no side channel and no guessing. The last three tests in this file
// are a different kind: they walk the app's own source tree and assert that the
// app cannot be reading the token, whatever any comment says. Enforce at the
// tool, never by prompting (CLAUDE.md).

import Foundation
import Testing

@testable import MetistryKit

// MARK: - The five states

@Test func signedInIsTheOnlyStateThatCameFromAnAnswer() {
    let stdout = """
    {
      "url": "http://127.0.0.1:8080",
      "principal": "user",
      "via": "local_owner_token",
      "management": true,
      "origin": "https://studio.example",
      "as_of": "2026-09-10T15:42:22.406Z"
    }
    """
    let state = ConsoleSignIn.from(CommandResult(exitCode: 0, stdout: stdout, stderr: ""), shape: "launchd")
    #expect(state.isSignedIn)
    // The sentence the Status header and Settings → Connections print.
    #expect(state.headline == "Signed in as owner (local token)")
    // `via` is shown verbatim beside it: it is the value docs/ops/auth.md names,
    // and the one worth quoting in a bug report.
    #expect(state.detail.contains("via local_owner_token"))
    #expect(state.detail.contains("management yes"))
    #expect(state.detail.contains("http://127.0.0.1:8080"))
    #expect(state.status == .ok)
    // Nothing to do — so nothing is offered to do.
    #expect(state.remedy == nil)
}

@Test func aPasskeySessionAndACaptureTokenAreTheSameStateSaidDifferently() {
    // The console answers the same shape for all three credentials; the app
    // must not pretend only one of them exists.
    let passkey = ConsoleSignIn.from(
        CommandResult(exitCode: 0, stdout: #"{"principal":"user","via":"passkey_session","management":true}"#, stderr: ""),
        shape: nil
    )
    #expect(passkey.headline == "Signed in as owner (passkey session)")

    let capture = ConsoleSignIn.from(
        CommandResult(exitCode: 0, stdout: #"{"principal":"owner_token","via":"owner_token","management":false}"#, stderr: ""),
        shape: nil
    )
    // Not "owner": a host-minted capture token never reaches management, and
    // calling it the owner on screen would be a lie the console does not tell.
    #expect(capture.headline == "Signed in as owner_token (capture token)")
    #expect(capture.detail.contains("management no"))
}

@Test func aCliWithoutTheVerbSaysUpdateTheCliRatherThanReportingAFailedSignIn() {
    // packages/cli/src/main.ts's default branch: exit 2, `unknown command`.
    let stale = CommandResult(exitCode: 2, stdout: "", stderr: "unknown command: console\n\nmetistry — Metistry command line\n")
    let state = ConsoleSignIn.from(stale, shape: "launchd")
    #expect(state.headline.contains("no `console whoami`"))
    #expect(state.detail.contains("update it"))
    #expect(state.remedy == [["metistry", "update"]])
    // Degraded, not failed: the install works; this app's view of it does not.
    #expect(state.status == .degraded)

    // A CLI that has `console` but not `whoami` answers `usage:` with the same
    // exit code, and means the same thing to a person.
    let usage = CommandResult(exitCode: 2, stdout: "", stderr: "usage: metistry console whoami [--json]\n")
    #expect(ConsoleSignIn.from(usage, shape: nil).status == .degraded)
}

@Test func anUnsetTokenNamesTheExactCommandThatMintsOne() {
    let stderr = "metistry console whoami: METISTRY_LOCAL_OWNER_TOKEN is not set (env, <instance>/state/.env, or the login Keychain) — `metistry secrets sync --to env` mints one for an install that predates it, then restart the console"
    let state = ConsoleSignIn.from(CommandResult(exitCode: 1, stdout: "", stderr: stderr), shape: "launchd")
    #expect(state.headline == "No local owner token on this install")
    // The CLI's own words, unedited.
    #expect(state.detail.contains("is not set"))
    // And the two commands, in the order they have to run — a freshly minted
    // token does nothing until the console is restarted with it.
    #expect(state.remedy == [
        ["metistry", "secrets", "sync", "--to", "env"],
        ["metistry", "restart", "console"],
    ])
    // A token nobody minted is `absent`, not a fault — the same rule that keeps
    // an unconfigured bridge out of doctor's exit code.
    #expect(state.status == .absent)
}

@Test func anUnreachableConsoleIsNotDressedAsARefusal() {
    let stderr = "metistry console whoami: console unreachable at http://127.0.0.1:8080: connect ECONNREFUSED 127.0.0.1:8080"
    let state = ConsoleSignIn.from(CommandResult(exitCode: 1, stdout: "", stderr: stderr), shape: "launchd")
    #expect(state.headline == "The console did not answer")
    #expect(state.detail.contains("ECONNREFUSED"))
    #expect(state.status == .failed)
    // Nothing this app can name would fix it, so it names nothing. A remedy
    // invented here would send someone the wrong way.
    #expect(state.remedy == nil)
}

@Test func aFourZeroOneSaysWhichOfLoopbackOrStalenessIsLikelier() {
    let stderr = "metistry console whoami: http://127.0.0.1:8080 refused the owner token (401). Either METISTRY_LOCAL_OWNER_TOKEN here is not the one the console was started with, or the request did not reach it from this machine."

    // Under compose the port is published through Docker's NAT, so the console
    // sees the bridge gateway rather than 127.0.0.1 — the loopback rule first.
    let compose = ConsoleSignIn.from(CommandResult(exitCode: 1, stdout: "", stderr: stderr), shape: "compose")
    #expect(compose.headline == "The console refused the token (401)")
    #expect(compose.status == .failed)
    #expect(compose.detail.contains("Most likely: the request did not reach the console over loopback"))
    #expect(compose.detail.contains("METISTRY_TRUSTED_LOOPBACK_PROXY"))
    // And the CLI's own message is still there, above the diagnosis.
    #expect(compose.detail.contains("401"))

    // Under launchd the console binds loopback directly, so the likelier cause
    // is that it was STARTED with a different value.
    let launchd = ConsoleSignIn.from(CommandResult(exitCode: 1, stdout: "", stderr: stderr), shape: "launchd")
    #expect(launchd.detail.contains("Most likely: the \(ConsoleSignIn.tokenVariable) in this environment is not the one the console was STARTED with"))

    // Shape unknown: both, said as both, rather than a guess dressed as a fact.
    let unknown = ConsoleSignIn.from(CommandResult(exitCode: 1, stdout: "", stderr: stderr), shape: nil)
    #expect(unknown.detail.contains("both are live"))

    // Either way the fix is the same pair of commands.
    #expect(compose.remedy == ConsoleSignIn.mintCommands)
}

@Test func theStatesAreToldApartByPhrasesTheVariablesRenameCannotBreak() {
    // The secret is being renamed (METISTRY_OWNER_TOKEN -> METISTRY_LOCAL_OWNER_TOKEN),
    // so nothing here may match on its name. Both spellings map identically.
    for name in ["METISTRY_OWNER_TOKEN", "METISTRY_LOCAL_OWNER_TOKEN", "SOMETHING_ELSE_ENTIRELY"] {
        let unset = CommandResult(exitCode: 1, stdout: "", stderr: "\(name) is not set (env, <instance>/state/.env, or the login Keychain)")
        #expect(ConsoleSignIn.from(unset, shape: nil).status == .absent, "unset, named \(name)")

        let refused = CommandResult(exitCode: 1, stdout: "", stderr: "http://127.0.0.1:8080 refused the owner token (401). Either \(name) here is …")
        if case .refused = ConsoleSignIn.from(refused, shape: nil) {} else {
            Issue.record("a 401 named \(name) was not read as a refusal")
        }
    }
}

@Test func anExitZeroThatPrintsSomethingUnreadableIsAContractDisagreement() {
    // Not "the console is down" and not "signed in": the app and the CLI
    // disagree about the reply's shape, and the fix is the same as a missing
    // verb's.
    let state = ConsoleSignIn.from(CommandResult(exitCode: 0, stdout: "hello\n", stderr: ""), shape: nil)
    #expect(state.status == .degraded)
    #expect(state.detail.contains("could not read"))
    #expect(!state.isSignedIn)

    // Exit 0 with valid JSON that names no principal is the same thing.
    let empty = ConsoleSignIn.from(CommandResult(exitCode: 0, stdout: #"{"ok":true}"#, stderr: ""), shape: nil)
    #expect(!empty.isSignedIn)
}

@Test func aFailureWithNoRecognisedPhraseStillSaysSomethingTrue() {
    let state = ConsoleSignIn.from(CommandResult(exitCode: 1, stdout: "", stderr: "EPERM: operation not permitted"), shape: nil)
    // The one headline that claims nothing about the cause, with the CLI's
    // verbatim line under it.
    #expect(state.headline == "The console did not answer")
    #expect(state.detail == "EPERM: operation not permitted")
}

// MARK: - The token is not a thing this app can hold

@Test func whoamiHasNoFieldATokenCouldLandIn() {
    // A reply carrying a token — which the CLI does not send, and must never be
    // able to make the app show — is decoded without it. There is no property
    // to put it in, and nothing rendered mentions it.
    let json = try! JSONValue.parse(Data(#"""
    {"principal":"user","via":"local_owner_token","management":true,"token":"sk-not-a-real-secret","url":"http://127.0.0.1:8080"}
    """#.utf8))
    let whoami = try! #require(ConsoleWhoami(json: json))
    let state = ConsoleSignIn.signedIn(whoami)
    #expect(!state.headline.contains("sk-not-a-real-secret"))
    #expect(!state.detail.contains("sk-not-a-real-secret"))
    // What it DOES say is the credential's kind, which is not a secret and is
    // the thing docs/ops/auth.md names.
    #expect(state.detail.contains("via local_owner_token"))
}

@Test func stdoutIsNeverEchoedByAFAILINGState() {
    // A verb that failed puts its reason on stderr. If stdout ever carried a
    // value, a state that echoed it would leak one — so no failing state reads
    // stdout at all.
    let leaky = CommandResult(exitCode: 1, stdout: "Bearer sk-not-a-real-secret", stderr: "console unreachable at http://127.0.0.1:8080")
    let state = ConsoleSignIn.from(leaky, shape: nil)
    #expect(!state.detail.contains("sk-not-a-real-secret"))
}

// MARK: - The model

@MainActor
@Test func withNoRuntimeTheModelSaysSoRatherThanAnsweringTheQuestion() async {
    let model = ConsoleSignInModel(cli: nil)
    await model.refresh()
    #expect(model.signIn == nil)
    #expect(model.phase == .unavailable(CLIReadError.noRuntime.localizedDescription))
    // No dot is a dot the model has not earned; `unavailable` is `failed`.
    #expect(model.status == .failed)
}

@MainActor
@Test func theModelShowsTheExactCommandItRanAndAsksOnlyOnce() async {
    let runner = ScriptedRunner(result: CommandResult(
        exitCode: 0,
        stdout: #"{"principal":"user","via":"local_owner_token","management":true,"url":"http://127.0.0.1:8080"}"#,
        stderr: ""
    ))
    let model = ConsoleSignInModel(cli: signInCLI(runner), shape: "launchd")
    #expect(model.phase == .idle)

    await model.refreshIfNeeded()
    #expect(model.phase == .answered)
    #expect(model.signIn?.isSignedIn == true)
    #expect(model.headline == "Signed in as owner (local token)")
    #expect(model.lastCommand == "/usr/bin/node /src/packages/cli/dist/main.js console whoami --json --product-dir /src")
    #expect(runner.invocations.count == 1)
    #expect(runner.invocations.first?.contains("whoami") == true)

    // `refreshIfNeeded` is for a view's `.task`: it must not re-ask on redraw.
    await model.refreshIfNeeded()
    #expect(runner.invocations.count == 1)
    // The button, which is explicit, does.
    await model.refresh()
    #expect(runner.invocations.count == 2)
}

@MainActor
@Test func switchingInstanceDropsThePreviousAnswerRatherThanCarryingItOver() async {
    let runner = ScriptedRunner(result: CommandResult(
        exitCode: 0,
        stdout: #"{"principal":"user","via":"local_owner_token","management":true}"#,
        stderr: ""
    ))
    let model = ConsoleSignInModel(cli: signInCLI(runner))
    await model.refresh()
    #expect(model.signIn?.isSignedIn == true)

    // A "signed in" belongs to the install it was asked about. Showing it beside
    // a different instance path is the one thing this row must never do.
    model.adopt(cli: signInCLI(runner), shape: "compose")
    #expect(model.signIn == nil)
    #expect(model.phase == .idle)
    #expect(model.lastCommand == nil)
    #expect(model.status == nil)
}

@MainActor
@Test func aRunnerThatCannotStartTheProcessIsNotAConsoleAnswer() async {
    let model = ConsoleSignInModel(cli: signInCLI(ThrowingRunner()))
    await model.refresh()
    #expect(model.signIn?.status == .failed)
    #expect(model.signIn?.detail.contains("could not run") == true)
}

// MARK: - One path to the console, enforced by reading the app's own source

@Test func everyConsoleCallGoesThroughOneClientAndOnlyTheCliIsAuthenticated() throws {
    let sources = try swiftSources()
    #expect(sources.count > 20, "the source scan found almost nothing — the path is wrong, not the app")

    // 1. The console's HTTP transport lives in exactly one file. The one
    //    other HTTP client is the capture bar's wire to the live-capture
    //    bridge on this Mac (plan §2.2: controlling a recording is
    //    device-local — no CLI verb, no console route), held to its own
    //    rules by `theBarsBridgeWireIsTheOnlyOtherDoorAndReachesOnlyTheRecorder` below.
    let usesURLSession = sources.filter { $0.body.contains("URLSession.shared") || $0.body.contains("URLSession(configuration") }.map(\.name)
    #expect(usesURLSession == ["console-client.swift", LiveCaptureDoor.transport])

    // 2. Nothing sets an Authorization header toward the CONSOLE. There is no
    //    CLI verb that hands this app a bearer scoped to the calling process
    //    (PR #119 added `console whoami` and nothing else), so the app has none
    //    to send — and it must not invent one by reading the Keychain or .env.
    //    The bar's bridge wire is the one file that sets one, and only the
    //    recorder's control key, only to loopback (checked below).
    for source in sources where source.name != LiveCaptureDoor.transport {
        for match in source.body.ranges(of: "forHTTPHeaderField:") {
            let tail = source.body[match.upperBound...].prefix(40).lowercased()
            #expect(
                tail.contains("\"content-type\"") || tail.contains("\"cookie\"") || tail.contains("\"set-cookie\""),
                "\(source.name) sets an HTTP header that is not content-type or cookie"
            )
        }
        #expect(!source.body.lowercased().contains("\"authorization\""), "\(source.name) names an Authorization header")
        #expect(!source.body.contains("Bearer "), "\(source.name) builds a bearer token")
    }

    // 3. No Keychain, from Swift, but one read. The CLI is the one place
    //    that knows where the local owner token lives. The recorder's control
    //    key is the single exception (live-capture-key.swift): one read-only
    //    query for one service, held below to never writing and never naming
    //    another item.
    for needle in ["SecItem", "kSecClass", "SecKeychain", "find-generic-password"] {
        let offenders = sources.filter { $0.body.contains(needle) && $0.name != LiveCaptureDoor.key }.map(\.name)
        #expect(offenders.isEmpty, "\(needle) appears in \(offenders)")
    }

    // 4. And no file is opened for a CONSOLE OR CLI VALUE — which is what makes
    //    "the app does not parse <instance>/state/.env" a fact rather than a
    //    promise. Every value on every screen still arrives from a `metistry`
    //    verb's stdout.
    //
    //    Three matches are not that:
    //      * `FileHandle.write(contentsOf:)` reads nothing: it is how a pasted
    //        API key reaches `metistry compute providers add`'s STDIN without
    //        ever passing through argv (compute-step.swift, process-command-
    //        runner.swift).
    //      * `Array.append(contentsOf:)` (and the like) is not file I/O at all
    //        — `capture-view.swift` uses it to fold the reloaded queue back
    //        into `captures`.
    //      * `capture-store.swift`'s `JSONCaptureQueueStore` is ruling 19's
    //        named, documented exception (`app-preferences.swift`'s
    //        `AppFileStore`): the offline capture queue is this app's OWN
    //        state, never a console or CLI value, so this guard is not the
    //        one ruling 19 needed to clear.
    //    All three are excluded by name so the rest of the guard stays a guard.
    let readsFiles = sources
        .filter { $0.name != "capture-store.swift" }
        .filter {
            $0.body
                .replacingOccurrences(of: "write(contentsOf:", with: "")
                .replacingOccurrences(of: "append(contentsOf:", with: "")
                .contains("contentsOf:")
        }
        .map(\.name)
    #expect(readsFiles.isEmpty, "these read a file directly: \(readsFiles)")
}

/// The two files the source walk above names as the capture bar's door to
/// the live-capture bridge (T8-5), and nothing else.
enum LiveCaptureDoor {
    static let transport = "live-capture-transport.swift"
    static let key = "live-capture-key.swift"
}

@Test func theBarsBridgeWireIsTheOnlyOtherDoorAndReachesOnlyTheRecorder() throws {
    let sources = try swiftSources()
    let transport = try #require(sources.first { $0.name == LiveCaptureDoor.transport }?.body)
    let key = try #require(sources.first { $0.name == LiveCaptureDoor.key }?.body)

    // The wire: loopback, the bridge's port, a route from a closed enum, and
    // two headers — the body's type and the control key's bearer.
    #expect(transport.contains("host = \"127.0.0.1\""), "the bridge wire is loopback only")
    #expect(!transport.contains("URL(string:"), "no caller-supplied URL")
    #expect(transport.contains("willPerformHTTPRedirection") && transport.contains("-> URLRequest? {\n        nil"), "redirects are refused, so the bearer never follows one")
    for match in transport.ranges(of: "forHTTPHeaderField:") {
        let tail = String(transport[match.upperBound...].prefix(40))
        #expect(tail.contains("\"Content-Type\"") || tail.contains("LiveCaptureBearer.field"), "an unexpected header: \(tail)")
    }
    #expect(transport.contains("static func header(_ key: LiveCaptureControlKey)"), "the bearer is only ever the control key")
    #expect(LiveCaptureBridge.url(.status).absoluteString == "http://127.0.0.1:7815/status")
    #expect(Set(LiveCaptureRoute.allCases.map { LiveCaptureBridge.url($0).host }) == ["127.0.0.1"])

    // The Keychain read: one query, read-only, one service.
    #expect(key.contains("SecItemCopyMatching"))
    for write in ["SecItemAdd", "SecItemUpdate", "SecItemDelete", "SecKeychain", "find-generic-password", "kSecUseDataProtectionKeychain"] {
        #expect(!key.contains(write), "\(write) in the key source")
    }
    let services = key.ranges(of: "\"metistry:").map { key[$0.lowerBound...].prefix(60).split(separator: "\"")[0] }
    #expect(Set(services).count == 1, "exactly one Keychain service is named: \(services)")
    #expect(KeychainLiveCaptureKeySource.service == "metistry:METISTRY_LIVE_CAPTURE_CONTROL_TOKEN")
    #expect(!key.contains("OWNER_TOKEN") && !key.contains("BRIDGE_TOKEN"), "the key source names no other credential")

    // …and the console's own client still sets none of this.
    let client = try #require(sources.first { $0.name == "console-client.swift" }?.body)
    #expect(!client.contains("LiveCapture"), "the console client never touches the recorder's key")
}

@Test func theHttpRoutesTheAppSpeaksAreAllPublicBootstrapOnes() throws {
    // The four the console's own PWA speaks, and no more. A fifth appearing
    // here without appearing in this list is the review this test is for.
    #expect(ConsoleClient.publicRoutes == [
        "GET /health",
        "POST /auth/login/start",
        "POST /auth/enroll/start",
        "POST /auth/enroll/finish",
    ])

    let client = try swiftSources().first { $0.name == "console-client.swift" }
    let body = try #require(client?.body)
    for path in ["/health", "/auth/login/start", "/auth/enroll/start", "/auth/enroll/finish"] {
        #expect(body.contains("\"\(path)\""), "\(path) is listed as public but is not called")
    }
    // The authenticated surface is the CLI, and it is one verb.
    #expect(ConsoleClient.whoamiVerb == ["console", "whoami", "--json"])
}

// MARK: - Helpers

private struct SwiftSource {
    let name: String
    let body: String
}

/// Every `.swift` file under `apps/macos/sources`, found from this test file's
/// own path so it works from any working directory.
private func swiftSources() throws -> [SwiftSource] {
    let sources = URL(fileURLWithPath: #filePath)      // tests/kit/<this>.swift
        .deletingLastPathComponent()                    // tests/kit
        .deletingLastPathComponent()                    // tests
        .deletingLastPathComponent()                    // apps/macos
        .appendingPathComponent("sources")
    let enumerator = try #require(FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil))
    var found: [SwiftSource] = []
    for case let url as URL in enumerator where url.pathExtension == "swift" {
        found.append(SwiftSource(name: url.lastPathComponent, body: try String(contentsOf: url, encoding: .utf8)))
    }
    return found.sorted { $0.name < $1.name }
}

@MainActor
private func signInCLI(_ runner: any CommandRunner) -> MetistryCLI {
    MetistryCLI(
        runtime: MetistryRuntime(
            source: .checkout,
            executable: URL(fileURLWithPath: "/usr/bin/node"),
            leadingArguments: ["/src/packages/cli/dist/main.js"],
            productDir: URL(fileURLWithPath: "/src")
        ),
        runner: runner
    )
}

/// Records what it was asked to run. Every call in these tests is made from the
/// main actor, so the recording is confined to it rather than locked.
@MainActor
private final class ScriptedRunner: CommandRunner {
    let result: CommandResult
    private(set) var invocations: [String] = []

    nonisolated init(result: CommandResult) { self.result = result }

    nonisolated func run(
        executable: URL, arguments: [String], environment: [String: String],
        currentDirectory: URL?, standardInput: String?, onOutput: @escaping @Sendable (OutputLine) -> Void
    ) async throws -> CommandResult {
        await record(arguments.joined(separator: " "))
        return result
    }

    private func record(_ argv: String) { invocations.append(argv) }
}

private struct ThrowingRunner: CommandRunner {
    func run(
        executable: URL, arguments: [String], environment: [String: String],
        currentDirectory: URL?, standardInput: String?, onOutput: @escaping @Sendable (OutputLine) -> Void
    ) async throws -> CommandResult {
        throw CommandRunnerError.notExecutable(executable)
    }
}

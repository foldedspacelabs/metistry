// Step 7: choosing compute, and the promise the step is built around.
//
// The promise is that the app never STORES the key and never shows it: it goes
// to the CLI's stdin, never to argv, and the property that held it is cleared
// before the process runs. Two of these tests are that promise — one reads the
// argument arrays, one reads what the runner was handed — and the rest are the
// shape of the step: what it will run, what the CLI's refusal looks like on
// screen, and that skipping is a state, not a failure.

import Foundation
import Testing

@testable import MetistryKit

private let report = """
{
  "file": "/i/compute.yaml",
  "instance_file": "/i/compute.yaml",
  "providers": [
    { "name": "openrouter", "kind": "openai-compatible", "locality": "off_machine", "base_url": "https://openrouter.ai/api/v1",
      "zdr": true, "secret": "METISTRY_OPENROUTER_API_KEY", "secret_present": true, "models_assigned": ["anthropic/claude-sonnet-5"] }
  ],
  "assignments": [
    { "target": "default", "provider": "openrouter", "model": "anthropic/claude-sonnet-5", "effort": "medium", "warn_non_zdr": false }
  ],
  "assigns_nothing": false
}
"""

private let nothingAssigned = """
{ "files": [], "instance_file": "/i/compute.yaml", "providers": [], "assignments": [], "assigns_nothing": true }
"""

@MainActor
private func stepModel(_ runner: RecordingRunner) -> ComputeStepModel {
    ComputeStepModel(
        cli: MetistryCLI(
            runtime: MetistryRuntime(source: .path, executable: URL(fileURLWithPath: "/usr/local/bin/metistry")),
            runner: runner
        )
    )
}

@MainActor
@Test func theTwoCommandsAreShownBeforeTheyRunAndCarryNoKey() {
    let m = stepModel(RecordingRunner(results: []))
    m.apiKey = "sk-or-v1-SECRET"
    let planned = m.plannedCommands
    #expect(planned.count == 2)
    #expect(planned[0].contains("compute") && planned[0].contains("providers") && planned[0].contains("add"))
    #expect(planned[0].contains("--from") && planned[0].contains("openrouter"))
    #expect(planned[1].contains("assign") && planned[1].contains("openrouter/anthropic/claude-sonnet-5"))
    // The whole point: a key can never be in an argument array.
    for command in planned {
        for argument in command { #expect(!argument.contains("SECRET")) }
    }
}

@MainActor
@Test func theKeyReachesTheCliOnStdinAndTheAppStopsHoldingIt() async {
    let runner = RecordingRunner(results: [
        CommandResult(exitCode: 0, stdout: "{}", stderr: ""),
        CommandResult(exitCode: 0, stdout: "{}", stderr: ""),
        CommandResult(exitCode: 0, stdout: report, stderr: ""),
    ])
    let m = stepModel(runner)
    m.apiKey = "  sk-or-v1-SECRET \n"
    await m.apply()

    #expect(m.phase == .assigned("openrouter/anthropic/claude-sonnet-5"))
    // 1. it went to stdin, trimmed, with the newline the CLI's stdin reader wants
    #expect(runner.calls[0].standardInput == "sk-or-v1-SECRET\n")
    // 2. it was in no argument of any call
    for call in runner.calls {
        for argument in call.arguments { #expect(!argument.contains("SECRET")) }
    }
    // 3. the property that held it is empty, so nothing observable carries it
    #expect(m.apiKey.isEmpty)
    // 4. and the assign ran second, with the pinned reference
    #expect(runner.calls[1].arguments.contains("openrouter/anthropic/claude-sonnet-5"))
    #expect(runner.calls[1].standardInput == nil)
}

@MainActor
@Test func aLocalProviderIsOfferedWithNoKeyFieldAtAll() async {
    let runner = RecordingRunner(results: [
        CommandResult(exitCode: 0, stdout: "{}", stderr: ""),
        CommandResult(exitCode: 0, stdout: "{}", stderr: ""),
        CommandResult(exitCode: 0, stdout: report, stderr: ""),
    ])
    let m = stepModel(runner)
    m.template = .lmstudio
    #expect(!m.template.needsKey)
    #expect(m.model.isEmpty) // no guess at which model somebody has loaded
    #expect(!m.canApply) // …so there is nothing to assign yet, and the button says so by being off
    m.model = "qwen/qwen3-30b"
    #expect(m.modelRef == "lmstudio/qwen/qwen3-30b")
    await m.apply()
    #expect(runner.calls[0].standardInput == nil) // nothing is piped where nothing is needed
}

@MainActor
@Test func theCliRefusalIsShownInItsOwnWordsAndNothingIsAssigned() async {
    let m = stepModel(RecordingRunner(results: [
        CommandResult(exitCode: 1, stdout: "", stderr: "metistry compute: providers.openrouter already declared\n")
    ]))
    m.apiKey = "sk-or-v1-x"
    await m.apply()
    guard case .failed(let why) = m.phase else { Issue.record("expected .failed"); return }
    #expect(why.contains("already declared"))
    #expect(why.contains("compute providers add"))
    #expect(!m.isSet)
}

@MainActor
@Test func skippingIsAStateWithItsConsequenceWrittenDown() async {
    let m = stepModel(RecordingRunner(results: [CommandResult(exitCode: 0, stdout: nothingAssigned, stderr: "")]))
    await m.refresh()
    #expect(!m.isSet)
    #expect(m.report?.engineSummary.contains("no engine") == true)
    m.skip()
    #expect(m.phase == .skipped)
    // The consequence, in the words an operator would read in doctor and `up`.
    #expect(ComputeStepModel.skipNote.contains("assistant: absent") || ComputeStepModel.skipNote.contains("`assistant: absent`"))
    #expect(ComputeStepModel.skipNote.contains("captures, tasks, search and the console keep working"))
}

@MainActor
@Test func readingTheCurrentStateNamesTheDefaultAndTheKeysPresence() async {
    let m = stepModel(RecordingRunner(results: [CommandResult(exitCode: 0, stdout: report, stderr: "")]))
    await m.refresh()
    #expect(m.isSet)
    #expect(m.report?.defaultRef == "openrouter/anthropic/claude-sonnet-5")
    #expect(m.report?.providers.first?.secret == "METISTRY_OPENROUTER_API_KEY")
    #expect(m.report?.providers.first?.secretPresent == true)
    // presence, never a value — the type has no field that could hold one
    #expect(m.report?.providers.first?.summary.contains("is in the Keychain") == true)
    #expect(m.lastCommand?.contains("compute show --json") == true)
}

@MainActor
@Test func aStaleCliSaysSoRatherThanReportingNoEngine() async {
    let m = stepModel(RecordingRunner(results: [CommandResult(exitCode: 2, stdout: "", stderr: "unknown command: compute\n")]))
    await m.refresh()
    #expect(m.phase == .failed("this CLI has no `compute show` verb yet — update it (metistry update, or Check for Updates…)"))
}

@Test func theTemplatesAreTheOnesTheCliAccepts() {
    // `COMPUTE_TEMPLATES` in packages/cli/src/compute.ts. A template the CLI
    // does not know would be a button that can only fail — and one the CLI has
    // that the app does not is a provider nobody can add from here, which is
    // how `applefm` was missing until the Compute pane went looking for it.
    #expect(ComputeTemplate.allCases.map(\.rawValue) == ["openrouter", "zen", "lmstudio", "ollama", "llamaserver", "applefm"])
    #expect(ComputeTemplate.openrouter.needsKey)
    #expect(!ComputeTemplate.llamaserver.needsKey)
    // apple-fm authenticates with a bridge token this install already minted,
    // so `providers add` finds it in the environment and asks for nothing.
    #expect(!ComputeTemplate.applefm.needsKey)
    #expect(ComputeStepModel.keyNote.contains("standard input"))
}

/// Records what each call was handed, and answers a scripted list.
private final class RecordingRunner: CommandRunner, @unchecked Sendable {
    struct Call: Sendable {
        let arguments: [String]
        let standardInput: String?
    }

    private let lock = NSLock()
    private nonisolated(unsafe) var results: [CommandResult]
    private nonisolated(unsafe) var recorded: [Call] = []

    init(results: [CommandResult]) {
        self.results = results
    }

    var calls: [Call] {
        lock.withLock { recorded }
    }

    func run(
        executable: URL, arguments: [String], environment: [String: String],
        currentDirectory: URL?, standardInput: String?, onOutput: @escaping @Sendable (OutputLine) -> Void
    ) async throws -> CommandResult {
        lock.withLock {
            recorded.append(Call(arguments: arguments, standardInput: standardInput))
            return results.isEmpty ? CommandResult(exitCode: 0, stdout: "{}", stderr: "") : results.removeFirst()
        }
    }
}

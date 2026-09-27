// Settings → Compute: one test per verb, and the two promises the pane makes.
//
// The promises are the same two the wizard's step 7 makes, because the pane
// runs the same model: the API key reaches the CLI on STDIN and appears in no
// argument of any call, and the app writes nothing itself — every change to
// compute.yaml is a `metistry compute` verb whose refusal is printed in the
// CLI's own words, naming the CLI's own field.
//
// Everything below drives a fake `CommandRunner`. Nothing here spawns a
// process, opens a file or touches a Keychain — and `console-sign-in-tests.swift`
// walks `apps/macos/sources` to assert the shipped code cannot either.

import Foundation
import Testing

@testable import MetistryKit

// MARK: - The reports these tests answer with

/// `metistry compute show --json`, as `packages/cli/src/compute.ts` shapes it:
/// a provider with a budget, two assignments, an instance budget.
private let fullReport = """
{
  "file": "/i/compute.yaml",
  "files": ["/p/seed/compute.yaml", "/i/compute.yaml"],
  "instance_file": "/i/compute.yaml",
  "providers": [
    { "name": "openrouter", "kind": "openai-compatible", "locality": "off_machine", "base_url": "https://openrouter.ai/api/v1",
      "zdr": false, "secret": "METISTRY_OPENROUTER_API_KEY", "secret_present": true,
      "models_assigned": ["anthropic/claude-sonnet-5"],
      "budget": { "daily_usd": 5, "monthly_usd": 100, "action": "critical_only" } },
    { "name": "lmstudio", "kind": "openai-compatible", "locality": "on_machine", "base_url": "http://127.0.0.1:1234/v1",
      "models_assigned": [] }
  ],
  "assignments": [
    { "target": "default", "provider": "openrouter", "model": "anthropic/claude-sonnet-5", "effort": "medium", "warn_non_zdr": true },
    { "target": "deep", "provider": "lmstudio", "model": "qwen3-30b", "effort": "high", "warn_non_zdr": false }
  ],
  "instance_budget": { "daily_usd": 12.5, "monthly_usd": 250, "action": "stop" },
  "assigns_nothing": false
}
"""

private let emptyReport = """
{ "files": [], "instance_file": "/i/compute.yaml", "providers": [], "assignments": [], "assigns_nothing": true }
"""

private let oneProviderNothingAssigned = """
{ "instance_file": "/i/compute.yaml", "assigns_nothing": true, "assignments": [],
  "providers": [ { "name": "lmstudio", "kind": "openai-compatible", "locality": "on_machine", "base_url": "http://127.0.0.1:1234/v1", "models_assigned": [] } ] }
"""

@MainActor
private func fakeCLI(_ runner: FakeRunner) -> MetistryCLI {
    MetistryCLI(
        runtime: MetistryRuntime(source: .path, executable: URL(fileURLWithPath: "/usr/local/bin/metistry")),
        runner: runner,
        instanceDir: URL(fileURLWithPath: "/i")
    )
}

/// A `StatusModel` that has really run `doctor --json` — through the same
/// `MetistryCLI` path the app uses, against a fake runner, so the pane reads
/// doctor's rows exactly the way it will on a Mac.
@MainActor
private func doctoredStatus(_ json: String = localModelDoctorJSON) async -> StatusModel {
    let status = StatusModel(cli: fakeCLI(FakeRunner(results: [CommandResult(exitCode: 0, stdout: json, stderr: "")])))
    await status.refresh()
    return status
}

@MainActor
private func paneModel(_ runner: FakeRunner, status: StatusModel? = nil) -> ComputeModel {
    ComputeModel(status: status ?? StatusModel(cli: nil), cli: fakeCLI(runner))
}

// MARK: - compute show

@MainActor
@Test func theReportIsReadWholeIncludingTheBudgetsTheOldPaneIgnored() async {
    let model = paneModel(FakeRunner(results: [CommandResult(exitCode: 0, stdout: fullReport, stderr: "")]))
    await model.refresh()

    #expect(model.phase == .read)
    #expect(model.report?.defaultRef == "openrouter/anthropic/claude-sonnet-5")
    #expect(model.report?.assignmentTargets == ["default", "deep"])
    // Per-provider budget and the instance's, both from the one read.
    #expect(model.report?.provider(named: "openrouter")?.budget?.action == .criticalOnly)
    #expect(model.report?.provider(named: "openrouter")?.budget?.dailyUSD == 5)
    #expect(model.report?.instanceBudget?.dailyUSD == 12.5)
    #expect(model.report?.instanceBudget?.action == .stop)
    // The badge: off this machine, and `zdr: false` is not a claim.
    #expect(model.report?.provider(named: "openrouter")?.isOffMachineWithoutZDR == true)
    #expect(model.report?.provider(named: "lmstudio")?.isOffMachineWithoutZDR == false)
    // Presence, never a value — there is no field on the type that could hold one.
    #expect(model.report?.provider(named: "openrouter")?.isMissingSecret == false)
    #expect(model.showCommand?.contains("compute show --json") == true)
}

// MARK: - compute providers add (the key, and where it does not go)

@MainActor
@Test func theKeyGoesToStdinAndTheNameAndBaseUrlGoToArguments() async {
    let runner = FakeRunner(results: [
        CommandResult(exitCode: 0, stdout: "stored METISTRY_OPENROUTER_API_KEY in the login Keychain\n{\n  \"name\": \"work\"\n}", stderr: ""),
        CommandResult(exitCode: 0, stdout: fullReport, stderr: ""),
    ])
    let model = paneModel(runner)
    model.openAddProvider(template: .openrouter)
    model.draft.assignsDefault = false
    model.draft.providerName = "work"
    model.draft.baseURL = "https://openrouter.example/api/v1"
    model.draft.apiKey = "  sk-or-v1-SECRET\n"
    await model.addProvider()

    let add = runner.calls[0]
    #expect(add.arguments.contains("--name") && add.arguments.contains("work"))
    #expect(add.arguments.contains("--base-url") && add.arguments.contains("https://openrouter.example/api/v1"))
    // 1. the key reached the child on stdin, trimmed, with the newline its reader wants
    #expect(add.standardInput == "sk-or-v1-SECRET\n")
    // 2. and it is in no argument of any call this pane made
    for call in runner.calls {
        for argument in call.arguments { #expect(!argument.contains("SECRET")) }
    }
    // 3. the property that held it is empty again
    #expect(model.draft.apiKey.isEmpty)
    // 4. adding a SECOND provider does not touch which one answers a turn
    #expect(!runner.calls.contains { $0.arguments.contains("assign") })
    #expect(model.lastOutcome?.ok == true)
    #expect(model.lastOutcome?.message.contains("work") == true)
}

@MainActor
@Test func theFirstProviderOnAnEnginelessInstallAlsoBecomesTheDefault() async {
    let runner = FakeRunner(results: [CommandResult(exitCode: 0, stdout: emptyReport, stderr: "")])
    let model = paneModel(runner)
    await model.refresh()
    // The pane decides this, not the sheet: `assigns_nothing` is the whole test.
    model.openAddProvider(template: .lmstudio)
    #expect(model.draft.assignsDefault)
    model.draft.model = "qwen3-30b"
    #expect(model.draft.plannedCommands.count == 2)
    #expect(model.draft.plannedCommands[1].contains("lmstudio/qwen3-30b"))
}

// MARK: - compute providers remove

@MainActor
@Test func aRemovalRefusalNamesTheFieldTheCliNamed() async {
    let stderr = "metistry compute: openrouter is still named by assignments.default, budgets.providers.openrouter — reassign those first (`metistry compute assign <target> <other-provider>/<model>`); /i/compute.yaml was NOT changed\n"
    let runner = FakeRunner(results: [
        CommandResult(exitCode: 1, stdout: "", stderr: stderr),
        CommandResult(exitCode: 0, stdout: fullReport, stderr: ""),
    ])
    let model = paneModel(runner)
    await model.removeProvider("openrouter")

    #expect(Array(runner.calls[0].arguments.suffix(5)) == ["compute", "providers", "remove", "openrouter", "--json"])
    #expect(model.lastOutcome?.ok == false)
    // Verbatim, with the FIELD in it — that is the thing to change next, and a
    // paraphrase would lose it.
    #expect(model.lastOutcome?.message.contains("assignments.default") == true)
    #expect(model.lastOutcome?.message.contains("budgets.providers.openrouter") == true)
    #expect(model.lastOutcome?.message.contains("was NOT changed") == true)
}

// MARK: - compute providers test

@MainActor
@Test func aProviderTestThatFailedIsStillAnAnswerAndNotACrash() async {
    // `providerTest` exits 1 when the provider did not answer, having printed a
    // perfectly good report. Reading `ok` from the exit code alone would turn
    // that into "the command broke". Pretty-printed, exactly as
    // `JSON.stringify(r, null, 2)` puts it on stdout — the shape that used to
    // leave the pane showing the closing `}` instead of the reason.
    let json = """
    {
      "name": "openrouter",
      "ok": false,
      "url": "https://openrouter.ai/api/v1",
      "models": [],
      "detail": "https://openrouter.ai/api/v1/models → HTTP 401"
    }
    """
    let model = paneModel(FakeRunner(results: [CommandResult(exitCode: 1, stdout: json, stderr: "")]))
    await model.testProvider("openrouter")

    #expect(model.tests["openrouter"]?.ok == false)
    #expect(model.tests["openrouter"]?.detail.contains("HTTP 401") == true)
    #expect(model.lastOutcome?.ok == false)
    // The outcome the pane actually prints: the CLI's `detail`, never just
    // the closing brace of the pretty-printed object it came from.
    #expect(model.lastOutcome?.message == "https://openrouter.ai/api/v1/models → HTTP 401")
    #expect(model.lastOutcome?.message != "}")
}

@MainActor
@Test func aPassingTestFillsTheModelPickerItAlreadyAsked() async {
    let json = #"{"name":"lmstudio","ok":true,"url":"http://127.0.0.1:1234/v1","models":["qwen3-30b","gemma-3"],"detail":"2 model(s)"}"#
    let model = paneModel(FakeRunner(results: [CommandResult(exitCode: 0, stdout: json, stderr: "")]))
    await model.testProvider("lmstudio")
    // One round trip, not two: the test already asked what it serves.
    #expect(model.models(for: "lmstudio") == ["qwen3-30b", "gemma-3"])
}

// MARK: - compute models list

@MainActor
@Test func theModelPickerIsFilledByTheProviderAndNotByTheApp() async {
    let json = """
    { "providers": [ { "name": "lmstudio", "ok": true, "detail": "3 model(s)", "models": ["a", "b", "c"] } ], "detected": [] }
    """
    let runner = FakeRunner(results: [CommandResult(exitCode: 0, stdout: json, stderr: "")])
    let model = paneModel(runner)
    await model.loadCatalogue(for: "lmstudio")

    #expect(runner.calls[0].arguments.contains("--provider"))
    #expect(runner.calls[0].arguments.contains("lmstudio"))
    #expect(model.models(for: "lmstudio") == ["a", "b", "c"])
    // A provider nobody asked about has no list, and says so by being empty
    // rather than by borrowing another provider's.
    #expect(model.models(for: "openrouter").isEmpty)
}

// MARK: - compute assign

@MainActor
@Test func assigningPassesTheTargetTheReferenceAndTheEffortAndCarriesTheWarning() async {
    let stdout = """
    ⚠ openrouter is off_machine and does not claim zero data retention — this is recorded, never blocked (C13)
    {
      "target": "assignments.default",
      "provider": "openrouter",
      "model": "anthropic/claude-sonnet-5",
      "effort": "high",
      "warn_non_zdr": true
    }
    """
    let runner = FakeRunner(results: [
        CommandResult(exitCode: 0, stdout: stdout, stderr: ""),
        CommandResult(exitCode: 0, stdout: fullReport, stderr: ""),
    ])
    let model = paneModel(runner)
    await model.assign(target: "default", ref: "openrouter/anthropic/claude-sonnet-5", effort: .high)

    let argv = runner.calls[0].arguments
    #expect(argv.contains("assign") && argv.contains("default"))
    #expect(argv.contains("openrouter/anthropic/claude-sonnet-5"))
    #expect(argv.contains("--effort") && argv.contains("high"))
    #expect(model.lastOutcome?.ok == true)
    // Recorded, never blocked: the warning rides along with the success.
    #expect(model.lastOutcome?.message.contains("zero data retention") == true)
}

@MainActor
@Test func assigningATierBeforeADefaultIsRefusedInTheCliesOwnWords() async {
    let stderr = "metistry compute: assignments.default is not set yet, and it is where every unnamed and unknown tier lands — run `metistry compute assign default <provider/model>` first; /i/compute.yaml was NOT changed\n"
    let runner = FakeRunner(results: [
        CommandResult(exitCode: 1, stdout: "", stderr: stderr),
        CommandResult(exitCode: 0, stdout: emptyReport, stderr: ""),
    ])
    let model = paneModel(runner)
    await model.assign(target: "deep", ref: "lmstudio/qwen3-30b", effort: .medium)
    #expect(model.lastOutcome?.ok == false)
    #expect(model.lastOutcome?.message.contains("assignments.default is not set yet") == true)
}

// MARK: - compute budget

@MainActor
@Test func aBudgetIsTheThreeFlagsTheCliTakesAndEnforcedInTheEngine() async {
    let stdout = """
    Recorded. Enforced in the engine, before the call (docs/ops/compute.md).
    { "target": "budgets.providers.openrouter", "daily_usd": 20, "monthly_usd": 300, "action": "stop" }
    """
    let runner = FakeRunner(results: [
        CommandResult(exitCode: 0, stdout: stdout, stderr: ""),
        CommandResult(exitCode: 0, stdout: fullReport, stderr: ""),
    ])
    let model = paneModel(runner)
    await model.setBudget(target: ComputeModel.providerBudgetTarget("openrouter"), daily: 20, monthly: 300, action: .stop)

    let argv = runner.calls[0].arguments
    #expect(argv.contains("budget") && argv.contains("provider:openrouter"))
    #expect(argv.contains("--daily") && argv.contains("20"))
    #expect(argv.contains("--monthly") && argv.contains("300"))
    #expect(argv.contains("--action") && argv.contains("stop"))
    #expect(model.lastOutcome?.ok == true)
    #expect(model.lastOutcome?.message.contains("enforced in the engine, before the call") == true)
}

@MainActor
@Test func anEmptyFieldIsLeaveItAloneAndAnActionWithNoLimitIsTheCliesRefusal() async {
    let stderr = "metistry compute: budgets.instance: give --daily <usd> or --monthly <usd> — an action with no limit never fires\n"
    let runner = FakeRunner(results: [
        CommandResult(exitCode: 1, stdout: "", stderr: stderr),
        CommandResult(exitCode: 0, stdout: fullReport, stderr: ""),
    ])
    let model = paneModel(runner)
    await model.setBudget(target: ComputeModel.instanceBudgetTarget, daily: nil, monthly: nil, action: .allow)

    // An empty field sends no flag at all, which is what lets the CLI keep the
    // value already in the file. It is not sent as zero.
    #expect(!runner.calls[0].arguments.contains("--daily"))
    #expect(!runner.calls[0].arguments.contains("--monthly"))
    #expect(model.lastOutcome?.message.contains("an action with no limit never fires") == true)
}

@MainActor
@Test func theBudgetNoteSaysEnforcedNeverRecordedNotEnforced() {
    #expect(ComputeModel.budgetNote.contains("Enforced in the engine, before the call"))
    #expect(!ComputeModel.budgetNote.lowercased().contains("not enforced"))
    #expect(!ComputeModel.budgetNote.contains("Nothing dials a provider"))
}

// MARK: - compute models install / load

@MainActor
@Test func anInstallShowsTheCliesOwnProgressLinesAndThenItsResult() async {
    // The progress is PROSE, not JSON: `ollamaPull` and `downloadGguf` pass
    // their lines straight to `out`, and the `--json` object is printed after
    // them. The pane shows the lines and reads the object.
    let stdout = """
    downloading https://huggingface.co/owner/repo/resolve/main/model.gguf
      12% · 480 MB of 4.0 GB
      100% · 4.0 GB
    /i/state/models/owner/repo/model.gguf: 4.0 GB, sha256 verified
    {
      "provider": "llamaserver",
      "server": "llamaserver",
      "model": "owner/repo/model.gguf",
      "ok": true,
      "detail": "4.0 GB, sha256 verified",
      "model_path": "state/models/owner/repo/model.gguf"
    }
    """
    let runner = FakeRunner(results: [
        CommandResult(exitCode: 0, stdout: stdout, stderr: ""),
        CommandResult(exitCode: 0, stdout: fullReport, stderr: ""),
    ])
    let model = paneModel(runner)
    let facts = await model.installModel(ref: "llamaserver/owner/repo/model.gguf")

    #expect(facts?.ok == true)
    #expect(facts?.modelPath == "state/models/owner/repo/model.gguf")
    // Every line the CLI printed, in order, for the progress view.
    #expect(model.output.contains { $0.text.contains("12% · 480 MB") })
    #expect(model.output.count >= 5)
}

@MainActor
@Test func loadIsHonestAboutTheTwoServersThatHaveNoAddressableLoad() async {
    let stdout = """
    Ollama has no addressable load: it loads a model on the first request and evicts it after keep_alive (default 5 minutes).
    { "provider": "ollama", "server": "ollama", "model": "qwen3:8b", "action": "load", "ok": true, "noop": true, "detail": "Ollama has no addressable load: it loads a model on the first request and evicts it after keep_alive (default 5 minutes)." }
    """
    let runner = FakeRunner(results: [CommandResult(exitCode: 0, stdout: stdout, stderr: "")])
    let model = paneModel(runner)
    await model.loadModel(ref: "ollama/qwen3:8b", unload: false)

    #expect(runner.calls[0].arguments.contains("load"))
    #expect(model.lastOutcome?.ok == true)
    #expect(model.lastOutcome?.message.contains("no addressable load") == true)
}

// MARK: - the local servers, from doctor

@Test func theLocalServersComeFromDoctorsOwnRowsAndAbsentIsNotAFailure() throws {
    let report = try DoctorReport.decode(from: Data(localModelDoctorJSON.utf8))
    let servers = report.localServers
    #expect(servers.map(\.server) == ["lmstudio", "ollama", "llamaserver", "applefm"])

    let lmstudio = try #require(servers.first { $0.server == "lmstudio" })
    #expect(lmstudio.status == .ok)
    #expect(lmstudio.models == ["qwen3-30b", "gemma-3"])
    #expect(lmstudio.provider == "lmstudio")
    #expect(lmstudio.canLoad)      // the only one with an addressable load
    #expect(lmstudio.label == "LM Studio")

    let ollama = try #require(servers.first { $0.server == "ollama" })
    // Nothing is wrong with a Mac that does not run Ollama.
    #expect(ollama.status == .absent)
    #expect(!ollama.isConfigured)
    #expect(ollama.canInstall && !ollama.canLoad)

    let applefm = try #require(servers.first { $0.server == "applefm" })
    // The OS's own model: there is nothing to pull, so no install control.
    #expect(!applefm.canInstall)
    #expect(applefm.isConfigured)
}

@Test func theRamFigureSaysEstimateBecauseItIsOne() {
    let sixteen: UInt64 = 16 * 1024 * 1024 * 1024
    #expect(MemoryHeadroom.reserveBytes(physical: sixteen) == 4 * 1024 * 1024 * 1024)
    #expect(MemoryHeadroom.headroomBytes(physical: sixteen) == 12 * 1024 * 1024 * 1024)
    // A big machine holds back a quarter rather than the 4 GB floor.
    let sixtyFour: UInt64 = 64 * 1024 * 1024 * 1024
    #expect(MemoryHeadroom.reserveBytes(physical: sixtyFour) == 16 * 1024 * 1024 * 1024)
    // And the sentence says what kind of number it is, every time.
    let note = MemoryHeadroom.summary(physical: sixteen)
    #expect(note.contains("estimate"))
    #expect(note.contains("Not a measurement"))
}

// MARK: - the banner

@MainActor
@Test func theAbsentAssistantIsSaidWhereItCanBeActedOnWithOneButton() async throws {
    // Nothing configured at all: the fix is a provider.
    let empty = paneModel(FakeRunner(results: [CommandResult(exitCode: 0, stdout: emptyReport, stderr: "")]), status: await doctoredStatus())
    await empty.refresh()
    let first = try #require(empty.engineBanner)
    #expect(first.headline == "assistant: absent — no default assignment")
    #expect(first.action == .addProvider)
    // Doctor's own remediation, not a paraphrase of it.
    #expect(first.detail.contains("metistry compute assign default"))

    // A provider but no default: the fix is the line that picks one.
    let unassigned = paneModel(FakeRunner(results: [CommandResult(exitCode: 0, stdout: oneProviderNothingAssigned, stderr: "")]), status: await doctoredStatus())
    await unassigned.refresh()
    #expect(unassigned.engineBanner?.action == .assignDefault)
    #expect(unassigned.engineBanner?.actionLabel == "Assign a Default Model…")

    // And an install with an engine has no banner at all.
    let running = paneModel(FakeRunner(results: [CommandResult(exitCode: 0, stdout: fullReport, stderr: "")]), status: await doctoredStatus())
    await running.refresh()
    #expect(running.engineBanner == nil)
}

// MARK: - a CLI older than this app

@MainActor
@Test func aStaleCliIsToldAboutRatherThanReportedAsAFailedWrite() async {
    let runner = FakeRunner(results: [
        CommandResult(exitCode: 2, stdout: "", stderr: "unknown command: compute\n"),
        CommandResult(exitCode: 2, stdout: "", stderr: "unknown command: compute\n"),
    ])
    let model = paneModel(runner)
    await model.assign(target: "default", ref: "openrouter/x", effort: .medium)
    #expect(model.lastOutcome?.ok == false)
    #expect(model.lastOutcome?.message == "this CLI has no `compute assign` verb yet — update it (metistry update, or Check for Updates…)")
}

// MARK: - prose and JSON down the same pipe

@Test func theProseTheCliPrintsBeforeItsJsonDoesNotHideTheJson() {
    let stdout = """
    stored METISTRY_OPENROUTER_API_KEY in the login Keychain under account you@mac
    reconciler: queued 1 write
    {
      "name": "openrouter",
      "secretStatus": "stored"
    }
    """
    let json = JSONValue.parseTrailing(in: stdout)
    #expect(json?.string("name") == "openrouter")
    #expect(json?.string("secretStatus") == "stored")

    // Pure JSON still parses.
    #expect(JSONValue.parseTrailing(in: #"{"ok":true}"#)?.bool("ok") == true)
    // And prose with no JSON in it is nil, not a guess.
    #expect(JSONValue.parseTrailing(in: "nothing to do here\n") == nil)
    // A prose line that opens with a brace costs an attempt, not the answer.
    #expect(JSONValue.parseTrailing(in: "{not json at all\n{\n  \"ok\": false\n}")?.bool("ok") == false)
}

// MARK: - Helpers

/// A doctor report with the rows this pane reads: the four local servers, a
/// supervisor with a `llamaserver` child, the `assistant` row absent for the
/// reason the banner names, and the two bridges.
private let localModelDoctorJSON = """
{
  "as_of": "2026-09-17T09:00:00.000Z",
  "product_dir": "/p",
  "shape": "launchd",
  "ok": true,
  "rows": [
    { "name": "console", "kind": "service", "status": "ok", "latency_ms": 12, "probe": "GET /health" },
    { "name": "assistant", "kind": "service", "status": "absent", "latency_ms": 0,
      "probe": "compute.yaml assigns a default → the supervisor starts the engine",
      "remediation": "no assignments.default in compute.yaml — nothing says which provider and model a turn runs on — `metistry compute assign default <provider/model>`; meanwhile the assistant is not started at all: captures, tasks, search and the console run, and fold turns wait (docs/ops/assistant-tools.md)" },
    { "name": "apple-fm", "kind": "bridge", "status": "ok", "latency_ms": 8, "probe": "GET /check" },
    { "name": "calendar", "kind": "bridge", "status": "absent", "latency_ms": 0, "probe": "GET /check" },
    { "name": "supervisor:com.foldedspacelabs.metistry.supervisor", "kind": "supervisor", "status": "ok", "latency_ms": 4,
      "probe": "the socket answers status with 4 child(ren)" },
    { "name": "child:console", "kind": "child", "status": "ok", "latency_ms": 1, "probe": "the supervisor reports console running" },
    { "name": "child:llamaserver", "kind": "child", "status": "ok", "latency_ms": 1, "probe": "the supervisor reports llamaserver running",
      "meta": { "pid": 5312, "restarts": 0 } },
    { "name": "local:lmstudio", "kind": "local-model", "status": "ok", "latency_ms": 22,
      "probe": "http://127.0.0.1:1234/v1/models answers",
      "meta": { "url": "http://127.0.0.1:1234/v1", "models": ["qwen3-30b", "gemma-3"], "loaded": 2, "provider": "lmstudio" } },
    { "name": "local:ollama", "kind": "local-model", "status": "absent", "latency_ms": 2,
      "probe": "http://127.0.0.1:11434/v1/models answers",
      "remediation": "Ollama is not answering on http://127.0.0.1:11434/v1 — nothing is wrong unless you meant to run it (ollama.com)",
      "meta": { "url": "http://127.0.0.1:11434/v1" } },
    { "name": "local:llamaserver", "kind": "local-model", "status": "ok", "latency_ms": 9,
      "probe": "http://127.0.0.1:7813/v1/models answers",
      "meta": { "url": "http://127.0.0.1:7813/v1", "models": ["qwen3-30b-q4"], "loaded": 1, "provider": "llamaserver" } },
    { "name": "local:applefm", "kind": "local-model", "status": "ok", "latency_ms": 6,
      "probe": "http://127.0.0.1:7810/v1/models answers",
      "meta": { "url": "http://127.0.0.1:7810/v1", "models": ["foundation-model"], "loaded": 1, "provider": "applefm" } }
  ]
}
"""

/// Answers a scripted list and records what each call was handed — arguments
/// and standard input both, because "the key is not in argv" is only a fact if
/// the test can see both.
private final class FakeRunner: CommandRunner, @unchecked Sendable {
    struct Call: Sendable {
        let arguments: [String]
        let standardInput: String?
    }

    private let lock = NSLock()
    private nonisolated(unsafe) var queued: [CommandResult]
    private nonisolated(unsafe) var recorded: [Call] = []

    init(results: [CommandResult]) {
        self.queued = results
    }

    var calls: [Call] { lock.withLock { recorded } }

    func run(
        executable: URL, arguments: [String], environment: [String: String],
        currentDirectory: URL?, standardInput: String?, onOutput: @escaping @Sendable (OutputLine) -> Void
    ) async throws -> CommandResult {
        let result: CommandResult = lock.withLock {
            recorded.append(Call(arguments: arguments, standardInput: standardInput))
            return queued.isEmpty ? CommandResult(exitCode: 0, stdout: "{}", stderr: "") : queued.removeFirst()
        }
        // A real child streams its lines as they happen; so does this, so the
        // progress view is exercised rather than assumed.
        for line in result.stdout.split(separator: "\n", omittingEmptySubsequences: false) {
            onOutput(OutputLine(stream: .standardOutput, text: String(line)))
        }
        return result
    }
}

// The menu bar's two decisions: how doctor's rows become groups, and what name a
// lifecycle verb gets. Both are one-liners with real consequences — a wrong name
// restarts the wrong component — so both are pinned here against a real report.

import Foundation
import Testing

@testable import MetistryKit

@Test func rowsAreGroupedByDoctorsOwnKindInDoctorsOwnOrder() throws {
    let report = try DoctorReport.decode(from: Data(sampleDoctorJSON.utf8))
    let groups = report.componentGroups
    #expect(groups.map(\.kind) == ["deployment", "bridge", "service", "db", "launchd", "container", "collector"])
    // The heading is a label; the kind is an identifier (design-system P10).
    #expect(groups.first { $0.kind == "launchd" }?.title == "Launchd Jobs")
    #expect(groups.first { $0.kind == "container" }?.title == "Containers")
    // A kind nobody has written a label for still gets a heading — invariant 5.
    #expect(ComponentGroup(kind: "widget", components: []).title == "Widget")
}

@Test func aGroupsDotIsItsWorstFaultAndAbsentIsNotAFault() throws {
    let report = try DoctorReport.decode(from: Data(sampleDoctorJSON.utf8))
    let groups = report.componentGroups
    #expect(groups.first { $0.kind == "container" }?.worstFault == .degraded)
    #expect(groups.first { $0.kind == "service" }?.worstFault == .ok)
    // The collector row is `absent`; the group is still ok, and so is the glyph.
    #expect(groups.first { $0.kind == "collector" }?.worstFault == .ok)
    #expect(report.worstFault == .degraded)
}

@Test func theLifecycleNameIsTheComponentNameNotDoctorsRowLabel() throws {
    let report = try DoctorReport.decode(from: Data(sampleDoctorJSON.utf8))
    let byRow = Dictionary(uniqueKeysWithValues: report.componentGroups.flatMap(\.components).map { ($0.row.name, $0) })

    #expect(byRow["launchd:com.foldedspacelabs.metistry.watchdog"]?.name == "watchdog")
    #expect(byRow["compose:console"]?.name == "console")
    #expect(byRow["reconciler"]?.name == "reconciler")
    #expect(byRow["apple-fm"]?.name == "apple-fm")

    // A launchd job that is not ours keeps its whole label: guessing a short
    // name for somebody else's job is how you stop the wrong process.
    let foreign = DoctorRow(name: "launchd:com.example.thing", kind: "launchd", status: .ok, latencyMs: 1, probe: "launchctl print")
    #expect(ComponentControl(row: foreign).name == "com.example.thing")
}

@Test func onlyThingsWithAProcessBehindThemOfferRestartStopStart() throws {
    let report = try DoctorReport.decode(from: Data(sampleDoctorJSON.utf8))
    let byRow = Dictionary(uniqueKeysWithValues: report.componentGroups.flatMap(\.components).map { ($0.row.id, $0) })

    #expect(byRow["service/console"]?.canControl == true)
    #expect(byRow["bridge/apple-fm"]?.canControl == true)
    #expect(byRow["launchd/launchd:com.foldedspacelabs.metistry.watchdog"]?.canControl == true)
    #expect(byRow["container/compose:console"]?.canControl == true)
    // A manifest that validates, a migration count and the resolved shape are
    // checks, not processes. The menu does not invent a control for them.
    #expect(byRow["collector/aws-costs"]?.canControl == false)
    #expect(byRow["db/migrations"]?.canControl == false)
    #expect(byRow["deployment/deployment"]?.canControl == false)
}

@Test func aCliWithoutTheVerbIsToldAboutRatherThanReportedAsAFailedRestart() {
    // `packages/cli/src/main.ts`'s default branch, verbatim.
    let unknown = CommandResult(exitCode: 2, stdout: "", stderr: "unknown command: restart\n\nmetistry — Metistry command line\n")
    #expect(MenuBarModel.isUnknownVerb(unknown))
    let outcome = MenuBarModel.outcome(verb: "restart", target: "console", result: unknown, lines: [])
    #expect(!outcome.ok)
    #expect(outcome.message.contains("no `restart` verb yet"))
    #expect(outcome.message.contains("update it"))
}

@Test func aUsageErrorForAVerbThatExistsIsNotMistakenForAMissingVerb() {
    let usage = CommandResult(exitCode: 2, stdout: "", stderr: "usage: metistry restart [<component>]\n")
    #expect(!MenuBarModel.isUnknownVerb(usage))
    let outcome = MenuBarModel.outcome(verb: "restart", target: nil, result: usage, lines: [])
    #expect(!outcome.ok)
    #expect(outcome.message.contains("usage: metistry restart"))
}

@Test func asuccessfulActionQuotesTheCliesOwnLastLine() {
    let ok = CommandResult(exitCode: 0, stdout: "", stderr: "")
    let outcome = MenuBarModel.outcome(
        verb: "restart",
        target: "apple-fm",
        result: ok,
        lines: [
            OutputLine(stream: .standardOutput, text: "kickstarting com.foldedspacelabs.metistry.apple-fm"),
            OutputLine(stream: .standardOutput, text: "apple-fm ok"),
            OutputLine(stream: .standardOutput, text: "   "),
        ]
    )
    #expect(outcome.ok)
    #expect(outcome.message == "restart apple-fm: apple-fm ok")
}

@MainActor
@Test func theWholeInstallKeyCannotCollideWithAComponentName() throws {
    let report = try DoctorReport.decode(from: Data(sampleDoctorJSON.utf8))
    let names = report.componentGroups.flatMap(\.components).map(\.name)
    #expect(!names.contains(MenuBarModel.wholeInstallKey))
    #expect(MenuBarModel.refreshInterval == .seconds(30))
}

@MainActor
@Test func viewLogAsksForTwoHundredLinesThroughTheCliAndNotAFilePath() async {
    let runtime = MetistryRuntime(
        source: .checkout,
        executable: URL(fileURLWithPath: "/usr/bin/node"),
        leadingArguments: ["/src/packages/cli/dist/main.js"],
        productDir: URL(fileURLWithPath: "/src")
    )
    let recorder = ArgumentRecorder()
    let model = LogViewerModel(cli: MetistryCLI(runtime: runtime, runner: recorder, instanceDir: nil))
    await model.load(component: "watchdog")
    #expect(recorder.last() == [
        "/src/packages/cli/dist/main.js", "logs", "watchdog", "--lines", "200", "--product-dir", "/src",
    ])
    #expect(model.command?.contains("logs watchdog --lines 200") == true)
}

@MainActor
@Test func aCliWithoutTheLogsVerbSaysSoInTheWindow() async {
    let runtime = MetistryRuntime(source: .path, executable: URL(fileURLWithPath: "/usr/local/bin/metistry"))
    let model = LogViewerModel(cli: MetistryCLI(
        runtime: runtime,
        runner: FixedResultRunner(result: CommandResult(exitCode: 2, stdout: "", stderr: "unknown command: logs")),
        instanceDir: nil
    ))
    await model.load(component: "watchdog")
    #expect(model.phase == .unavailable("this CLI has no `logs` verb yet — update it (metistry update, or Check for Updates…)"))
}

// MARK: - the menu bar

@Test func theSupervisorsChildrenAreListedWithTheServicesAndCanBeRestarted() throws {
    let report = try DoctorReport.decode(from: Data(supervisedDoctorJSON.utf8))
    let services = try #require(report.componentGroups.first { $0.kind == "service" })
    // One group, not two: `console` is a service row and `llamaserver` is a
    // child row, and a person opening the menu is looking for both in Services.
    #expect(services.components.map(\.name).contains("console"))
    #expect(services.components.map(\.name).contains("llamaserver"))
    #expect(!report.componentGroups.contains { $0.kind == "child" })

    let llama = try #require(services.components.first { $0.name == "llamaserver" })
    // `child:llamaserver` is the row's name; `llamaserver` is what
    // `metistry restart|stop|start|logs` takes.
    #expect(llama.row.name == "child:llamaserver")
    #expect(llama.canControl)
    // The supervisor itself keeps its own group — it owns the children.
    #expect(report.componentGroups.contains { $0.kind == "supervisor" })
}

@Test func theAppleFmBridgeSaysWhatItServesOnceAProviderDialsIt() throws {
    let report = try DoctorReport.decode(from: Data(supervisedDoctorJSON.utf8))
    #expect(report.bridgeNote(for: "apple-fm") == "serves foundation-model")
    // Every other component says nothing extra, including the other bridge.
    #expect(report.bridgeNote(for: "console") == nil)
    #expect(report.bridgeNote(for: "calendar") == nil)

    // And a Mac where compute.yaml dials nothing says nothing either: the
    // bridge being up is not the same fact as the engine being able to use it.
    let unconfigured = DoctorReport(
        asOf: "now", productDir: "/p", shape: "launchd", ok: true,
        rows: [DoctorRow(
            name: "local:applefm", kind: "local-model", status: .ok, latencyMs: 1,
            probe: "http://127.0.0.1:7810/v1/models answers",
            meta: .object(["url": .string("http://127.0.0.1:7810/v1"), "configured": .bool(false)])
        )]
    )
    #expect(unconfigured.bridgeNote(for: "apple-fm") == nil)
}


/// A report from an install that runs a local model: a supervisor with a
/// `llamaserver` child of its own, and an `apple-fm` bridge that `compute.yaml`
/// now dials. Separate from `sampleDoctorJSON` because neither shape existed
/// when that one was written, and both rows are the point here.
private let supervisedDoctorJSON = """
{
  "as_of": "2026-09-17T09:00:00.000Z",
  "product_dir": "/p",
  "shape": "launchd",
  "ok": true,
  "rows": [
    { "name": "console", "kind": "service", "status": "ok", "latency_ms": 12, "probe": "GET /health" },
    { "name": "apple-fm", "kind": "bridge", "status": "ok", "latency_ms": 8, "probe": "GET /check" },
    { "name": "calendar", "kind": "bridge", "status": "absent", "latency_ms": 0, "probe": "GET /check" },
    { "name": "supervisor:com.foldedspacelabs.metistry.supervisor", "kind": "supervisor", "status": "ok", "latency_ms": 4,
      "probe": "the socket answers status with 2 child(ren)" },
    { "name": "child:console", "kind": "child", "status": "ok", "latency_ms": 1, "probe": "the supervisor reports console running" },
    { "name": "child:llamaserver", "kind": "child", "status": "ok", "latency_ms": 1,
      "probe": "the supervisor reports llamaserver running", "meta": { "pid": 5312, "restarts": 0 } },
    { "name": "local:applefm", "kind": "local-model", "status": "ok", "latency_ms": 6,
      "probe": "http://127.0.0.1:7810/v1/models answers",
      "meta": { "url": "http://127.0.0.1:7810/v1", "models": ["foundation-model"], "loaded": 1, "provider": "applefm" } }
  ]
}
"""

private final class ArgumentRecorder: CommandRunner, @unchecked Sendable {
    private let lock = NSLock()
    private var calls: [[String]] = []

    func last() -> [String]? {
        lock.withLock { calls.last }
    }

    func run(
        executable: URL, arguments: [String], environment: [String: String],
        currentDirectory: URL?, standardInput: String?, onOutput: @escaping @Sendable (OutputLine) -> Void
    ) async throws -> CommandResult {
        lock.withLock { calls.append(arguments) }
        return CommandResult(exitCode: 0, stdout: "line one\n", stderr: "")
    }
}

private struct FixedResultRunner: CommandRunner {
    let result: CommandResult

    func run(
        executable: URL, arguments: [String], environment: [String: String],
        currentDirectory: URL?, standardInput: String?, onOutput: @escaping @Sendable (OutputLine) -> Void
    ) async throws -> CommandResult {
        result
    }
}

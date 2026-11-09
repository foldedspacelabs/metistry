// Fix All in the Status window (X-125, ruled 2026-10-04).
//
// The ticket's bold test is two claims, each a code path rather than a
// sentence: FIX ALL RUNS THE FIXABLE ROWS ONLY — it is `doctor --fix --yes
// --json` and nothing else, a your-hand row has no button and no command —
// and A DESTRUCTIVE FIX ASKS FIRST: when a row's repair moves files or
// restarts a running service the confirm is on screen before `--yes` leaves
// the app, and Cancel sends nothing.
//
// Then the door itself (M6 admits exactly two argvs; every other `doctor`
// argv is refused), §2.18 for the panel with the new controls, and the wire
// shape the CLI's `--fix --json` document has (packages/cli/src/doctor-fix.ts).

#if os(macOS)
import AppKit
import Foundation
import SwiftUI
import Testing

@testable import MetistryKit

// MARK: - The wire, as `doctor --json` (X-123) writes it

private let shimRow = """
{ "name": "cli shim", "kind": "install", "status": "degraded", "latency_ms": 1, "probe": "~/.local/bin/metistry points here",
  "remediation": "write the shim", "fix": "fixable",
  "repair": { "id": "cli_shim", "confirm": false, "does": "write this install's cli shim" } }
"""

private let reconcilerRow = """
{ "name": "child:reconciler", "kind": "child", "status": "failed", "latency_ms": 1, "probe": "the supervisor reports reconciler running",
  "remediation": "the reconciler does not answer", "fix": "fixable",
  "repair": { "id": "restart", "target": "reconciler", "confirm": true, "does": "restart reconciler through the supervisor" } }
"""

private let handRow = """
{ "name": "calendar access", "kind": "bridge", "status": "degraded", "latency_ms": 2, "probe": "read 1 event",
  "remediation": "grant Calendars to Metistry in System Settings ▸ Privacy & Security", "fix": "hand" }
"""

private let infoRow = """
{ "name": "apple-fm", "kind": "bridge", "status": "absent", "latency_ms": 0, "probe": "not configured", "fix": "info" }
"""

private let okRow = """
{ "name": "db", "kind": "db", "status": "ok", "latency_ms": 3, "probe": "SELECT 1 round-trip", "fix": "info" }
"""

private func document(_ rows: [String], ok: Bool = false, mode: String? = nil, fixes: String? = nil) -> String {
    """
    { "as_of": "2026-10-19T10:00:00.000Z", "product_dir": "/p", "shape": "launchd", "ok": \(ok),
      \(mode.map { #""mode": "\#($0)","# } ?? "")
      \(fixes.map { #""fixes": \#($0),"# } ?? "")
      "rows": [\(rows.joined(separator: ","))] }
    """
}

/// The `--fix` run's answer: the rows as they are after the one re-check, and what ran.
private let fixedDocument = document(
    [
        shimRow.replacingOccurrences(of: #""status": "degraded""#, with: #""status": "ok""#).replacingOccurrences(of: #""remediation": "write the shim","#, with: #""fixed": true,"#),
        reconcilerRow.replacingOccurrences(of: #""status": "failed""#, with: #""status": "failed""#).replacingOccurrences(of: #""fix": "fixable","#, with: #""fixed": false, "fix": "fixable","#),
        handRow, infoRow, okRow,
    ],
    mode: "fix",
    fixes: """
    [
      { "id": "cli_shim", "rows": ["cli shim"], "does": "write this install's cli shim", "confirm": false, "outcome": "fixed",
        "steps": ["$ write ~/.local/bin/metistry"], "before": { "cli shim": "degraded" }, "after": { "cli shim": "ok" } },
      { "id": "restart", "target": "reconciler", "rows": ["child:reconciler"], "does": "restart reconciler through the supervisor", "confirm": true,
        "outcome": "applied", "steps": ["$ metistry restart reconciler"], "before": { "child:reconciler": "failed" }, "after": { "child:reconciler": "failed" } }
    ]
    """
)

// MARK: - Fakes

/// The read verbs' runner: answers `doctor --check --json` from a queue and records every argv.
private final class ReadRunner: CommandRunner, @unchecked Sendable {
    private let lock = NSLock()
    private var queue: [String]
    private var _calls: [[String]] = []

    init(_ documents: [String]) { queue = documents }

    var calls: [[String]] { lock.withLock { _calls } }

    func run(
        executable: URL, arguments: [String], environment: [String: String],
        currentDirectory: URL?, standardInput: String?, onOutput: @escaping @Sendable (OutputLine) -> Void
    ) async throws -> CommandResult {
        let stdout = lock.withLock { () -> String in
            _calls.append(arguments)
            return queue.count > 1 ? queue.removeFirst() : (queue.first ?? "")
        }
        return CommandResult(exitCode: 1, stdout: stdout, stderr: "")
    }
}

private let runtime = MetistryRuntime(source: .path, executable: URL(fileURLWithPath: "/usr/local/bin/metistry"))

/// A status model that has read `check`, with a recording door for the repair.
@MainActor
private func statusReading(_ check: String, fix: CommandResult = CommandResult(exitCode: 1, stdout: fixedDocument, stderr: "")) async -> (StatusModel, ReadRunner, SettingsRecordingRunner) {
    let reads = ReadRunner([check])
    let door = SettingsRecordingRunner()
    door.result = fix
    let cli = MetistryCLI(runtime: runtime, runner: reads, instanceDir: URL(fileURLWithPath: "/i"))
    let model = StatusModel(cli: cli, management: door)
    await model.refresh()
    return (model, reads, door)
}

private let mixed = document([shimRow, reconcilerRow, handRow, infoRow, okRow])
private let onlyPlain = document([shimRow, handRow, infoRow, okRow])

// MARK: - The wire shape

@Test func theRepairContractDecodesAndAnUnknownClassIsNoFix() throws {
    let report = try DoctorReport.decode(from: Data(mixed.utf8))
    let shim = try #require(report.rows.first { $0.name == "cli shim" })
    #expect(shim.fix == .fixable)
    #expect(shim.repair == DoctorRepair(id: "cli_shim", confirm: false, does: "write this install's cli shim"))
    #expect(shim.isFixable)
    let restart = try #require(report.rows.first { $0.name == "child:reconciler" }?.repair)
    #expect(restart.target == "reconciler" && restart.confirm)
    #expect(report.rows.first { $0.name == "calendar access" }?.isYoursToDo == true)
    #expect(report.rows.first { $0.name == "apple-fm" }?.isFixable == false)
    #expect(report.rows.first { $0.name == "db" }?.isFixable == false)

    // a class this build does not know, and a repair with no `does`, decode as no fix — never a failed report
    let odd = try DoctorReport.decode(from: Data(document([
        #"{ "name": "x", "kind": "k", "status": "failed", "latency_ms": 0, "probe": "p", "fix": "sudo" }"#,
        #"{ "name": "y", "kind": "k", "status": "failed", "latency_ms": 0, "probe": "p", "fix": "fixable", "repair": { "id": "restart", "confirm": true } }"#,
    ]).utf8))
    #expect(odd.rows.count == 2)
    #expect(odd.rows.allSatisfy { $0.fix != .fixable || $0.repair == nil })
    #expect(odd.fixAllPlan == nil, "a row with no named fix is not Fix All's to run")
}

@Test func aFixDocumentCarriesWhatRanAndTheReCheck() throws {
    let report = try DoctorReport.decode(from: Data(fixedDocument.utf8))
    #expect(report.mode == "fix")
    let fixes = try #require(report.fixes)
    #expect(fixes.map(\.id) == ["cli_shim", "restart:reconciler"])
    #expect(fixes.map(\.outcomeLabel) == ["Fixed", "Ran — still failing"])
    #expect(fixes[1].after == ["child:reconciler": "failed"])
    #expect(report.rows.first { $0.name == "cli shim" }?.fixed == true)
    #expect(report.rows.first { $0.name == "child:reconciler" }?.fixed == false)
    #expect(report.rows.first { $0.name == "db" }?.fixed == nil)
    // a CLI before the repair contract sends none of it, and the report reads as it always did
    let old = try DoctorReport.decode(from: Data(#"{"as_of":"t","product_dir":"/p","shape":"launchd","ok":true,"rows":[{"name":"db","kind":"db","status":"failed","latency_ms":0,"probe":"p","remediation":"r"}]}"#.utf8))
    #expect(old.mode == nil && old.fixes == nil && old.fixAllPlan == nil)
}

// MARK: - The plan: fixable rows only

@Test func fixAllIsMadeOfTheFixableRowsOnlyOnePerFix() throws {
    let report = try DoctorReport.decode(from: Data(mixed.utf8))
    let plan = try #require(report.fixAllPlan)
    #expect(plan.items.map(\.rows) == [["cli shim"], ["child:reconciler"]], "not the your-hand row, the fact, or the ok row")
    #expect(plan.asks)

    // two rows, one restart: one fix, both rows named
    let twice = try DoctorReport.decode(from: Data(document([
        reconcilerRow, reconcilerRow.replacingOccurrences(of: "child:reconciler", with: "service:reconciler"),
    ]).utf8))
    let item = try #require(twice.fixAllPlan?.items.first)
    #expect(twice.fixAllPlan?.items.count == 1)
    #expect(item.rows == ["child:reconciler", "service:reconciler"])

    // nothing fixable, nothing offered
    let none = try DoctorReport.decode(from: Data(document([handRow, infoRow, okRow]).utf8))
    #expect(none.fixAllPlan == nil)
    #expect(none.yoursToDo.map(\.name) == ["calendar access"])
}

// MARK: - The door: M6 admits exactly two argvs

@Test func theDoctorRowAdmitsExactlyTheReadAndTheRepairAndNothingElse() {
    #expect(ManagementCommand(.doctor, ["doctor", "--check", "--json"]) != nil)
    #expect(ManagementCommand(.doctor, ["doctor", "--fix", "--yes", "--json"]) != nil)
    #expect(ManagementRow.doctor.exactShapes == [["doctor", "--check", "--json"], ["doctor", "--fix", "--yes", "--json"]])

    // MISUSE: every other doctor argv is refused — the prefix no longer opens the verb
    let refused: [[String]] = [
        ["doctor"],
        ["doctor", "--json"],
        ["doctor", "--check"],
        ["doctor", "--fix"],
        ["doctor", "--fix", "--json"],
        ["doctor", "--fix", "--yes"],
        ["doctor", "--yes", "--fix", "--json"],
        ["doctor", "--fix", "--json", "--yes"],
        ["doctor", "--check", "--fix", "--json"],
        ["doctor", "--fix", "--yes", "--json", "--force"],
        ["doctor", "--fix", "--yes", "--json", "--product-dir", "/elsewhere"],
        ["doctor", "--check", "--json", "--product-dir=/elsewhere"],
        ["doctor", "--fix", "--yes", "--json", ";", "rm", "-rf", "/"],
        ["doctor", "--fix", "--yes", "--json", "restart"],
        ["doctor", "fix", "--yes", "--json"],
        ["doctor", "--fix=--yes", "--json"],
        ["Doctor", "--fix", "--yes", "--json"],
        ["doctor", "--fix", "--yes", "--json", ""],
        [],
    ]
    for argv in refused {
        #expect(ManagementCommand(.doctor, argv) == nil, "\(argv) must be refused")
    }
    // the repair belongs to M6 alone: no other row can carry it
    for row in ManagementRow.allCases where row != .doctor {
        #expect(ManagementCommand(row, ["doctor", "--fix", "--yes", "--json"]) == nil, "\(row)")
        #expect(ManagementCommand(row, ["doctor", "--check", "--json"]) == nil, "\(row)")
    }
    // and every other row is still checked by its verb prefix
    #expect(ManagementCommand(.services, ["restart", "console", "--json"]) != nil)
}

@MainActor
@Test func theReadIsDoctorCheckJson() async {
    let (model, reads, _) = await statusReading(mixed)
    #expect(reads.calls.count == 1)
    #expect(Array(reads.calls[0].prefix(3)) == ["doctor", "--check", "--json"])
    #expect(model.lastCommand?.contains("doctor --check --json") == true)
    #expect(model.report?.rows.count == 5)
}

// MARK: - A destructive fix asks first

@MainActor
@Test func aFixThatRestartsARunningServiceAsksBeforeAnythingIsSent() async throws {
    let (model, _, door) = await statusReading(mixed)
    #expect(model.canFixAll)
    await model.proposeFixAll()

    // the ask is on screen, names BOTH fixes, marks the one that asks — and the door is untouched
    let confirmation = try #require(model.confirmation)
    #expect(door.commands.isEmpty, "presenting the confirm runs nothing")
    #expect(confirmation.title == "Fix All?")
    #expect(confirmation.confirm == "Fix All")
    #expect(confirmation.costs.count == 2)
    #expect(confirmation.costs[0].contains("write this install's cli shim") && confirmation.costs[0].contains("cli shim"))
    #expect(confirmation.costs[1].contains("restart reconciler through the supervisor"))
    #expect(confirmation.costs[1].contains("restarts a running service"))
    #expect(!confirmation.costs[0].contains("restarts a running service"))
    #expect(!model.canFixAll, "a second press while the ask is open does nothing")

    // Cancel sends nothing, and the report is as it was
    await model.choose(.cancel)
    #expect(model.confirmation == nil)
    #expect(door.commands.isEmpty)
    #expect(model.fixPhase == .idle)
    #expect(model.report?.mode == nil)

    // Confirm sends exactly `doctor --fix --yes --json`, once
    await model.proposeFixAll()
    #expect(door.commands.isEmpty, "asking again still sends nothing")
    await model.choose(.confirm)
    #expect(door.commands.map(\.arguments) == [["doctor", "--fix", "--yes", "--json"]])
    #expect(door.commands.map(\.row) == [.doctor])
    #expect(model.confirmation == nil)
}

@MainActor
@Test func theAskNamesEveryFixSoThereIsNoUnpreviewedYes() async throws {
    // a plan whose only confirm-class fix is one of three
    let wide = document([
        shimRow, reconcilerRow,
        shimRow.replacingOccurrences(of: "cli shim", with: "seed templates").replacingOccurrences(of: "cli_shim", with: "seed_templates").replacingOccurrences(of: "write this install's cli shim", with: "re-seed the templates the vault lacks"),
    ])
    let (model, _, _) = await statusReading(wide)
    await model.proposeFixAll()
    let confirmation = try #require(model.confirmation)
    #expect(confirmation.costs.count == 3)
}

@MainActor
@Test func aSheetDismissedWithoutAnAnswerIsCancel() async {
    let (model, _, door) = await statusReading(mixed)
    await model.proposeFixAll()
    #expect(model.confirmation != nil)
    await model.choose(.alternative)   // anything that is not .confirm
    #expect(door.commands.isEmpty)
    #expect(model.confirmation == nil)
}

// MARK: - Fix All runs the fixable rows only

@MainActor
@Test func whenNothingAsksFixAllRunsAtOnceAndOnlyTheRepairArgvIsSent() async throws {
    let (model, reads, door) = await statusReading(onlyPlain, fix: CommandResult(exitCode: 0, stdout: document(
        [shimRow.replacingOccurrences(of: #""status": "degraded""#, with: #""status": "ok""#).replacingOccurrences(of: #""remediation": "write the shim","#, with: #""fixed": true,"#), handRow, infoRow, okRow],
        mode: "fix",
        fixes: #"[{ "id": "cli_shim", "rows": ["cli shim"], "does": "write this install's cli shim", "confirm": false, "outcome": "fixed", "steps": [], "before": { "cli shim": "degraded" }, "after": { "cli shim": "ok" } }]"#
    ), stderr: ""))
    await model.proposeFixAll()
    #expect(model.confirmation == nil, "nothing here moves files or restarts a running service")
    #expect(door.commands.map(\.arguments) == [["doctor", "--fix", "--yes", "--json"]])
    // the preview's own read was taken first, through the read door
    #expect(reads.calls.count == 2 && reads.calls.allSatisfy { Array($0.prefix(3)) == ["doctor", "--check", "--json"] })

    guard case .done(let outcome) = model.fixPhase else { Issue.record("expected a finished run, got \(model.fixPhase)"); return }
    #expect(outcome.headline == "1 fixed")
    #expect(outcome.allFixed)
    #expect(outcome.unpreviewed.isEmpty)
    // the report on screen is now the re-check's
    #expect(model.report?.mode == "fix")
    #expect(model.report?.rows.first { $0.name == "cli shim" }?.fixed == true)
    #expect(model.fixAllPlan == nil, "nothing fixable is left, so no button")
}

@MainActor
@Test func theYourHandRowShowsWhatToDoAndNothingRunsIt() async throws {
    let (model, _, door) = await statusReading(document([handRow, infoRow, okRow]))
    #expect(model.fixAllPlan == nil)
    #expect(!model.canFixAll)
    await model.proposeFixAll()
    await model.choose(.confirm)
    #expect(door.commands.isEmpty, "no fixable row, no command — whatever is pressed")
    #expect(model.confirmation == nil)

    let hand = try #require(model.report?.rows.first { $0.name == "calendar access" })
    let view = DoctorRowView(row: hand)
    #expect(view.fixTag == "your hand")
    #expect(view.fixNote == "This one is yours to do; Fix All does not touch it.")
    // the remediation, which names the step, is the row's text — unchanged
    #expect(hand.remediation?.contains("System Settings") == true)
    #expect(DoctorRowView(row: try #require(model.report?.rows.first { $0.name == "apple-fm" })).fixTag == nil)
    #expect(DoctorRowView(row: try #require(model.report?.rows.first { $0.name == "db" })).fixNote == nil)
}

@MainActor
@Test func aFixableRowSaysWhatFixAllWillDoAndAskingIsSaid() async throws {
    let (model, _, _) = await statusReading(mixed)
    let shim = DoctorRowView(row: try #require(model.report?.rows.first { $0.name == "cli shim" }))
    #expect(shim.fixTag == "Fix All")
    #expect(shim.fixNote == "Fix All will: write this install's cli shim.")
    let reconciler = DoctorRowView(row: try #require(model.report?.rows.first { $0.name == "child:reconciler" }))
    #expect(reconciler.fixNote == "Fix All will: restart reconciler through the supervisor. It asks first.")
}

@MainActor
@Test func afterARunEachRowSaysFixedOrStillFailingAndEachFixShowsItsReCheck() async throws {
    let (model, _, _) = await statusReading(mixed)
    await model.proposeFixAll()
    await model.choose(.confirm)
    guard case .done(let outcome) = model.fixPhase else { Issue.record("expected a finished run, got \(model.fixPhase)"); return }
    #expect(outcome.headline == "1 fixed · 1 ran, still failing")
    #expect(!outcome.allFixed)
    #expect(outcome.exitCode == 1)

    let fixed = DoctorRowView(row: try #require(model.report?.rows.first { $0.name == "cli shim" }))
    #expect(fixed.fixTag == "fixed")
    let stuck = DoctorRowView(row: try #require(model.report?.rows.first { $0.name == "child:reconciler" }))
    #expect(stuck.fixTag == "still failing")
    #expect(stuck.fixNote == "Doctor tried a fix and the re-check still finds this.")

    let records = outcome.fixes.map { FixRecordView(fix: $0).transition }
    #expect(records == ["cli shim degraded → ok", "child:reconciler failed → failed"])
}

@MainActor
@Test func aFixThatAskedWithoutBeingInThePreviewIsSaidAfterwards() async throws {
    // read: one plain fix. By the time the door runs, a restart had also become fixable and `--yes` ran it.
    let (model, _, _) = await statusReading(onlyPlain)
    await model.proposeFixAll()
    guard case .done(let outcome) = model.fixPhase else { Issue.record("expected a finished run, got \(model.fixPhase)"); return }
    // the default fake door answered with `fixedDocument`: its restart was not in `onlyPlain`'s plan
    #expect(outcome.unpreviewed.map(\.id) == ["restart:reconciler"])
}

// MARK: - When it cannot run

@MainActor
@Test func aCliThatAnswersWithoutRepairingIsNeverReportedAsNothingToFix() async {
    // an old CLI ignores `--fix` and prints the plain check: no `mode`
    let (model, _, door) = await statusReading(onlyPlain, fix: CommandResult(exitCode: 1, stdout: onlyPlain, stderr: ""))
    await model.proposeFixAll()
    #expect(door.commands.count == 1)
    guard case .unavailable(let why) = model.fixPhase else { Issue.record("got \(model.fixPhase)"); return }
    #expect(why.contains("without repairing"))
    #expect(model.report?.mode == nil, "the read on screen is left as it was")
}

@MainActor
@Test func aRepairThatPrintsNothingSaysSoWithTheCliOwnWords() async {
    let (model, _, _) = await statusReading(onlyPlain, fix: CommandResult(exitCode: 2, stdout: "", stderr: "metistry: Keychain is locked\n"))
    await model.proposeFixAll()
    guard case .unavailable(let why) = model.fixPhase else { Issue.record("got \(model.fixPhase)"); return }
    #expect(why.contains("exit 2") && why.contains("Keychain is locked"))
}

@MainActor
@Test func noRuntimeMeansNoFixAll() async {
    let model = StatusModel(cli: nil)
    await model.refresh()
    #expect(!model.canFixAll)
    await model.proposeFixAll()
    #expect(model.fixPhase == .idle && model.confirmation == nil)
}

@MainActor
@Test func theMenuBarsReReadDoesNotRaceARepairInFlight() async throws {
    let reads = ReadRunner([onlyPlain])
    let door = ComputeBlockingRunner()
    let cli = MetistryCLI(runtime: runtime, runner: reads, instanceDir: URL(fileURLWithPath: "/i"))
    let model = StatusModel(cli: cli, management: door)
    await model.refresh()
    let run = Task { await model.proposeFixAll() }
    await door.started()
    #expect(model.isFixing)
    #expect(!model.canFixAll, "the button is dead while it runs")
    let before = reads.calls.count
    await model.refresh()
    #expect(reads.calls.count == before, "no read starts while the repair is running")
    run.cancel()
    await run.value
    #expect(!model.isFixing)
}

@MainActor
@Test func anotherInstanceDropsTheAskAndTheOutcome() async throws {
    let (model, _, door) = await statusReading(mixed)
    await model.proposeFixAll()
    #expect(model.confirmation != nil)
    model.cli = MetistryCLI(runtime: runtime, runner: ReadRunner([mixed]), instanceDir: URL(fileURLWithPath: "/other"))
    #expect(model.confirmation == nil)
    await model.choose(.confirm)
    #expect(door.commands.isEmpty, "a confirm for the first install is not an answer for the second")
}

// MARK: - §2.18

@MainActor
@Test func theStatusPanelWithFixAllSpeaksEveryControl() async throws {
    let (model, _, _) = await statusReading(mixed)
    let panel = StatusPanel(model: model, signIn: ConsoleSignInModel(cli: nil), runtime: nil).frame(width: 760, height: 700)
    let tree = try await AccessibilityProbe.snapshot(panel)
    defer { tree.close() }
    #expect(tree.unlabeledControls.isEmpty, "unlabeled: \(tree.unlabeledControls)")
    #expect(tree.saysAssistant.isEmpty)
    #expect(tree.controlNames.contains { $0.hasPrefix("Fix All") }, "controls: \(tree.controlNames)")
    #expect(tree.controlNames.contains("Run metistry doctor again"))

    // after a run: the result card, every fix a spoken sentence, the headline a heading
    await model.proposeFixAll()
    await model.choose(.confirm)
    let after = try await AccessibilityProbe.snapshot(StatusPanel(model: model, signIn: ConsoleSignInModel(cli: nil), runtime: nil).frame(width: 760, height: 900))
    defer { after.close() }
    #expect(after.unlabeledControls.isEmpty, "unlabeled: \(after.unlabeledControls)")
    #expect(after.headings.contains("1 fixed · 1 ran, still failing"), "headings: \(after.headings)")
    #expect(after.labels.contains { $0.contains("restart reconciler through the supervisor. Ran — still failing.") }, "labels: \(after.labels)")
}

@MainActor
@Test func theConfirmSheetSpeaksEveryControlAndEscapeIsCancel() async throws {
    let (model, _, door) = await statusReading(mixed)
    await model.proposeFixAll()
    let confirmation = try #require(model.confirmation)
    let tree = try await AccessibilityProbe.snapshot(CostConfirmView(confirmation) { _ in }.frame(width: 480))
    defer { tree.close() }
    #expect(tree.unlabeledControls.isEmpty)
    #expect(tree.controlNames.contains("Cancel, Return") && tree.controlNames.contains("Fix All"), "controls: \(tree.controlNames)")
    // Return is Cancel (P3): the default action is the safe one
    #expect(confirmation.presentation().controls.first { $0.shortcut == "Return" }?.label == "Cancel")
    #expect(door.commands.isEmpty)
}

@MainActor
@Test func theLargestTextGrowsTheStatusHeaderLongerNeverWider() async throws {
    let (model, _, _) = await statusReading(mixed)
    await model.proposeFixAll()
    await model.choose(.confirm)
    let width: CGFloat = 560
    for size in [DynamicTypeSize.large, .accessibility5] {
        let renderer = ImageRenderer(content: StatusPanel(model: model, signIn: ConsoleSignInModel(cli: nil), runtime: nil)
            .environment(\.dynamicTypeSize, size)
            .frame(width: width, height: 4000))
        renderer.proposedSize = ProposedViewSize(width: width, height: 4000)
        renderer.scale = 1
        let image = try #require(renderer.cgImage, "the panel did not render")
        #expect(CGFloat(image.width) <= width, "wider than the window at \(size): \(image.width)")
    }
}
#endif

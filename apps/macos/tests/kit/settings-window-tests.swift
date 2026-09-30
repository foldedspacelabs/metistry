// The Settings window (T6-11, screen-15-settings.md §1–§5.2, §5.4–§5.6).
//
// The ticket's two bold tests are here: THE LID DIALOG NEVER RUNS A COMMAND —
// presenting it, reading it, Copy and Cancel reach no runner, and no argument
// list any Settings control can build holds a `pmset` — and the largest text
// grows every pane LONGER, NEVER WIDER at the window's fixed 640 pt pane.
// Then §2.18.7 per pane, the keep-awake mirror against core's own source, and
// each §2.2 verb the window runs — confirmed first, and exactly as argv.

#if os(macOS)
import AppKit
import Foundation
import SwiftUI
import Testing

@testable import MetistryKit

// MARK: - The window

@Test func theSidebarIsScreen15sSectionsInItsFourGroups() {
    #expect(SettingsModel.SectionGroup.allCases.map { $0.sections.map(\.title) } == [
        ["Instance", "Services", "Compute", "Updates"],
        ["Account", "Connections", "Secrets", "Variables"],
        ["Live Capture", "Sessions"],
        ["Keyboard", "Advanced"],
    ])
    #expect(SettingsModel.SectionGroup.allCases.map(\.title) == [nil, "Access", "Capture", nil])
    // every section is in exactly one group, and the enum is the sidebar's order
    #expect(SettingsModel.SectionGroup.allCases.flatMap(\.sections) == SettingsModel.Section.allCases)
    // Connections is renamed Account; the external servers' pane is Connections (C114)
    #expect(SettingsModel.Section.account.title == "Account")
    #expect(SettingsModel.Section.connections.group == .access)
    // the window is fixed and set by its widest pane (§2)
    #expect(SettingsLayout.width == SettingsLayout.sidebar + SettingsLayout.pane)
    #expect((SettingsLayout.width, SettingsLayout.height) == (840, 600))
    // a pane whose own ticket has not landed says what it will hold — never a dead end
    for section in [SettingsModel.Section.variables, .liveCapture, .sessions] {
        #expect((section.pendingNote?.count ?? 0) > 40, "\(section)")
    }
}

// MARK: - The lid dialog never runs a command

@MainActor
@Test func theLidDialogNeverRunsACommand() async throws {
    let (settings, runner, _) = try await settingsReading(keepAwake: #"{"enabled":true,"sleep_on_battery":true,"sleep_lid_closed":true}"#)
    var copied: [String] = []
    settings.copyText = { copied.append($0) }
    #expect(settings.keepAwake == KeepAwakeSwitches(enabled: true, sleepOnBattery: true, sleepLidClosed: true))

    // turning the lid switch off opens the dialog — and nothing else
    settings.setKeepAwake(.sleepLidClosed, to: false)
    #expect(settings.lidDialogPresented)
    #expect(settings.confirmation == nil)
    #expect(runner.commands.isEmpty)

    // Copy puts the administrator's command on the pasteboard; it runs nothing
    settings.copyLidCommand()
    #expect(copied == [LidClosedDialog.command])
    #expect(runner.commands.isEmpty)

    // Cancel leaves the switch as it was; it runs nothing
    settings.dismissLidDialog()
    #expect(!settings.lidDialogPresented)
    #expect(runner.commands.isEmpty)

    // the dialog itself holds no runner: Copy and Cancel are the only closures it calls
    var calls: [String] = []
    let dialog = try await AccessibilityProbe.snapshot(LidClosedDialogView(onCopy: { calls.append("copy") }, onCancel: { calls.append("cancel") }, onTurnOff: { calls.append("turn off") }))
    defer { dialog.close() }
    #expect(dialog.unlabeledBesidesFields.isEmpty, "unlabeled: \(dialog.unlabeledBesidesFields)")
    let said = dialog.nodes.map(\.name)
    #expect(said.contains(LidClosedDialog.command), "the command, to read and copy: \(said)")
    #expect(said.contains(LidClosedDialog.undo), "how to undo it")
    #expect(said.contains { $0.contains(LidClosedDialog.warning) }, "the warning")
    #expect(dialog.headings.contains(LidClosedDialog.title), "\(dialog.headings)")
    #expect(runner.commands.isEmpty)

    // Turn Off stores the SWITCH — M4, `set-keep-awake --sleep-lid-closed false`
    settings.setKeepAwake(.sleepLidClosed, to: false)
    await settings.storeLidClosedAwake()
    #expect(!settings.lidDialogPresented)
    #expect(runner.commands.map(\.row) == [.keepAwake])
    #expect(runner.commands.first?.arguments.starts(with: ["deployment", "set-keep-awake", "--sleep-lid-closed", "false", "--yes"]) == true)

    // and no argument list anything in Settings can build holds a pmset: it is
    // not a §2.2 verb, so a ManagementCommand cannot be made of one
    for command in runner.commands { #expect(!command.arguments.contains { $0.contains("pmset") }) }
    for row in ManagementRow.allCases {
        #expect(ManagementCommand(row, ["pmset", "-a", "disablesleep", "1"]) == nil)
        #expect(ManagementCommand(row, ["sudo", "pmset", "-a", "disablesleep", "1"]) == nil)
    }
    #expect(settings.plan(.runVerb(command: ["sudo", "pmset", "-a", "disablesleep", "1"], label: "Keep awake")) == .copyOnly("sudo pmset -a disablesleep 1"))
}

@MainActor
@Test func aKeepAwakeSwitchIsConfirmedWithItsCostThenWrittenThroughM4() async throws {
    let (settings, runner, _) = try await settingsReading(keepAwake: #""allow_sleep_on_battery""#)
    #expect(settings.keepAwake == KeepAwakeSwitches(.allowSleepOnBattery))

    settings.setKeepAwake(.sleepOnBattery, to: false)
    let pending = try #require(settings.confirmation)
    #expect(pending.command.row == .keepAwake)
    #expect(pending.command.arguments.starts(with: ["deployment", "set-keep-awake", "--sleep-on-battery", "false", "--yes"]))
    #expect(pending.cost.contains(KeepAwakeSetting.always.consequence), "the cost is the value it becomes")
    #expect(pending.said.hasPrefix("metistry deployment set-keep-awake"))
    #expect(runner.commands.isEmpty, "nothing runs before the confirmation")

    await settings.confirm(pending)
    #expect(runner.commands.count == 1)
    #expect(settings.confirmation == nil)
    #expect(settings.outcome?.ok == true)

    // a switch set to what it already is asks nothing
    settings.setKeepAwake(.enabled, to: true)
    #expect(settings.confirmation == nil)
}

// MARK: - The keep-awake mirror

@Test func theKeepAwakeMirrorIsCoresObjectFormRowForRow() throws {
    // core's keepAwakeSetting: each legacy value is exactly one object
    #expect(KeepAwakeSwitches(.never) == KeepAwakeSwitches(enabled: false, sleepOnBattery: true, sleepLidClosed: true))
    #expect(KeepAwakeSwitches(.allowSleepOnBattery) == KeepAwakeSwitches(enabled: true, sleepOnBattery: true, sleepLidClosed: true))
    #expect(KeepAwakeSwitches(.always) == KeepAwakeSwitches(enabled: true, sleepOnBattery: false, sleepLidClosed: true))
    #expect(KeepAwakeSwitches(.alwaysLidClosed) == KeepAwakeSwitches(enabled: true, sleepOnBattery: false, sleepLidClosed: false))
    // …and keepAwakeValue back, including the one object no value names
    for value in KeepAwakeSetting.allCases { #expect(KeepAwakeSwitches(value).nearest == value) }
    #expect(KeepAwakeSwitches(enabled: true, sleepOnBattery: true, sleepLidClosed: false).nearest == .allowSleepOnBattery)
    #expect(KeepAwakeSwitches(enabled: true, sleepOnBattery: true, sleepLidClosed: false).wantsLidClosedAwake)
    #expect(!KeepAwakeSwitches(enabled: false, sleepOnBattery: true, sleepLidClosed: false).wantsLidClosedAwake)

    // either spelling off the wire; a missing sub-switch is its safe answer; no `enabled` is no setting
    let parse = { (text: String) in KeepAwakeSwitches(json: try JSONValue.parse(Data(text.utf8))) }
    #expect(try parse(#""always""#) == KeepAwakeSwitches(.always))
    #expect(try parse(#"{"enabled":true}"#) == KeepAwakeSwitches(enabled: true, sleepOnBattery: true, sleepLidClosed: true))
    #expect(try parse(#"{"enabled":true,"sleep_lid_closed":false}"#)?.wantsLidClosedAwake == true)
    #expect(try parse(#"{"sleep_on_battery":false}"#) == nil)
    #expect(try parse(#""sometimes""#) == nil)

    // the flags are main.ts's, each taking true or false
    #expect(KeepAwakeSwitch.allCases.map(\.flag) == ["--enabled", "--sleep-on-battery", "--sleep-lid-closed"])

    // the dialog's words are core's, verbatim — read from power.ts, not trusted to the eye
    let power = try String(contentsOf: repoRoot().appendingPathComponent("packages/core/src/power.ts"), encoding: .utf8)
    #expect(power.contains(#"LID_CLOSED_DIALOG_TITLE = "\#(LidClosedDialog.title)""#))
    #expect(power.contains(#"LID_CLOSED_COMMAND = "\#(LidClosedDialog.command)""#))
    #expect(power.contains(#"LID_CLOSED_UNDO = "\#(LidClosedDialog.undo)""#))
    #expect(power.contains(#""\#(LidClosedDialog.warning)""#))
    for field in ["enabled: z.boolean()", "sleep_on_battery: z.boolean().default(true)", "sleep_lid_closed: z.boolean().default(true)"] {
        #expect(power.contains(field), "\(field)")
    }
}

@Test func doctorsKeepAwakeRowSaysWhetherTheLidHalfIsInEffect() {
    let row = { (lid: String?) in
        DoctorRow(name: "keep-awake", kind: "keep-awake", status: .degraded, latencyMs: 1, probe: "p",
                  meta: .object(["mode": .string("always_lid_closed"), "holding": .bool(true)].merging(lid.map { ["lid_closed": .string($0)] } ?? [:]) { a, _ in a }))
    }
    #expect(KeepAwakeFacts(row: row("not in effect")).lidClosedInEffect == false)
    #expect(KeepAwakeFacts(row: row("in effect")).lidClosedInEffect)
    #expect(KeepAwakeFacts(row: row(nil)).lidClosed == nil)
}

// MARK: - Services

@MainActor
@Test func servicesAreDoctorsRowsAndEachProblemCarriesTheFixDoctorNames() async throws {
    let (settings, runner, _) = try await settingsReading(doctor: servicesDoctorJSON)

    #expect(settings.supervisor?.label.hasPrefix("launchd") == true)
    #expect(settings.supervisor?.row?.status == .ok)
    let lines = Dictionary(uniqueKeysWithValues: settings.serviceLines.map { ($0.name, $0) })
    #expect(lines["console"]?.status == .ok)
    #expect(lines["console"]?.uptime == "up 3 h 12 min")
    #expect(lines["console"]?.port == 18080, "the namespace's port")
    #expect(lines["reconciler"]?.status == .failed, "the worst of its rows")
    #expect(lines["reconciler"]?.reason?.hasPrefix("the supervisor did not report") == true, "doctor's words, verbatim")
    #expect(lines["reconciler"]?.uptime == nil)
    #expect(lines["assistant"]?.isDisabled == true)

    // the problems: failed and degraded, plus an absent row only when doctor names a fix
    #expect(settings.doctorProblems.map(\.name) == ["child:reconciler", "db", "keep-awake"])
    #expect(settings.checksPassed == 3)

    // each fix, as the pane offers it
    #expect(settings.plan(.openSecrets(label: "Add METISTRY_DB_PASSWORD in Secrets")) == .openSection(.secrets))
    #expect(settings.plan(.openSystemSettings(label: "Open System Settings")) == .openSystemSettings)
    #expect(settings.plan(.runVerb(command: ["metistry", "logs", "reconciler"], label: "View logs")) == .openLog("reconciler"))
    guard case .confirm(let up) = settings.plan(.runVerb(command: ["metistry", "up"], label: "Run metistry up")) else {
        Issue.record("a §2.2 verb is confirmed, not run")
        return
    }
    #expect(up.command == ManagementCommand(.install, ["up"]))
    #expect(settings.plan(.runVerb(command: ["metistry", "vault", "push", "--force"], label: "Push")) == .copyOnly("metistry vault push --force"))
    #expect(runner.commands.isEmpty, "a plan runs nothing")
}

@MainActor
@Test func stoppingAsksFirstAndRestartingOneServiceDoesNot() async throws {
    let (settings, runner, _) = try await settingsReading(doctor: servicesDoctorJSON)

    await settings.restart("console")
    #expect(runner.commands.map(\.arguments) == [["restart", "console", "--json"]])
    #expect(runner.commands.first?.row == .services)

    settings.proposeStop("console")
    let stop = try #require(settings.confirmation)
    #expect(stop.destructive)
    #expect(stop.cost.contains("lose the console"))
    #expect(stop.command.arguments == ["stop", "console", "--json"])
    settings.cancelConfirmation()
    #expect(runner.commands.count == 1, "Cancel runs nothing")

    settings.proposeStopAll()
    #expect(settings.confirmation?.command.arguments == ["stop", "--json"])
    settings.proposeRestartAll()
    #expect(settings.confirmation?.command.arguments == ["restart", "--json"])
    #expect(runner.commands.count == 1)
}

// MARK: - Instance

@MainActor
@Test func theIdentityChangesOnlyThroughIdentitySetAndOnlyWhatChanged() async throws {
    let (settings, runner, _) = try await settingsReading()
    await settings.refreshIdentity()
    #expect(settings.identity?.assistantName == "Aide")

    settings.beginIdentityEdit()
    #expect(settings.identityDraft == IdentityDraft(name: "Aide", mention: "@aide", mark: "🦉"))
    #expect(settings.identityCommand(try #require(settings.identityDraft)) == nil, "nothing changed, nothing to write")

    settings.identityDraft?.name = "Ada"
    settings.identityDraft?.mark = "🐙"
    settings.proposeIdentityChange()
    #expect(settings.identityDraft == nil)
    let pending = try #require(settings.confirmation)
    #expect(pending.command == ManagementCommand(.identity, ["identity", "set", "--name", "Ada", "--mark", "🐙"]))
    #expect(pending.cost.contains("Activity"))
    #expect(runner.commands.isEmpty)
    await settings.confirm(pending)
    #expect(runner.commands.map(\.row) == [.identity])
}

@MainActor
@Test func linkedInstancesAreTheRecordedRouteAndChangeOnlyThroughM11() async throws {
    let (settings, runner, session) = try await settingsReading()
    defer { withExtendedLifetime(session) {} }
    await settings.refreshLinked()
    #expect(settings.linkedPhase == .read)
    let peer = try #require(settings.linked.first)
    #expect(peer.name == "Second")
    #expect(peer.origin == "https://second.example.com")
    #expect(peer.capabilities == ["capture", "knowledge", "queries", "tasks"])
    // components-03 §2: a linked instance *Not seen for 3 days*
    #expect(peer.notSeen(now: WireTime.date("2026-09-19T02:00:00.000Z")!) == "Not seen for 3 days")
    #expect(peer.notSeen(now: WireTime.date("2026-09-16T05:00:00.000Z")!) == nil)

    settings.proposeRemove(peer)
    #expect(settings.confirmation?.command == ManagementCommand(.linkedInstances, ["instances", "remove", peer.id]))
    #expect(settings.confirmation?.destructive == true)
    settings.cancelConfirmation()

    settings.beginLink()
    settings.linkOrigin = "  https://third.example.com "
    settings.proposeLink()
    #expect(settings.confirmation?.command == ManagementCommand(.linkedInstances, ["instances", "add", "https://third.example.com"]))
    settings.cancelConfirmation()

    await settings.refreshLinkedOrigins()
    #expect(runner.commands.map(\.arguments) == [["instances", "refresh"]])
    // the one route Settings reads, and no write over the API
    let routes = session.transportCalls
    #expect(routes.allSatisfy { $0.method == "GET" }, "\(routes)")
    #expect(routes.contains { $0.path == "/api/instances" })
}

// MARK: - Updates

@MainActor
@Test func updateAndRollBackAreM2AndRollBackNeedsAKeptRelease() async throws {
    let (settings, runner, _) = try await settingsReading(version: #"{"cli_version":"0.11.0","product_version":"0.11.0","lock":{"version":"0.11.0","channel":"release"},"runtime_pack":{"version":"0.11.0","commit":"abc1234","built_at":"2026-09-20"}}"#)
    await settings.refreshVersions()
    // the verb's own keys: `lock.channel` and `runtime_pack.version`
    #expect(settings.runtimeChannel == "release")
    #expect(settings.versions?.runtime == "0.11.0")
    #expect(settings.rollBackUnavailableReason == nil)

    settings.proposeUpdate()
    #expect(settings.confirmation?.command == ManagementCommand(.update, ["update"]))
    settings.proposeRollBack()
    #expect(settings.confirmation?.command == ManagementCommand(.update, ["update", "--rollback"]))
    #expect(settings.confirmation?.destructive == true)
    #expect(runner.commands.isEmpty)

    let (checkout, _, _) = try await settingsReading(version: #"{"cli_version":"0.11.0","lock":{"version":"0.11.0","channel":"git"}}"#)
    await checkout.refreshVersions()
    #expect(checkout.rollBackUnavailableReason?.contains("git checkout") == true)
    checkout.proposeRollBack()
    #expect(checkout.confirmation == nil)
}

@MainActor
@Test func aFailedVerbIsShownInTheCLIsOwnWordsWithItsLog() async throws {
    let (settings, runner, _) = try await settingsReading()
    runner.result = CommandResult(exitCode: 1, stdout: "fetching release 0.12.0\nmigrations: 3 to apply\n", stderr: "error: update failed at migrate; rolled back to 0.11.0 — nothing was lost\n")
    settings.proposeUpdate()
    await settings.confirm(try #require(settings.confirmation))
    let outcome = try #require(settings.outcome)
    #expect(!outcome.ok)
    #expect(outcome.words == "update failed at migrate; rolled back to 0.11.0 — nothing was lost")
    #expect(outcome.lines.contains("migrations: 3 to apply"))
}

// MARK: - §2.18

@MainActor
@Test func everyControlOnEveryPaneSpeaksItsName() async throws {
    let (app, session, cleanup) = try await appReading()
    defer { cleanup(); withExtendedLifetime(session) {} }
    for section in SettingsModel.Section.allCases {
        let tree = try await AccessibilityProbe.snapshot(
            SettingsPaneContent(section: section, model: app, actions: SettingsActions()).frame(width: SettingsLayout.pane)
        )
        defer { tree.close() }
        #expect(tree.unlabeledBesidesFields.isEmpty, "\(section) unlabeled: \(tree.unlabeledBesidesFields)")
        #expect(tree.fieldsWithoutAPrompt.isEmpty, "\(section): a field that would say nothing")
        #expect(!tree.headings.isEmpty, "\(section): each section a heading")
    }
    // the sidebar says every section, and the editors every field
    let sidebar = try await AccessibilityProbe.snapshot(SettingsSidebar(settings: app.settings).frame(width: SettingsLayout.sidebar, height: SettingsLayout.height))
    defer { sidebar.close() }
    for section in SettingsModel.Section.allCases {
        #expect(sidebar.nodes.contains { $0.name == section.title }, "\(section.title) not spoken: \(sidebar.nodes.map(\.name).filter { !$0.isEmpty })")
    }
    app.settings.beginIdentityEdit()
    let editor = try await AccessibilityProbe.snapshot(IdentityEditorView(settings: app.settings))
    defer { editor.close() }
    #expect(editor.unlabeledBesidesFields.isEmpty)
    #expect(editor.fieldsWithoutAPrompt.isEmpty)
    app.settings.identityDraft = nil
    app.settings.beginLink()
    let link = try await AccessibilityProbe.snapshot(LinkInstanceView(settings: app.settings))
    defer { link.close() }
    #expect(link.unlabeledBesidesFields.isEmpty)
    #expect(link.fieldsWithoutAPrompt.isEmpty)
}

@MainActor
@Test func theLargestTextGrowsEveryPaneLongerNeverWider() async throws {
    let (app, session, cleanup) = try await appReading()
    defer { cleanup(); withExtendedLifetime(session) {} }
    let width = SettingsLayout.pane
    for section in SettingsModel.Section.allCases {
        var heights: [DynamicTypeSize: CGFloat] = [:]
        for size in [DynamicTypeSize.large, .accessibility5] {
            let renderer = ImageRenderer(content: SettingsPaneContent(section: section, model: app, actions: SettingsActions())
                .padding(MetistrySpace.s5)
                .frame(width: width)
                .environment(\.dynamicTypeSize, size))
            renderer.proposedSize = ProposedViewSize(width: width, height: nil)
            renderer.scale = 1
            let image = try #require(renderer.cgImage, "\(section) did not render")
            #expect(CGFloat(image.width) <= width, "\(section) is \(image.width) wide at \(size)")
            heights[size] = CGFloat(image.height)
        }
        #expect((heights[.accessibility5] ?? 0) > (heights[.large] ?? 0), "\(section) did not grow at the largest text: \(heights)")
    }
}

// MARK: - Fixtures

private func repoRoot() -> URL {
    // tests/kit/<this>.swift → apps/macos → the repository
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent()
}

private let fakeRuntime = MetistryRuntime(source: .path, executable: URL(fileURLWithPath: "/usr/local/bin/metistry"))

/// A settings model over a CLI that answers each read verb from JSON, the
/// recorded console, and a management runner that records every command.
@MainActor
private func settingsReading(
    doctor: String = servicesDoctorJSON,
    keepAwake: String = #""never""#,
    version: String = #"{"cli_version":"0.11.0"}"#
) async throws -> (SettingsModel, SettingsRecordingRunner, RecordedSession) {
    let reads = VerbRunner([
        "doctor": doctor,
        "identity": #"{"instance_id":"bf790c03-78f2-46ca-9655-a7d631c18d0f","name":"Aide","mention":"@aide","icon":"🦉"}"#,
        "version": version,
        "deployment": #"{"shape":"launchd","from":"seed/deployment.yaml","keep_awake":"never","keep_awake_setting":\#(keepAwake),"services":[]}"#,
    ])
    let cli = MetistryCLI(runtime: fakeRuntime, runner: reads, instanceDir: URL(fileURLWithPath: "/tmp/instance"))
    let status = StatusModel(cli: cli)
    await status.refresh()
    let runner = SettingsRecordingRunner()
    let console = try FixtureConsole.recorded()
    let session = ConsoleSession(transport: console, management: runner)
    let settings = SettingsModel(status: status, cli: cli, instanceDir: URL(fileURLWithPath: "/tmp/instance"), session: session)
    await settings.refreshDeployment()
    return (settings, runner, RecordedSession(session: session, console: console))
}

/// The whole app, reading canned verbs and the recorded console — for the
/// panes, which read the app's pointers and registrations too.
@MainActor
private func appReading() async throws -> (AppModel, RecordedSession, () -> Void) {
    let id = "com.foldedspacelabs.metistry.tests.settings-window.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: id)!
    let app = AppModel(bundleResourceURL: nil, runner: VerbRunner([:]), defaults: defaults)
    app.activateInstance(URL(fileURLWithPath: "/tmp/instance"))
    let (settings, runner, recorded) = try await settingsReading()
    _ = settings
    app.console.adopt(transport: recorded.console, management: runner)
    let reads = VerbRunner([
        "doctor": servicesDoctorJSON,
        "identity": #"{"instance_id":"bf790c03-78f2-46ca-9655-a7d631c18d0f","name":"Aide","mention":"@aide","icon":"🦉"}"#,
        "version": #"{"cli_version":"0.11.0","product_version":"0.11.0","lock":{"version":"0.11.0","channel":"release"}}"#,
        "deployment": #"{"shape":"launchd","from":"seed/deployment.yaml","keep_awake":"always_lid_closed","keep_awake_setting":{"enabled":true,"sleep_on_battery":false,"sleep_lid_closed":false},"services":[]}"#,
        "secrets": #"[{"name":"METISTRY_DB_PASSWORD","scope":"instance","inKeychain":true,"foundUnder":"instance","inEnv":true}]"#,
    ])
    let cli = MetistryCLI(runtime: fakeRuntime, runner: reads, instanceDir: URL(fileURLWithPath: "/tmp/instance"))
    app.status.cli = cli
    await app.status.refresh()
    app.settings.adopt(cli: cli, instanceDir: URL(fileURLWithPath: "/tmp/instance"))
    await app.settings.refreshIdentity()
    await app.settings.refreshVersions()
    await app.settings.refreshDeployment()
    await app.settings.refreshSecrets()
    await app.settings.refreshLinked()
    await app.settings.connectionsPane.refresh()
    return (app, recorded, { UserDefaults.standard.removePersistentDomain(forName: id) })
}

/// The session and the console under it, so a test can read what was asked.
private struct RecordedSession {
    let session: ConsoleSession
    let console: FixtureConsole
    var transportCalls: [FixtureCall] { console.calls }
}

/// Answers `metistry <verb> …` with the JSON filed under its first word.
private struct VerbRunner: CommandRunner {
    let replies: [String: String]
    init(_ replies: [String: String]) { self.replies = replies }

    func run(
        executable: URL, arguments: [String], environment: [String: String],
        currentDirectory: URL?, standardInput: String?, onOutput: @escaping @Sendable (OutputLine) -> Void
    ) async throws -> CommandResult {
        let verb = arguments.first ?? ""
        return CommandResult(exitCode: 0, stdout: replies[verb] ?? "", stderr: "")
    }
}

/// A management runner that records what it was handed and answers as told.
final class SettingsRecordingRunner: ManagementRunner, @unchecked Sendable {
    private let lock = NSLock()
    private var _commands: [ManagementCommand] = []
    private var _result = CommandResult(exitCode: 0, stdout: "ok\n", stderr: "")

    var commands: [ManagementCommand] { lock.withLock { _commands } }
    var result: CommandResult { get { lock.withLock { _result } } set { lock.withLock { _result = newValue } } }

    func plannedArguments(_ command: ManagementCommand) -> [String] { ["metistry"] + command.arguments }

    func run(_ command: ManagementCommand, onOutput: @escaping @Sendable (OutputLine) -> Void) async throws -> CommandResult {
        lock.withLock {
            _commands.append(command)
            return _result
        }
    }
}

/// `metistry doctor --json` on a namespaced launchd install: the supervisor
/// and its children, one service down, a manifest probe failing with a fix,
/// and the lid half of keep-awake asked for and not in effect.
let servicesDoctorJSON = """
{
  "as_of": "2026-09-27T03:00:00.000Z",
  "product_dir": "/Applications/Metistry.app/Contents/Resources/product",
  "shape": "launchd",
  "ok": false,
  "rows": [
    { "name": "deployment", "kind": "deployment", "status": "ok", "latency_ms": 1, "probe": "deployment.yaml shape",
      "meta": { "shape": "launchd", "from": "seed/deployment.yaml",
                "services": { "db": "launchd", "console": "launchd", "reconciler": "launchd", "assistant": "disabled" },
                "namespace": { "label_suffix": "a1b2c3d4", "base": 18080, "ports": { "console": 18080, "db": 18081, "reconciler": 18082 } } } },
    { "name": "supervisor:com.foldedspacelabs.metistry.a1b2c3d4", "kind": "supervisor", "status": "ok", "latency_ms": 2, "probe": "socket answers" },
    { "name": "child:console", "kind": "child", "status": "ok", "latency_ms": 1, "probe": "the supervisor reports console running",
      "meta": { "pid": 4411, "uptime_sec": 11520, "restarts": 0 } },
    { "name": "child:reconciler", "kind": "child", "status": "failed", "latency_ms": 1, "probe": "the supervisor reports reconciler running",
      "remediation": "the supervisor did not report reconciler — metistry logs supervisor",
      "action": { "kind": "run_verb", "command": ["metistry", "logs", "reconciler"], "label": "View reconciler logs" } },
    { "name": "db", "kind": "db", "status": "absent", "latency_ms": 0, "probe": "SELECT 1 round-trip",
      "remediation": "METISTRY_DB_PASSWORD is unset",
      "action": { "kind": "open_secrets", "label": "Add METISTRY_DB_PASSWORD in Secrets" } },
    { "name": "apple-fm", "kind": "bridge", "status": "absent", "latency_ms": 0, "probe": "not configured", "remediation": "not configured" },
    { "name": "keep-awake", "kind": "keep-awake", "status": "degraded", "latency_ms": 3, "probe": "pmset -g assertions",
      "remediation": "keeping this Mac awake with the lid closed is not available without an administrator change",
      "meta": { "mode": "always_lid_closed", "holding": true, "pid": 4410, "power_source": "ac", "lid_closed": "not in effect", "sleep_lid_closed": false },
      "action": { "kind": "some_future_kind", "label": "A button this build does not know" } }
  ]
}
"""
#endif

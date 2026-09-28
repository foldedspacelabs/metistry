// Settings ▸ Services (screen-15 §5.2, C129): Doctor first, then the supervisor
// and one line per service, then When it runs.
//
// DOCTOR MOVED HERE from Advanced. Each problem shows doctor's remediation
// verbatim and — when doctor can NAME the fix (T4-21's `action`) — one button:
// open Secrets, open System Settings, open the service's log, or run the verb,
// confirmed first. Nothing parses the prose to find a fix.
//
// THE SERVICES are doctor's rows: the state, how long it has been up or why it
// is not, and its port. Restart · Stop · Log are `metistry restart|stop|start`
// and `logs` (M5) — the supervisor's local socket, never a route: a remote stop
// would lock the owner out. Stopping asks first.
//
// WHEN IT RUNS. Start at Login is the APP's login item; Run in the Background
// is the install's ONE background item (background-agent.swift) — two different
// registrations, and the prose on each says which. Keep this Mac Awake is
// `metistry deployment set-keep-awake` (M4) through the object form (T4-20):
// under it, disabled while it is off, Allow sleep on battery and Allow sleep
// when the lid is closed, both on by default, each with a warning tip. Turning
// the lid one off opens the lid dialog, which RUNS NOTHING (plan §2.15).

import SwiftUI

struct ServicesPane: View {
    @Environment(\.colorScheme) private var scheme
    let model: AppModel
    let actions: SettingsActions

    private var settings: SettingsModel { model.settings }

    var body: some View {
        let p = Palette(scheme)
        doctor(p)
        services(p)
        whenItRuns(p)
    }

    // MARK: Doctor

    @ViewBuilder
    private func doctor(_ p: Palette) -> some View {
        SettingsSection("Doctor") {
            SettingsControls {
                Button("Run Doctor") { Task { await model.status.refresh() } }
                    .disabled(model.status.isChecking)
                if model.status.isChecking {
                    ProgressView().controlSize(.small)
                    Text("Checking — running `metistry doctor --json` on this Mac…")
                        .metistryText(.footnote, p, .textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                } else if let report = model.status.report {
                    Text(report.summary).metistryText(.caption1, p, .textTertiary)
                }
            }
            if case .unavailable(let why) = model.status.phase {
                UnavailableCard(what: "Doctor did not answer", reason: why, command: model.status.lastCommand)
            }
            if model.status.report != nil {
                if settings.doctorProblems.isEmpty {
                    Label("All healthy — no problems to fix.", systemImage: CheckStatus.ok.symbolName)
                        .metistryText(.callout, p, .ok)
                } else {
                    ForEach(settings.doctorProblems) { row in
                        DoctorProblemRow(row: row, settings: settings, actions: actions)
                    }
                }
                Text("\(settings.checksPassed) checks passed")
                    .metistryText(.caption1, p, .textTertiary)
            }
        }
    }

    // MARK: The services

    @ViewBuilder
    private func services(_ p: Palette) -> some View {
        SettingsSection("Services") {
            if let supervisor = settings.supervisor {
                HStack(alignment: .top, spacing: MetistrySpace.s3) {
                    StatusDot(supervisor.row?.status ?? .absent)
                    VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                        Text(supervisor.label)
                            .metistryText(.callout, p)
                            .fixedSize(horizontal: false, vertical: true)
                        if let row = supervisor.row, row.status != .ok {
                            Text(row.remediation ?? row.probe)
                                .metistryText(.caption1, p, .textTertiary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .accessibilityElement(children: .combine)
                SettingsControls {
                    Button("Restart All") { settings.proposeRestartAll() }
                    Button("Stop All") { settings.proposeStopAll() }
                }
                .disabled(settings.management == nil || settings.running != nil)
                ForEach(settings.serviceLines) { line in
                    ServiceLineView(line: line, settings: settings, actions: actions)
                }
                if let deployment = settings.deployment {
                    Text("Planned by \(deployment.from) — the product's seed, then this instance's own deployment.yaml.")
                        .metistryText(.caption1, p, .textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                UnavailableCard(
                    what: "No services reported yet",
                    reason: "They come from `metistry doctor --json`. Run Doctor above.",
                    command: model.status.lastCommand
                )
            }
        }
    }

    // MARK: When it runs

    @ViewBuilder
    private func whenItRuns(_ p: Palette) -> some View {
        SettingsSection("When It Runs") {
            loginItem(p)
            Divider()
            backgroundItem(p)
            Divider()
            KeepAwakeControls(settings: settings)
        }
        .task { model.loginItem.refresh() }
        .task { model.backgroundAgent.refresh() }
        .task(id: model.instances.active) { await settings.refreshDeployment() }
    }

    @ViewBuilder
    private func loginItem(_ p: Palette) -> some View {
        Toggle("Start at Login", isOn: Binding(get: { model.loginItem.isOn }, set: { model.loginItem.set($0) }))
            .disabled(!model.loginItem.isSupported)
        HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
            StatusDot(loginDot)
            Text(model.loginItem.status.label)
                .metistryText(.footnote, p, model.loginItem.status.colorRole)
                .fixedSize(horizontal: false, vertical: true)
        }
        // `requiresApproval` is the normal first-time answer: macOS holds the
        // registration until the person allows it, and there is exactly one
        // place to do that.
        if model.loginItem.status.needsApproval {
            Button("Open Login Items…") { model.loginItem.openSystemSettings() }
        }
        if model.loginItem.status == .notFound {
            Text(LoginItemModel.notAnAppBundleNote)
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        if let error = model.loginItem.lastError {
            UnavailableCard(what: "SMAppService refused", reason: error)
        }
        Text(LoginItemModel.note)
            .metistryText(.caption1, p, .textTertiary)
            .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private func backgroundItem(_ p: Palette) -> some View {
        Toggle("Run in the Background", isOn: Binding(get: { model.backgroundAgent.isOn }, set: { model.backgroundAgent.set($0) }))
            .disabled(!model.backgroundAgent.isSupported || !model.backgroundAgent.bundlesAgent)
        HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
            StatusDot(agentDot)
            Text(model.backgroundAgent.statusLabel)
                .metistryText(.footnote, p, model.backgroundAgent.colorRole)
                .fixedSize(horizontal: false, vertical: true)
        }
        if model.backgroundAgent.needsApproval {
            Button("Open Login Items…") { model.backgroundAgent.openSystemSettings() }
        }
        if model.backgroundAgent.status == .notFound {
            Text(BackgroundAgentModel.notAnAppBundleNote)
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
            Text(BackgroundAgentModel.terminalNote)
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        if let error = model.backgroundAgent.lastError {
            UnavailableCard(what: "SMAppService refused", reason: error)
        }
        Text(BackgroundAgentModel.note)
            .metistryText(.caption1, p, .textTertiary)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var loginDot: CheckStatus {
        switch model.loginItem.status {
        case .enabled: return .ok
        case .requiresApproval: return .degraded
        case .notRegistered: return .absent
        case .notFound, .unknown: return .failed
        }
    }

    private var agentDot: CheckStatus {
        switch model.backgroundAgent.status {
        case .enabled: return .ok
        case .requiresApproval: return .degraded
        case .notRegistered: return .absent
        case .notFound, .unknown: return .failed
        }
    }
}

/// One of doctor's problems, and the fix it names.
struct DoctorProblemRow: View {
    @Environment(\.colorScheme) private var scheme
    let row: DoctorRow
    let settings: SettingsModel
    let actions: SettingsActions

    var body: some View {
        let p = Palette(scheme)
        HStack(alignment: .top, spacing: MetistrySpace.s3) {
            StatusDot(row.status)
            VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                Text(row.name).metistryText(.mono, p)
                Text(row.remediation ?? row.probe)
                    .metistryText(.caption1, p, .textSecondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                if let action = row.action {
                    fix(action)
                }
            }
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private func fix(_ action: DoctorAction) -> some View {
        switch settings.plan(action) {
        case .openSection(let section):
            Button(action.label) { settings.section = section }
        case .openSystemSettings:
            Button(action.label) { actions.openSystemSettings() }
        case .openLog(let service):
            Button(action.label) { actions.openLog(service) }
        case .confirm(let confirmation):
            Button(action.label) { settings.confirmation = confirmation }
                .disabled(settings.management == nil || settings.running != nil)
        case .copyOnly(let command):
            Button("Copy the Command") { settings.copyText(command) }
                .accessibilityLabel("Copy \(command)")
        }
    }
}

/// One service: its state, how long it has been up or why it is not, its
/// port, and Restart · Stop · Log.
struct ServiceLineView: View {
    @Environment(\.colorScheme) private var scheme
    let line: ServiceLine
    let settings: SettingsModel
    let actions: SettingsActions

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s3) {
                StatusDot(line.isDisabled ? .absent : line.status)
                Text(line.name).metistryText(.mono, p)
                Text(line.isDisabled ? "disabled" : line.status.label)
                    .metistryText(.caption1, p, line.isDisabled ? .absent : line.status.colorRole)
                Spacer(minLength: 0)
            }
            .accessibilityElement(children: .combine)
            Text(detail)
                .metistryText(.caption1, p, .textTertiary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            if !line.isDisabled {
                SettingsControls {
                    if line.status == .ok {
                        Button("Restart") { Task { await settings.restart(line.name) } }
                            .accessibilityLabel("Restart \(line.name)")
                        Button("Stop") { settings.proposeStop(line.name) }
                            .accessibilityLabel("Stop \(line.name)")
                    } else {
                        Button("Start") { Task { await settings.start(line.name) } }
                            .accessibilityLabel("Start \(line.name)")
                    }
                    Button("Log") { actions.openLog(line.name) }
                        .accessibilityLabel("\(line.name) log")
                }
                .disabled(settings.management == nil || settings.running != nil)
            }
        }
    }

    private var detail: String {
        var parts: [String] = [line.plannedShape]
        if let uptime = line.uptime { parts.append(uptime) }
        if let port = line.port { parts.append("port \(port)") }
        if let reason = line.reason { parts.append(reason) }
        return parts.joined(separator: " · ")
    }
}

/// Keep this Mac Awake and its two sub-switches (C129), as stored in
/// deployment.yaml and read back through `metistry deployment --json`.
struct KeepAwakeControls: View {
    @Environment(\.colorScheme) private var scheme
    let settings: SettingsModel

    var body: some View {
        let p = Palette(scheme)
        if let switches = settings.keepAwake {
            Toggle(KeepAwakeSwitch.enabled.title, isOn: binding(.enabled, switches))
                .disabled(settings.management == nil || settings.running != nil)
            if let facts = settings.keepAwakeFacts {
                Text(facts.summary)
                    .metistryText(.footnote, p, facts.status.colorRole)
                    .fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                subSwitch(.sleepOnBattery, switches, p)
                subSwitch(.sleepLidClosed, switches, p)
                if switches.wantsLidClosedAwake {
                    let inEffect = settings.keepAwakeFacts?.lidClosedInEffect == true
                    Label(inEffect ? "In effect — an administrator setting keeps this Mac awake." : "Not in effect until the administrator setting is made.", systemImage: inEffect ? CheckStatus.ok.symbolName : CheckStatus.degraded.symbolName)
                        .metistryText(.caption1, p, inEffect ? .ok : .degraded)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.leading, MetistrySpace.s5)
            .disabled(!switches.enabled || settings.management == nil || settings.running != nil)
            if let note = settings.deploymentFacts?.keepAwakeNote {
                Text(note)
                    .metistryText(.caption1, p, .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text("Stored in deployment.yaml through `metistry deployment set-keep-awake`; it takes effect the next time the services start.")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        } else if case .unavailable(let why) = settings.deploymentPhase {
            UnavailableCard(what: "Could not read the keep-awake setting", reason: why)
        } else {
            Text("Reading `metistry deployment --json`…").metistryText(.footnote, p, .textSecondary)
        }
    }

    @ViewBuilder
    private func subSwitch(_ which: KeepAwakeSwitch, _ switches: KeepAwakeSwitches, _ p: Palette) -> some View {
        Toggle(which.title, isOn: binding(which, switches))
        if let warning = which.warning, !switches[which] {
            Label(warning, systemImage: CheckStatus.degraded.symbolName)
                .metistryText(.caption1, p, .degraded)
                .fixedSize(horizontal: false, vertical: true)
        } else if let warning = which.warning {
            Text(warning)
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func binding(_ which: KeepAwakeSwitch, _ switches: KeepAwakeSwitches) -> Binding<Bool> {
        Binding(get: { switches[which] }, set: { settings.setKeepAwake(which, to: $0) })
    }
}

/// The lid dialog (plan §2.15, ruling 3): the administrator command with Copy,
/// how to undo it, and the warning. It runs nothing — Copy puts text on the
/// pasteboard, Cancel leaves the switch on, and Turn Off hands back to the
/// pane, which stores the switch through M4.
public struct LidClosedDialogView: View {
    @Environment(\.colorScheme) private var scheme
    let onCopy: () -> Void
    let onCancel: () -> Void
    let onTurnOff: () -> Void

    public init(onCopy: @escaping () -> Void, onCancel: @escaping () -> Void, onTurnOff: @escaping () -> Void) {
        self.onCopy = onCopy
        self.onCancel = onCancel
        self.onTurnOff = onTurnOff
    }

    public var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s4) {
            Text(LidClosedDialog.title)
                .metistryText(.headline, p)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                Text("To keep a closed Mac awake, run this in Terminal as an administrator:")
                    .metistryText(.callout, p)
                    .fixedSize(horizontal: false, vertical: true)
                SettingsControls {
                    Text(LidClosedDialog.command)
                        .metistryText(.mono, p)
                        .textSelection(.enabled)
                    Button("Copy") { onCopy() }
                        .accessibilityLabel("Copy the command")
                }
                Text("To undo it:")
                    .metistryText(.callout, p)
                Text(LidClosedDialog.undo)
                    .metistryText(.mono, p)
                    .textSelection(.enabled)
            }
            Label(LidClosedDialog.warning, systemImage: CheckStatus.degraded.symbolName)
                .metistryText(.callout, p, .degraded)
                .fixedSize(horizontal: false, vertical: true)
            Text("Metistry keeps your choice and never runs the command. Doctor reads `pmset -g`, and the switch says it is not in effect until it is.")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("Cancel", role: .cancel, action: onCancel)
                    .keyboardShortcut(.cancelAction)
                Button("Turn Off", action: onTurnOff)
                    .accessibilityLabel("Turn off Allow sleep when the lid is closed")
            }
        }
        .padding(MetistrySpace.s5)
        .frame(width: 480)
    }
}

// Settings: what is on screen and where every value came from (T6-11,
// screen-15-settings.md). The window is settings-view.swift; each pane is a
// file under settings-panes/.
//
// Twelve sections in a grouped sidebar (screen-15 §1), and each one is a
// window onto something else — never a copy of it (app-preferences.swift holds
// the rule and the pointers this app does persist):
//
//   Instance     the active instance directory + recents (PERSISTED, pointers);
//                the instance id and the assistant's name, mention and mark from
//                `metistry identity --json` (READ-THROUGH), changed only by
//                `metistry identity set` (M10, a protected write, confirmed);
//                namespace and ports from doctor's `deployment` row; linked
//                instances from `GET /api/instances`, changed by `metistry
//                instances add|remove|refresh` (M11)
//   Services     Doctor (its problems, each with the fix doctor NAMES — T4-21's
//                `action`), the supervisor and one line per service from
//                doctor's rows, the lifecycle verbs (M5), and When it runs:
//                the login item, the background item, and keep-awake through
//                `metistry deployment set-keep-awake` (M4) — the lid dialog
//                runs nothing
//   Compute      compute-model.swift (T6-12): `GET /api/compute` and its
//                catalogue; limits and the model through the API (§2.3),
//                providers and local models through M16/M17, confirmed
//   Updates      Sparkle's own preferences; the runtime through `metistry
//                version --json`, `metistry update` and `--rollback` (M2)
//   Account      the console sign-in and the instance repository — the old
//                *Connections* (screen-15 §1)
//   Connections  connections-model.swift (T6-13a's pane): the list and one
//                connection from `GET /api/connections(/:name)` and
//                `GET /api/secrets`; tool modes, the offer switch and Test are
//                `metistry connections` (M13), a secret's hosts and grant
//                `metistry secrets` (M7)
//   Secrets, Variables, Live Capture, Sessions
//                their own tickets' panes; until each lands, the pane says what
//                it will hold and which verb does it today
//   Keyboard     the any-app shortcuts (T6-16 registers them) and Show All ⌘/
//   Advanced     the resolved runtime, the developer override, versions, logs,
//                the passkey diagnostic
//
// Nothing here caches to disk. Every read is re-done when the pane opens, so a
// value the user changed in a file or a terminal shows up without a relaunch —
// and a value the app cannot read says "unavailable" in its own row and leaves
// the rest of the pane alone (design-system P5).
//
// EVERY WRITE IS A §2.2 VERB, CONFIRMED. A change to a protected file
// (identity.yaml, deployment.yaml, instances.yaml) or to the running services
// is a `ManagementCommand` — a type that cannot hold anything §2.2 does not
// list — shown with the exact command before it runs (`SettingsConfirmation`),
// and run through the session's `ManagementRunner`. No console route is added
// for any of it (invariant 10), and no setting is a prompt or a config line.

import Foundation
import Observation

/// The state of one read-through value. Same four states as everything else in
/// the product, for the same reason: state is reported, never inferred.
public enum ReadPhase: Equatable, Sendable {
    case idle
    case reading
    case read
    case unavailable(String)
}

@MainActor
@Observable
public final class SettingsModel {
    public enum Section: String, CaseIterable, Identifiable, Sendable {
        case instance
        case services
        case compute
        case updates
        case account
        case connections
        case secrets
        case variables
        case liveCapture
        case sessions
        case keyboard
        case advanced

        public var id: String { rawValue }

        /// Title Case — these are navigation labels (design-system P10).
        public var title: String {
            switch self {
            case .instance: return "Instance"
            case .services: return "Services"
            case .compute: return "Compute"
            case .updates: return "Updates"
            case .account: return "Account"
            case .connections: return "Connections"
            case .secrets: return "Secrets"
            case .variables: return "Variables"
            case .liveCapture: return "Live Capture"
            case .sessions: return "Sessions"
            case .keyboard: return "Keyboard"
            case .advanced: return "Advanced"
            }
        }

        public var symbolName: String {
            switch self {
            case .instance: return "folder"
            case .services: return "gearshape.2"
            case .compute: return "cpu"
            case .updates: return "arrow.down.circle"
            case .account: return "person.crop.circle"
            case .connections: return "link"
            case .secrets: return "key"
            case .variables: return "textformat.abc"
            case .liveCapture: return "record.circle"
            case .sessions: return "waveform"
            case .keyboard: return "keyboard"
            case .advanced: return "wrench.and.screwdriver"
            }
        }

        public var group: SectionGroup {
            SectionGroup.allCases.first { $0.sections.contains(self) } ?? .general
        }

        /// A pane whose own ticket has not landed yet: it says what it will
        /// hold and which verb does it today, rather than a dead end (C138).
        public var pendingNote: String? {
            switch self {
            case .variables:
                return "Variables — the text your agents read — get their own pane here. Until then they are `metistry variables set <name> <value>` and `metistry variables unset <name>` in Terminal (.metistry/variables.yaml, a protected path)."
            case .liveCapture:
                return "The capture bar's switch, its placement, the permissions macOS has granted and how long recordings are kept get their own pane here."
            case .sessions:
                return "Recorded sessions, what each one produced, and Purge Now get their own pane here."
            default:
                return nil
            }
        }
    }

    /// The sidebar's groups, in order (screen-15 §1). The first and the last
    /// carry no heading.
    public enum SectionGroup: String, CaseIterable, Identifiable, Sendable {
        case general
        case access
        case capture
        case tail

        public var id: String { rawValue }

        public var title: String? {
            switch self {
            case .general, .tail: return nil
            case .access: return "Access"
            case .capture: return "Capture"
            }
        }

        public var sections: [Section] {
            switch self {
            case .general: return [.instance, .services, .compute, .updates]
            case .access: return [.account, .connections, .secrets, .variables]
            case .capture: return [.liveCapture, .sessions]
            case .tail: return [.keyboard, .advanced]
            }
        }
    }

    public var section: Section = .instance

    /// The shared doctor report. Services and Account render it; they never
    /// run their own probes (invariant 3 — one read path).
    public let status: StatusModel
    /// Who the console takes this Mac to be. The app's one sign-in model, shared
    /// with the Status header, the menu bar and the wizard — Connections renders
    /// it, and no pane asks the question a second time.
    public let consoleSignIn: ConsoleSignInModel
    /// The Compute pane. It owns the write verbs; `compute` below is the
    /// read-only summary the Connections pane has always shown, and both come
    /// from the same `compute show --json`.
    public let computePane: ComputeModel
    /// The Connections pane: read over the API, changed through M13 and M7.
    public let connectionsPane: ConnectionsModel
    public private(set) var cli: MetistryCLI?
    public private(set) var instanceDir: URL?

    // MARK: read-through, never persisted
    public private(set) var identity: InstanceIdentity?
    public private(set) var identityPhase: ReadPhase = .idle
    public private(set) var identityCommand: String?
    public private(set) var versions: VersionFacts?
    public private(set) var versionsPhase: ReadPhase = .idle
    public private(set) var versionsCommand: String?
    public private(set) var secrets: [SecretListing] = []
    public private(set) var secretsPhase: ReadPhase = .idle
    public private(set) var secretsCommand: String?
    public private(set) var deploymentFacts: DeploymentShapeFacts?
    public private(set) var deploymentPhase: ReadPhase = .idle

    // MARK: the §2.2 verbs, and what the last one said

    /// The confirmation on screen — the exact command, and what it costs —
    /// before any protected write or lifecycle verb runs. `nil`: none.
    public var confirmation: SettingsConfirmation?
    /// The lid dialog (plan §2.15). Presenting it, reading it and Copy run
    /// nothing; only *Turn Off* stores the setting, through M4.
    public var lidDialogPresented = false
    /// The assistant's identity, being edited. `nil`: not editing.
    public var identityDraft: IdentityDraft?
    /// *Link an Instance…*'s origin, being typed. `nil`: the sheet is closed.
    public var linkOrigin: String?
    /// The verb running now, as the pane says it.
    public private(set) var running: String?
    /// The last verb's outcome, in the CLI's own words (§3.16).
    public private(set) var outcome: SettingsOutcome?

    /// The console's peers, from `GET /api/instances`.
    public private(set) var linked: [LinkedInstance] = []
    public private(set) var linkedPhase: ReadPhase = .idle
    /// A newer runtime release, as the daily Update Check announced it
    /// (`release.available`, T2-18) while this app was listening. `nil`: none
    /// heard — which is not the same as none published.
    public private(set) var runtimeAvailable: String?

    /// The pasteboard, handed in by the platform (the kit has no AppKit).
    public var copyText: @MainActor (String) -> Void = { _ in }

    /// The active instance's console session: its stores for the one read
    /// Settings makes over the API (linked instances), its event stream, and
    /// its `ManagementRunner` for every write. Held, not copied, so an
    /// instance switch — which re-wires the session — reaches here too.
    @ObservationIgnored public private(set) var session: ConsoleSession?
    @ObservationIgnored private let managementOverride: (any ManagementRunner)?

    public init(
        status: StatusModel,
        cli: MetistryCLI?,
        instanceDir: URL?,
        consoleSignIn: ConsoleSignInModel? = nil,
        computePane: ComputeModel? = nil,
        session: ConsoleSession? = nil,
        management: (any ManagementRunner)? = nil
    ) {
        self.status = status
        self.cli = cli
        self.instanceDir = instanceDir
        self.consoleSignIn = consoleSignIn ?? ConsoleSignInModel(cli: cli)
        self.computePane = computePane ?? ComputeModel(status: status, cli: cli, session: session, management: management)
        self.connectionsPane = ConnectionsModel(session: session)
        self.session = session
        self.managementOverride = management
        // `release.available` names the version and nothing else; Settings ▸
        // Updates is where it is offered.
        session?.events.watch([.identity]) { [weak self] event in
            guard let self else { return false }
            if case .releaseAvailable(let version) = event.change { self.runtimeAvailable = version }
            return true
        }
    }

    /// §2.2's runner: the session's, which follows every instance switch.
    public var management: (any ManagementRunner)? {
        managementOverride ?? session?.management ?? cli.map { CLIManagementRunner(cli: $0) }
    }

    /// Re-point at another install. Everything read-through is dropped rather
    /// than left showing the previous instance's values while the new reads run —
    /// a stale name beside a new path is the one thing this pane must never do.
    public func adopt(cli: MetistryCLI?, instanceDir: URL?) {
        self.cli = cli
        self.instanceDir = instanceDir
        identity = nil
        identityPhase = .idle
        identityCommand = nil
        versions = nil
        versionsPhase = .idle
        versionsCommand = nil
        secrets = []
        secretsPhase = .idle
        secretsCommand = nil
        deploymentFacts = nil
        deploymentPhase = .idle
        linked = []
        linkedPhase = .idle
        runtimeAvailable = nil
        confirmation = nil
        lidDialogPresented = false
        identityDraft = nil
        linkOrigin = nil
        outcome = nil
        computePane.adopt(cli: cli)
        connectionsPane.adopt()
    }

    // MARK: - Instance

    /// `metistry identity --json`.
    public func refreshIdentity() async {
        guard let cli else {
            identityPhase = .unavailable(CLIReadError.noRuntime.localizedDescription ?? "no runtime")
            return
        }
        identityCommand = cli.plannedArguments(for: ["identity", "--json"]).joined(separator: " ")
        identityPhase = .reading
        switch await cli.identity() {
        case .success(let value):
            identity = value
            identityPhase = .read
        case .failure(let error):
            identity = nil
            identityPhase = .unavailable(error.localizedDescription ?? "unavailable")
        }
    }

    /// `metistry version --json` — the product, the runtime pack, and the
    /// instance's pin, in one read.
    public func refreshVersions() async {
        guard let cli else {
            versionsPhase = .unavailable(CLIReadError.noRuntime.localizedDescription ?? "no runtime")
            return
        }
        versionsCommand = cli.plannedArguments(for: ["version", "--json"]).joined(separator: " ")
        versionsPhase = .reading
        switch await cli.versions() {
        case .success(let value):
            versions = value
            versionsPhase = .read
        case .failure(let error):
            versions = nil
            versionsPhase = .unavailable(error.localizedDescription ?? "unavailable")
        }
    }

    /// The instance's pin, from the same read. `metistry.lock` is not opened by
    /// this app any more.
    public var pin: InstancePin? { versions?.lock }

    /// What the Instance pane prints for the assistant's name. `identity.yaml`
    /// is the only place it lives and `metistry identity` is the only route to
    /// it, so a read that failed says so rather than falling back to a default
    /// that would be a second definition of the name.
    public var assistantNameDisplay: String {
        identity?.assistantName ?? "unknown"
    }

    /// The instance id, and what it is for. `metistry init` mints a v4 UUID into
    /// `identity.yaml`; it is the Keychain account this instance's own secrets
    /// are filed under, which is what makes several instances on one Mac
    /// self-contained (docs/product/desktop-app-plan.md).
    public static let instanceIdNote =
        "The instance id is the v4 UUID `metistry init` minted into identity.yaml. It is this directory's stable identity "
        + "and the login-Keychain account its instance-scoped secrets are filed under, which is what keeps several "
        + "instances on one Mac from reading each other's."

    // MARK: - Secrets

    /// `metistry secrets list --json` — names and scope. Values are not
    /// requested, not returned by the verb, and could not be rendered if they
    /// were.
    public func refreshSecrets() async {
        guard let cli else {
            secretsPhase = .unavailable(CLIReadError.noRuntime.localizedDescription ?? "no runtime")
            return
        }
        secretsCommand = cli.plannedArguments(for: ["secrets", "list", "--json"]).joined(separator: " ")
        secretsPhase = .reading
        switch await cli.secretsList() {
        case .success(let rows):
            secrets = rows
            secretsPhase = rows.isEmpty
                ? .unavailable("`metistry secrets list --json` named nothing — this install has no .env yet, or no secret-shaped variables in it")
                : .read
        case .failure(let error):
            secrets = []
            secretsPhase = .unavailable(error.localizedDescription ?? "unavailable")
        }
    }

    // MARK: - Compute

    // ONE read of `GET /api/compute` for the whole window. The Compute pane
    // owns it (compute-model.swift, T6-12); other panes read the report through
    // these, so no two panes can disagree about which model answers a turn and
    // none makes the read another already made.

    public var compute: ComputeFacts? { computePane.report }
    public var computePhase: ReadPhase { computePane.phase }
    public var computeCommand: String? { ComputeModel.readRoute }

    /// `GET /api/compute` — which provider and model each tier runs on, and
    /// whether the key each provider NAMES is present. No value of any key
    /// crosses this boundary, because the route cannot serve one.
    public func refreshCompute() async {
        await computePane.refresh()
    }

    // MARK: - Services

    public var deployment: DeploymentFacts? { status.report?.deployment }

    /// Every doctor row that speaks for one service: its process — a
    /// supervisor child, a container, or a launchd job — and its manifest's own
    /// probe. Matched by name only; the state is doctor's, never decided here.
    public func serviceRows(named name: String) -> [DoctorRow] {
        (status.report?.rows ?? []).filter { row in
            switch row.kind {
            case "child": return row.name == "child:\(name)"
            case "container": return row.name == "compose:\(name)"
            // `launchd:com.foldedspacelabs.metistry[.<suffix>].<service>` — the
            // service is the label's last component (launchd.ts `serviceOf`)
            case "launchd": return row.name.hasPrefix("launchd:") && row.name.split(separator: ".").last.map(String.init) == name
            case "service": return row.name == name
            default: return false
            }
        }
    }

    /// One line per service the shape plans, in doctor's words: the worst
    /// state any of its rows reports, how long it has been up — or why it is
    /// not — and its port when this instance has a namespace.
    public var serviceLines: [ServiceLine] {
        guard let deployment else { return [] }
        return deployment.ordered.map { planned in
            let rows = serviceRows(named: planned.name)
            let worst = rows.max { ServiceLine.severity($0.status) < ServiceLine.severity($1.status) }
            let uptime = rows.lazy.compactMap { $0.meta?["uptime_sec"]?.intValue }.first
            return ServiceLine(
                name: planned.name,
                plannedShape: planned.shape,
                status: rows.isEmpty ? .absent : (worst?.status ?? .absent),
                uptime: worst?.status == .ok || worst == nil ? uptime.map(ServiceLine.uptimeText) : nil,
                reason: rows.isEmpty ? "not in this doctor report" : (worst?.status == .ok ? nil : (worst?.remediation ?? worst?.probe)),
                port: deployment.namespace?.ports[planned.name]
            )
        }
    }

    /// What runs the services: the supervisor (launchd) or Docker Compose, and
    /// doctor's row for it when there is one.
    public var supervisor: (label: String, row: DoctorRow?)? {
        guard let shape = deployment?.shape else { return nil }
        let rows = status.report?.rows ?? []
        switch shape {
        case "launchd": return ("launchd — one supervisor runs every service as its child", rows.first { $0.kind == "supervisor" })
        case "compose": return ("Docker Compose — each service is a container", rows.first { $0.kind == "compose" })
        default: return (shape, nil)
        }
    }

    /// Doctor's problems, each with the fix it names (T4-21): every failed or
    /// degraded row, and a not-configured row only when doctor offers a fix —
    /// an absent bridge nobody set up is not a problem to raise.
    public var doctorProblems: [DoctorRow] {
        (status.report?.rows ?? []).filter { row in
            switch row.status {
            case .failed, .degraded: return true
            case .absent: return row.action != nil
            case .ok: return false
            }
        }
    }

    /// *Checks passed*: the rows doctor said `ok`.
    public var checksPassed: Int { status.report?.count(of: .ok) ?? 0 }

    /// What a doctor action does from this pane. `runVerb` is §2.2's verbs
    /// only — `ManagementCommand` refuses any other — and is confirmed before
    /// it runs; a log is opened, not run; anything else is shown to copy.
    public func plan(_ action: DoctorAction) -> DoctorActionPlan {
        switch action {
        case .openSecrets: return .openSection(.secrets)
        case .openSystemSettings: return .openSystemSettings
        case .runVerb(let argv, let label):
            let args = argv.first == "metistry" ? Array(argv.dropFirst()) : argv
            if args.first == "logs", args.count > 1 { return .openLog(args[1]) }
            guard let command = ManagementRow.allCases.lazy.compactMap({ ManagementCommand($0, args) }).first else {
                return .copyOnly(argv.joined(separator: " "))
            }
            return .confirm(SettingsConfirmation(
                title: "\(label)?",
                cost: "Runs this on this Mac, as you. Doctor runs again after it.",
                actionTitle: label,
                command: command,
                after: .doctor
            ))
        }
    }

    // MARK: Lifecycle (M5)

    /// Restart one service now: nothing is lost, and the pane shows the CLI's
    /// answer. Restart All asks first, because it takes the console down with it.
    public func restart(_ service: String) async {
        guard let command = ManagementCommand(.services, ["restart", service, "--json"]) else { return }
        await run(command, after: .doctor)
    }

    public func start(_ service: String) async {
        guard let command = ManagementCommand(.services, ["start", service, "--json"]) else { return }
        await run(command, after: .doctor)
    }

    /// Stop one service: confirmed, naming what stops with it.
    public func proposeStop(_ service: String) {
        guard let command = ManagementCommand(.services, ["stop", service, "--json"]) else { return }
        confirmation = SettingsConfirmation(
            title: "Stop \(service)?",
            cost: service == "console"
                ? "The app, the phone and every agent lose the console until you start it again. Start it here, or with `metistry start console`."
                : "\(service) stays stopped — through restarts of the others — until you start it again.",
            actionTitle: "Stop",
            command: command,
            destructive: true,
            after: .doctor
        )
    }

    public func proposeRestartAll() {
        guard let command = ManagementCommand(.services, ["restart", "--json"]) else { return }
        confirmation = SettingsConfirmation(
            title: "Restart every service?",
            cost: "Every service this shape runs restarts, the console with them: a turn in progress is cut off, and the app reconnects when they are back.",
            actionTitle: "Restart All",
            command: command,
            after: .doctor
        )
    }

    public func proposeStopAll() {
        guard let command = ManagementCommand(.services, ["stop", "--json"]) else { return }
        confirmation = SettingsConfirmation(
            title: "Stop every service?",
            cost: "Nothing runs until you start it again: no console, no captures, no scheduled routines, and the phone cannot reach this Mac.",
            actionTitle: "Stop All",
            command: command,
            destructive: true,
            after: .doctor
        )
    }

    // MARK: Keep this Mac awake (M4)

    /// `metistry deployment --json` — the shape, and the keep-awake switches
    /// exactly as stored (T4-20), without doctor's full sweep.
    public func refreshDeployment() async {
        guard let cli else {
            deploymentPhase = .unavailable(CLIReadError.noRuntime.localizedDescription)
            return
        }
        deploymentPhase = .reading
        switch await cli.deployment() {
        case .success(let facts):
            deploymentFacts = facts
            deploymentPhase = facts.keepAwake == nil
                ? .unavailable("`metistry deployment --json` did not report keep_awake — this CLI predates it: update it (metistry update)")
                : .read
        case .failure(let error):
            deploymentFacts = nil
            deploymentPhase = .unavailable(error.localizedDescription)
        }
    }

    /// The switches as stored. `nil` until `metistry deployment --json` has answered.
    public var keepAwake: KeepAwakeSwitches? { deploymentFacts?.keepAwake }

    /// Doctor's `keep-awake` row: whether it holds, on which power, and
    /// whether the lid half is in effect.
    public var keepAwakeFacts: KeepAwakeFacts? { status.report?.keepAwake }

    /// The one verb that changes one switch: `set-keep-awake <flag> true|false
    /// --yes`, which changes only the switch it names (packages/cli
    /// deployment-report.ts). Never a `pmset` — that is not a §2.2 verb, and a
    /// `ManagementCommand` cannot hold it.
    public func keepAwakeCommand(_ which: KeepAwakeSwitch, _ on: Bool) -> ManagementCommand? {
        var arguments = ["deployment", "set-keep-awake", which.flag, on ? "true" : "false", "--yes"]
        if let dir = instanceDir { arguments += ["--instance", dir.path] }
        return ManagementCommand(.keepAwake, arguments)
    }

    /// A switch was flipped. Turning *Allow sleep when the lid is closed* off
    /// opens the lid dialog and runs nothing; every other change is confirmed
    /// with what it costs, then written through M4.
    public func setKeepAwake(_ which: KeepAwakeSwitch, to on: Bool) {
        guard var target = keepAwake, target[which] != on else { return }
        if which == .sleepLidClosed, !on {
            lidDialogPresented = true
            return
        }
        target[which] = on
        guard let command = keepAwakeCommand(which, on) else { return }
        confirmation = SettingsConfirmation(
            title: which == .enabled ? (on ? "Keep this Mac awake?" : "Let this Mac sleep?") : "\(which.title): \(on ? "on" : "off")?",
            cost: "\(target.nearest.consequence) It is written to deployment.yaml as you, and takes effect the next time the services start.",
            actionTitle: "Change",
            command: command,
            after: .deployment
        )
    }

    /// The lid dialog's Copy: the administrator command, to the pasteboard.
    /// Runs nothing.
    public func copyLidCommand() {
        copyText(LidClosedDialog.command)
    }

    /// The lid dialog's Cancel: the switch stays on. Runs nothing.
    public func dismissLidDialog() {
        lidDialogPresented = false
    }

    /// The lid dialog's *Turn Off*: the dialog closes, and the switch's value
    /// is stored through M4 (`--sleep-lid-closed false`) — what ruling 3 says
    /// is kept. The administrator command is the owner's to run; doctor reads
    /// `pmset -g` and the switch says *not in effect* until it is.
    public func storeLidClosedAwake() async {
        lidDialogPresented = false
        guard let command = keepAwakeCommand(.sleepLidClosed, false) else { return }
        await run(command, after: .deployment)
    }

    // MARK: - Account

    public var reconciler: ReconcilerFacts? { status.report?.reconciler }

    /// The instance repo's backup state, in one sentence, from the reconciler's
    /// own report — the sole committer is the only honest source, and the app
    /// runs no git of its own (invariant 9 applied to the client).
    public var repositoryStatus: String {
        guard let facts = reconciler else { return "unknown — doctor has not reported the reconciler yet" }
        guard facts.pushAttempted, let remote = facts.remote else {
            return "no remote — this instance is versioned locally only. `metistry connect-repo` adds one."
        }
        let when = facts.pushedAt.map { " at \($0)" } ?? ""
        return facts.pushOK == true
            ? "pushed to \(remote)\(when)"
            : "last push to \(remote) failed\(when) — see the reconciler row in Status"
    }

    /// The provider keys this install's compute.yaml NAMES, as `secrets list`
    /// reports them: set or not set, never the value. Empty until both reads
    /// have run — the app keeps no list of provider names of its own, because
    /// compute.yaml is the only thing that decides them.
    public var providerSecretListings: [SecretListing] {
        let named = Set(compute?.providers.compactMap(\.secret) ?? [])
        return secrets.filter { named.contains($0.name) }
    }

    /// What the Connections pane says about the console's door, under the
    /// sign-in state itself. The decision, in one paragraph, because "why does
    /// this Mac not need a passkey?" is the question the row provokes.
    public static let consoleSignInNote =
        "This Mac authenticates to the LOCAL console implicitly: the app and the `metistry` command are the same package on the "
        + "same machine, so the console accepts \(ConsoleSignIn.tokenVariable) as the `user` principal — the same principal a "
        + "passkey session yields — but only over a connection from this machine (docs/ops/auth.md). The app never reads the "
        + "token: `metistry console whoami --json` resolves it, presents it, and prints the answer, and there is no field on "
        + "this pane that could hold a value. Passkeys are unchanged, and are what a browser or a phone enrols."

    // MARK: - Instance: the assistant (M10)

    public func beginIdentityEdit() {
        identityDraft = IdentityDraft(identity)
    }

    /// `metistry identity set` with the fields that changed, or `nil` when
    /// none did. The CLI validates every field and refuses the whole write
    /// when one is invalid — nothing is checked here that it checks.
    public func identityCommand(_ draft: IdentityDraft) -> ManagementCommand? {
        var arguments = ["identity", "set"]
        let trimmed = { (s: String) in s.trimmingCharacters(in: .whitespacesAndNewlines) }
        if trimmed(draft.name) != (identity?.assistantName ?? ""), !trimmed(draft.name).isEmpty { arguments += ["--name", trimmed(draft.name)] }
        if trimmed(draft.mention) != (identity?.mention ?? ""), !trimmed(draft.mention).isEmpty { arguments += ["--mention", trimmed(draft.mention)] }
        if trimmed(draft.mark) != (identity?.icon ?? ""), !trimmed(draft.mark).isEmpty { arguments += ["--mark", trimmed(draft.mark)] }
        guard arguments.count > 2 else { return nil }
        return ManagementCommand(.identity, arguments)
    }

    /// Save…: the editor closes and the protected write is confirmed.
    public func proposeIdentityChange() {
        guard let draft = identityDraft else { return }
        identityDraft = nil
        guard let command = identityCommand(draft) else { return }
        confirmation = SettingsConfirmation(
            title: "Change \(assistantNameDisplay)'s identity?",
            cost: "identity.yaml is a protected file: this is written as you, through the reconciler, and shows in Activity. The console picks it up at its next restart.",
            actionTitle: "Change",
            command: command,
            after: .identity
        )
    }

    // MARK: - Instance: linked instances (M11)

    /// `GET /api/instances` — the peer registry, read-only over the API.
    public func refreshLinked() async {
        guard let session else {
            linkedPhase = .unavailable("no console session for this instance")
            return
        }
        linkedPhase = .reading
        switch await session.stores.instances() {
        case .success(let list):
            linked = LinkedInstance.list(list.json)
            linkedPhase = .read
        case .failure(let error):
            linkedPhase = .unavailable(error.localizedDescription)
        }
    }

    /// *Check Now* / *Refresh*: re-asks every recorded origin who it is
    /// (`metistry instances refresh`). An unreachable one keeps its row.
    public func refreshLinkedOrigins() async {
        guard let command = ManagementCommand(.linkedInstances, ["instances", "refresh"]) else { return }
        await run(command, after: .linked)
    }

    public func beginLink() {
        linkOrigin = ""
    }

    /// Link…: the sheet closes and the trust relationship is confirmed.
    public func proposeLink() {
        let origin = (linkOrigin ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        linkOrigin = nil
        guard !origin.isEmpty, let command = ManagementCommand(.linkedInstances, ["instances", "add", origin]) else { return }
        confirmation = SettingsConfirmation(
            title: "Link \(origin)?",
            cost: "This instance asks that origin who it is and records its id, name and what it offers in instances.yaml, a protected file, as you. An origin that will not say is not written.",
            actionTitle: "Link",
            command: command,
            after: .linked
        )
    }

    public func proposeRemove(_ instance: LinkedInstance) {
        guard let command = ManagementCommand(.linkedInstances, ["instances", "remove", instance.id]) else { return }
        confirmation = SettingsConfirmation(
            title: "Remove \(instance.name)?",
            cost: "This instance stops knowing about \(instance.origin). Linking it again asks it who it is from the start.",
            actionTitle: "Remove",
            command: command,
            destructive: true,
            after: .linked
        )
    }

    // MARK: - Updates: the runtime (M2)

    /// `git` or `release`, from the instance's pin.
    public var runtimeChannel: String? { pin?.source }

    /// Roll Back flips a release install's `current` to the one before it; a
    /// checkout has no previous release to flip to.
    public var rollBackUnavailableReason: String? {
        switch runtimeChannel {
        case "release": return nil
        case "git": return "This install runs from a git checkout: there is no previous release kept to roll back to."
        default: return "The instance's pin does not say which channel it is on."
        }
    }

    public func proposeUpdate() {
        guard let command = ManagementCommand(.update, ["update"]) else { return }
        confirmation = SettingsConfirmation(
            title: runtimeAvailable.map { "Update the runtime to \($0)?" } ?? "Update the runtime?",
            cost: "The services stop and start on the new release, its migrations run under a lock, and the new pin is written to the instance repository. The previous release is kept for Roll Back.",
            actionTitle: "Update Runtime",
            command: command,
            after: .versions
        )
    }

    public func proposeRollBack() {
        guard rollBackUnavailableReason == nil, let command = ManagementCommand(.update, ["update", "--rollback"]) else { return }
        confirmation = SettingsConfirmation(
            title: "Roll back the runtime?",
            cost: "The previous release runs again. Migrations are additive and are not reverted: what the newer release wrote stays.",
            actionTitle: "Roll Back",
            command: command,
            destructive: true,
            after: .versions
        )
    }

    // MARK: - Running a confirmed verb

    /// The confirmation's action: run the command it named — the one the
    /// owner read, handed back by the dialog rather than looked up again.
    public func confirm(_ pending: SettingsConfirmation) async {
        if confirmation?.id == pending.id { confirmation = nil }
        await run(pending.command, after: pending.after)
    }

    public func cancelConfirmation() {
        confirmation = nil
    }

    public func dismissOutcome() {
        outcome = nil
    }

    /// One §2.2 verb, through the session's runner; its lines are kept for
    /// View Log, its answer is the CLI's own last line, and the read it
    /// changed is re-done.
    func run(_ command: ManagementCommand, after: SettingsConfirmation.After) async {
        guard let runner = management else {
            outcome = SettingsOutcome(command: command.arguments.joined(separator: " "), ok: false, words: "No metistry runtime located — finish step 1 of first run.", lines: [])
            return
        }
        let said = (["metistry"] + command.arguments).joined(separator: " ")
        running = said
        outcome = nil
        let lines = LineCollector()
        do {
            let result = try await runner.run(command) { lines.append($0.text) }
            let collected = lines.all.isEmpty ? (result.stdout + "\n" + result.stderr).split(separator: "\n").map(String.init) : lines.all
            outcome = SettingsOutcome(command: said, ok: result.ok, words: Self.cliWords(result, command: said), lines: collected)
        } catch {
            outcome = SettingsOutcome(command: said, ok: false, words: error.localizedDescription, lines: lines.all)
        }
        running = nil
        switch after {
        case .doctor: await status.refresh()
        case .deployment:
            await refreshDeployment()
            await status.refresh()
        case .identity: await refreshIdentity()
        case .linked: await refreshLinked()
        case .versions: await refreshVersions()
        case .connections: await connectionsPane.refresh()
        }
    }

    /// The CLI's answer, verbatim: its last non-empty line — stderr's on a
    /// failure, stdout's otherwise.
    static func cliWords(_ result: CommandResult, command: String) -> String {
        let lines = { (text: String) in text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }
        let text = (result.ok ? lines(result.stdout).last : (lines(result.stderr).last ?? lines(result.stdout).last))
            ?? (result.ok ? "Done: \(command)" : "\(command) exited \(result.exitCode)")
        return text.hasPrefix("error: ") ? String(text.dropFirst(7)) : text
    }
}

// MARK: - What the panes hold

/// Before a §2.2 verb runs: what it is called, what it costs, and the exact
/// command. Never a bare *Are you sure?* — the button is the act's own verb.
public struct SettingsConfirmation: Identifiable, Equatable, Sendable {
    /// Which read the verb changes, re-done after it.
    public enum After: Sendable, Equatable {
        case doctor, deployment, identity, linked, versions, connections
    }

    public let id = UUID()
    public let title: String
    public let cost: String
    public let actionTitle: String
    public let command: ManagementCommand
    public let destructive: Bool
    public let after: After

    public init(title: String, cost: String, actionTitle: String, command: ManagementCommand, destructive: Bool = false, after: After) {
        self.title = title
        self.cost = cost
        self.actionTitle = actionTitle
        self.command = command
        self.destructive = destructive
        self.after = after
    }

    /// The command as a person would type it.
    public var said: String { (["metistry"] + command.arguments).joined(separator: " ") }
}

/// What the last verb said.
public struct SettingsOutcome: Equatable, Sendable {
    public let command: String
    public let ok: Bool
    /// The CLI's own last line (§3.16: never re-worded).
    public let words: String
    /// Everything it printed — the pane's View Log.
    public let lines: [String]
}

/// What a doctor action does from Settings ▸ Services.
public enum DoctorActionPlan: Equatable, Sendable {
    case openSection(SettingsModel.Section)
    case openSystemSettings
    case openLog(String)
    case confirm(SettingsConfirmation)
    /// Not a verb this app runs: shown, with Copy, for Terminal.
    case copyOnly(String)
}

/// One service, as Settings ▸ Services draws it.
public struct ServiceLine: Identifiable, Equatable, Sendable {
    public let name: String
    /// The shape it runs in, or `disabled`.
    public let plannedShape: String
    public let status: CheckStatus
    /// *up 3 h 12 min*, from doctor's `uptime_sec`, while it runs.
    public let uptime: String?
    /// Doctor's remediation, verbatim, when it does not.
    public let reason: String?
    /// Its port, when this instance has a namespace.
    public let port: Int?

    public var id: String { name }
    public var isDisabled: Bool { plannedShape == "disabled" }

    /// Which row speaks for a service: the worst.
    static func severity(_ status: CheckStatus) -> Int {
        switch status {
        case .ok: return 0
        case .absent: return 1
        case .degraded: return 2
        case .failed: return 3
        }
    }

    static func uptimeText(_ seconds: Int) -> String {
        let minutes = seconds / 60, hours = minutes / 60, days = hours / 24
        if days > 0 { return "up \(days) d \(hours % 24) h" }
        if hours > 0 { return "up \(hours) h \(minutes % 60) min" }
        if minutes > 0 { return "up \(minutes) min" }
        return "up \(seconds) s"
    }
}

/// The assistant's identity, as the editor holds it.
public struct IdentityDraft: Equatable, Sendable {
    public var name: String
    public var mention: String
    /// The file's `icon:` — a glyph.
    public var mark: String

    public init(name: String = "", mention: String = "", mark: String = "") {
        self.name = name
        self.mention = mention
        self.mark = mark
    }

    init(_ identity: InstanceIdentity?) {
        self.init(name: identity?.assistantName ?? "", mention: identity?.mention ?? "", mark: identity?.icon ?? "")
    }
}

/// A peer in `instances.yaml`, as `GET /api/instances` serves it.
public struct LinkedInstance: Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let origin: String
    public let lastSeen: Date?
    /// The coarse, deliberately uninformative vocabulary a console advertises.
    public let capabilities: [String]

    public init(id: String, name: String, origin: String, lastSeen: Date?, capabilities: [String]) {
        self.id = id
        self.name = name
        self.origin = origin
        self.lastSeen = lastSeen
        self.capabilities = capabilities
    }

    static func list(_ json: JSONValue) -> [LinkedInstance] {
        (json["instances"]?.arrayValue ?? []).compactMap { row in
            guard let id = row.string("instance_id"), let origin = row.string("origin") else { return nil }
            return LinkedInstance(
                id: id,
                name: row.string("name") ?? id,
                origin: origin,
                lastSeen: WireTime.date(row.string("last_seen")),
                capabilities: row["capabilities"]?.arrayValue?.compactMap(\.stringValue) ?? []
            )
        }
    }

    /// components-03 §2's stale state: *Not seen for 3 days*, once a peer has
    /// been silent a day or more. A closed laptop is not a departed instance,
    /// so this is a fact with Check Now and Remove beside it, not a verdict.
    public func notSeen(now: Date) -> String? {
        guard let lastSeen else { return "Never seen" }
        let days = Int(now.timeIntervalSince(lastSeen) / 86_400)
        guard days >= 1 else { return nil }
        return days == 1 ? "Not seen for 1 day" : "Not seen for \(days) days"
    }
}

/// Settings ▸ Keyboard's five: the any-app shortcuts (components-02 §2, C120).
/// Registering them is T6-16's; until it lands the switch is off and dimmed
/// with its reason, and nothing is registered (§2.18.2).
public enum AnyAppShortcut: String, CaseIterable, Sendable {
    case ask, note, todo, startRecording, stopRecording

    public var command: ShellCommand {
        switch self {
        case .ask: return .ask
        case .note: return .note
        case .todo: return .todo
        case .startRecording: return .startRecording
        case .stopRecording: return .stopRecording
        }
    }

    /// components-02 §2's suggestion.
    public var suggested: String {
        switch self {
        case .ask: return "⌃⌥⌘A"
        case .note: return "⌃⌥⌘N"
        case .todo: return "⌃⌥⌘T"
        case .startRecording: return "⌃⌥⌘R"
        case .stopRecording: return "⌃⌥⌘S"
        }
    }

    /// Why the switch is dimmed today.
    public static let notYet = "Not in this build yet: the recorder that checks each shortcut with macOS comes first, and nothing is registered until every row is clear."
}

/// Lines a verb prints as it runs, gathered off the main actor.
private final class LineCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var lines: [String] = []
    func append(_ line: String) { lock.withLock { lines.append(line) } }
    var all: [String] { lock.withLock { lines } }
}

// Set Up Remote Access — the guided flow (design-build-plan §2.23, X-107),
// one flow in two places: the wizard's **Remote Access** step (between
// Services and Door) and Settings ▸ Remote Access ▸ **Change…**. Its seven
// steps are the plan's: choose · get the tool · sign in · approve · expose ·
// check · Add a Phone. The app runs three verbs and nothing else:
//
//   remote status --json            the chooser's rows and the record (step 1)
//   remote set <p> [flags] --json   a PREVIEW: what detect found, what would
//                                   change, what a switch would undo and strand
//   remote set <p> [flags] --yes    steps 2–5, the CLI's own ceremony — the pack,
//          --json                   the node, the provider's sign-in page in the
//                                   browser, each approval page, the handler,
//                                   the public name, the wait for the origin to
//                                   answer, the protected write, the old
//                                   provider's revoke
//   remote test --json              step 6: *answers from this Mac*
//
// WHAT THE APP ADDS, AND WHAT IT NEVER ADDS. It shows where the CLI is from
// the lines the CLI prints as it goes (the sign-in link, each approval link,
// "Waiting for <name> to appear on the internet") — classified by
// `RemoteFlowProgress`, with every link offered to open again. It does not
// talk to a provider, write a record, or decide completion: `BackendState`
// reaching `Running` is the CLI's reading, not this file's. Step 6 is said as
// *answers from this Mac*, never as reaching the phone (§2.23); only Add a
// Phone's *Opened on your phone* says that, and **Add a Phone… is offered
// only once the check passes.**
//
// THE SWITCH CONFIRMS, NAMING THE COST. Choosing a provider while another is in
// place puts a `CostConfirmation` in front of `--yes`: the phones the change
// strands (the CLI's own sentence) and what the old provider's revoke would
// undo and leave for the owner — both read from the preview, never worded
// here. None preselected, and continuing with None satisfies the wizard's
// step: an install that exposes nothing is correct.

import Foundation
import Observation
import SwiftUI

// MARK: - The steps

/// The guided flow's seven steps (§2.23, "Set Up Remote Access").
public enum RemoteFlowStep: Int, CaseIterable, Identifiable, Sendable {
    case choose = 1
    case getTool
    case signIn
    case approve
    case expose
    case check
    case addPhone

    public var id: Int { rawValue }

    public var title: String {
        switch self {
        case .choose: return "Choose"
        case .getTool: return "Get the tool"
        case .signIn: return "Sign in"
        case .approve: return "Approve"
        case .expose: return "Expose"
        case .check: return "Check"
        case .addPhone: return "Add a Phone"
        }
    }
}

/// A link the CLI printed while it worked — the provider's sign-in page, an
/// approval page — with the line it came in.
public struct RemoteFlowLink: Sendable, Equatable, Identifiable {
    public let url: URL
    /// The CLI's line, without the URL: *sign in to Tailscale at*.
    public let label: String
    public let step: RemoteFlowStep

    public var id: String { url.absoluteString }

    public init(url: URL, label: String, step: RemoteFlowStep) {
        self.url = url
        self.label = label
        self.step = step
    }
}

/// Where the CLI is, read from what it prints. Best effort: a line this does
/// not recognise moves nothing, and the log is on screen regardless.
public enum RemoteFlowProgress {
    /// The step a line of the CLI's narration belongs to, if it names one.
    public static func step(of line: String) -> RemoteFlowStep? {
        // most specific first: an approval line carries a login.tailscale.com
        // link and the word "node"; a sign-in line carries "login"
        let l = line.lowercased()
        if l.contains("answers from this mac") { return .check }
        if l.contains("approve") { return .approve } // "approval" (NeedsMachineAuth) is still the sign-in
        if l.contains("sign in") || l.contains("signed in") || l.contains("login") { return .signIn }
        if l.contains("appear on the internet") || l.contains("to answer from this mac") || l.contains("resolves") || l.contains("handler") || l.contains("funnel") || l.contains("serve") { return .expose }
        if l.contains("pack") || l.contains("fetch") || l.contains("launchd job") || l.contains("node") { return .getTool }
        return nil
    }

    /// The first `https://` link in a line, and the line without it.
    public static func link(in line: String, step: RemoteFlowStep) -> RemoteFlowLink? {
        guard let range = line.range(of: #"https?://[^\s"'<>]+"#, options: .regularExpression), let url = URL(string: String(line[range])) else { return nil }
        var label = line
        label.removeSubrange(range)
        label = label.trimmingCharacters(in: CharacterSet(charactersIn: " :—-–").union(.whitespacesAndNewlines))
        return RemoteFlowLink(url: url, label: label.isEmpty ? url.absoluteString : label, step: step)
    }
}

// MARK: - The model

@MainActor
@Observable
public final class RemoteAccessFlowModel {
    public enum Phase: Equatable, Sendable {
        /// `remote status --json` is running.
        case loading
        /// Step 1 on screen.
        case choosing
        /// The chosen provider's preview is running (read-only on the CLI side).
        case previewing
        /// What would change, in the CLI's words; the one button.
        case previewed(RemoteSetResult)
        /// `remote set … --yes` is running: steps 2–5, the CLI's.
        case settingUp
        /// `remote test --json` is running.
        case checking
        /// Step 6's answer. `ok` offers Add a Phone….
        case checked(RemoteTestResult)
        /// The CLI refused or failed, in its own words; `problems` carries its doctor rows.
        case failed(String)
        /// No runtime, or a CLI older than the verb.
        case unavailable(String)
    }

    public private(set) var phase: Phase = .loading
    public private(set) var status: RemoteStatus?
    /// The chooser's rows, from the CLI; empty until read.
    public private(set) var choices: [RemoteChoice] = []
    /// The provider on screen. None preselected (§2.23 step 1).
    public var selected: String = "none" {
        didSet { if selected != oldValue { Task { await preview() } } }
    }
    /// Tailscale's mode: *Any browser (Funnel)*, the default, or *Only my devices*.
    public var mode: String = "funnel" {
        didSet { if mode != oldValue { Task { await preview() } } }
    }
    /// Tailscale: the owner's own app rather than the bundled node.
    public var useApp = false {
        didSet { if useApp != oldValue { Task { await preview() } } }
    }
    /// A pasted token for a provider that takes one. Held in memory for the
    /// one `set` it is written to, then cleared; never shown back, never in argv.
    public var token: String = ""
    /// The confirm before a switch. Presenting it runs nothing.
    public var confirmation: CostConfirmation?
    /// Where the CLI is while `set --yes` runs.
    public private(set) var progress: RemoteFlowStep = .getTool
    /// The links the CLI printed, newest last; each offered to open again.
    public private(set) var links: [RemoteFlowLink] = []
    /// Everything the CLI printed during the last run.
    public private(set) var lines: [OutputLine] = []
    /// After a failure: the doctor rows that are not ok, each with its sentence.
    public private(set) var problems: [DoctorRow] = []
    /// True once `remote set … --yes` wrote the record.
    public private(set) var applied = false
    /// The last verb, as a person would type it.
    public private(set) var lastCommand: String?

    @ObservationIgnored private var management: (any ManagementRunner)?
    /// The browser, handed in by the platform: `openURL` in the view.
    @ObservationIgnored public var onAddPhone: @MainActor () -> Void = {}
    /// Told once the record is written, so the pane and Devices re-read.
    @ObservationIgnored public var onApplied: @MainActor () -> Void = {}
    @ObservationIgnored private var running: Task<Void, Never>?
    /// Moves on every verb and cancel: a late answer from before is dropped.
    @ObservationIgnored private var generation = 0

    public init(management: (any ManagementRunner)?) {
        self.management = management
    }

    /// The pane's Change…: the current choice and mode preselected, so the
    /// flow opens on what is in force rather than on None.
    public func preselect(_ status: RemoteStatus?) {
        guard let status, status.available.contains(status.provider) else { return }
        self.status = status
        selected = status.provider
        if let mode = status.mode { self.mode = mode }
        useApp = status.settings["node_from"] == "app"
    }

    /// Re-point at another install's CLI (the wizard's runtime step changes it).
    public func adopt(management: (any ManagementRunner)?) {
        self.management = management
    }

    // MARK: Loading — step 1

    /// `metistry remote status --json`: the chooser and the record. A flow that
    /// already set its provider up stays where it got to — the wizard's Back
    /// and Continue re-enter the step without undoing what the screen said.
    public func load() async {
        if applied, case .checked = phase { return }
        generation += 1
        let current = generation
        guard let management, let command = ManagementCommand(.remoteAccess, ["remote", "status", "--json"]) else {
            phase = .unavailable(CLIReadError.noRuntime.localizedDescription ?? "no runtime")
            return
        }
        phase = .loading
        lastCommand = RemoteAccessWords.readCommand
        let result: CommandResult
        do {
            result = try await management.run(command) { _ in }
        } catch {
            guard current == generation else { return }
            phase = .unavailable(error.localizedDescription)
            return
        }
        guard current == generation else { return }
        if let read = RemoteStatus.parse(result.stdout) {
            status = read
            choices = read.choices
            phase = .choosing
            if selected != "none" { await preview() }
        } else if CLIDegradation.isUnknownVerb(result) {
            phase = .unavailable(CLIDegradation.message(verb: "remote"))
        } else {
            phase = .unavailable(SettingsModel.cliWords(result, command: RemoteAccessWords.readCommand))
        }
    }

    /// The chooser's row for the selection, when the CLI named it.
    public var selectedChoice: RemoteChoice? { choices.first { $0.id == selected } }
    /// *Tailscale*, as a person says it.
    public var selectedName: String { RemoteAccessWords.providerName(selected) }
    /// The provider in force before this flow changes anything.
    public var currentProvider: String { status?.provider ?? "none" }
    /// Whether choosing `selected` is a switch away from another provider — the case that confirms.
    public var isSwitch: Bool { currentProvider != "none" && currentProvider != selected }
    /// Whether the selection takes a pasted token (zrok, ngrok; cloudflare without its sign-in).
    public var needsToken: Bool { ["zrok", "ngrok"].contains(selected) }

    /// The wizard's step is satisfied by None — nothing to do — or by a
    /// provider that was set up here, or that the record already names
    /// (wizard-model.swift).
    public var satisfiesStep: Bool { selected == "none" || applied || (status?.provider == selected && selected != "none") }

    /// The `set` as it would run, for the card that shows it before it runs.
    public func plan(yes: Bool) -> RemoteSetPlan {
        var plan = RemoteSetPlan(provider: selected, yes: yes)
        if selected == "tailscale" {
            plan.mode = mode
            plan.useApp = useApp
        }
        let pasted = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if needsToken, !pasted.isEmpty { plan.token = pasted }
        return plan
    }

    // MARK: The preview

    /// `remote set <p> [flags] --json` without `--yes`: read-only on the CLI
    /// side (detect, and a dry revoke of the old provider). Runs on every
    /// change of choice, so the card under the chooser is always the current
    /// choice's.
    public func preview() async {
        switch phase {
        case .loading, .unavailable, .settingUp, .checking: return
        default: break
        }
        // the record naming the selection is what `applied` means; a re-read
        // of the same choice does not unsay it
        if status?.provider != selected { applied = false }
        problems = []
        links = []
        guard selected != "none" else {
            phase = .choosing
            return
        }
        guard let choice = selectedChoice, choice.available else {
            phase = .choosing
            return
        }
        generation += 1
        let current = generation
        guard let management else {
            phase = .unavailable(CLIReadError.noRuntime.localizedDescription ?? "no runtime")
            return
        }
        // the preview never carries the token: nothing is enabled or signed in by it
        var plan = self.plan(yes: false)
        plan.token = nil
        guard let command = plan.command else { return }
        phase = .previewing
        lastCommand = (["metistry"] + command.arguments).joined(separator: " ")
        let result: CommandResult
        do {
            result = try await management.run(command) { _ in }
        } catch {
            guard current == generation else { return }
            phase = .failed(error.localizedDescription)
            return
        }
        guard current == generation else { return }
        if let read = RemoteSetResult.parse(result.stdout) {
            phase = .previewed(read)
        } else if CLIDegradation.isUnknownVerb(result) {
            phase = .unavailable(CLIDegradation.message(verb: "remote set"))
        } else {
            phase = .failed(SettingsModel.cliWords(result, command: "metistry remote set \(selected)"))
        }
    }

    // MARK: Steps 2–5

    /// The one button. A switch away from a provider confirms first, naming
    /// the cost in the CLI's preview words; a first set-up runs — the preview
    /// on screen was the informed half, and the button says the act.
    public func setUp() {
        guard case .previewed(let preview) = phase else { return }
        if isSwitch {
            let name = RemoteAccessWords.providerName(currentProvider)
            var costs: [String] = []
            if let stranding = preview.stranding { costs.append(stranding) }
            costs += preview.revoked?.undone ?? []
            costs += (preview.revoked?.leftForOwner ?? []).map { RemoteAccessWords.leftForOwner(name, $0) }
            if costs.isEmpty { costs = [RemoteAccessWords.strandedFallback] }
            confirmation = CostConfirmation(
                title: RemoteAccessWords.switchTitle(selectedName),
                costHeading: RemoteAccessWords.switchHeading(from: name),
                costs: costs,
                confirm: RemoteAccessWords.switchTo(selectedName)
            )
            return
        }
        run()
    }

    /// Only `.confirm` runs. Cancel runs nothing and keeps the preview.
    public func choose(_ choice: CostConfirmView.Choice) {
        confirmation = nil
        guard choice == .confirm else { return }
        run()
    }

    /// `remote set <p> [flags] --yes --json`, streamed: the CLI's steps 2–5 and
    /// its switching ceremony. Cancelling ends the process.
    private func run() {
        guard let management, let command = plan(yes: true).command?.terminatingOnCancel() else { return }
        generation += 1
        let current = generation
        phase = .settingUp
        progress = .getTool
        links = []
        lines = []
        problems = []
        lastCommand = (["metistry"] + command.arguments).joined(separator: " ")
        token = "" // written to the one process's stdin; held no longer
        let sink = OutputSink()
        // the model is held for the run: `cancel()` ends the process, and a
        // late answer is dropped by the generation check
        let model = self
        running = Task {
            let result: CommandResult
            do {
                result = try await management.run(command) { line in
                    sink.append(line)
                    Task { @MainActor in
                        guard model.generation == current else { return }
                        model.absorb(line)
                    }
                }
            } catch {
                guard self.generation == current else { return }
                self.lines = sink.drain()
                self.phase = .failed(error.localizedDescription)
                return
            }
            guard self.generation == current else { return }
            self.lines = sink.drain()
            if result.ok, let read = RemoteSetResult.parse(result.stdout), read.applied {
                self.applied = true
                self.onApplied()
                await self.check()
            } else if result.ok, RemoteSetResult.parse(result.stdout) != nil {
                // exit 0 and not applied: the CLI previewed (a `--yes` it did not take)
                self.phase = .failed(SettingsModel.cliWords(result, command: "metistry remote set \(self.selected)"))
            } else if CLIDegradation.isUnknownVerb(result) {
                self.phase = .unavailable(CLIDegradation.message(verb: "remote set"))
            } else {
                // the doctor rows first, so the failure lands with its sentence beside it
                await self.readProblems()
                guard self.generation == current else { return }
                self.phase = .failed(SettingsModel.cliWords(result, command: "metistry remote set \(self.selected)"))
            }
        }
    }

    /// One line of the CLI's narration: where it is, and any link it printed.
    func absorb(_ line: OutputLine) {
        lines.append(line)
        guard let step = RemoteFlowProgress.step(of: line.text) else { return }
        if step.rawValue > progress.rawValue || step == .signIn || step == .approve { progress = step }
        // the pages the owner has to open: the provider's sign-in, each approval — not every address the CLI mentions
        guard step == .signIn || step == .approve else { return }
        if let link = RemoteFlowProgress.link(in: line.text, step: step), !links.contains(where: { $0.url == link.url }) {
            links.append(link)
        }
    }

    // MARK: Step 6

    /// `remote test --json`: the provider's own status, then `GET
    /// <origin>/health` from this Mac — *answers from this Mac*.
    public func check() async {
        guard let management, let command = ManagementCommand(.remoteAccess, ["remote", "test", "--json"]) else { return }
        generation += 1
        let current = generation
        phase = .checking
        progress = .check
        lastCommand = RemoteAccessWords.testCommand
        let result: CommandResult
        do {
            result = try await management.run(command) { _ in }
        } catch {
            guard current == generation else { return }
            phase = .failed(error.localizedDescription)
            return
        }
        guard current == generation else { return }
        if let read = RemoteTestResult.parse(result.stdout) {
            problems = read.problems
            phase = .checked(read)
            if read.ok { progress = .addPhone }
        } else if CLIDegradation.isUnknownVerb(result) {
            phase = .unavailable(CLIDegradation.message(verb: "remote test"))
        } else {
            phase = .failed(SettingsModel.cliWords(result, command: RemoteAccessWords.testCommand))
        }
    }

    /// After a failed `set`: the doctor rows, so the failure shows its doctor
    /// sentence beside the CLI's last line.
    private func readProblems() async {
        guard let management, let command = ManagementCommand(.remoteAccess, ["remote", "status", "--json"]) else { return }
        let current = generation
        guard let result = try? await management.run(command, onOutput: { _ in }), current == generation, let read = RemoteStatus.parse(result.stdout) else { return }
        problems = read.rows.filter { $0.status != .ok }
    }

    /// Step 7 is offered only once step 6 passed.
    public var canAddPhone: Bool {
        if case .checked(let read) = phase { return read.ok }
        return false
    }

    public func addPhone() {
        guard canAddPhone else { return }
        onAddPhone()
    }

    /// The whole run, over again from the chooser.
    public func startOver() {
        cancel()
        phase = .choosing
        Task { await preview() }
    }

    /// Ends a running verb; a late answer is dropped.
    public func cancel() {
        generation += 1
        running?.cancel()
        running = nil
        confirmation = nil
        if phase == .settingUp || phase == .checking || phase == .previewing {
            phase = .choosing
        }
    }

    /// Whether a verb is running.
    public var isBusy: Bool {
        switch phase {
        case .loading, .previewing, .settingUp, .checking: return true
        default: return false
        }
    }
}

// MARK: - The view

/// The flow, drawn once: the wizard's step and the pane's Change… sheet both
/// present this over a `RemoteAccessFlowModel`.
public struct RemoteAccessFlowView: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.openURL) private var openURL

    private let model: RemoteAccessFlowModel
    /// Whether this is the pane's sheet (None is Turn Off's, below) or the wizard's step.
    private let inSettings: Bool

    public init(model: RemoteAccessFlowModel, inSettings: Bool = false) {
        self.model = model
        self.inSettings = inSettings
    }

    public var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s4) {
            stepsLine(p)
            switch model.phase {
            case .loading:
                HStack(spacing: MetistrySpace.s2) {
                    ProgressView().controlSize(.small)
                    Text("Reading how this Mac is reached…").metistryText(.callout, p, .textSecondary)
                }
                .accessibilityElement(children: .combine)
            case .unavailable(let why):
                UnavailableCard(what: "Could not read remote access", reason: why, command: RemoteAccessWords.readCommand)
            case .choosing, .previewing, .previewed, .failed:
                chooser(p)
                preview(p)
            case .settingUp:
                chooser(p)
                settingUp(p)
            case .checking:
                HStack(spacing: MetistrySpace.s2) {
                    ProgressView().controlSize(.small)
                    Text("Checking that \(model.status?.origin ?? model.selectedName) \(RemoteAccessWords.answersFromThisMac)…").metistryText(.callout, p, .textSecondary)
                }
                .accessibilityElement(children: .combine)
                .metistryCard(p)
            case .checked(let read):
                checked(read, p)
            }
            if let command = model.lastCommand {
                Text(command)
                    .metistryText(.caption1, p, .textTertiary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !model.lines.isEmpty, model.phase != .settingUp {
                OutputLogView(lines: model.lines)
            }
        }
    }

    // MARK: The seven steps

    private func stepsLine(_ p: Palette) -> some View {
        HStack(spacing: MetistrySpace.s2) {
            ForEach(RemoteFlowStep.allCases) { step in
                HStack(spacing: MetistrySpace.s1) {
                    Circle().fill(p[dot(step)]).frame(width: 6, height: 6).accessibilityHidden(true)
                    Text(step.title).metistryText(.caption2, p, step == current ? .textPrimary : .textTertiary)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Step \(step.rawValue), \(step.title)\(step == current ? ", current" : "")")
            }
        }
    }

    /// The step the flow is on.
    private var current: RemoteFlowStep {
        switch model.phase {
        case .loading, .choosing, .previewing, .previewed, .unavailable, .failed: return .choose
        case .settingUp: return model.progress
        case .checking: return .check
        case .checked(let read): return read.ok ? .addPhone : .check
        }
    }

    private func dot(_ step: RemoteFlowStep) -> MetistryColorRole {
        if step == current { return .accent }
        if step.rawValue < current.rawValue { return .ok }
        if case .failed = model.phase, step == .getTool { return .failed }
        return .border
    }

    // MARK: Step 1

    private func chooser(_ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s3) {
            Text(RemoteAccessWords.question).metistryText(.headline, p)
            VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                ForEach(model.choices) { choice in
                    ChoiceRow(
                        title: choice.label + (choice.isRecommended ? " — \(RemoteAccessWords.recommended)" : ""),
                        detail: choice.available ? choice.detail : "\(RemoteAccessWords.notYetAvailable) · \(choice.detail)",
                        selected: model.selected == choice.id,
                        enabled: choice.available && !model.isBusy
                    ) { model.selected = choice.id }
                    if choice.id == "tailscale", model.selected == "tailscale" {
                        tailscaleOptions(p)
                    }
                }
            }
            if model.selected == "none" {
                Text(inSettings && model.currentProvider != "none" ? RemoteAccessWords.turnOffNote : RemoteAccessWords.continueWithNone)
                    .metistryText(.caption1, p, .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .metistryCard(p)
    }

    private func tailscaleOptions(_ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            Picker("Mode", selection: Binding(get: { model.mode }, set: { model.mode = $0 })) {
                Text("Any browser (Funnel)").tag("funnel")
                Text("Only my devices (tailnet)").tag("tailnet")
            }
            .pickerStyle(.radioGroup)
            .disabled(model.isBusy)
            Text(model.mode == "funnel"
                ? "Your phone opens the address in Safari with no app. Tailscale's relays carry only ciphertext; TLS ends on this Mac."
                : "Only devices signed in to your Tailscale account reach it — the phone needs the Tailscale app. Nothing is on the internet.")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
            Toggle("Use the Tailscale app already on this Mac", isOn: Binding(get: { model.useApp }, set: { model.useApp = $0 }))
                .disabled(model.isBusy)
            Text("Off: Metistry brings its own node (the bundled tailscaled, named metistry-<instance>, its state private to this instance). On: your app's own node, driven through its command line.")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.leading, MetistrySpace.s5)
    }

    // MARK: The preview and the one button

    @ViewBuilder
    private func preview(_ p: Palette) -> some View {
        if model.selected != "none" {
            VStack(alignment: .leading, spacing: MetistrySpace.s3) {
                switch model.phase {
                case .previewing:
                    HStack(spacing: MetistrySpace.s2) {
                        ProgressView().controlSize(.small)
                        Text("Looking at what \(model.selectedName) would change…").metistryText(.footnote, p, .textSecondary)
                    }
                    .accessibilityElement(children: .combine)
                case .previewed(let read):
                    previewFacts(read, p)
                case .failed(let why):
                    UnavailableCard(what: "\(model.selectedName) could not be set up", reason: why, command: model.lastCommand)
                    ForEach(model.problems) { row in
                        DoctorRowView(row: row)
                    }
                default:
                    EmptyView()
                }
                if model.needsToken {
                    tokenField(p)
                }
                HStack(spacing: MetistrySpace.s3) {
                    Button(model.isSwitch ? RemoteAccessWords.switchTo(model.selectedName) : RemoteAccessWords.setUp(model.selectedName)) { model.setUp() }
                        .buttonStyle(.borderedProminent)
                        .disabled(!canSetUp)
                    if case .failed = model.phase {
                        Button("Look Again") { Task { await model.preview() } }
                    }
                }
                CommandCard(title: "Runs", argument: ["metistry"] + model.plan(yes: true).arguments)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .metistryCard(p)
        }
    }

    private var canSetUp: Bool {
        guard case .previewed = model.phase else { return false }
        if model.needsToken, model.token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return false }
        return true
    }

    private func previewFacts(_ read: RemoteSetResult, _ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            let tool = read.detection.tool
            FactRow("Tool", tool.present ? "here\(tool.version.map { " (\($0)\(tool.from == "pack" ? ", Metistry's pack" : tool.from == "owner" ? ", your own install" : ""))" } ?? "")" : "not here — set-up fetches it", role: tool.present ? .textPrimary : .absent)
            if let signedIn = read.detection.signedIn {
                FactRow("Signed in", signedIn ? "yes" : "not yet — the provider's own page opens in your browser", role: signedIn ? .textPrimary : .absent)
            }
            if let origin = read.detection.origin ?? read.origin {
                FactRow("Address", origin, mono: true)
            }
            if !read.detection.wouldChange.isEmpty {
                Text("Set-up would:").metistryText(.caption2, p, .textSecondary)
                ForEach(Array(read.detection.wouldChange.enumerated()), id: \.offset) { _, line in
                    Text("· \(line)")
                        .metistryText(.footnote, p, .textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if let stranding = read.stranding {
                Text(stranding)
                    .metistryText(.footnote, p, .degraded)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let revoked = read.revoked, !revoked.undone.isEmpty || !revoked.leftForOwner.isEmpty {
                Text("Then, at \(RemoteAccessWords.providerName(model.currentProvider)):").metistryText(.caption2, p, .textSecondary)
                ForEach(Array((revoked.undone + revoked.leftForOwner.map { RemoteAccessWords.leftForOwner(RemoteAccessWords.providerName(model.currentProvider), $0) }).enumerated()), id: \.offset) { _, line in
                    Text("· \(line)")
                        .metistryText(.footnote, p, .textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func tokenField(_ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            Text("Account token").metistryText(.caption2, p, .textSecondary)
            SecureField("paste the token from \(model.selectedName)'s dashboard", text: Binding(get: { model.token }, set: { model.token = $0 }))
                .textFieldStyle(.roundedBorder)
            Text("Goes to the CLI's standard input for the one command below and nowhere else — never on the command line, never kept by this app.")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: Steps 2–5, running

    private func settingUp(_ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s3) {
            HStack(spacing: MetistrySpace.s2) {
                ProgressView().controlSize(.small)
                Text("\(model.progress.rawValue). \(model.progress.title) — \(progressSentence)")
                    .metistryText(.callout, p)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)
            ForEach(model.links) { link in
                VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                    Text(link.label).metistryText(.footnote, p, .textSecondary).fixedSize(horizontal: false, vertical: true)
                    Button {
                        openURL(link.url)
                    } label: {
                        Label(link.url.absoluteString, systemImage: "arrow.up.forward.square")
                    }
                    .accessibilityLabel("Open \(link.label): \(link.url.absoluteString)")
                }
            }
            if !model.links.isEmpty {
                Text("Metistry opened it in your browser and is waiting. If it did not open, the link above does.")
                    .metistryText(.caption1, p, .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button(RemoteAccessWords.cancel) { model.cancel() }
            OutputLogView(lines: model.lines)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .metistryCard(p)
    }

    private var progressSentence: String {
        switch model.progress {
        case .choose: return ""
        case .getTool: return "fetching \(model.selectedName)'s tool, if it is not here, and starting it"
        case .signIn: return "\(model.selectedName)'s own sign-in page is open in your browser; this finishes by itself once you are signed in"
        case .approve: return "\(model.selectedName) asks a one-time question of its own — one click on the page it opened"
        case .expose: return "pointing \(model.selectedName) at this Mac and waiting for the address to answer from here"
        case .check, .addPhone: return RemoteAccessWords.answersFromThisMac
        }
    }

    // MARK: Step 6 and 7

    private func checked(_ read: RemoteTestResult, _ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s3) {
            HStack(spacing: MetistrySpace.s2) {
                StatusDot(read.ok ? .ok : .failed)
                Text(read.ok ? "\(read.origin ?? model.selectedName) \(RemoteAccessWords.answersFromThisMac)" : "\(model.selectedName) is set up, but the check did not pass")
                    .metistryText(.headline, p)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text(RemoteAccessWords.checkNote)
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(read.ok ? read.rows : read.problems) { row in
                DoctorRowView(row: row)
            }
            if model.selected == "tailscale", model.mode == "tailnet" {
                Text("Your phone must be signed in to the same Tailscale account.")
                    .metistryText(.footnote, p, .textSecondary)
            }
            HStack(spacing: MetistrySpace.s3) {
                if read.ok {
                    Button(AddPhoneWords.addAPhone) { model.addPhone() }
                        .buttonStyle(.borderedProminent)
                }
                Button(RemoteAccessWords.test) { Task { await model.check() } }
                Button("Start Over") { model.startOver() }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .metistryCard(p)
    }
}

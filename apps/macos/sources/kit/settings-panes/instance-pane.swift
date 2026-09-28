// Settings ▸ Instance (screen-15 §5.1): the assistant, this instance, the
// recents, the vault's History (T10-7, below), and the instances this one is
// linked to.
//
// The assistant is named in identity.yaml and nowhere else, and that file is a
// protected path: Edit… changes it only through `metistry identity set` (M10,
// T2-16) — confirmed with the exact command, written as the owner through the
// reconciler, and shown in Activity as a `config_write` run. The pane holds no
// copy of the name; it reads `metistry identity --json` again after the write.
//
// Linked instances are read over the API (`GET /api/instances`) and changed
// only by `metistry instances add|remove|refresh` (M11): a trust relationship
// with another origin is a management verb, never a route (invariant 10).

import SwiftUI
import UniformTypeIdentifiers

struct InstancePane: View {
    @Environment(\.colorScheme) private var scheme
    let model: AppModel
    let actions: SettingsActions

    @State private var pickingInstance = false

    private var settings: SettingsModel { model.settings }

    var body: some View {
        let p = Palette(scheme)
        assistant(p)
        thisInstance(p)
        recents(p)
        // The vault's git: sync, and Roll Back… (T10-7). It renders a model
        // rather than holding one.
        InstanceHistorySection(model: model.vaultHistory, assistantName: model.shell.assistantName)
        linkedInstances(p)
    }

    // MARK: The assistant

    @ViewBuilder
    private func assistant(_ p: Palette) -> some View {
        SettingsSection("Assistant") {
            if case .unavailable(let why) = settings.identityPhase {
                UnavailableCard(what: "Could not read the identity", reason: why, command: settings.identityCommand)
            } else if settings.identityPhase == .reading {
                Text("Reading `metistry identity --json`…").metistryText(.footnote, p, .textSecondary)
            } else {
                FactRow("Name", settings.assistantNameDisplay, mono: true)
                FactRow("Mention", settings.identity?.mention ?? "not set", mono: true, role: settings.identity?.mention == nil ? .absent : .textPrimary)
                FactRow("Mark", settings.identity?.icon ?? "not set", role: settings.identity?.icon == nil ? .absent : .textPrimary)
                FactRow(
                    "Instance ID",
                    settings.identity?.instanceID ?? "not reported",
                    help: SettingsModel.instanceIdNote,
                    mono: true,
                    role: settings.identity?.instanceID == nil ? .absent : .textPrimary
                )
                Button("Edit…") { settings.beginIdentityEdit() }
                    .disabled(settings.identity == nil || settings.management == nil)
                    .accessibilityLabel("Edit the name, mention and mark")
            }
            Text("identity.yaml is a protected file. Edit… changes it with `metistry identity set` — written as you through the reconciler, and shown in Activity.")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .task(id: model.instances.active) { await settings.refreshIdentity() }
    }

    // MARK: This instance

    @ViewBuilder
    private func thisInstance(_ p: Palette) -> some View {
        SettingsSection("This Instance") {
            Text(model.instances.active?.path ?? "None chosen")
                .metistryText(.mono, p, model.instances.active == nil ? .textTertiary : .textPrimary)
                .lineLimit(2)
                .truncationMode(.head)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            SettingsControls {
                Button("Choose…") { pickingInstance = true }
                    .accessibilityLabel("Choose an instance folder")
                if let active = model.instances.active {
                    Button("Open in Finder") { actions.openInFinder(active) }
                }
                Button("Set Up Again…", action: actions.setUpAgain)
            }
            if let namespace = settings.deployment?.namespace {
                FactRow("Namespace", namespace.labelSuffix, help: "Its own launchd labels and ports (state/ports.yaml), so it runs beside another instance on this Mac.", mono: true)
                FactRow("Ports", SettingsWords.ports(namespace), mono: true)
            } else if settings.deployment != nil {
                FactRow("Namespace", "none — the default labels and ports", role: .textSecondary)
            }
            Text("Every `metistry` verb the app runs is given METISTRY_INSTANCE_DIR=<this path>, so this is the one place that decides which install the app is talking to. Set Up Again… runs the first-launch steps over; nothing happens until you press Run on a step.")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .fileImporter(isPresented: $pickingInstance, allowedContentTypes: [.folder]) { result in
            if case .success(let url) = result { model.activateInstance(url) }
        }
    }

    // MARK: Recent

    @ViewBuilder
    private func recents(_ p: Palette) -> some View {
        if !model.instances.recents.isEmpty {
            SettingsSection("Recent") {
                ForEach(model.instances.recents, id: \.path) { url in
                    let active = url.path == model.instances.active?.path
                    HStack(spacing: MetistrySpace.s2) {
                        Image(systemName: active ? "checkmark.circle.fill" : "folder")
                            .foregroundStyle(p[active ? .ok : .textTertiary])
                            .accessibilityHidden(true)
                        Button(url.path) { model.activateInstance(url) }
                            .buttonStyle(.plain)
                            .metistryText(.footnote, p, .textPrimary)
                            .lineLimit(1)
                            .truncationMode(.head)
                            .accessibilityLabel(active ? "\(url.path), active" : "Switch to \(url.path)")
                        Spacer(minLength: MetistrySpace.s2)
                        Button("Forget") { model.forgetInstance(url) }
                            .accessibilityLabel("Forget \(url.lastPathComponent)")
                    }
                }
            }
        }
    }

    // MARK: Linked instances

    @ViewBuilder
    private func linkedInstances(_ p: Palette) -> some View {
        SettingsSection("Linked Instances") {
            if case .unavailable(let why) = settings.linkedPhase {
                UnavailableCard(what: "Could not read the linked instances", reason: why)
            } else if settings.linkedPhase == .read, settings.linked.isEmpty {
                Text("No instances linked. Linking one lets this instance know who it is and what it offers.")
                    .metistryText(.footnote, p, .textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(settings.linked) { instance in
                LinkedInstanceRow(instance: instance, now: Date(), settings: settings)
            }
            SettingsControls {
                Button("Link an Instance…") { settings.beginLink() }
                Button("Refresh") { Task { await settings.refreshLinkedOrigins() } }
                    .accessibilityLabel("Refresh linked instances")
            }
            .disabled(settings.management == nil || settings.running != nil)
            Text("From instances.yaml, a protected file. Link, Refresh and Remove are `metistry instances add|refresh|remove`; Refresh re-asks every origin who it is and leaves an unreachable one as it was.")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .task(id: model.instances.active) { await settings.refreshLinked() }
    }
}

struct LinkedInstanceRow: View {
    @Environment(\.colorScheme) private var scheme
    let instance: LinkedInstance
    let now: Date
    let settings: SettingsModel

    var body: some View {
        let p = Palette(scheme)
        let stale = instance.notSeen(now: now)
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            Text(instance.name).metistryText(.headline, p)
            Text(instance.origin)
                .metistryText(.mono, p, .textSecondary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            if !instance.capabilities.isEmpty {
                Text(instance.capabilities.joined(separator: " · "))
                    .metistryText(.caption1, p, .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text(stale ?? instance.lastSeen.map { "Last seen \($0.formatted(date: .abbreviated, time: .shortened))" } ?? "")
                .metistryText(.caption1, p, stale == nil ? .textTertiary : .stale)
            SettingsControls {
                if stale != nil {
                    Button("Check Now") { Task { await settings.refreshLinkedOrigins() } }
                        .accessibilityLabel("Check \(instance.name) now")
                }
                Button("Remove") { settings.proposeRemove(instance) }
                    .accessibilityLabel("Remove \(instance.name)")
            }
            .disabled(settings.management == nil || settings.running != nil)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Words the panes share.
enum SettingsWords {
    /// `console 18080 · db 18081 …`, in a stable order.
    static func ports(_ namespace: DeploymentNamespace) -> String {
        namespace.ports.sorted { $0.key < $1.key }.map { "\($0.key) \($0.value)" }.joined(separator: " · ")
    }
}

// MARK: - History

// Settings ▸ Instance ▸ History (design-build-plan T10-7, §2.21).
//
// Where the vault's git stands, read from `GET /api/vault/status` (T10-2):
// the sync policy in force, ahead and behind, the last commit, the last push
// and pull, and any conflict holding the sync — and **Roll Back…**, which
// asks in Needs You and changes nothing until Approve there (T10-6). The
// model is vault-history-model.swift; this file only draws it.
//
// NOT ON THE PHONE, NOT FROM A REMOTE CLIENT (ruling 7). Roll Back is reach
// `local`: it is drawn only while the console says this client is the local
// owner token, and otherwise the section says where it happens instead.
//
// ACCESSIBILITY (§2.18). Each fact is one spoken element — its label and its
// value, ahead and behind in words rather than arrows; the section's title
// is a heading; every control is a named Button; nothing moves; no key is
// bound. The pane scrolls, so the largest text makes it longer, never wider.

/// The History section of Settings ▸ Instance.
public struct InstanceHistorySection: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: VaultHistoryModel
    let assistantName: String?

    public init(model: VaultHistoryModel, assistantName: String?) {
        self.model = model
        self.assistantName = assistantName
    }

    public var body: some View {
        let p = Palette(scheme)
        SettingsSection(VaultHistoryWords.history) {
            switch (model.status.section.value, model.status.section.problem) {
            case (let sync?, _):
                facts(sync, p)
                if let problem = model.status.section.problem {
                    FactNote(FactNoteModel("Showing what was last read: \(problem)"))
                }
            case (nil, let problem?):
                UnavailableCard(what: "Could not read the vault's sync", reason: problem)
            case (nil, nil):
                Text("reading `GET /api/vault/status`…").metistryText(.footnote, p, .textSecondary)
            }
            Text(VaultHistoryWords.policyNote)
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
            rollBack(p)
        }
        .accessibilityElement(children: .contain)
        .task(id: model.status.section.hasValue) { await model.refreshIfDue() }
        .sheet(isPresented: Binding(get: { model.rollbackOpen }, set: { if !$0 { model.closeRollback() } })) {
            RollbackSheet(model: model, assistantName: assistantName)
        }
    }

    @ViewBuilder
    private func facts(_ sync: VaultSyncRead, _ p: Palette) -> some View {
        HistoryFact("Push", sync.push + (sync.pushOverride.map { " (METISTRY_PUSH_SCHEDULE overrides it: \($0))" } ?? ""))
        HistoryFact("Pull", sync.pull)
        if let error = sync.policyError {
            HistoryFact("Policy", "deployment.yaml's vault: block does not read — the last good policy keeps running: \(error)", role: .degraded)
        }
        HistoryFact("Branch", sync.branch ?? "not reported", mono: true)
        HistoryFact("Ahead and behind", sync.aheadBehind, spoken: sync.aheadBehindSpoken, role: sync.remote == nil ? .textSecondary : .textPrimary)
        if let c = sync.lastCommit {
            let who = VaultWho.name(source: c.author, author: nil, assistantName: assistantName).map { " · by \($0)" } ?? ""
            let when = c.at.map { " · \(model.clock.moment($0, now: model.now()))" } ?? ""
            HistoryFact("Last commit", "\(c.short) \(c.subject)\(who)\(when)")
        } else {
            HistoryFact("Last commit", "none reported", role: .textSecondary)
        }
        HistoryFact("Last push", sync.pushLine(clock: model.clock, now: model.now()), role: sync.lastPushFailed ? .failed : .textPrimary)
        HistoryFact("Last pull", sync.pullLine(clock: model.clock, now: model.now()), role: sync.lastPull?.ok == false ? .failed : .textPrimary)
        if let paths = sync.conflict {
            HistoryFact("Conflict", paths.isEmpty ? "The sync is stopped by a conflict." : "The sync is stopped: \(paths.joined(separator: ", "))", role: .degraded)
            Text(VaultHistoryWords.conflictNote)
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            HistoryFact("Conflict", VaultHistoryWords.noConflict)
        }
    }

    @ViewBuilder
    private func rollBack(_ p: Palette) -> some View {
        switch model.reach {
        case .local:
            HStack(spacing: MetistrySpace.s3) {
                Button(VaultHistoryWords.rollBack) { model.openRollback() }
                    .disabled(!model.allowsDecisions)
                Button("Read Again") { Task { await model.refresh() } }
            }
            if !model.allowsDecisions, let why = model.decisionsUnavailableReason {
                FactNote(FactNoteModel(why))
            }
            Text(VaultHistoryWords.rollbackNote)
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        case .remote:
            Button("Read Again") { Task { await model.refresh() } }
            FactNote(FactNoteModel(VaultHistoryWords.onlyTheMac))
        case .unknown:
            Button("Read Again") { Task { await model.refresh() } }
        }
    }
}

/// A label and its value, spoken as one.
struct HistoryFact: View {
    let label: String
    let value: String
    let spoken: String?
    let mono: Bool
    let role: MetistryColorRole

    init(_ label: String, _ value: String, spoken: String? = nil, mono: Bool = false, role: MetistryColorRole = .textPrimary) {
        self.label = label
        self.value = value
        self.spoken = spoken
        self.mono = mono
        self.role = role
    }

    var body: some View {
        FactRow(label, value, mono: mono, role: role)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(verbatim: "\(label), \(spoken ?? value)"))
    }
}

/// Roll Back…: choose what, then ask. The answer names what Approve would undo.
struct RollbackSheet: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: VaultHistoryModel
    let assistantName: String?

    var body: some View {
        let p = Palette(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: MetistrySpace.s4) {
                Text("Roll Back").metistryText(.title3, p).accessibilityAddTraits(.isHeader)
                switch model.rollback {
                case .raised(let preview):
                    raised(preview, p)
                default:
                    choose(p)
                }
            }
            .padding(MetistrySpace.s5)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(width: 520)
        .frame(minHeight: 360)
        .background(p[.bg])
    }

    @ViewBuilder
    private func choose(_ p: Palette) -> some View {
        #if os(macOS)
        Picker("What to roll back", selection: $model.choice) {
            ForEach(RollbackChoice.allCases) { Text($0.title).tag($0) }
        }
        .pickerStyle(.radioGroup)
        #else
        Picker("What to roll back", selection: $model.choice) {
            ForEach(RollbackChoice.allCases) { Text($0.title).tag($0) }
        }
        #endif
        switch model.choice {
        case .lastCommit:
            EmptyView()
        case .commit:
            TextField("Commit id", text: $model.commitText, prompt: Text("9ab8c7d"))
                .textFieldStyle(.roundedBorder)
                .font(.system(.body, design: .monospaced))
        case .day:
            DatePicker("Day", selection: $model.day, in: ...model.now(), displayedComponents: .date)
        }
        Text(model.targetLine(assistantName: assistantName))
            .metistryText(.callout, p)
            .fixedSize(horizontal: false, vertical: true)
        if let problem = model.targetProblem {
            Text(problem).metistryText(.caption1, p, .textSecondary).fixedSize(horizontal: false, vertical: true)
        }
        if case .refused(let why) = model.rollback {
            UnavailableCard(what: "Not asked", reason: why)
        }
        Text(VaultHistoryWords.rollbackNote)
            .metistryText(.caption1, p, .textTertiary)
            .fixedSize(horizontal: false, vertical: true)
        HStack(spacing: MetistrySpace.s3) {
            Spacer(minLength: 0)
            Button("Cancel") { model.closeRollback() }
            Button(VaultHistoryWords.askToRollBack) { Task { await model.requestRollback() } }
                .disabled(model.target == nil || model.rollback == .sending || !model.allowsDecisions)
            if model.rollback == .sending { ProgressView().controlSize(.small) }
        }
    }

    @ViewBuilder
    private func raised(_ preview: RollbackPreview, _ p: Palette) -> some View {
        if let title = preview.title {
            Text(title).metistryText(.headline, p).fixedSize(horizontal: false, vertical: true)
        }
        Text(preview.raised ? VaultHistoryWords.waitingInNeedsYou : VaultHistoryWords.alreadyWaiting)
            .metistryText(.callout, p)
            .fixedSize(horizontal: false, vertical: true)
        Text(preview.summary).metistryText(.callout, p).fixedSize(horizontal: false, vertical: true)
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            Text("What Approve Undoes").metistryText(.subhead, p).accessibilityAddTraits(.isHeader)
            ForEach(preview.commitLines(assistantName: assistantName, clock: model.clock), id: \.self) { line in
                Text(line).metistryText(.mono, p).fixedSize(horizontal: false, vertical: true)
            }
        }
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            Text("What Goes Back").metistryText(.subhead, p).accessibilityAddTraits(.isHeader)
            ForEach(preview.files, id: \.self) { file in
                Text(file).metistryText(.mono, p).fixedSize(horizontal: false, vertical: true)
            }
            if let base = preview.base {
                Text("As of \(base.short) “\(base.subject)”\(base.at.map { ", \(model.clock.day($0))" } ?? "")")
                    .metistryText(.caption1, p, .textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        if !preview.skippedConfig.isEmpty {
            Text("Left as they are (configuration): \(preview.skippedConfig.joined(separator: ", "))")
                .metistryText(.caption1, p, .textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        HStack {
            Spacer(minLength: 0)
            Button("Done") { model.closeRollback() }
        }
    }
}

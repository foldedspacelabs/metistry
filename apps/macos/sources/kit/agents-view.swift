// Agents — the roster and New Agent (design-build-plan T6-5; screen-07-agents.md
// §2, §6, §7; C52, C138). One agent's page is agent-detail-view.swift; what
// both draw from is agents-model.swift.
//
// THREE THINGS PER ROW: who it is, what it is, whether it is working (§2).
// Scope and spend are detail information and stay there. Presence is two
// filled dots, a hollow one with no word, and `degraded` only for the two
// states that are wrong (§2.1). Yours and Connected are two groups because
// they differ in what you can do to them; revoked credentials are a third,
// collapsed, and `absent` — a fact about the past, never `failed` (§2.2).
// The assistant is never listed (C52).
//
// NEW AGENT ASKS THE KIND FIRST (C138): a local agent, another agent service
// connected as a connection, or a tool that gets a token. Each leads somewhere;
// on a client that is not the Mac running Metistry each is dimmed with why.
//
// THE KEYS ARE THE MENU'S (§2.18.1, C119). ↑↓ are the list's own; ↩ is Item ▸
// Open for the selected row; Esc goes back (`onExitCommand`, not a shortcut).
// Screen 7 §7 also names ⌘S and ⌘⌫, and neither is in the closed menu table
// (shell-commands.swift) — so, as ruled for Activity's keys at the W2
// checkpoint, they are not bound; Save and Revoke are focusable controls.
//
// ACCESSIBILITY (§2.18). A row is one element that says its whole sentence;
// every glyph-only control speaks its name; each section is a heading; the
// text is semantic styles only, so the largest size makes rows longer, never
// wider. Nothing on this screen moves, so Reduce Motion has nothing to stop.

import SwiftUI

public struct AgentsView: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: AgentsModel
    let assistantName: String?
    /// *Give It One* and a routine's row: Scheduled, where routines are set.
    let onGoToScheduled: (() -> Void)?
    /// Connect an Agent: Settings › Connections (M13).
    let onOpenConnections: (() -> Void)?
    let tick: Duration

    public init(model: AgentsModel, assistantName: String?, tick: Duration = .seconds(5), onGoToScheduled: (() -> Void)? = nil, onOpenConnections: (() -> Void)? = nil) {
        self.model = model
        self.assistantName = assistantName
        self.onGoToScheduled = onGoToScheduled
        self.onOpenConnections = onOpenConnections
        self.tick = tick
    }

    public var body: some View {
        let p = Palette(scheme)
        Group {
            if let id = model.openID, model.record(id) != nil {
                AgentDetailView(model: model, agentID: id, assistantName: assistantName, onGoToScheduled: onGoToScheduled)
            } else {
                AgentsRosterView(model: model, assistantName: assistantName)
            }
        }
        // Flexible down to nothing: the window's minimum is the shell's (#392).
        .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .topLeading)
        .background(p[.surface])
        .shellItemActions(model.itemActions)
        .sheet(isPresented: $model.isChoosingNewAgent) {
            NewAgentChooser(model: model, onOpenConnections: onOpenConnections)
        }
        .sheet(item: Binding(get: { model.registration.map(SheetToken.init) }, set: { if $0 == nil { model.registration = nil } })) { _ in
            RegisterToolSheet(model: model)
        }
        .sheet(item: Binding(get: { model.newLocal.map(SheetToken.init) }, set: { if $0 == nil { model.newLocal = nil } })) { _ in
            NewLocalAgentSheet(model: model, assistantName: assistantName)
        }
        .sheet(item: Binding(get: { model.credential.map { SheetToken($0.id) } }, set: { if $0 == nil { model.dismissCredential() } })) { _ in
            if let credential = model.credential {
                CredentialSheet(credential: credential, canCopy: model.copyText != nil, onCopy: { model.copyCredential() }, onDone: { model.dismissCredential() })
            }
        }
        .task {
            await model.refreshIfDue()
            while !Task.isCancelled {
                try? await Task.sleep(for: tick)
                if Task.isCancelled { break }
                await model.refreshIfDue()
            }
        }
    }
}

/// An `Identifiable` handle for a sheet whose content is the model's own.
struct SheetToken: Identifiable, Equatable {
    let id: String
    init(_ id: String) { self.id = id }
    init(_ draft: RegistrationDraft) { self.id = "register" }
    init(_ draft: NewLocalAgentDraft) { self.id = "new-local" }
}

// MARK: - The roster

struct AgentsRosterView: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: AgentsModel
    let assistantName: String?

    var body: some View {
        let p = Palette(scheme)
        let panel = model.panel
        VStack(alignment: .leading, spacing: 0) {
            header(p, panel: panel)
            if let notice = model.notice {
                Text(verbatim: notice)
                    .metistryText(.callout, p, .textSecondary)
                    .padding(.horizontal, MetistrySpace.s4)
                    .padding(.bottom, MetistrySpace.s2)
            }
            switch panel {
            case .placeholders(let waiting):
                PlaceholderRows(count: 5, waitingFor: waiting)
                    .padding(MetistrySpace.s4)
                Spacer(minLength: 0)
            case .failed(let state):
                StatePanel(state, now: model.now(), clock: model.clock) {
                    Task { await model.load() }
                }
                Spacer(minLength: 0)
            case .roster:
                if let roster = model.roster(assistantName: assistantName) {
                    AgentsRosterList(model: model, roster: roster)
                }
            }
        }
    }

    private func header(_ p: Palette, panel: AgentsModel.Panel) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s3) {
            Text(verbatim: AgentWords.title)
                .metistryFont(.title2, weight: .semibold)
                .foregroundStyle(p[.textPrimary])
                .accessibilityAddTraits(.isHeader)
            if case .roster(let since?) = panel {
                // Presence is a snapshot: its age rides the header (§6).
                StalePill(isStale: true, age: ClockTime.age(model.now().timeIntervalSince(since)))
            }
            Spacer(minLength: MetistrySpace.s2)
            ControlButton(ControlSpec(AgentWords.newAgent, glyph: .added, role: .secondary)) {
                model.isChoosingNewAgent = true
            }
        }
        .padding(.horizontal, MetistrySpace.s4)
        .padding(.top, MetistrySpace.s3)
        .padding(.bottom, MetistrySpace.s2)
    }
}

struct AgentsRosterList: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: AgentsModel
    let roster: AgentRoster

    var body: some View {
        let p = Palette(scheme)
        List(selection: $model.selection) {
            SwiftUI.Section {
                if roster.yours.isEmpty {
                    AgentsEmptyLine(title: "No agents yet.", sentence: "An agent is a markdown file describing how it should work.", action: AgentWords.newAgent) {
                        model.isChoosingNewAgent = true
                    }
                } else {
                    ForEach(roster.yours) { row in
                        AgentRosterRowView(row: row).tag(row.id)
                    }
                }
            } header: {
                groupHeader("\(AgentWords.yours) · \(roster.yours.count)", p)
            }
            SwiftUI.Section {
                if roster.connected.isEmpty {
                    AgentsEmptyLine(title: "Nothing has connected.", sentence: "An agent gets a token here, and nothing else gives it one.", action: nil, onAction: nil)
                } else {
                    ForEach(roster.connected) { row in
                        AgentRosterRowView(row: row).tag(row.id)
                    }
                }
            } header: {
                groupHeader("\(AgentWords.connected) · \(roster.connected.count)", p)
            }
            if !roster.revoked.isEmpty {
                SwiftUI.Section {
                    DisclosureGroup(isExpanded: $model.showsRevoked) {
                        Text(verbatim: "Their pending access asks were settled, and the access you approved for them went with them.")
                            .metistryText(.footnote, p, .textSecondary)
                        ForEach(roster.revoked) { row in
                            AgentRevokedRowView(row: row)
                        }
                    } label: {
                        Text(verbatim: "\(AgentWords.revoked) · \(roster.revoked.count)")
                            .metistryText(.subhead, p, .textSecondary)
                    }
                }
            }
        }
        .listStyle(.inset)
        .scrollContentBackground(.hidden)
        .shellListFocus()
        .contextMenu(forSelectionType: String.self, menu: { _ in }, primaryAction: { ids in
            if let id = ids.first { Task { await model.open(id) } }
        })
    }

    private func groupHeader(_ text: String, _ p: Palette) -> some View {
        Text(verbatim: text)
            .metistryFont(.caption1, weight: .semibold)
            .textCase(.uppercase)
            .foregroundStyle(p[.textTertiary])
            .accessibilityAddTraits(.isHeader)
    }
}

/// A group with nothing in it says why (§6) — never an empty list.
struct AgentsEmptyLine: View {
    @Environment(\.colorScheme) private var scheme
    let title: String
    let sentence: String
    let action: String?
    let onAction: (() -> Void)?

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            Text(verbatim: title).metistryText(.body, p, .textPrimary)
            Text(verbatim: sentence).metistryText(.callout, p, .textSecondary)
            if let action, let onAction {
                ControlButton(ControlSpec(action, role: .secondary), action: onAction)
                    .padding(.top, MetistrySpace.s1)
            }
        }
        .padding(.vertical, MetistrySpace.s2)
    }
}

/// The presence mark: filled for working and queued, hollow for idle,
/// `degraded` for the two that are wrong. Decorative — the row says it.
struct AgentPresenceDot: View {
    @Environment(\.colorScheme) private var scheme
    let mark: AgentPresenceMark

    var body: some View {
        let p = Palette(scheme)
        Group {
            if mark.isWrong {
                Image(systemName: MetistryGlyph.degraded.rawValue).foregroundStyle(p[.degraded])
            } else if mark.isFilled {
                Circle().fill(p[.agent]).frame(width: 8, height: 8)
            } else {
                Circle().strokeBorder(p[.textTertiary], lineWidth: 1.5).frame(width: 8, height: 8)
            }
        }
        .frame(width: 16)
        .accessibilityHidden(true)
    }
}

struct AgentRosterRowView: View {
    @Environment(\.colorScheme) private var scheme
    let row: AgentRosterRow

    var body: some View {
        let p = Palette(scheme)
        HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s3) {
            AgentPresenceDot(mark: row.presence)
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s3) {
                    name(p)
                    what(p)
                }
                VStack(alignment: .leading, spacing: 2) {
                    name(p)
                    what(p)
                }
            }
            Spacer(minLength: MetistrySpace.s2)
            if let word = row.presence.word {
                Text(verbatim: word).metistryText(.footnote, p, row.presence.isWrong ? .degraded : .textSecondary)
            }
            Text(verbatim: row.time)
                .metistryText(.footnote, p, .textTertiary)
                .monospacedDigit()
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: row.spoken))
        .accessibilityAddTraits(.isButton)
    }

    private func name(_ p: Palette) -> some View {
        Text(verbatim: row.id)
            .metistryFont(.body, design: .mono)
            .foregroundStyle(p[.textPrimary])
    }

    private func what(_ p: Palette) -> some View {
        Text(verbatim: row.whatItIs)
            .metistryText(.callout, p, row.pending ? .accent : .textSecondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}

struct AgentRevokedRowView: View {
    @Environment(\.colorScheme) private var scheme
    let row: AgentRevokedRow

    var body: some View {
        let p = Palette(scheme)
        HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s3) {
            Image(systemName: MetistryGlyph.absent.rawValue).foregroundStyle(p[.absent]).frame(width: 16).accessibilityHidden(true)
            Text(verbatim: row.id).metistryFont(.body, design: .mono).foregroundStyle(p[.textSecondary])
            if let name = row.displayName {
                Text(verbatim: name).metistryText(.callout, p, .textTertiary)
            }
            Spacer(minLength: 0)
            Text(verbatim: "revoked").metistryText(.footnote, p, .textTertiary)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: "\(row.id), revoked"))
    }
}

// MARK: - New Agent (C138)

struct NewAgentChooser: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss
    @Bindable var model: AgentsModel
    let onOpenConnections: (() -> Void)?

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s3) {
            Text(verbatim: AgentWords.newAgent)
                .metistryFont(.headline)
                .foregroundStyle(p[.textPrimary])
                .accessibilityAddTraits(.isHeader)
            Text(verbatim: "What kind of agent?").metistryText(.callout, p, .textSecondary)
            ForEach(NewAgentKind.allCases) { kind in
                let why = kind.unavailableBecause(isLocalClient: model.isLocalClient)
                VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                    ControlButton(ControlSpec(kind.title, role: .secondary, disabledBecause: why)) {
                        if kind == .connectAgent {
                            model.isChoosingNewAgent = false
                            onOpenConnections?()
                        } else {
                            model.chooseNewAgent(kind)
                        }
                    }
                    Text(verbatim: kind.sentence).metistryText(.footnote, p, .textSecondary)
                    if let why { FactNote(FactNoteModel(why)) }
                }
                .padding(.vertical, MetistrySpace.s1)
            }
            HStack {
                Spacer(minLength: 0)
                ControlButton(ControlSpec(CostConfirmation.cancel, role: .secondary)) { dismiss() }
            }
        }
        .padding(MetistrySpace.s5)
        .frame(minWidth: 0, maxWidth: 460, alignment: .leading)
        .background(p[.elevated])
    }
}

/// A tool that works for you: an id, its name, and whether it runs elsewhere.
/// The token is minted here and shown once (`CredentialSheet`).
struct RegisterToolSheet: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: AgentsModel

    var body: some View {
        let p = Palette(scheme)
        let draft = model.registration ?? RegistrationDraft()
        VStack(alignment: .leading, spacing: MetistrySpace.s3) {
            Text(verbatim: NewAgentKind.tool.title)
                .metistryFont(.headline)
                .foregroundStyle(p[.textPrimary])
                .accessibilityAddTraits(.isHeader)
            Text(verbatim: NewAgentKind.tool.sentence).metistryText(.callout, p, .textSecondary)
            TextField("Id", text: binding(\.id), prompt: Text(verbatim: "Id, e.g. cursor"))
                .textFieldStyle(.roundedBorder)
            if !draft.id.isEmpty, let problem = draft.idProblem {
                Text(verbatim: problem).metistryText(.footnote, p, .failed)
            }
            TextField("Name", text: binding(\.displayName), prompt: Text(verbatim: "Name, e.g. Cursor"))
                .textFieldStyle(.roundedBorder)
            Toggle(isOn: binding(\.remote)) {
                Text(verbatim: "It runs on another machine")
            }
            if draft.remote {
                Text(verbatim: "It waits for your approval in Needs You before its token works.")
                    .metistryText(.footnote, p, .textSecondary)
            }
            Text(verbatim: "It starts with no reach at all — grant it folders on its page.")
                .metistryText(.footnote, p, .textSecondary)
            if let problem = model.registrationProblem {
                Text(verbatim: problem).metistryText(.footnote, p, .failed).textSelection(.enabled)
            }
            if !model.allowsDecisions, let why = model.decisionsUnavailableReason {
                FactNote(FactNoteModel(why))
            }
            HStack(spacing: MetistrySpace.s2) {
                Spacer(minLength: 0)
                ControlButton(ControlSpec(CostConfirmation.cancel, role: .secondary)) { model.registration = nil }
                ControlButton(ControlSpec("Make Its Token", role: .primary, disabledBecause: draft.isSendable && model.allowsDecisions ? nil : "An id and a name first")) {
                    Task { await model.register() }
                }
            }
        }
        .padding(MetistrySpace.s5)
        .frame(minWidth: 0, maxWidth: 460, alignment: .leading)
        .background(p[.elevated])
        #if os(macOS)
        .onExitCommand { model.registration = nil }
        #endif
    }

    private func binding<T>(_ key: WritableKeyPath<RegistrationDraft, T>) -> Binding<T> {
        Binding(
            get: { (model.registration ?? RegistrationDraft())[keyPath: key] },
            set: { model.registration?[keyPath: key] = $0 }
        )
    }
}

/// A local agent, blank or from one the owner has — `metistry agents define`.
struct NewLocalAgentSheet: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: AgentsModel
    let assistantName: String?

    var body: some View {
        let p = Palette(scheme)
        let draft = model.newLocal ?? NewLocalAgentDraft()
        ScrollView {
            VStack(alignment: .leading, spacing: MetistrySpace.s3) {
                Text(verbatim: NewAgentKind.local.title)
                    .metistryFont(.headline)
                    .foregroundStyle(p[.textPrimary])
                    .accessibilityAddTraits(.isHeader)
                Text(verbatim: NewAgentKind.local.sentence).metistryText(.callout, p, .textSecondary)
                Picker(selection: Binding(get: { draft.template ?? "" }, set: { value in Task { await model.startFrom(value.isEmpty ? nil : value) } })) {
                    Text(verbatim: "Blank").tag("")
                    ForEach(model.templates, id: \.self) { Text(verbatim: "Start from \($0)").tag($0) }
                } label: {
                    Text(verbatim: "Start from")
                }
                TextField("Id", text: binding(\.id), prompt: Text(verbatim: "Id, e.g. vendor-research"))
                    .textFieldStyle(.roundedBorder)
                if !draft.id.isEmpty, let problem = draft.idProblem {
                    Text(verbatim: problem).metistryText(.footnote, p, .failed)
                }
                TextField("Area", text: binding(\.area), prompt: Text(verbatim: "Area, e.g. research"))
                    .textFieldStyle(.roundedBorder)
                if !draft.area.isEmpty, let problem = draft.areaProblem {
                    Text(verbatim: problem).metistryText(.footnote, p, .failed)
                }
                TextField("Description", text: binding(\.description), prompt: Text(verbatim: "What it does, in a line"))
                    .textFieldStyle(.roundedBorder)
                AgentModelPickers(
                    choices: model.modelChoices(current: draft.model, assistantName: assistantName),
                    model: binding(\.model),
                    effort: binding(\.effort)
                )
                Text(verbatim: "How it should work").metistryText(.subhead, p, .textSecondary)
                TextEditor(text: binding(\.prompt))
                    .metistryFont(.body, design: .mono)
                    .frame(minHeight: 160)
                    .overlay(RoundedRectangle(cornerRadius: MetistryRadius.sm).strokeBorder(p[.border], lineWidth: 1))
                    .accessibilityLabel(Text(verbatim: "How it should work"))
                Text(verbatim: "It starts with no tools and no reach — its file's scope and uses are yours to write by hand.")
                    .metistryText(.footnote, p, .textSecondary)
                Text(verbatim: AgentWords.neverWrites(assistantName)).metistryText(.footnote, p, .textSecondary)
                if let problem = model.createProblem {
                    Text(verbatim: problem).metistryText(.footnote, p, .failed).textSelection(.enabled)
                }
                HStack(spacing: MetistrySpace.s2) {
                    Spacer(minLength: 0)
                    ControlButton(ControlSpec(CostConfirmation.cancel, role: .secondary)) { model.newLocal = nil }
                    ControlButton(ControlSpec(model.isCreating ? "Writing…" : "Create Agent", role: .primary, disabledBecause: draft.isSendable && !model.isCreating ? nil : "An id, an area and how it should work first")) {
                        Task { await model.createLocal() }
                    }
                }
            }
            .padding(MetistrySpace.s5)
        }
        .frame(minWidth: 0, idealWidth: 520, maxWidth: 560, minHeight: 0, idealHeight: 620, alignment: .topLeading)
        .background(p[.elevated])
        #if os(macOS)
        .onExitCommand { model.newLocal = nil }
        #endif
    }

    private func binding<T>(_ key: WritableKeyPath<NewLocalAgentDraft, T>) -> Binding<T> {
        Binding(
            get: { (model.newLocal ?? NewLocalAgentDraft())[keyPath: key] },
            set: { model.newLocal?[keyPath: key] = $0 }
        )
    }
}

/// The one model dropdown (C128) and its effort.
struct AgentModelPickers: View {
    let choices: [AgentModelChoice]
    @Binding var model: String
    @Binding var effort: String

    var body: some View {
        Picker(selection: $model) {
            ForEach(choices) { Text(verbatim: $0.label).tag($0.value) }
        } label: {
            Text(verbatim: "Model")
        }
        Picker(selection: $effort) {
            ForEach(ComputeEffort.allCases) { Text(verbatim: $0.label).tag($0.rawValue) }
        } label: {
            Text(verbatim: "Effort")
        }
    }
}

/// A bearer, shown once: register or rotate answered it, and the app keeps no copy.
struct CredentialSheet: View {
    @Environment(\.colorScheme) private var scheme
    let credential: AgentCredential
    let canCopy: Bool
    let onCopy: () -> Void
    let onDone: () -> Void

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s3) {
            Text(verbatim: "\(credential.id)'s Token")
                .metistryFont(.headline)
                .foregroundStyle(p[.textPrimary])
                .accessibilityAddTraits(.isHeader)
            Text(verbatim: "Shown once. Metistry keeps no copy — give it to the tool now.")
                .metistryText(.callout, p, .textSecondary)
            Text(verbatim: credential.token)
                .metistryFont(.body, design: .mono)
                .foregroundStyle(p[.textPrimary])
                .textSelection(.enabled)
                .padding(MetistrySpace.s2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(p[.sunken], in: RoundedRectangle(cornerRadius: MetistryRadius.sm, style: .continuous))
                .accessibilityLabel(Text(verbatim: "Token"))
            if credential.pending == true {
                Text(verbatim: "It works once you approve it in Needs You.")
                    .metistryText(.footnote, p, .textSecondary)
            }
            HStack(spacing: MetistrySpace.s2) {
                Spacer(minLength: 0)
                if canCopy {
                    ControlButton(ControlSpec("Copy Token", role: .secondary), action: onCopy)
                }
                ControlButton(ControlSpec("Done", role: .primary), action: onDone)
            }
        }
        .padding(MetistrySpace.s5)
        .frame(minWidth: 0, maxWidth: 460, alignment: .leading)
        .background(p[.elevated])
    }
}

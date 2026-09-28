// One agent (design-build-plan T6-5; screen-07-agents.md §3–§5; C42, C128,
// C136, C138). The roster is agents-view.swift; the model agents-model.swift.
//
// A LOCAL AGENT is its definition first — a markdown file in the vault, drawn
// as prose with its path and *versioned in the vault*, and edited, on the Mac
// that runs Metistry only, through `metistry agents define` (M12). Esc closes
// the editor and keeps a draft (C136). Then the permissions table, its one
// model dropdown, the routines that assign it work (each leading to
// Scheduled) and what it did. No autonomy matrix: a local agent's room to act
// comes from what assigns it work (§3.3).
//
// A CONNECTED AGENT has no definition — someone else's code — so its page is
// shorter and says why: how it connects, its reach and projects, the same
// permissions table with Edit, the escalation ceiling (C42) and Revoke with its
// cascade stated before the button.
//
// CHANGING THINGS (§5): a narrowing applies on commit; a widening is
// confirmed with core's own strings and a button that says *Widen*; a record
// that moved while the editor was open sends nothing and offers the edit
// again; revoking and rotating confirm, naming the cost.

import SwiftUI

struct AgentDetailView: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: AgentsModel
    let agentID: String
    let assistantName: String?
    let onGoToScheduled: (() -> Void)?

    var body: some View {
        let p = Palette(scheme)
        if let record = model.record(agentID) {
            ScrollView {
                VStack(alignment: .leading, spacing: MetistrySpace.s5) {
                    header(record, p)
                    if let notice = model.notice {
                        Text(verbatim: notice).metistryText(.callout, p, .textSecondary).textSelection(.enabled)
                    }
                    if record.kind == "crew" {
                        AgentDefinitionSection(model: model, agentID: agentID, assistantName: assistantName)
                    } else {
                        AgentConnectionSection(model: model, record: record)
                    }
                    permissions(record, p)
                    let ceilings = model.ceilings(of: agentID)
                    if !ceilings.isEmpty {
                        AgentCeilingSection(ceilings: ceilings)
                    }
                    if record.kind == "crew" {
                        AgentRoutinesSection(model: model, agentID: agentID, onGoToScheduled: onGoToScheduled)
                    }
                    AgentRunsSection(model: model, agentID: agentID, assistantName: assistantName)
                    if record.kind == "external" && !record.revoked {
                        credentialActions(record, p)
                    }
                }
                .frame(maxWidth: MetistrySize.contentMax, alignment: .leading)
                .padding(MetistrySpace.s5)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            #if os(macOS)
            .onExitCommand { model.back() }
            #endif
            .sheet(item: Binding(get: { model.access.map { SheetToken($0.agentID) } }, set: { if $0 == nil { model.cancelAccessEdit() } })) { _ in
                AccessEditorSheet(model: model)
            }
            .sheet(item: Binding(get: { model.revokeConfirmation.map { SheetToken($0.title) } }, set: { if $0 == nil { model.cancelRevoke() } })) { _ in
                if let c = model.revokeConfirmation {
                    CostConfirmView(c) { choice in
                        if choice == .confirm { Task { await model.confirmRevoke() } } else { model.cancelRevoke() }
                    }
                }
            }
            .sheet(item: Binding(get: { model.rotateConfirmation.map { SheetToken($0.title) } }, set: { if $0 == nil { model.cancelRotate() } })) { _ in
                if let c = model.rotateConfirmation {
                    CostConfirmView(c) { choice in
                        if choice == .confirm { Task { await model.confirmRotate() } } else { model.cancelRotate() }
                    }
                }
            }
        }
    }

    private func header(_ record: AgentRecord, _ p: Palette) -> some View {
        let mark = AgentPresenceMark(state: model.presenceRow(agentID)?.state)
        return VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            ControlButton(ControlSpec("Agents", role: .plain, name: "Back to Agents")) { model.back() }
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s3) {
                AgentPresenceDot(mark: mark)
                Text(verbatim: record.id)
                    .metistryFont(.title2, design: .mono, weight: .semibold)
                    .foregroundStyle(p[.textPrimary])
                    .accessibilityAddTraits(.isHeader)
                if let word = mark.word {
                    Text(verbatim: word).metistryText(.footnote, p, mark.isWrong ? .degraded : .textSecondary)
                }
            }
            Text(verbatim: kindLine(record)).metistryText(.callout, p, .textSecondary)
            if let spend = model.presenceRow(agentID)?.spendTodayUSD, spend > 0 {
                Text(verbatim: "Spent today: \(AgentMoney.format(spend))").metistryText(.footnote, p, .textSecondary)
            }
        }
    }

    private func kindLine(_ record: AgentRecord) -> String {
        let name = record.displayName.map { "\($0) · " } ?? ""
        if record.kind == "crew" { return "\(name)Yours — you defined it, and only you may change how it works." }
        return "\(name)Connected — you didn't write this and can't read it; it authenticated in with a token."
    }

    @ViewBuilder
    private func permissions(_ record: AgentRecord, _ p: Palette) -> some View {
        let rows = record.permissions ?? []
        let editable = model.canEditAccess(agentID) && model.allowsDecisions
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            PermissionsTable(rows, onEdit: editable ? { model.beginAccessEdit(agentID) } : nil)
            if record.kind == "crew" {
                Text(verbatim: "Its reach is its definition's scope, uses and autonomy — written in the file by hand.")
                    .metistryText(.footnote, p, .textSecondary)
            } else if model.canEditAccess(agentID), !model.allowsDecisions, let why = model.decisionsUnavailableReason {
                FactNote(FactNoteModel(why))
            }
        }
    }

    private func credentialActions(_ record: AgentRecord, _ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            Text(verbatim: "Its Token").metistryFont(.headline).foregroundStyle(p[.textPrimary]).accessibilityAddTraits(.isHeader)
            FlowLayout(spacing: MetistrySpace.s2) {
                if model.isLocalClient {
                    ControlButton(ControlSpec("Rotate Token…", role: .secondary, disabledBecause: model.allowsDecisions ? nil : model.decisionsUnavailableReason)) {
                        model.askToRotate(agentID)
                    }
                }
                ControlButton(ControlSpec("Revoke…", role: .destructive, disabledBecause: model.allowsDecisions ? nil : model.decisionsUnavailableReason)) {
                    model.askToRevoke(agentID)
                }
            }
            if !model.isLocalClient {
                Text(verbatim: "A new token is made on the Mac that runs Metistry.").metistryText(.footnote, p, .textSecondary)
            }
        }
    }
}

/// Dollars as the detail says them: *$0.25*, *$1.84*.
enum AgentMoney {
    static func format(_ usd: Double) -> String { String(format: "$%.2f", usd) }
}

// MARK: - The definition (local)

struct AgentDefinitionSection: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: AgentsModel
    let agentID: String
    let assistantName: String?

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            Text(verbatim: "Definition").metistryFont(.headline).foregroundStyle(p[.textPrimary]).accessibilityAddTraits(.isHeader)
            switch model.definitions[agentID] {
            case .loading?, nil:
                PlaceholderRows(count: 2, waitingFor: nil)
            case .absent(let path)?:
                // Nothing broke: the file is not there (§6).
                StatePanel(StatePanelModel(.absent, title: "No Definition File", sentence: "Metistry looked for \(path) and it isn't there."), now: model.now(), clock: model.clock)
            case .failed(let why)?:
                StatePanel(StatePanelModel(.failed, title: "Couldn't Read the Definition", sentence: "The rest of this page is still current.", reason: why, action: StateWords.tryAgain), now: model.now(), clock: model.clock) {
                    Task { await model.open(agentID) }
                }
            case .loaded(let reading)?:
                if let editor = model.editor, editor.agentID == agentID {
                    AgentDefinitionEditor(model: model, assistantName: assistantName)
                } else {
                    reader(reading, p)
                }
            }
        }
    }

    @ViewBuilder
    private func reader(_ reading: AgentDefinitionReading, _ p: Palette) -> some View {
        if let path = reading.path {
            Text(verbatim: "\(path) · \(reading.origin == "product" ? "shipped with Metistry — saving writes your own copy" : AgentWords.versionedInTheVault)")
                .metistryFont(.footnote, design: .mono)
                .foregroundStyle(p[.textSecondary])
                .textSelection(.enabled)
        }
        if let description = reading.description, !description.isEmpty {
            Text(verbatim: description).metistryText(.body, p, .textPrimary)
        }
        Text(verbatim: reading.prompt)
            .metistryFont(.callout, design: .mono)
            .foregroundStyle(p[.textPrimary])
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .padding(MetistrySpace.s3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(p[.sunken], in: RoundedRectangle(cornerRadius: MetistryRadius.sm, style: .continuous))
        Text(verbatim: computeLine(reading)).metistryText(.callout, p, .textSecondary)
        if model.keptDraft == agentID {
            HStack(spacing: MetistrySpace.s2) {
                Text(verbatim: AgentWords.draftKept(agentID)).metistryText(.callout, p, .textSecondary)
                ControlButton(ControlSpec("Open", role: .plain, name: "Open the draft of \(agentID)")) { model.beginEdit(agentID) }
                ControlButton(ControlSpec("Discard", role: .plain, name: "Discard the draft of \(agentID)")) { model.discardDraft(agentID) }
            }
        }
        if model.canEditDefinition(agentID) {
            ControlButton(ControlSpec(model.drafts[agentID] != nil ? "Edit Draft" : "Edit Definition", glyph: .edit, role: .secondary)) { model.beginEdit(agentID) }
        } else if !model.isLocalClient {
            FactNote(FactNoteModel(AgentWords.editOnTheMac))
        }
    }

    private func computeLine(_ reading: AgentDefinitionReading) -> String {
        let choices = model.modelChoices(current: reading.model, assistantName: assistantName)
        var line: String
        if reading.model == nil || reading.model == AgentModelChoice.sameAsDefaultWire {
            let who = assistantName ?? "the default"
            line = "Runs on the same model as \(who)"
        } else {
            line = "Runs on \(reading.model.flatMap { m in choices.first { $0.value == m }?.label } ?? "")"
        }
        if let effort = reading.effort.flatMap(ComputeEffort.init(rawValue:)) { line += " · \(effort.label.lowercased()) effort" }
        if let turns = reading.maxTurns { line += " · at most \(turns) turns" }
        if let budget = reading.budgetUSDPerRun { line += " · \(AgentMoney.format(budget)) a run" }
        return line
    }
}

struct AgentDefinitionEditor: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: AgentsModel
    let assistantName: String?

    var body: some View {
        let p = Palette(scheme)
        if let draft = model.editor {
            VStack(alignment: .leading, spacing: MetistrySpace.s3) {
                if let path = draft.original.path {
                    Text(verbatim: "\(path) · \(AgentWords.versionedInTheVault)")
                        .metistryFont(.footnote, design: .mono)
                        .foregroundStyle(p[.textSecondary])
                }
                TextField("Description", text: binding(\.description), prompt: Text(verbatim: "What it does, in a line"))
                    .textFieldStyle(.roundedBorder)
                AgentModelPickers(
                    choices: model.modelChoices(current: draft.model, assistantName: assistantName),
                    model: binding(\.model),
                    effort: binding(\.effort)
                )
                // A markdown editor, not a form field: the behaviour is prose
                // with structure, and the headings stay visible (§3.1).
                TextEditor(text: binding(\.prompt))
                    .metistryFont(.body, design: .mono)
                    .frame(minHeight: 220)
                    .overlay(RoundedRectangle(cornerRadius: MetistryRadius.sm).strokeBorder(p[.border], lineWidth: 1))
                    .accessibilityLabel(Text(verbatim: "How \(draft.agentID) should work"))
                Text(verbatim: AgentWords.neverWrites(assistantName)).metistryText(.footnote, p, .textSecondary)
                if let problem = model.saveProblem {
                    Text(verbatim: problem).metistryText(.footnote, p, .failed).textSelection(.enabled)
                }
                HStack(spacing: MetistrySpace.s2) {
                    Spacer(minLength: 0)
                    ControlButton(ControlSpec("Close", role: .secondary, name: "Close, keeping the draft")) { model.abandonEdit(draft) }
                    ControlButton(ControlSpec(model.isSaving ? "Saving…" : "Save", role: .primary, disabledBecause: draft.isChanged && !model.isSaving ? nil : "Nothing changed")) {
                        Task { await model.saveDefinition() }
                    }
                }
            }
            #if os(macOS)
            // Esc keeps a draft (C136) — it does not throw the edit away.
            .onExitCommand { model.abandonEdit(draft) }
            #endif
        }
    }

    private func binding<T>(_ key: WritableKeyPath<DefinitionDraft, T>) -> Binding<T> {
        Binding(
            get: { model.editor![keyPath: key] },
            set: { model.editor?[keyPath: key] = $0 }
        )
    }
}

// MARK: - How it connects (connected)

struct AgentConnectionSection: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: AgentsModel
    let record: AgentRecord

    var body: some View {
        let p = Palette(scheme)
        let now = model.now()
        let projects = record.projects ?? []
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            Text(verbatim: "How It Connects").metistryFont(.headline).foregroundStyle(p[.textPrimary]).accessibilityAddTraits(.isHeader)
            if let created = WireTime.date(record.createdAt) {
                Text(verbatim: "Registered \(model.clock.moment(created, now: now))").metistryText(.callout, p, .textPrimary)
            }
            Text(verbatim: WireTime.date(model.presenceRow(record.id)?.lastSeenAt ?? record.lastSeenAt).map { "Last seen \(ClockTime.age(now.timeIntervalSince($0)))" } ?? "Never seen")
                .metistryText(.callout, p, .textPrimary)
            Text(verbatim: record.remote ? "From another machine" : "From this Mac").metistryText(.callout, p, .textPrimary)
            Text(verbatim: projects.isEmpty ? "A member of no project" : "Projects: \(projects.joined(separator: ", "))").metistryText(.callout, p, .textPrimary)
            if record.pending {
                Text(verbatim: "Waiting for you to approve — its token authenticates nothing until you do.")
                    .metistryText(.callout, p, .accent)
                ControlButton(ControlSpec("Approve", glyph: .approve, role: .primary, disabledBecause: model.allowsDecisions ? nil : model.decisionsUnavailableReason)) {
                    Task { await model.approve(record.id) }
                }
                if !model.allowsDecisions, let why = model.decisionsUnavailableReason { FactNote(FactNoteModel(why)) }
            }
        }
    }
}

// MARK: - The escalation ceiling (C42)

struct AgentCeilingSection: View {
    @Environment(\.colorScheme) private var scheme
    let ceilings: [AgentAccessCeiling]

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            Text(verbatim: "What It Can No Longer Ask").metistryFont(.headline).foregroundStyle(p[.textPrimary]).accessibilityAddTraits(.isHeader)
            ForEach(Array(ceilings.enumerated()), id: \.offset) { item in
                Text(verbatim: AgentWords.ceiling(item.element)).metistryText(.callout, p, .textPrimary)
            }
            Text(verbatim: "Its asks are refused at the tool, so nothing reaches Needs You — the quiet there means this.")
                .metistryText(.footnote, p, .textSecondary)
        }
    }
}

// MARK: - Its routines (local)

struct AgentRoutinesSection: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: AgentsModel
    let agentID: String
    let onGoToScheduled: (() -> Void)?

    var body: some View {
        let p = Palette(scheme)
        let own = model.routines(of: agentID)
        let run = model.runNowControl(agentID)
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            Text(verbatim: "Its Routines").metistryFont(.headline).foregroundStyle(p[.textPrimary]).accessibilityAddTraits(.isHeader)
            if own.isEmpty {
                // Run Now with nothing to run is dimmed with its reason, and
                // leads somewhere (C138).
                FlowLayout(spacing: MetistrySpace.s2) {
                    ControlButton(run) {}
                    if let onGoToScheduled {
                        ControlButton(ControlSpec(AgentWords.giveItOne, role: .secondary, name: "Give \(agentID) a routine"), action: onGoToScheduled)
                    }
                }
                if let why = run.disabledBecause { FactNote(FactNoteModel(why)) }
            } else {
                ForEach(own) { routine in
                    routineRow(routine, several: own.count > 1, p)
                }
                if own.count == 1 {
                    ControlButton(run) { Task { await model.runNow(agentID) } }
                    if let why = run.disabledBecause { FactNote(FactNoteModel(why)) }
                }
            }
        }
    }

    private func routineRow(_ routine: AgentRoutine, several: Bool, _ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: routine.title).metistryText(.body, p, .textPrimary)
            Text(verbatim: routine.paused ? AgentWords.paused : routine.describe).metistryText(.callout, p, .textSecondary)
            if let held = routine.held {
                Text(verbatim: held).metistryText(.footnote, p, .textSecondary)
            }
            if let at = WireTime.date(routine.lastRunAt) {
                let cost = routine.lastRunCost.map { " · \(AgentMoney.format($0))" } ?? ""
                Text(verbatim: "Last ran \(model.clock.moment(at, now: model.now()))\(routine.lastRunOK == false ? " · failed" : "")\(cost)")
                    .metistryText(.footnote, p, routine.lastRunOK == false ? .failed : .textSecondary)
            }
            FlowLayout(spacing: MetistrySpace.s2) {
                if let onGoToScheduled {
                    ControlButton(ControlSpec("Open in Scheduled", role: .plain, name: "Open \(routine.title) in Scheduled"), action: onGoToScheduled)
                }
                if several {
                    ControlButton(ControlSpec("Run Now", role: .plain, disabledBecause: model.allowsDecisions ? nil : model.decisionsUnavailableReason, name: "Run \(routine.title) Now")) {
                        Task { await model.run(routine) }
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
    }
}

// MARK: - What it did

struct AgentRunsSection: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: AgentsModel
    let agentID: String
    let assistantName: String?

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            Text(verbatim: "What It Did").metistryFont(.headline).foregroundStyle(p[.textPrimary]).accessibilityAddTraits(.isHeader)
            switch model.runs[agentID] {
            case .loading?, nil:
                PlaceholderRows(count: 2, waitingFor: nil)
            case .failed(let why)?, .absent(let why)?:
                Text(verbatim: "Couldn't read what it did: \(why)").metistryText(.callout, p, .failed).textSelection(.enabled)
            case .loaded(let rows)?:
                if rows.isEmpty {
                    Text(verbatim: "Nothing in the last 7 days.").metistryText(.callout, p, .textSecondary)
                } else {
                    ForEach(Array(rows.enumerated()), id: \.offset) { item in
                        runRow(item.element, p)
                    }
                }
            }
        }
    }

    private func runRow(_ row: ActivityFeedRow, _ p: Palette) -> some View {
        let when = WireTime.date(row.ts).map { model.clock.moment($0, now: model.now()) } ?? row.ts
        let subject = ActivityTitleCase.subject(row.subject, kind: row.kind)
        let failed = row.ok == false
        let detail = row.detail ?? ""
        let spoken = "\(ActivityKind.spoken(row.kind)), \(subject), \(when)\(failed ? ", failed" : "")\(detail.isEmpty ? "" : ". \(detail)")"
        return HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
            Image(systemName: failed ? MetistryGlyph.failed.rawValue : ActivityKind.symbol(row.kind))
                .foregroundStyle(p[failed ? .failed : .textSecondary])
                .accessibilityHidden(true)
            Text(verbatim: when).metistryText(.footnote, p, .textTertiary).monospacedDigit()
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: subject.isEmpty ? ActivityKind.spoken(row.kind) : subject).metistryText(.callout, p, .textPrimary)
                if !detail.isEmpty {
                    Text(verbatim: detail).metistryText(.footnote, p, .textSecondary)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: spoken))
    }
}

// MARK: - Editing reach and autonomy (connected)

struct AccessEditorSheet: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: AgentsModel
    @State private var newArea = ""
    @State private var newProject = ""

    var body: some View {
        let p = Palette(scheme)
        Group {
            if let widening = model.widening {
                // Core's own strings, verbatim, and a button that says *Widen*.
                CostConfirmView(widening.confirmation) { choice in
                    if choice == .confirm { Task { await model.confirmWidening() } } else { model.cancelWidening() }
                }
            } else if let draft = model.access {
                form(draft, p)
            }
        }
        .frame(minWidth: 0, idealWidth: 520, maxWidth: 560, alignment: .topLeading)
        .background(p[.elevated])
    }

    private func form(_ draft: AccessDraft, _ p: Palette) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: MetistrySpace.s3) {
                Text(verbatim: "\(draft.agentID)'s Permissions")
                    .metistryFont(.headline)
                    .foregroundStyle(p[.textPrimary])
                    .accessibilityAddTraits(.isHeader)
                Text(verbatim: "Taking room away applies at once. Giving more asks you first.")
                    .metistryText(.callout, p, .textSecondary)
                if let notice = model.accessNotice {
                    Text(verbatim: notice).metistryText(.callout, p, .stale)
                }
                if let problem = model.accessProblem {
                    Text(verbatim: problem).metistryText(.callout, p, .failed).textSelection(.enabled)
                }
                knowledge(draft, p)
                projects(draft, p)
                autonomy(draft, p)
                HStack(spacing: MetistrySpace.s2) {
                    Spacer(minLength: 0)
                    ControlButton(ControlSpec(CostConfirmation.cancel, role: .secondary)) { model.cancelAccessEdit() }
                    ControlButton(ControlSpec("Save", role: .primary, disabledBecause: draft.isChanged && model.allowsDecisions ? nil : (model.allowsDecisions ? "Nothing changed" : model.decisionsUnavailableReason))) {
                        Task { await model.commitAccess() }
                    }
                }
            }
            .padding(MetistrySpace.s5)
        }
        #if os(macOS)
        .onExitCommand { model.cancelAccessEdit() }
        #endif
    }

    @ViewBuilder
    private func knowledge(_ draft: AccessDraft, _ p: Palette) -> some View {
        Text(verbatim: "Knowledge").metistryFont(.subhead, weight: .semibold).foregroundStyle(p[.textPrimary]).accessibilityAddTraits(.isHeader)
        Picker(selection: binding(\.reach.tier)) {
            ForEach(AgentReach.tiers, id: \.self) { Text(verbatim: AgentReach.tierLabel($0)).tag($0) }
        } label: {
            Text(verbatim: "Reads")
        }
        if draft.reach.tier == "areas" {
            ForEach(draft.reach.areas, id: \.self) { area in
                HStack(spacing: MetistrySpace.s2) {
                    Text(verbatim: area).metistryFont(.callout, design: .mono).foregroundStyle(p[.textPrimary])
                    Spacer(minLength: 0)
                    ControlButton(ControlSpec("", glyph: .removed, role: .plain, name: "Remove \(area)")) {
                        model.access?.reach.areas.removeAll { $0 == area }
                    }
                }
            }
            HStack(spacing: MetistrySpace.s2) {
                TextField("Folder", text: $newArea, prompt: Text(verbatim: "Add a folder, e.g. Areas/Ops"))
                    .textFieldStyle(.roundedBorder)
                ControlButton(ControlSpec("Add", role: .secondary, disabledBecause: newArea.trimmingCharacters(in: .whitespaces).isEmpty ? "Name a folder" : nil, name: "Add folder")) {
                    let area = newArea.trimmingCharacters(in: .whitespaces)
                    if !area.isEmpty, model.access?.reach.areas.contains(area) == false { model.access?.reach.areas.append(area) }
                    newArea = ""
                }
            }
        }
        Toggle(isOn: binding(\.reach.queries)) { Text(verbatim: "Named queries") }
    }

    @ViewBuilder
    private func projects(_ draft: AccessDraft, _ p: Palette) -> some View {
        Text(verbatim: "Projects").metistryFont(.subhead, weight: .semibold).foregroundStyle(p[.textPrimary]).accessibilityAddTraits(.isHeader)
        ForEach(draft.reach.projects, id: \.self) { project in
            HStack(spacing: MetistrySpace.s2) {
                Text(verbatim: project).metistryFont(.callout, design: .mono).foregroundStyle(p[.textPrimary])
                Spacer(minLength: 0)
                ControlButton(ControlSpec("", glyph: .removed, role: .plain, name: "Leave \(project)")) {
                    model.access?.reach.projects.removeAll { $0 == project }
                }
            }
        }
        HStack(spacing: MetistrySpace.s2) {
            TextField("Project", text: $newProject, prompt: Text(verbatim: "Add a project by its id"))
                .textFieldStyle(.roundedBorder)
            ControlButton(ControlSpec("Add", role: .secondary, disabledBecause: newProject.trimmingCharacters(in: .whitespaces).isEmpty ? "Name a project" : nil, name: "Add project")) {
                let project = newProject.trimmingCharacters(in: .whitespaces)
                if !project.isEmpty, model.access?.reach.projects.contains(project) == false { model.access?.reach.projects.append(project) }
                newProject = ""
            }
        }
    }

    @ViewBuilder
    private func autonomy(_ draft: AccessDraft, _ p: Palette) -> some View {
        let level = draft.autonomy.effectiveLevel
        let effective = AgentAutonomy.effective(draft.autonomy)
        Text(verbatim: "What It May Do").metistryFont(.subhead, weight: .semibold).foregroundStyle(p[.textPrimary]).accessibilityAddTraits(.isHeader)
        Picker(selection: Binding(get: { level }, set: { model.access?.autonomy.level = $0 })) {
            ForEach(AgentAutonomy.levels, id: \.self) { Text(verbatim: AgentAutonomy.levelLabel($0)).tag($0) }
        } label: {
            Text(verbatim: "Level")
        }
        ForEach(AgentAutonomy.kinds, id: \.self) { kind in
            let fallback = PermissionWords.mode(AgentAutonomy.defaults[level]?[kind] ?? "deny") ?? ""
            Picker(selection: Binding(get: { draft.autonomy.actions[kind] ?? "" }, set: { model.access?.autonomy.actions[kind] = $0.isEmpty ? nil : $0 })) {
                Text(verbatim: "Level's Default (\(fallback))").tag("")
                ForEach(AgentAutonomy.modes.reversed(), id: \.self) { Text(verbatim: PermissionWords.mode($0) ?? $0).tag($0) }
            } label: {
                Text(verbatim: "\(AgentAutonomy.kindLabel(kind)) — now \(PermissionWords.mode(effective[kind] ?? "deny") ?? "")")
            }
        }
    }

    private func binding<T>(_ key: WritableKeyPath<AccessDraft, T>) -> Binding<T> {
        Binding(
            get: { model.access![keyPath: key] },
            set: { model.access?[keyPath: key] = $0 }
        )
    }
}

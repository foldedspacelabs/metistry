// Settings → Compute, on screen.
//
// Four sections and a sheet, and every control on them is one `metistry
// compute …` verb (compute-model.swift names all nine). Nothing here holds a
// value the CLI owns: the editors are drafts of what is about to be typed into
// an argument array, seeded from the last `compute show --json` and thrown away
// when it changes. The one value that never reaches an argument array is the
// API key, and it is in a `SecureField` bound to the wizard step's model, whose
// `apply()` writes it to the child's stdin and clears it (compute-step.swift).
//
// The pane re-reads on appear and on an instance switch. The app watches no
// directory — there is no file watcher in MetistryKit, by the same rule that
// keeps the file readers out — so a `compute.yaml` edited in a terminal is
// picked up the next time this pane is opened, and "Read Again" is there for
// the case where it is already open.

import SwiftUI

public struct ComputePaneView: View {
    @Environment(\.colorScheme) private var scheme
    private let model: ComputeModel

    /// What is typed into an assignment row, before it becomes arguments.
    private struct AssignmentDraft: Equatable {
        var provider: String
        var model: String
        var effort: ComputeEffort
    }

    /// What is typed into a budget row, as STRINGS: an empty field is "leave it
    /// alone", which a `Double` cannot express and the CLI's own flags can.
    private struct BudgetDraft: Equatable {
        var daily: String = ""
        var monthly: String = ""
        var action: ComputeBudgetAction = .allow
    }

    @State private var assignments: [String: AssignmentDraft] = [:]
    @State private var budgets: [String: BudgetDraft] = [:]
    @State private var newTarget: String = ""
    @State private var installRefs: [String: String] = [:]
    @State private var addingProvider = false
    @State private var confirmingRemoval: String?

    public init(model: ComputeModel) {
        self.model = model
    }

    public var body: some View {
        let p = Palette(scheme)
        Group {
            banner(p)
            providersSection(p)
            assignmentsSection(p)
            budgetsSection(p)
            localModelsSection(p)
            activitySection(p)
        }
        .onAppear { seedDrafts() }
        .onChange(of: model.report) { seedDrafts() }
        .sheet(isPresented: $addingProvider) {
            AddProviderSheet(model: model, isPresented: $addingProvider)
        }
    }

    // MARK: - The engine banner

    @ViewBuilder
    private func banner(_ p: Palette) -> some View {
        if let banner = model.engineBanner {
            SettingsSection("Engine") {
                HStack(alignment: .top, spacing: MetistrySpace.s3) {
                    StatusDot(.absent)
                    VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                        Text(banner.headline).metistryText(.headline, p, .absent)
                        Text(banner.detail)
                            .metistryText(.caption1, p, .textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: MetistrySpace.s2)
                }
                if let label = banner.actionLabel, let action = banner.action {
                    Button(label) {
                        switch action {
                        case .addProvider:
                            model.openAddProvider()
                            addingProvider = true
                        case .assignDefault:
                            // Prepare the one row that fixes it: the default's
                            // draft, pointed at a provider, with that
                            // provider's own catalogue asked for so the picker
                            // has something in it.
                            let provider = model.report?.providers.first?.name ?? ""
                            assignments["default"] = AssignmentDraft(provider: provider, model: "", effort: .medium)
                            Task { await model.loadCatalogue(for: provider) }
                        }
                    }
                }
            }
        } else if let ref = model.report?.defaultRef {
            SettingsSection("Engine") {
                FactRow("Default", model.report?.engineSummary ?? ref, mono: true, role: .ok)
            }
        }
    }

    // MARK: - Providers

    @ViewBuilder
    private func providersSection(_ p: Palette) -> some View {
        SettingsSection("Providers") {
            if case .unavailable(let why) = model.phase {
                UnavailableCard(what: "Could not read the compute configuration", reason: why, command: model.showCommand)
            }
            ForEach(model.report?.providers ?? []) { provider in
                providerRow(provider, p)
            }
            if model.report?.providers.isEmpty == true {
                Text("No providers yet. A provider is a base URL, a kind and — off this machine — the NAME of a key.")
                    .metistryText(.footnote, p, .textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: MetistrySpace.s3) {
                Button("Add Provider…") {
                    model.openAddProvider()
                    addingProvider = true
                }
                Button("Read Again") { Task { await model.refresh() } }
                    .disabled(model.phase == .reading)
                if model.phase == .reading { ProgressView().controlSize(.small) }
                Spacer(minLength: 0)
                if let file = model.report?.file {
                    Text(file).metistryText(.caption2, p, .textTertiary).lineLimit(1).truncationMode(.head)
                }
            }
            Text(ComputeModel.persistenceNote)
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private func providerRow(_ provider: ComputeProviderFacts, _ p: Palette) -> some View {
        let key = ComputeModel.providerKey(provider.name)
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                Text(provider.name).metistryText(.mono, p)
                if provider.isOffMachineWithoutZDR {
                    Text("no ZDR claim")
                        .metistryText(.caption2, p, .degraded)
                        .padding(.horizontal, MetistrySpace.s2)
                        .padding(.vertical, 1)
                        .background(p[.degraded].opacity(0.15), in: Capsule())
                }
                if provider.isMissingSecret {
                    Text("key not set").metistryText(.caption2, p, .absent)
                }
                Spacer(minLength: MetistrySpace.s2)
                if model.isBusy(key) { ProgressView().controlSize(.small) }
                Button("Test") { Task { await model.testProvider(provider.name) } }
                    .disabled(model.isBusy(key))
                Button("Remove") { confirmingRemoval = provider.name }
                    .disabled(model.isBusy(key))
            }
            Text(provider.baseURL).metistryText(.caption1, p, .textSecondary).textSelection(.enabled)
            Text(provider.summary)
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
            if let test = model.tests[provider.name] {
                HStack(alignment: .top, spacing: MetistrySpace.s2) {
                    StatusDot(test.status)
                    Text(test.detail)
                        .metistryText(.caption1, p, test.ok ? .ok : .failed)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.vertical, MetistrySpace.s1)
        .confirmationDialog(
            "Remove \(confirmingRemoval ?? "")?",
            isPresented: Binding(get: { confirmingRemoval == provider.name }, set: { if !$0 { confirmingRemoval = nil } })
        ) {
            Button("Remove \(provider.name)", role: .destructive) {
                confirmingRemoval = nil
                Task { await model.removeProvider(provider.name) }
            }
            Button("Cancel", role: .cancel) { confirmingRemoval = nil }
        } message: {
            Text("`metistry compute providers remove \(provider.name)` refuses while anything still names it, and says which field. The key stays in the login Keychain — only `metistry secrets` deletes one.")
        }
    }

    // MARK: - Assignments

    @ViewBuilder
    private func assignmentsSection(_ p: Palette) -> some View {
        SettingsSection("Assignments") {
            ForEach(model.report?.assignmentTargets ?? [], id: \.self) { target in
                assignmentRow(target, p)
            }
            HStack(spacing: MetistrySpace.s2) {
                TextField("a tier name, or crew:<name>", text: $newTarget)
                    .textFieldStyle(.roundedBorder)
                Button("Add Assignment") {
                    let target = newTarget.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !target.isEmpty else { return }
                    assignments[target] = AssignmentDraft(
                        provider: model.report?.providers.first?.name ?? "",
                        model: "",
                        effort: .medium
                    )
                    newTarget = ""
                }
                .disabled(newTarget.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            ForEach(pendingTargets, id: \.self) { target in
                assignmentRow(target, p)
            }
            Text("`default` is where every unnamed and unknown tier lands, so the CLI refuses a tier or a crew until it is set. The model list is whatever the provider itself served back — press Models to ask it.")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// Targets the person has just added and not yet written — held in view
    /// state, never in the report, because the report is the file.
    private var pendingTargets: [String] {
        let written = Set(model.report?.assignmentTargets ?? [])
        return assignments.keys.filter { !written.contains($0) }.sorted()
    }

    @ViewBuilder
    private func assignmentRow(_ target: String, _ p: Palette) -> some View {
        let key = ComputeModel.assignKey(target)
        let draft = assignments[target] ?? AssignmentDraft(provider: "", model: "", effort: .medium)
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                Text(target).metistryText(.mono, p)
                if model.report?.assignments.first(where: { $0.target == target })?.warnNonZDR == true {
                    Text("no ZDR claim").metistryText(.caption2, p, .degraded)
                }
                Spacer(minLength: MetistrySpace.s2)
                if model.isBusy(key) { ProgressView().controlSize(.small) }
            }
            HStack(spacing: MetistrySpace.s2) {
                Picker("Provider", selection: Binding(
                    get: { draft.provider },
                    set: { assignments[target] = AssignmentDraft(provider: $0, model: draft.model, effort: draft.effort) }
                )) {
                    ForEach(model.report?.providers ?? []) { provider in
                        Text(provider.name).tag(provider.name)
                    }
                }
                .labelsHidden()
                .frame(maxWidth: 160)

                TextField("model id", text: Binding(
                    get: { draft.model },
                    set: { assignments[target] = AssignmentDraft(provider: draft.provider, model: $0, effort: draft.effort) }
                ))
                .textFieldStyle(.roundedBorder)

                Menu("Models") {
                    let ids = model.models(for: draft.provider)
                    if ids.isEmpty {
                        Text(model.catalogues[draft.provider] == nil ? "not asked yet" : "the provider served none")
                    }
                    ForEach(ids, id: \.self) { id in
                        Button(id) {
                            assignments[target] = AssignmentDraft(provider: draft.provider, model: id, effort: draft.effort)
                        }
                    }
                    Divider()
                    Button("Ask \(draft.provider) for its list") {
                        Task { await model.loadCatalogue(for: draft.provider) }
                    }
                }
                .frame(maxWidth: 110)
                .disabled(draft.provider.isEmpty)
            }
            HStack(spacing: MetistrySpace.s2) {
                Picker("Effort", selection: Binding(
                    get: { draft.effort },
                    set: { assignments[target] = AssignmentDraft(provider: draft.provider, model: draft.model, effort: $0) }
                )) {
                    ForEach(ComputeEffort.allCases) { effort in
                        Text(effort.label).tag(effort)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(maxWidth: 240)
                Spacer(minLength: 0)
                Button("Assign") {
                    Task { await model.assign(target: target, ref: "\(draft.provider)/\(draft.model)", effort: draft.effort) }
                }
                .disabled(draft.provider.isEmpty || draft.model.trimmingCharacters(in: .whitespaces).isEmpty || model.isBusy(key))
            }
        }
        .padding(.vertical, MetistrySpace.s1)
    }

    // MARK: - Budgets

    @ViewBuilder
    private func budgetsSection(_ p: Palette) -> some View {
        SettingsSection("Budgets") {
            budgetRow(
                label: "This instance",
                target: ComputeModel.instanceBudgetTarget,
                current: model.report?.instanceBudget,
                p
            )
            ForEach(model.report?.providers ?? []) { provider in
                budgetRow(
                    label: provider.name,
                    target: ComputeModel.providerBudgetTarget(provider.name),
                    current: provider.budget,
                    p
                )
            }
            Text(ComputeModel.budgetNote)
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private func budgetRow(label: String, target: String, current: ComputeBudgetFacts?, _ p: Palette) -> some View {
        let key = ComputeModel.budgetKey(target)
        let draft = budgets[target] ?? BudgetDraft()
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                Text(label).metistryText(.mono, p)
                Spacer(minLength: MetistrySpace.s2)
                Text(current?.summary ?? "no budget set")
                    .metistryText(.caption1, p, current == nil ? .absent : .textSecondary)
                if model.isBusy(key) { ProgressView().controlSize(.small) }
            }
            HStack(spacing: MetistrySpace.s2) {
                TextField("$ / day", text: Binding(
                    get: { draft.daily },
                    set: { budgets[target] = BudgetDraft(daily: $0, monthly: draft.monthly, action: draft.action) }
                ))
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 100)
                TextField("$ / month", text: Binding(
                    get: { draft.monthly },
                    set: { budgets[target] = BudgetDraft(daily: draft.daily, monthly: $0, action: draft.action) }
                ))
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 100)
                Picker("Action", selection: Binding(
                    get: { draft.action },
                    set: { budgets[target] = BudgetDraft(daily: draft.daily, monthly: draft.monthly, action: $0) }
                )) {
                    ForEach(ComputeBudgetAction.allCases) { action in
                        Text(action.label).tag(action)
                    }
                }
                .labelsHidden()
                .frame(maxWidth: 150)
                Spacer(minLength: 0)
                Button("Set") {
                    Task {
                        await model.setBudget(
                            target: target,
                            daily: Double(draft.daily.trimmingCharacters(in: .whitespaces)),
                            monthly: Double(draft.monthly.trimmingCharacters(in: .whitespaces)),
                            action: draft.action
                        )
                    }
                }
                .disabled(model.isBusy(key))
            }
            Text(draft.action.detail).metistryText(.caption2, p, .textTertiary)
        }
        .padding(.vertical, MetistrySpace.s1)
    }

    // MARK: - Local models

    @ViewBuilder
    private func localModelsSection(_ p: Palette) -> some View {
        SettingsSection("Local Models") {
            if model.localServers.isEmpty {
                Text("No `local:` rows in the last doctor report — run Doctor from Status or Services, and this fills in.")
                    .metistryText(.footnote, p, .textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(model.localServers) { server in
                localServerRow(server, p)
            }
            Text(model.memoryNote)
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private func localServerRow(_ server: LocalServerFacts, _ p: Palette) -> some View {
        let ref = installRefs[server.server] ?? ""
        let key = ComputeModel.serverKey(server.provider ?? server.server)
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                StatusDot(server.status)
                Text(server.label).metistryText(.headline, p)
                Spacer(minLength: MetistrySpace.s2)
                Text(server.isConfigured ? "provider \(server.provider ?? "")" : "not configured")
                    .metistryText(.caption2, p, server.isConfigured ? .textSecondary : .absent)
            }
            if let url = server.url {
                Text(url).metistryText(.caption1, p, .textTertiary).textSelection(.enabled)
            }
            if server.models.isEmpty {
                Text(server.remediation ?? "answering, nothing loaded")
                    .metistryText(.caption1, p, .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text("loaded: \(server.models.prefix(6).joined(separator: ", "))\(server.models.count > 6 ? " … \(server.models.count) in total" : "")")
                    .metistryText(.caption1, p, .textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if server.canInstall, let provider = server.provider {
                HStack(spacing: MetistrySpace.s2) {
                    TextField("model to install", text: Binding(
                        get: { installRefs[server.server] ?? "" },
                        set: { installRefs[server.server] = $0 }
                    ))
                    .textFieldStyle(.roundedBorder)
                    if model.isBusy(key) { ProgressView().controlSize(.small) }
                    Button("Install") {
                        Task { _ = await model.installModel(ref: "\(provider)/\(ref)") }
                    }
                    .disabled(ref.trimmingCharacters(in: .whitespaces).isEmpty || model.isBusy(key))
                    if server.canLoad {
                        Button("Load") { Task { await model.loadModel(ref: "\(provider)/\(ref)", unload: false) } }
                            .disabled(ref.trimmingCharacters(in: .whitespaces).isEmpty || model.isBusy(key))
                        Button("Unload") { Task { await model.loadModel(ref: "\(provider)/\(ref)", unload: true) } }
                            .disabled(ref.trimmingCharacters(in: .whitespaces).isEmpty || model.isBusy(key))
                    }
                }
                Text(server.installHint)
                    .metistryText(.caption2, p, .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            } else if server.canInstall {
                Text("Nothing in compute.yaml dials this server yet — add a provider for it and the install controls appear.")
                    .metistryText(.caption2, p, .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, MetistrySpace.s1)
    }

    // MARK: - What just happened

    @ViewBuilder
    private func activitySection(_ p: Palette) -> some View {
        if let outcome = model.lastOutcome {
            SettingsSection("Last Action") {
                HStack(alignment: .top, spacing: MetistrySpace.s2) {
                    StatusDot(outcome.ok ? .ok : .failed)
                    VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                        Text("metistry \(outcome.verb)").metistryText(.mono, p, .textSecondary)
                        Text(outcome.message)
                            .metistryText(.footnote, p, outcome.ok ? .textPrimary : .failed)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                    }
                }
                if let command = model.lastCommand {
                    Text(command).metistryText(.caption2, p, .textTertiary).textSelection(.enabled)
                }
                if !model.output.isEmpty {
                    OutputLogView(title: "The CLI's own output", lines: model.output)
                }
            }
        }
    }

    // MARK: - Drafts

    /// Seed every editor from the file, discarding whatever was half-typed. A
    /// draft is a view's scratch space; the report is the record, and after a
    /// write the record is what the row must show.
    private func seedDrafts() {
        guard let report = model.report else { return }
        var seededAssignments: [String: AssignmentDraft] = [:]
        for row in report.assignments {
            seededAssignments[row.target] = AssignmentDraft(
                provider: row.provider,
                model: row.model,
                effort: ComputeEffort(rawValue: row.effort) ?? .medium
            )
        }
        assignments = seededAssignments
        var seededBudgets: [String: BudgetDraft] = [:]
        if let instance = report.instanceBudget {
            seededBudgets[ComputeModel.instanceBudgetTarget] = BudgetDraft(
                daily: instance.dailyUSD.map(ComputeBudgetFacts.money) ?? "",
                monthly: instance.monthlyUSD.map(ComputeBudgetFacts.money) ?? "",
                action: instance.action
            )
        }
        for provider in report.providers {
            guard let budget = provider.budget else { continue }
            seededBudgets[ComputeModel.providerBudgetTarget(provider.name)] = BudgetDraft(
                daily: budget.dailyUSD.map(ComputeBudgetFacts.money) ?? "",
                monthly: budget.monthlyUSD.map(ComputeBudgetFacts.money) ?? "",
                action: budget.action
            )
        }
        budgets = seededBudgets
    }
}

/// The add-a-provider sheet: a template, where it lives, and — where the
/// template needs one — a key that goes to stdin and nowhere else.
///
/// It is bound to `ComputeStepModel`, the WIZARD's step 7 model, on purpose.
/// One model owns the key's path to a child process, so there is one place to
/// read to know the app never puts it in argv, a file or a log.
public struct AddProviderSheet: View {
    @Environment(\.colorScheme) private var scheme
    private let model: ComputeModel
    @Binding private var isPresented: Bool

    public init(model: ComputeModel, isPresented: Binding<Bool>) {
        self.model = model
        self._isPresented = isPresented
    }

    private var draft: ComputeStepModel { model.draft }

    public var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s4) {
            Text("Add a Provider").metistryText(.title3, p)

            Picker("Template", selection: Binding(get: { draft.template }, set: { draft.template = $0 })) {
                ForEach(ComputeTemplate.allCases) { template in
                    Text(template.label).tag(template)
                }
            }
            .pickerStyle(.menu)
            Text(draft.template.detail)
                .metistryText(.caption1, p, .textSecondary)
                .fixedSize(horizontal: false, vertical: true)

            LabeledContent("Name") {
                TextField(draft.template.rawValue, text: Binding(get: { draft.providerName }, set: { draft.providerName = $0 }))
                    .textFieldStyle(.roundedBorder)
            }
            LabeledContent("Base URL") {
                TextField("the template's own", text: Binding(get: { draft.baseURL }, set: { draft.baseURL = $0 }))
                    .textFieldStyle(.roundedBorder)
            }
            if draft.template.needsKey {
                LabeledContent("API key") {
                    SecureField("pasted here, sent to the command's stdin", text: Binding(get: { draft.apiKey }, set: { draft.apiKey = $0 }))
                        .textFieldStyle(.roundedBorder)
                }
                Text(ComputeStepModel.keyNote)
                    .metistryText(.caption1, p, .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if draft.assignsDefault {
                LabeledContent("Model") {
                    TextField("the model id, as the provider knows it", text: Binding(get: { draft.model }, set: { draft.model = $0 }))
                        .textFieldStyle(.roundedBorder)
                }
                Text("This install has no engine yet, so this provider also becomes `assignments.default` — the second verb below.")
                    .metistryText(.caption1, p, .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            CommandCard(arguments: draft.plannedCommands, placeholder: "no runtime located")

            if case .failed(let why) = draft.phase {
                UnavailableCard(what: "The CLI refused", reason: why)
            }
            if !draft.output.isEmpty {
                OutputLogView(lines: draft.output)
            }

            HStack(spacing: MetistrySpace.s3) {
                Spacer(minLength: 0)
                Button("Cancel") {
                    // Clears the key first, unconditionally: a sheet dismissed
                    // mid-paste must not leave one in an observable property.
                    draft.reset(template: draft.template, assignsDefault: draft.assignsDefault)
                    isPresented = false
                }
                Button("Add Provider") {
                    Task {
                        await model.addProvider()
                        if model.lastOutcome?.ok == true { isPresented = false }
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!draft.canApply)
            }
        }
        .padding(MetistrySpace.s5)
        .frame(width: 520)
        .background(p[.bg])
    }
}

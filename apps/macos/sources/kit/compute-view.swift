// Settings ▸ Compute, on screen (T6-12; screen-15 §5.3, C130–C133).
//
// One column, in the spec's order: the assistant uses · Providers · Your
// Models · Spending Limits · Advanced (tiers). Every value is the model's
// read of the client API (compute-model.swift); every editor is a draft of
// what is about to be sent, re-seeded from the read after it changes. A model
// is written one way everywhere — `ModelLineText` — so the dropdown's field,
// its menu, Your Models, a search result and a tier cannot disagree.
//
// A change inside the boundary (the model, its effort, a limit, a tier) acts
// at once through the API and says its answer under the pane's last-action
// card. A change to the boundary (a provider's switch, gear or removal; a
// model's install, load or unload) is an M16/M17 verb, confirmed here with the
// exact command before it runs; its progress is the CLI's own lines.

import SwiftUI

public struct ComputePaneView: View {
    @Environment(\.colorScheme) private var scheme
    private let model: ComputeModel
    private let assistantName: String?
    private let onReplaceKey: () -> Void

    /// A limit being typed, as STRINGS: an empty field is "leave it alone",
    /// which a `Double` cannot express and the route's own body can.
    private struct LimitDraft: Equatable {
        var daily: String = ""
        var monthly: String = ""
        var action: ComputeBudgetAction = .stop
    }

    @State private var limitDrafts: [String: LimitDraft] = [:]
    @State private var projectDrafts: [String: String] = [:]
    @State private var addingProvider = false
    @State private var tiersShown = false
    @State private var newTier = ""
    @State private var newTierRef = ""
    @State private var removingTier: String?

    public init(model: ComputeModel, assistantName: String? = nil, onReplaceKey: @escaping () -> Void = {}) {
        self.model = model
        self.assistantName = assistantName
        self.onReplaceKey = onReplaceKey
    }

    /// *Metis uses* — the configured name, never a hardcoded one.
    static func usesTitle(_ assistantName: String?) -> String {
        "\(assistantName ?? "The Assistant") Uses"
    }

    public var body: some View {
        let p = Palette(scheme)
        Group {
            if case .unavailable(let why) = model.phase {
                UnavailableCard(what: "Could not read the compute configuration", reason: why, command: ComputeModel.readRoute)
            }
            banner(p)
            activity(p)
            assistantSection(p)
            providersSection(p)
            yourModelsSection(p)
            limitsSection(p)
            advancedSection(p)
        }
        .onAppear { seedDrafts() }
        .onChange(of: model.compute) { seedDrafts() }
        .task(id: model.query) {
            // search as you type, without a round of catalogue reads per key
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled else { return }
            await model.search()
        }
        .sheet(isPresented: $addingProvider) {
            AddProviderSheet(model: model, isPresented: $addingProvider)
        }
        .sheet(isPresented: Binding(get: { model.gear != nil }, set: { if !$0 { model.gear = nil } })) {
            ProviderGearSheet(model: model)
        }
        .sheet(isPresented: Binding(get: { model.install != nil }, set: { if !$0 { model.install = nil } })) {
            InstallModelSheet(model: model)
        }
        .alert(
            model.confirmation?.title ?? "",
            isPresented: Binding(get: { model.confirmation != nil }, set: { if !$0 { model.cancelConfirmation() } }),
            presenting: model.confirmation
        ) { pending in
            Button(pending.actionTitle, role: pending.destructive ? .destructive : nil) {
                Task { await model.confirm(pending) }
            }
            Button("Cancel", role: .cancel) { model.cancelConfirmation() }
        } message: { pending in
            Text("\(pending.cost)\n\n\(pending.said)")
        }
    }

    // MARK: - The engine banner

    @ViewBuilder
    private func banner(_ p: Palette) -> some View {
        if let banner = model.engineBanner {
            HStack(alignment: .top, spacing: MetistrySpace.s3) {
                StatusDot(.absent)
                VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                    Text(banner.headline).metistryText(.headline, p, .absent)
                    Text(banner.detail)
                        .metistryText(.caption1, p, .textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let label = banner.actionLabel, banner.action == .addProvider {
                        Button(label) {
                            model.openAddProvider()
                            addingProvider = true
                        }
                    }
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .metistryCard(p)
        }
    }

    // MARK: - What is running, and what the last action said

    @ViewBuilder
    private func activity(_ p: Palette) -> some View {
        if let running = model.running {
            VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                HStack(spacing: MetistrySpace.s2) {
                    ProgressView().controlSize(.small).accessibilityLabel("Working")
                    Text(running.waiting).metistryText(.callout, p)
                }
                .accessibilityElement(children: .combine)
                Text(running.said)
                    .metistryText(.caption1, p, .textTertiary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                // the CLI's own progress lines — a download's bytes, a pull's
                // status — never a percentage nobody reported
                ForEach(Array(model.output.suffix(3).enumerated()), id: \.offset) { _, line in
                    Text(line.text)
                        .metistryText(.mono, p, .textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .metistryCard(p)
        } else if let outcome = model.lastOutcome {
            VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                    StatusDot(outcome.ok ? .ok : .failed)
                    Text(outcome.message)
                        .metistryText(.callout, p, outcome.ok ? .textPrimary : .failed)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                Text(outcome.verb)
                    .metistryText(.caption1, p, .textTertiary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                if !model.output.isEmpty {
                    DisclosureGroup("View Log") {
                        Text(model.output.map(\.text).joined(separator: "\n"))
                            .metistryText(.mono, p, .textSecondary)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .metistryCard(p)
        }
    }

    // MARK: - 1 · The assistant uses

    @ViewBuilder
    private func assistantSection(_ p: Palette) -> some View {
        let title = Self.usesTitle(assistantName)
        SettingsSection(title) {
            let current = model.assistantModel
            let effort = current.flatMap { ComputeEffort(rawValue: $0.effort) } ?? .medium
            ModelMenu(
                title: "Model",
                options: model.modelOptions(including: current?.ref),
                selected: current.map { model.line(for: $0.ref) },
                placeholder: "Choose a model"
            ) { line in
                Task { await model.assign(target: "default", ref: line.ref, effort: effort) }
            }
            .disabled(model.report == nil || model.isBusy(ComputeModel.assignKey("default")))
            SettingsControls {
                Picker("Effort", selection: Binding(
                    get: { effort },
                    set: { new in
                        guard let ref = current?.ref else { return }
                        Task { await model.assign(target: "default", ref: ref, effort: new) }
                    }
                )) {
                    ForEach(ComputeEffort.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                .fixedSize()
                .disabled(current == nil)
                if model.isBusy(ComputeModel.assignKey("default")) {
                    ProgressView().controlSize(.small).accessibilityLabel("Saving")
                }
            }
            if let current, current.warnNonZDR {
                Text("Off this Mac, and the provider claims no zero data retention: recorded on every run, never blocked.")
                    .metistryText(.caption1, p, .degraded)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text("One model for every turn, and no fallback. The router chooses among the tiers under Advanced, inside the spending limits below.")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - 2 · Providers

    @ViewBuilder
    private func providersSection(_ p: Palette) -> some View {
        SettingsSection("Providers") {
            let providers = model.report?.providers ?? []
            if providers.isEmpty, model.phase == .read {
                Text("No providers yet. A provider is where prompts go: a model on this Mac, or a cloud service and the secret that is its key.")
                    .metistryText(.footnote, p, .textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(providers) { provider in
                providerLine(provider, p)
                if provider.id != providers.last?.id { Divider() }
            }
            SettingsControls {
                Button("Add Provider…") {
                    model.openAddProvider()
                    addingProvider = true
                }
                .disabled(model.cli == nil)
                if model.phase == .reading { ProgressView().controlSize(.small).accessibilityLabel("Reading") }
            }
        }
    }

    @ViewBuilder
    private func providerLine(_ provider: ComputeProviderFacts, _ p: Palette) -> some View {
        let busy = model.isBusy(ComputeModel.providerKey(provider.name)) || model.running != nil
        let issue = model.issue(for: provider)
        let head = HStack(alignment: .center, spacing: MetistrySpace.s2) {
            // The switch carries the name: off = not searched, not offered. A
            // checkbox, not `.switch`: SwiftUI on the Mac gives the switch's
            // AppKit control no name (measured — label, `.accessibilityLabel`
            // and a string title all leave it empty), and §2.18.7 is the rule.
            Toggle(provider.name, isOn: Binding(get: { provider.enabled }, set: { model.proposeSwitch(provider, on: $0) }))
                .metistryText(.headline, p, provider.enabled ? .textPrimary : .textSecondary)
            .help(provider.enabled ? "On: searched and offered" : "Off: not searched, not offered")
            .disabled(busy)
            TagText(tag: provider.tag)
            if let issue {
                Text(issue.label).metistryText(.caption1, p, issue.replacesKey ? .failed : .degraded)
            }
        }
        let actions = HStack(spacing: MetistrySpace.s2) {
            if let issue {
                Button(issue.actionLabel) {
                    if issue.replacesKey { onReplaceKey() } else { Task { await model.testProvider(provider.name) } }
                }
                .disabled(busy)
            }
            Button("Test") { Task { await model.testProvider(provider.name) } }
                .disabled(busy)
            Button {
                model.openGear(provider)
            } label: {
                Image(systemName: "gearshape")
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("\(provider.name) settings")
            .help("Base URL, key, billing")
            .disabled(busy)
            Button("Remove") { model.proposeRemove(provider) }
                .disabled(busy)
        }
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: MetistrySpace.s2) {
                    head
                    Spacer(minLength: MetistrySpace.s2)
                    actions
                }
                VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                    head
                    actions
                }
            }
            if let test = model.tests[provider.name] {
                HStack(alignment: .top, spacing: MetistrySpace.s2) {
                    StatusDot(test.status)
                    Text(test.detail)
                        .metistryText(.caption1, p, test.ok ? .textSecondary : .failed)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    // MARK: - 3 · Your Models

    @ViewBuilder
    private func yourModelsSection(_ p: Palette) -> some View {
        SettingsSection("Your Models") {
            capacity(p)
            SettingsControls {
                TextField("Search models", text: Binding(get: { model.query }, set: { model.query = $0 }), prompt: Text("Search every provider's models"))
                    .textFieldStyle(.roundedBorder)
                    .frame(minWidth: 200)
                Button("Refresh") { Task { await model.refreshCatalogues() } }
                    .help("Read every switched-on provider's catalogue again")
                    .disabled(model.cataloguePhase == .reading)
                if model.cataloguePhase == .reading || model.resultsPhase == .reading {
                    ProgressView().controlSize(.small).accessibilityLabel("Reading catalogues")
                }
            }
            ForEach(model.catalogueNotes) { note in
                HStack(alignment: .top, spacing: MetistrySpace.s2) {
                    StatusDot(note.silent ? .degraded : .absent)
                    Text(note.words)
                        .metistryText(.caption1, p, note.silent ? .degraded : .textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if note.silent {
                        Spacer(minLength: 0)
                        Button("Retry") { Task { await model.refreshCatalogues() } }
                    }
                }
            }
            if case .unavailable(let why) = model.cataloguePhase {
                Text("The catalogue could not be read: \(why)")
                    .metistryText(.caption1, p, .failed)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if model.query.trimmingCharacters(in: .whitespaces).isEmpty {
                modelList(p)
            } else {
                searchResults(p)
            }
            if !model.installableProviders.isEmpty {
                Button("Install a Model…") { model.beginInstall() }
                    .disabled(model.running != nil)
            }
            Text("Removing a model from this Mac is not in this build: `metistry compute models` has no remove verb yet — LM Studio and Ollama remove their own.")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private func capacity(_ p: Palette) -> some View {
        let physical = model.physicalMemory
        let headroom = MemoryHeadroom.headroomBytes(physical: physical)
        CapacityBar(
            title: "Memory",
            fraction: physical == 0 ? 0 : 1 - Double(headroom) / Double(physical),
            words: "\(MemoryHeadroom.gigabytes(headroom)) GB of \(MemoryHeadroom.gigabytes(physical)) GB free for a model (an estimate)"
        )
        if let disk = model.diskCapacity() {
            CapacityBar(
                title: "Disk",
                fraction: disk.usedFraction,
                words: "\(DiskCapacity.gigabytes(disk.availableBytes)) GB of \(DiskCapacity.gigabytes(disk.totalBytes)) GB free"
            )
        }
    }

    /// No search: one line each, *On this Mac* then *Cloud*.
    @ViewBuilder
    private func modelList(_ p: Palette) -> some View {
        let groups = model.yourModels
        if groups.onThisMac.isEmpty && groups.cloud.isEmpty && model.cataloguePhase == .read {
            Text("No models yet: switch on a provider, or add one.")
                .metistryText(.footnote, p, .textSecondary)
        }
        if !groups.onThisMac.isEmpty {
            Text("On this Mac").metistryText(.subhead, p, .textSecondary).accessibilityAddTraits(.isHeader)
            ForEach(groups.onThisMac) { line in modelRow(line, p) }
        }
        if !groups.cloud.isEmpty {
            Text("Cloud").metistryText(.subhead, p, .textSecondary).accessibilityAddTraits(.isHeader)
            ForEach(groups.cloud) { line in modelRow(line, p) }
        }
    }

    @ViewBuilder
    private func modelRow(_ line: ComputeModelLine, _ p: Palette) -> some View {
        let loads = model.server(for: line.provider)?.canLoad == true
        ViewThatFits(in: .horizontal) {
            HStack(spacing: MetistrySpace.s2) {
                ModelLineText(line: line)
                if loads { loadButtons(line) }
            }
            VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                ModelLineText(line: line)
                if loads { HStack(spacing: MetistrySpace.s2) { loadButtons(line) } }
            }
        }
    }

    @ViewBuilder
    private func loadButtons(_ line: ComputeModelLine) -> some View {
        Button("Load") { model.proposeLoad(line, unload: false) }
            .accessibilityLabel("Load \(line.name)")
            .disabled(model.running != nil)
        Button("Unload") { model.proposeLoad(line, unload: true) }
            .accessibilityLabel("Unload \(line.name)")
            .disabled(model.running != nil)
    }

    /// A search: grouped by model (C131), filtered and sorted.
    @ViewBuilder
    private func searchResults(_ p: Palette) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: MetistrySpace.s2) { filterControls(p) }
            VStack(alignment: .leading, spacing: MetistrySpace.s2) { filterControls(p) }
        }
        Picker("Sort", selection: Binding(get: { model.sort }, set: { model.sort = $0 })) {
            ForEach(CatalogueSort.allCases) { Text($0.label).tag($0) }
        }
        .pickerStyle(.menu)
        .fixedSize()
        if let noMatch = model.noMatch {
            Text(noMatch).metistryText(.footnote, p, .textSecondary)
        }
        if case .unavailable(let why) = model.resultsPhase {
            Text("The search could not be read: \(why)")
                .metistryText(.caption1, p, .failed)
                .fixedSize(horizontal: false, vertical: true)
        }
        ForEach(model.visibleResults) { result in
            SearchResultView(result: result, model: model)
        }
    }

    @ViewBuilder
    private func filterControls(_ p: Palette) -> some View {
        ForEach(CatalogueFilter.allCases) { filter in
            Toggle(filter.label, isOn: Binding(
                get: { model.filters.contains(filter) },
                set: { on in if on { model.filters.insert(filter) } else { model.filters.remove(filter) } }
            ))
            .toggleStyle(.button)
        }
        Toggle("Fits This Mac", isOn: .constant(false))
            .toggleStyle(.button)
            .disabled(true)
            .help("Not in this build: nothing serves a model's size yet.")
    }

    // MARK: - 4 · Spending Limits

    @ViewBuilder
    private func limitsSection(_ p: Palette) -> some View {
        SettingsSection("Spending Limits") {
            if let limits = model.limits {
                if let instance = limits.instance {
                    dollarLimit(label: "This instance", instance, p)
                }
                ForEach(limits.providers.filter { $0.tag != .local || $0.dollar?.action != nil }) { provider in
                    Divider()
                    if let dollar = provider.dollar {
                        dollarLimit(label: provider.name, dollar, p)
                    } else {
                        windowLimit(provider, p)
                    }
                }
                if let projects = limits.projects, !projects.isEmpty {
                    Divider()
                    Text("Projects").metistryText(.subhead, p, .textSecondary).accessibilityAddTraits(.isHeader)
                    ForEach(projects) { project in projectLimit(project, p) }
                    Text("A project's daily budget: at the limit an autonomous project switches to review, and nothing is refused.")
                        .metistryText(.caption1, p, .textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else if model.phase == .read {
                Text("This console does not serve spending limits yet — update the runtime (Settings \u{203A} Updates).")
                    .metistryText(.footnote, p, .textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text(ComputeModel.limitsNote)
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private func dollarLimit(label: String, _ limit: ComputeLimits.Dollar, _ p: Palette) -> some View {
        let key = ComputeModel.limitKey(limit.scope)
        let draft = limitDrafts[limit.scope] ?? LimitDraft()
        let set = { (d: LimitDraft) in limitDrafts[limit.scope] = d }
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                Text(label).metistryText(.headline, p)
                Spacer(minLength: MetistrySpace.s2)
                Text(Self.spent(today: limit.spentToday, month: limit.spentThisMonth))
                    .metistryText(.caption1, p, .textSecondary)
            }
            SettingsControls {
                TextField("Per day", text: Binding(get: { draft.daily }, set: { var d = draft; d.daily = $0; set(d) }), prompt: Text("$ per day"))
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 96)
                TextField("Per month", text: Binding(get: { draft.monthly }, set: { var d = draft; d.monthly = $0; set(d) }), prompt: Text("$ per month"))
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 96)
                Picker("At the limit", selection: Binding(get: { draft.action }, set: { var d = draft; d.action = $0; set(d) })) {
                    ForEach(ComputeBudgetAction.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .accessibilityLabel("\(label): at the limit")
                .fixedSize()
                Button("Save") {
                    Task {
                        await model.setLimit(
                            scope: limit.scope,
                            daily: Double(draft.daily.trimmingCharacters(in: .whitespaces)),
                            monthly: Double(draft.monthly.trimmingCharacters(in: .whitespaces)),
                            action: draft.action
                        )
                    }
                }
                .accessibilityLabel("Save \(label)\u{2019}s limit")
                .disabled(model.isBusy(key))
            }
        }
    }

    @ViewBuilder
    private func windowLimit(_ provider: ComputeLimits.Provider, _ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                Text(provider.name).metistryText(.headline, p)
                TagText(tag: provider.tag)
            }
            Text(Self.windowWords(provider))
                .metistryText(.caption1, p, .textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private func projectLimit(_ project: ComputeLimits.Project, _ p: Palette) -> some View {
        let key = ComputeModel.limitKey("project:\(project.id)")
        let label = project.title ?? project.id
        SettingsControls {
            Text(label).metistryText(.callout, p)
            Text(project.spentToday.map { "\(ComputeModelLine.dollars($0)) today" } ?? "today not known")
                .metistryText(.caption1, p, .textSecondary)
            TextField("Per day", text: Binding(get: { projectDrafts[project.id] ?? "" }, set: { projectDrafts[project.id] = $0 }), prompt: Text("$ per day"))
                .textFieldStyle(.roundedBorder)
                .frame(width: 96)
            Button("Save") {
                guard let daily = Double((projectDrafts[project.id] ?? "").trimmingCharacters(in: .whitespaces)) else { return }
                Task { await model.setProjectBudget(project.id, daily: daily) }
            }
            .accessibilityLabel("Save \(label)\u{2019}s daily budget")
            .disabled(model.isBusy(key) || Double((projectDrafts[project.id] ?? "").trimmingCharacters(in: .whitespaces)) == nil)
        }
    }

    static func spent(today: Double?, month: Double?) -> String {
        guard let today, let month else { return "spend not known" }
        return "\(ComputeModelLine.dollars(today)) today \u{00B7} \(ComputeModelLine.dollars(month)) this month"
    }

    /// A subscription's window is its limit (C133).
    static func windowWords(_ provider: ComputeLimits.Provider) -> String {
        let used = provider.callsToday.map { today in
            " \u{00B7} \(today) \(today == 1 ? "call" : "calls") today, \(provider.callsThisMonth ?? 0) this month"
        } ?? ""
        return "Its plan\u{2019}s window is its limit, enforced by the provider\(used)."
    }

    // MARK: - 5 · Advanced: tiers (Q1)

    @ViewBuilder
    private func advancedSection(_ p: Palette) -> some View {
        SettingsSection("Advanced") {
            DisclosureGroup("Tiers", isExpanded: $tiersShown) {
                VStack(alignment: .leading, spacing: MetistrySpace.s3) {
                    Text("The tiers the router may choose among, each with its model and effort. A request names no model of its own; unnamed and unknown tiers land on the default above.")
                        .metistryText(.caption1, p, .textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                    ForEach(model.tiers) { tier in tierRow(tier, p) }
                    Divider()
                    SettingsControls {
                        TextField("Tier", text: $newTier, prompt: Text("a tier from rules.yaml"))
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 160)
                        ModelMenu(
                            title: "Model",
                            options: model.modelOptions(),
                            selected: newTierRef.isEmpty ? nil : model.line(for: newTierRef),
                            placeholder: "Choose a model"
                        ) { line in newTierRef = line.ref }
                        Button("Add Tier") {
                            let tier = newTier.trimmingCharacters(in: .whitespaces)
                            let ref = newTierRef
                            newTier = ""
                            newTierRef = ""
                            Task { await model.assign(target: tier, ref: ref, effort: .medium) }
                        }
                        .disabled(newTier.trimmingCharacters(in: .whitespaces).isEmpty || newTierRef.isEmpty)
                    }
                }
                .padding(.top, MetistrySpace.s2)
            }
        }
    }

    @ViewBuilder
    private func tierRow(_ tier: ComputeAssignmentFacts, _ p: Palette) -> some View {
        let effort = ComputeEffort(rawValue: tier.effort) ?? .medium
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            Text(tier.target).metistryText(.mono, p)
            ModelMenu(
                title: "Model",
                options: model.modelOptions(including: tier.ref),
                selected: model.line(for: tier.ref),
                placeholder: "Choose a model"
            ) { line in
                Task { await model.assign(target: tier.target, ref: line.ref, effort: effort) }
            }
            SettingsControls {
                Picker("Effort", selection: Binding(
                    get: { effort },
                    set: { new in Task { await model.assign(target: tier.target, ref: tier.ref, effort: new) } }
                )) {
                    ForEach(ComputeEffort.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .accessibilityLabel("\(tier.target) effort")
                .fixedSize()
                Button("Remove") { Task { await model.unassign(target: tier.target) } }
                    .accessibilityLabel("Remove the \(tier.target) tier")
                    .disabled(model.isBusy(ComputeModel.assignKey(tier.target)))
            }
        }
    }

    // MARK: - Drafts

    /// Seed every limit editor from the read, discarding what was half-typed:
    /// after a write, the read is what the row must show.
    private func seedDrafts() {
        guard let limits = model.limits else { return }
        var seeded: [String: LimitDraft] = [:]
        let dollars = [limits.instance].compactMap { $0 } + limits.providers.compactMap(\.dollar)
        for limit in dollars {
            seeded[limit.scope] = LimitDraft(
                daily: limit.dailyUSD.map(ComputeBudgetFacts.money) ?? "",
                monthly: limit.monthlyUSD.map(ComputeBudgetFacts.money) ?? "",
                action: limit.action ?? .stop
            )
        }
        limitDrafts = seeded
        var projects: [String: String] = [:]
        for project in limits.projects ?? [] {
            projects[project.id] = project.dailyUSD.map(ComputeBudgetFacts.money) ?? ""
        }
        projectDrafts = projects
    }
}

// MARK: - A model, on screen

/// **name** maker · provider · tag, and the price on the right — the one
/// rendering of `ComputeModelLine` (screen-15 §5.3).
public struct ModelLineText: View {
    @Environment(\.colorScheme) private var scheme
    let line: ComputeModelLine

    public init(line: ComputeModelLine) {
        self.line = line
    }

    public var body: some View {
        let p = Palette(scheme)
        HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
            (Text(line.name).fontWeight(.semibold) + Text(" \(line.detail)").foregroundStyle(p[.textSecondary]))
                .metistryText(.callout, p)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: MetistrySpace.s2)
            if let price = line.price {
                Text(price).metistryText(.caption1, p, .textSecondary)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(line.spoken)
    }
}

/// The dropdown that picks a model: the whole line in its field and in its
/// menu, grouped *On this Mac*, *Cloud*, with the price on the right.
struct ModelMenu: View {
    let title: String
    let options: [ComputeModelLine]
    let selected: ComputeModelLine?
    let placeholder: String
    let pick: (ComputeModelLine) -> Void

    var body: some View {
        let local = options.filter { $0.tag.runsOnThisMac }
        let cloud = options.filter { !$0.tag.runsOnThisMac }
        Picker(title, selection: Binding(
            get: { selected?.ref ?? "" },
            set: { ref in if let line = options.first(where: { $0.ref == ref }), ref != selected?.ref { pick(line) } }
        )) {
            if selected == nil {
                Text(options.isEmpty ? "No models yet: switch on a provider, or add one" : placeholder).tag("")
            }
            if !local.isEmpty {
                SwiftUI.Section("On this Mac") { ForEach(local) { Text(Self.menuText($0)).tag($0.ref) } }
            }
            if !cloud.isEmpty {
                SwiftUI.Section("Cloud") { ForEach(cloud) { Text(Self.menuText($0)).tag($0.ref) } }
            }
        }
        .pickerStyle(.menu)
    }

    /// The same words as `ModelLineText`, as a menu can hold them.
    static func menuText(_ line: ComputeModelLine) -> String {
        line.price.map { "\(line.text)    \($0)" } ?? line.text
    }
}

/// A provider's one tag: *Local* · *Cloud* · *Subscription*.
struct TagText: View {
    @Environment(\.colorScheme) private var scheme
    let tag: ComputeTag

    var body: some View {
        let p = Palette(scheme)
        Text(tag.label)
            .metistryText(.caption2, p, .textSecondary)
            .padding(.horizontal, MetistrySpace.s2)
            .padding(.vertical, 1)
            .background(p[.sunken], in: Capsule())
    }
}

/// Memory or disk: a bar and what it means, spoken as one sentence.
struct CapacityBar: View {
    @Environment(\.colorScheme) private var scheme
    let title: String
    let fraction: Double
    let words: String

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            HStack(alignment: .firstTextBaseline) {
                Text(title).metistryText(.caption2, p, .textSecondary)
                Spacer(minLength: MetistrySpace.s2)
                Text(words).metistryText(.caption1, p, .textSecondary).multilineTextAlignment(.trailing)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(p[.sunken])
                    Capsule().fill(p[fraction > 0.9 ? .degraded : .accent]).frame(width: geo.size.width * min(max(fraction, 0), 1))
                }
            }
            .frame(height: 6)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title): \(words)")
    }
}

/// One search result, grouped by model: collapsed, *Local or cloud · from
/// $0.10 per M*; open, one line per place (C131).
struct SearchResultView: View {
    @Environment(\.colorScheme) private var scheme
    let result: ComputeSearchResult
    let model: ComputeModel
    @State private var open = false

    var body: some View {
        let p = Palette(scheme)
        DisclosureGroup(isExpanded: $open) {
            VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                ForEach(Array(zip(result.lines, result.places)), id: \.0.ref) { line, place in
                    VStack(alignment: .leading, spacing: 2) {
                        ModelLineText(line: line)
                        Text(Self.placeWords(line: line, place: place))
                            .metistryText(.caption1, p, place.cheapest ? .ok : .textTertiary)
                            .fixedSize(horizontal: false, vertical: true)
                        if model.server(for: line.provider)?.canLoad == true {
                            HStack(spacing: MetistrySpace.s2) {
                                Button("Load") { model.proposeLoad(line, unload: false) }
                                    .accessibilityLabel("Load \(line.name)")
                                    .disabled(model.running != nil)
                            }
                        }
                    }
                }
            }
            .padding(.top, MetistrySpace.s1)
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(result.name).metistryText(.headline, p)
                Text(result.facts).metistryText(.caption1, p, .textSecondary).fixedSize(horizontal: false, vertical: true)
                if !open {
                    Text(result.summary).metistryText(.caption1, p, .textTertiary)
                }
            }
            .accessibilityElement(children: .combine)
        }
    }

    /// What a place adds under its line: ZDR and *Cheapest* for a cloud
    /// place, the plan for a subscription's. *Add* on a cloud place, and a
    /// local place's size and fit, are drawn and not served yet.
    static func placeWords(line: ComputeModelLine, place: ComputeCatalogueReply.Place) -> String {
        var parts: [String] = []
        switch line.tag {
        case .local:
            parts.append("on this Mac, free")
        case .subscription:
            parts.append("included in your plan")
        case .cloud:
            if let zdr = place.zdr { parts.append(zdr ? "zero data retention" : "no zero-retention claim") }
        }
        if place.cheapest { parts.append("Cheapest") }
        return parts.joined(separator: " \u{00B7} ")
    }
}

// MARK: - Sheets

/// A provider's gear: base URL, which secret is its key, billing — then Test
/// and Save. Headers and a data policy are drawn and not served: the verb has
/// no flag for either yet.
struct ProviderGearSheet: View {
    @Environment(\.colorScheme) private var scheme
    let model: ComputeModel

    var body: some View {
        let p = Palette(scheme)
        if let draft = model.gear {
            VStack(alignment: .leading, spacing: MetistrySpace.s4) {
                Text("\(draft.name) Settings").metistryText(.title3, p).accessibilityAddTraits(.isHeader)
                LabeledContent("Base URL") {
                    TextField("Base URL", text: Binding(get: { model.gear?.baseURL ?? "" }, set: { model.gear?.baseURL = $0 }), prompt: Text("https://…/v1"))
                        .textFieldStyle(.roundedBorder)
                }
                if draft.tag != .local {
                    LabeledContent("Key") {
                        TextField("Key", text: Binding(get: { model.gear?.secret ?? "" }, set: { model.gear?.secret = $0 }), prompt: Text("the name of one of this instance's secrets"))
                            .textFieldStyle(.roundedBorder)
                    }
                    Text("A secret\u{2019}s NAME, never a value: Settings \u{203A} Secrets holds the value, in the login Keychain.")
                        .metistryText(.caption1, p, .textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                    Picker("Billing", selection: Binding(get: { model.gear?.billing ?? .token }, set: { model.gear?.billing = $0 })) {
                        ForEach(ComputeBilling.allCases) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .fixedSize()
                }
                LabeledContent("Headers") {
                    Text("Not in this build").metistryText(.callout, p, .textTertiary)
                }
                LabeledContent("Data policy") {
                    Text(draft.zdr == true ? "Claims zero data retention" : "No zero-retention claim")
                        .metistryText(.callout, p, .textSecondary)
                }
                Text("Headers and a data policy (ZDR only \u{00B7} Any) are not in this build: `metistry compute providers set` has no flag for either yet.")
                    .metistryText(.caption1, p, .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
                if let command = model.gear?.command {
                    Text((["metistry"] + command.arguments).joined(separator: " "))
                        .metistryText(.mono, p, .textSecondary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack(spacing: MetistrySpace.s3) {
                    Button("Test") { Task { await model.testProvider(draft.name) } }
                    if let test = model.tests[draft.name] {
                        StatusDot(test.status)
                        Text(test.detail).metistryText(.caption1, p, test.ok ? .textSecondary : .failed).lineLimit(2)
                    }
                    Spacer(minLength: 0)
                    Button("Cancel") { model.gear = nil }
                    Button("Save") { model.proposeGearSave() }
                        .keyboardShortcut(.defaultAction)
                        .disabled(model.gear?.command == nil)
                }
            }
            .padding(MetistrySpace.s5)
            .frame(width: 520)
            .background(p[.bg])
        }
    }
}

/// *Install a Model…*: which local server, which model — then the confirmed
/// verb, with this Mac's disk and memory said before it runs.
struct InstallModelSheet: View {
    @Environment(\.colorScheme) private var scheme
    let model: ComputeModel

    var body: some View {
        let p = Palette(scheme)
        let provider = model.install?.provider ?? ""
        VStack(alignment: .leading, spacing: MetistrySpace.s4) {
            Text("Install a Model").metistryText(.title3, p).accessibilityAddTraits(.isHeader)
            Picker("Server", selection: Binding(get: { model.install?.provider ?? "" }, set: { model.install?.provider = $0 })) {
                ForEach(model.installableProviders, id: \.self) { Text($0).tag($0) }
            }
            .pickerStyle(.menu)
            LabeledContent("Model") {
                TextField("Model", text: Binding(get: { model.install?.model ?? "" }, set: { model.install?.model = $0 }), prompt: Text("the model, as the server names it"))
                    .textFieldStyle(.roundedBorder)
            }
            if let server = model.server(for: provider) {
                Text(server.installHint)
                    .metistryText(.caption1, p, .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text("\(model.diskNote) \(model.memoryNote)")
                .metistryText(.caption1, p, .textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: MetistrySpace.s3) {
                Spacer(minLength: 0)
                Button("Cancel") { model.install = nil }
                Button("Continue") { model.proposeInstall() }
                    .keyboardShortcut(.defaultAction)
                    .disabled((model.install?.model ?? "").trimmingCharacters(in: .whitespaces).isEmpty || provider.isEmpty)
            }
        }
        .padding(MetistrySpace.s5)
        .frame(width: 480)
        .background(p[.bg])
    }
}

/// The add-a-provider sheet: a template, where it lives, and — where the
/// template needs one — a key that goes to stdin and nowhere else.
///
/// It is bound to `ComputeStepModel`, the WIZARD's step 7 model, on purpose.
/// One model owns the key's path to a child process, so there is one place to
/// read to know the app never puts it in argv, a file or a log. Both commands
/// are on the sheet before its button runs them.
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
            Text("Add a Provider").metistryText(.title3, p).accessibilityAddTraits(.isHeader)

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
                TextField("Name", text: Binding(get: { draft.providerName }, set: { draft.providerName = $0 }), prompt: Text(draft.template.rawValue))
                    .textFieldStyle(.roundedBorder)
            }
            LabeledContent("Base URL") {
                TextField("Base URL", text: Binding(get: { draft.baseURL }, set: { draft.baseURL = $0 }), prompt: Text("the template's own"))
                    .textFieldStyle(.roundedBorder)
            }
            if draft.template.needsKey {
                LabeledContent("API key") {
                    SecureField("API key", text: Binding(get: { draft.apiKey }, set: { draft.apiKey = $0 }), prompt: Text("pasted here, sent to the command's stdin"))
                        .textFieldStyle(.roundedBorder)
                }
                Text(ComputeStepModel.keyNote)
                    .metistryText(.caption1, p, .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if draft.assignsDefault {
                LabeledContent("Model") {
                    TextField("Model", text: Binding(get: { draft.model }, set: { draft.model = $0 }), prompt: Text("the model id, as the provider knows it"))
                        .textFieldStyle(.roundedBorder)
                }
                Text("This install has no engine yet, so this provider also becomes the default model — the second command below.")
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

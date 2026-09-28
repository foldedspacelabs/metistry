// Work ▸ Projects (design-build-plan T6-8; screen-13-projects.md, C83, C94).
//
// THE LIST (§1): one row per project — its name, then its MODE, read first
// after the name; its agents; its work (open · blocked); today's spend against
// its budget, as a line and a bar; its last activity. ↩ opens a project; ⌘O
// opens its folder in Obsidian (components-02 §1: the list keys and ⌘O).
// Projects appear on first use, so the empty list leads to the Board — there
// is no New Project (plan §1.4).
//
// A PROJECT (§2): the header — name, mode chip, the Review toggle, and a
// footnote (*$5 a day · 20 handoffs at once*, *review since 2:40 PM (over
// budget)*); over budget, one sentence saying when, why and what changed, with
// Raise Budget (§3; C138: it opens Settings › Compute › Spending limits, where
// a project's daily budget sits beside the instance's). Then In Flight; the
// Permissions every member gets, in the Agents table (C58); the Agents, each
// with only what it holds beyond the project; the recent runs, each opening
// its detail.
//
// THE MODE (C83). A quiet outline for Autonomous; the heavier outline and the
// review mark for a Review the owner chose — weight, nothing is wrong; the
// warning tint and *over budget* only for a Review the budget forced. The
// chip is decided in projects-model.swift (`ProjectModeChip`) and drawn here.
//
// THE CONFIRMATIONS (§4). Back to Autonomous names what it gives back and its
// button takes the destructive role; into Review says how many handoffs will
// wait; adding an agent names exactly what it inherits. Nothing is sent until
// the owner confirms, and the row is read again after.
//
// ACCESSIBILITY (§2.18). A row is one element — *Metistry, Review, 1 agent, 4
// open · 1 blocked, $0.00 today · no budget, active 2 hours ago*; the chip
// speaks its mode in words, never colour alone; every section is a heading;
// every control says its name. Nothing moves, so Reduce Motion has nothing to
// stop. No key is bound here: Open and Open in Obsidian are the Item menu's
// (C119). Text is semantic styles only: the largest size makes a row longer,
// never wider.

import SwiftUI

// MARK: - The screen

public struct ProjectsView: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: ProjectsModel
    let assistantName: String?
    let tickInterval: Duration
    /// Opens a vault path where the owner reads the vault. Nil: ⌘O is dimmed.
    let onOpenInObsidian: ((String) -> Void)?
    /// Raise Budget: Settings › Compute › Spending limits (C138).
    let onRaiseBudget: (() -> Void)?
    /// A run's detail — nil where nothing draws it.
    let onOpenRun: ((Int) -> Void)?
    /// The empty list's way on: the Board, where a task names a project.
    let onGoToBoard: (() -> Void)?

    public init(
        model: ProjectsModel,
        assistantName: String?,
        tick: Duration = .seconds(15),
        onOpenInObsidian: ((String) -> Void)? = nil,
        onRaiseBudget: (() -> Void)? = nil,
        onOpenRun: ((Int) -> Void)? = nil,
        onGoToBoard: (() -> Void)? = nil
    ) {
        self.model = model
        self.assistantName = assistantName
        self.tickInterval = tick
        self.onOpenInObsidian = onOpenInObsidian
        self.onRaiseBudget = onRaiseBudget
        self.onOpenRun = onOpenRun
        self.onGoToBoard = onGoToBoard
    }

    public var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: 0) {
            ProjectsHeader(model: model)
                .padding(.horizontal, MetistrySpace.s5)
                .padding(.vertical, MetistrySpace.s3)
                .background(p[.surface])
            Divider()
            content(p)
        }
        // Flexible down to nothing, as every screen is: the window's minimum
        // is the shell's to set (#392).
        .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .topLeading)
        .background(p[.surface])
        .shellItemActions(itemActions)
        .sheet(item: $model.confirmation) { pending in
            CostConfirmView(pending.cost) { choice in
                if choice == .confirm {
                    Task { await model.confirm() }
                } else {
                    model.cancel()
                }
            }
            .frame(minWidth: 0, idealWidth: 420, maxWidth: 480)
        }
        .task {
            await model.refreshIfDue()
            while !Task.isCancelled {
                try? await Task.sleep(for: tickInterval)
                if Task.isCancelled { break }
                await model.refreshIfDue()
            }
        }
    }

    @ViewBuilder
    private func content(_ p: Palette) -> some View {
        if let id = model.opened, let project = model.project(id) {
            ProjectsScroll {
                ProjectDetail(model: model, project: project, assistantName: assistantName, onRaiseBudget: onRaiseBudget, onOpenRun: onOpenRun)
            }
        } else {
            switch model.paint {
            case .placeholders(let waiting):
                VStack(alignment: .leading) {
                    PlaceholderRows(count: 4, waitingFor: waiting)
                    Spacer(minLength: 0)
                }
                .padding(MetistrySpace.s4)
            case .failed(let why):
                VStack {
                    StatePanel(
                        StatePanelModel(.failed, title: "Couldn't Read Projects", sentence: "The console didn't answer with the projects.", reason: why, action: StateWords.tryAgain),
                        now: model.now(), clock: model.clock
                    ) { Task { await model.load() } }
                    Spacer(minLength: 0)
                }
            case .content(let staleSince):
                VStack(alignment: .leading, spacing: 0) {
                    if let staleSince {
                        StaleBand(StaleBandModel("Spend", asOf: staleSince, when: .age, action: ProjectsWords.syncNow), now: model.now(), clock: model.clock) {
                            Task { await model.load() }
                        }
                    }
                    if model.list.isEmpty {
                        VStack {
                            StatePanel(
                                StatePanelModel(.empty, title: "No Projects Yet", sentence: ProjectsWords.emptySentence, action: onGoToBoard == nil ? nil : ProjectsWords.openBoard),
                                now: model.now(), clock: model.clock
                            ) { onGoToBoard?() }
                            Spacer(minLength: 0)
                        }
                    } else {
                        ProjectsList(model: model)
                    }
                }
            }
        }
    }

    /// The Item menu: Open (↩) for the selected row, Open in Obsidian (⌘O)
    /// for the project's folder when it has one.
    private var itemActions: ShellActionTable {
        var table: ShellActionTable = [:]
        let id = model.opened ?? model.selection
        guard let id, let project = model.project(id) else { return table }
        if model.opened == nil { table[.open] = { Task { await model.open(id) } } }
        if let area = project.area, let onOpenInObsidian { table[.openInObsidian] = { onOpenInObsidian(area) } }
        return table
    }
}

/// The title, or the way back to the list.
struct ProjectsHeader: View {
    @Environment(\.colorScheme) private var scheme
    let model: ProjectsModel

    var body: some View {
        let p = Palette(scheme)
        HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s3) {
            if model.opened != nil {
                ControlButton(ControlSpec(ProjectsWords.back, glyph: .disclosure, role: .plain, name: "Back to Projects")) { model.back() }
            } else {
                Text(verbatim: ProjectsWords.title)
                    .metistryFont(.title2)
                    .foregroundStyle(p[.textPrimary])
                    .accessibilityAddTraits(.isHeader)
            }
            Spacer(minLength: 0)
        }
    }
}

/// A column at reading width that scrolls.
struct ProjectsScroll<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: MetistrySpace.s6) {
                content()
            }
            .frame(maxWidth: MetistrySize.contentMax, alignment: .leading)
            .padding(MetistrySpace.s5)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

// MARK: - The list

struct ProjectsList: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: ProjectsModel

    var body: some View {
        let p = Palette(scheme)
        List(selection: $model.selection) {
            ForEach(model.list) { project in
                ProjectRowView(row: ProjectRowWords(project, agents: model.agentCount(project), blocked: model.blockedCount(project.id), now: model.now()))
                    .tag(project.id)
            }
        }
        .listStyle(.inset)
        .scrollContentBackground(.hidden)
        .background(p[.surface])
        .contextMenu(forSelectionType: String.self) { ids in
            if let id = ids.first {
                Button("Open") { Task { await model.open(id) } }
            }
        } primaryAction: { ids in
            if let id = ids.first { Task { await model.open(id) } }
        }
        .shellListFocus()
        .accessibilityLabel(Text(verbatim: ProjectsWords.title))
    }
}

/// One row's words, decided — what the row draws and what VoiceOver says.
public struct ProjectRowWords: Sendable, Equatable {
    public let name: String
    public let chip: ProjectModeChip
    /// *1 agent · 4 open · 1 blocked · active 2 hours ago*.
    public let facts: String
    public let spend: ProjectSpend

    public init(_ p: ProjectRecord, agents: Int, blocked: Int?, now: Date) {
        name = p.name
        chip = ProjectModeChip(ProjectMode(p))
        facts = ([ProjectsWords.agentCount(agents), ProjectsWords.work(p, blocked: blocked)] + (ProjectsWords.lastActive(p.lastActivity, now: now).map { [$0] } ?? [])).joined(separator: " · ")
        spend = ProjectSpend(spent: p.spendTodayUSD, budget: p.dailyBudgetUSD)
    }

    /// The whole row, as one sentence: the mode is said in words.
    public var spoken: String {
        [name, chip.spoken, facts.replacingOccurrences(of: " · ", with: ", "), spend.spoken].joined(separator: ", ")
    }
}

struct ProjectRowView: View {
    @Environment(\.colorScheme) private var scheme
    let row: ProjectRowWords

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            FlowLayout(spacing: MetistrySpace.s2) {
                Text(verbatim: row.name)
                    .metistryFont(.headline)
                    .foregroundStyle(p[.textPrimary])
                    .fixedSize(horizontal: false, vertical: true)
                ProjectModeChipView(chip: row.chip)
            }
            Text(verbatim: row.facts)
                .metistryFont(.subhead)
                .foregroundStyle(p[.textSecondary])
                .fixedSize(horizontal: false, vertical: true)
            ProjectSpendView(spend: row.spend)
        }
        .padding(.vertical, MetistrySpace.s1)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: row.spoken))
    }
}

// MARK: - The chip and the bar

struct ProjectModeChipView: View {
    @Environment(\.colorScheme) private var scheme
    let chip: ProjectModeChip

    var body: some View {
        let p = Palette(scheme)
        HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s1) {
            if let glyph = chip.glyph {
                Image(systemName: glyph.rawValue)
                    .foregroundStyle(p[chip.glyphInk ?? chip.ink])
                    .accessibilityHidden(true)
            }
            Text(verbatim: chip.text)
                .foregroundStyle(p[chip.ink])
                .fixedSize(horizontal: false, vertical: true)
        }
        .metistryFont(.caption1, weight: chip.weight)
        .padding(.horizontal, MetistrySpace.s2)
        .padding(.vertical, 2)
        .background(chip.plate.map { p[$0] } ?? .clear, in: Capsule())
        .overlay(Capsule().strokeBorder(p[chip.outline], lineWidth: chip.outlineWidth))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: chip.spoken))
    }
}

struct ProjectSpendView: View {
    @Environment(\.colorScheme) private var scheme
    let spend: ProjectSpend

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: spend.line)
                .metistryFont(.subhead)
                .monospacedDigit()
                .foregroundStyle(p[.textSecondary])
                .fixedSize(horizontal: false, vertical: true)
            if let fraction = spend.fraction {
                UsageMeter(fraction: fraction, ink: spend.barInk)
                    .frame(maxWidth: 240)
                    .accessibilityHidden(true)
            }
        }
    }
}

// MARK: - A project

struct ProjectDetail: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: ProjectsModel
    let project: ProjectRecord
    let assistantName: String?
    let onRaiseBudget: (() -> Void)?
    let onOpenRun: ((Int) -> Void)?
    /// Add Agent is open, listing who could join.
    @State private var choosing = false

    var body: some View {
        let p = Palette(scheme)
        let mode = ProjectMode(project)
        VStack(alignment: .leading, spacing: MetistrySpace.s6) {
            header(p, mode)
            inFlight(p)
            permissions(p)
            agents(p)
            recentRuns(p)
        }
    }

    // MARK: The header (§2, §3)

    @ViewBuilder
    private func header(_ p: Palette, _ mode: ProjectMode) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: MetistrySpace.s3) {
                    title(p)
                    ProjectModeChipView(chip: ProjectModeChip(mode))
                    Spacer(minLength: MetistrySpace.s2)
                    toggle(mode)
                }
                VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                    title(p)
                    ProjectModeChipView(chip: ProjectModeChip(mode))
                    toggle(mode)
                }
            }
            Text(verbatim: ProjectsWords.budgetLine(project))
                .metistryFont(.footnote)
                .monospacedDigit()
                .foregroundStyle(p[.textSecondary])
                .fixedSize(horizontal: false, vertical: true)
            if let since = ProjectsWords.sinceLine(project, now: model.now(), clock: model.clock) {
                Text(verbatim: since)
                    .metistryFont(.footnote)
                    .foregroundStyle(p[.textSecondary])
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let sentence = ProjectsWords.overBudgetSentence(project, now: model.now(), clock: model.clock) {
                FlowLayout(spacing: MetistrySpace.s3) {
                    Text(verbatim: sentence)
                        .metistryFont(.body)
                        .foregroundStyle(p[.textPrimary])
                        .fixedSize(horizontal: false, vertical: true)
                    if let onRaiseBudget {
                        ControlButton(ControlSpec(ProjectsWords.raiseBudget, role: .secondary), action: onRaiseBudget)
                            .accessibilityHint(Text(verbatim: "Opens Settings, Compute, Spending limits"))
                    }
                }
            }
            if let reason = model.decisionsUnavailableReason {
                Text(verbatim: reason)
                    .metistryFont(.footnote)
                    .foregroundStyle(p[.textSecondary])
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let notice = model.notice {
                Text(verbatim: notice)
                    .metistryFont(.callout)
                    .foregroundStyle(p[.textPrimary])
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func title(_ p: Palette) -> some View {
        Text(verbatim: project.name)
            .metistryFont(.title2)
            .foregroundStyle(p[.textPrimary])
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader)
    }

    /// The kill switch: on is Review. Flipping it asks first (§4); it stays
    /// where it was until the console says otherwise.
    private func toggle(_ mode: ProjectMode) -> some View {
        Toggle(isOn: Binding(get: { mode.isReview }, set: { model.requestMode(review: $0, for: project) })) {
            Text(verbatim: ProjectsWords.review)
        }
        .toggleStyle(ProjectReviewSwitchStyle())
        .fixedSize()
        .disabled(!model.allowsDecisions || model.isActing)
        .help(mode.isReview ? "Set back to Autonomous" : "Set to Review — handoffs between its agents come to you")
    }

    // MARK: In flight

    @ViewBuilder
    private func inFlight(_ p: Palette) -> some View {
        let blocked = model.blockedCount(project.id)
        let spend = ProjectSpend(spent: project.spendTodayUSD, budget: project.dailyBudgetUSD)
        let facts: [(String, String)] = [
            ("Open", "\(project.openTasks)"),
            ("Blocked", blocked.map(String.init) ?? "—"),
            ("Handoffs in flight", "\(project.bundlesInFlight) of \(project.maxOpenBundles)"),
            ("Queued", "\(project.bundlesQueued)"),
            ("Open threads", "\(project.openThreads)"),
        ]
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            heading(ProjectsWords.inFlight, p)
            ForEach(facts, id: \.0) { fact in
                ProjectFactRow(label: fact.0, value: fact.1)
            }
            VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                Text(verbatim: "Spent today")
                    .metistryFont(.body)
                    .foregroundStyle(p[.textSecondary])
                ProjectSpendView(spend: spend)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(verbatim: "Spent today, \(spend.spoken)"))
        }
    }

    // MARK: Permissions (C58)

    @ViewBuilder
    private func permissions(_ p: Palette) -> some View {
        let rows = project.grants.rows
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            if rows.isEmpty {
                heading(ProjectsWords.permissions, p)
                caption(ProjectsWords.everyMemberGetsThese, p)
                Text(verbatim: ProjectsWords.grantsNothing)
                    .metistryFont(.callout)
                    .foregroundStyle(p[.textSecondary])
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                caption(ProjectsWords.everyMemberGetsThese, p)
                PermissionsTable(rows)
            }
        }
    }

    // MARK: Agents

    @ViewBuilder
    private func agents(_ p: Palette) -> some View {
        let members = model.members(of: project)
        let candidates = model.candidates(for: project)
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                heading(ProjectsWords.agents, p)
                Spacer(minLength: MetistrySpace.s2)
                ControlButton(ControlSpec(ProjectsWords.addAgent, glyph: choosing ? .disclosureOpen : .disclosure, role: .secondary, name: ProjectsWords.addAgent)) {
                    choosing.toggle()
                }
                .disabled(candidates.isEmpty || !model.allowsDecisions || model.isActing)
                .help(candidates.isEmpty ? ProjectsWords.noCandidates : "Joining is a grant — you'll see what it inherits first")
            }
            if choosing, !candidates.isEmpty {
                // Each connected agent that could join; choosing one asks first,
                // naming what it would inherit (§4).
                FlowLayout(spacing: MetistrySpace.s2) {
                    ForEach(candidates) { agent in
                        let name = agent.displayName ?? agent.id
                        ControlButton(ControlSpec(name, role: .plain, name: "Add \(name)")) {
                            choosing = false
                            model.requestAdd(agent, to: project)
                        }
                    }
                }
            }
            if members.isEmpty {
                Text(verbatim: ProjectsWords.noMembers)
                    .metistryFont(.callout)
                    .foregroundStyle(p[.textSecondary])
            }
            ForEach(members) { member in
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: member.name)
                        .metistryFont(.body, weight: .medium)
                        .foregroundStyle(p[.textPrimary])
                    Text(verbatim: member.line)
                        .metistryFont(.subhead)
                        .foregroundStyle(p[.textSecondary])
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Text(verbatim: member.spoken))
            }
            if let own = model.ownAgent(of: project) {
                Text(verbatim: ProjectsWords.ownAgentLine(assistantName ?? own.displayName ?? own.id))
                    .metistryFont(.callout)
                    .foregroundStyle(p[.textSecondary])
                    .fixedSize(horizontal: false, vertical: true)
            }
            if candidates.isEmpty, !(model.agents.section.value ?? []).isEmpty {
                Text(verbatim: ProjectsWords.noCandidates)
                    .metistryFont(.footnote)
                    .foregroundStyle(p[.textSecondary])
            }
        }
    }

    // MARK: Recent runs

    @ViewBuilder
    private func recentRuns(_ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            heading(ProjectsWords.recentRuns, p)
            switch model.runs[project.id] ?? .waiting {
            case .waiting:
                Text(verbatim: "Reading its runs…")
                    .metistryFont(.callout)
                    .foregroundStyle(p[.textSecondary])
            case .failed(let why):
                Text(verbatim: "Couldn't read its runs: \(why)")
                    .metistryFont(.callout)
                    .foregroundStyle(p[.textSecondary])
                    .fixedSize(horizontal: false, vertical: true)
            case .loaded(let runs):
                if runs.isEmpty {
                    Text(verbatim: ProjectsWords.noRuns)
                        .metistryFont(.callout)
                        .foregroundStyle(p[.textSecondary])
                }
                ForEach(runs) { run in
                    ProjectRunRow(run: run, words: ProjectRunWords(run, now: model.now(), clock: model.clock), onOpen: onOpenRun.map { open in { open(run.runID) } })
                }
            }
        }
    }

    private func heading(_ text: String, _ p: Palette) -> some View {
        Text(verbatim: text)
            .metistryFont(.headline)
            .foregroundStyle(p[.textPrimary])
            .accessibilityAddTraits(.isHeader)
    }

    private func caption(_ text: String, _ p: Palette) -> some View {
        Text(verbatim: text)
            .metistryFont(.footnote)
            .foregroundStyle(p[.textSecondary])
    }
}

/// The Review switch, drawn as a button so it speaks as one control — *Review,
/// on* — and carries the focus ring every custom control does under Full
/// Keyboard Access (§2.18.6). The track fills with accent when on: a choice,
/// never a state colour.
struct ProjectReviewSwitchStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        Button {
            configuration.isOn.toggle()
        } label: {
            HStack(spacing: MetistrySpace.s2) {
                configuration.label
                ProjectSwitchTrack(isOn: configuration.isOn)
            }
        }
        .buttonStyle(Plate())
        .focusEffectDisabled()
        .accessibilityValue(Text(verbatim: configuration.isOn ? "on" : "off"))
        .accessibilityAddTraits(.isToggle)
    }

    struct Plate: ButtonStyle {
        func makeBody(configuration: Configuration) -> some View {
            Label(configuration: configuration)
        }

        struct Label: View {
            @Environment(\.colorScheme) private var scheme
            @Environment(\.isEnabled) private var enabled
            @Environment(\.isFocused) private var focused
            let configuration: ButtonStyle.Configuration

            var body: some View {
                let p = Palette(scheme)
                configuration.label
                    .metistryFont(.body, weight: .medium)
                    .foregroundStyle(p[enabled ? .textPrimary : .textTertiary])
                    .padding(.horizontal, MetistrySpace.s1)
                    .padding(.vertical, 2)
                    .overlay(RoundedRectangle(cornerRadius: MetistryRadius.sm, style: .continuous).inset(by: -3).strokeBorder(focused ? p[.focusRing] : .clear, lineWidth: 2))
                    .contentShape(Rectangle())
            }
        }
    }
}

struct ProjectSwitchTrack: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.isEnabled) private var enabled
    let isOn: Bool

    var body: some View {
        let p = Palette(scheme)
        Capsule()
            .fill(isOn && enabled ? p[.accent] : p[.sunken])
            .overlay(Capsule().strokeBorder(p[.borderControl], lineWidth: 1))
            .overlay(alignment: isOn ? .trailing : .leading) {
                Circle().fill(p[.elevated]).padding(2).overlay(Circle().strokeBorder(p[.borderControl], lineWidth: 1).padding(2))
            }
            .frame(width: 32, height: 18)
            .accessibilityHidden(true)
    }
}

struct ProjectFactRow: View {
    @Environment(\.colorScheme) private var scheme
    let label: String
    let value: String

    var body: some View {
        let p = Palette(scheme)
        HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
            Text(verbatim: label)
                .foregroundStyle(p[.textSecondary])
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: MetistrySpace.s2)
            Text(verbatim: value)
                .foregroundStyle(p[.textPrimary])
                .monospacedDigit()
        }
        .metistryFont(.body)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: "\(label), \(value == "—" ? "not known yet" : value)"))
    }
}

/// A run's line, decided.
public struct ProjectRunWords: Sendable, Equatable {
    /// *2:40 PM · cursor · dispatched to github-issues ok*.
    public let text: String
    public let failed: Bool
    public let spoken: String

    public init(_ run: ProjectRun, now: Date, clock: ClockTime) {
        let when = run.at.map { clock.moment($0, now: now) }
        text = [when, run.actor, run.what.isEmpty ? nil : run.what].compactMap { $0 }.joined(separator: " · ")
        failed = run.ok == false
        spoken = "Run, \(text.replacingOccurrences(of: " · ", with: ", "))\(failed ? ", failed" : "")"
    }
}

struct ProjectRunRow: View {
    @Environment(\.colorScheme) private var scheme
    let run: ProjectRun
    let words: ProjectRunWords
    let onOpen: (() -> Void)?

    var body: some View {
        let p = Palette(scheme)
        let line = HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
            if words.failed {
                Image(systemName: MetistryGlyph.failed.rawValue)
                    .foregroundStyle(p[.failed])
                    .accessibilityHidden(true)
            }
            Text(verbatim: words.text)
                .foregroundStyle(p[.textPrimary])
                .fixedSize(horizontal: false, vertical: true)
                .multilineTextAlignment(.leading)
            Spacer(minLength: 0)
        }
        .metistryFont(.callout)
        if let onOpen {
            Button(action: onOpen) { line.contentShape(Rectangle()) }
                .buttonStyle(MetistryButtonStyle(role: .plain))
                .accessibilityLabel(Text(verbatim: words.spoken))
                .accessibilityHint(Text(verbatim: "Opens the run's detail"))
                .help("Open the run's detail")
        } else {
            line
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Text(verbatim: words.spoken))
        }
    }
}

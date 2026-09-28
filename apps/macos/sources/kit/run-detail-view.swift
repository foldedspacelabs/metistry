// Run detail (design-build-plan T6-10; screen-12-run-detail.md, C78, C79,
// C95). What it reads and decides is run-detail-model.swift.
//
// ONE PAGE FOR ANY RUN, drawn over the screen it was opened from — an
// Activity row, a project's recent runs — with that screen's name as the way
// back, so the sidebar still says where the owner is.
//
// THE CONVERSATION LEADS (§1), at reading width: the definition layer (the
// system prompt as sent) collapsed, the task, the replies in the transcript
// rule (C69), and each tool call where it happened, on the `agent-quiet` wash
// because both what it asked and what it got are agent-side data (P1). A call
// that failed is open, its refusal as its result (§3), so a log line never has
// to be matched to a moment.
//
// THE SIDE COLUMN, in order: what the assistant took from this session (its
// configured name, C88) — above cost and timing, because it is why sessions
// are kept; the run — model, time, tokens, cache, cost; the route, for a
// route record (T9-1); and the tool sequence with proportional durations,
// a failed call in `failed` with its mark. Narrower than both, the side
// column follows the conversation.
//
// THE TRANSCRIPT GONE (components-03 §2): past 30 days the archive answers
// nothing, and the page says so in one line while the run, its cost and its
// tool calls — the ledger's, not the archive's — stay.
//
// ACCESSIBILITY (§2.18). Screen 12 carries no Spoken table, so C121's rules
// stand in for it: every section is a heading; the pill says *failed* in
// words; a call row says its tool and whether it failed, and opening it is a
// button that says so; a tool-sequence row says the tool, its time and its
// outcome (the bars are the chart, and the rows are its table); a taken item
// says its kind, its line, where it lands and its status. Nothing moves, so
// Reduce Motion has nothing to stop. No key is bound here: Open in Obsidian
// (a routine's written file) is the Item menu's (C119). Text is semantic
// styles only, so the largest size makes the page longer, never wider.

import SwiftUI

// MARK: - The page

public struct RunDetailView: View {
    @Environment(\.colorScheme) private var scheme
    let model: RunDetailModel
    let assistantName: String?
    /// Opens a vault path where the owner reads the vault. Nil: ⌘O is dimmed.
    let onOpenPath: ((String) -> Void)?

    public init(model: RunDetailModel, assistantName: String?, onOpenPath: ((String) -> Void)? = nil) {
        self.model = model
        self.assistantName = assistantName
        self.onOpenPath = onOpenPath
    }

    public var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: 0) {
            RunDetailBar(model: model, assistantName: assistantName)
                .padding(.horizontal, MetistrySpace.s5)
                .padding(.vertical, MetistrySpace.s3)
                .background(p[.surface])
            Divider()
            content
        }
        .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .topLeading)
        .background(p[.surface])
        .shellItemActions(itemActions)
        .task(id: model.opening) { await model.load() }
    }

    @ViewBuilder
    private var content: some View {
        switch model.run {
        case .waiting:
            VStack(alignment: .leading) {
                PlaceholderRows(count: 4, waitingFor: model.opening.map { "Reading run \($0.runID)…" })
                Spacer(minLength: 0)
            }
            .padding(MetistrySpace.s4)
        case .failed(let why):
            VStack {
                StatePanel(
                    StatePanelModel(.failed, title: "Couldn't Read This Run", sentence: "The console didn't answer with the run.", reason: why, action: StateWords.tryAgain),
                    now: model.now(), clock: model.clock
                ) { Task { await model.load() } }
                Spacer(minLength: 0)
            }
        case .loaded(let run):
            ScrollView {
                VStack(alignment: .leading, spacing: MetistrySpace.s6) {
                    RunDetailTitle(run: run, assistantName: assistantName, clock: model.clock)
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .top, spacing: MetistrySpace.s8) {
                            RunConversationColumn(model: model, assistantName: assistantName)
                                .frame(minWidth: 320, idealWidth: 520, maxWidth: MetistrySize.contentMax, alignment: .leading)
                            RunSideColumn(model: model, run: run, assistantName: assistantName)
                                .frame(width: 280, alignment: .leading)
                        }
                        VStack(alignment: .leading, spacing: MetistrySpace.s8) {
                            RunConversationColumn(model: model, assistantName: assistantName)
                            RunSideColumn(model: model, run: run, assistantName: assistantName)
                        }
                    }
                }
                .padding(MetistrySpace.s5)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    /// The Item menu: Open in Obsidian (⌘O) for the file a routine run wrote.
    private var itemActions: ShellActionTable {
        var table: ShellActionTable = [:]
        if let path = model.writtenPath, let onOpenPath { table[.openInObsidian] = { onOpenPath(path) } }
        return table
    }
}

/// The way back, and where this page sits: *Activity ▸ Morning Brief ▸ 6:02 AM*.
struct RunDetailBar: View {
    @Environment(\.colorScheme) private var scheme
    let model: RunDetailModel
    let assistantName: String?

    var body: some View {
        let p = Palette(scheme)
        let origin = model.opening?.over.title ?? "Back"
        FlowLayout(spacing: MetistrySpace.s3) {
            ControlButton(ControlSpec(origin, glyph: .undo, role: .plain, name: "Back to \(origin)")) { model.close() }
            Text(verbatim: crumbs(origin))
                .metistryFont(.footnote)
                .foregroundStyle(p[.textSecondary])
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func crumbs(_ origin: String) -> String {
        var parts = [origin]
        if let run = model.detail {
            parts.append(RunDetailWords.title(run, assistantName: assistantName))
            if let at = WireTime.date(run.ts) { parts.append(model.clock.moment(at, now: model.now())) }
        }
        return parts.joined(separator: " ▸ ")
    }
}

/// The title, the pill, the day — and, for a failed run, the failure in one sentence (§3).
struct RunDetailTitle: View {
    @Environment(\.colorScheme) private var scheme
    let run: RunDetail
    let assistantName: String?
    let clock: ClockTime

    var body: some View {
        let p = Palette(scheme)
        let pill = RunPill(run.ok)
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            FlowLayout(spacing: MetistrySpace.s3) {
                Text(verbatim: RunDetailWords.title(run, assistantName: assistantName))
                    .metistryFont(.title2)
                    .foregroundStyle(p[.textPrimary])
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                MarkView(Mark(pill.text, glyph: pill.glyph, style: .caption1, weight: .medium, ink: pill.ink, plate: pill.plate, on: .surface, shape: .chip, spoken: pill.text))
                if let at = WireTime.date(run.ts) {
                    Text(verbatim: RunDetailWords.when(at, clock: clock))
                        .metistryFont(.subhead)
                        .monospacedDigit()
                        .foregroundStyle(p[.textSecondary])
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if let failure = RunDetailWords.failure(run) {
                Text(verbatim: failure)
                    .metistryFont(.body)
                    .foregroundStyle(p[.textPrimary])
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
    }
}

// MARK: - The conversation

struct RunConversationColumn: View {
    @Environment(\.colorScheme) private var scheme
    let model: RunDetailModel
    let assistantName: String?
    /// Entries the owner opened or closed against their default: a failed
    /// call starts open (§3), everything else closed.
    @State private var toggled: Set<String> = []

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s4) {
            RunHeading(RunDetailWords.conversation)
            switch model.conversation {
            case .waiting:
                Text(verbatim: RunDetailWords.reading)
                    .metistryFont(.callout)
                    .foregroundStyle(p[.textSecondary])
            case .notKept:
                MarkView(Mark(RunDetailWords.notKept, glyph: .empty, style: .callout, ink: .textSecondary, on: .surface))
            case .gone(let expired):
                MarkView(Mark(expired ? RunDetailWords.expired : RunDetailWords.purged, glyph: .stale, style: .callout, ink: .textSecondary, on: .surface))
            case .failed(let why):
                VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                    MarkView(Mark("Couldn't read the conversation: \(why)", glyph: .failed, style: .callout, ink: .failed, on: .surface))
                    ControlButton(ControlSpec(StateWords.tryAgain)) { Task { await model.load() } }
                }
            case .loaded:
                let entries = model.entries
                if entries.isEmpty {
                    Text(verbatim: "The archive kept no messages for this turn.")
                        .metistryFont(.callout)
                        .foregroundStyle(p[.textSecondary])
                }
                ForEach(entries) { entry in
                    row(entry)
                }
            }
        }
        // The transcript rule hangs in the gutter, outside the measure (C69).
        .padding(.leading, AgentProse.gutter)
    }

    @ViewBuilder
    private func row(_ entry: RunConversationEntry) -> some View {
        switch entry {
        case .definition(let id, let prompt):
            RunLayer(title: RunDetailWords.definition, detail: "The system prompt as sent · \(prompt.split(whereSeparator: \.isWhitespace).count) words", isOpen: isOpen(id, byDefault: false), toggle: { toggle(id) }) {
                RunMonoBlock(text: RunConversation.clip(prompt), ground: .sunken)
            }
        case .task(_, let text, let at):
            RunTaskView(text: text, at: at, clock: model.clock)
        case .reply(_, let text, let at):
            AgentProse(AgentProseModel(treatment: .rule, author: AgentChipModel(agentID: AgentChipModel.assistantPrincipal, assistantName: assistantName ?? ""), text: text, at: at), on: .surface, clock: model.clock)
        case .call(let id, let call):
            RunCallView(call: call, isOpen: isOpen(id, byDefault: call.failed), toggle: { toggle(id) })
        case .toolText(_, let text):
            VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                RunCaption(RunDetailWords.got)
                RunMonoBlock(text: text, ground: .agentQuiet)
            }
            .accessibilityElement(children: .combine)
        }
    }

    private func isOpen(_ id: String, byDefault open: Bool) -> Bool { open != toggled.contains(id) }

    private func toggle(_ id: String) {
        if toggled.contains(id) { toggled.remove(id) } else { toggled.insert(id) }
    }
}

/// A collapsible layer: its name, a line about it, and what it holds.
struct RunLayer<Content: View>: View {
    @Environment(\.colorScheme) private var scheme
    let title: String
    let detail: String
    let isOpen: Bool
    let toggle: () -> Void
    @ViewBuilder let content: () -> Content

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            Button(action: toggle) {
                HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                    Image(systemName: (isOpen ? MetistryGlyph.disclosureOpen : .disclosure).rawValue)
                        .foregroundStyle(p[.textSecondary])
                        .accessibilityHidden(true)
                    Text(verbatim: title.uppercased())
                        .metistryFont(.caption1, weight: .semibold)
                        .foregroundStyle(p[.textSecondary])
                    Text(verbatim: detail)
                        .metistryFont(.caption1)
                        .foregroundStyle(p[.textSecondary])
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(MetistryButtonStyle(role: .plain))
            .accessibilityLabel(Text(verbatim: "\(title), \(detail)"))
            .accessibilityValue(Text(verbatim: isOpen ? "open" : "closed"))
            .help(isOpen ? "Close \(title)" : "Open \(title)")
            if isOpen { content() }
        }
    }
}

/// What the turn was asked to do (§1: *TASK · MORNING BRIEF*).
struct RunTaskView: View {
    @Environment(\.colorScheme) private var scheme
    let text: String
    let at: Date?
    let clock: ClockTime

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            HStack(alignment: .firstTextBaseline) {
                RunCaption(RunDetailWords.task)
                Spacer(minLength: MetistrySpace.s2)
                if let at {
                    Text(verbatim: clock.time(at))
                        .metistryFont(.caption1)
                        .monospacedDigit()
                        .foregroundStyle(p[.textSecondary])
                }
            }
            Text(verbatim: text)
                .metistryFont(.body)
                .foregroundStyle(p[.textPrimary])
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .padding(MetistrySpace.s3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .overlay(RoundedRectangle(cornerRadius: MetistryRadius.md, style: .continuous).strokeBorder(p[.border], lineWidth: 1))
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: "\(RunDetailWords.task), \(text)"))
    }
}

/// One tool call in the conversation: closed, its tool; open, what it asked
/// and what it got — on the `agent-quiet` wash (P1).
struct RunCallView: View {
    @Environment(\.colorScheme) private var scheme
    let call: RunCallEntry
    let isOpen: Bool
    let toggle: () -> Void

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            Button(action: toggle) {
                HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                    Image(systemName: (isOpen ? MetistryGlyph.disclosureOpen : .disclosure).rawValue)
                        .foregroundStyle(p[.textSecondary])
                        .accessibilityHidden(true)
                    if call.failed {
                        Image(systemName: MetistryGlyph.failed.rawValue)
                            .foregroundStyle(p[.failed])
                            .accessibilityHidden(true)
                    }
                    Text(verbatim: call.tool)
                        .metistryFont(.callout, design: .mono)
                        .foregroundStyle(p[call.failed ? .failed : .textPrimary])
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(MetistryButtonStyle(role: .plain))
            .accessibilityLabel(Text(verbatim: call.spoken))
            .accessibilityValue(Text(verbatim: isOpen ? "open" : "closed"))
            .help(isOpen ? "Close the call" : "Show what it asked and what it got")
            if isOpen {
                VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                    RunCaption(RunDetailWords.asked)
                    RunMonoBlock(text: call.asked, ground: .agentQuiet)
                }
                .accessibilityElement(children: .combine)
                VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                    RunCaption(RunDetailWords.got)
                    RunMonoBlock(text: call.got ?? RunDetailWords.noResult, ground: .agentQuiet, ink: call.failed ? .failed : .textPrimary)
                }
                .accessibilityElement(children: .combine)
            }
        }
        .padding(MetistrySpace.s2)
        .background(p[.agentQuiet], in: RoundedRectangle(cornerRadius: MetistryRadius.md, style: .continuous))
    }
}

struct RunMonoBlock: View {
    @Environment(\.colorScheme) private var scheme
    let text: String
    let ground: MetistryColorRole
    var ink: MetistryColorRole = .textPrimary

    var body: some View {
        let p = Palette(scheme)
        Text(verbatim: text)
            .metistryFont(.footnote, design: .mono)
            .foregroundStyle(p[ink])
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(MetistrySpace.s2)
            .background(p[ground], in: RoundedRectangle(cornerRadius: MetistryRadius.sm, style: .continuous))
    }
}

/// A small all-caps label — furniture, not an attribute (facets §3).
struct RunCaption: View {
    @Environment(\.colorScheme) private var scheme
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        let p = Palette(scheme)
        Text(verbatim: text.uppercased())
            .metistryFont(.caption1, weight: .semibold)
            .foregroundStyle(p[.textSecondary])
            .accessibilityLabel(Text(verbatim: text))
    }
}

struct RunHeading: View {
    @Environment(\.colorScheme) private var scheme
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        let p = Palette(scheme)
        Text(verbatim: text)
            .metistryFont(.headline)
            .foregroundStyle(p[.textPrimary])
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader)
    }
}

// MARK: - The side column

struct RunSideColumn: View {
    @Environment(\.colorScheme) private var scheme
    let model: RunDetailModel
    let run: RunDetail
    let assistantName: String?

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s6) {
            if let taken = model.taken {
                VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                    RunHeading(RunDetailWords.took(assistantName))
                    switch taken {
                    case .waiting:
                        quiet("Reading Needs You…", p)
                    case .failed(let why):
                        quiet("Couldn't read Needs You: \(why)", p)
                    case .loaded(let items):
                        if items.isEmpty {
                            quiet(RunDetailWords.foldLine(model.turns, clock: model.clock, now: model.now()) ?? "Nothing from this is waiting in Needs You.", p)
                        }
                        ForEach(items) { item in
                            RunTakenRow(item: item)
                        }
                    }
                }
            }
            VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                RunHeading(RunDetailWords.theRun)
                let facts = RunDetailWords.facts(run)
                if facts.isEmpty { quiet("The ledger holds no model, time or cost for this run.", p) }
                ForEach(facts) { RunFactRow(fact: $0) }
            }
            let route = RunDetailWords.route(run)
            if !route.isEmpty {
                VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                    RunHeading(RunDetailWords.theRoute)
                    ForEach(route) { RunFactRow(fact: $0) }
                }
            }
            VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                let lines = RunToolLine.lines(run.toolCalls)
                RunHeading(RunDetailWords.toolCalls(lines.count, total: max(run.toolCallsTotal, lines.count)))
                if lines.isEmpty { quiet("No tool calls.", p) }
                ForEach(lines) { RunToolRow(line: $0) }
            }
        }
    }

    private func quiet(_ text: String, _ p: Palette) -> some View {
        Text(verbatim: text)
            .metistryFont(.callout)
            .foregroundStyle(p[.textSecondary])
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// One thing the fold proposed from this session (§2): its kind, where it
/// would land, the line itself, and its status.
struct RunTakenRow: View {
    @Environment(\.colorScheme) private var scheme
    let item: RunTakenItem

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                Text(verbatim: item.kind)
                    .metistryFont(.subhead, weight: .semibold)
                    .foregroundStyle(p[.textPrimary])
                Text(verbatim: item.path)
                    .metistryFont(.footnote, design: .mono)
                    .foregroundStyle(p[.textSecondary])
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text(verbatim: item.line)
                .metistryFont(.callout)
                .foregroundStyle(p[.textPrimary])
                .fixedSize(horizontal: false, vertical: true)
            Text(verbatim: item.status)
                .metistryFont(.footnote)
                .foregroundStyle(p[.textSecondary])
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: item.spoken))
    }
}

struct RunFactRow: View {
    @Environment(\.colorScheme) private var scheme
    let fact: RunFact

    var body: some View {
        let p = Palette(scheme)
        HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
            Text(verbatim: fact.label)
                .foregroundStyle(p[.textSecondary])
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: MetistrySpace.s2)
            Text(verbatim: fact.value)
                .foregroundStyle(p[.textPrimary])
                .monospacedDigit()
                .multilineTextAlignment(.trailing)
                .fixedSize(horizontal: false, vertical: true)
        }
        .metistryFont(.subhead)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: fact.spoken))
    }
}

/// One call in the sequence: its tool and time, and a bar for its share of
/// the longest call — `failed` ink and the failed mark when it failed.
struct RunToolRow: View {
    @Environment(\.colorScheme) private var scheme
    let line: RunToolLine

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                if line.failed {
                    Image(systemName: MetistryGlyph.failed.rawValue)
                        .foregroundStyle(p[.failed])
                }
                Text(verbatim: line.tool)
                    .metistryFont(.footnote, design: .mono)
                    .foregroundStyle(p[line.failed ? .failed : .textPrimary])
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: MetistrySpace.s2)
                if let duration = line.duration {
                    Text(verbatim: duration)
                        .metistryFont(.footnote)
                        .monospacedDigit()
                        .foregroundStyle(p[.textSecondary])
                }
            }
            if let fraction = line.fraction {
                UsageMeter(fraction: fraction, ink: line.failed ? .failed : .accent)
            }
            if line.failed, let error = line.error {
                Text(verbatim: error)
                    .metistryFont(.footnote)
                    .foregroundStyle(p[.textSecondary])
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: line.spoken))
    }
}

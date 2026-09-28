// Scheduled (design-build-plan T6-6; screen-08-routines.md §10–§11, §2.5):
// one place to see everything Metistry runs on its own, and when.
//
//     Scheduled   [Routines 11 | Syncs 4]                        [New Routine]
//     THIS WEEK ─┬──·──·─────┬──·──·─────┬── …                 [Show as Table]
//     THROUGHOUT THE DAY
//                 Inbox Sort              Every 5 minutes
//     TODAY
//       4:00 AM   Session Purge  default  Run by Aide · Every day at 4:00 AM
//     TOMORROW · MONDAY
//       7:00 AM   Morning Brief  default  Run by Aide · Working days at 7:00 AM
//     INACTIVE
//          —      Weekly Digest           Run by researcher · Fridays at 3:00 PM
//
// The list is the schedule (§4): a routine appears once per time it acts, in
// day bands, ordered by what runs next; interval housekeeping is one row in
// *Throughout the day*; paused and held routines sit together at the bottom
// and say why. A silent tick is not an occurrence — every row comes from the
// schedule, never from a run (scheduled-model.swift). The detail beside it is
// routine-detail-view.swift.
//
// THE WEEK ON ONE AXIS (§4.1). A mark per time a routine acts across the next
// seven days, a marker per day and a faint noon line inside each; one ink, no
// legend. It speaks one sentence — *This week: 39 runs, all by 7 AM or after
// 6 PM* — and *Show as Table* draws the same runs as a table (§2.18.3).
//
// KEYS (components-02 §1). ↑↓ are the list's own; ⌘R is Item ▸ Run Now / Sync
// Now and ⌥⌘P Item ▸ Pause, answered through `shellItemActions` — nothing on
// this screen binds a key of its own (C119). Screen 8 §7's `r` and `p` are
// not in the closed menu table, so they are not bound.
//
// ACCESSIBILITY (§2.18). A row is one element that says the Spoken table's
// sentence — *7:00 AM, Morning Brief, default, run by Aide, working days at
// 7 AM. Nothing to do* — with its state in words, never a colour alone.
// Nothing here animates, so Reduce Motion has nothing to stop. Text is the
// semantic styles through `metistryFont`, and every row wraps rather than
// clips at the largest size.

import SwiftUI

public struct ScheduledView: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: ScheduledModel
    let assistantName: String?
    let tick: Duration
    /// Opens a vault path where the vault is read (Obsidian). Nil: nothing opens.
    let onOpenPath: ((String) -> Void)?
    /// *Edit on Agents* — the agent's definition is edited there (§5.1).
    let onGoToAgents: (() -> Void)?
    /// A stopped sync's one request waits in Needs You (T3-12).
    let onGoToNeedsYou: (() -> Void)?

    public init(
        model: ScheduledModel,
        assistantName: String?,
        tick: Duration = .seconds(5),
        onOpenPath: ((String) -> Void)? = nil,
        onGoToAgents: (() -> Void)? = nil,
        onGoToNeedsYou: (() -> Void)? = nil
    ) {
        self.model = model
        self.assistantName = assistantName
        self.tick = tick
        self.onOpenPath = onOpenPath
        self.onGoToAgents = onGoToAgents
        self.onGoToNeedsYou = onGoToNeedsYou
    }

    public var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: 0) {
            ScheduledHeader(model: model)
                .padding(.horizontal, MetistrySpace.s4)
                .padding(.top, MetistrySpace.s3)
                .padding(.bottom, MetistrySpace.s2)
            Divider()
            content
        }
        // Flexible down to nothing, as every screen is (#392): the list and
        // the detail scroll, and the window's minimum is the shell's to set.
        .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .topLeading)
        .background(p[.surface])
        .shellItemActions(model.itemActions())
        .task {
            await model.refreshIfDue()
            while !Task.isCancelled {
                try? await Task.sleep(for: tick)
                if Task.isCancelled { break }
                await model.refreshIfDue()
            }
        }
        .task(id: model.selection) { await model.loadSelection() }
    }

    @ViewBuilder
    private var content: some View {
        switch FirstPaint.paint(model.list.section, loadingSince: model.loadingSince, ageLimit: ScheduledModel.ageLimit, waitingFor: "Reading what's scheduled", now: model.now()) {
        case .placeholders(let waiting):
            PlaceholderRows(count: 6, waitingFor: waiting)
                .padding(MetistrySpace.s4)
            Spacer(minLength: 0)
        case .failed(let why):
            StatePanel(
                StatePanelModel(.failed, title: "Couldn't Read Scheduled", sentence: "Nothing is known about what runs — it isn't an empty schedule.", reason: why, action: StateWords.tryAgain),
                now: model.now(),
                clock: model.clock
            ) {
                Task { await model.refresh() }
            }
            Spacer(minLength: 0)
        case .content(let staleSince):
            if let staleSince {
                StaleBand(StaleBandModel("Showing the schedule", asOf: staleSince, action: StateWords.tryAgain), now: model.now(), clock: model.clock) {
                    Task { await model.refresh() }
                }
            }
            HStack(spacing: 0) {
                listColumn
                    .frame(minWidth: 0, idealWidth: 400, maxWidth: 480, maxHeight: .infinity, alignment: .top)
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel(Text(verbatim: model.tab.title))
                Divider()
                detailColumn
                    .frame(minWidth: 0, maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel(Text(verbatim: model.tab == .routines ? "Routine" : "Sync"))
            }
        }
    }

    @ViewBuilder
    private var listColumn: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: 0) {
            ForEach(model.listing?.problems ?? [], id: \.self) { problem in
                MarkView(Mark(problem, glyph: .degraded, style: .footnote, ink: .degraded, on: .surface, spoken: "Problem: \(problem)"))
                    .padding(.horizontal, MetistrySpace.s4)
                    .padding(.top, MetistrySpace.s2)
            }
            if model.tab == .routines {
                if (model.listing?.routines ?? []).isEmpty {
                    StatePanel(StatePanelModel(.empty, title: "Nothing Is Scheduled", sentence: "A routine gives one of your agents a standing task."))
                    Spacer(minLength: 0)
                } else {
                    WeekAxisView(week: model.week, showsTable: $model.showsWeekTable)
                        .padding(.horizontal, MetistrySpace.s4)
                        .padding(.vertical, MetistrySpace.s3)
                    list(model.routineBands)
                    if model.onlyDefaults {
                        footnote("Only the defaults so far. A New Routine gives one of your agents a standing task.")
                    }
                }
            } else {
                if model.syncRows.isEmpty {
                    StatePanel(StatePanelModel(.empty, title: "No Syncs Yet", sentence: "A sync brings a connection's changes in on a cadence."))
                    Spacer(minLength: 0)
                } else {
                    list([ScheduledBand(title: "Syncs", rows: model.syncRows)], headers: false)
                }
                footnote(ScheduledWords.newSync)
            }
        }
        .background(p[.surface])
    }

    private func footnote(_ text: String) -> some View {
        Text(verbatim: text)
            .metistryFont(.footnote)
            .foregroundStyle(Palette(scheme)[.textSecondary])
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, MetistrySpace.s4)
            .padding(.vertical, MetistrySpace.s2)
    }

    private func list(_ bands: [ScheduledBand], headers: Bool = true) -> some View {
        List(selection: $model.selection) {
            ForEach(bands) { band in
                SwiftUI.Section {
                    ForEach(band.rows) { row in
                        if let presentation = model.presentation(row, assistantName: assistantName) {
                            ScheduledRowView(presentation)
                                .tag(row.id)
                        }
                    }
                } header: {
                    if headers {
                        Text(verbatim: band.title)
                            .metistryFont(.caption2, weight: .semibold)
                            .textCase(.uppercase)
                            .foregroundStyle(Palette(scheme)[.textSecondary])
                            .accessibilityAddTraits(.isHeader)
                    }
                }
            }
        }
        .listStyle(.inset)
        // The rows' inks are checked against `surface`; the list paints it.
        .scrollContentBackground(.hidden)
        .background(Palette(scheme)[.surface])
        .shellListFocus()
        .accessibilityLabel(Text(verbatim: model.tab.title))
    }

    @ViewBuilder
    private var detailColumn: some View {
        if let target = model.selectedTarget {
            if target.isSync {
                SyncDetailView(model: model, name: target.name, onGoToNeedsYou: onGoToNeedsYou)
                    .id(target.name)
            } else {
                RoutineDetailView(model: model, name: target.name, assistantName: assistantName, onOpenPath: onOpenPath, onGoToAgents: onGoToAgents, onGoToNeedsYou: onGoToNeedsYou)
                    .id(target.name)
            }
        } else {
            StatePanel(StatePanelModel(
                .empty,
                title: model.tab == .routines ? "No Routine Selected" : "No Sync Selected",
                sentence: model.tab == .routines ? "Choose one to see its schedule, its task and its history." : "Choose one to see its cadence and what it raises."
            ))
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

// MARK: - The header

/// *Scheduled*, the two tabs with their counts (§11), and the tab's button.
struct ScheduledHeader: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: ScheduledModel

    var body: some View {
        let p = Palette(scheme)
        FlowLayout(spacing: MetistrySpace.s3, lineSpacing: MetistrySpace.s2) {
            Text(verbatim: ScheduledWords.title)
                .metistryFont(.title2, weight: .semibold)
                .foregroundStyle(p[.textPrimary])
                .accessibilityAddTraits(.isHeader)
            Picker("Show", selection: Binding(get: { model.tab }, set: { tab in
                model.tab = tab
                model.selection = nil
            })) {
                ForEach(ScheduledModel.Tab.allCases) { tab in
                    Text(verbatim: "\(tab.title) \(model.count(tab))").tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .fixedSize()
            // New Routine changes what runs: the Mac alone (§2.3), and absent elsewhere.
            if model.tab == .routines, model.reach.changesWhatRuns {
                ControlButton(ControlSpec(ScheduledWords.newRoutine, glyph: .added, role: .secondary, disabledBecause: ScheduledWords.newRoutineNotYet)) {}
            }
        }
    }
}

// MARK: - A row

struct ScheduledRowView: View {
    @Environment(\.colorScheme) private var scheme
    let presentation: ScheduledRowPresentation

    init(_ presentation: ScheduledRowPresentation) {
        self.presentation = presentation
    }

    var body: some View {
        let p = Palette(scheme)
        let row = presentation
        HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
            Group {
                if let glyph = row.glyph {
                    Image(systemName: glyph.rawValue).foregroundStyle(p[row.glyphInk])
                } else {
                    Image(systemName: MetistryGlyph.failed.rawValue).hidden()
                }
            }
            .metistryFont(.subhead)
            VStack(alignment: .leading, spacing: 2) {
                FlowLayout(spacing: MetistrySpace.s2, lineSpacing: 2) {
                    if !row.when.isEmpty {
                        Text(verbatim: row.when)
                            .metistryFont(.subhead, weight: .medium)
                            .monospacedDigit()
                            .foregroundStyle(p[.textSecondary])
                    }
                    Text(verbatim: row.title)
                        .metistryFont(.body, weight: .semibold)
                        .foregroundStyle(p[.textPrimary])
                    if row.isDefault {
                        ScheduledTag(text: "default")
                    }
                }
                Text(verbatim: [row.runBy.map { "Run by \($0)" }, row.recurrence].compactMap { $0 }.joined(separator: " · "))
                    .metistryFont(.subhead)
                    .foregroundStyle(p[.textSecondary])
                    .fixedSize(horizontal: false, vertical: true)
                if let detail = row.detail {
                    Text(verbatim: detail)
                        .metistryFont(.footnote)
                        .foregroundStyle(p[row.detailInk])
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: row.spoken))
    }
}

/// The *default* tag (§10.1): a quiet chip, not a state.
struct ScheduledTag: View {
    @Environment(\.colorScheme) private var scheme
    let text: String

    var body: some View {
        let p = Palette(scheme)
        Text(verbatim: text)
            .metistryFont(.caption1, weight: .medium)
            .foregroundStyle(p[.textSecondary])
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(p[.sunken], in: Capsule())
    }
}

// MARK: - The week on one axis

struct WeekAxisView: View {
    @Environment(\.colorScheme) private var scheme
    let week: WeekAxis
    @Binding var showsTable: Bool

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: "This week")
                    .metistryFont(.caption2, weight: .semibold)
                    .textCase(.uppercase)
                    .foregroundStyle(p[.textSecondary])
                    .accessibilityHidden(true)
                Spacer(minLength: MetistrySpace.s2)
                ControlButton(ControlSpec(showsTable ? "Hide Table" : "Show as Table", role: .plain)) { showsTable.toggle() }
            }
            VStack(spacing: 2) {
                HStack(spacing: 0) {
                    ForEach(week.days) { day in
                        WeekDayStrip(day: day)
                    }
                }
                .frame(height: 22)
                HStack(spacing: 0) {
                    ForEach(week.days) { day in
                        Text(verbatim: day.label)
                            .metistryFont(.caption2)
                            .foregroundStyle(p[.textSecondary])
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.leading, 3)
                    }
                }
            }
            // A chart speaks one sentence; its table is the button beside it.
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(verbatim: week.sentence))
            .accessibilityAddTraits(.isImage)
            if showsTable {
                VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                    ForEach(week.days) { day in
                        HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                            Text(verbatim: day.longLabel)
                                .metistryFont(.footnote, weight: .semibold)
                                .foregroundStyle(p[.textPrimary])
                            Text(verbatim: day.summary)
                                .metistryFont(.footnote)
                                .foregroundStyle(p[.textSecondary])
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(Text(verbatim: "\(day.longLabel), \(day.summary)"))
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityLabel(Text(verbatim: "Runs this week"))
            }
        }
    }
}

/// One day of the axis: its marker, the faint noon line, a mark per run.
struct WeekDayStrip: View {
    @Environment(\.colorScheme) private var scheme
    let day: WeekAxis.Day

    var body: some View {
        let p = Palette(scheme)
        GeometryReader { geo in
            ZStack(alignment: .topLeading) {
                Rectangle().fill(p[.border]).frame(width: 1, height: geo.size.height)
                Rectangle().fill(p[.border].opacity(0.5)).frame(width: 1, height: geo.size.height * 0.4)
                    .offset(x: geo.size.width / 2, y: geo.size.height * 0.3)
                Rectangle().fill(p[.border]).frame(height: 1).offset(y: geo.size.height / 2)
                ForEach(Array(day.marks.enumerated()), id: \.offset) { _, mark in
                    RoundedRectangle(cornerRadius: 1)
                        .fill(p[.accent])
                        .frame(width: 2, height: geo.size.height * 0.7)
                        .offset(x: max(0, geo.size.width * mark - 1), y: geo.size.height * 0.15)
                }
            }
        }
        .frame(minWidth: 0, maxWidth: .infinity)
    }
}

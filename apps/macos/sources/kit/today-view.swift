// Today (design-build-plan T6-1a, T6-1b; screen-05-today.md §12–§15).
//
// THE TOP OF THE DAY (T6-1b). The Morning Brief is Today's first state — one
// wash, then the Standup collapsed — and folds to a line once read; Next Up
// sticks under the header from thirty minutes before the next meeting;
// calendar help is one line beside its one action; and from thirty minutes
// before the working day ends, the top becomes Close the Day. The pieces, and
// what each reads and writes, are in today-brief-view.swift.
//
// THE DAY BELOW (T6-1a) is the spine: one time-ordered column — meetings at
// their time, the owner's rows in the gaps between them, a NOW rule that
// sticks under the header, and the morning folded above it to one line, so
// the page opens at now (§12.2, §14.4). With no meeting on the day it is the
// plain list, in the owner's order (§12.4). The header carries the day bar —
// Meetings · Travel · Focus Blocked · Tasks That Fit · Doesn't Fit against the
// working day — and Today / All (⌥⌘T): All is the vault's open lines through
// the one `where:` language, the box shown, copyable and editable, with the
// saved views beside it (§8, §15.6). The model is today-model.swift.
//
// WHAT IT WRITES, and nothing else: the Tick door and the Defer door, each one
// field on one line of the owner's note, refused `409 stale` if the line is not
// the one drawn here — one click ticks, with a receipt and Undo, never a
// dialog (C99); the day's order (`PUT /api/today/order`), whole, when a row is
// dragged or moved; `POST /api/today/close`; a meeting's note
// (`POST /api/meetings/:event_id/note`, idempotent per event); a meeting's move,
// preview first and confirmed with its single-use token; and one chat message
// when the owner asks for a draft agenda.
//
// THE NAME. The brief's author is the configured name, with the spark; until
// the console has said it, the words are shown without an author — never a
// default, never the principal id.

import Foundation
import Observation
import SwiftUI

// MARK: - The view


public struct TodayView: View {
    @Environment(\.colorScheme) private var scheme
    #if os(macOS)
    @Environment(\.undoManager) private var undoManager
    #endif
    @Bindable var model: TodayModel
    let assistantName: String?
    let tickInterval: Duration
    /// Opens a vault path (the meeting's note). Nil: nothing opens.
    let onOpenPath: ((String) -> Void)?
    /// Opens the capture bar with this event chosen. Nil: Record is dimmed with its reason.
    let onRecord: ((TodayEvent) -> Void)?
    /// Goes to Needs You, where the close's request is.
    let onGoToNeedsYou: (() -> Void)?

    public init(model: TodayModel, assistantName: String?, tick: Duration = .seconds(15), onOpenPath: ((String) -> Void)? = nil, onRecord: ((TodayEvent) -> Void)? = nil, onGoToNeedsYou: (() -> Void)? = nil) {
        self.model = model
        self.assistantName = assistantName
        self.tickInterval = tick
        self.onOpenPath = onOpenPath
        self.onRecord = onRecord
        self.onGoToNeedsYou = onGoToNeedsYou
    }

    public var body: some View {
        let p = Palette(scheme)
        Group {
            switch model.panel {
            case .placeholders(let waiting):
                VStack(alignment: .leading) {
                    PlaceholderRows(count: 5, waitingFor: waiting)
                    Spacer(minLength: 0)
                }
                .padding(MetistrySpace.s4)
            case .state(let state):
                VStack {
                    StatePanel(state, now: model.now(), clock: model.clock) { Task { await model.load() } }
                    Spacer(minLength: 0)
                }
            case .page(let staleSince):
                VStack(alignment: .leading, spacing: 0) {
                    if let staleSince {
                        StaleBand(StaleBandModel("Showing today", asOf: staleSince, action: StateWords.tryAgain), now: model.now(), clock: model.clock) {
                            Task { await model.load() }
                        }
                    }
                    if let day = model.day {
                        TodayHeader(model: model, day: day)
                            .padding(.horizontal, MetistrySpace.s5)
                            .padding(.vertical, MetistrySpace.s4)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(p[.surface])
                        Divider()
                    }
                    switch model.mode {
                    case .today:
                        ScrollViewReader { proxy in
                            ScrollView {
                                LazyVStack(alignment: .leading, spacing: MetistrySpace.s5, pinnedViews: [.sectionHeaders]) {
                                    TodayPage(model: model, assistantName: assistantName, onOpenPath: onOpenPath, onRecord: onRecord, onGoToNeedsYou: onGoToNeedsYou, onTick: tick)
                                }
                                .frame(maxWidth: MetistrySize.contentMax, alignment: .leading)
                                .padding(MetistrySpace.s5)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            // The page opens at now: the morning is one line above NOW, and if it was left open the page starts at NOW anyway (§14.4).
                            .onAppear { if model.pastOpen { proxy.scrollTo(TodaySpineView.nowID, anchor: .top) } }
                        }
                    case .all:
                        TodayAllView(model: model, onTick: tick)
                    }
                }
            }
        }
        // Flexible down to nothing, as Activity is: the page scrolls, and the
        // window's minimum is the shell's to set. Without the zeros the
        // screen's minimum was its content's at no width at all: 1,127–1,440
        // pt tall with a day on screen, 1,841 when the console did not answer.
        .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .topLeading)
        .background(p[.surface])
        // View ▸ Today / All (⌥⌘T); Go ▸ Filter (⌘F) is All's box. Menu items, never a bare key (C119).
        .shellScreenActions([
            .todayOrAll: { model.toggleMode() },
            .filter: { model.askForTheBox() },
        ])
        .onAppear { model.opened() }
        .onDisappear { if model.expandedWash == .brief { model.briefWasRead() } }
        .task {
            await model.refreshIfDue()
            while !Task.isCancelled {
                try? await Task.sleep(for: tickInterval)
                if Task.isCancelled { break }
                await model.refreshIfDue()
            }
        }
    }

    /// One click ticks (C99). The tick is also Edit ▸ Undo's (⌘Z) — the same door, the other way.
    private func tick(_ task: TodayTask, _ checked: Bool) {
        Task {
            let done = await model.tick(task, checked: checked)
            #if os(macOS)
            guard done, let undoManager else { return }
            let model = model
            undoManager.registerUndo(withTarget: model) { target in
                Task { @MainActor in await target.tick(task, checked: !checked) }
            }
            undoManager.setActionName(checked ? "Tick" : "Untick")
            #endif
        }
    }
}

/// Title and day, Today / All, closing early, and — on Today — the day bar.
struct TodayHeader: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: TodayModel
    let day: TodayDay

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s3) {
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s3) {
                Text(verbatim: TodayWords.title).todayText(.title2, p).accessibilityAddTraits(.isHeader)
                if let date = TodayDates.date(day.date, calendar: model.calendar) {
                    Text(verbatim: Self.longDay(date, calendar: model.calendar)).todayText(.callout, p, .textSecondary)
                }
                Spacer(minLength: MetistrySpace.s2)
                if model.mode == .today, case .idle = model.close, !model.closeIsDue {
                    // Before the window, closing early is one quiet control away — never a dead end.
                    ControlButton(ControlSpec(TodayWords.closeEarly, role: .plain, name: "Close the Day early")) { model.openClose() }
                }
                // A scope, where the section title would sit; the sidebar never gains a row (§8).
                Picker(selection: Binding(get: { model.mode }, set: { model.setMode($0) })) {
                    ForEach(TodayMode.allCases, id: \.self) { mode in
                        Text(verbatim: mode.rawValue).tag(mode)
                    }
                } label: {
                    Text(verbatim: TodayWords.todayOrAll)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                .accessibilityLabel(Text(verbatim: TodayWords.todayOrAllSpoken))
            }
            if model.mode == .today {
                if let bar = model.dayBar {
                    TodayDayBarView(bar: bar)
                } else if model.profile != nil {
                    Text(verbatim: TodayWords.noWorkingHours).todayText(.footnote, p, .textSecondary).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    static func longDay(_ date: Date, calendar: Calendar) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = calendar.timeZone
        f.dateFormat = "EEEE d MMMM"
        return f.string(from: date)
    }
}

/// The page's pieces, in order: Close the Day, the brief, Next Up, calendar help, the spine.
struct TodayPage: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: TodayModel
    let assistantName: String?
    let onOpenPath: ((String) -> Void)?
    let onRecord: ((TodayEvent) -> Void)?
    let onGoToNeedsYou: (() -> Void)?
    let onTick: (TodayTask, Bool) -> Void

    var body: some View {
        let p = Palette(scheme)
        if let day = model.day {
            closeArea(day)
            briefArea(day, p)
            nextUpArea(day, p)
            helpArea(p)
            if let spine = model.spine {
                TodaySpineView(model: model, day: day, spine: spine, onTick: onTick)
            }
        }
    }

    @ViewBuilder
    private func closeArea(_ day: TodayDay) -> some View {
        switch model.close {
        case .closed(let closed):
            TodayClosedLine(closed: closed, tomorrow: model.tomorrowDate, clock: model.clock) { model.openClose() }
        case .noteNotWritten(let missing):
            TodayNoteNotWrittenView(missing: missing, onOpenRequest: onGoToNeedsYou) { model.openClose() }
        default:
            if model.closePanelShown, let plan = model.closePlan {
                let refusal: String? = { if case .refused(let why) = model.close { return why } else { return nil } }()
                let closing: Bool = { if case .closing = model.close { return true } else { return false } }()
                TodayClosePanel(
                    plan: plan, choices: model.deferChoices, today: day.date, tomorrow: model.tomorrow, clock: model.clock,
                    notes: model.notes, closing: closing, refusal: refusal, line: $model.closeLine,
                    onDefer: { task, choice in Task { await model.deferTask(task, to: choice) } },
                    onTick: onTick,
                    onClose: { Task { await model.closeDay() } }
                )
            }
        }
    }

    @ViewBuilder
    private func briefArea(_ day: TodayDay, _ p: Palette) -> some View {
        switch model.brief {
        case .unasked, .reading:
            EmptyView()  // nothing, rather than a wrong sentence, while the file is read
        case .ready(let doc, let standup):
            if model.expandedWash == .brief {
                TodayBriefOpen(
                    document: doc, standup: standup, path: day.brief ?? "",
                    planned: day.tasks.filter(\.isOpen).count, carried: day.tasks.filter { $0.carriedDays > 0 }.count,
                    assistantName: assistantName, clock: model.clock,
                    onCopyStandup: model.copyText.map { copy in { copy($0) } }
                )
                // scrolled past: folded on the next open, never under the reader
                .onDisappear { model.briefWasRead() }
            } else {
                TodayFoldedLine(text: doc.foldedLine, spoken: doc.foldedLine) { model.openBrief() }
            }
        case .noWorkingDays:
            TodayBriefMissing(title: "No Morning Brief", sentence: "\(WorkingProfile.path) doesn't say which days you work, so none is written.")
        case .runFailed(let at, let next):
            TodayBriefMissing(title: "The Morning Brief Failed", sentence: "It ran at \(at.map(model.clock.time) ?? "its time") and failed\(next.map { "; it runs next at \(model.clock.moment($0, now: model.now()))" } ?? "").")
        case .notYet(let next):
            TodayBriefMissing(title: "No Morning Brief Yet", sentence: next.map { "It's written at \(model.clock.moment($0, now: model.now()))." } ?? "It hasn't been written today.")
        case .unreadable(let why):
            TodayBriefMissing(title: "Couldn't Read the Morning Brief", sentence: why)
        }
    }

    @ViewBuilder
    private func nextUpArea(_ day: TodayDay, _ p: Palette) -> some View {
        switch model.nextUp {
        case .card(let card):
            let agendaNote: String? = {
                switch model.agenda[card.event.id] {
                case .asked?: return assistantName.map { "Asked \($0) for a draft agenda — it will be in Chat." } ?? "Asked for a draft agenda — it will be in Chat."
                case .failed(let why)?: return why
                case .asking?: return "Asking…"
                case nil: return nil
                }
            }()
            TodayNextUpView(
                card: card, today: day.date, expanded: model.expandedWash == .nextUp,
                prediction: model.isOnPage(card.prediction), predictionNote: agendaNote, notesNote: model.notesNote,
                notes: model.notes, assistantName: assistantName, clock: model.clock, canRecord: onRecord != nil,
                onExpand: { model.openNextUpLine() },
                onOpenNotes: { Task { if let path = await model.meetingNote(card.event) { onOpenPath?(path) } } },
                onRecord: { onRecord?(card.event) },
                onPredict: { _ in Task { await model.draftAgenda(card) } },
                onCopyStandup: model.standupText != nil && model.copyText != nil ? { model.copyStandup() } : nil,
                onTick: onTick
            )
        case .calendarDone:
            Text(verbatim: NextUp.calendarDone).metistryText(.callout, p, .textSecondary)
        case .none:
            EmptyView()
        }
    }

    @ViewBuilder
    private func helpArea(_ p: Palette) -> some View {
        switch model.move {
        case .confirming(let warning):
            if let confirmation = warning.confirmation(clock: model.clock) {
                CostConfirmView(confirmation, on: .elevated) { choice in
                    if choice == .confirm { Task { await model.confirmMove(warning) } } else { model.cancelMove() }
                }
                .clipShape(RoundedRectangle(cornerRadius: MetistryRadius.lg, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: MetistryRadius.lg, style: .continuous).strokeBorder(p[.border], lineWidth: 1))
            }
        case .moved(let receipt):
            Text(verbatim: receipt).metistryText(.callout, p, .textSecondary).fixedSize(horizontal: false, vertical: true)
        case .failed(let why):
            Text(verbatim: why).metistryText(.callout, p, .failed).fixedSize(horizontal: false, vertical: true)
        case .idle, .asking:
            if let help = model.calendarHelp {
                let busy: Bool = { if case .asking = model.move { return true } else { return false } }()
                TodayCalendarHelpView(
                    help: help, prediction: model.isOnPage(help.prediction), clock: model.clock, busy: busy,
                    onMove: { Task { await model.beginMove(help) } },
                    onNotToday: { model.dismissCalendarHelp() }
                )
            }
        }
    }
}

// MARK: - The spine

/// The day under the top: the morning's line, NOW, and what is left, in time order.
struct TodaySpineView: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: TodayModel
    let day: TodayDay
    let spine: TodaySpine
    let onTick: (TodayTask, Bool) -> Void

    static let nowID = "today.now"

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            Text(verbatim: TodayWords.theDay).todayText(.headline, p).accessibilityAddTraits(.isHeader)
            if model.isEmptyDay {
                Text(verbatim: "Nothing scheduled for today. That means nothing is due or planned — not that you're finished.")
                    .todayText(.callout, p, .textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(spine.allDay) { event in
                TodayMeetingRow(event: event, time: TodayWords.allDay, note: nil)
            }
            if !spine.earlier.isEmpty {
                TodayEarlierLine(summary: spine.earlier.summary, open: model.pastOpen) { model.togglePast() }
                if model.pastOpen {
                    VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                        ForEach(spine.earlier.meetings) { event in
                            TodayMeetingRow(event: event, time: model.clock.range(event.start, event.end), note: nil)
                        }
                        ForEach(spine.earlier.done) { item in
                            row(item, keys: [])
                        }
                    }
                    .padding(.leading, MetistrySpace.s4)
                }
            }
            if let note = model.orderNote {
                Text(verbatim: note).todayText(.footnote, p, .failed).fixedSize(horizontal: false, vertical: true)
            }
            if spine.isList {
                let keys = spine.list.map(\.key)
                ForEach(spine.list) { item in row(item, keys: keys) }
            }
        }
        if let now = spine.now {
            let keys = spine.placeable.map(\.key)
            let inNextUp: String? = { if case .card(let card) = model.nextUp { return card.event.id } else { return nil } }()
            SwiftUI.Section {
                VStack(alignment: .leading, spacing: MetistrySpace.s3) {
                    ForEach(spine.entries) { entry in
                        switch entry {
                        case .meeting(let event):
                            TodayMeetingRow(event: event, time: model.clock.range(event.start, event.end), note: event.id == inNextUp ? TodayWords.inNextUp : nil)
                        case .gap(let gap):
                            VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                                TodayGapHeader(gap: gap, clock: model.clock)
                                ForEach(gap.items) { item in row(item, keys: keys) }
                            }
                        }
                    }
                    if !spine.doesNotFit.isEmpty {
                        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                            TodayRule(label: TodayWords.doesNotFit(spine.dayEnd.map(model.clock.time)), ink: .degraded)
                            ForEach(spine.doesNotFit) { item in row(item, keys: keys) }
                        }
                    }
                    if let end = spine.dayEnd {
                        Text(verbatim: "\(model.clock.time(end)) · your day ends")
                            .todayText(.footnote, p, .textSecondary)
                    }
                }
            } header: {
                TodayNowRule(time: model.clock.time(now))
                    .id(Self.nowID)
            }
        }
    }

    @ViewBuilder
    private func row(_ item: SpineItem, keys: [String]) -> some View {
        let index = keys.firstIndex(of: item.key)
        let up: (() -> Void)? = index.flatMap { $0 > 0 ? { Task { await model.move(item.key, by: -1) } } : nil }
        let down: (() -> Void)? = index.flatMap { $0 < keys.count - 1 ? { Task { await model.move(item.key, by: 1) } } : nil }
        Group {
            switch item {
            case .task(let task):
                TodayTaskRow(task: task, today: day.date, note: model.notes[task.key], onTick: { onTick(task, $0) }, onUndo: { onTick(task, false) }, onMoveUp: up, onMoveDown: down)
            case .work(let work):
                TodayWorkRow(work: work, onMoveUp: up, onMoveDown: down)
            }
        }
        .modifier(TodayDragOrder(key: item.key, draggable: index != nil) { dropped in
            Task { await model.move(dropped, onto: item.key) }
        })
    }
}

/// Drag to reorder (screen 5 §2); the order you leave it in is stored.
struct TodayDragOrder: ViewModifier {
    let key: String
    let draggable: Bool
    let onDrop: (String) -> Void

    func body(content: Content) -> some View {
        if draggable {
            content
                .draggable(key)
                .dropDestination(for: String.self) { keys, _ in
                    guard let dropped = keys.first, dropped != key else { return false }
                    onDrop(dropped)
                    return true
                }
        } else {
            content
        }
    }
}

/// `NOW` — the clock, a dot and a rule in accent, pinned under the header as the page scrolls.
struct TodayNowRule: View {
    @Environment(\.colorScheme) private var scheme
    let time: String

    var body: some View {
        let p = Palette(scheme)
        HStack(spacing: MetistrySpace.s2) {
            Text(verbatim: time).metistryFont(.footnote, weight: .bold).foregroundStyle(p[.accent])
            Circle().fill(p[.accent]).frame(width: 7, height: 7)
            Rectangle().fill(p[.accent].opacity(0.45)).frame(height: 1)
            Text(verbatim: "NOW").metistryFont(.caption2, weight: .bold).foregroundStyle(p[.accent])
        }
        .padding(.vertical, MetistrySpace.s2)
        .background(p[.surface])
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: "Now, \(time)"))
        .accessibilityAddTraits(.isHeader)
    }
}

/// The morning, folded: *Earlier today — 3 done · 1 meeting · 2 carried forward*, expanding in place.
struct TodayEarlierLine: View {
    @Environment(\.colorScheme) private var scheme
    let summary: String
    let open: Bool
    let onToggle: () -> Void

    var body: some View {
        let p = Palette(scheme)
        Button(action: onToggle) {
            HStack(spacing: MetistrySpace.s2) {
                Image(systemName: open ? MetistryGlyph.disclosureOpen.rawValue : MetistryGlyph.disclosure.rawValue)
                    .foregroundStyle(p[.textSecondary])
                    .accessibilityHidden(true)
                Text(verbatim: "\(TodayWords.earlier) — \(summary)")
                    .todayText(.footnote, p, .textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                Rectangle().fill(p[.border]).frame(height: 1)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(verbatim: "\(TodayWords.earlier): \(summary.replacingOccurrences(of: " · ", with: ", "))"))
        .accessibilityValue(Text(verbatim: open ? "shown" : "folded"))
    }
}

/// A free stretch's header: *35m free* on the left, *both fit · 10m to spare* on the right.
struct TodayGapHeader: View {
    @Environment(\.colorScheme) private var scheme
    let gap: TodaySpine.Gap
    let clock: ClockTime

    var body: some View {
        let p = Palette(scheme)
        let time = gap.end.map { clock.range(gap.start, $0) } ?? clock.time(gap.start)
        ViewThatFits(in: .horizontal) {
            HStack(spacing: MetistrySpace.s2) {
                Text(verbatim: time).todayText(.footnote, p, .textSecondary)
                label(p)
                Rectangle().fill(p[.border]).frame(height: 1)
                Text(verbatim: gap.fits).todayText(.footnote, p, .textSecondary)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: time).todayText(.footnote, p, .textSecondary)
                label(p)
                Text(verbatim: gap.fits).todayText(.footnote, p, .textSecondary).fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: "\(gap.label), \(time). \(gap.fits)"))
        .accessibilityAddTraits(.isHeader)
    }

    @ViewBuilder
    private func label(_ p: Palette) -> some View {
        if gap.focus != nil {
            HStack(spacing: MetistrySpace.s1) {
                Image(systemName: MetistryGlyph.estimate.rawValue).foregroundStyle(p[.accent]).accessibilityHidden(true)
                Text(verbatim: gap.label).todayText(.callout, p).fontWeight(.semibold).fixedSize(horizontal: false, vertical: true)
            }
        } else {
            Text(verbatim: gap.label.uppercased()).metistryFont(.caption2, weight: .bold).foregroundStyle(p[.textTertiary])
        }
    }
}

/// A rule with a word on it — *Doesn't fit before 5:30 PM*.
struct TodayRule: View {
    @Environment(\.colorScheme) private var scheme
    let label: String
    let ink: MetistryColorRole

    var body: some View {
        let p = Palette(scheme)
        HStack(spacing: MetistrySpace.s2) {
            Text(verbatim: label).todayText(.footnote, p, ink).fixedSize(horizontal: false, vertical: true)
            Rectangle().fill(p[.border]).frame(height: 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// A meeting at its time: title, who, where. Retrieved, so plain.
struct TodayMeetingRow: View {
    @Environment(\.colorScheme) private var scheme
    let event: TodayEvent
    let time: String
    /// *in Next Up ↑*, instead of repeating the briefing.
    let note: String?

    var body: some View {
        let p = Palette(scheme)
        HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
            Image(systemName: MetistryGlyph.due.rawValue).foregroundStyle(p[.textSecondary]).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: event.title).todayText(.body, p).fontWeight(.semibold).fixedSize(horizontal: false, vertical: true)
                Text(verbatim: ([time] + details).joined(separator: " · ")).todayText(.footnote, p, .textSecondary).fixedSize(horizontal: false, vertical: true)
                if let note {
                    Text(verbatim: note).metistryFont(.footnote, weight: .semibold).foregroundStyle(p[.accent])
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var details: [String] {
        var out: [String] = []
        let people = event.others.count
        if people > 0 { out.append(people == 1 ? "with \(event.others[0].displayName)" : "\(people + 1) people") }
        if let location = event.location { out.append(location) }
        return out
    }
}

/// An agent's row on the day: the board glyph in `agent`, and no checkbox —
/// there is nothing here for the owner to tick (screen 5 §2).
struct TodayWorkRow: View {
    @Environment(\.colorScheme) private var scheme
    let work: TodayWork
    let onMoveUp: (() -> Void)?
    let onMoveDown: (() -> Void)?

    var body: some View {
        let p = Palette(scheme)
        HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
            Image(systemName: "square.grid.3x1.below.line.grid.1x2").foregroundStyle(p[.agent]).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: work.title).todayText(.body, p).fixedSize(horizontal: false, vertical: true)
                Text(verbatim: work.reason).todayText(.footnote, p, .textSecondary).fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: work.spoken))
        .todayMoveActions(up: onMoveUp, down: onMoveDown)
    }
}

// MARK: - The day bar

/// Five segments with a 2px track gap, so adjacency never carries meaning;
/// *Doesn't Fit* stays in the legend at 0m, hollow, so the category is learnable.
struct TodayDayBarView: View {
    @Environment(\.colorScheme) private var scheme
    let bar: DayBar

    static let gap: CGFloat = 2
    static let height: CGFloat = 8

    nonisolated static func ink(_ segment: DayBar.Segment) -> MetistryColorRole {
        switch segment {
        case .meetings: return .chart1
        case .travel: return .chart2
        case .focus: return .chart3
        case .fits: return .chart4
        case .doesNotFit: return .degraded
        }
    }

    var body: some View {
        let p = Palette(scheme)
        let total = max(bar.workingMinutes, DayBar.Segment.allCases.map(bar.value).reduce(0, +), 1)
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                Text(verbatim: TodayWords.theDay.uppercased()).metistryFont(.caption2, weight: .bold).foregroundStyle(p[.textTertiary])
                Text(verbatim: bar.line).todayText(.footnote, p, .textSecondary).fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityHidden(true)
            GeometryReader { geo in
                let shown = DayBar.Segment.allCases.filter { bar.value($0) > 0 }
                let room = max(geo.size.width - CGFloat(max(shown.count - 1, 0)) * Self.gap, 0)
                HStack(spacing: Self.gap) {
                    ForEach(shown) { segment in
                        Rectangle().fill(p[Self.ink(segment)]).frame(width: room * CGFloat(bar.value(segment)) / CGFloat(total))
                    }
                    Spacer(minLength: 0)
                }
            }
            .frame(height: Self.height)
            .background(p[.sunken])
            .clipShape(Capsule())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(verbatim: bar.sentence))
            .accessibilityChartDescriptor(DayBarDescriptor(bar: bar))
            FlowLayout(spacing: MetistrySpace.s3) {
                ForEach(DayBar.Segment.allCases) { segment in
                    let value = bar.value(segment)
                    HStack(spacing: MetistrySpace.s1) {
                        RoundedRectangle(cornerRadius: 2)
                            .fill(value > 0 ? p[Self.ink(segment)] : Color.clear)
                            .overlay(RoundedRectangle(cornerRadius: 2).strokeBorder(value > 0 ? Color.clear : p[.textTertiary], lineWidth: 1.5))
                            .frame(width: 8, height: 8)
                        Text(verbatim: segment.rawValue).todayText(.caption2, p, .textSecondary)
                        Text(verbatim: DayBar.span(value)).todayText(.caption2, p, .textTertiary)
                    }
                }
            }
            .accessibilityHidden(true)
        }
    }
}

/// The bar's table for the rotor and Audio Graphs (§2.18.3).
struct DayBarDescriptor: AXChartDescriptorRepresentable {
    let bar: DayBar

    func makeChartDescriptor() -> AXChartDescriptor {
        let names = DayBar.Segment.allCases.map(\.rawValue)
        let x = AXCategoricalDataAxisDescriptor(title: "Part of the day", categoryOrder: names)
        let y = AXNumericDataAxisDescriptor(title: "Minutes", range: 0...Double(max(bar.workingMinutes, 1)), gridlinePositions: []) { DayBar.spoken(Int($0)) }
        let series = AXDataSeriesDescriptor(name: "The day", isContinuous: false, dataPoints: DayBar.Segment.allCases.map { AXDataPoint(x: $0.rawValue, y: Double(bar.value($0))) })
        return AXChartDescriptor(title: TodayWords.theDay, summary: bar.sentence, xAxis: x, yAxis: y, additionalAxes: [], series: [series])
    }
}

// MARK: - All

/// The vault's lines through the one `where:` language: the saved views, the
/// box — shown, selectable, copyable, editable — and what it answers (§8, §15.6).
struct TodayAllView: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: TodayModel
    let onTick: (TodayTask, Bool) -> Void
    @FocusState private var boxFocused: Bool

    var body: some View {
        let p = Palette(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: MetistrySpace.s4) {
                FlowLayout(spacing: MetistrySpace.s2) {
                    ForEach(SavedTaskView.all) { view in
                        ControlButton(ControlSpec(view.name, selected: view.filter != nil && view.filter == model.whereText.trimmingCharacters(in: .whitespaces), disabledBecause: view.unavailableBecause, name: "Saved view, \(view.name)")) {
                            Task { await model.apply(view) }
                        }
                    }
                }
                VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                    HStack(spacing: MetistrySpace.s2) {
                        Text(verbatim: "where:").metistryFont(.callout, design: .mono).foregroundStyle(p[.textSecondary]).accessibilityHidden(true)
                        TextField(TodayWords.wherePrompt, text: $model.whereText, prompt: Text(verbatim: TodayWords.wherePrompt))
                            .metistryFont(.callout, design: .mono)
                            .textFieldStyle(.roundedBorder)
                            .focused($boxFocused)
                            .onSubmit { Task { await model.runWhere() } }
                            .accessibilityLabel(Text(verbatim: TodayWords.whereLabel))
                        ControlButton(ControlSpec(TodayWords.show, name: "Show the lines this filter matches")) { Task { await model.runWhere() } }
                        ControlButton(ControlSpec(TodayWords.copy, role: .plain, disabledBecause: model.copyText == nil ? "Copying isn't available here" : nil, name: TodayWords.copyWhere)) {
                            model.copyText?(model.whereText.trimmingCharacters(in: .whitespacesAndNewlines))
                        }
                    }
                    Text(verbatim: TodayWords.whereHint).todayText(.footnote, p, .textSecondary).fixedSize(horizontal: false, vertical: true)
                }
                results(p)
            }
            .frame(maxWidth: MetistrySize.contentMax, alignment: .leading)
            .padding(MetistrySpace.s5)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .task {
            if case .unasked = model.allTasks { await model.runWhere() }
        }
        .onAppear { if model.takeBoxRequest() { boxFocused = true } }
        .onChange(of: model.boxRequests) { if model.takeBoxRequest() { boxFocused = true } }
    }

    @ViewBuilder
    private func results(_ p: Palette) -> some View {
        switch model.allTasks {
        case .unasked, .asking:
            PlaceholderRows(count: 3, waitingFor: nil)
        case .refused(let why):
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: "Couldn't read this filter. Nothing was guessed.").todayText(.callout, p, .degraded)
                Text(verbatim: why).metistryFont(.footnote, design: .mono).foregroundStyle(p[.textPrimary]).fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)
        case .failed(let why):
            StatePanel(StatePanelModel(.failed, title: "Couldn't Load These Lines", sentence: "Nothing is known about them — it isn't an empty list.", reason: why, action: StateWords.tryAgain)) {
                Task { await model.runWhere() }
            }
        case .rows(let rows, let filter, let more):
            VStack(alignment: .leading, spacing: MetistrySpace.s3) {
                if rows.isEmpty {
                    Text(verbatim: filter.isEmpty ? "No open lines in the vault." : "No open lines match where: \(filter)")
                        .todayText(.callout, p, .textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                let today = model.day?.date ?? TodayDates.ymd(model.now(), calendar: model.calendar)
                ForEach(rows) { task in
                    TodayTaskRow(task: task, today: today, note: model.notes[task.key], onTick: { onTick(task, $0) }, onUndo: { onTick(task, false) })
                }
                if more {
                    Text(verbatim: "Showing the first \(rows.count). Narrow the filter to see the rest.")
                        .todayText(.footnote, p, .textSecondary)
                }
            }
        }
    }
}

extension View {
    /// Move Up and Move Down, for VoiceOver and Full Keyboard Access — what a drag does, one place at a time.
    @ViewBuilder
    func todayMoveActions(up: (() -> Void)?, down: (() -> Void)?) -> some View {
        if up == nil && down == nil {
            self
        } else {
            self
                .accessibilityAction(named: Text(verbatim: TodayWords.moveUp)) { up?() }
                .accessibilityAction(named: Text(verbatim: TodayWords.moveDown)) { down?() }
                .contextMenu {
                    Button(TodayWords.moveUp) { up?() }.disabled(up == nil)
                    Button(TodayWords.moveDown) { down?() }.disabled(down == nil)
                }
        }
    }
}

extension TodayWords {
    public static let todayOrAll = "Today / All"
    public static let todayOrAllSpoken = "Today or All, Option-Command-T"
    public static let noWorkingHours = "Me/profile.md has no working_hours, so the day bar has no day to measure against."
    public static let allDay = "All day"
    public static let earlier = "Earlier today"
    public static let wherePrompt = "due <= today or overdue"
    public static let whereLabel = "where:, the filter in the template language"
    public static let whereHint = "The same language as a template's where: — paste it into Templates/Plan.md, or type any filter the views can't build."
    public static let show = "Show"
    public static let copy = "Copy"
    public static let copyWhere = "Copy the where: filter"
    public static let moveUp = "Move Up"
    public static let moveDown = "Move Down"

    /// *Doesn't fit before 5:30 PM* — shown, never refused.
    public static func doesNotFit(_ end: String?) -> String {
        end.map { "Doesn’t fit before \($0)" } ?? "Doesn’t fit today"
    }
}

extension View {
    /// A type step and its ink that grow with the largest text size on the Mac too (§2.18.5).
    func todayText(_ style: MetistryTextStyle, _ p: Palette, _ role: MetistryColorRole = .textPrimary) -> some View {
        metistryFont(style).foregroundStyle(p[role])
    }
}

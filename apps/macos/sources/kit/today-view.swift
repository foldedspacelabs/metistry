// Today (design-build-plan T6-1b; screen-05-today.md §15.1–15.3, §15.5).
//
// THE TOP OF THE DAY. The Morning Brief is Today's first state — one wash,
// then the Standup collapsed — and folds to a line once read; Next Up sticks
// under the header from thirty minutes before the next meeting; calendar
// help is one line beside its one action; and from thirty minutes before the
// working day ends, the top becomes Close the Day. The pieces, and what each
// reads and writes, are in today-brief-view.swift.
//
// THE DAY BELOW is the day's meetings and tasks in plain rows — the spine,
// NOW and the day bar are T6-1a's (`today-model.swift`), which grows this
// list; what is here is what Next Up and Close the Day stand on.
//
// WHAT IT WRITES, and nothing else: the Tick door and the Defer door, each one
// field on one line of the owner's note, refused `409 stale` if the line is not
// the one drawn here; `POST /api/today/close`; a meeting's note
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
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: MetistrySpace.s5) {
                            TodayPage(model: model, assistantName: assistantName, onOpenPath: onOpenPath, onRecord: onRecord, onGoToNeedsYou: onGoToNeedsYou)
                        }
                        .frame(maxWidth: MetistrySize.contentMax, alignment: .leading)
                        .padding(MetistrySpace.s5)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(p[.surface])
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
}

/// The page's pieces, in order: header, Close the Day, the brief, Next Up, calendar help, the day.
struct TodayPage: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: TodayModel
    let assistantName: String?
    let onOpenPath: ((String) -> Void)?
    let onRecord: ((TodayEvent) -> Void)?
    let onGoToNeedsYou: (() -> Void)?

    var body: some View {
        let p = Palette(scheme)
        if let day = model.day {
            header(day, p)
            closeArea(day)
            briefArea(day, p)
            nextUpArea(day, p)
            helpArea(p)
            dayList(day, p)
        }
    }

    private func header(_ day: TodayDay, _ p: Palette) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s3) {
            Text(verbatim: TodayWords.title).metistryText(.title2, p).accessibilityAddTraits(.isHeader)
            if let date = TodayDates.date(day.date, calendar: model.calendar) {
                Text(verbatim: Self.longDay(date, calendar: model.calendar)).metistryText(.callout, p, .textSecondary)
            }
            Spacer(minLength: MetistrySpace.s2)
            if case .idle = model.close, !model.closeIsDue {
                // Before the window, closing early is one quiet control away — never a dead end.
                ControlButton(ControlSpec(TodayWords.closeEarly, role: .plain, name: "Close the Day early")) { model.openClose() }
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
                    onTick: { task, checked in Task { await model.tick(task, checked: checked) } },
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
                onTick: { task, checked in Task { await model.tick(task, checked: checked) } }
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

    @ViewBuilder
    private func dayList(_ day: TodayDay, _ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s3) {
            Text(verbatim: TodayWords.theDay).metistryText(.headline, p).accessibilityAddTraits(.isHeader)
            if model.isEmptyDay {
                Text(verbatim: "Nothing scheduled for today. That means nothing is due or planned — not that you're finished.")
                    .metistryText(.callout, p, .textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            let inNextUp: String? = { if case .card(let card) = model.nextUp { return card.event.id } else { return nil } }()
            ForEach(day.timedEvents) { event in
                HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                    Image(systemName: "calendar").foregroundStyle(p[.textSecondary]).accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: event.title).metistryText(.body, p).fixedSize(horizontal: false, vertical: true)
                        Text(verbatim: event.id == inNextUp ? TodayWords.inNextUp : model.clock.range(event.start, event.end))
                            .metistryText(.footnote, p, .textSecondary)
                    }
                }
                .accessibilityElement(children: .combine)
            }
            ForEach(day.tasks.filter { $0.isOpen || model.kept.contains($0.key) }) { task in
                TodayTaskRow(task: task, today: day.date, note: model.notes[task.key], onTick: { checked in Task { await model.tick(task, checked: checked) } }, onUndo: { Task { await model.tick(task, checked: false) } })
            }
        }
    }
}

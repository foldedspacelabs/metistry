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

// MARK: - The day, as GET /api/today serves it

/// One `vault_tasks` row (T2-7's `tasks`). The whole row is kept for the facet row.
public struct TodayTask: Sendable, Equatable, Identifiable {
    public let key: String
    public let path: String
    public let text: String
    public let checked: Bool
    public let dropped: Bool
    public let waiting: Bool
    /// The person facet, as written (`Jim`, `Jim Fallon`).
    public let assigned: String?
    public let carriedDays: Int
    public let row: JSONValue

    public var id: String { key }

    public init?(json: JSONValue) {
        guard let key = json.string("task_key"), let text = json.string("text") else { return nil }
        self.key = key
        self.path = json.string("path") ?? ""
        self.text = text
        self.checked = json["checked"]?.boolValue ?? false
        self.dropped = json["dropped"]?.boolValue ?? false
        self.waiting = json["waiting"]?.boolValue ?? false
        self.assigned = json.string("assigned").flatMap { $0.isEmpty ? nil : $0 }
        self.carriedDays = json["carried_days"]?.intValue ?? 0
        self.row = json
    }

    public var isOpen: Bool { !checked && !dropped }
    /// Owed to someone: open, a person named, and not waiting on them (C102).
    public var isOwed: Bool { isOpen && !waiting && assigned != nil }

    /// components-02 §3: *Send Jim the revised Q4 scope. Priority 2, 30 minutes, third day* —
    /// and ticked, *Sign the SOW, done. Written to today's note. Undo available*.
    public func spoken(today: String, note: TodayTaskNote?) -> String {
        if checked || { if case .ticked = note { return true } else { return false } }() {
            let notePath = { () -> String in if case .ticked(let p) = note { return p } else { return path } }()
            let written = notePath == "Journal/\(today).md" ? "Written to today's note" : "Written to \(notePath)"
            let undo = { if case .ticked = note { return ". Undo available" } else { return "" } }()
            return "\(text), done. \(written)\(undo)"
        }
        var facets: [String] = []
        if let p = row["priority"]?.intValue { facets.append("Priority \(p)") }
        if let size = row.string("size"), let minutes = TaskFacets.defaultSizeMinutes[size.lowercased()] { facets.append(FacetRowModel.spokenMinutes(minutes)) }
        if carriedDays >= 2 { facets.append(FacetRowModel.carriedWords(carriedDays)) }
        return facets.isEmpty ? text : "\(text). \(facets.joined(separator: ", "))"
    }
}

/// One attendee as `day_events` serves it.
public struct TodayAttendee: Sendable, Equatable {
    public let name: String?
    public let email: String?
    /// `People/Dana.md`, when the attendee resolves to a person page (A4).
    public let person: String?
    public let isSelf: Bool

    public init(json: JSONValue) {
        name = json.string("name")
        email = json.string("email")
        person = json.string("person")
        isSelf = json["self"]?.boolValue ?? false
    }

    public var displayName: String {
        if let name, !name.isEmpty { return name }
        if let base = personBase { return base }
        return email ?? "someone"
    }

    var personBase: String? {
        guard let person else { return nil }
        let file = person.split(separator: "/").last.map(String.init) ?? person
        return file.hasSuffix(".md") ? String(file.dropLast(3)) : file
    }

    /// Whether a task's person facet names this attendee: the name, the
    /// person page, or the first name, compared without case.
    public func matches(_ assigned: String) -> Bool {
        let who = assigned.trimmingCharacters(in: .whitespaces).lowercased()
        guard !who.isEmpty else { return false }
        let names = [name, personBase].compactMap { $0?.lowercased() }
        return names.contains(who) || names.contains { $0.split(separator: " ").first.map(String.init) == who }
    }
}

/// One `day_events` row.
public struct TodayEvent: Sendable, Equatable, Identifiable {
    public let id: String
    public let title: String
    public let start: Date
    public let end: Date
    public let allDay: Bool
    public let location: String?
    public let attendees: [TodayAttendee]
    /// The meeting note's path, when there is one (A3).
    public let note: String?

    public init?(json: JSONValue) {
        guard let id = json.string("event_id"), let start = WireTime.date(json.string("start")) else { return nil }
        self.id = id
        self.title = json.string("title") ?? "(untitled)"
        self.start = start
        self.end = WireTime.date(json.string("end")) ?? start
        self.allDay = json["all_day"]?.boolValue ?? false
        self.location = json.string("location").flatMap { $0.isEmpty ? nil : $0 }
        self.attendees = (json["attendees"]?.arrayValue ?? []).map(TodayAttendee.init(json:))
        self.note = json.string("note")
    }

    /// Everyone but the owner.
    public var others: [TodayAttendee] { attendees.filter { !$0.isSelf } }
    /// The standup gets two lines and Copy Standup, not a briefing (§15.2).
    public var isStandup: Bool { title.range(of: #"\bstand[- ]?up\b"#, options: [.regularExpression, .caseInsensitive]) != nil }
}

/// `GET /api/today`.
public struct TodayDay: Sendable, Equatable {
    public let date: String
    public let tasks: [TodayTask]
    public let events: [TodayEvent]
    public let brief: String?
    public let standup: String?
    public let plan: String?
    public let asOf: Date?

    public init(json: JSONValue) {
        date = json.string("date") ?? ""
        tasks = (json["tasks"]?.arrayValue ?? []).compactMap(TodayTask.init(json:))
        events = (json["events"]?.arrayValue ?? []).compactMap(TodayEvent.init(json:))
        brief = json.string("brief")
        standup = json.string("standup")
        plan = json.string("plan")
        asOf = WireTime.date(json.string("as_of"))
    }

    /// Timed meetings in start order — an all-day event has no *next up*.
    public var timedEvents: [TodayEvent] { events.filter { !$0.allDay }.sorted { $0.start < $1.start } }
}

// MARK: - The brief's state

public enum BriefReading: Sendable, Equatable {
    case unasked
    case reading
    case ready(BriefDocument, standup: String?)
    /// Absent: `Me/profile.md` names no working days, so no brief is written (§15.1).
    case noWorkingDays
    /// Failed: the morning's run failed — when it ran, and when it runs next.
    case runFailed(at: Date?, next: Date?)
    /// Not written yet today.
    case notYet(next: Date?)
    /// The file is named and could not be read.
    case unreadable(String)
}

/// A move in flight: asking for the preview, the warning on screen, or its outcome.
public enum MoveState: Sendable, Equatable {
    case idle
    case asking(eventID: String)
    case confirming(MoveWarning)
    case moved(String)
    case failed(String)
}

public enum CloseState: Sendable, Equatable {
    /// Nothing asked: the panel shows itself only inside the closing window.
    case idle
    case open
    case closing
    case closed(ClosedDay)
    case noteNotWritten(NoteNotWritten)
    case refused(String)
}

public enum AgendaAsk: Sendable, Equatable {
    case asking
    case asked
    case failed(String)
}

// MARK: - The model

/// Today's top and the day under it. Held by `AppModel`, so the brief's fold,
/// a closed day and a dismissed offer outlive a trip to another screen;
/// dropped with everything else on an instance switch.
@MainActor
@Observable
public final class TodayModel {
    public static let policy = RefreshPolicy.board
    /// How long the day on screen may go unrefreshed before the band says so.
    public static let ageLimit: TimeInterval = 600
    /// Close the Day takes the top from this long before the working day ends (§15.5).
    public static let closeLead: TimeInterval = 30 * 60
    static let briefReadKey = "metistry.today.briefRead"

    public private(set) var section = Section<TodayDay>()
    public private(set) var loadingSince: Date?
    public private(set) var consecutiveFailures = 0
    public private(set) var isInvalidated = false

    public private(set) var brief: BriefReading = .unasked
    /// Nil until read; an empty profile when the file is not there.
    public private(set) var profile: WorkingProfile?
    public private(set) var tomorrow: TomorrowShape?

    /// Whether the brief is drawn open. Opening Next Up's line folds it.
    public private(set) var briefOpen = true
    public private(set) var notes: [String: TodayTaskNote] = [:]
    public private(set) var close: CloseState = .idle
    public var closeLine = ""
    public private(set) var move: MoveState = .idle
    public private(set) var agenda: [String: AgendaAsk] = [:]
    public private(set) var notesNote: String?
    /// The day calendar help was dismissed for: Not Today means not today.
    public private(set) var helpDismissedOn: String?
    /// Moves every tick of the view's clock, so what depends on the time is drawn again.
    public private(set) var clockTick = 0

    @ObservationIgnored public var now: @MainActor () -> Date
    @ObservationIgnored public let calendar: Calendar
    @ObservationIgnored public let clock: ClockTime
    /// The platform's pasteboard, supplied by the app target (the kit has no AppKit).
    @ObservationIgnored public var copyText: (@MainActor (String) -> Void)?
    @ObservationIgnored private weak var session: ConsoleSession?
    @ObservationIgnored private let defaults: UserDefaults?
    /// Lines deferred from the close panel stay drawn with their receipt, whatever the day reloads to.
    @ObservationIgnored private var deferred: [String: TodayTask] = [:]
    @ObservationIgnored private var briefFor: String?
    @ObservationIgnored private var tomorrowFor: String?
    @ObservationIgnored private var generationAsked = 0

    public init(session: ConsoleSession, timeZone: TimeZone = .current, defaults: UserDefaults? = nil, now: @escaping @MainActor () -> Date = { Date() }) {
        self.session = session
        self.defaults = defaults
        self.now = now
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        self.calendar = calendar
        self.clock = ClockTime(timeZone: timeZone)
        session.register { [weak self] in
            guard let self else { return false }
            self.reset()
            return true
        }
        session.events.watch([.today]) { [weak self] _ in
            guard let self else { return false }
            self.isInvalidated = true
            return true
        }
    }

    // MARK: Reading

    public var day: TodayDay? { section.value }

    public var document: BriefDocument? {
        if case .ready(let doc, _) = brief { return doc }
        return nil
    }

    public var standupText: String? {
        if case .ready(_, let standup) = brief { return standup }
        return nil
    }

    /// Ticked lines keep their place, struck, with their receipt.
    var kept: Set<String> {
        Set(notes.compactMap { key, note in if case .ticked = note { return key } else { return nil } })
    }

    public var nextUp: NextUpState {
        guard let day else { return .none }
        _ = clockTick
        let state = NextUp.of(day, brief: document, now: now())
        guard case .card(let card) = state else { return state }
        // a line ticked a moment ago stays in the card, struck, with its Undo
        let keep = day.tasks.filter { kept.contains($0.key) && !card.owed.contains($0) && $0.assigned.map { who in card.event.others.contains { $0.matches(who) } } == true }
        return keep.isEmpty ? state : .card(NextUpCard(event: card.event, minutes: card.minutes, owed: card.owed + keep, written: card.written))
    }

    public var calendarHelp: CalendarHelp? {
        guard let day, helpDismissedOn != day.date else { return nil }
        _ = clockTick
        return CalendarHelp.offer(day, profile: profile, now: now(), calendar: calendar)
    }

    /// Every prediction the page draws, in the order offered — three at most.
    public var predictions: [TodayPrediction] {
        var candidates: [TodayPrediction?] = []
        if case .card(let card) = nextUp { candidates.append(card.prediction) }
        candidates.append(calendarHelp?.prediction)
        return TodayPredictions.page(candidates)
    }

    public func isOnPage(_ prediction: TodayPrediction?) -> TodayPrediction? {
        guard let prediction, predictions.contains(prediction) else { return nil }
        return prediction
    }

    /// The one expanded wash on the page (§15.3).
    public var expandedWash: TodayWash? {
        var written = false
        if case .card(let card) = nextUp { written = card.written != nil && !card.isStandup }
        let closing: Bool = { if case .idle = close { return closeIsDue } else if case .open = close { return true } else if case .closing = close { return true } else if case .refused = close { return true } else { return false } }()
        // While Close the Day holds the top, the brief is its folded line.
        return TodayWashes.expanded(briefOpen: briefOpen && !closing, briefHasProse: document?.prose != nil, nextUpWritten: written)
    }

    /// From thirty minutes before `working_hours` ends. Never, when the profile does not say.
    public var closeIsDue: Bool {
        _ = clockTick
        guard let end = profile?.dayEnd else { return false }
        let at = now()
        let dayEnd = calendar.startOfDay(for: at).addingTimeInterval(TimeInterval(end * 60))
        return at >= dayEnd.addingTimeInterval(-Self.closeLead)
    }

    /// Whether the close panel is drawn.
    public var closePanelShown: Bool {
        switch close {
        case .idle: return closeIsDue
        case .open, .closing, .refused: return true
        case .closed, .noteNotWritten: return false
        }
    }

    public var closePlan: CloseDayPlan? {
        guard let day else { return nil }
        let present = Set(day.tasks.map(\.key))
        let extra = deferred.values.filter { !present.contains($0.key) }.sorted { $0.text < $1.text }
        let merged = TodayDay(date: day.date, tasks: day.tasks + extra, events: day.events)
        return CloseDayPlan(merged)
    }

    public var deferChoices: [(DeferChoice, TaskDeferral)] {
        guard let day else { return [] }
        return DeferChoice.available(today: day.date, profile: profile, calendar: calendar)
    }

    public var tomorrowDate: String? { day.flatMap { TodayDates.adding(1, to: $0.date, calendar: calendar) } }

    /// What takes the page's place, if anything.
    public enum Panel: Sendable, Equatable {
        case placeholders(waitingFor: String?)
        case page(staleSince: Date?)
        case state(StatePanelModel)
    }

    public var panel: Panel {
        switch FirstPaint.paint(section, loadingSince: loadingSince, ageLimit: Self.ageLimit, waitingFor: "Reading today", now: now()) {
        case .placeholders(let waiting): return .placeholders(waitingFor: waiting)
        case .failed(let why): return .state(StatePanelModel(.failed, title: "Couldn't Load Today", sentence: "Nothing is known about today — it isn't an empty day.", reason: why, action: StateWords.tryAgain))
        case .content(let stale): return .page(staleSince: stale)
        }
    }

    /// Nothing due, nothing planned, no meetings — which is not *finished* (screen 5 §7).
    public var isEmptyDay: Bool {
        guard let day else { return false }
        return day.tasks.isEmpty && day.events.isEmpty
    }

    // MARK: Asking

    /// The day, then what hangs off it: the profile once, the brief once per day.
    public func load() async {
        guard let session else { return }
        let generation = session.generation
        isInvalidated = false
        loadingSince = now()
        section.beginLoading(background: section.hasValue)
        let answer = await session.stores.today(date: nil)
        guard session.generation == generation else { return }
        loadingSince = nil
        switch answer {
        case .success(let reply):
            let day = TodayDay(json: reply.json)
            section.loaded(day, asOf: day.asOf, at: now())
            consecutiveFailures = 0
        case .failure(let error):
            section.failed(error, at: now())
            if case .unreachable = section.reachability { consecutiveFailures += 1 } else { consecutiveFailures = 0 }
        }
        if profile == nil { await loadProfile() }
        if let day, briefFor != day.date { await loadBrief(for: day) }
        if closePanelShown, let day, tomorrowFor != day.date { await loadTomorrow() }
    }

    /// What the view's clock calls: the time moves every tick; the console is asked only when due.
    public func refreshIfDue() async {
        clockTick &+= 1
        let due = isInvalidated || Self.policy.isDue(lastAttemptAt: section.lastAttemptAt, consecutiveFailures: consecutiveFailures, now: now())
        if due { await load() } else if closePanelShown, let day, tomorrowFor != day.date { await loadTomorrow() }
    }

    func loadProfile() async {
        guard let session else { return }
        let generation = session.generation
        let answer = await session.stores.knowledgePage(path: WorkingProfile.path)
        guard session.generation == generation else { return }
        switch answer {
        case .success(let page): profile = WorkingProfile.parse(page.content)
        case .failure(.http(404, _)): profile = WorkingProfile()
        case .failure: break  // unknown, and asked again with the day
        }
    }

    /// The brief and the standup are files: read through the page route, never assembled here.
    func loadBrief(for day: TodayDay) async {
        guard let session else { return }
        let generation = session.generation
        briefFor = day.date
        brief = .reading
        if let path = day.brief {
            switch await session.stores.knowledgePage(path: path) {
            case .success(let page):
                var standup: String?
                if let s = day.standup, case .success(let sp) = await session.stores.knowledgePage(path: s) { standup = sp.content }
                guard session.generation == generation else { return }
                brief = .ready(BriefDocument.parse(page.content), standup: standup)
                // folded once read: on the next open, never under the reader
                briefOpen = defaults?.string(forKey: Self.briefReadKey) != day.date
                return
            case .failure(.http(404, _)):
                break  // named before the routine wrote it
            case .failure(let error):
                guard session.generation == generation else { return }
                brief = .unreadable(error.localizedDescription)
                return
            }
        }
        if let profile, profile.workingDays == nil {
            brief = .noWorkingDays
            return
        }
        let routine = await session.stores.routine("morning-brief")
        guard session.generation == generation else { return }
        guard case .success(let detail) = routine else { brief = .notYet(next: nil); return }
        let r = detail.json["routine"]
        let next = WireTime.date(r?.string("next_run"))
        if let last = r?["last_run"], let at = WireTime.date(last.string("at")), calendar.isDate(at, inSameDayAs: now()), last["ok"]?.boolValue == false {
            brief = .runFailed(at: at, next: next)
        } else {
            brief = .notYet(next: next)
        }
    }

    func loadTomorrow() async {
        guard let session, let date = tomorrowDate else { return }
        tomorrowFor = day?.date
        let generation = session.generation
        let answer = await session.stores.today(date: date)
        guard session.generation == generation else { return }
        if case .success(let reply) = answer { tomorrow = TomorrowShape(TodayDay(json: reply.json)) }
    }

    // MARK: The brief and the washes

    /// The brief was on screen open: it folds on the next open (§15.1).
    public func briefWasRead() {
        guard let day, case .ready = brief else { return }
        defaults?.set(day.date, forKey: Self.briefReadKey)
    }

    /// Today opened again: a brief read last time is its line now.
    public func opened() {
        guard let day, case .ready = brief else { return }
        briefOpen = defaults?.string(forKey: Self.briefReadKey) != day.date
    }

    public func openBrief() { briefOpen = true }

    /// Opening Next Up's line folds the brief: one voice open at a time.
    public func openNextUpLine() {
        briefWasRead()
        briefOpen = false
    }

    public func copyStandup() {
        guard let text = standupText else { return }
        copyText?(BriefText.withoutTitle(text))
    }

    // MARK: Tick and Defer

    /// Tick and Undo: the same door, the two directions (§2.11).
    public func tick(_ task: TodayTask, checked: Bool) async {
        guard let session else { return }
        notes[task.key] = nil
        let answer = await session.stores.check(task.key, checked: checked, seenText: task.text, idempotencyKey: "tick-\(UUID().uuidString)")
        switch answer {
        case .success:
            notes[task.key] = checked ? .ticked(path: task.path) : .reopened(path: task.path)
            await load()
        case .failure(let error):
            notes[task.key] = Self.refusal(error)
        }
    }

    /// Defer from the close panel: a `do` day or someday, one field on one line.
    public func deferTask(_ task: TodayTask, to choice: DeferChoice) async {
        guard let session, let deferral = deferChoices.first(where: { $0.0 == choice })?.1 else { return }
        let answer = await session.stores.schedule(task.key, deferral, seenText: task.text, idempotencyKey: "defer-\(UUID().uuidString)")
        switch answer {
        case .success:
            deferred[task.key] = task
            notes[task.key] = .deferred(choice)
        case .failure(let error):
            notes[task.key] = Self.refusal(error)
        }
    }

    static func refusal(_ error: ConsoleError) -> TodayTaskNote {
        if case .http(409, let envelope?) = error, envelope.reason == "stale" {
            return .stale(line: envelope.details["line"]?.stringValue)
        }
        return .failed("Not written — \(error.localizedDescription)")
    }

    // MARK: Close the Day

    public func openClose() {
        close = .open
        Task { await self.loadTomorrow() }
    }

    public func closeDay() async {
        guard let session, let day else { return }
        close = .closing
        let line = closeLine.trimmingCharacters(in: .whitespacesAndNewlines)
        let answer = await session.stores.closeDay(day.date, line: line.isEmpty ? nil : line)
        switch CloseOutcome.of(answer, day: day.date) {
        case .closed(let closed):
            close = .closed(closed)
            isInvalidated = true
        case .noteNotWritten(let missing):
            close = .noteNotWritten(missing)
        case .refused(let why):
            close = .refused(why)
            if case .failure(.http(409, _)) = answer { isInvalidated = true }
        }
    }

    // MARK: Calendar help

    public func dismissCalendarHelp() {
        helpDismissedOn = day?.date
    }

    /// Preview first; a meeting with people in it warns, naming them and the new time (C90).
    public func beginMove(_ help: CalendarHelp) async {
        guard let session else { return }
        move = .asking(eventID: help.event.id)
        let request = EventMove(start: Self.iso(help.start), end: Self.iso(help.end))
        let answer = await session.stores.moveEvent(help.event.id, request)
        switch answer {
        case .success(let reply):
            guard let warning = MoveWarning(preview: reply.json, request: request) else {
                move = .failed("The calendar didn't return a preview — nothing was moved.")
                return
            }
            if warning.people.isEmpty {
                await confirmMove(warning)
            } else {
                move = .confirming(warning)
            }
        case .failure(let error):
            move = .failed("Couldn't ask the calendar — nothing was moved. \(error.localizedDescription)")
        }
    }

    public func confirmMove(_ warning: MoveWarning) async {
        guard let session else { return }
        move = .asking(eventID: warning.eventID)
        var request = warning.request
        request.confirmToken = warning.token
        let answer = await session.stores.moveEvent(warning.eventID, request)
        switch answer {
        case .success(let reply) where reply.json["moved"]?.boolValue == true:
            let told = warning.people.isEmpty ? "" : " — your calendar tells \(TodayWords.list(warning.people))"
            move = .moved("Moved the \(warning.title) to \(clock.range(warning.start, warning.end))\(told).")
            isInvalidated = true
        case .success:
            move = .failed("The calendar didn't confirm the move — nothing was moved.")
        case .failure(let error):
            move = .failed("Not moved — \(error.localizedDescription)")
        }
    }

    public func cancelMove() { move = .idle }

    static func iso(_ date: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: date)
    }

    // MARK: Next Up's acts

    /// The meeting's note — the first one's, on a second call — for the owner to open.
    public func meetingNote(_ event: TodayEvent) async -> String? {
        guard let session else { return nil }
        notesNote = nil
        switch await session.stores.meetingNote(eventID: event.id) {
        case .success(let reply):
            guard let path = reply.json.string("path") else {
                notesNote = "Couldn't open the meeting's note — the console named no file."
                return nil
            }
            return path
        case .failure(let error):
            notesNote = "Couldn't open the meeting's note — \(error.localizedDescription)"
            return nil
        }
    }

    /// Draft the Agenda: one message to the assistant, naming the meeting and what is owed.
    public func draftAgenda(_ card: NextUpCard) async {
        guard let session else { return }
        agenda[card.event.id] = .asking
        let people = TodayWords.list(card.event.others.map(\.displayName))
        let items = card.owed.map { "- \($0.text)" }.joined(separator: "\n")
        let text = "Draft an agenda for \(card.event.title) at \(clock.time(card.event.start))\(people.isEmpty ? "" : " with \(people)"). The open items:\n\(items)"
        switch await session.stores.send(text) {
        case .success: agenda[card.event.id] = .asked
        case .failure(let error): agenda[card.event.id] = .failed("Not asked — \(error.localizedDescription)")
        }
    }

    /// Drop everything. Called by the session on an instance switch.
    public func reset() {
        section = Section()
        loadingSince = nil
        consecutiveFailures = 0
        isInvalidated = false
        brief = .unasked
        profile = nil
        tomorrow = nil
        briefOpen = true
        notes = [:]
        close = .idle
        closeLine = ""
        move = .idle
        agenda = [:]
        notesNote = nil
        helpDismissedOn = nil
        deferred = [:]
        briefFor = nil
        tomorrowFor = nil
    }
}

extension TodayDay {
    init(date: String, tasks: [TodayTask], events: [TodayEvent]) {
        self.date = date
        self.tasks = tasks
        self.events = events
        brief = nil
        standup = nil
        plan = nil
        asOf = nil
    }
}

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

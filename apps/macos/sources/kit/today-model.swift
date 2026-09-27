// Today's model (design-build-plan T6-1a, T6-1b; screen-05-today.md §12–§15).
//
// What the Today screen knows and asks for — the day as `GET /api/today`
// serves it, the brief and the close (T6-1b), and the day's spine, NOW, the
// day bar, drag order and All (T6-1a) — kept apart from the drawing in
// today-view.swift, so a test can hold the day without a window.

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
    /// Owed on an earlier day and still open — the query's own `carried` flag.
    public var isCarried: Bool { row["row_flags"]?.arrayValue?.contains(.string("carried")) ?? false }

    /// `size s│m│l` as minutes, from the profile's `task_size_minutes`. Nil: no size on the line.
    public func minutes(_ sizes: [String: Int]) -> Int? {
        row.string("size").flatMap { sizes[$0.lowercased()] }
    }

    /// The same line with its box as the Tick door left it — for a list that is not reloaded under the reader.
    public func with(checked value: Bool) -> TodayTask {
        guard case .object(var fields) = row else { return self }
        fields["checked"] = .bool(value)
        return TodayTask(json: .object(fields)) ?? self
    }
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

/// One `day_work` row (T2-7's `work`): an agent's row on the Board that is on
/// the day. It has no checkbox — there is nothing here for the owner to tick
/// (screen 5 §2) — and its lead is the board glyph in `agent`.
public struct TodayWork: Sendable, Equatable, Identifiable {
    public let id: String
    public let title: String
    public let status: String
    public let flags: Set<String>
    /// The owner's line this row waits on (`meta.blocked_by`), while it is open.
    public let waitsOn: String?

    public init?(json: JSONValue) {
        guard let id = json.string("id") ?? json["id"]?.intValue.map(String.init), let title = json.string("title") else { return nil }
        self.id = id
        self.title = title
        self.status = json.string("status") ?? ""
        self.flags = Set(json["row_flags"]?.arrayValue?.compactMap(\.stringValue) ?? [])
        self.waitsOn = json["blocked_by_task_open"]?.boolValue == true ? json.string("blocked_by_task") : nil
    }

    /// Its key in the day's order — spelled so it can never be a task key.
    public var key: String { "work:\(id)" }
    /// Closed on the day: it belongs to the morning's summary, not to what is left.
    public var isClosed: Bool { flags.contains("closed") || status == "done" || status == "cancelled" }

    /// *Work #41 · blocked · waiting on you: Send Dana the fixture format* — the fields the row has, never a control.
    public var reason: String {
        var parts = ["Work #\(id)"]
        if !status.isEmpty { parts.append(status.replacingOccurrences(of: "_", with: " ")) }
        if let waitsOn { parts.append("waiting on you: \(waitsOn)") }
        return parts.joined(separator: " · ")
    }

    public var spoken: String { "\(title). \(reason.replacingOccurrences(of: " · ", with: ", ")). An agent's row — Open it on the Board" }
}

/// `GET /api/today`.
public struct TodayDay: Sendable, Equatable {
    public let date: String
    public let tasks: [TodayTask]
    public let events: [TodayEvent]
    /// The day's agent rows (`day_work`).
    public let work: [TodayWork]
    /// The owner's drag order: task keys and `work:<id>`s (`today_order`).
    public let order: [String]
    public let brief: String?
    public let standup: String?
    public let plan: String?
    public let asOf: Date?

    public init(json: JSONValue) {
        date = json.string("date") ?? ""
        tasks = (json["tasks"]?.arrayValue ?? []).compactMap(TodayTask.init(json:))
        events = (json["events"]?.arrayValue ?? []).compactMap(TodayEvent.init(json:))
        work = (json["work"]?.arrayValue ?? []).compactMap(TodayWork.init(json:))
        order = (json["order"]?.arrayValue ?? []).compactMap(\.stringValue)
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

    /// Today or All (⌥⌘T). A scope, not a position in time (§14.4).
    public private(set) var mode: TodayMode = .today
    /// The morning, expanded in place. Folded on every open: by the afternoon the morning *is* a summary.
    public private(set) var pastOpen = false
    /// The order just dragged, drawn before the console has said it stored it.
    public private(set) var orderOverride: [String]?
    /// Why a drag did not stick.
    public private(set) var orderNote: String?
    /// All's `where:` box — the one filter language, shown, selectable and copyable (§8).
    public var whereText = ""
    public private(set) var allTasks: AllTasks = .unasked
    /// Go ▸ Filter (⌘F) asked for All's box; the view takes the request once.
    public private(set) var boxRequests = 0
    @ObservationIgnored private var boxRequestsTaken = 0

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
    @ObservationIgnored private var ordersInFlight = 0

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

    /// `task_size_minutes` from the profile; its documented defaults until the profile says.
    public var sizes: [String: Int] { profile?.sizeMinutes ?? TaskFacets.defaultSizeMinutes }

    /// The order the page draws: a drag not yet stored, else the day's own.
    public var order: [String] { orderOverride ?? day?.order ?? [] }

    /// The day as one column, NOW where the clock is (§12.2).
    public var spine: TodaySpine? {
        guard let day else { return nil }
        _ = clockTick
        return TodaySpine.build(day, order: order, kept: kept, now: now(), profile: profile, calendar: calendar, sizes: sizes)
    }

    /// Nil without `working_hours` in the profile.
    public var dayBar: DayBar? {
        guard let day, let spine else { return nil }
        return DayBar.of(day, spine: spine, profile: profile, calendar: calendar, sizes: sizes)
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
            // the stored order is the day's now; a drag still in flight keeps its own
            if ordersInFlight == 0 { orderOverride = nil }
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

    /// Tick and Undo: the same door, the two directions (§2.11). True when the line was written.
    @discardableResult
    public func tick(_ task: TodayTask, checked: Bool) async -> Bool {
        guard let session else { return false }
        notes[task.key] = nil
        let answer = await session.stores.check(task.key, checked: checked, seenText: task.text, idempotencyKey: "tick-\(UUID().uuidString)")
        switch answer {
        case .success:
            notes[task.key] = checked ? .ticked(path: task.path) : .reopened(path: task.path)
            if case .rows(let rows, let filter, let more) = allTasks {
                allTasks = .rows(rows.map { $0.key == task.key ? $0.with(checked: checked) : $0 }, filter: filter, more: more)
            }
            await load()
            return true
        case .failure(let error):
            // `409 stale`: the line as it now stands, and nothing written — never a retry over the owner's edit
            notes[task.key] = Self.refusal(error)
            return false
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

    // MARK: The spine

    public func togglePast() { pastOpen.toggle() }

    /// Drop `key` onto `target`'s place, then store the whole order (`PUT /api/today/order`).
    public func move(_ key: String, onto target: String) async {
        guard let keys = spine?.arranged.map(\.key), let next = TodayOrder.moving(key, onto: target, in: keys) else { return }
        await store(next)
    }

    /// Move Up and Move Down: the keyboard's and VoiceOver's way to do what a drag
    /// does — onto the row drawn above or below.
    public func move(_ key: String, by offset: Int) async {
        guard let drawn = spine?.placeable.map(\.key), let from = drawn.firstIndex(of: key), drawn.indices.contains(from + offset) else { return }
        await move(key, onto: drawn[from + offset])
    }

    /// Drawn at once; stored whole. A refusal puts the rows back where the console has them, and says so.
    func store(_ next: [String]) async {
        guard let session, let day else { return }
        let before = orderOverride
        orderOverride = next
        orderNote = nil
        ordersInFlight += 1
        defer { ordersInFlight -= 1 }
        let answer = await session.stores.setOrder(date: day.date, taskKeys: next)
        switch answer {
        case .success(let reply):
            if let stored = reply.json["order"]?.arrayValue?.compactMap(\.stringValue) { orderOverride = stored }
        case .failure(let error):
            orderOverride = before
            orderNote = "Not moved — \(error.localizedDescription)"
        }
    }

    // MARK: All

    public func setMode(_ next: TodayMode) {
        mode = next
    }

    /// View ▸ Today / All (⌥⌘T).
    public func toggleMode() { setMode(mode == .today ? .all : .today) }

    /// Go ▸ Filter (⌘F): All, with its box focused.
    public func askForTheBox() {
        setMode(.all)
        boxRequests += 1
    }

    /// Whether a ⌘F is waiting for the box — answered once.
    public func takeBoxRequest() -> Bool {
        guard boxRequestsTaken < boxRequests else { return false }
        boxRequestsTaken = boxRequests
        return true
    }

    /// `GET /api/vault-tasks?where=` with the box as it stands. The console compiles it; nothing is guessed here.
    public func runWhere() async {
        guard let session else { return }
        let generation = session.generation
        let filter = whereText.trimmingCharacters(in: .whitespacesAndNewlines)
        allTasks = .asking
        let answer = await session.stores.vaultTasks(where: filter)
        guard session.generation == generation else { return }
        switch answer {
        case .success(let reply):
            let rows = (reply.json["rows"]?.arrayValue ?? []).compactMap(TodayTask.init(json:))
            allTasks = .rows(rows, filter: filter, more: reply.json["more"]?.boolValue ?? false)
        case .failure(.http(400, let envelope)):
            allTasks = .refused(envelope?.message ?? "The console refused this filter.")
        case .failure(let error):
            allTasks = .failed(error.localizedDescription)
        }
    }

    /// A saved view loads its string into the box, where it can be read, copied and changed.
    public func apply(_ view: SavedTaskView) async {
        guard let filter = view.filter else { return }
        whereText = filter
        await runWhere()
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
        mode = .today
        pastOpen = false
        orderOverride = nil
        orderNote = nil
        whereText = ""
        allTasks = .unasked
    }
}

extension TodayDay {
    init(date: String, tasks: [TodayTask], events: [TodayEvent]) {
        self.date = date
        self.tasks = tasks
        self.events = events
        work = []
        order = []
        brief = nil
        standup = nil
        plan = nil
        asOf = nil
    }
}

// MARK: - The spine (screen-05 §12.2, §14.4)

/// One row the owner can place: a line of theirs, or an agent's row on the day.
public enum SpineItem: Sendable, Equatable, Identifiable {
    case task(TodayTask)
    case work(TodayWork)

    public var id: String { key }

    /// Its key in the day's order.
    public var key: String {
        switch self {
        case .task(let task): return task.key
        case .work(let work): return work.key
        }
    }

    public var title: String {
        switch self {
        case .task(let task): return task.text
        case .work(let work): return work.title
        }
    }

    /// The owner's minutes. An agent's row is not the owner's time (screen 5 §11), and a line with no size has none to count.
    public func minutes(_ sizes: [String: Int]) -> Int? {
        if case .task(let task) = self { return task.minutes(sizes) }
        return nil
    }
}

/// The owner's order (screen 5 §2: *the order you leave it in is stored and authoritative*).
public enum TodayOrder {
    /// The stored order first, then every row it does not name, as served.
    public static func arrange(_ items: [SpineItem], order: [String]) -> [SpineItem] {
        let byKey = Dictionary(items.map { ($0.key, $0) }, uniquingKeysWith: { a, _ in a })
        var seen = Set<String>()
        var out: [SpineItem] = []
        for key in order {
            if let item = byKey[key], seen.insert(key).inserted { out.append(item) }
        }
        out += items.filter { seen.insert($0.key).inserted }
        return out
    }

    /// `key` dropped onto `target`: it takes the target's place, as a drop does.
    /// Nil when either is not in `keys`, or nothing would move.
    public static func moving(_ key: String, onto target: String, in keys: [String]) -> [String]? {
        guard key != target, let from = keys.firstIndex(of: key), let to = keys.firstIndex(of: target) else { return nil }
        var out = keys
        out.remove(at: from)
        out.insert(key, at: to)
        return out
    }

}

/// The day as one time-ordered column: meetings at their time, the owner's
/// rows in the gaps between them, a NOW rule, and the morning folded above it
/// (§12.2, §14.4). With no meeting on the day there are no gaps, and the spine
/// is the plain list, in the owner's order (§12.4).
public struct TodaySpine: Sendable, Equatable {
    /// A stretch of free time, or a focus block — an event with nobody else in it (§14.5).
    public struct Gap: Sendable, Equatable, Identifiable {
        public let start: Date
        /// Nil: open-ended — the profile gives no `working_hours`, so the day has no end to fit against.
        public let end: Date?
        public let focus: TodayEvent?
        public var items: [SpineItem] = []
        /// The minutes the rows placed here are estimated at.
        public var used = 0
        /// Rows placed here with no size — counted as none, and said so.
        public var unsized = 0

        public var id: String { focus.map { "focus:\($0.id)" } ?? "gap:\(Int(start.timeIntervalSince1970))" }

        /// Nil when open-ended.
        public var minutes: Int? { end.map { Int(($0.timeIntervalSince(start) / 60).rounded(.down)) } }

        public var spare: Int? { minutes.map { $0 - used } }

        /// *35m free*, or the focus block's own name.
        public var label: String {
            if let focus { return "Focus — \(focus.title)" }
            guard let minutes else { return "Free" }
            return "\(ClockTime.duration(TimeInterval(minutes * 60))) free"
        }

        /// *both fit · 10m to spare*.
        public var fits: String {
            let n = items.count
            guard n > 0 else { return "Nothing planned here" }
            let fit = n == 1 ? "fits" : n == 2 ? "both fit" : "all \(n) fit"
            var parts = [fit]
            if let spare, spare > 0, unsized == 0 { parts.append("\(ClockTime.duration(TimeInterval(spare * 60))) to spare") }
            if unsized > 0 { parts.append(unsized == 1 ? "1 has no size" : "\(unsized) have no size") }
            return parts.joined(separator: " · ")
        }
    }

    public enum Entry: Sendable, Equatable, Identifiable {
        case meeting(TodayEvent)
        case gap(Gap)

        public var id: String {
            switch self {
            case .meeting(let event): return "meeting:\(event.id)"
            case .gap(let gap): return gap.id
            }
        }
    }

    /// Above NOW, folded to one line: what is done, and the meetings that are over.
    public struct Earlier: Sendable, Equatable {
        public var meetings: [TodayEvent] = []
        public var done: [SpineItem] = []
        /// Open rows owed on an earlier day, now on this one.
        public var carried = 0

        public var isEmpty: Bool { meetings.isEmpty && done.isEmpty && carried == 0 }

        /// *3 done · 1 meeting · 2 carried forward* (§14.4).
        public var summary: String {
            var parts: [String] = []
            if !done.isEmpty { parts.append("\(done.count) done") }
            if !meetings.isEmpty { parts.append(meetings.count == 1 ? "1 meeting" : "\(meetings.count) meetings") }
            if carried > 0 { parts.append("\(carried) carried forward") }
            return parts.joined(separator: " · ")
        }
    }

    public var earlier = Earlier()
    /// Every open row in the owner's order — what an order PUT sends, whatever the gaps did with it.
    public var arranged: [SpineItem] = []
    /// Where NOW is drawn. Nil: the plain list — no meetings, so no clock to hang the day on.
    public var now: Date?
    public var allDay: [TodayEvent] = []
    /// After NOW, in time order.
    public var entries: [Entry] = []
    /// The plain list, in the owner's order, when there is no NOW.
    public var list: [SpineItem] = []
    /// What is left when the gaps are full — never refused, only shown (§4: the meter refuses nothing).
    public var doesNotFit: [SpineItem] = []
    public var dayEnd: Date?

    /// A gap shorter than this between two meetings is a walk between rooms, not a place for a row.
    public static let shortestGap: TimeInterval = 10 * 60

    /// Every row the owner can drag, in the order drawn.
    public var placeable: [SpineItem] {
        if now == nil { return list }
        return entries.flatMap { entry -> [SpineItem] in
            if case .gap(let gap) = entry { return gap.items }
            return []
        } + doesNotFit
    }

    public var isList: Bool { now == nil }

    /// Lay the day out. `kept` are lines ticked on this screen: they keep their place, struck, with their receipt (P9).
    public static func build(_ day: TodayDay, order: [String], kept: Set<String>, now: Date, profile: WorkingProfile?, calendar: Calendar, sizes: [String: Int]) -> TodaySpine {
        var spine = TodaySpine()
        var open: [SpineItem] = []
        for task in day.tasks {
            if task.isOpen || kept.contains(task.key) {
                open.append(.task(task))
            } else if task.checked {
                spine.earlier.done.append(.task(task))
            }
        }
        for work in day.work {
            if work.isClosed { spine.earlier.done.append(.work(work)) } else { open.append(.work(work)) }
        }
        spine.earlier.carried = day.tasks.filter { $0.isOpen && $0.isCarried && !kept.contains($0.key) }.count
        let arranged = TodayOrder.arrange(open, order: order)
        spine.arranged = arranged
        spine.allDay = day.events.filter(\.allDay)

        let timed = day.timedEvents
        guard !timed.isEmpty else {
            spine.list = arranged
            return spine
        }
        spine.now = now
        spine.earlier.meetings = timed.filter { $0.end <= now }

        let base = TodayDates.date(day.date, calendar: calendar) ?? calendar.startOfDay(for: now)
        let dayStart = profile?.dayStart.map { base.addingTimeInterval(TimeInterval($0 * 60)) }
        let dayEnd = profile?.dayEnd.map { base.addingTimeInterval(TimeInterval($0 * 60)) }
        spine.dayEnd = dayEnd

        var cursor = max(now, dayStart ?? now)
        var entries: [Entry] = []
        func free(until end: Date) {
            let stop = dayEnd.map { min($0, end) } ?? end
            if stop.timeIntervalSince(cursor) >= shortestGap { entries.append(.gap(Gap(start: cursor, end: stop, focus: nil))) }
        }
        for event in timed where event.end > now {
            if event.others.isEmpty {
                // a focus block: the owner's own time, and rows go in it
                free(until: event.start)
                let start = max(cursor, event.start)
                let end = dayEnd.map { min($0, event.end) } ?? event.end
                if end > start { entries.append(.gap(Gap(start: start, end: end, focus: event))) } else { entries.append(.meeting(event)) }
            } else {
                free(until: event.start)
                entries.append(.meeting(event))
            }
            cursor = max(cursor, event.end)
        }
        if let dayEnd {
            free(until: dayEnd)
        } else {
            entries.append(.gap(Gap(start: cursor, end: nil, focus: nil)))
        }

        // The owner's order, top to bottom: each row goes in the first gap, from
        // the one the row above it went in, that still has room — so no row is
        // ever drawn above one the owner put before it. A row too long for any
        // gap left is shown under *Doesn't fit*, and does not hold up the rows
        // after it (§4: nothing is refused).
        var at = entries.startIndex
        for item in arranged {
            let minutes = item.minutes(sizes) ?? 0
            let slot = entries[at...].firstIndex { entry in
                if case .gap(let gap) = entry { return gap.spare.map { $0 >= minutes } ?? true }
                return false
            }
            guard let slot, case .gap(var gap) = entries[slot] else {
                spine.doesNotFit.append(item)
                continue
            }
            gap.items.append(item)
            gap.used += minutes
            if item.minutes(sizes) == nil, case .task = item { gap.unsized += 1 }
            entries[slot] = .gap(gap)
            at = slot
        }
        spine.entries = entries
        return spine
    }
}

// MARK: - The day bar (§14.3, §15.7)

/// Five segments against the working day: *Meetings · Travel · Focus Blocked ·
/// Tasks That Fit · Doesn't Fit*. A chart — the `chart-*` ramp, never the
/// facet channels — that speaks one sentence and carries its table.
public struct DayBar: Sendable, Equatable {
    public enum Segment: String, CaseIterable, Sendable, Identifiable {
        case meetings = "Meetings"
        case travel = "Travel"
        case focus = "Focus Blocked"
        case fits = "Tasks That Fit"
        case doesNotFit = "Doesn’t Fit"

        public var id: String { rawValue }
    }

    public let minutes: [Segment: Int]
    /// The working day's length, from `working_hours`.
    public let workingMinutes: Int

    public func value(_ segment: Segment) -> Int { minutes[segment] ?? 0 }

    /// What the calendar holds: meetings, travel and focus.
    public var committed: Int { value(.meetings) + value(.travel) + value(.focus) }

    /// *5h 2m committed of 9h · everything planned fits*.
    public var line: String {
        let over = value(.doesNotFit)
        let tail = over > 0 ? "\(Self.span(over)) doesn’t fit" : "everything planned fits"
        return "\(Self.span(committed)) committed of \(Self.span(workingMinutes)) · \(tail)"
    }

    /// The chart's one sentence (§2.18.3).
    public var sentence: String {
        let over = value(.doesNotFit)
        return "The day: \(Self.spoken(committed)) committed of \(Self.spoken(workingMinutes)); \(over > 0 ? "\(Self.spoken(over)) of tasks doesn’t fit" : "everything planned fits")"
    }

    static func span(_ minutes: Int) -> String { minutes == 0 ? "0m" : ClockTime.duration(TimeInterval(minutes * 60)) }

    static func spoken(_ minutes: Int) -> String {
        let h = minutes / 60, m = minutes % 60
        let hours = h == 1 ? "1 hour" : "\(h) hours"
        let mins = m == 1 ? "1 minute" : "\(m) minutes"
        if h > 0 && m > 0 { return "\(hours) \(mins)" }
        return h > 0 ? hours : mins
    }

    /// Nil when the profile gives no `working_hours`: there is no day to measure against, and none is assumed.
    public static func of(_ day: TodayDay, spine: TodaySpine, profile: WorkingProfile?, calendar: Calendar, sizes: [String: Int]) -> DayBar? {
        guard let startMin = profile?.dayStart, let endMin = profile?.dayEnd, endMin > startMin else { return nil }
        let base = TodayDates.date(day.date, calendar: calendar) ?? Date()
        let start = base.addingTimeInterval(TimeInterval(startMin * 60)), end = base.addingTimeInterval(TimeInterval(endMin * 60))
        func clipped(_ events: [TodayEvent]) -> Int {
            // overlapping meetings are one stretch of the day, counted once
            let spans = events.map { (max($0.start, start), min($0.end, end)) }.filter { $0.0 < $0.1 }.sorted { $0.0 < $1.0 }
            var total: TimeInterval = 0
            var current: (Date, Date)?
            for s in spans {
                if let c = current, s.0 <= c.1 { current = (c.0, max(c.1, s.1)) } else {
                    if let c = current { total += c.1.timeIntervalSince(c.0) }
                    current = s
                }
            }
            if let c = current { total += c.1.timeIntervalSince(c.0) }
            return Int((total / 60).rounded())
        }
        let timed = day.timedEvents
        var fits = 0
        for entry in spine.entries {
            if case .gap(let gap) = entry, gap.focus == nil { fits += gap.used }
        }
        return DayBar(minutes: [
            .meetings: clipped(timed.filter { !$0.others.isEmpty }),
            // No travel time is served yet (A1 carries `location`, not the drive), so none is counted.
            .travel: 0,
            .focus: clipped(timed.filter { $0.others.isEmpty }),
            .fits: fits,
            .doesNotFit: spine.doesNotFit.compactMap { $0.minutes(sizes) }.reduce(0, +),
        ], workingMinutes: endMin - startMin)
    }
}

// MARK: - All (§8, §15.6)

public enum TodayMode: String, CaseIterable, Sendable {
    case today = "Today"
    case all = "All"
}

/// A saved view of All: a stored `where:` string, loaded into the box as it is.
public struct SavedTaskView: Sendable, Equatable, Identifiable {
    public let name: String
    /// Nil: the `where:` language cannot say this view yet, and none is guessed at.
    public let filter: String?
    public let unavailableBecause: String?

    public var id: String { name }

    /// §15.6: Slipping · Owed · Waiting on Others. Slipping is *carried three or
    /// more times, overdue, or owed to someone* and Owed is *owed to someone*;
    /// the grammar has no carry count and no "names a person", so neither is
    /// written until it does (T2-7's open item) — they are drawn, dimmed, with why.
    public static let all: [SavedTaskView] = [
        SavedTaskView(name: "Slipping", filter: nil, unavailableBecause: "The where: language can’t say “carried three times” or “owed to someone” yet"),
        SavedTaskView(name: "Owed", filter: nil, unavailableBecause: "The where: language can’t say “owed to someone” yet"),
        SavedTaskView(name: "Waiting on Others", filter: "waiting", unavailableBecause: nil),
    ]
}

/// What All shows under its box.
public enum AllTasks: Sendable, Equatable {
    case unasked
    case asking
    /// The rows, the filter they answer, and whether there are more past the page.
    case rows([TodayTask], filter: String, more: Bool)
    /// `400`: outside the grammar — the parser's own words, naming the token.
    case refused(String)
    case failed(String)
}

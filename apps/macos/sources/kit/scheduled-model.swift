// Scheduled's model (design-build-plan T6-6, §2.5; screen-08-routines.md
// §10–§11): everything recurring, in one place — routines and syncs, when each
// acts, where each field came from, and what the owner may change.
//
// What the screen knows and asks for, kept apart from the drawing
// (scheduled-view.swift, routine-detail-view.swift) so a test can hold the
// week without a window. It reads `ScheduledStore` (T3-3's eleven doors) and
// nothing else, plus `GET /api/runs/:id` for the latest run's steps and
// `GET /api/whoami` for whether this client may change what runs.
//
// THE SCHEDULE IS WHEN IT ACTS, NEVER WHEN IT TICKED (§3). A row is an
// occurrence: a time the routine's schedule says it acts — its resolved days
// (the console's `days`, which already follows the profile) at each of its
// `at` times, in its zone — never a run read back from history. A routine
// that ticked twelve times and did nothing has twelve silent runs in its
// History and not one extra row here, and an interval routine (Inbox Sort,
// every 5 minutes) is one row in *Throughout the day*, never 288.
//
// TIMING IS INSIDE THE BOUNDARY; WHAT RUNS IS NOT (§2.3). A schedule, a
// pause, Reset to Default, a sync's cadence and raise toggles and Run Now are
// the owner's from any client. A New Routine's actor, task and per-run grants
// are reach `local`: the editor exists only while `GET /api/whoami` says this
// client is the local owner token, and `saveAssignment` refuses without
// sending anything otherwise — the console refuses it too (`403 local_only`),
// and that answer also takes the editor away. A client hiding a control is
// never the control; here the tool refuses as well.

import Foundation
import Observation
import SwiftUI

// MARK: - Where a field came from

/// `default` (the manifest) · `profile` (`Me/profile.md`) · `yours`
/// (`scheduled.yaml`) — core's `FIELD_ORIGINS`. A client renders the label and
/// never works the layer out.
public enum FieldOrigin: String, Sendable, Equatable, CaseIterable {
    case `default`, profile, yours

    public init(wire: String?) {
        self = FieldOrigin(rawValue: wire ?? "") ?? .default
    }

    /// §2.5: *default* · *from your profile* · *yours*.
    public var label: String {
        switch self {
        case .default: return "default"
        case .profile: return "from your profile"
        case .yours: return "yours"
        }
    }
}

/// A layered field: its value and the layer it came from.
public struct Sourced<Value: Sendable & Equatable>: Sendable, Equatable {
    public let value: Value
    public let origin: FieldOrigin

    public init(value: Value, origin: FieldOrigin) {
        self.value = value
        self.origin = origin
    }

    /// `{value, origin}` off the wire; nil when there is no such field or `read` refuses its value.
    static func read(_ json: JSONValue?, _ value: (JSONValue) -> Value?) -> Sourced<Value>? {
        guard let json, let raw = json["value"], let v = value(raw) else { return nil }
        return Sourced(value: v, origin: FieldOrigin(wire: json["origin"]?.stringValue))
    }
}

// MARK: - A schedule

/// The day part of a time-of-day schedule, as the owner (or the manifest) wrote it.
public enum DaySet: Sendable, Equatable {
    case workingDays
    /// Every day whose next day is a working day.
    case eveOfWorkingDays
    case weekdays([String])

    init?(_ json: JSONValue?) {
        switch json {
        case .string("working_days")?: self = .workingDays
        case .string("eve_of_working_days")?: self = .eveOfWorkingDays
        case .array(let a)?: self = .weekdays(a.compactMap(\.stringValue))
        default: return nil
        }
    }

    /// What `PUT …/schedule` takes back — the named set stays named, so a
    /// routine that follows the profile keeps following it.
    public var wire: [String] {
        switch self {
        case .workingDays: return ["working_days"]
        case .eveOfWorkingDays: return ["eve_of_working_days"]
        case .weekdays(let days): return days
        }
    }
}

/// When a routine acts: `{days, at, tz?}`, `{every}`, or — for one release —
/// a product manifest's cron string, kept verbatim.
public enum RoutineTiming: Sendable, Equatable {
    case timeOfDay(days: DaySet, at: [String], tz: String?)
    case interval(String)
    case unreadable(String)

    init(_ json: JSONValue) {
        if let every = json["every"]?.stringValue {
            self = .interval(every)
        } else if let days = DaySet(json["days"]), let at = json["at"]?.arrayValue?.compactMap(\.stringValue), !at.isEmpty {
            self = .timeOfDay(days: days, at: at, tz: json["tz"]?.stringValue)
        } else if let text = json.stringValue {
            self = .unreadable(text)
        } else {
            self = .unreadable(String(describing: json))
        }
    }

    public var isInterval: Bool {
        if case .interval = self { return true }
        return false
    }

    public var times: [String] {
        if case .timeOfDay(_, let at, _) = self { return at }
        return []
    }
}

// MARK: - A run

/// What one run came to — `meta.outcome` (D7) first, then `ok`.
public enum RunResult: Sendable, Equatable {
    case acted
    /// `silent`: a real outcome, said in words (§3: "Silent is gone").
    case nothingToDo
    case skipped(String)
    case failed(String)
    /// `ok` and no outcome recorded.
    case succeeded
    case unknown

    init(ok: Bool?, outcome: String?, error: String?) {
        if ok == false {
            self = .failed(error.flatMap { $0.isEmpty ? nil : $0 } ?? "no error was recorded")
        } else if outcome == "acted" {
            self = .acted
        } else if outcome == "silent" {
            self = .nothingToDo
        } else if let outcome, outcome.hasPrefix("skipped") {
            let reason = outcome.split(separator: ":", maxSplits: 1).dropFirst().first.map(String.init) ?? ""
            self = .skipped(reason.replacingOccurrences(of: "_", with: " "))
        } else if ok == true {
            self = .succeeded
        } else {
            self = .unknown
        }
    }

    /// The row's word: *Succeeded* · *Nothing to do* · *Skipped* · *Failed*.
    public var word: String {
        switch self {
        case .acted, .succeeded: return "Succeeded"
        case .nothingToDo: return "Nothing to do"
        case .skipped: return "Skipped"
        case .failed: return "Failed"
        case .unknown: return "Result not recorded"
        }
    }

    /// The word and why, where there is a why — an error verbatim (§6).
    public var sentence: String {
        switch self {
        case .skipped(let why) where !why.isEmpty: return "Skipped — \(why)"
        case .failed(let error): return "Failed — \(error)"
        default: return word
        }
    }

    public var isFailure: Bool {
        if case .failed = self { return true }
        return false
    }

    /// The mark that carries it: failed has its own, a skip is *absent* (§6), the rest none.
    public var glyph: (MetistryGlyph, MetistryColorRole)? {
        switch self {
        case .failed: return (.failed, .failed)
        case .skipped: return (.absent, .absent)
        default: return nil
        }
    }
}

/// `last_run`, and a History row (`routine_history`: the same plus `steps` and `trigger`).
public struct ScheduledRun: Sendable, Equatable, Identifiable {
    public let runID: String
    public let at: Date?
    public let result: RunResult
    public let costUSD: Double?
    /// How many tool calls it made; nil when not recorded.
    public let steps: Int?
    /// `run_now` for a run the owner asked for.
    public let trigger: String?

    public var id: String { runID }
    public var numericID: Int? { Int(runID) }

    public init?(json: JSONValue?) {
        guard let json, case .object = json else { return nil }
        runID = json.string("run_id") ?? json["run_id"]?.intValue.map(String.init) ?? ""
        at = WireTime.date(json.string("at"))
        result = RunResult(ok: json["ok"]?.boolValue, outcome: json.string("outcome"), error: json.string("error"))
        costUSD = json.string("cost_usd").flatMap(Double.init) ?? json["cost_usd"]?.doubleValue
        steps = json["steps"]?.intValue
        trigger = json.string("trigger")
    }
}

// MARK: - A routine, a sync

/// One key of a product routine's `config`, as the manifest (or the owner) set it.
public struct ScheduledConfigField: Sendable, Equatable, Identifiable {
    public let key: String
    public let value: String
    public let origin: FieldOrigin
    public var id: String { key }

    /// `skip_without_calendar_event` → *Skip without calendar event*.
    public var label: String {
        let words = key.replacingOccurrences(of: "_", with: " ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }
}

public struct ScheduledRoutine: Sendable, Equatable, Identifiable {
    public enum Source: String, Sendable { case product, `extension`, assignment }

    public let name: String
    public let title: String
    public let source: Source
    public let schedule: Sourced<RoutineTiming>
    public let paused: Sourced<Bool>
    public let config: [ScheduledConfigField]
    /// A New Routine's assignment; nil for a product routine, which the assistant runs.
    public let actor: String?
    public let task: String?
    public let readGrants: [String]
    /// A time of day's weekdays, resolved — `profile` when they follow `Me/profile.md`.
    public let days: Sourced<[String]>?
    public let timeZone: Sourced<String>?
    public let nextRun: Date?
    /// Why no next run can be placed (`no_working_days`, …).
    public let nextRefused: String?
    public let lastRun: ScheduledRun?
    /// No entry in the file — the **default** tag.
    public let isDefault: Bool
    /// Why the runner does not run it; nil when it runs.
    public let held: String?

    public var id: String { name }
    public var isAssignment: Bool { source == .assignment }
    public var isPaused: Bool { paused.value }
    /// Paused, held, or with no next run it can place: the *Inactive* band.
    public var isInactive: Bool { isPaused || held != nil || nextRefused != nil }

    public init?(json: JSONValue) {
        guard let name = json.string("name") else { return nil }
        self.name = name
        title = json.string("title") ?? name
        source = Source(rawValue: json.string("source") ?? "") ?? .product
        schedule = Sourced.read(json["schedule"], { RoutineTiming($0) }) ?? Sourced(value: .unreadable(json.string("describe") ?? ""), origin: .default)
        paused = Sourced.read(json["paused"], \.boolValue) ?? Sourced(value: false, origin: .default)
        var config: [ScheduledConfigField] = []
        if case .object(let fields)? = json["config"] {
            for key in fields.keys.sorted() {
                guard let field = fields[key], let value = field["value"] else { continue }
                let text: String
                switch value {
                case .string(let s): text = s
                case .bool(let b): text = b ? "on" : "off"
                case .number(let d): text = d == d.rounded() ? String(Int(d)) : String(d)
                case .null: continue
                default: text = String(describing: value)
                }
                config.append(ScheduledConfigField(key: key, value: text, origin: FieldOrigin(wire: field["origin"]?.stringValue)))
            }
        }
        self.config = config
        actor = json.string("actor")
        task = json.string("task")
        readGrants = json["grants"]?["read"]?.arrayValue?.compactMap(\.stringValue) ?? []
        days = Sourced.read(json["days"]) { $0.arrayValue?.compactMap(\.stringValue) }
        timeZone = Sourced.read(json["time_zone"], \.stringValue)
        nextRun = WireTime.date(json.string("next_run"))
        nextRefused = json["next_refused"]?.string("why", "reason")
        lastRun = ScheduledRun(json: json["last_run"])
        isDefault = json["is_default"]?.boolValue ?? false
        held = json.string("held")
    }
}

public struct ScheduledRaise: Sendable, Equatable, Identifiable {
    public let rule: String
    public let on: Sourced<Bool>
    public var id: String { rule }

    /// `review_requested` → *Review requested*.
    public var label: String {
        let words = rule.replacingOccurrences(of: "_", with: " ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }
}

public struct ScheduledSync: Sendable, Equatable, Identifiable {
    public let name: String
    public let title: String
    /// Nil until the connection setup flow writes it (`metistry connections add`).
    public let connection: String?
    public let every: Sourced<String?>
    public let paused: Sourced<Bool>
    public let raise: [ScheduledRaise]
    public let nextRun: Date?
    public let nextRefused: String?
    public let lastRun: ScheduledRun?
    public let isDefault: Bool
    public let held: String?

    public var id: String { name }
    public var isPaused: Bool { paused.value }

    public init?(json: JSONValue) {
        guard let name = json.string("name") else { return nil }
        self.name = name
        title = json.string("title") ?? name
        connection = json.string("connection")
        every = Sourced.read(json["every"], { v -> String?? in v == .null ? .some(nil) : v.stringValue.map { .some($0) } }) ?? Sourced(value: nil, origin: .default)
        paused = Sourced.read(json["paused"], \.boolValue) ?? Sourced(value: false, origin: .default)
        var raise: [ScheduledRaise] = []
        if case .object(let rules)? = json["raise"] {
            for rule in rules.keys.sorted() {
                if let on = Sourced.read(rules[rule], \.boolValue) { raise.append(ScheduledRaise(rule: rule, on: on)) }
            }
        }
        self.raise = raise
        nextRun = WireTime.date(json.string("next_run"))
        nextRefused = json["next_refused"]?.string("why", "reason")
        lastRun = ScheduledRun(json: json["last_run"])
        isDefault = json["is_default"]?.boolValue ?? false
        held = json.string("held")
    }
}

/// `GET /api/scheduled`.
public struct ScheduledListing: Sendable, Equatable {
    public let routines: [ScheduledRoutine]
    public let syncs: [ScheduledSync]
    /// The profile's zone, else `METISTRY_TZ`, else nil.
    public let timezone: String?
    /// Entries that do not fit their manifest, and the file's own errors: said, never hidden.
    public let problems: [String]
    public let asOf: Date?

    public init(json: JSONValue) {
        routines = (json["routines"]?.arrayValue ?? []).compactMap(ScheduledRoutine.init(json:))
        syncs = (json["syncs"]?.arrayValue ?? []).compactMap(ScheduledSync.init(json:))
        timezone = json.string("timezone")
        let fits = (json["problems"]?.arrayValue ?? []).compactMap { p -> String? in
            guard let message = p.string("message") else { return nil }
            let which = [p.string("name"), p.string("field")].compactMap { $0 }.joined(separator: " · ")
            return which.isEmpty ? message : "\(which) — \(message)"
        }
        problems = fits + (json["errors"]?.arrayValue ?? []).compactMap(\.stringValue)
        asOf = WireTime.date(json.string("as_of"))
    }
}

/// `GET /api/scheduled/routines/:name`.
public struct RoutineDetailReading: Sendable, Equatable {
    public var routine: ScheduledRoutine
    public var history: [ScheduledRun]
}

/// `GET /api/scheduled/syncs/:name`.
public struct SyncDetailReading: Sendable, Equatable {
    public var sync: ScheduledSync
    public var history: [ScheduledRun]
}

/// A run's steps (`GET /api/runs/:id`): what it read and called, the model call
/// with its tokens, and the file it wrote — History's latest run, opened.
public struct RunSteps: Sendable, Equatable {
    public struct Call: Sendable, Equatable, Identifiable {
        public let id: Int
        public let tool: String
        public let ok: Bool?
        public let durationMs: Int?
        public let error: String?
    }

    public let calls: [Call]
    public let callsTotal: Int
    public let model: String?
    public let tokensIn: Int?
    public let tokensOut: Int?
    public let durationMs: Int?
    public let costUSD: Double?
    /// The vault file it wrote.
    public let path: String?
    /// Why a skip happened, in the runner's words.
    public let why: String?

    public init(_ run: RunDetail) {
        calls = run.toolCalls.map { Call(id: $0.id, tool: $0.tool ?? "a tool", ok: $0.ok, durationMs: $0.durationMs, error: $0.error) }
        callsTotal = max(run.toolCallsTotal, run.toolCalls.count)
        model = run.model
        tokensIn = run.tokensIn
        tokensOut = run.tokensOut
        durationMs = run.durationMs
        costUSD = run.costUSD
        path = run.meta?["path"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
        why = run.meta?["why"]?.stringValue
    }
}

/// Something read on demand.
public enum ScheduledReading<Value: Sendable & Equatable>: Sendable, Equatable {
    case loading
    case loaded(Value)
    case failed(String)

    public var value: Value? {
        if case .loaded(let v) = self { return v }
        return nil
    }
}

/// Whether this client may change what runs (§2.3): the local owner token only.
public enum ClientReach: Sendable, Equatable {
    /// Not asked yet, or the question failed: nothing local is offered.
    case unknown
    case local
    /// Any other credential — a passkey session, the owner token over the network.
    case remote(via: String)

    public var changesWhatRuns: Bool { self == .local }
}

// MARK: - Words

public enum ScheduledWords {
    public static let title = "Scheduled"
    public static let throughoutTheDay = "Throughout the day"
    public static let inactive = "Inactive"
    public static let runNow = "Run Now"
    public static let syncNow = "Sync Now"
    public static let pause = "Pause"
    public static let resume = "Resume"
    public static let resetToDefault = "Reset to Default"
    public static let newRoutine = "New Routine"
    public static let newRoutineNotYet = "New Routine isn't in this build yet"
    public static let productFoot = "Shipped with Metistry; everything above is yours to change."
    /// T3-12: a component that fails this many times in a row stops, and raises one request.
    public static let strikes = 3
    public static let onlyTheMac = "What a routine runs — its agent, its task and what it may read — changes only on this instance's Mac."
    public static let newSync = "A sync starts with its connection: add one with `metistry connections add`, and its sync appears here."
    public static let noConnection = "Not connected — a sync starts when its connection is added (`metistry connections add`)."
    static let weekdayCodes = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
    static let weekdayShort = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    static let weekdayLong = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
    static let weekdayPlural = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"]

    /// `07:00` → *7:00 AM*; spoken, *7 AM* (components-02 §3).
    public static func clock(_ hhmm: String, spoken: Bool = false) -> String {
        guard let (h, m) = parse(hhmm) else { return hhmm }
        let meridiem = h < 12 ? "AM" : "PM"
        let hour = h % 12 == 0 ? 12 : h % 12
        if spoken && m == 0 { return "\(hour) \(meridiem)" }
        return String(format: "%d:%02d %@", hour, m, meridiem)
    }

    static func parse(_ hhmm: String) -> (Int, Int)? {
        let parts = hhmm.split(separator: ":")
        guard parts.count == 2, let h = Int(parts[0]), let m = Int(parts[1]), (0..<24).contains(h), (0..<60).contains(m) else { return nil }
        return (h, m)
    }

    /// `5m` → *Every 5 minutes*; `1h` → *Every hour*.
    public static func every(_ code: String) -> String {
        guard let n = Int(code.dropLast()), let unit = code.last else { return "Every \(code)" }
        switch (unit, n) {
        case ("m", 1): return "Every minute"
        case ("m", _): return "Every \(n) minutes"
        case ("h", 1): return "Every hour"
        case ("h", _): return "Every \(n) hours"
        default: return "Every \(code)"
        }
    }

    /// The segmented cadence's words (§10.3): *5 min · 15 min · Hour · 6 hours*.
    public static func cadence(_ code: String) -> String {
        switch code {
        case "5m": return "5 min"
        case "15m": return "15 min"
        case "1h": return "Hour"
        case "6h": return "6 hours"
        default: return code
        }
    }

    /// The closed set (`EVERY`, packages/core/src/scheduled.ts).
    public static let cadences = ["5m", "15m", "1h", "6h"]

    /// The day set in words: *Working days* · *Every day* · *Sundays* · *Mon, Wed, Fri*.
    public static func days(_ set: DaySet) -> String {
        switch set {
        case .workingDays: return "Working days"
        case .eveOfWorkingDays: return "Evenings before working days"
        case .weekdays(let days):
            let chosen = weekdayCodes.indices.filter { days.contains(weekdayCodes[$0]) }
            if chosen.count == 7 { return "Every day" }
            if chosen == [1, 2, 3, 4, 5] { return "Weekdays" }
            if chosen == [0, 6] { return "Weekends" }
            if chosen.count == 1 { return weekdayPlural[chosen[0]] }
            if chosen.isEmpty { return "No days" }
            return chosen.map { weekdayShort[$0] }.joined(separator: ", ")
        }
    }

    /// The Recurrence (§3): the rule, in words — *Working days at 7:00 AM*.
    public static func recurrence(_ timing: RoutineTiming, spoken: Bool = false) -> String {
        switch timing {
        case .timeOfDay(let days, let at, _):
            let times = at.map { clock($0, spoken: spoken) }
            let joined = times.count <= 1 ? times.joined() : times.dropLast().joined(separator: ", ") + " and " + times.last!
            let text = "\(Self.days(days)) at \(joined)"
            return spoken ? text.prefix(1).lowercased() + text.dropFirst() : text
        case .interval(let code):
            let text = every(code)
            return spoken ? text.lowercased() : text
        case .unreadable(let text):
            return text
        }
    }
}

// MARK: - When a routine acts

public enum ScheduledCalendar {
    /// Every time `routine` acts in `[from, to)`: its resolved days at each of
    /// its times, in its zone — the schedule, never a run. An interval routine
    /// has none (it is *Throughout the day*); an inactive one has none.
    public static func occurrences(of routine: ScheduledRoutine, from: Date, to: Date, fallbackZone: TimeZone) -> [Date] {
        guard !routine.isInactive, from < to else { return [] }
        var out: [Date] = []
        switch routine.schedule.value {
        case .interval:
            return []
        case .unreadable:
            break
        case .timeOfDay(_, let at, let tz):
            let weekdays = Set(routine.days?.value ?? [])
            let zone = (tz ?? routine.timeZone?.value).flatMap(TimeZone.init(identifier:)) ?? fallbackZone
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = zone
            var day = calendar.startOfDay(for: from)
            while day < to, !weekdays.isEmpty {
                let code = ScheduledWords.weekdayCodes[calendar.component(.weekday, from: day) - 1]
                if weekdays.contains(code) {
                    for time in at {
                        guard let (h, m) = ScheduledWords.parse(time),
                              let when = calendar.date(bySettingHour: h, minute: m, second: 0, of: day),
                              when >= from, when < to else { continue }
                        out.append(when)
                    }
                }
                guard let next = calendar.date(byAdding: .day, value: 1, to: day) else { break }
                day = next
            }
        }
        // The console placed the next one; it is the truth where the two differ.
        if let next = routine.nextRun, next >= from, next < to, !out.contains(next) { out.append(next) }
        return out.sorted()
    }

    /// The next `count` times it acts after `now` — the Schedule section's *next three runs*.
    public static func upcoming(_ routine: ScheduledRoutine, count: Int, now: Date, fallbackZone: TimeZone) -> [Date] {
        if case .interval(let code) = routine.schedule.value {
            guard !routine.isInactive, let first = routine.nextRun, let step = seconds(code) else { return [] }
            return (0..<count).map { first.addingTimeInterval(Double($0) * step) }
        }
        return Array(occurrences(of: routine, from: now, to: now.addingTimeInterval(15 * 86_400), fallbackZone: fallbackZone).prefix(count))
    }

    static func seconds(_ code: String) -> TimeInterval? {
        guard let n = Double(code.dropLast()), let unit = code.last else { return nil }
        switch unit {
        case "m": return n * 60
        case "h": return n * 3600
        default: return nil
        }
    }
}

// MARK: - The list

/// One row of Routines or Syncs. A routine appears once per occurrence (§4).
public struct ScheduledRow: Sendable, Equatable, Identifiable {
    public enum Kind: Sendable, Equatable {
        case occurrence(Date)
        case throughout
        case inactive
        case sync
    }

    public let name: String
    public let kind: Kind

    public var id: String {
        switch kind {
        case .occurrence(let at): return "routine|\(name)|\(Int(at.timeIntervalSince1970))"
        case .throughout: return "routine|\(name)|every"
        case .inactive: return "routine|\(name)|inactive"
        case .sync: return "sync|\(name)"
        }
    }

    public var isSync: Bool { kind == .sync }

    /// The routine or sync a row id names.
    public static func target(of id: String) -> (isSync: Bool, name: String)? {
        let parts = id.split(separator: "|", omittingEmptySubsequences: false)
        guard parts.count >= 2 else { return nil }
        return (parts[0] == "sync", String(parts[1]))
    }
}

public struct ScheduledBand: Sendable, Equatable, Identifiable {
    public let title: String
    public let rows: [ScheduledRow]
    public var id: String { title }
}

/// The week on one axis (§4.1): a mark per time a routine acts, day markers
/// for scale. One ink; the Run By column says who runs each one.
public struct WeekAxis: Sendable, Equatable {
    public struct Run: Sendable, Equatable {
        /// *7:00 AM*.
        public let time: String
        public let title: String
    }

    public struct Day: Sendable, Equatable, Identifiable {
        public let start: Date
        /// *Sun*.
        public let label: String
        /// *Sunday 27 Sep*.
        public let longLabel: String
        /// Where each run falls in the day, 0…1.
        public let marks: [Double]
        public let runs: [Run]
        public var id: Date { start }

        /// The table's row: *6 runs: Session Purge at 4:00 AM, …*.
        public var summary: String {
            guard !runs.isEmpty else { return "No runs" }
            let count = runs.count == 1 ? "1 run" : "\(runs.count) runs"
            return "\(count): " + runs.map { "\($0.title) at \($0.time)" }.joined(separator: ", ")
        }
    }

    public let days: [Day]
    public let count: Int
    /// Runs strictly between 7 AM and 6 PM.
    public let duringTheDay: Int

    /// components-02 §3: *This week: 39 runs, all by 7 AM or after 6 PM*.
    public var sentence: String {
        guard count > 0 else { return "This week: nothing runs at a set time" }
        let runs = count == 1 ? "1 run" : "\(count) runs"
        if duringTheDay == 0 { return "This week: \(runs), all by 7 AM or after 6 PM" }
        return "This week: \(runs), \(duringTheDay) between 7 AM and 6 PM"
    }
}

// MARK: - The model

/// What the last change to a routine or sync came to, said under its header.
public struct ScheduledNote: Sendable, Equatable {
    public enum Kind: Sendable, Equatable { case done, refused, failed }
    public let kind: Kind
    public let text: String
}

@MainActor
@Observable
public final class ScheduledModel {
    public enum Tab: String, CaseIterable, Identifiable, Sendable {
        case routines, syncs
        public var id: String { rawValue }
        public var title: String { self == .routines ? "Routines" : "Syncs" }
    }

    public static let policy = RefreshPolicy.board
    /// How long the list on screen may go unrefreshed before the band says so.
    public static let ageLimit: TimeInterval = 600

    public let list: SectionModel<ScheduledListing>
    public private(set) var loadingSince: Date?
    public var tab: Tab = .routines
    /// A row id (`ScheduledRow.id`).
    public var selection: String?
    public private(set) var routineDetails: [String: ScheduledReading<RoutineDetailReading>] = [:]
    public private(set) var syncDetails: [String: ScheduledReading<SyncDetailReading>] = [:]
    public private(set) var steps: [Int: ScheduledReading<RunSteps>] = [:]
    public private(set) var reach: ClientReach = .unknown
    public private(set) var notes: [String: ScheduledNote] = [:]
    /// Names with a change in flight.
    public private(set) var busy: Set<String> = []
    /// Shows the week's table under the axis (the chart's *Show as table*).
    public var showsWeekTable = false
    /// Moves every tick of the view's clock, so what depends on the time is drawn again.
    public private(set) var clockTick = 0

    @ObservationIgnored public var now: @MainActor () -> Date
    @ObservationIgnored public let fallbackZone: TimeZone
    @ObservationIgnored private weak var session: ConsoleSession?
    @ObservationIgnored private var detailsInvalidated = false
    @ObservationIgnored private var reachAsked = false

    public init(session: ConsoleSession, timeZone: TimeZone = .current, now: @escaping @MainActor () -> Date = { Date() }) {
        self.session = session
        self.fallbackZone = timeZone
        self.now = now
        self.list = SectionModel(session: session, policy: Self.policy, topics: [.scheduled]) { stores in
            await stores.scheduled().map { reply in
                let listing = ScheduledListing(json: reply.json)
                return (listing, listing.asOf)
            }
        }
        session.register { [weak self] in
            guard let self else { return false }
            self.reset()
            return true
        }
        session.events.watch([.scheduled]) { [weak self] _ in
            guard let self else { return false }
            self.detailsInvalidated = true
            return true
        }
    }

    // MARK: Reading

    public var listing: ScheduledListing? { list.section.value }

    /// The screen's zone: the profile's (the console's `timezone`), else this Mac's.
    public var zone: TimeZone { listing?.timezone.flatMap(TimeZone.init(identifier:)) ?? fallbackZone }
    public var clock: ClockTime { ClockTime(timeZone: zone) }
    public var calendar: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = zone
        return c
    }

    public func routine(_ name: String) -> ScheduledRoutine? {
        routineDetails[name]?.value?.routine ?? listing?.routines.first { $0.name == name }
    }

    public func sync(_ name: String) -> ScheduledSync? {
        syncDetails[name]?.value?.sync ?? listing?.syncs.first { $0.name == name }
    }

    public var selectedTarget: (isSync: Bool, name: String)? { selection.flatMap(ScheduledRow.target(of:)) }

    /// The tabs' counts: *Routines 10 · Syncs 5*.
    public func count(_ tab: Tab) -> Int {
        tab == .routines ? listing?.routines.count ?? 0 : listing?.syncs.count ?? 0
    }

    /// Only the product's defaults, and none of the owner's own (components-03 §2's empty row).
    public var onlyDefaults: Bool {
        guard let listing else { return false }
        return !listing.routines.contains { $0.isAssignment }
    }

    /// Routines, by what runs next: *Throughout the day*, then a band per day,
    /// then *Inactive* (§4, §11).
    public var routineBands: [ScheduledBand] {
        _ = clockTick
        guard let listing else { return [] }
        let at = now()
        let cal = calendar
        let today = cal.startOfDay(for: at)
        guard let windowEnd = cal.date(byAdding: .day, value: 2, to: today) else { return [] }
        var byDay: [Date: [(Date, ScheduledRoutine)]] = [:]
        for routine in listing.routines where !routine.isInactive && !routine.schedule.value.isInterval {
            var times = ScheduledCalendar.occurrences(of: routine, from: at, to: windowEnd, fallbackZone: zone)
            if times.isEmpty {
                // Nothing today or tomorrow: it appears once, on the day it next acts.
                times = Array(ScheduledCalendar.upcoming(routine, count: 1, now: at, fallbackZone: zone))
            }
            for time in times { byDay[cal.startOfDay(for: time), default: []].append((time, routine)) }
        }
        var bands: [ScheduledBand] = []
        let throughout = listing.routines.filter { !$0.isInactive && $0.schedule.value.isInterval }
        if !throughout.isEmpty {
            bands.append(ScheduledBand(title: ScheduledWords.throughoutTheDay, rows: throughout.sorted(by: Self.byTitle).map { ScheduledRow(name: $0.name, kind: .throughout) }))
        }
        for day in byDay.keys.sorted() {
            let rows = byDay[day]!.sorted { $0.0 != $1.0 ? $0.0 < $1.0 : $0.1.title < $1.1.title }
            bands.append(ScheduledBand(title: dayTitle(day, today: today), rows: rows.map { ScheduledRow(name: $0.1.name, kind: .occurrence($0.0)) }))
        }
        let inactive = listing.routines.filter(\.isInactive)
        if !inactive.isEmpty {
            bands.append(ScheduledBand(title: ScheduledWords.inactive, rows: inactive.sorted(by: Self.byTitle).map { ScheduledRow(name: $0.name, kind: .inactive) }))
        }
        return bands
    }

    public var syncRows: [ScheduledRow] {
        (listing?.syncs ?? []).sorted { $0.title < $1.title }.map { ScheduledRow(name: $0.name, kind: .sync) }
    }

    private static func byTitle(_ a: ScheduledRoutine, _ b: ScheduledRoutine) -> Bool { a.title < b.title }

    /// *Today* · *Tomorrow · Monday* · *Sunday · 4 Oct*.
    func dayTitle(_ day: Date, today: Date) -> String {
        let cal = calendar
        let weekday = ScheduledWords.weekdayLong[cal.component(.weekday, from: day) - 1]
        if day == today { return "Today" }
        if let tomorrow = cal.date(byAdding: .day, value: 1, to: today), day == tomorrow { return "Tomorrow · \(weekday)" }
        return "\(weekday) · \(clock.day(day))"
    }

    /// This week on one axis: the seven days from today, every time a routine acts.
    public var week: WeekAxis {
        _ = clockTick
        let cal = calendar
        let start = cal.startOfDay(for: now())
        var days: [WeekAxis.Day] = []
        var count = 0, during = 0
        let clock = self.clock
        for offset in 0..<7 {
            guard let dayStart = cal.date(byAdding: .day, value: offset, to: start), let dayEnd = cal.date(byAdding: .day, value: 1, to: dayStart) else { continue }
            var runs: [(Date, String)] = []
            for routine in listing?.routines ?? [] where !routine.schedule.value.isInterval {
                for time in ScheduledCalendar.occurrences(of: routine, from: dayStart, to: dayEnd, fallbackZone: zone) {
                    runs.append((time, routine.title))
                }
            }
            runs.sort { $0.0 != $1.0 ? $0.0 < $1.0 : $0.1 < $1.1 }
            let length = dayEnd.timeIntervalSince(dayStart)
            let marks = runs.map { $0.0.timeIntervalSince(dayStart) / length }
            for (time, _) in runs {
                let minutes = cal.component(.hour, from: time) * 60 + cal.component(.minute, from: time)
                if minutes > 7 * 60 && minutes < 18 * 60 { during += 1 }
            }
            count += runs.count
            let weekday = cal.component(.weekday, from: dayStart) - 1
            days.append(WeekAxis.Day(
                start: dayStart,
                label: ScheduledWords.weekdayShort[weekday],
                longLabel: "\(ScheduledWords.weekdayLong[weekday]) \(clock.day(dayStart))",
                marks: marks,
                runs: runs.map { WeekAxis.Run(time: clock.time($0.0), title: $0.1) }
            ))
        }
        return WeekAxis(days: days, count: count, duringTheDay: during)
    }

    // MARK: A row, presented

    /// components-02 §3: *6:00 AM, Standup, default, run by Metis, working days at 6 AM. Succeeded*.
    public func presentation(_ row: ScheduledRow, assistantName: String?) -> ScheduledRowPresentation? {
        switch row.kind {
        case .sync:
            guard let sync = sync(row.name) else { return nil }
            return ScheduledRowPresentation(sync: sync, clock: clock, now: now())
        case .occurrence(let at):
            guard let routine = routine(row.name) else { return nil }
            return ScheduledRowPresentation(routine: routine, when: clock.time(at), assistantName: assistantName, clock: clock, now: now())
        case .throughout:
            guard let routine = routine(row.name) else { return nil }
            return ScheduledRowPresentation(routine: routine, when: "", assistantName: assistantName, clock: clock, now: now())
        case .inactive:
            guard let routine = routine(row.name) else { return nil }
            return ScheduledRowPresentation(routine: routine, when: "—", assistantName: assistantName, clock: clock, now: now())
        }
    }

    // MARK: Asking

    /// The first load, and what the view's clock calls on every tick.
    public func refreshIfDue() async {
        clockTick &+= 1
        await askReachIfNeeded()
        if !list.section.hasValue && loadingSince == nil { loadingSince = now() }
        await list.refreshIfDue(now: now())
        loadingSince = nil
        if detailsInvalidated, let target = selectedTarget {
            detailsInvalidated = false
            await loadDetail(isSync: target.isSync, name: target.name, force: true)
        }
    }

    /// Try Again, and a stale band's refresh.
    public func refresh() async {
        loadingSince = list.section.hasValue ? nil : now()
        await list.refresh(background: list.section.hasValue)
        loadingSince = nil
    }

    /// What a view's `.task(id: selection)` calls.
    public func loadSelection() async {
        guard let target = selectedTarget else { return }
        await loadDetail(isSync: target.isSync, name: target.name, force: false)
    }

    public func loadDetail(isSync: Bool, name: String, force: Bool) async {
        guard let session else { return }
        let generation = session.generation
        if isSync {
            if !force, syncDetails[name]?.value != nil { return }
            if syncDetails[name]?.value == nil { syncDetails[name] = .loading }
            let answer = await session.stores.sync(name)
            guard session.generation == generation else { return }
            switch answer {
            case .success(let reply):
                guard let sync = reply["sync"].flatMap(ScheduledSync.init(json:)) else {
                    syncDetails[name] = .failed("the console's answer had no sync in it")
                    return
                }
                syncDetails[name] = .loaded(SyncDetailReading(sync: sync, history: Self.history(reply["history"])))
            case .failure(let error):
                if syncDetails[name]?.value == nil { syncDetails[name] = .failed(error.localizedDescription) }
            }
        } else {
            if !force, routineDetails[name]?.value != nil { return }
            if routineDetails[name]?.value == nil { routineDetails[name] = .loading }
            let answer = await session.stores.routine(name)
            guard session.generation == generation else { return }
            switch answer {
            case .success(let reply):
                guard let routine = reply["routine"].flatMap(ScheduledRoutine.init(json:)) else {
                    routineDetails[name] = .failed("the console's answer had no routine in it")
                    return
                }
                let history = Self.history(reply["history"])
                routineDetails[name] = .loaded(RoutineDetailReading(routine: routine, history: history))
                // History opens its latest run to its steps (§10.2).
                if let latest = history.first?.numericID { await readSteps(latest, force: force) }
            case .failure(let error):
                if routineDetails[name]?.value == nil { routineDetails[name] = .failed(error.localizedDescription) }
            }
        }
    }

    static func history(_ json: JSONValue?) -> [ScheduledRun] {
        (json?.arrayValue ?? []).compactMap(ScheduledRun.init(json:))
    }

    public func readSteps(_ runID: Int, force: Bool = false) async {
        guard let session else { return }
        if !force, steps[runID]?.value != nil { return }
        let generation = session.generation
        if steps[runID]?.value == nil { steps[runID] = .loading }
        let answer = await session.stores.run(runID)
        guard session.generation == generation else { return }
        switch answer {
        case .success(let reply): steps[runID] = .loaded(RunSteps(reply.run))
        case .failure(let error): if steps[runID]?.value == nil { steps[runID] = .failed(error.localizedDescription) }
        }
    }

    /// `GET /api/whoami`, once per instance: whether this client is the local owner.
    func askReachIfNeeded() async {
        guard !reachAsked, let session else { return }
        reachAsked = true
        let generation = session.generation
        let answer = await session.stores.whoami()
        guard session.generation == generation else { return }
        switch answer {
        case .success(let who):
            reach = who.via == "local_owner_token" ? .local : .remote(via: who.via)
        case .failure:
            // Unknown is not local: nothing that changes what runs is offered.
            reach = .unknown
            reachAsked = false
        }
    }

    // MARK: Deciding

    /// O3: false while the console is unreachable; the controls print why.
    public var allowsDecisions: Bool { session?.allowsDecisions ?? false }
    public var decisionsUnavailableReason: String? { session?.decisionsUnavailableReason }

    public func runNow(routine name: String) async {
        await start(name) { await $0.runNow(routine: name) }
    }

    public func runNow(sync name: String) async {
        await start(name) { await $0.runNow(sync: name) }
    }

    private func start(_ name: String, _ call: (ConsoleStores) async -> Result<RoutineRunResult, ConsoleError>) async {
        guard let session, !busy.contains(name) else { return }
        busy.insert(name)
        defer { busy.remove(name) }
        let answer = await call(session.stores)
        switch answer {
        case .success(let reply):
            if reply["started"]?.boolValue == true {
                notes[name] = ScheduledNote(kind: .done, text: "Started — its run lands in History when it finishes.")
            } else {
                let why = reply["refused"]?.string("message") ?? reply["refused"]?.string("reason") ?? "the runner did not start it"
                notes[name] = ScheduledNote(kind: .refused, text: "Not started — \(why)")
            }
        case .failure(let error):
            notes[name] = ScheduledNote(kind: .failed, text: error.localizedDescription)
        }
        list.invalidate()
        detailsInvalidated = true
    }

    public func togglePause(routine name: String) async {
        guard let routine = routine(name) else { return }
        await changeRoutine(name) { routine.isPaused ? await $0.resume(routine: name) : await $0.pause(routine: name) }
    }

    /// Days and times, or a cadence: `PUT …/schedule`.
    public func setSchedule(routine name: String, _ schedule: RoutineSchedule) async {
        await changeRoutine(name) { await $0.setSchedule(routine: name, schedule) }
    }

    /// Reset to Default restores the schedule, the task and the grants, and asks nothing (§10.2).
    public func resetToDefault(routine name: String) async {
        await changeRoutine(name, done: "Back to its default.") { await $0.resetToDefault(routine: name) }
    }

    /// What a New Routine runs — reach `local`. Refused here, with nothing
    /// sent, unless this client is the local owner; the console refuses it too.
    @discardableResult
    public func saveAssignment(routine name: String, actor: String, task: String, reads: [String]) async -> Bool {
        guard reach.changesWhatRuns else {
            notes[name] = ScheduledNote(kind: .refused, text: ScheduledWords.onlyTheMac)
            return false
        }
        guard let routine = routine(name), routine.isAssignment else { return false }
        let schedule: RoutineSchedule
        switch routine.schedule.value {
        case .timeOfDay(let days, let at, let tz): schedule = .timeOfDay(days: days.wire, at: at, tz: tz)
        case .interval(let every): schedule = .interval(every)
        case .unreadable: return false
        }
        let assignment = RoutineAssignment(actor: actor, task: task, read: reads, schedule: schedule, paused: routine.isPaused ? true : nil)
        return await changeRoutine(name) { await $0.setAssignment(routine: name, assignment) }
    }

    @discardableResult
    private func changeRoutine(_ name: String, done: String? = nil, _ call: (ConsoleStores) async -> Result<RoutineDetail, ConsoleError>) async -> Bool {
        guard let session, !busy.contains(name) else { return false }
        busy.insert(name)
        defer { busy.remove(name) }
        let answer = await call(session.stores)
        switch answer {
        case .success(let reply):
            if let routine = reply["routine"].flatMap(ScheduledRoutine.init(json:)) {
                let history = routineDetails[name]?.value?.history ?? []
                routineDetails[name] = .loaded(RoutineDetailReading(routine: routine, history: history))
            }
            notes[name] = done.map { ScheduledNote(kind: .done, text: $0) }
            list.invalidate()
            await list.refresh(background: true)
            return true
        case .failure(let error):
            if case .http(403, let envelope) = error, envelope?.code == "local_only" {
                // The console says this client is not the Mac: the editor goes.
                reach = .remote(via: "local_only")
            }
            notes[name] = ScheduledNote(kind: .failed, text: error.localizedDescription)
            return false
        }
    }

    public func togglePause(sync name: String) async {
        guard let sync = sync(name) else { return }
        await changeSync(name, SyncSettings(paused: !sync.isPaused))
    }

    public func setEvery(sync name: String, _ every: String) async {
        await changeSync(name, SyncSettings(every: every))
    }

    public func setRaise(sync name: String, rule: String, _ on: Bool) async {
        await changeSync(name, SyncSettings(raise: [rule: on]))
    }

    private func changeSync(_ name: String, _ settings: SyncSettings) async {
        guard let session, !busy.contains(name) else { return }
        busy.insert(name)
        defer { busy.remove(name) }
        switch await session.stores.updateSync(name, settings) {
        case .success(let reply):
            if let sync = reply["sync"].flatMap(ScheduledSync.init(json:)) {
                let history = syncDetails[name]?.value?.history ?? []
                syncDetails[name] = .loaded(SyncDetailReading(sync: sync, history: history))
            }
            notes[name] = nil
            list.invalidate()
            await list.refresh(background: true)
        case .failure(let error):
            notes[name] = ScheduledNote(kind: .failed, text: error.localizedDescription)
        }
    }

    public func dismissNote(_ name: String) {
        notes[name] = nil
    }

    /// Item ▸ Run Now (⌘R) and Item ▸ Pause (⌥⌘P) for the selection (components-02 §1).
    public func itemActions() -> ShellActionTable {
        guard let target = selectedTarget, allowsDecisions else { return [:] }
        if target.isSync {
            guard sync(target.name) != nil else { return [:] }
            return [
                .runNow: { [weak self] in Task { await self?.runNow(sync: target.name) } },
                .pause: { [weak self] in Task { await self?.togglePause(sync: target.name) } },
            ]
        }
        guard routine(target.name) != nil else { return [:] }
        return [
            .runNow: { [weak self] in Task { await self?.runNow(routine: target.name) } },
            .pause: { [weak self] in Task { await self?.togglePause(routine: target.name) } },
        ]
    }

    /// Stopped after three failures in a row (T3-12): the newest runs, all failed.
    public func isStopped(_ history: [ScheduledRun]) -> Bool {
        history.count >= ScheduledWords.strikes && history.prefix(ScheduledWords.strikes).allSatisfy(\.result.isFailure)
    }

    /// Drop everything. Called by the session on an instance switch.
    func reset() {
        tab = .routines
        selection = nil
        routineDetails = [:]
        syncDetails = [:]
        steps = [:]
        reach = .unknown
        reachAsked = false
        notes = [:]
        busy = []
        detailsInvalidated = false
        loadingSince = nil
        showsWeekTable = false
    }
}

// MARK: - A row, as drawn and spoken

public struct ScheduledRowPresentation: Sendable, Equatable {
    /// The time, *Every 5 minutes*'s blank, or *—* for an inactive one.
    public let when: String
    public let title: String
    public let isDefault: Bool
    /// *Run by Metis* — an agent id for a New Routine; nil until the name is known.
    public let runBy: String?
    public let runByIsAgent: Bool
    /// The Recurrence, or for a sync its connection and cadence.
    public let recurrence: String
    /// The state glyph and its ink, where a state carries meaning.
    public let glyph: MetistryGlyph?
    public let glyphInk: MetistryColorRole
    /// A line under the row: the error verbatim, why it is held or paused.
    public let detail: String?
    public let detailInk: MetistryColorRole
    public let spoken: String

    init(routine: ScheduledRoutine, when: String, assistantName: String?, clock: ClockTime, now: Date) {
        self.when = when
        title = routine.title
        isDefault = routine.isDefault
        if let actor = routine.actor {
            runBy = actor
            runByIsAgent = true
        } else {
            runBy = assistantName
            runByIsAgent = false
        }
        recurrence = ScheduledWords.recurrence(routine.schedule.value)
        let result = routine.lastRun?.result
        var state: String
        var glyph: MetistryGlyph?
        var ink: MetistryColorRole = .textSecondary
        var detail: String?
        var detailInk: MetistryColorRole = .textSecondary
        if routine.isPaused {
            // Its own band and its words: no mark (⏱ is Ask's alone, amendments §8.3).
            state = "Paused"
            detail = routine.paused.origin == .yours ? "Paused by you" : "Paused"
        } else if let held = routine.held {
            glyph = .absent
            ink = .absent
            state = "Held"
            detail = held
        } else if let refused = routine.nextRefused {
            glyph = .absent
            ink = .absent
            state = "Can't be placed"
            detail = refused
        } else if let result {
            state = result.word
            if let (g, i) = result.glyph { glyph = g; ink = i }
            if case .failed(let error) = result {
                detail = error
                detailInk = .failed
            }
        } else {
            state = "Hasn't run yet"
        }
        if case .failed = result, state != result?.word { state += ". Last run failed" }
        self.glyph = glyph
        glyphInk = ink
        self.detail = detail
        self.detailInk = detailInk
        var parts: [String] = []
        if !when.isEmpty && when != "—" { parts.append(when) }
        parts.append(routine.title)
        if routine.isDefault { parts.append("default") }
        if let runBy { parts.append("run by \(runBy)") }
        parts.append(ScheduledWords.recurrence(routine.schedule.value, spoken: true))
        var spoken = parts.joined(separator: ", ") + ". " + state
        if let detail, detailInk == .failed { spoken += ", \(detail)" } else if let detail, glyph == .absent { spoken += ", \(detail)" }
        self.spoken = spoken
    }

    init(sync: ScheduledSync, clock: ClockTime, now: Date) {
        when = ""
        title = sync.title
        isDefault = sync.isDefault
        runBy = sync.connection
        runByIsAgent = false
        let every = sync.every.value.map(ScheduledWords.every) ?? "On its own schedule"
        let raising = sync.raise.filter(\.on.value).map { $0.label.lowercased() }
        recurrence = raising.isEmpty ? every : "\(every) · raises \(raising.joined(separator: ", "))"
        var glyph: MetistryGlyph?
        var ink: MetistryColorRole = .textSecondary
        var detail: String?
        var detailInk: MetistryColorRole = .textSecondary
        var state: String
        if sync.connection == nil {
            glyph = .absent
            ink = .absent
            state = "Not connected"
            detail = "Not connected"
        } else if sync.isPaused {
            state = "Paused"
            detail = sync.paused.origin == .yours ? "Paused by you" : "Paused"
        } else if let held = sync.held {
            glyph = .absent
            ink = .absent
            state = "Held"
            detail = held
        } else if let last = sync.lastRun {
            state = last.result.word
            if let (g, i) = last.result.glyph { glyph = g; ink = i }
            if case .failed(let error) = last.result {
                detail = error
                detailInk = .failed
            } else if let at = last.at {
                detail = "Last \(clock.moment(at, now: now))"
            }
        } else {
            state = "Hasn't run yet"
        }
        self.glyph = glyph
        glyphInk = ink
        self.detail = detail
        self.detailInk = detailInk
        var parts = [sync.title]
        if let connection = sync.connection { parts.append("from \(connection)") }
        parts.append(every.lowercased())
        if !raising.isEmpty { parts.append("raises \(raising.joined(separator: ", "))") }
        var spoken = parts.joined(separator: ", ") + ". " + state
        if let detail, detailInk == .failed { spoken += ", \(detail)" }
        self.spoken = spoken
    }
}

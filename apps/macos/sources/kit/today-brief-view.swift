// Today's top: the Morning Brief, Next Up, calendar help, Close the Day
// (design-build-plan T6-1b; screen-05-today.md §15.1–15.3, §15.5; C90, C97,
// C101–C103, C111).
//
// WHAT IS READ, AND FROM WHERE. Nothing here is assembled from a guess:
//
//   * the brief is its own file, `Journal/Brief/<date>.md` (T3-6), read whole
//     through `GET /api/knowledge/page` — its first paragraph is the one
//     serif voice, its `## Next Up` list holds each meeting's one generated
//     line (a filled slot keeps `<!-- metistry:written N -->`; a pending one
//     is not a line yet);
//   * the Standup section is the Standup routine's own file (C111), presented
//     collapsed with *Copy Standup* — copied, never posted;
//   * the working day is `Me/profile.md`'s `working_days` and `working_hours`,
//     the same two fields `plan-tomorrow` and `morning-brief` read;
//   * the day is `GET /api/today` (T2-7); tomorrow's shape is the same route
//     for tomorrow's date.
//
// ONE VOICE OPEN AT A TIME, THREE PREDICTIONS A PAGE (§15.3). The brief is
// the expanded wash at first open; once it folds, Next Up's generated line is.
// `TodayWashes` decides which, and cannot answer two. Calendar help is one
// line beside its one action, and every prediction on the page goes through
// `TodayPredictions.page`, which keeps three.
//
// CALENDAR HELP IS RETRIEVED, NOT WRITTEN. The offer — which meeting to move,
// to when, and what it frees — is computed here from the day's events and the
// working hours; no model wrote it, so it carries no spark and no wash.
// Moving a meeting with people in it warns first, naming who the calendar
// will tell and the new time (C90) — neutral, because moving a meeting is not
// a fault. Only the owner's own meetings move without the warning, and even
// then only through the route's single-use preview token.
//
// CLOSE THE DAY WRITES THROUGH DOORS, AND SAYS WHAT IT WROTE (§15.5.1).
// Each Tomorrow · This Week · Someday is the Defer door on one line; Close the
// Day is `POST /api/today/close`, which writes the daily note's Metistry
// section and enqueues tomorrow's plan. Broken markers are the request the
// console raised — never a success, never a folded *Day closed* line.

import Foundation
import SwiftUI

// MARK: - The brief, read

/// `Journal/Brief/<date>.md`, as `morning-brief` renders it and its one turn
/// fills it. Only what this screen shows is kept.
public struct BriefDocument: Sendable, Equatable {
    /// The paragraphs before the first `##` heading, the title gone and each
    /// `written` marker stripped. Nil while the slot is still pending.
    public var prose: String?
    /// The `## Next Up` list: each meeting line and, once its slot is filled,
    /// the one line written for it.
    public var meetings: [BriefMeeting]

    public struct BriefMeeting: Sendable, Equatable {
        /// `9:30–9:45 AM` as the routine wrote it.
        public var when: String
        public var title: String
        /// The generated line; nil while pending.
        public var written: String?
    }

    public init(prose: String?, meetings: [BriefMeeting]) {
        self.prose = prose
        self.meetings = meetings
    }

    static let writtenMarker = try! NSRegularExpression(pattern: #"\s*<!--\s*metistry:written\s+\d+\s*-->"#)
    static let pendingMarker = try! NSRegularExpression(pattern: #"<!--\s*metistry:prose\b[^>]*-->"#)

    public static func parse(_ markdown: String) -> BriefDocument {
        let lines = BriefText.body(markdown).components(separatedBy: "\n")
        var prose: [String] = []
        var meetings: [BriefMeeting] = []
        var heading: String?
        for raw in lines {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("## ") {
                heading = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                continue
            }
            if line.hasPrefix("# ") && heading == nil && prose.isEmpty { continue }
            switch heading {
            case nil:
                guard !line.isEmpty else {
                    if !prose.isEmpty && prose.last != "" { prose.append("") }
                    continue
                }
                if Self.isPending(line) { continue }
                prose.append(Self.stripWritten(line))
            case "Next Up"?:
                if raw.hasPrefix("- ") {
                    let parts = String(raw.dropFirst(2)).components(separatedBy: " · ")
                    guard parts.count >= 2 else { continue }
                    meetings.append(BriefMeeting(when: parts[0].trimmingCharacters(in: .whitespaces), title: parts[1].trimmingCharacters(in: .whitespaces), written: nil))
                } else if line.hasPrefix("- "), !meetings.isEmpty, meetings[meetings.count - 1].written == nil {
                    let text = String(line.dropFirst(2))
                    guard !Self.isPending(text), text.contains("metistry:written") else { continue }
                    meetings[meetings.count - 1].written = Self.stripWritten(text)
                }
            default:
                continue
            }
        }
        while prose.last == "" { prose.removeLast() }
        let joined = prose.isEmpty ? nil : prose.joined(separator: "\n")
        return BriefDocument(prose: joined, meetings: meetings)
    }

    static func isPending(_ line: String) -> Bool {
        pendingMarker.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)) != nil
    }

    static func stripWritten(_ line: String) -> String {
        writtenMarker.stringByReplacingMatches(in: line, range: NSRange(line.startIndex..., in: line), withTemplate: "")
            .trimmingCharacters(in: .whitespaces)
    }

    /// The line a meeting's Next Up card shows, matched by title — the
    /// routine bounds a title to one line, so the event's own title is the key.
    public func written(for event: TodayEvent) -> String? {
        let title = event.title.trimmingCharacters(in: .whitespaces).lowercased()
        return meetings.first { $0.title.lowercased() == title }?.written
    }

    /// *Morning Brief — Four things today; the lease comparables are the one
    /// that moved.* The first sentence of the prose, links read as their text.
    public var foldedLine: String {
        guard let prose else { return BriefWords.title }
        let plain = BriefText.plain(prose.components(separatedBy: "\n").first ?? prose)
        var first = plain
        if let end = plain.range(of: #"[.!?](\s|$)"#, options: .regularExpression) {
            first = String(plain[..<plain.index(after: end.lowerBound)])
        }
        if first.count > 120 { first = String(first.prefix(119)) + "…" }
        return first.isEmpty ? BriefWords.title : "\(BriefWords.title) — \(first)"
    }
}

/// Markdown made readable as text, where this screen shows a vault file.
public enum BriefText {
    /// The file without its frontmatter.
    public static func body(_ markdown: String) -> String {
        guard markdown.hasPrefix("---\n") || markdown.hasPrefix("---\r\n") else { return markdown }
        let rest = markdown.dropFirst(4)
        guard let end = rest.range(of: "\n---") else { return markdown }
        let after = rest[end.upperBound...]
        return String(after.drop { $0 == "\n" || $0 == "\r" || $0 == "-" })
    }

    /// The file without its frontmatter and its first `#` title — what Copy
    /// Standup copies and the Standup section shows.
    public static func withoutTitle(_ markdown: String) -> String {
        var text = body(markdown)
        while text.hasPrefix("\n") { text.removeFirst() }
        if text.hasPrefix("# ") {
            text = text.firstIndex(of: "\n").map { String(text[text.index(after: $0)...]) } ?? ""
        }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// `[[Journal/Plan/2026-09-28|the plan]]` → *the plan*; emphasis marks dropped.
    public static func plain(_ text: String) -> String {
        var out = text
        if let link = try? NSRegularExpression(pattern: #"\[\[([^\]|]*)(?:\|([^\]]*))?\]\]"#) {
            let range = NSRange(out.startIndex..., in: out)
            var result = ""
            var last = out.startIndex
            for match in link.matches(in: out, range: range) {
                guard let whole = Range(match.range, in: out) else { continue }
                result += out[last..<whole.lowerBound]
                if let alias = Range(match.range(at: 2), in: out) {
                    result += out[alias]
                } else if let target = Range(match.range(at: 1), in: out) {
                    result += out[target]
                }
                last = whole.upperBound
            }
            result += out[last...]
            out = result
        }
        return out.replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "`", with: "")
            .replacingOccurrences(of: "*", with: "")
            .trimmingCharacters(in: .whitespaces)
    }
}

/// Words the brief says in more than one place.
public enum BriefWords {
    public static let title = "Morning Brief"
    public static let standup = "Standup"
    public static let copyStandup = "Copy Standup"
    public static let copied = "Copied"
    /// Once, inside the Standup section (§15.1).
    public static let notPosted = "Metistry doesn't post this."
    /// Every state where the brief is missing ends with it: the spine does not depend on the brief.
    public static let dayIsComplete = "The day below is still complete."
}

// MARK: - The working day, from Me/profile.md

/// `working_days` and `working_hours`, read from the profile's frontmatter
/// the way the routines read them: never assumed when absent.
public struct WorkingProfile: Sendable, Equatable {
    /// `mon` … `sun`. Nil: the profile does not say.
    public var workingDays: [String]?
    /// Minutes past local midnight. Nil: `working_hours` absent or unreadable.
    public var dayStart: Int?
    public var dayEnd: Int?
    /// `task_size_minutes` — `s`, `m`, `l` to minutes (T6-1a). Nil: the profile does not say.
    public var sizeMinutes: [String: Int]?

    public init(workingDays: [String]? = nil, dayStart: Int? = nil, dayEnd: Int? = nil, sizeMinutes: [String: Int]? = nil) {
        self.workingDays = workingDays
        self.dayStart = dayStart
        self.dayEnd = dayEnd
        self.sizeMinutes = sizeMinutes
    }

    public static let path = "Me/profile.md"
    static let dayNames = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]

    public static func parse(_ markdown: String) -> WorkingProfile {
        guard markdown.hasPrefix("---") else { return WorkingProfile() }
        var lines = markdown.components(separatedBy: "\n").dropFirst()
        if let end = lines.firstIndex(where: { $0.trimmingCharacters(in: .whitespaces) == "---" }) { lines = lines[..<end] }
        var profile = WorkingProfile()
        let all = Array(lines)
        for (i, line) in all.enumerated() where !line.hasPrefix("#") && !line.hasPrefix(" ") {
            if line.hasPrefix("working_hours:") {
                let value = Self.unquote(String(line.dropFirst("working_hours:".count)))
                let ends = value.components(separatedBy: CharacterSet(charactersIn: "-–")).map { $0.trimmingCharacters(in: .whitespaces) }
                if ends.count == 2, let a = Self.minutes(ends[0]), let b = Self.minutes(ends[1]), a < b {
                    profile.dayStart = a
                    profile.dayEnd = b
                }
            } else if line.hasPrefix("working_days:") {
                let value = String(line.dropFirst("working_days:".count)).trimmingCharacters(in: .whitespaces)
                var days: [String] = []
                if value.hasPrefix("[") {
                    days = value.trimmingCharacters(in: CharacterSet(charactersIn: "[] ")).components(separatedBy: ",").map(Self.unquote)
                } else if value.isEmpty {
                    for next in all[(i + 1)...] {
                        let t = next.trimmingCharacters(in: .whitespaces)
                        guard t.hasPrefix("- ") else { break }
                        days.append(Self.unquote(String(t.dropFirst(2))))
                    }
                }
                let known = days.map { String($0.lowercased().prefix(3)) }.filter(dayNames.contains)
                profile.workingDays = known.isEmpty ? nil : known
            } else if line.hasPrefix("task_size_minutes:") {
                // `{ s: 15, m: 45, l: 90 }`, or the same as an indented block
                let value = String(line.dropFirst("task_size_minutes:".count)).trimmingCharacters(in: .whitespaces)
                var pairs: [String] = []
                if value.hasPrefix("{") {
                    pairs = value.trimmingCharacters(in: CharacterSet(charactersIn: "{} ")).components(separatedBy: ",")
                } else if value.isEmpty {
                    for next in all[(i + 1)...] {
                        guard next.hasPrefix(" "), next.contains(":") else { break }
                        pairs.append(next)
                    }
                }
                var sizes: [String: Int] = [:]
                for pair in pairs {
                    let kv = pair.split(separator: ":", maxSplits: 1).map { Self.unquote(String($0)).lowercased() }
                    if kv.count == 2, ["s", "m", "l"].contains(kv[0]), let n = Int(kv[1]), n > 0 { sizes[kv[0]] = n }
                }
                profile.sizeMinutes = sizes.isEmpty ? nil : sizes
            }
        }
        return profile
    }

    static func unquote(_ s: String) -> String {
        s.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "\"'")).trimmingCharacters(in: .whitespaces)
    }

    static func minutes(_ hhmm: String) -> Int? {
        let parts = hhmm.split(separator: ":")
        guard parts.count == 2, let h = Int(parts[0]), let m = Int(parts[1]), (0..<24).contains(h), (0..<60).contains(m) else { return nil }
        return h * 60 + m
    }

    /// The week's last working day on or after `date` — This Week's day. Friday when the profile does not say.
    func lastWorkingDay(ofWeekContaining date: Date, calendar: Calendar) -> Date? {
        let days = Set((workingDays ?? ["mon", "tue", "wed", "thu", "fri"]).compactMap { Self.dayNames.firstIndex(of: $0) }.map { $0 + 1 })
        let weekday = calendar.component(.weekday, from: date) // 1 = Sunday
        // The week runs Monday to Sunday: the days left in it, latest first.
        let daysToSunday = (8 - weekday) % 7
        for offset in stride(from: daysToSunday, through: 0, by: -1) {
            guard let d = calendar.date(byAdding: .day, value: offset, to: date) else { continue }
            if days.contains(calendar.component(.weekday, from: d)) { return calendar.startOfDay(for: d) }
        }
        return nil
    }
}

// MARK: - Predictions: three a page

/// A predicted action, with its reason (§12.5): it names the act, and why now.
public struct TodayPrediction: Sendable, Equatable, Identifiable {
    public enum Act: Sendable, Equatable {
        case draftAgenda(eventID: String)
        case moveMeeting(eventID: String)
    }

    public let act: Act
    /// Title Case, the act: *Draft the Agenda*, *Move the Lease Call…*.
    public let label: String
    /// Sentence case, the reason: *3 open items with Jim*.
    public let reason: String

    public var id: String {
        switch act {
        case .draftAgenda(let id): return "agenda:\(id)"
        case .moveMeeting(let id): return "move:\(id)"
        }
    }

    public var spoken: String { "\(label), \(reason)" }
}

public enum TodayPredictions {
    /// Predictions on one page, at most (§15.3, §12.5).
    public static let perPage = 3

    /// The page's predictions in the order offered, each once, never more than three.
    public static func page(_ candidates: [TodayPrediction?]) -> [TodayPrediction] {
        var seen = Set<String>()
        var out: [TodayPrediction] = []
        for case let p? in candidates where !seen.contains(p.id) {
            seen.insert(p.id)
            out.append(p)
            if out.count == perPage { break }
        }
        return out
    }
}

// MARK: - One voice open at a time

public enum TodayWash: String, Sendable, Equatable {
    case brief, nextUp
}

public enum TodayWashes {
    /// The one expanded wash: the brief while it is open and readable, else
    /// Next Up's generated line when there is one. Never two (§15.3).
    public static func expanded(briefOpen: Bool, briefHasProse: Bool, nextUpWritten: Bool) -> TodayWash? {
        if briefOpen && briefHasProse { return .brief }
        return nextUpWritten ? .nextUp : nil
    }
}

// MARK: - Next Up

public struct NextUpCard: Sendable, Equatable {
    public let event: TodayEvent
    /// Whole minutes until it starts; 0 once it is due.
    public let minutes: Int
    /// What you owe the people in it: open tasks whose person facet names one of them (C102).
    public let owed: [TodayTask]
    /// The brief's one generated line for it; nil until the turn writes it.
    public let written: String?

    public var isStandup: Bool { event.isStandup }

    /// *Draft the Agenda — 3 open items with Jim*: only when there is something owed, never for the standup.
    public var prediction: TodayPrediction? {
        guard !isStandup, !owed.isEmpty else { return nil }
        var names: [String] = []
        for task in owed { if let who = task.assigned, !names.contains(who) { names.append(who) } }
        let items = owed.count == 1 ? "1 open item" : "\(owed.count) open items"
        return TodayPrediction(act: .draftAgenda(eventID: event.id), label: "Draft the Agenda", reason: "\(items) with \(TodayWords.list(names))")
    }

    /// *Next Up · in 12 min* — or *now*.
    public var lead: String { minutes > 0 ? "Next Up · in \(minutes) min" : "Next Up · now" }
    public var spokenLead: String { minutes > 0 ? "Next Up, in \(minutes) \(minutes == 1 ? "minute" : "minutes")" : "Next Up, now" }
}

public enum NextUpState: Sendable, Equatable {
    case none
    case card(NextUpCard)
    /// There were meetings, and none is left (§15.2).
    case calendarDone
}

public enum NextUp {
    /// The card appears this long before the next event (§15.2).
    public static let lead: TimeInterval = 30 * 60
    public static let calendarDone = "Nothing else on your calendar today."

    public static func of(_ day: TodayDay, brief: BriefDocument?, now: Date) -> NextUpState {
        let timed = day.timedEvents
        guard !timed.isEmpty else { return .none }
        guard let next = timed.first(where: { $0.start > now }) else {
            return timed.allSatisfy { $0.end <= now } ? .calendarDone : .none
        }
        guard next.start.timeIntervalSince(now) <= lead else { return .none }
        let owed = day.tasks.filter { task in
            guard task.isOwed, let who = task.assigned else { return false }
            return next.others.contains { $0.matches(who) }
        }
        let minutes = max(0, Int((next.start.timeIntervalSince(now) / 60).rounded(.up)))
        return .card(NextUpCard(event: next, minutes: minutes, owed: owed, written: brief?.written(for: next)))
    }
}

// MARK: - Calendar help

/// One offer: move one meeting so the day holds a focus block (§14.5). Shown
/// only when the day is measurably fragmented and the move would fix it.
public struct CalendarHelp: Sendable, Equatable {
    public let event: TodayEvent
    public let start: Date
    public let end: Date
    /// The longest free stretch the move leaves in the working day.
    public let frees: TimeInterval

    /// A focus block, at least.
    public static let focus: TimeInterval = 90 * 60
    /// Nothing that starts sooner than this is offered for a move.
    public static let notice: TimeInterval = 30 * 60

    public var prediction: TodayPrediction {
        TodayPrediction(act: .moveMeeting(eventID: event.id), label: "Move the \(event.title)…", reason: "leaves \(ClockTime.duration(frees)) free for focus")
    }

    /// The folded line, retrieved facts only: *Your day has no block of 1h 30m
    /// left. Moving the Lease Call to 3:30–4:00 PM leaves 2h free.*
    public func line(clock: ClockTime) -> String {
        "No stretch of \(ClockTime.duration(Self.focus)) is left in your day. Moving the \(event.title) to \(clock.range(start, end)) leaves \(ClockTime.duration(frees)) free."
    }

    /// The offer for `now`, or nil: no working hours, not fragmented, or no single move fixes it.
    public static func offer(_ day: TodayDay, profile: WorkingProfile?, now: Date, calendar: Calendar) -> CalendarHelp? {
        guard let profile, let startMin = profile.dayStart, let endMin = profile.dayEnd else { return nil }
        let midnight = calendar.startOfDay(for: now)
        let dayStart = midnight.addingTimeInterval(TimeInterval(startMin * 60))
        let dayEnd = midnight.addingTimeInterval(TimeInterval(endMin * 60))
        let from = max(now, dayStart)
        guard dayEnd > from else { return nil }
        let events = day.timedEvents.filter { $0.end > from && $0.start < dayEnd }
        guard events.count >= 2 else { return nil }
        let before = longestGap(events.map { ($0.start, $0.end) }, from: from, to: dayEnd)
        guard before < focus else { return nil }

        var best: CalendarHelp?
        for event in events where event.start >= now.addingTimeInterval(notice) {
            let length = event.end.timeIntervalSince(event.start)
            let rest = events.filter { $0.id != event.id }.map { ($0.start, $0.end) }
            for gap in gaps(rest, from: max(from, now.addingTimeInterval(notice)), to: dayEnd) where gap.1.timeIntervalSince(gap.0) >= length {
                for start in [gap.0, gap.1.addingTimeInterval(-length)] where start != event.start {
                    let moved = rest + [(start, start.addingTimeInterval(length))]
                    let frees = longestGap(moved, from: from, to: dayEnd)
                    guard frees >= focus, frees > (best?.frees ?? 0) else { continue }
                    best = CalendarHelp(event: event, start: start, end: start.addingTimeInterval(length), frees: frees)
                }
            }
        }
        return best
    }

    static func gaps(_ busy: [(Date, Date)], from: Date, to: Date) -> [(Date, Date)] {
        var out: [(Date, Date)] = []
        var cursor = from
        for (s, e) in busy.sorted(by: { $0.0 < $1.0 }) {
            if s > cursor { out.append((cursor, min(s, to))) }
            cursor = max(cursor, e)
            if cursor >= to { break }
        }
        if cursor < to { out.append((cursor, to)) }
        return out.filter { $0.1 > $0.0 }
    }

    static func longestGap(_ busy: [(Date, Date)], from: Date, to: Date) -> TimeInterval {
        gaps(busy, from: from, to: to).map { $0.1.timeIntervalSince($0.0) }.max() ?? 0
    }
}

/// The warning before a meeting with people in it moves (C90): who the
/// calendar will tell, and the new time. Neutral — not a fault.
public struct MoveWarning: Sendable, Equatable {
    public let eventID: String
    public let title: String
    public let start: Date
    public let end: Date
    public let people: [String]
    public let token: String
    public let request: EventMove

    public func confirmation(clock: ClockTime) -> CostConfirmation? {
        CostConfirmation(
            title: "Move the \(title) to \(clock.range(start, end))?",
            costHeading: "Your calendar will send the new time to:",
            costs: people,
            confirm: "Move the Meeting",
            destructive: false
        )
    }

    /// What `POST /api/calendar/events/:id/move` answered without a token:
    /// the preview and its single-use token. Nil when it says nothing usable.
    public init?(preview json: JSONValue, request: EventMove) {
        guard let token = json.string("confirm_token"), let preview = json["preview"] else { return nil }
        let to = preview["to"]
        self.eventID = preview.string("event_id") ?? ""
        self.title = preview.string("title") ?? ""
        self.start = WireTime.date(to?.string("start")) ?? WireTime.date(request.start) ?? Date.distantPast
        self.end = WireTime.date(to?.string("end")) ?? WireTime.date(request.end) ?? Date.distantPast
        self.people = (preview["attendees"]?.arrayValue ?? []).map(TodayAttendee.init(json:)).filter { !$0.isSelf }.map(\.displayName)
        self.token = token
        self.request = request
    }
}

// MARK: - Close the Day

/// Where a still-open line can go (§15.5): each is the Defer door's one field.
public enum DeferChoice: String, CaseIterable, Sendable, Identifiable {
    case tomorrow, thisWeek, someday

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .tomorrow: return "Tomorrow"
        case .thisWeek: return "This Week"
        case .someday: return "Someday"
        }
    }

    /// The choices open on `today` with the door's value for each. This Week —
    /// the week's last working day — only while it is after tomorrow.
    public static func available(today: String, profile: WorkingProfile?, calendar: Calendar) -> [(DeferChoice, TaskDeferral)] {
        guard let date = TodayDates.date(today, calendar: calendar),
              let tomorrow = calendar.date(byAdding: .day, value: 1, to: date) else { return [(.someday, .someday)] }
        var out: [(DeferChoice, TaskDeferral)] = [(.tomorrow, .on(TodayDates.ymd(tomorrow, calendar: calendar)))]
        if let week = (profile ?? WorkingProfile()).lastWorkingDay(ofWeekContaining: date, calendar: calendar), week > tomorrow {
            out.append((.thisWeek, .on(TodayDates.ymd(week, calendar: calendar))))
        }
        out.append((.someday, .someday))
        return out
    }
}

/// The close panel's facts, from the day as drawn.
public struct CloseDayPlan: Sendable, Equatable {
    public let done: [TodayTask]
    /// Open lines that are the owner's own.
    public let stillOpen: [TodayTask]
    /// Open lines whose person facet says who is waiting (C102) — tasks, like the rest.
    public let owed: [TodayTask]

    public static let shownDone = 3

    public init(_ day: TodayDay) {
        done = day.tasks.filter(\.checked)
        owed = day.tasks.filter(\.isOwed)
        stillOpen = day.tasks.filter { $0.isOpen && !$0.isOwed }
    }

    public var doneHeadline: String { done.count == 1 ? "1 done" : "\(done.count) done" }
}

/// The next working day's shape, from `GET /api/today?date=<tomorrow>`.
public struct TomorrowShape: Sendable, Equatable {
    public let date: String
    public let meetings: Int
    public let firstAt: Date?
    public let tasks: Int

    public init(_ day: TodayDay) {
        date = day.date
        let timed = day.timedEvents
        meetings = timed.count
        firstAt = timed.first?.start
        tasks = day.tasks.filter(\.isOpen).count
    }

    public func sentence(clock: ClockTime) -> String {
        let m: String
        switch meetings {
        case 0: m = "No meetings"
        case 1: m = "1 meeting"
        default: m = "\(meetings) meetings"
        }
        let first = firstAt.map { meetings > 0 ? ", the first at \(clock.time($0))" : "" } ?? ""
        let t = tasks == 1 ? "1 task planned" : "\(tasks) tasks planned"
        return "\(m)\(first) · \(t)"
    }
}

/// `POST /api/today/close`'s `200`: what it wrote.
public struct ClosedDay: Sendable, Equatable {
    public let day: String
    public let path: String
    public let closedAt: Date?
    public let done: Int
    /// A day (`2026-09-29`) or `someday`, and how many lines went there.
    public let moved: [String: Int]
    public let line: String?

    public init?(json: JSONValue) {
        guard json["ok"]?.boolValue == true, let day = json.string("day"), let path = json.string("path") else { return nil }
        self.day = day
        self.path = path
        self.closedAt = WireTime.date(json.string("closed_at"))
        self.done = json["done"]?.intValue ?? 0
        var moved: [String: Int] = [:]
        if case .object(let o)? = json["moved"] {
            for (k, v) in o { if let n = v.intValue { moved[k] = n } }
        }
        self.moved = moved
        self.line = json.string("line")
    }

    /// *Day closed at 5:14 PM · 6 done · 3 to tomorrow · 1 this week · 1 someday* (§15.5).
    public func foldedLine(tomorrow: String?, clock: ClockTime) -> String {
        var parts = [closedAt.map { "Day closed at \(clock.time($0))" } ?? "Day closed", "\(done) done"]
        let toTomorrow = tomorrow.flatMap { moved[$0] } ?? 0
        let someday = moved["someday"] ?? 0
        let later = moved.filter { $0.key != "someday" && $0.key != tomorrow }.values.reduce(0, +)
        if toTomorrow > 0 { parts.append("\(toTomorrow) to tomorrow") }
        if later > 0 { parts.append("\(later) this week") }
        if someday > 0 { parts.append("\(someday) someday") }
        return parts.joined(separator: " · ")
    }
}

/// `409 section_missing`: the daily note's markers are not one clean pair, so
/// nothing went into it, and the console raised a `note` request saying so.
public struct NoteNotWritten: Sendable, Equatable {
    public let path: String?
    public let requestID: Int?
    public let reason: String?
    public let atLine: Int?
    public let planEnqueued: Bool

    public init?(_ error: ConsoleError) {
        guard case .http(409, let envelope?) = error, envelope.code == "section_missing" else { return nil }
        let d = envelope.details
        path = d["path"]?.stringValue
        requestID = d["request_id"]?.intValue ?? d["request_id"]?.stringValue.flatMap { Int($0) }
        reason = d["reason"]?.stringValue
        atLine = d["at_line"]?.intValue
        planEnqueued = d["plan"]?["enqueued"]?.boolValue ?? false
    }

    public static let title = "Today's Note Wasn't Updated"
    public static let openRequest = "Open the Request"

    /// What happened, and what did not: never a success.
    public var sentence: String {
        let file = path ?? "today's note"
        var why = "the Metistry section in \(file) couldn't be found"
        if let reason { why += " (\(reason.replacingOccurrences(of: "_", with: " "))\(atLine.map { ", line \($0)" } ?? ""))" }
        let plan = planEnqueued ? " Tomorrow's plan is still being written." : ""
        return "Nothing was written into your note: \(why). A request in Needs You shows what would have been written.\(plan)"
    }
}

/// What a close came back as.
public enum CloseOutcome: Sendable, Equatable {
    case closed(ClosedDay)
    case noteNotWritten(NoteNotWritten)
    /// Refused, or not reached: the words to show, and nothing folds.
    case refused(String)

    public static func of(_ answer: Result<CloseDayResult, ConsoleError>, day: String) -> CloseOutcome {
        switch answer {
        case .success(let reply):
            if let closed = ClosedDay(json: reply.json) { return .closed(closed) }
            return .refused("The console answered a close this app can't read — nothing is shown as closed.")
        case .failure(let error):
            if let missing = NoteNotWritten(error) { return .noteNotWritten(missing) }
            if case .http(409, let envelope?) = error, envelope.reason == "stale" {
                let today = envelope.details["today"]?.stringValue
                return .refused("Today was drawn for \(day)\(today.map { ", and it is now \($0)" } ?? ""). Nothing was written — close the day that is showing after it reloads.")
            }
            if case .http(404, _) = error {
                return .refused("There's no Journal/\(day).md to write into, and closing never creates your note. Apply Templates/Daily.md in Obsidian, then close again. Tomorrow's plan is still being written.")
            }
            return .refused("Not closed — \(error.localizedDescription)")
        }
    }
}

// MARK: - Words

public enum TodayWords {
    public static let title = "Today"
    public static let closeTheDay = "Close the Day"
    public static let closeEarly = "Close the Day…"
    public static let reopen = "Reopen"
    public static let done = "Done"
    public static let stillOpen = "Still Open"
    public static let owed = "Owed to People"
    public static let tomorrow = "Tomorrow"
    public static let lineForTomorrow = "A Line for Tomorrow"
    public static let linePrompt = "A line for tomorrow (optional)"
    public static let lineHint = "Optional — your own words. They lead tomorrow's plan and the Morning Brief."
    public static let openNotes = "Open Notes"
    public static let record = "Record"
    public static let recordUnavailable = "Recording starts from the capture bar, which isn't in this build yet"
    public static let notToday = "Not Today"
    public static let theDay = "The Day"
    public static let inNextUp = "in Next Up ↑"
    public static let showAll = "Show All"

    /// *Dana*, *Dana and Jim*, *Dana, Jim and Ana*.
    public static func list(_ names: [String]) -> String {
        switch names.count {
        case 0: return ""
        case 1: return names[0]
        default: return names.dropLast().joined(separator: ", ") + " and " + names[names.count - 1]
        }
    }
}

/// `YYYY-MM-DD` in the page's calendar — the Defer door's `do` is a day in the owner's zone, resolved by the client.
public enum TodayDates {
    public static func ymd(_ date: Date, calendar: Calendar) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    public static func date(_ ymd: String, calendar: Calendar) -> Date? {
        let parts = ymd.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }

    public static func adding(_ days: Int, to ymd: String, calendar: Calendar) -> String? {
        guard let d = date(ymd, calendar: calendar), let next = calendar.date(byAdding: .day, value: days, to: d) else { return nil }
        return Self.ymd(next, calendar: calendar)
    }
}

// MARK: - Views

/// The brief, open: the one wash, the Standup section collapsed, the foot.
struct TodayBriefOpen: View {
    @Environment(\.colorScheme) private var scheme
    let document: BriefDocument
    let standup: String?
    let path: String
    let planned: Int
    let carried: Int
    let assistantName: String?
    let clock: ClockTime
    let onCopyStandup: ((String) -> Void)?
    @State private var standupOpen = false
    @State private var copied = false

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s3) {
            Text(verbatim: BriefWords.title)
                .metistryText(.headline, p)
                .accessibilityAddTraits(.isHeader)
            if let prose = document.prose {
                if let name = assistantName {
                    AgentProse(AgentProseModel(treatment: .wash, author: .assistant(named: name), text: BriefText.plain(prose), generated: true), clock: clock)
                } else {
                    // The name is not known yet: the words, without an author the page would have to invent.
                    Text(verbatim: BriefText.plain(prose))
                        .metistryFont(.body, design: .serif)
                        .foregroundStyle(p[.textPrimary])
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(MetistrySpace.s3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(p[.agentQuiet], in: RoundedRectangle(cornerRadius: MetistryRadius.md, style: .continuous))
                }
            }
            if let standup {
                DisclosureGroup(isExpanded: $standupOpen) {
                    VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                        Text(verbatim: BriefText.withoutTitle(standup))
                            .metistryText(.body, p)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                        Text(verbatim: BriefWords.notPosted)
                            .metistryText(.footnote, p, .textSecondary)
                    }
                    .padding(.top, MetistrySpace.s1)
                } label: {
                    HStack(alignment: .firstTextBaseline) {
                        Text(verbatim: BriefWords.standup).metistryText(.subhead, p).accessibilityAddTraits(.isHeader)
                        Spacer(minLength: MetistrySpace.s2)
                        ControlButton(ControlSpec(copied ? BriefWords.copied : BriefWords.copyStandup, disabledBecause: onCopyStandup == nil ? "Copying isn't available here" : nil, name: BriefWords.copyStandup)) {
                            onCopyStandup?(BriefText.withoutTitle(standup))
                            copied = true
                        }
                    }
                }
            }
            Text(verbatim: TodayBriefFoot.text(planned: planned, carried: carried, path: path))
                .metistryText(.footnote, p, .textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

enum TodayBriefFoot {
    /// *The plan is the day below · 7 tasks, 2 carried · Journal/Brief/<date>.md* — the plan is not repeated (§15.1).
    static func text(planned: Int, carried: Int, path: String) -> String {
        let tasks = planned == 1 ? "1 task" : "\(planned) tasks"
        return "The plan is the day below · \(tasks)\(carried > 0 ? ", \(carried) carried" : "") · \(path)"
    }
}

/// A folded voice: one line, which opens it.
struct TodayFoldedLine: View {
    @Environment(\.colorScheme) private var scheme
    let text: String
    let spoken: String
    let onOpen: () -> Void

    var body: some View {
        let p = Palette(scheme)
        Button(action: onOpen) {
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                Image(systemName: MetistryGlyph.disclosure.rawValue).foregroundStyle(p[.textSecondary]).accessibilityHidden(true)
                Text(verbatim: text)
                    .metistryText(.callout, p)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(verbatim: spoken))
        .accessibilityHint(Text(verbatim: "Opens it"))
    }
}

/// A missing brief says why, and that the day is complete without it (§15.1).
struct TodayBriefMissing: View {
    @Environment(\.colorScheme) private var scheme
    let title: String
    let sentence: String

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            Text(verbatim: title).metistryText(.subhead, p).accessibilityAddTraits(.isHeader)
            Text(verbatim: "\(sentence) \(BriefWords.dayIsComplete)")
                .metistryText(.callout, p, .textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }
}

/// One task line on this screen: a checkbox you tick, its words, its facets.
struct TodayTaskRow: View {
    @Environment(\.colorScheme) private var scheme
    let task: TodayTask
    let today: String
    let note: TodayTaskNote?
    let onTick: (Bool) -> Void
    let onUndo: () -> Void
    /// Move Up and Move Down in the day's order (T6-1a); nil where the row has no place to move.
    var onMoveUp: (() -> Void)? = nil
    var onMoveDown: (() -> Void)? = nil

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                Toggle(isOn: Binding(get: { task.checked }, set: { onTick($0) })) {
                    Text(verbatim: task.text)
                        .metistryText(.body, p, task.checked ? .textTertiary : .textPrimary)
                        .strikethrough(task.checked)
                        .fixedSize(horizontal: false, vertical: true)
                }
                #if os(macOS)
                .toggleStyle(.checkbox)
                #endif
                .accessibilityLabel(Text(verbatim: task.spoken(today: today, note: note)))
                .todayMoveActions(up: onMoveUp, down: onMoveDown)
            }
            if let day = TaskDay(today) {
                FacetRow(TaskFacets(vaultTask: task.row), today: day)
                    .padding(.leading, MetistrySpace.s5)
            }
            if let note {
                TodayTaskNoteView(note: note, onUndo: onUndo)
                    .padding(.leading, MetistrySpace.s5)
            }
        }
    }
}

/// What a write left on its line: the receipt with Undo, the line as it now stands, or the refusal.
public enum TodayTaskNote: Sendable, Equatable {
    case ticked(path: String)
    case reopened(path: String)
    case deferred(DeferChoice)
    case stale(line: String?)
    case failed(String)
}

struct TodayTaskNoteView: View {
    @Environment(\.colorScheme) private var scheme
    let note: TodayTaskNote
    let onUndo: () -> Void

    var body: some View {
        let p = Palette(scheme)
        switch note {
        case .ticked(let path):
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                Text(verbatim: "Ticked in \(path)").metistryText(.footnote, p, .textSecondary).fixedSize(horizontal: false, vertical: true)
                ControlButton(ControlSpec("Undo", glyph: .undo, role: .plain)) { onUndo() }
            }
        case .reopened(let path):
            Text(verbatim: "Reopened in \(path)").metistryText(.footnote, p, .textSecondary)
        case .deferred(let choice):
            Text(verbatim: "Moved to \(choice.label.lowercased() == "someday" ? "someday" : choice.label.lowercased())")
                .metistryText(.footnote, p, .textSecondary)
        case .stale(let line):
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: "This line changed in your note since it was shown. Nothing was written.")
                    .metistryText(.footnote, p, .degraded)
                    .fixedSize(horizontal: false, vertical: true)
                Text(verbatim: line ?? "The line is gone from the note.")
                    .metistryFont(.footnote, design: .mono)
                    .foregroundStyle(p[.textPrimary])
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)
        case .failed(let why):
            Text(verbatim: why).metistryText(.footnote, p, .failed).fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// Next Up: retrieved first, then the one written line, then its actions (§15.2).
struct TodayNextUpView: View {
    @Environment(\.colorScheme) private var scheme
    let card: NextUpCard
    let today: String
    let expanded: Bool
    let prediction: TodayPrediction?
    let predictionNote: String?
    let notesNote: String?
    let notes: [String: TodayTaskNote]
    let assistantName: String?
    let clock: ClockTime
    let canRecord: Bool
    let onExpand: () -> Void
    let onOpenNotes: () -> Void
    let onRecord: () -> Void
    let onPredict: (TodayPrediction) -> Void
    let onCopyStandup: (() -> Void)?
    let onTick: (TodayTask, Bool) -> Void

    var body: some View {
        let p = Palette(scheme)
        let e = card.event
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            Text(verbatim: card.lead)
                .metistryText(.caption1, p, .textSecondary)
                .accessibilityLabel(Text(verbatim: card.spokenLead))
                .accessibilityAddTraits(.isHeader)
            Text(verbatim: e.title).metistryText(.headline, p).fixedSize(horizontal: false, vertical: true)
            Text(verbatim: [clock.range(e.start, e.end), e.location ?? ""].filter { !$0.isEmpty }.joined(separator: " · "))
                .metistryText(.callout, p, .textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            if card.isStandup {
                // Two lines and Copy Standup: the draft stays in the brief (§15.2).
                if let onCopyStandup {
                    ControlButton(ControlSpec(BriefWords.copyStandup)) { onCopyStandup() }
                }
            } else {
                if !e.others.isEmpty {
                    Text(verbatim: "With \(TodayWords.list(e.others.map(\.displayName)))")
                        .metistryText(.callout, p, .textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if !card.owed.isEmpty {
                    Text(verbatim: "What You Owe Them").metistryText(.subhead, p).accessibilityAddTraits(.isHeader)
                    ForEach(card.owed) { task in
                        TodayTaskRow(task: task, today: today, note: notes[task.key], onTick: { onTick(task, $0) }, onUndo: { onTick(task, false) })
                    }
                }
                if let written = card.written {
                    if expanded, let name = assistantName {
                        AgentProse(AgentProseModel(treatment: .wash, author: .assistant(named: name), text: written, generated: true), clock: clock)
                    } else {
                        TodayFoldedLine(text: written, spoken: "\(AgentProseModel.generatedNote): \(written)", onOpen: onExpand)
                    }
                }
                FlowLayout(spacing: MetistrySpace.s2) {
                    ControlButton(ControlSpec(TodayWords.openNotes, name: "\(TodayWords.openNotes), \(e.title)")) { onOpenNotes() }
                    ControlButton(ControlSpec(TodayWords.record, disabledBecause: canRecord ? nil : TodayWords.recordUnavailable, name: "\(TodayWords.record) \(e.title)")) { onRecord() }
                    if let prediction {
                        ControlButton(ControlSpec(prediction.label, name: prediction.spoken)) { onPredict(prediction) }
                            .accessibilityHint(Text(verbatim: prediction.reason))
                    }
                }
                if let prediction {
                    Text(verbatim: prediction.reason).metistryText(.footnote, p, .textSecondary).accessibilityHidden(true)
                }
                if let predictionNote {
                    Text(verbatim: predictionNote).metistryText(.footnote, p, .textSecondary).fixedSize(horizontal: false, vertical: true)
                }
                if let notesNote {
                    Text(verbatim: notesNote).metistryText(.footnote, p, .textSecondary).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(MetistrySpace.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(p[.elevated], in: RoundedRectangle(cornerRadius: MetistryRadius.lg, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: MetistryRadius.lg, style: .continuous).strokeBorder(p[.border], lineWidth: 1))
        .accessibilityElement(children: .contain)
    }
}

/// Calendar help, folded to one line beside its one action, and Not Today.
struct TodayCalendarHelpView: View {
    @Environment(\.colorScheme) private var scheme
    let help: CalendarHelp
    let prediction: TodayPrediction?
    let clock: ClockTime
    let busy: Bool
    let onMove: () -> Void
    let onNotToday: () -> Void

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            Text(verbatim: help.line(clock: clock))
                .metistryText(.callout, p, .textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            FlowLayout(spacing: MetistrySpace.s2) {
                if let prediction {
                    ControlButton(ControlSpec(prediction.label, disabledBecause: busy ? "Asking the calendar" : nil, name: prediction.spoken)) { onMove() }
                }
                ControlButton(ControlSpec(TodayWords.notToday, role: .plain, name: "\(TodayWords.notToday), no calendar help today")) { onNotToday() }
            }
        }
    }
}

/// The close panel (§15.5): Done, Still Open, Owed to People, Tomorrow, the line, and the act.
struct TodayClosePanel: View {
    @Environment(\.colorScheme) private var scheme
    let plan: CloseDayPlan
    let choices: [(DeferChoice, TaskDeferral)]
    let today: String
    let tomorrow: TomorrowShape?
    let clock: ClockTime
    let notes: [String: TodayTaskNote]
    let closing: Bool
    let refusal: String?
    @Binding var line: String
    let onDefer: (TodayTask, DeferChoice) -> Void
    let onTick: (TodayTask, Bool) -> Void
    let onClose: () -> Void
    @State private var showAllDone = false

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s4) {
            Text(verbatim: TodayWords.closeTheDay).metistryText(.title3, p).accessibilityAddTraits(.isHeader)

            section(TodayWords.done, p) {
                Text(verbatim: plan.doneHeadline).metistryText(.body, p)
                let shown = showAllDone ? plan.done : Array(plan.done.prefix(CloseDayPlan.shownDone))
                ForEach(shown) { task in
                    Text(verbatim: task.text).metistryText(.callout, p, .textSecondary).strikethrough().fixedSize(horizontal: false, vertical: true)
                }
                if plan.done.count > CloseDayPlan.shownDone && !showAllDone {
                    ControlButton(ControlSpec(TodayWords.showAll, role: .plain, name: "Show all \(plan.done.count) done")) { showAllDone = true }
                }
            }

            if !plan.stillOpen.isEmpty {
                section(TodayWords.stillOpen, p) {
                    ForEach(plan.stillOpen) { task in openRow(task, p) }
                }
            }

            if !plan.owed.isEmpty {
                section(TodayWords.owed, p) {
                    ForEach(plan.owed) { task in
                        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                            TodayTaskRow(task: task, today: today, note: notes[task.key], onTick: { onTick(task, $0) }, onUndo: { onTick(task, false) })
                            deferButtons(task)
                                .padding(.leading, MetistrySpace.s5)
                        }
                    }
                }
            }

            if let tomorrow {
                section(TodayWords.tomorrow, p) {
                    Text(verbatim: tomorrow.sentence(clock: clock)).metistryText(.body, p).fixedSize(horizontal: false, vertical: true)
                }
            }

            section(TodayWords.lineForTomorrow, p) {
                // The prompt names the field: SwiftUI on the Mac does not carry
                // `.accessibilityLabel` onto the AppKit field, and VoiceOver
                // reads an empty field's prompt (mac-app.md, "Needs You: the bodies").
                TextField(text: $line, prompt: Text(verbatim: TodayWords.linePrompt)) { Text(verbatim: TodayWords.lineForTomorrow) }
                    .textFieldStyle(.roundedBorder)
                Text(verbatim: TodayWords.lineHint).metistryText(.footnote, p, .textSecondary).fixedSize(horizontal: false, vertical: true)
            }

            if let refusal {
                Text(verbatim: refusal).metistryText(.callout, p, .failed).fixedSize(horizontal: false, vertical: true)
            }

            HStack {
                Spacer(minLength: 0)
                ControlButton(ControlSpec(TodayWords.closeTheDay, role: .primary, disabledBecause: closing ? "Closing" : nil)) { onClose() }
            }
        }
        .padding(MetistrySpace.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(p[.elevated], in: RoundedRectangle(cornerRadius: MetistryRadius.lg, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: MetistryRadius.lg, style: .continuous).strokeBorder(p[.border], lineWidth: 1))
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func section<Content: View>(_ title: String, _ p: Palette, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            Text(verbatim: title).metistryText(.subhead, p, .textSecondary).accessibilityAddTraits(.isHeader)
            content()
        }
    }

    private func openRow(_ task: TodayTask, _ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            Text(verbatim: task.text).metistryText(.body, p).fixedSize(horizontal: false, vertical: true)
            deferButtons(task)
            if let note = notes[task.key] {
                TodayTaskNoteView(note: note, onUndo: {})
            }
        }
    }

    private func deferButtons(_ task: TodayTask) -> some View {
        FlowLayout(spacing: MetistrySpace.s2) {
            ForEach(choices, id: \.0) { choice, _ in
                ControlButton(ControlSpec(choice.label, selected: notes[task.key] == .deferred(choice), name: "Move \(task.text) to \(choice.label.lowercased())")) { onDefer(task, choice) }
            }
        }
    }
}

/// A closed day folds to one line naming what it wrote, with Reopen.
struct TodayClosedLine: View {
    @Environment(\.colorScheme) private var scheme
    let closed: ClosedDay
    let tomorrow: String?
    let clock: ClockTime
    let onReopen: () -> Void

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                Text(verbatim: closed.foldedLine(tomorrow: tomorrow, clock: clock))
                    .metistryText(.callout, p)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: MetistrySpace.s2)
                ControlButton(ControlSpec(TodayWords.reopen, role: .plain, name: "Reopen Close the Day")) { onReopen() }
            }
            Text(verbatim: "Written to \(closed.path)\(closed.line == nil ? "" : " · your line leads tomorrow's plan")")
                .metistryText(.footnote, p, .textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// Broken markers: the request, never a success (§15.5.1).
struct TodayNoteNotWrittenView: View {
    @Environment(\.colorScheme) private var scheme
    let missing: NoteNotWritten
    let onOpenRequest: (() -> Void)?
    let onReopen: () -> Void

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                Image(systemName: MetistryGlyph.degraded.rawValue).foregroundStyle(p[.degraded]).accessibilityHidden(true)
                Text(verbatim: NoteNotWritten.title).metistryText(.headline, p).accessibilityAddTraits(.isHeader)
            }
            Text(verbatim: missing.sentence).metistryText(.callout, p).fixedSize(horizontal: false, vertical: true)
            FlowLayout(spacing: MetistrySpace.s2) {
                if let onOpenRequest {
                    ControlButton(ControlSpec(NoteNotWritten.openRequest, role: .primary, name: missing.requestID.map { "\(NoteNotWritten.openRequest), number \($0)" } ?? NoteNotWritten.openRequest)) { onOpenRequest() }
                }
                ControlButton(ControlSpec(TodayWords.reopen, role: .plain, name: "Reopen Close the Day")) { onReopen() }
            }
        }
        .padding(MetistrySpace.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(p[.degradedQuiet], in: RoundedRectangle(cornerRadius: MetistryRadius.lg, style: .continuous))
        .accessibilityElement(children: .contain)
    }
}

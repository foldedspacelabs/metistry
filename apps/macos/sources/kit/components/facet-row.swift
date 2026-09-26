// The facet row — one order, wherever a task is drawn (facets §8.1):
//
//     Priority · Due · Estimate · People · Links · State
//
// with the do-date, which reads **Planned** (C134; typed `do …`, stored
// `scheduled_for`), beside Due — the two dates together, told apart by the
// word, since Due owns the calendar glyph. One row builder, one order, no
// exceptions: Today, the Board, a card, a meeting's to-dos all call this.
//
// THE LADDER, AS RULES (facets §2, §7.1, §8.2; screen 5 §3, §13.3):
//
//   * Priority is weight, never hue: one badge shape for all four steps, P1
//     filled, P2–P4 outlined in `border-control` with the ink stepping down.
//     Unset renders nothing — absent and P3 are different facts.
//   * Due and Estimate are glyph-prefixed text, not chips: neither is a
//     target. An overdue Due escalates into the tinted chip, glyph and all.
//   * People and links are chips by kind of thing — `entity-person`,
//     `entity-note`, `entity-project`; a work row or an external ref neutral.
//   * State is a tint, from the state roles only, and the row carries at most
//     ONE. At most three chips in all; the rest fold into `+N`, and every one
//     of them is still in what VoiceOver says.
//
// The states are what the server REPORTED (`row_flags`, P5) — the component
// never decides a task is overdue from its date.

import SwiftUI

/// A calendar day as the wire sends it: `2026-09-28`.
public struct TaskDay: Sendable, Equatable, Comparable {
    public let iso: String

    public init?(_ iso: String?) {
        guard let iso, Self.date(iso) != nil else { return nil }
        self.iso = iso
    }

    static func date(_ iso: String) -> Date? {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        return f.date(from: iso)
    }

    var date: Date { Self.date(iso)! }

    public static func < (a: TaskDay, b: TaskDay) -> Bool { a.iso < b.iso }

    /// Whole days from `today` to this day.
    public func days(from today: TaskDay) -> Int {
        Int((date.timeIntervalSince(today.date) / 86_400).rounded())
    }

    private func format(_ pattern: String) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = pattern
        return f.string(from: date)
    }

    /// *Today* · *Tomorrow* · *Yesterday* · *Wed* (this week) · *28 Sep*.
    public func label(today: TaskDay) -> String {
        switch days(from: today) {
        case 0: return "Today"
        case 1: return "Tomorrow"
        case -1: return "Yesterday"
        case 2...6: return format("EEE")
        default: return format("d MMM")
        }
    }

    /// The same, in words VoiceOver reads well: *Wednesday*, *28 September*.
    public func spoken(today: TaskDay) -> String {
        switch days(from: today) {
        case 0: return "today"
        case 1: return "tomorrow"
        case -1: return "yesterday"
        case 2...6: return format("EEEE")
        default: return format("d MMMM")
        }
    }
}

/// A thing a task points at that you can open — a chip, by kind (facets §1).
public enum FacetLink: Sendable, Equatable {
    /// A note, a page, a document — its title, not its path (facets §3).
    case note(String)
    case project(String)
    /// An area is a project-kind thing (facets §1: *a project or an area*).
    case area(String)
    /// `Work #418` (facets §7.4).
    case work(Int)
    /// `linear:ABC-123` — an identifier is a value, printed as-is.
    case external(String)
}

/// What the server reported about the task's state. Closed: each case has
/// one rendering, and a new one is a change here.
public enum FacetState: Sendable, Equatable {
    /// Escalates Due into the tinted chip (facets §8.2).
    case overdue
    /// Waiting on someone else.
    case waiting
    case blocked
    /// Blocking an agent's work — glyph and tint (screen 5 §13.3, rung 4).
    case blockingAgent
    /// Carried over: nothing at 1 day, neutral at 2, `degraded-quiet` at 3–4,
    /// `degraded` with a glyph at 5+. Never `failed` (screen 5 §3).
    case carried(days: Int)
    case stale
    case failed
}

public struct TaskFacets: Sendable, Equatable {
    /// 1…4. Nil (and anything outside 1…4) renders nothing.
    public var priority: Int?
    public var due: TaskDay?
    /// `scheduled_for`, which reads *Planned* (C134).
    public var planned: TaskDay?
    public var estimateMinutes: Int?
    /// Names, verbatim — as the vault spells them.
    public var people: [String]
    public var links: [FacetLink]
    public var states: [FacetState]

    public init(priority: Int? = nil, due: TaskDay? = nil, planned: TaskDay? = nil, estimateMinutes: Int? = nil, people: [String] = [], links: [FacetLink] = [], states: [FacetState] = []) {
        self.priority = priority
        self.due = due
        self.planned = planned
        self.estimateMinutes = estimateMinutes
        self.people = people
        self.links = links
        self.states = states
    }

    /// `size s│m│l` rendered as minutes — S≈15, M≈45, L≈90 (daily-flow-spec
    /// field table). The map is instance config (§6.2); these are its defaults.
    public static let defaultSizeMinutes: [String: Int] = ["s": 15, "m": 45, "l": 90]

    /// A `vault_tasks` row as the wire serves it (`GET /api/today`'s tasks,
    /// `GET /api/vault-tasks`). The flags are the query's own `row_flags`.
    public init(vaultTask row: JSONValue, sizeMinutes: [String: Int] = TaskFacets.defaultSizeMinutes) {
        let flags = Set(row["row_flags"]?.arrayValue?.compactMap(\.stringValue) ?? [])
        var states: [FacetState] = []
        if flags.contains("overdue") { states.append(.overdue) }
        if flags.contains("blocking_agent") { states.append(.blockingAgent) }
        if flags.contains("carried"), let days = row["carried_days"]?.intValue { states.append(.carried(days: days)) }
        if flags.contains("waiting") { states.append(.waiting) }
        var links: [FacetLink] = []
        if let project = row.string("project") {
            links.append(.project(project))
        } else if let area = row.string("area") {
            links.append(.area(area))
        }
        if let work = row["work_id"]?.intValue ?? row.string("work_id").flatMap({ Int($0) }) { links.append(.work(work)) }
        links += (row["ext_refs"]?.arrayValue ?? []).compactMap(\.stringValue).map(FacetLink.external)
        self.init(
            priority: row["priority"]?.intValue,
            due: TaskDay(row.string("due")),
            planned: TaskDay(row.string("scheduled_for")),
            estimateMinutes: row.string("size").flatMap { sizeMinutes[$0.lowercased()] },
            people: row.string("assigned").map { [$0] } ?? [],
            links: links,
            states: states
        )
    }
}

public struct FacetRowModel: Sendable, Equatable {
    public var facets: TaskFacets
    public var today: TaskDay

    public init(_ facets: TaskFacets, today: TaskDay) {
        self.facets = facets
        self.today = today
    }

    /// The cap on chips per item, and on tinted ones (facets §1).
    public static let maxChips = 3
    public static let maxTints = 1

    public struct Presentation: Sendable, Equatable {
        /// In the one order. Chips beyond the cap are folded into the last, `+N`.
        public var marks: [Mark]
        /// Every facet, in words, the folded ones included.
        public var spoken: String
    }

    /// Which facet a mark is, for the order and the cap.
    enum Slot: Int, Comparable {
        case priority, due, planned, estimate, people, links, state, overflow
        static func < (a: Slot, b: Slot) -> Bool { a.rawValue < b.rawValue }
    }

    struct Piece {
        var slot: Slot
        var mark: Mark
        var spoken: String
        /// Chips count against the cap; the tint rank decides which tint survives.
        var isChip: Bool
        var tintRank: Int?
    }

    public func presentation(on ground: MetistryColorRole = .surface) -> Presentation {
        let f = facets
        var pieces: [Piece] = []
        let overdue = f.states.contains(.overdue)

        if let p = f.priority, (1...4).contains(p) {
            let mark: Mark
            if p == 1 {
                mark = Mark("P1", style: .caption1, weight: .bold, ink: .bg, plate: .textPrimary, on: ground, shape: .badge, spoken: "priority 1")
            } else {
                let ink: MetistryColorRole = p == 2 ? .textPrimary : p == 3 ? .textSecondary : .textTertiary
                mark = Mark("P\(p)", style: .caption1, weight: .semibold, ink: ink, on: ground, outline: .borderControl, shape: .badge, spoken: "priority \(p)")
            }
            pieces.append(Piece(slot: .priority, mark: mark, spoken: "priority \(p)", isChip: false, tintRank: nil))
        }
        if let due = f.due {
            let words = "due \(due.spoken(today: today))"
            if overdue {
                pieces.append(Piece(slot: .due, mark: Mark("Overdue · \(due.label(today: today))", glyph: .due, style: .subhead, ink: .degraded, plate: .degradedQuiet, on: ground, shape: .chip, spoken: "overdue, \(words)"), spoken: "overdue, \(words)", isChip: true, tintRank: 1))
            } else {
                pieces.append(Piece(slot: .due, mark: Mark(due.label(today: today), glyph: .due, style: .subhead, ink: .textSecondary, on: ground, spoken: words), spoken: words, isChip: false, tintRank: nil))
            }
        }
        if let planned = f.planned {
            let words = "planned \(planned.spoken(today: today))"
            pieces.append(Piece(slot: .planned, mark: Mark("Planned \(planned.label(today: today))", style: .subhead, ink: .textSecondary, on: ground, spoken: words), spoken: words, isChip: false, tintRank: nil))
        }
        if let minutes = f.estimateMinutes, minutes > 0 {
            let words = "about \(Self.spokenMinutes(minutes))"
            // The tilde is load-bearing: an estimate is not a measurement (screen 5 §7).
            pieces.append(Piece(slot: .estimate, mark: Mark("~" + Self.minutes(minutes), glyph: .estimate, style: .subhead, ink: .textSecondary, on: ground, spoken: words), spoken: words, isChip: false, tintRank: nil))
        }
        for person in f.people {
            pieces.append(Piece(slot: .people, mark: Mark(person, style: .subhead, ink: .entityPerson, plate: .entityPersonQuiet, on: ground, shape: .chip), spoken: person, isChip: true, tintRank: nil))
        }
        for link in f.links {
            let (text, ink, plate, design, words): (String, MetistryColorRole, MetistryColorRole, TypeDesign, String)
            switch link {
            case .note(let title): (text, ink, plate, design, words) = (title, .entityNote, .entityNoteQuiet, .sans, "note \(title)")
            case .project(let name): (text, ink, plate, design, words) = (name, .entityProject, .entityProjectQuiet, .sans, "project \(name)")
            case .area(let name): (text, ink, plate, design, words) = (name, .entityProject, .entityProjectQuiet, .sans, "area \(name)")
            case .work(let id): (text, ink, plate, design, words) = ("Work #\(id)", .textPrimary, .absentQuiet, .sans, "work \(id)")
            case .external(let ref): (text, ink, plate, design, words) = (ref, .textPrimary, .absentQuiet, .mono, ref)
            }
            pieces.append(Piece(slot: .links, mark: Mark(text, style: .subhead, design: design, ink: ink, plate: plate, on: ground, shape: .chip, spoken: words), spoken: words, isChip: true, tintRank: nil))
        }
        for state in f.states {
            guard let piece = Self.statePiece(state, on: ground) else { continue }
            pieces.append(piece)
        }

        // The cap. Tints first — only the most serious survives — then the
        // chips in the one order until the cap, then `+N` for the rest.
        let tints = pieces.enumerated().filter { $0.element.tintRank != nil }.sorted { $0.element.tintRank! < $1.element.tintRank! }
        var dropped = Set(tints.dropFirst(Self.maxTints).map(\.offset))
        let chips = pieces.enumerated().filter { $0.element.isChip && !dropped.contains($0.offset) }
        let keptTint = tints.first.map(\.offset)
        let ordered = chips.sorted { a, b in
            if a.offset == keptTint { return true }
            if b.offset == keptTint { return false }
            return a.offset < b.offset
        }
        let totalChips = pieces.filter(\.isChip).count
        let room = totalChips > Self.maxChips ? Self.maxChips - 1 : Self.maxChips
        for item in ordered.dropFirst(room) { dropped.insert(item.offset) }

        var marks = pieces.enumerated().filter { !dropped.contains($0.offset) }.sorted { $0.element.slot < $1.element.slot || ($0.element.slot == $1.element.slot && $0.offset < $1.offset) }.map(\.element.mark)
        if !dropped.isEmpty {
            let more = pieces.enumerated().filter { dropped.contains($0.offset) }.map(\.element.spoken)
            marks.append(Mark("+\(dropped.count)", style: .subhead, ink: .textPrimary, plate: .absentQuiet, on: ground, shape: .chip, spoken: "and \(more.joined(separator: ", "))"))
        }
        return Presentation(marks: marks, spoken: pieces.sorted { $0.slot < $1.slot }.map(\.spoken).joined(separator: ", "))
    }

    static func statePiece(_ state: FacetState, on ground: MetistryColorRole) -> Piece? {
        func tint(_ text: String, _ glyph: MetistryGlyph?, _ ink: MetistryColorRole, _ plate: MetistryColorRole, rank: Int, spoken: String) -> Piece {
            Piece(slot: .state, mark: Mark(text, glyph: glyph, style: .subhead, ink: ink, plate: plate, on: ground, shape: .chip, spoken: spoken), spoken: spoken, isChip: true, tintRank: rank)
        }
        switch state {
        case .overdue: return nil  // drawn as the Due facet itself
        case .failed: return tint("Failed", .failed, .failed, .failedQuiet, rank: 0, spoken: "failed")
        case .blockingAgent: return tint("Blocking an Agent", .degraded, .degraded, .degradedQuiet, rank: 2, spoken: "blocking an agent")
        case .carried(let days) where days >= 5: return tint("Day \(days)", .degraded, .degraded, .degradedQuiet, rank: 3, spoken: Self.carriedWords(days))
        case .carried(let days) where days >= 3: return tint("Day \(days)", nil, .textPrimary, .degradedQuiet, rank: 4, spoken: Self.carriedWords(days))
        case .carried(let days) where days == 2:
            return Piece(slot: .state, mark: Mark("Day 2", style: .subhead, ink: .textPrimary, plate: .absentQuiet, on: ground, shape: .chip, spoken: Self.carriedWords(2)), spoken: Self.carriedWords(2), isChip: true, tintRank: nil)
        case .carried: return nil  // one day carried is nothing (screen 5 §3)
        case .blocked: return tint("Blocked", nil, .presenceBlocked, .presenceBlockedQuiet, rank: 5, spoken: "blocked")
        case .waiting: return tint("Waiting", nil, .presenceBlocked, .presenceBlockedQuiet, rank: 6, spoken: "waiting")
        case .stale: return tint("Stale", .stale, .stale, .staleQuiet, rank: 7, spoken: "stale")
        }
    }

    static func carriedWords(_ days: Int) -> String {
        let ordinals = [2: "second", 3: "third", 4: "fourth", 5: "fifth", 6: "sixth", 7: "seventh", 8: "eighth", 9: "ninth", 10: "tenth"]
        return ordinals[days].map { "\($0) day" } ?? "day \(days)"
    }

    /// `45m` · `1h 30m` · `2h`.
    static func minutes(_ m: Int) -> String {
        m < 60 ? "\(m)m" : (m % 60 == 0 ? "\(m / 60)h" : "\(m / 60)h \(m % 60)m")
    }

    static func spokenMinutes(_ m: Int) -> String {
        if m < 60 { return "\(m) minutes" }
        let h = m / 60, r = m % 60
        let hours = h == 1 ? "1 hour" : "\(h) hours"
        return r == 0 ? hours : "\(hours) \(r) minutes"
    }
}

public struct FacetRow: View {
    let model: FacetRowModel
    let ground: MetistryColorRole

    public init(_ facets: TaskFacets, today: TaskDay, on ground: MetistryColorRole = .surface) {
        self.model = FacetRowModel(facets, today: today)
        self.ground = ground
    }

    public var body: some View {
        let view = model.presentation(on: ground)
        FlowLayout(spacing: MetistrySpace.s2, lineSpacing: MetistrySpace.s1) {
            ForEach(Array(view.marks.enumerated()), id: \.offset) { MarkView($0.element) }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: view.spoken))
    }
}

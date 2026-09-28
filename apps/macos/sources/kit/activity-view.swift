// Activity (design-build-plan T6-3; screen-02-activity.md §1–§12; design-system
// §3.2; C17, C18, C19, C43).
//
// WHAT HAPPENED WHILE YOU WERE AWAY. One list, newest first, read from the
// `activity_feed` named query and nothing else — `ActivityStore` over the
// session's gate. Every row is recent and none is urgent, so the only
// hierarchy is **time bands, one glyph column, and who did it** (§1): no row is
// coloured for being recent, and the glyph — not the row — takes `failed`, read
// from the query's `ok` column and never from the English in `detail` (C19).
//
// A REPLY'S TOOL CALLS FOLD INTO THE REPLY (§1). Rows sharing a `turn_id` sit
// under their `turn` row as one disclosure; opening it asks the query for that
// turn's calls by `turn_id`, so it shows all of them rather than only those
// that fell inside the window's `limit` (§6 fault 6). A turn's own row is drawn
// from its run (`GET /api/runs/:id`) — the model as its subject, the time, cost
// and tokens as its detail (§6 fault 3) — and until that answers it says what
// the feed row says.
//
// NEW ROWS ARE HELD AND COUNTED, NEVER INSERTED (§4, P9). The poll asks with
// `since` (the newest `ts` already seen, inclusive) and de-duplicates on
// `(ref, ts, kind)`; what is new waits in `pending` behind a *↓ 12 new* pill,
// and the painted list does not move until the owner takes it. A filter change
// is a different question: the cursor, the buffer and the painted list start
// again (§4).
//
// ROUTINES (§12). `routine_run` rows are the eighth chip. Its subject is the
// routine's display name, not the raw component id — `plan-tomorrow` reads
// `Tomorrow's Plan` (Ruling 25, X-21), stamped into `meta.display_name` by
// the runner from the manifest it already has loaded and read straight back
// by `activity_feed`, so the query never hands the panel a slug to
// un-hyphenate. A routine that wrote something
// carries the spark — what it produced is prose, and P1 says that shows
// before it is read — and opening it reads the file it names (its run's
// `meta.path`, through `GET /api/knowledge/page`) into the one prose component.
// A routine that could not run (`meta.outcome` `skipped:…`) is **absent**,
// never failed: nothing broke (§12.3). Both are read from the run's own
// structured `meta`, never parsed out of the feed's detail line.
//
// THE KEYS ARE THE MENU'S (§2.18.1, C119). ↑↓ move and ←→ fold a turn — the
// list's own navigation — and ↩ is Item ▸ Open, published for the selected
// row. Screen 2 §8 also names `1`–`7`, `/`, ⌘R and ⌘↩; none of them is in the
// closed menu table (shell-commands.swift, "a shortcut that is not here does
// not exist"), so the chips and the pill are focusable controls instead
// (Full Keyboard Access reaches them) and no bare key is bound here.
//
// THE NAME. The assistant's rows say its configured name; until the console
// has said it, the actor is left out — never a default, never the principal id.

import Foundation
import Observation
import SwiftUI

// MARK: - The eight chips

/// All, and the seven groups `activity_feed.yaml` derives (§3; C43 the seventh).
/// The value is passed straight through as the query's `kind` param, which
/// matches an exact kind OR a group — the SQL owns what is in each.
public enum ActivityChip: String, CaseIterable, Sendable, Identifiable {
    case all = ""
    case capture, proposal, decision, work, run, message, routine

    public var id: String { self == .all ? "all" : rawValue }

    public var label: String {
        switch self {
        case .all: return "All"
        case .capture: return "Captures"
        case .proposal: return "Proposals"
        case .decision: return "Decisions"
        case .work: return "Work"
        case .run: return "Runs"
        case .message: return "Messages"
        case .routine: return "Routines"
        }
    }

    /// The query's `kind` param. Nil for All: every kind.
    public var kind: String? { self == .all ? nil : rawValue }
}

/// The time window beside the title: the query's `hours`.
public enum ActivityWindow: Int, CaseIterable, Sendable, Identifiable {
    case day = 24
    case week = 168

    public var id: Int { rawValue }
    public var hours: Int { rawValue }

    /// The menu's words.
    public var label: String { self == .day ? "Last 24 hours" : "Last 7 days" }
    /// Inside a Title Case state title.
    public var titlePhrase: String { self == .day ? "the Last 24 Hours" : "the Last 7 Days" }
}

/// The four params the controls set. Nothing here is a filter the query
/// cannot run, and nothing the query can run is missing (§3).
public struct ActivityFilter: Sendable, Equatable {
    public var window: ActivityWindow = .day
    public var chip: ActivityChip = .all
    /// An actor, exactly as the rows name it. Nil: every actor.
    public var agent: String?
    /// A project id. Nil: every project.
    public var project: String?

    public init(window: ActivityWindow = .day, chip: ActivityChip = .all, agent: String? = nil, project: String? = nil) {
        self.window = window
        self.chip = chip
        self.agent = agent
        self.project = project
    }

    /// Anything but the window narrows it — which is what filtered-empty says.
    public var isNarrowed: Bool { chip != .all || agent != nil || project != nil }
}

// MARK: - Kinds: the glyph, and the kind said in words

/// One SF Symbol per `activity_feed` kind — design-system §3.2's fourteen, plus
/// `capture` (C17), `routine_run` (C43, the Scheduled row's own mark: a
/// routine) and `config_write` (T2-16). Decorative on screen — the row speaks
/// its kind in words, because a glyph has no accessible name of its own (§9).
public enum ActivityKind {
    public static let symbols: [String: String] = [
        "tool": "wrench.and.screwdriver",
        "turn": "bubble.left.and.bubble.right",
        "crew_run": "person.2",
        "dispatch": "tray.and.arrow.down",
        "task_op": "checklist",
        "agent_admin": "shield.lefthalf.filled",
        "project_mode": "slider.horizontal.3",
        "collector_run": "exclamationmark.triangle",
        "proposal_created": "doc.badge.plus",
        "proposal_decided": "checkmark.seal",
        "work_history": "list.bullet.rectangle",
        "brief": "newspaper",
        "review": "magnifyingglass",
        "alert": "bell.badge",
        "capture": "square.and.pencil",
        "routine_run": "repeat",
        "config_write": "gearshape",
    ]
    /// A kind this build has no glyph for.
    public static let other = "circle.dotted"

    public static func symbol(_ kind: String) -> String { symbols[kind] ?? other }

    static let words: [String: String] = [
        "tool": "tool call",
        "turn": "turn",
        "crew_run": "crew run",
        "dispatch": "dispatch",
        "task_op": "work change",
        "agent_admin": "agent change",
        "project_mode": "project mode",
        "collector_run": "collector run",
        "proposal_created": "request",
        "proposal_decided": "decision",
        "work_history": "work",
        "brief": "brief",
        "review": "review",
        "alert": "alert",
        "capture": "capture",
        "routine_run": "routine",
        "config_write": "configuration change",
    ]

    /// The kind as VoiceOver says it. An unknown kind is said as the wire
    /// spells it, its underscores read as spaces.
    public static func spoken(_ kind: String) -> String {
        words[kind] ?? kind.replacingOccurrences(of: "_", with: " ")
    }
}

// MARK: - Title Case at render, from a closed list (§2.2; design-system §3.2)

/// The subject is Title Cased only for kinds whose subject the console itself
/// composes. `turn`, `tool` and `dispatch` can carry authored text and are not
/// here; nor is `work_history`, whose subject is the task's own title (C18);
/// nor `capture`, whose subject is the note's first line. Identifiers — any
/// token holding `/ _ - . :` or a digit, or already mixed-case — are left as
/// they are, and the short joining words stay lowercase unless they lead.
public enum ActivityTitleCase {
    public static let kinds: Set<String> = [
        "collector_run", "proposal_created", "proposal_decided", "project_mode",
        "agent_admin", "brief", "review", "alert", "task_op", "crew_run", "routine_run",
    ]
    static let minor: Set<String> = ["a", "an", "and", "at", "by", "for", "in", "of", "on", "or", "the", "to", "via"]

    public static func subject(_ subject: String?, kind: String) -> String {
        guard let subject, !subject.isEmpty else { return "" }
        guard kinds.contains(kind) else { return subject }
        var out = ""
        var index = 0
        for token in tokens(subject) {
            defer { index += 1 }
            if token.first?.isWhitespace == true || isIdentifier(token) {
                out += token
                continue
            }
            let lower = token.lowercased()
            if index > 0 && minor.contains(lower) {
                out += lower
            } else {
                out += lower.prefix(1).uppercased() + lower.dropFirst()
            }
        }
        return out
    }

    /// Words and the whitespace between them, in order, so the string is
    /// rebuilt rather than rewritten.
    static func tokens(_ text: String) -> [String] {
        var out: [String] = []
        var current = ""
        var inSpace: Bool?
        for ch in text {
            let space = ch.isWhitespace
            if let inSpace, inSpace != space {
                out.append(current)
                current = ""
            }
            inSpace = space
            current.append(ch)
        }
        if !current.isEmpty { out.append(current) }
        return out
    }

    static func isIdentifier(_ word: String) -> Bool {
        if word.contains(where: { "/_-.:".contains($0) || $0.isNumber }) { return true }
        return word.contains(where: \.isLowercase) && word.contains(where: \.isUppercase)
    }
}

// MARK: - Time

public enum ActivityTime {
    /// *now* · *2m* · *3h* · *2d* — the time column.
    public static func short(_ seconds: TimeInterval) -> String {
        let s = max(Int(seconds), 0)
        if s < 60 { return "now" }
        if s < 3600 { return "\(s / 60)m" }
        if s < 86_400 { return "\(s / 3600)h" }
        return "\(s / 86_400)d"
    }

    /// *6.2s* · *4m 12s*.
    static func duration(ms: Int) -> String {
        ms < 60_000 ? String(format: "%.1fs", Double(ms) / 1000) : ClockTime.duration(Double(ms) / 1000)
    }

    static func spokenDuration(ms: Int) -> String {
        ms < 60_000 ? String(format: "%.1f seconds", Double(ms) / 1000) : ClockTime.duration(Double(ms) / 1000)
    }
}

/// The sticky headers (§2). A band is a stretch of time, not a colour.
public enum ActivityBand: Hashable, Sendable {
    case justNow
    case earlierToday
    case yesterday
    /// An older day, by its date — the 7-day window reaches past yesterday.
    case day(Date)

    /// How recent *Just now* is.
    public static let justNowSpan: TimeInterval = 15 * 60

    public static func of(_ date: Date, now: Date, calendar: Calendar) -> ActivityBand {
        if now.timeIntervalSince(date) < justNowSpan { return .justNow }
        if calendar.isDate(date, inSameDayAs: now) { return .earlierToday }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) { return .yesterday }
        return .day(calendar.startOfDay(for: date))
    }

    public func title(calendar: Calendar) -> String {
        switch self {
        case .justNow: return "Just now"
        case .earlierToday: return "Earlier today"
        case .yesterday: return "Yesterday"
        case .day(let date):
            let f = DateFormatter()
            f.locale = Locale(identifier: "en_US_POSIX")
            f.timeZone = calendar.timeZone
            f.dateFormat = "EEEE d MMM"
            return f.string(from: date)
        }
    }
}

// MARK: - Who did it

/// The actor chip (§2.1): the `agent` hue for an agent — the instance's
/// assistant by its configured name, or an agent the registry lists — and
/// neutral on `absent-quiet` for a channel, a component or the owner (P1).
/// A name the console has not given yet is left out, never replaced.
public enum ActivityActor: Sendable, Equatable {
    case agent(AgentChipModel)
    case neutral(String)

    public static func of(_ actor: String?, agents: Set<String>, assistantName: String?) -> ActivityActor? {
        guard let actor = actor?.trimmingCharacters(in: .whitespaces), !actor.isEmpty else { return nil }
        if actor == AgentChipModel.assistantPrincipal {
            return assistantName.map { .agent(.assistant(named: $0)) }
        }
        let crew = actor.hasPrefix("crew:") ? String(actor.dropFirst(5)) : nil
        if agents.contains(actor) || crew.map(agents.contains) == true {
            return .agent(AgentChipModel(agentID: actor, assistantName: assistantName ?? ""))
        }
        return .neutral(actor)
    }

    /// What the row prints, and what its sentence starts with (§9).
    public var label: String {
        switch self {
        case .agent(let chip): return chip.label
        case .neutral(let name): return name
        }
    }

    public var isAgent: Bool {
        if case .agent = self { return true }
        return false
    }

    public func mark(on ground: MetistryColorRole) -> Mark {
        switch self {
        case .agent(let chip):
            return chip.mark(on: ground)
        case .neutral(let name):
            return Mark(name, style: .caption1, design: .mono, ink: .textPrimary, plate: .absentQuiet, on: ground, shape: .chip, spoken: name)
        }
    }
}

// MARK: - Where a row goes

/// The row's `ref` (§2.1): what opening it opens.
public enum ActivityDestination: Sendable, Hashable {
    case capture(Int)
    case request(Int)
    case work(Int)
    case message(Int)
    /// Run detail, which is not drawn yet (§6 fault 2, §7): not openable.
    case run(Int)

    public init?(ref: String?) {
        guard let ref, let colon = ref.firstIndex(of: ":"), let id = Int(ref[ref.index(after: colon)...]) else { return nil }
        switch ref[..<colon] {
        case "inbox": self = .capture(id)
        case "proposals": self = .request(id)
        case "work": self = .work(id)
        case "outbound_messages": self = .message(id)
        case "runs": self = .run(id)
        default: return nil
        }
    }

    /// Whether there is anything to open. A run's detail has no screen yet.
    public var isOpenable: Bool {
        if case .run = self { return false }
        return true
    }
}

// MARK: - What a run says about itself

/// One run as `GET /api/runs/:id` reports it — read for a `turn` row (the
/// model, time, cost, tokens and the whole count of its calls) and for a
/// `routine_run` row (what it wrote, or why it did not run).
public struct ActivityRunReading: Sendable, Equatable {
    public var model: String?
    public var durationMs: Int?
    public var costUSD: Double?
    public var tokensIn: Int?
    public var tokensOut: Int?
    public var toolCallsTotal: Int
    public var toolCallsFailed: Int
    /// `acted` · `silent` · `skipped:<reason>` — the routine runner's own word.
    public var outcome: String?
    /// The vault file a routine wrote.
    public var path: String?
    /// Why a skip happened, in the runner's words.
    public var why: String?

    public init(model: String? = nil, durationMs: Int? = nil, costUSD: Double? = nil, tokensIn: Int? = nil, tokensOut: Int? = nil, toolCallsTotal: Int = 0, toolCallsFailed: Int = 0, outcome: String? = nil, path: String? = nil, why: String? = nil) {
        self.model = model
        self.durationMs = durationMs
        self.costUSD = costUSD
        self.tokensIn = tokensIn
        self.tokensOut = tokensOut
        self.toolCallsTotal = toolCallsTotal
        self.toolCallsFailed = toolCallsFailed
        self.outcome = outcome
        self.path = path
        self.why = why
    }

    public init(_ run: RunDetail) {
        self.init(
            model: run.model,
            durationMs: run.durationMs,
            costUSD: run.costUSD,
            tokensIn: run.tokensIn,
            tokensOut: run.tokensOut,
            toolCallsTotal: run.toolCallsTotal,
            toolCallsFailed: run.toolCallsFailed,
            outcome: run.meta?["outcome"]?.stringValue,
            path: run.meta?["path"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 },
            why: run.meta?["why"]?.stringValue
        )
    }

    /// A routine that could not run: absent, not failed (§12.3).
    public var skipReason: String? {
        guard let outcome, outcome.hasPrefix("skipped:") else { return nil }
        return String(outcome.dropFirst("skipped:".count))
    }

    /// A routine that wrote a file: its row carries the spark.
    public var wroteProse: Bool { skipReason == nil && path != nil }
}

/// Something read on demand — a turn's calls, a routine's file.
public enum ActivityRead<Value: Sendable & Equatable>: Sendable, Equatable {
    case loading
    case loaded(Value)
    case failed(String)

    public var value: Value? {
        if case .loaded(let v) = self { return v }
        return nil
    }
}

// MARK: - One row, as a value

/// A row drawn: every word, its ink and its ground, and the sentence VoiceOver
/// says — computed first, so a test reads the decisions (T5-3's rule).
public struct ActivityRowPresentation: Sendable, Equatable {
    /// The kind's SF Symbol — or, for a failed row, `failed`'s own mark, so
    /// failure never differs from the rest by colour alone (amendments §8.3).
    public var glyphSymbol: String
    public var glyphInk: MetistryColorRole
    /// `failed` (a run that failed), `absent` (a routine that could not run), or nil.
    public var state: MetistryColorRole?
    public var actor: Mark?
    /// The spark, before the subject, on a routine row that wrote prose (§12.1).
    public var spark: Mark?
    public var subject: Mark
    public var detail: Mark?
    public var time: Mark
    /// The absolute time, for `.help()` (design-system §3.2).
    public var absoluteTime: String
    public var spoken: String
    public var isOpenable: Bool

    /// Every mark, for the contrast check.
    public var marks: [Mark] { [actor, spark, subject, detail, time].compactMap { $0 } }
}

/// One turn, folded: how many calls it made, and whether it is open.
public struct ActivityTurnFold: Sendable, Equatable {
    public var count: Int
    public var failed: Int
    public var isExpanded: Bool
}

public enum ActivityRowPresenter {
    public static let ground: MetistryColorRole = .surface

    public static func present(
        _ row: ActivityFeedRow,
        agents: Set<String>,
        assistantName: String?,
        reading: ActivityRunReading? = nil,
        fold: ActivityTurnFold? = nil,
        now: Date,
        clock: ClockTime,
        canOpen: Bool = true
    ) -> ActivityRowPresentation {
        let ground = Self.ground
        let actor = ActivityActor.of(row.actor, agents: agents, assistantName: assistantName)
        let failed = row.ok == false
        let skipped = row.kind == "routine_run" ? reading?.skipReason : nil

        let state: MetistryColorRole? = failed ? .failed : (skipped != nil ? .absent : nil)
        let symbol: String
        switch state {
        case .failed?: symbol = MetistryGlyph.failed.rawValue
        case .absent?: symbol = MetistryGlyph.absent.rawValue
        default: symbol = ActivityKind.symbol(row.kind)
        }

        // A turn is its model, its time, cost and tokens (§6 fault 3) once its
        // run has answered; the feed's own words until then.
        var subject = ActivityTitleCase.subject(row.subject, kind: row.kind)
        var detailText = row.detail.flatMap { $0.isEmpty ? nil : $0 }
        var detailSpoken = detailText.map { $0.replacingOccurrences(of: " · ", with: ", ") }
        if row.kind == "turn", let reading {
            if let model = reading.model, !model.isEmpty { subject = model }
            var shown: [String] = []
            var said: [String] = []
            if let ms = reading.durationMs {
                shown.append(ActivityTime.duration(ms: ms))
                said.append(ActivityTime.spokenDuration(ms: ms))
            }
            if let cost = reading.costUSD {
                shown.append(cost < 0.01 ? String(format: "$%.4f", cost) : String(format: "$%.3f", cost))
                said.append(String(format: "%.1f cents", cost * 100))
            }
            if let tin = reading.tokensIn, let tout = reading.tokensOut {
                shown.append("\(tin + tout) tokens")
                said.append("\(tin + tout) tokens")
            }
            detailText = shown.isEmpty ? detailText : shown.joined(separator: " · ")
            detailSpoken = said.isEmpty ? detailSpoken : said.joined(separator: ", ")
        }
        if let fold {
            let tools = "\(fold.count) tool\(fold.count == 1 ? "" : "s")"
            let failedPart = fold.failed > 0 ? ", \(fold.failed) failed" : ""
            detailText = [detailText, tools + failedPart].compactMap { $0 }.joined(separator: " · ")
            detailSpoken = [detailSpoken, "\(tools)\(failedPart) \(fold.isExpanded ? "expanded" : "collapsed")"].compactMap { $0 }.joined(separator: ", ")
        }
        if let skipped {
            // The fact that stopped it, in the runner's words (§12.3).
            let why = reading?.why.flatMap { $0.isEmpty ? nil : $0 }
            detailText = ["didn't run: \(skipped)", why].compactMap { $0 }.joined(separator: " — ")
            detailSpoken = detailText
        }

        let date = WireTime.date(row.ts)
        let age = date.map { now.timeIntervalSince($0) } ?? 0
        let spark: Mark? = row.kind == "routine_run" && !failed && reading?.wroteProse == true
            ? Mark("", glyph: .spark, style: .caption1, ink: .agent, on: ground, spoken: "written")
            : nil

        var kindWords = ActivityKind.spoken(row.kind)
        if failed { kindWords += ", failed" }
        if skipped != nil { kindWords += ", didn't run" }
        if spark != nil { kindWords += ", written" }
        let sentence = [actor?.label, subject.isEmpty ? nil : subject, kindWords, detailSpoken, date.map { _ in ClockTime.age(age) }]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator: ", ")

        return ActivityRowPresentation(
            glyphSymbol: symbol,
            glyphInk: state ?? .textSecondary,
            state: state,
            actor: actor?.mark(on: ground),
            spark: spark,
            subject: Mark(subject, style: .body, ink: .textPrimary, on: ground),
            detail: detailText.map { Mark($0, style: .subhead, ink: .textSecondary, on: ground) },
            time: Mark(date.map { _ in ActivityTime.short(age) } ?? "", style: .footnote, ink: .textSecondary, on: ground),
            absoluteTime: date.map { clock.moment($0, now: now) } ?? row.ts,
            spoken: sentence,
            isOpenable: canOpen && (ActivityDestination(ref: row.ref)?.isOpenable ?? false)
        )
    }
}

// MARK: - The list's items

/// What the list draws, in its order: a row, a turn with its calls folded
/// under it, or a routine that wrote something (opening shows the prose).
public enum ActivityItem: Sendable, Equatable, Identifiable {
    case row(ActivityFeedRow)
    /// `calls` are the ones inside the window; opening fetches them all.
    case turn(head: ActivityFeedRow, turnID: String, calls: [ActivityFeedRow])
    case routine(ActivityFeedRow)

    public var id: String { head.identity }

    public var head: ActivityFeedRow {
        switch self {
        case .row(let r), .routine(let r): return r
        case .turn(let head, _, _): return head
        }
    }

    /// Group a newest-first page. A call whose `turn` row is on the page sits
    /// under it; a call whose turn fell outside the window stays a row of its
    /// own rather than being hidden.
    public static func group(_ rows: [ActivityFeedRow]) -> [ActivityItem] {
        var heads: [String: ActivityFeedRow] = [:]
        for row in rows where row.kind == "turn" {
            if let id = row.turnID, heads[id] == nil { heads[id] = row }
        }
        var calls: [String: [ActivityFeedRow]] = [:]
        for row in rows where row.kind != "turn" {
            if let id = row.turnID, heads[id] != nil { calls[id, default: []].append(row) }
        }
        var items: [ActivityItem] = []
        for row in rows {
            if let id = row.turnID, heads[id] != nil {
                guard row.kind == "turn", heads[id] == row else { continue }
                items.append(.turn(head: row, turnID: id, calls: calls[id] ?? []))
            } else if row.kind == "routine_run" && row.ok == true {
                items.append(.routine(row))
            } else {
                items.append(.row(row))
            }
        }
        return items
    }
}

public struct ActivityBandGroup: Sendable, Equatable, Identifiable {
    public let band: ActivityBand
    public let title: String
    public let items: [ActivityItem]
    public var id: String { title }
}

// MARK: - The model

/// The screen's state: the filter, the painted page, the held rows, and what
/// has been read on demand. Held by `AppModel`, so the list the owner left is
/// the list they return to; dropped with everything else on an instance switch.
@MainActor
@Observable
public final class ActivityModel {
    /// The query's own default, and the most a page holds.
    public static let pageLimit = 100
    /// How long the list on screen may go unrefreshed before the band says so.
    public static let ageLimit: TimeInterval = 300
    public static let policy = RefreshPolicy.feed

    public private(set) var filter = ActivityFilter()
    /// The painted page. `stale` keeps it when a refresh fails (P5).
    public private(set) var section = Section<ActivityFeed>()
    /// New rows, held and counted — never inserted until taken (§4).
    public private(set) var pending: [ActivityFeedRow] = []
    public private(set) var loadingSince: Date?
    public private(set) var consecutiveFailures = 0
    /// The list's selection: an item's or a call's identity.
    public var selection: String?
    /// Open turns and routines, by the head row's identity.
    public private(set) var expanded: Set<String> = []
    /// A turn's calls, asked by `turn_id` when it is opened.
    public private(set) var turnCalls: [String: ActivityRead<[ActivityFeedRow]>] = [:]
    /// What a run says about itself, by run id.
    public private(set) var runs: [Int: ActivityRead<ActivityRunReading>] = [:]
    /// A routine's file, by run id.
    public private(set) var prose: [Int: ActivityRead<KnowledgePage>] = [:]
    /// The registry's agent ids: whose chip takes the `agent` hue.
    public private(set) var agentIDs: Set<String> = []
    /// The project picker's options, from `GET /api/projects`.
    public private(set) var projectIDs: [String] = []

    @ObservationIgnored public var now: @MainActor () -> Date
    @ObservationIgnored public let calendar: Calendar
    @ObservationIgnored public let clock: ClockTime
    @ObservationIgnored private weak var session: ConsoleSession?
    /// Moves with every filter change and every reset: an answer to an older
    /// question is dropped when it lands.
    @ObservationIgnored private var question = 0
    @ObservationIgnored private var askedContext = false

    public init(session: ConsoleSession, timeZone: TimeZone = .current, now: @escaping @MainActor () -> Date = { Date() }) {
        self.session = session
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
    }

    // MARK: Reading

    public var rows: [ActivityFeedRow] { section.value?.rows ?? [] }
    public var pendingCount: Int { pending.count }

    /// The newest `ts` seen — painted or held — which is what `since` sends.
    public var cursor: String? {
        (rows.map(\.ts) + pending.map(\.ts)).max()
    }

    public var items: [ActivityItem] { ActivityItem.group(rows) }

    public var bands: [ActivityBandGroup] {
        let at = now()
        var order: [ActivityBand] = []
        var byBand: [ActivityBand: [ActivityItem]] = [:]
        for item in items {
            let band = WireTime.date(item.head.ts).map { ActivityBand.of($0, now: at, calendar: calendar) } ?? .justNow
            if byBand[band] == nil { order.append(band) }
            byBand[band, default: []].append(item)
        }
        return order.map { ActivityBandGroup(band: $0, title: $0.title(calendar: calendar), items: byBand[$0] ?? []) }
    }

    /// The actors on the page, for the agent picker — and the chosen one even
    /// when the page no longer holds it.
    public var actorOptions: [String] {
        var seen = Set(rows.compactMap(\.actor).filter { !$0.isEmpty })
        if let agent = filter.agent { seen.insert(agent) }
        return seen.sorted()
    }

    public var projectOptions: [String] {
        var ids = projectIDs
        if let project = filter.project, !ids.contains(project) { ids.append(project) }
        return ids
    }

    /// `↓ 12 new` — nil when nothing is held.
    public var pill: ControlSpec? {
        guard pendingCount > 0 else { return nil }
        return ControlSpec("↓ \(pendingCount) new", role: .secondary, name: "\(pendingCount) new row\(pendingCount == 1 ? "" : "s")")
    }

    public func presentation(_ row: ActivityFeedRow, assistantName: String?, canOpen: Bool = true) -> ActivityRowPresentation {
        ActivityRowPresenter.present(row, agents: agentIDs, assistantName: assistantName, reading: row.runID.flatMap { runs[$0]?.value }, now: now(), clock: clock, canOpen: canOpen)
    }

    public func presentation(_ item: ActivityItem, assistantName: String?, canOpen: Bool = true) -> ActivityRowPresentation {
        guard case .turn(let head, let turnID, let calls) = item else { return presentation(item.head, assistantName: assistantName, canOpen: canOpen) }
        let reading = head.runID.flatMap { runs[$0]?.value }
        let fetched = turnCalls[turnID]?.value.map(Self.callsOnly)
        let count = max(reading?.toolCallsTotal ?? 0, fetched?.count ?? calls.count)
        let failed = reading?.toolCallsFailed ?? (fetched ?? calls).filter { $0.ok == false }.count
        let fold = ActivityTurnFold(count: count, failed: failed, isExpanded: expanded.contains(item.id))
        return ActivityRowPresenter.present(head, agents: agentIDs, assistantName: assistantName, reading: reading, fold: fold, now: now(), clock: clock, canOpen: canOpen)
    }

    /// What an open turn shows: every call it made, in the order it made them —
    /// fetched by `turn_id`, or the window's own while that is asked — and a
    /// line when the window holds fewer than the turn made.
    public func calls(of item: ActivityItem) -> (rows: [ActivityFeedRow], note: String?) {
        guard case .turn(let head, let turnID, let window) = item else { return ([], nil) }
        let sequence: ([ActivityFeedRow]) -> [ActivityFeedRow] = { $0.sorted { $0.ts < $1.ts } }
        switch turnCalls[turnID] {
        case .loaded(let all)?:
            return (sequence(Self.callsOnly(all)), nil)
        case .failed(let why)?:
            let total = head.runID.flatMap { runs[$0]?.value?.toolCallsTotal } ?? window.count
            let note = total > window.count ? "\(total) tools, \(window.count) shown — couldn't read the rest: \(why)" : nil
            return (sequence(window), note)
        case .loading?, nil:
            return (sequence(window), nil)
        }
    }

    static func callsOnly(_ rows: [ActivityFeedRow]) -> [ActivityFeedRow] { rows.filter { $0.kind != "turn" } }

    /// Every row a selection can land on — heads and open calls.
    public func row(withID id: String) -> ActivityFeedRow? {
        for item in items {
            if item.id == id { return item.head }
            if expanded.contains(item.id), let call = calls(of: item).rows.first(where: { $0.identity == id }) { return call }
        }
        return nil
    }

    // MARK: The panel

    /// What takes the list's place, if anything (§5).
    public enum Panel: Sendable, Equatable {
        case placeholders(waitingFor: String?)
        case list(staleSince: Date?)
        case state(StatePanelModel)
    }

    public var panel: Panel {
        let at = now()
        switch FirstPaint.paint(section, loadingSince: loadingSince, ageLimit: Self.ageLimit, waitingFor: "Reading \(filter.window.titlePhrase.lowercased())", now: at) {
        case .placeholders(let waiting):
            return .placeholders(waitingFor: waiting)
        case .failed(let why):
            return .state(StatePanelModel(.failed, title: "Couldn't Load Activity", sentence: "Nothing is known about this window — it isn't an empty one.", reason: why, action: StateWords.tryAgain))
        case .content(let staleSince):
            guard rows.isEmpty else { return .list(staleSince: staleSince) }
            return .state(emptyState)
        }
    }

    /// Empty, or filtered-empty — never the same sentence (§5).
    public var emptyState: StatePanelModel {
        let window = filter.window.titlePhrase
        guard filter.isNarrowed else {
            return StatePanelModel(
                .empty,
                title: "Nothing in \(window)",
                sentence: "A quiet stretch, not a fault: nothing happened worth recording.",
                action: filter.window == .day ? "Widen to 7 Days" : nil
            )
        }
        var title = filter.chip == .all ? "Nothing" : "No \(filter.chip.label)"
        if let agent = filter.agent { title += " from \(agent)" }
        if let project = filter.project { title += " for \(project)" }
        return StatePanelModel(.empty, title: "\(title) in \(window)", sentence: "The filter is hiding everything else in this window.", action: "Clear the Filter")
    }

    /// The empty panel's one action.
    public func takeEmptyAction() async {
        if filter.isNarrowed {
            await apply(ActivityFilter(window: filter.window))
        } else if filter.window == .day {
            await apply(ActivityFilter(window: .week))
        }
    }

    // MARK: Asking

    /// A full pull for the current filter: the painted page, from nothing.
    public func load() async {
        guard let session else { return }
        let asked = question
        let generation = session.generation
        let filter = self.filter
        loadingSince = now()
        section.beginLoading(background: section.hasValue)
        let answer = await session.stores.activityFeed(
            hours: filter.window.hours, limit: Self.pageLimit, kind: filter.chip.kind,
            project: filter.project, agent: filter.agent, since: nil, turnID: nil
        )
        guard asked == question, session.generation == generation else { return }
        loadingSince = nil
        record(answer) { page in
            self.pending = []
            self.section.loaded(page, asOf: WireTime.date(page.asOf))
        }
    }

    /// The poll: everything at or after the cursor, held rather than painted.
    public func poll() async {
        guard let session else { return }
        guard section.hasValue, !rows.isEmpty, let since = cursor else { return await load() }
        let asked = question
        let generation = session.generation
        let filter = self.filter
        section.beginLoading(background: true)
        let answer = await session.stores.activityFeed(
            hours: filter.window.hours, limit: Self.pageLimit, kind: filter.chip.kind,
            project: filter.project, agent: filter.agent, since: since, turnID: nil
        )
        guard asked == question, session.generation == generation else { return }
        record(answer) { page in
            let known = Set(self.rows.map(\.identity) + self.pending.map(\.identity))
            var seen = known
            var fresh: [ActivityFeedRow] = []
            for row in page.rows where !seen.contains(row.identity) {
                seen.insert(row.identity)
                fresh.append(row)
            }
            if !fresh.isEmpty { self.pending = (fresh + self.pending).sorted { $0.ts > $1.ts } }
            // The painted page is unchanged, and still what the console says
            // happened — only newer, held rows were added.
            if let painted = self.section.value { self.section.loaded(painted, asOf: WireTime.date(page.asOf) ?? self.section.asOf) }
        }
    }

    private func record(_ answer: Result<ActivityFeed, ConsoleError>, _ loaded: (ActivityFeed) -> Void) {
        switch answer {
        case .success(let page):
            loaded(page)
            consecutiveFailures = 0
        case .failure(let error):
            section.failed(error)
            if case .unreachable = section.reachability { consecutiveFailures += 1 } else { consecutiveFailures = 0 }
        }
    }

    /// What the view's clock calls: asks only when `policy` says it is time.
    public func refreshIfDue() async {
        if !askedContext { await loadContext() }
        guard Self.policy.isDue(lastAttemptAt: section.lastAttemptAt, consecutiveFailures: consecutiveFailures, now: now()) else { return }
        await poll()
    }

    /// Take the held rows: they are painted in one step, at the top (§4).
    public func showPending() {
        guard !pending.isEmpty, let painted = section.value else { return }
        let merged = painted.merging(ActivityFeed(rows: pending, asOf: painted.asOf))
        pending = []
        section.loaded(merged, asOf: section.asOf)
    }

    /// Who is an agent, and which projects exist — asked once, and again after
    /// an instance switch. Neither blocks the list: without the registry every
    /// chip but the assistant's is neutral, which claims nothing.
    public func loadContext() async {
        guard let session else { return }
        askedContext = true
        let generation = session.generation
        async let agents = session.stores.agents()
        async let projects = session.stores.projects()
        let (a, p) = await (agents, projects)
        guard session.generation == generation else { return }
        if case .success(let list) = a { agentIDs = Set(list.agents.map(\.id)) }
        if case .success(let list) = p {
            projectIDs = (list.json["projects"]?.arrayValue ?? []).compactMap { $0["id"]?.stringValue }.sorted()
        }
    }

    // MARK: The filter

    /// A different question: the cursor, the buffer and the page start again.
    public func apply(_ next: ActivityFilter) async {
        guard next != filter else { return }
        filter = next
        question += 1
        section = Section()
        pending = []
        expanded = []
        turnCalls = [:]
        selection = nil
        await load()
    }

    public func setWindow(_ window: ActivityWindow) async { var f = filter; f.window = window; await apply(f) }
    public func setChip(_ chip: ActivityChip) async { var f = filter; f.chip = chip; await apply(f) }
    public func setAgent(_ agent: String?) async { var f = filter; f.agent = agent; await apply(f) }
    public func setProject(_ project: String?) async { var f = filter; f.project = project; await apply(f) }

    // MARK: Opening a turn, a routine

    public func isExpanded(_ item: ActivityItem) -> Bool { expanded.contains(item.id) }

    public func setExpanded(_ item: ActivityItem, _ open: Bool) async {
        guard open != expanded.contains(item.id) else { return }
        if open { expanded.insert(item.id) } else { expanded.remove(item.id) }
        guard open else { return }
        switch item {
        case .turn(_, let turnID, _):
            await readTurn(turnID)
        case .routine(let row):
            guard let id = row.runID else { return }
            await readRun(id)
            await readProse(id)
        case .row:
            break
        }
    }

    /// Every call one reply made, by `turn_id`, in this window.
    public func readTurn(_ turnID: String) async {
        guard let session, turnCalls[turnID]?.value == nil else { return }
        let asked = question
        let generation = session.generation
        turnCalls[turnID] = .loading
        let answer = await session.stores.activityTurn(turnID, hours: filter.window.hours)
        guard asked == question, session.generation == generation else { return }
        switch answer {
        case .success(let page): turnCalls[turnID] = .loaded(page.rows)
        case .failure(let error): turnCalls[turnID] = .failed(error.localizedDescription)
        }
    }

    /// What one run says about itself. Asked once per run; a row asks when it appears.
    public func readRun(_ id: Int) async {
        guard let session else { return }
        switch runs[id] {
        case .loading?, .loaded?: return
        case .failed?, nil: break
        }
        let generation = session.generation
        runs[id] = .loading
        let answer = await session.stores.run(id)
        guard session.generation == generation else { return }
        switch answer {
        case .success(let reply): runs[id] = .loaded(ActivityRunReading(reply.run))
        case .failure(let error): runs[id] = .failed(error.localizedDescription)
        }
    }

    /// The file a routine wrote, read whole — the prose, verbatim.
    public func readProse(_ id: Int) async {
        guard let session, prose[id]?.value == nil else { return }
        guard let path = runs[id]?.value?.path else { return }
        let generation = session.generation
        prose[id] = .loading
        let answer = await session.stores.knowledgePage(path: path)
        guard session.generation == generation else { return }
        switch answer {
        case .success(let page): prose[id] = .loaded(page)
        case .failure(let error): prose[id] = .failed(error.localizedDescription)
        }
    }

    /// Drop everything. Called by the session on an instance switch.
    public func reset() {
        question += 1
        filter = ActivityFilter()
        section = Section()
        pending = []
        loadingSince = nil
        consecutiveFailures = 0
        selection = nil
        expanded = []
        turnCalls = [:]
        runs = [:]
        prose = [:]
        agentIDs = []
        projectIDs = []
        askedContext = false
    }
}

// MARK: - The view

public struct ActivityView: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: ActivityModel
    let assistantName: String?
    /// Opens a row's destination. Nil: nothing on this screen opens.
    let onOpen: ((ActivityDestination) -> Void)?
    /// The view's clock tick; the model decides whether a tick is a request.
    let tick: Duration

    public init(model: ActivityModel, assistantName: String?, tick: Duration = .seconds(5), onOpen: ((ActivityDestination) -> Void)? = nil) {
        self.model = model
        self.assistantName = assistantName
        self.onOpen = onOpen
        self.tick = tick
    }

    public var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: 0) {
            ActivityHeader(model: model)
                .padding(.horizontal, MetistrySpace.s4)
                .padding(.top, MetistrySpace.s3)
                .padding(.bottom, MetistrySpace.s2)
            content(p)
        }
        // Flexible down to nothing: the list scrolls, and the window's minimum
        // is the shell's to set. Without the zeros the screen's minimum was its
        // content's at no width at all — the chips a character per line, 1,117 pt
        // tall — and the window grew, or its content slid off the top, when
        // Activity opened.
        .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .topLeading)
        .background(p[ActivityRowPresenter.ground])
        .task {
            await model.refreshIfDue()
            while !Task.isCancelled {
                try? await Task.sleep(for: tick)
                if Task.isCancelled { break }
                await model.refreshIfDue()
            }
        }
    }

    @ViewBuilder
    private func content(_ p: Palette) -> some View {
        switch model.panel {
        case .placeholders(let waiting):
            PlaceholderRows(count: 6, waitingFor: waiting)
                .padding(MetistrySpace.s4)
            Spacer(minLength: 0)
        case .state(let state):
            if let pill = model.pill { pillRow(pill) }
            StatePanel(state, now: model.now(), clock: model.clock) {
                Task {
                    if state.kind == .failed { await model.load() } else { await model.takeEmptyAction() }
                }
            }
            Spacer(minLength: 0)
        case .list(let staleSince):
            if let staleSince {
                StaleBand(StaleBandModel("Showing activity", asOf: staleSince, action: StateWords.tryAgain), now: model.now(), clock: model.clock) {
                    Task { await model.poll() }
                }
            }
            ActivityList(model: model, assistantName: assistantName, onOpen: onOpen, pill: model.pill)
        }
    }

    private func pillRow(_ pill: ControlSpec) -> some View {
        HStack {
            Spacer(minLength: 0)
            ControlButton(pill) { model.showPending() }
                .accessibilityHint(Text(verbatim: ActivityWords.pillHint))
            Spacer(minLength: 0)
        }
        .padding(.vertical, MetistrySpace.s1)
    }
}

/// Words the screen says in more than one place.
public enum ActivityWords {
    public static let title = "Activity"
    public static let pillHint = "Activates to show them"
    public static let open = "Open"
}

/// The title and the three controls beside it (§2), then the eight chips.
struct ActivityHeader: View {
    @Environment(\.colorScheme) private var scheme
    let model: ActivityModel

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            FlowLayout(spacing: MetistrySpace.s3, lineSpacing: MetistrySpace.s2) {
                Text(verbatim: ActivityWords.title)
                    .metistryFont(.title2, weight: .semibold)
                    .foregroundStyle(p[.textPrimary])
                    .accessibilityAddTraits(.isHeader)
                Picker("Window", selection: Binding(get: { model.filter.window }, set: { w in Task { await model.setWindow(w) } })) {
                    ForEach(ActivityWindow.allCases) { Text(verbatim: $0.label).tag($0) }
                }
                .pickerStyle(.menu)
                .fixedSize()
                Picker("Agent", selection: Binding(get: { model.filter.agent ?? "" }, set: { a in Task { await model.setAgent(a.isEmpty ? nil : a) } })) {
                    Text("Every agent").tag("")
                    ForEach(model.actorOptions, id: \.self) { Text(verbatim: $0).tag($0) }
                }
                .pickerStyle(.menu)
                .fixedSize()
                Picker("Project", selection: Binding(get: { model.filter.project ?? "" }, set: { v in Task { await model.setProject(v.isEmpty ? nil : v) } })) {
                    Text("Every project").tag("")
                    ForEach(model.projectOptions, id: \.self) { Text(verbatim: $0).tag($0) }
                }
                .pickerStyle(.menu)
                .fixedSize()
            }
            FlowLayout(spacing: MetistrySpace.s2, lineSpacing: MetistrySpace.s1) {
                ForEach(ActivityChip.allCases) { chip in
                    Button {
                        Task { await model.setChip(chip) }
                    } label: {
                        Text(verbatim: chip.label)
                    }
                    .buttonStyle(ActivityChipStyle(isSelected: model.filter.chip == chip))
                    .accessibilityLabel(Text(verbatim: chip.label))
                    .accessibilityAddTraits(model.filter.chip == chip ? .isSelected : [])
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel(Text(verbatim: "Show"))
        }
    }
}

/// A filter chip: outlined, or on `accent-quiet` when chosen — a choice, not a
/// state, so never a state colour — with the focus ring every custom control
/// carries under Full Keyboard Access (§2.18.6).
struct ActivityChipStyle: ButtonStyle {
    let isSelected: Bool

    func makeBody(configuration: Configuration) -> some View {
        Styled(configuration: configuration, isSelected: isSelected)
    }

    struct Styled: View {
        @Environment(\.colorScheme) private var scheme
        @Environment(\.isFocused) private var focused
        let configuration: ButtonStyle.Configuration
        let isSelected: Bool

        var body: some View {
            let p = Palette(scheme)
            configuration.label
                .metistryFont(.subhead, weight: isSelected ? .semibold : .medium)
                .foregroundStyle(p[.textPrimary])
                .padding(.horizontal, MetistrySpace.s3)
                .padding(.vertical, 3)
                .background(isSelected ? p[.accentQuiet] : .clear, in: Capsule())
                .overlay(Capsule().strokeBorder(isSelected ? .clear : p[.borderControl], lineWidth: 1))
                .overlay(Capsule().inset(by: -3).strokeBorder(focused ? p[.focusRing] : .clear, lineWidth: 2))
                .contentShape(Capsule())
        }
    }
}

/// The bands and their rows.
struct ActivityList: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: ActivityModel
    let assistantName: String?
    let onOpen: ((ActivityDestination) -> Void)?
    let pill: ControlSpec?

    var body: some View {
        let p = Palette(scheme)
        let canOpen = onOpen != nil
        ScrollViewReader { proxy in
            VStack(spacing: 0) {
                if let pill {
                    HStack {
                        Spacer(minLength: 0)
                        ControlButton(pill) {
                            let top = model.bands.first?.items.first?.id
                            model.showPending()
                            // To the top, in one step: nothing slides (§2.18.4).
                            if let first = model.bands.first?.items.first?.id ?? top { proxy.scrollTo(first, anchor: .top) }
                        }
                        .accessibilityHint(Text(verbatim: ActivityWords.pillHint))
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, MetistrySpace.s1)
                }
                List(selection: $model.selection) {
                    ForEach(model.bands) { band in
                        SwiftUI.Section {
                            ForEach(band.items) { item in
                                itemView(item, canOpen: canOpen)
                            }
                        } header: {
                            ActivityBandHeader(title: band.title)
                        }
                    }
                }
                .listStyle(.inset)
                .scrollContentBackground(.hidden)
                .background(p[ActivityRowPresenter.ground])
                .contextMenu(forSelectionType: String.self) { ids in
                    if let id = ids.first, let destination = openable(id) {
                        Button(ActivityWords.open) { onOpen?(destination) }
                    }
                } primaryAction: { ids in
                    if let id = ids.first, let destination = openable(id) { onOpen?(destination) }
                }
                .onKeyPress(.rightArrow) { fold(open: true) }
                .onKeyPress(.leftArrow) { fold(open: false) }
                .shellListFocus()
                .shellItemActions(itemActions)
                .accessibilityLabel(Text(verbatim: ActivityWords.title))
            }
        }
    }

    @ViewBuilder
    private func itemView(_ item: ActivityItem, canOpen: Bool) -> some View {
        switch item {
        case .row(let row):
            ActivityRowView(model.presentation(item, assistantName: assistantName, canOpen: canOpen))
                .tag(item.id)
                .id(item.id)
                .task { if row.kind == "routine_run", let id = row.runID { await model.readRun(id) } }
        case .turn:
            DisclosureGroup(isExpanded: expansion(item)) {
                let calls = model.calls(of: item)
                ForEach(calls.rows) { call in
                    ActivityRowView(model.presentation(call, assistantName: assistantName, canOpen: canOpen))
                        .tag(call.identity)
                }
                if let note = calls.note {
                    MarkView(Mark(note, style: .subhead, ink: .textSecondary, on: ActivityRowPresenter.ground))
                }
            } label: {
                ActivityRowView(model.presentation(item, assistantName: assistantName, canOpen: canOpen))
            }
            .tag(item.id)
            .id(item.id)
            .task { if let id = item.head.runID { await model.readRun(id) } }
        case .routine(let row):
            DisclosureGroup(isExpanded: expansion(item)) {
                RoutineProse(model: model, row: row, assistantName: assistantName)
            } label: {
                ActivityRowView(model.presentation(item, assistantName: assistantName, canOpen: canOpen))
            }
            .tag(item.id)
            .id(item.id)
            .task { if let id = row.runID { await model.readRun(id) } }
        }
    }

    private func expansion(_ item: ActivityItem) -> Binding<Bool> {
        Binding(get: { model.isExpanded(item) }, set: { open in Task { await model.setExpanded(item, open) } })
    }

    private func openable(_ id: String) -> ActivityDestination? {
        guard onOpen != nil, let destination = ActivityDestination(ref: model.row(withID: id)?.ref), destination.isOpenable else { return nil }
        return destination
    }

    /// Item ▸ Open (↩), for a selected row that has somewhere to go.
    private var itemActions: ShellActionTable {
        guard let id = model.selection, let destination = openable(id), let onOpen else { return [:] }
        return [.open: { onOpen(destination) }]
    }

    /// ←/→ fold and unfold the selected turn or routine.
    private func fold(open: Bool) -> KeyPress.Result {
        guard let id = model.selection, let item = model.items.first(where: { $0.id == id }) else { return .ignored }
        if case .row = item { return .ignored }
        guard model.isExpanded(item) != open else { return .ignored }
        Task { await model.setExpanded(item, open) }
        return .handled
    }
}

/// A band's sticky header, on `sunken` — heading level 3 (§9).
struct ActivityBandHeader: View {
    @Environment(\.colorScheme) private var scheme
    let title: String

    static func mark(_ title: String) -> Mark {
        Mark(title, style: .subhead, weight: .semibold, ink: .textSecondary, on: .sunken)
    }

    var body: some View {
        let p = Palette(scheme)
        Text(verbatim: title)
            .metistryFont(.subhead, weight: .semibold)
            .foregroundStyle(p[.textSecondary])
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, MetistrySpace.s2)
            .padding(.vertical, MetistrySpace.s1)
            .background(p[.sunken])
            .accessibilityAddTraits(.isHeader)
            .accessibilityHeading(.h3)
    }
}

/// One row: `[glyph] [actor] [subject] … [time]`, the detail beneath on the
/// same left edge, clamped to two lines (§2.1).
public struct ActivityRowView: View {
    @Environment(\.colorScheme) private var scheme
    let presentation: ActivityRowPresentation

    public init(_ presentation: ActivityRowPresentation) {
        self.presentation = presentation
    }

    public var body: some View {
        let p = Palette(scheme)
        let v = presentation
        HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
            Image(systemName: v.glyphSymbol)
                .foregroundStyle(p[v.glyphInk])
                .metistryFont(.body)
                .frame(minWidth: 18)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                    if let actor = v.actor { MarkView(actor).layoutPriority(1) }
                    if let spark = v.spark { MarkView(spark) }
                    Text(verbatim: v.subject.text)
                        .metistryFont(.body)
                        .foregroundStyle(p[v.subject.ink])
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: MetistrySpace.s2)
                    Text(verbatim: v.time.text)
                        .metistryFont(.footnote)
                        .monospacedDigit()
                        .foregroundStyle(p[v.time.ink])
                        .fixedSize()
                        .help(v.absoluteTime)
                }
                if let detail = v.detail {
                    Text(verbatim: detail.text)
                        .metistryFont(.subhead)
                        .foregroundStyle(p[detail.ink])
                        .lineLimit(2)
                        .truncationMode(.tail)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: v.spoken))
        .accessibilityAddTraits(v.isOpenable ? .isButton : [])
    }
}

/// An open routine: the file it wrote, in the one prose component — or why it
/// is not there. Not a diff: a plan has no previous version (§12.1).
struct RoutineProse: View {
    let model: ActivityModel
    let row: ActivityFeedRow
    let assistantName: String?

    var body: some View {
        let id = row.runID ?? -1
        Group {
            switch model.runs[id] {
            case .failed(let why)?:
                StatePanel(StatePanelModel(.failed, title: "Couldn't Read This Run", sentence: "What it wrote is unknown until it can be read.", reason: why, action: StateWords.tryAgain)) {
                    Task { await model.readRun(id); await model.readProse(id) }
                }
            case .loaded(let reading)?:
                if let path = reading.path {
                    switch model.prose[id] {
                    case .loaded(let page)?:
                        AgentProse(AgentProseModel(treatment: .wash, author: author, text: page.content, at: WireTime.date(row.ts), generated: true), clock: model.clock)
                    case .failed(let why)?:
                        StatePanel(StatePanelModel(.failed, title: "Couldn't Read \(path)", sentence: "The run says it wrote this file.", reason: why, action: StateWords.tryAgain)) {
                            Task { await model.readProse(id) }
                        }
                    case .loading?, nil:
                        PlaceholderRows(count: 3, waitingFor: "Reading \(path)")
                            .task { await model.readProse(id) }
                    }
                } else {
                    StatePanel(StatePanelModel(.absent, title: "Nothing Written", sentence: reading.skipReason == nil ? "This run names no file it wrote." : "It didn't run, so it wrote nothing."))
                }
            case .loading?, nil:
                PlaceholderRows(count: 2, waitingFor: "Reading the run")
            }
        }
        .padding(.vertical, MetistrySpace.s2)
    }

    /// Who wrote it: the agent the routine assigned, or — a built-in routine —
    /// the instance's assistant by name; with no name known, the row's own actor (P5).
    private var author: AgentChipModel {
        if case .agent(let chip)? = ActivityActor.of(row.actor, agents: model.agentIDs, assistantName: assistantName) { return chip }
        if let assistantName { return .assistant(named: assistantName) }
        return AgentChipModel(agentID: row.actor ?? "", assistantName: "")
    }
}

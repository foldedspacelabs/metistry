// Needs You — the list (design-build-plan T5-4a; screen 3 §3, §12.7, §13;
// components-01 §2; C110, K2, R11, R14, R15).
//
// ONE LINE PER REQUEST, AND THE SELECTED ONE BESIDE IT. The queue is
// `GET /api/proposals` (pending, minus what Later put down), one line per
// request — its type, what it asks, who is asking, how old it is — grouped
// *Today* and *Earlier*, newest first (the queue's own order), filtered by
// type and by **From**. One selected request is drawn at reading width on the
// right; drawing it — the bodies and the answers — is T5-4b's, reached
// through `detail`, so this file is the list and the row and nothing inside a
// request.
//
// SEVERAL SELECTED IS THE BULK LIST (screen 3 §3; reply-feedback.md). Select
// more than one — ⌘-click, ⇧-click, ⇧↑↓, ⌘A, or *Select All on This Page* —
// and the right-hand side becomes the selection's verbs: **Later · Skip ·
// Decline**, and never Approve. That is enforced here, not described:
// `BulkVerb` is the closed list the selection can be answered with, it has no
// case that sends `allow`, `accept_with_changes` or `accept_as_work`, and the
// selection is answered through it and nothing else — "the interface must not
// offer what the endpoint refuses". Skip lives only here (K2): no single row
// offers it. Decline is `deny`, always, with its per-kind consequences (R15).
// The page is at most 100 rows (`MAX_LIST`), so the selection is too, and the
// control says *on this page* rather than hiding the cap.
//
// PARTIAL SUCCESS IS THE NORMAL OUTCOME (§3.1). The batch is all-or-nothing per
// row, so its result is a band above the list, not a toast: *2 of 3 declined*,
// what happened to the rest, and — for a row still pending — its selection
// kept and **Retry** acting on exactly it. The colour is on the glyph; the
// words stay `text-primary`.
//
// O3. Every decision here — the three verbs, Retry, the Item menu's L and D —
// is disabled while the console is unreachable, with the gate's own sentence
// under it (components-01 §1.3), and `answerSelection` refuses before asking
// the store as well, so a menu that raced the gate sends nothing either.
//
// THE NAME. The assistant's rows say its configured name; until the console
// has said it, the name is left out — never a default, never *assistant*.

import Foundation
import Observation
import SwiftUI

// MARK: - Who asked (screen 3 §12.7)

/// The From filter's buckets: the instance's assistant, the other agents, and
/// each source system a mirrored request lives in. A source is read from the
/// row's `source` (migration 0027); `GET /api/proposals` does not select that
/// column yet, so until it does, From offers Everyone · the assistant · Agents.
public enum NeedsYouFrom: Hashable, Sendable {
    case assistant
    case agents
    /// `github`, `calendar`, `mail`, `linear` — `proposals.source.kind`.
    case source(String)

    /// The bucket a row is in. A mirror is its source's, whoever raised it; a
    /// row with neither a source nor an agent is in no bucket but Everyone.
    public static func of(_ row: RequestRow) -> NeedsYouFrom? {
        if let kind = row.source?.kind.trimmingCharacters(in: .whitespaces), !kind.isEmpty { return .source(kind) }
        guard let agent = row.sourceAgent?.trimmingCharacters(in: .whitespaces), !agent.isEmpty else { return nil }
        return agent == AgentChipModel.assistantPrincipal ? .assistant : .agents
    }

    /// The menu's word. Nil for the assistant until its name is known.
    public func label(assistantName: String?) -> String? {
        switch self {
        case .assistant: return assistantName
        case .agents: return "Agents"
        case .source(let kind): return NeedsYouSources.name(kind)
        }
    }

    /// Everyone · the assistant · Agents · the sources in §12.7's order, then
    /// any other source by its name.
    var rank: (Int, String) {
        switch self {
        case .assistant: return (0, "")
        case .agents: return (1, "")
        case .source(let kind):
            let known = NeedsYouSources.known.firstIndex { $0.kind == kind.lowercased() }
            return (2 + (known ?? NeedsYouSources.known.count), kind)
        }
    }
}

/// The source systems §12.7 names, by the name each goes by. A kind this
/// build does not know is printed as the wire spells it (P10), never guessed at.
public enum NeedsYouSources {
    static let known: [(kind: String, name: String)] = [
        ("github", "GitHub"), ("calendar", "Calendar"), ("mail", "Mail"), ("linear", "Linear"),
    ]

    public static func name(_ kind: String) -> String {
        known.first { $0.kind == kind.lowercased() }?.name ?? kind
    }
}

// MARK: - The type's glyph

/// The glyph beside a type's word. Decorative — the word says the type — so it
/// is hidden from VoiceOver; and no symbol here is one a shared component
/// already gives a meaning (amendments §8.3: one glyph, one meaning), which
/// `needs-you-view-tests.swift` holds against `MetistryGlyph`.
public enum NeedsYouTypeGlyph {
    public static let symbols: [String: String] = [
        "question": "questionmark.bubble",
        "pull_request": "arrow.triangle.pull",
        "access": "key",
        "action": "bolt",
        "meeting": "mic",
        "review": "eye",
        "note": "note.text",
        "improvement": "wand.and.stars",
        "report": "doc.plaintext",
        "invitation": "calendar.badge.plus",
        "task": "list.bullet.rectangle",
        "message": "envelope",
    ]
    /// A type this build has no glyph for, or a row with no reading.
    public static let other = "doc"

    public static func symbol(_ type: String?) -> String {
        type.flatMap { symbols[$0] } ?? other
    }
}

// MARK: - How old

public enum NeedsYouAge {
    /// *now* · *8m* · *2h* · *3d* — the list's compact age.
    public static func short(_ seconds: TimeInterval) -> String {
        let s = max(Int(seconds), 0)
        if s < 60 { return "now" }
        if s < 3600 { return "\(s / 60)m" }
        if s < 86_400 { return "\(s / 3600)h" }
        return "\(s / 86_400)d"
    }

    /// What VoiceOver says for it (components-01 §2.8): *12 minutes old*.
    public static func spoken(_ seconds: TimeInterval) -> String {
        let s = max(Int(seconds), 0)
        func unit(_ n: Int, _ word: String) -> String { "\(n) \(word)\(n == 1 ? "" : "s") old" }
        if s < 60 { return "just now" }
        if s < 3600 { return unit(s / 60, "minute") }
        if s < 86_400 { return unit(s / 3600, "hour") }
        return unit(s / 86_400, "day")
    }
}

// MARK: - One line

/// One request as the list draws it: a value first, so the words, their order
/// and their inks are testable, then a view that only draws it (the T5-3 rule).
public struct NeedsYouRowModel: Sendable, Equatable, Identifiable {
    public let id: Int
    /// The type key, for the filter; nil from a console older than X-5.
    public let type: String?
    /// The word the owner reads, from the console — never the stored kind.
    public let word: String
    public let symbol: String
    /// What it asks, verbatim (agent-written, so never case-corrected — P10).
    public let title: String?
    public let from: NeedsYouFrom?
    /// The agent chip; nil for a mirror, for a row with no agent, and for the
    /// assistant while its name is unknown.
    public let chip: AgentChipModel?
    /// The source a mirror lives in, and the person it names.
    public let sourceName: String?
    public let person: String?
    /// `external` or `you` — `internal` is the default and carries no marker (C22).
    public let trust: String?
    public let age: String
    public let spokenAge: String
    public let isToday: Bool

    public init(_ row: RequestRow, assistantName: String?, now: Date, calendar: Calendar) {
        id = row.id
        type = row.request?.type
        // A row with no reading says what it is in general, and nothing more:
        // the stored kind is the machinery's word, not the owner's.
        word = row.request?.word ?? "request"
        symbol = NeedsYouTypeGlyph.symbol(row.request?.type)
        title = Self.title(of: row)
        from = NeedsYouFrom.of(row)
        switch from {
        case .assistant:
            chip = assistantName.map { AgentChipModel.assistant(named: $0) }
        case .agents:
            chip = row.sourceAgent.map { AgentChipModel(agentID: $0, assistantName: assistantName ?? "") }
        case .source, .none:
            chip = nil
        }
        if case .source(let kind) = from {
            sourceName = NeedsYouSources.name(kind)
            person = row.source?.person.flatMap { $0.isEmpty ? nil : $0 }
        } else {
            sourceName = nil
            person = nil
        }
        switch row.trust {
        case "external": trust = "external"
        case "user": trust = "you"
        default: trust = nil
        }
        let at = WireTime.date(row.ts)
        let elapsed = at.map { now.timeIntervalSince($0) }
        age = elapsed.map(NeedsYouAge.short) ?? "—"
        spokenAge = elapsed.map(NeedsYouAge.spoken) ?? "age unknown"
        isToday = at.map { calendar.isDate($0, inSameDayAs: now) } ?? false
    }

    /// What the request asks, from its own payload: its title, or its summary,
    /// or — an access request — the folder it wants. Nil rather than a kind or
    /// a path dressed up as a title (content-states: `partial`).
    static func title(of row: RequestRow) -> String? {
        for key in ["title", "summary"] {
            if let text = row.payload?.string(key)?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty { return text }
        }
        if let access = row.accessRequest { return "Read \(access.area)" }
        return nil
    }

    public struct Presentation: Sendable, Equatable {
        public var symbol: String
        public var word: Mark
        public var age: Mark
        /// The title, or — when the request carries none — the partial note.
        public var title: Mark
        public var chips: [Mark]
        public var spoken: String
    }

    public func presentation(on ground: MetistryColorRole = .surface) -> Presentation {
        var chips: [Mark] = []
        if let chip { chips.append(chip.mark(on: ground)) }
        if let sourceName {
            chips.append(Mark(sourceName, style: .caption1, ink: .textSecondary, plate: .sunken, on: ground, shape: .chip, spoken: "from \(sourceName)"))
            if let person { chips.append(Mark(person, style: .caption1, ink: .textSecondary, on: ground)) }
        }
        // Provenance is neutral: a grey chip, never the warning tint (C22, review 01).
        if let trust { chips.append(Mark(trust, style: .caption1, ink: .textSecondary, plate: .sunken, on: ground, shape: .chip)) }

        let titleMark = title.map { Mark($0, style: .body, weight: .medium, ink: .textPrimary, on: ground) }
            ?? PartialNoteModel("this request carries no title").mark(on: ground)
        return Presentation(
            symbol: symbol,
            word: Mark(word, style: .caption2, weight: .semibold, ink: .textSecondary, on: ground, uppercase: true),
            age: Mark(age, style: .caption1, ink: .textSecondary, on: ground, spoken: spokenAge),
            title: titleMark,
            chips: chips,
            spoken: spoken
        )
    }

    /// components-01 §2.8: *from agent drey-dev: access, Read Areas/Finance.
    /// 12 minutes old.* — who first, because the words that follow are theirs (P1).
    public var spoken: String {
        var who: [String] = []
        if let chip { who.append(chip.spoken) }
        if let sourceName { who.append(["from \(sourceName)", person].compactMap { $0 }.joined(separator: ", ")) }
        if let trust { who.append(trust) }
        let lead = who.isEmpty ? "" : who.joined(separator: ", ") + ": "
        return "\(lead)\(word), \(title ?? "no title"). \(spokenAge)."
    }
}

// MARK: - Grouping and filters

public struct NeedsYouGroup: Sendable, Equatable, Identifiable {
    public enum Day: String, Sendable { case today = "Today", earlier = "Earlier" }
    public let day: Day
    public let rows: [NeedsYouRowModel]
    public var id: String { day.rawValue }
    /// *Today · 6* — the count lets the eye skip a whole group.
    public var title: String { "\(day.rawValue) · \(rows.count)" }
}

public struct NeedsYouTypeChip: Sendable, Equatable, Identifiable {
    /// Nil is All.
    public let type: String?
    public let label: String
    public let count: Int
    public var id: String { type ?? "" }

    /// The word the console gave, pluralised and in Title Case for a filter:
    /// *pull request* → *Pull Requests*, *access* → *Access*.
    public static func label(for word: String) -> String {
        let titled = word.split(separator: " ").map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
        return titled.hasSuffix("s") ? titled : titled + "s"
    }
}

public struct NeedsYouFromOption: Sendable, Equatable, Identifiable {
    /// Nil is Everyone.
    public let from: NeedsYouFrom?
    public let label: String
    public let count: Int
    public var id: String { label }
}

// MARK: - The bulk verbs (K2; reply-feedback.md)

/// What a selection may be answered with — closed, and without Approve.
/// Approve, Revise and Approve as Work each DO something per kind (an
/// `action` runs), so they stay one at a time; the batch route refuses them
/// and this list cannot express them.
public enum BulkVerb: String, CaseIterable, Sendable {
    case later, skip, decline

    public var label: String {
        switch self {
        case .later: return "Later"
        case .skip: return "Skip"
        case .decline: return "Decline"
        }
    }

    /// The answer the batch sends. Decline is `deny`, always, with the one
    /// reason given once; Skip writes the fixed marker and ignores it.
    public func answer(reason: String = "") -> RequestAnswer {
        switch self {
        case .later: return .later
        case .skip: return .skip
        case .decline:
            let why = reason.trimmingCharacters(in: .whitespacesAndNewlines)
            return .decline(why.isEmpty ? nil : why)
        }
    }

    /// *2 of 3 declined.*
    public var past: String {
        switch self {
        case .later: return "set for later"
        case .skip: return "skipped"
        case .decline: return "declined"
        }
    }

    /// The Item menu's key for it. Skip has none: every Mac shortcut is a menu
    /// item (§2.18.1), and the Item menu's closed list has no Skip.
    public var command: ShellCommand? {
        switch self {
        case .later: return .later
        case .decline: return .decline
        case .skip: return nil
        }
    }

    public var glyph: MetistryGlyph? { self == .later ? .later : nil }
}

// MARK: - The partial-success band (§3.1)

public struct BulkOutcome: Sendable, Equatable {
    public let verb: BulkVerb
    /// Exactly what was sent — Decline's reason included — so Retry re-sends
    /// the same answer rather than whatever the field says now.
    public let answer: RequestAnswer
    /// The ids sent, in the order they were listed.
    public let asked: [Int]
    public let applied: [Int]
    /// Answered somewhere else first — the first answer to arrive wins.
    public let elsewhere: [Int]
    /// Refused for another reason, each with the console's own words.
    public let refused: [(id: Int, reason: String)]
    /// Still pending after the queue was read again: what Retry acts on.
    public let retryable: [Int]
    /// The batch itself did not go through; nothing was applied.
    public let failure: String?

    public static func == (a: BulkOutcome, b: BulkOutcome) -> Bool {
        a.verb == b.verb && a.answer == b.answer && a.asked == b.asked && a.applied == b.applied && a.elsewhere == b.elsewhere
            && a.refused.map(\.id) == b.refused.map(\.id) && a.refused.map(\.reason) == b.refused.map(\.reason)
            && a.retryable == b.retryable && a.failure == b.failure
    }

    init(verb: BulkVerb, answer: RequestAnswer? = nil, asked: [Int], result: Result<RequestBatchResult, ConsoleError>, stillPending: Set<Int>) {
        self.verb = verb
        self.answer = answer ?? verb.answer()
        self.asked = asked
        switch result {
        case .success(let batch):
            let byID = Dictionary(batch.results.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            applied = asked.filter { byID[$0]?.ok == true }
            elsewhere = asked.filter { byID[$0]?.ok == false && byID[$0]?.reason == "already_decided" }
            refused = asked.compactMap { id in
                guard let row = byID[id] else { return (id, "the console gave no answer for it") }
                guard !row.ok, row.reason != "already_decided" else { return nil }
                return (id, row.error?.message ?? row.reason ?? "refused")
            }
            failure = nil
        case .failure(let error):
            applied = []
            elsewhere = []
            refused = []
            failure = error.localizedDescription
        }
        let unsettled = failure == nil ? refused.map(\.id) : asked
        retryable = unsettled.filter { stillPending.contains($0) }
    }

    public var isComplete: Bool { failure == nil && applied.count == asked.count }

    public struct Presentation: Sendable, Equatable {
        public var headline: Mark
        public var lines: [Mark]
        public var controls: [ControlSpec]
        public var spoken: String
    }

    /// The band's words. `disabledBecause` is O3's fact, when Retry cannot go.
    public func presentation(on ground: MetistryColorRole = .elevated, disabledBecause: String? = nil) -> Presentation {
        let glyph: MetistryGlyph?
        let glyphInk: MetistryColorRole?
        let headline: String
        if failure != nil {
            headline = "Nothing was \(verb.past)."
            (glyph, glyphInk) = (.failed, .failed)
        } else if isComplete {
            headline = "\(asked.count) \(verb.past)."
            (glyph, glyphInk) = (nil, nil)
        } else {
            headline = "\(applied.count) of \(asked.count) \(verb.past)."
            (glyph, glyphInk) = (.degraded, .degraded)
        }
        var lines: [String] = []
        if let failure { lines.append(failure) }
        if !elsewhere.isEmpty {
            lines.append("\(Self.count(elsewhere.count)) answered somewhere else while this was open.")
        }
        let reasons = Array(Set(refused.map(\.reason))).sorted()
        for reason in reasons {
            let n = refused.filter { $0.reason == reason }.count
            lines.append("\(Self.subject(n)) couldn't be \(verb.past): \(reason)")
        }
        if !retryable.isEmpty {
            lines.append("\(retryable.count == 1 ? "It is" : "They are") still selected — nothing was lost and nothing was re-sent.")
        }
        var controls: [ControlSpec] = []
        if !retryable.isEmpty {
            controls.append(ControlSpec("Retry \(retryable.count)", role: .secondary, disabledBecause: disabledBecause))
        }
        controls.append(ControlSpec("Dismiss", role: .plain))
        let head = Mark(headline, glyph: glyph, glyphInk: glyphInk, style: .headline, ink: .textPrimary, on: ground,
                        spoken: glyph == nil ? headline : "\(glyph == .failed ? "failed" : "partial"). \(headline)")
        let marks = lines.map { Mark($0, style: .subhead, ink: .textPrimary, on: ground) }
        return Presentation(headline: head, lines: marks, controls: controls, spoken: ([headline] + lines).joined(separator: " "))
    }

    /// *One was* / *3 were*.
    static func count(_ n: Int) -> String { n == 1 ? "One was" : "\(n) were" }
    static func subject(_ n: Int) -> String { n == 1 ? "One" : "\(n)" }
}

// MARK: - The model

@MainActor
@Observable
public final class NeedsYouModel {
    /// The console's page ceiling (`MAX_LIST`): the batch refuses more, so the
    /// selection never holds more.
    public static let pageLimit = 100
    /// How long a queue on screen may go unrefreshed before the band says so.
    public static let ageLimit: TimeInterval = 300

    /// `GET /api/proposals`, with the moment its answer arrived — the route
    /// carries no `as_of`, and the stale band has to say *as of* something the
    /// console did say.
    public let queue: SectionModel<RequestPage>

    public private(set) var typeFilter: String?
    public private(set) var fromFilter: NeedsYouFrom?
    /// The list's selection. One is the detail; two or more is the bulk list.
    public var selection: Set<Int> = []
    /// Decline's one reason, given once for the whole selection.
    public var declineReason = ""
    public private(set) var outcome: BulkOutcome?
    /// A batch is in flight: the verbs wait for it (the owner's own state, so
    /// no line under them).
    public private(set) var isAnswering = false

    /// Called after an answer changed the queue — the shell's count.
    @ObservationIgnored public var onQueueChanged: (@MainActor () async -> Void)?
    /// Posts a VoiceOver announcement. Injected so a test can hear it.
    @ObservationIgnored public var announce: @MainActor (String) -> Void = { text in
        AccessibilityNotification.Announcement(text).post()
    }
    @ObservationIgnored public var now: @MainActor () -> Date
    @ObservationIgnored public var calendar: Calendar

    @ObservationIgnored private weak var session: ConsoleSession?
    @ObservationIgnored private var didFirstSelect = false
    @ObservationIgnored private var anchor: Int?
    @ObservationIgnored private var requestCards: (name: String, generation: Int, cards: RequestCards)?

    public init(session: ConsoleSession, timeZone: TimeZone = .current, now: @escaping @MainActor () -> Date = { Date() }) {
        self.session = session
        self.now = now
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        self.calendar = calendar
        // `needs_you.changed` marks it due; while the stream is live it waits to be told (T5-7).
        queue = SectionModel(session: session, policy: .requests, topics: [.needsYou]) { stores in
            await stores.requests().map { ($0, Date()) }
        }
        session.register { [weak self] in
            guard let self else { return false }
            self.reset()
            return true
        }
    }

    // MARK: Reading

    /// The queue as it stands: pending and not put down.
    public var rows: [RequestRow] {
        let at = now()
        return (queue.section.value?.proposals ?? []).filter { $0.isInQueue(now: at) }
    }

    public func rowModels(assistantName: String?) -> [NeedsYouRowModel] {
        let at = now()
        return rows.map { NeedsYouRowModel($0, assistantName: assistantName, now: at, calendar: calendar) }
    }

    /// What the filters let through, in the list's order.
    public var visibleRows: [RequestRow] {
        rows.filter { row in
            (typeFilter == nil || row.request?.type == typeFilter) && (fromFilter == nil || NeedsYouFrom.of(row) == fromFilter)
        }
    }

    public func groups(assistantName: String?) -> [NeedsYouGroup] {
        let at = now()
        let models = visibleRows.map { NeedsYouRowModel($0, assistantName: assistantName, now: at, calendar: calendar) }
        return [NeedsYouGroup.Day.today, .earlier].compactMap { day in
            let rows = models.filter { $0.isToday == (day == .today) }
            return rows.isEmpty ? nil : NeedsYouGroup(day: day, rows: rows)
        }
    }

    /// All, then each type present, most first — counted over the whole queue.
    public var typeChips: [NeedsYouTypeChip] {
        var order: [String] = []
        var counts: [String: Int] = [:]
        var words: [String: String] = [:]
        for row in rows {
            guard let shape = row.request else { continue }
            if counts[shape.type] == nil { order.append(shape.type) }
            counts[shape.type, default: 0] += 1
            words[shape.type] = shape.word
        }
        let types = order.enumerated().sorted { a, b in
            let (ca, cb) = (counts[a.element] ?? 0, counts[b.element] ?? 0)
            return ca != cb ? ca > cb : a.offset < b.offset
        }.map(\.element)
        return [NeedsYouTypeChip(type: nil, label: "All", count: rows.count)]
            + types.map { NeedsYouTypeChip(type: $0, label: NeedsYouTypeChip.label(for: words[$0] ?? $0), count: counts[$0] ?? 0) }
    }

    /// Everyone, then each asker present. The assistant's bucket is offered only
    /// once its name is known; its rows are under Everyone until then.
    public func fromOptions(assistantName: String?) -> [NeedsYouFromOption] {
        var counts: [NeedsYouFrom: Int] = [:]
        for row in rows { if let from = NeedsYouFrom.of(row) { counts[from, default: 0] += 1 } }
        let present = counts.keys.sorted { $0.rank < $1.rank }
        return [NeedsYouFromOption(from: nil, label: "Everyone", count: rows.count)]
            + present.compactMap { from in
                from.label(assistantName: assistantName).map { NeedsYouFromOption(from: from, label: $0, count: counts[from] ?? 0) }
            }
    }

    // MARK: Selecting

    /// The selection, as the bulk list answers it: only rows still listed, in
    /// the list's order, never more than a page.
    public var bulkIDs: [Int] {
        Array(visibleRows.map(\.id).filter(selection.contains).prefix(Self.pageLimit))
    }

    public var isBulk: Bool { bulkIDs.count >= 2 }

    public var selectedRow: RequestRow? {
        guard selection.count == 1, let id = selection.first else { return nil }
        return visibleRows.first { $0.id == id }
    }

    /// *Select All on This Page*: every row the filters show, up to the page.
    public func selectAllOnPage() {
        selection = Set(visibleRows.prefix(Self.pageLimit).map(\.id))
    }

    public func clearSelection() {
        selection = []
    }

    /// Land on one request — a notification, Today's *N waiting* (§13.1).
    public func focus(on id: Int) {
        if !visibleRows.contains(where: { $0.id == id }) {
            typeFilter = nil
            fromFilter = nil
        }
        selection = [id]
        didFirstSelect = true
    }

    public func filter(type: String?) {
        typeFilter = type
        reconcile()
    }

    public func filter(from: NeedsYouFrom?) {
        fromFilter = from
        reconcile()
    }

    /// After the queue or a filter moved: a filter with nothing left in it goes
    /// back to all; a selection never holds a row the list no longer shows; and
    /// when the selected request left (answered here or elsewhere), the one that
    /// took its place is selected, so the detail is never an empty column.
    func reconcile() {
        if let type = typeFilter, !rows.contains(where: { $0.request?.type == type }) { typeFilter = nil }
        if let from = fromFilter, !rows.contains(where: { NeedsYouFrom.of($0) == from }) { fromFilter = nil }
        let visible = visibleRows.map(\.id)
        let kept = selection.filter(visible.contains)
        if kept.isEmpty, !visible.isEmpty, !selection.isEmpty || !didFirstSelect {
            selection = [visible[min(anchor ?? 0, visible.count - 1)]]
            didFirstSelect = true
        } else if kept != selection {
            selection = kept
        }
        // Where the selection starts in the list, so the row that takes the
        // place of an answered one is the one selected next.
        anchor = visible.firstIndex(where: selection.contains) ?? anchor
    }

    // MARK: Asking

    public func refresh() async {
        await queue.refresh(background: queue.section.hasValue)
        reconcile()
    }

    public func refreshIfDue() async {
        let before = queue.section.lastAttemptAt
        await queue.refreshIfDue(now: now())
        if queue.section.lastAttemptAt != before { reconcile() }
    }

    // MARK: Deciding

    public var allowsDecisions: Bool { session?.allowsDecisions ?? false }

    /// O3's sentence, when decisions cannot go.
    public var decisionsUnavailableReason: String? {
        guard let session else { return StateWords.unreachable }
        return session.decisionsUnavailableReason
    }

    /// The bulk list's three verbs, in order — and no fourth.
    public var bulkControls: [ControlSpec] {
        let off = allowsDecisions ? nil : decisionsUnavailableReason
        return BulkVerb.allCases.map { verb in
            ControlSpec(verb.label, glyph: verb.glyph, role: .secondary, shortcut: verb.command?.shortcut?.spoken, disabledBecause: off)
        }
    }

    /// Answer the selection with one verb. Refused before the store is asked
    /// while decisions are off (O3), with nothing selected, or while a batch
    /// is already in flight.
    @discardableResult
    public func answerSelection(_ verb: BulkVerb) async -> BulkOutcome? {
        await answer(bulkIDs, verb, verb.answer(reason: declineReason))
    }

    /// Retry exactly the rows the last batch left pending.
    @discardableResult
    public func retry() async -> BulkOutcome? {
        guard let outcome, !outcome.retryable.isEmpty else { return nil }
        return await answer(outcome.retryable, outcome.verb, outcome.answer)
    }

    public func dismissOutcome() {
        outcome = nil
    }

    private func answer(_ ids: [Int], _ verb: BulkVerb, _ answer: RequestAnswer) async -> BulkOutcome? {
        let ids = Array(ids.prefix(Self.pageLimit))
        // The one door this list answers through: a BulkVerb's own answer,
        // which is always a batchable one (the type has no other).
        guard !ids.isEmpty, !isAnswering, allowsDecisions, answer.isBatchable, let session else { return nil }
        isAnswering = true
        defer { isAnswering = false }
        let generation = session.generation
        let result = await session.stores.answerMany(ids, answer)
        guard session.generation == generation else { return nil }
        await queue.refresh(background: true)
        let pending = Set(rows.map(\.id))
        let outcome = BulkOutcome(verb: verb, answer: answer, asked: ids, result: result, stillPending: pending)
        // Later settled nothing, so a Later that went through leaves no receipt
        // (components-01 §2.5); anything short of that is the band.
        self.outcome = verb == .later && outcome.isComplete ? nil : outcome
        if case .success = result, verb == .decline { declineReason = "" }
        // What was answered left the queue, so the selection keeps exactly what
        // is still pending — the rows Retry acts on, and any past the page — and
        // when nothing is, the row that took their place is selected.
        reconcile()
        announce(outcome.presentation().spoken)
        await onQueueChanged?()
        return outcome
    }

    /// What the Item menu may do from here. A selection offers only its verbs
    /// that have a key — Later and Decline — and never Approve or Revise; one
    /// request offers whatever its detail answers with (`row`, T5-4b).
    public func itemActions(row: (RequestRow) -> ShellActionTable = { _ in [:] }) -> ShellActionTable {
        if isBulk {
            guard allowsDecisions, !isAnswering else { return [:] }
            var table: ShellActionTable = [:]
            for verb in BulkVerb.allCases {
                guard let command = verb.command else { continue }
                table[command] = { [weak self] in
                    Task { await self?.answerSelection(verb) }
                }
            }
            return table
        }
        return selectedRow.map(row) ?? [:]
    }

    // MARK: One request (T5-4b)

    /// One card per request (`RequestCards`), so the detail and the Item menu
    /// act on the same one and a draft survives the list refreshing around
    /// it. Rebuilt for another instance or another name; nil with no session.
    public func cards(assistantName: String) -> RequestCards? {
        guard let session else { return nil }
        if let held = requestCards, held.name == assistantName, held.generation == session.generation {
            held.cards.keep(only: Set(rows.map(\.id)))
            return held.cards
        }
        let cards = RequestCards(store: session.stores, assistantName: assistantName)
        requestCards = (assistantName, session.generation, cards)
        return cards
    }

    /// The owner's day, for the dates a card's body prints.
    public var today: TaskDay {
        let d = calendar.dateComponents([.year, .month, .day], from: now())
        return TaskDay(String(format: "%04d-%02d-%02d", d.year ?? 1970, d.month ?? 1, d.day ?? 1))!
    }

    // MARK: Paint

    /// Nothing waits: the queue said so, or — before it has — the count did.
    public func isEmpty(waiting: Int?) -> Bool {
        queue.section.hasValue ? rows.isEmpty : waiting == 0
    }

    /// When the list on screen is from, if the band should say so.
    public var staleSince: Date? {
        guard queue.section.hasValue else { return nil }
        if case .stale = queue.section.state { return queue.section.asOf }
        guard let asOf = queue.section.asOf, now().timeIntervalSince(asOf) > Self.ageLimit else { return nil }
        return asOf
    }

    func reset() {
        typeFilter = nil
        fromFilter = nil
        selection = []
        declineReason = ""
        outcome = nil
        isAnswering = false
        didFirstSelect = false
        anchor = nil
        requestCards = nil
    }
}

// MARK: - The view

public struct NeedsYouView<Detail: View>: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable private var model: NeedsYouModel
    private let waiting: Int?
    private let assistantName: String?
    private let onGoToToday: () -> Void
    private let rowActions: (RequestRow) -> ShellActionTable
    private let detail: (RequestRow) -> Detail
    @State private var waitedLong = false

    /// - Parameters:
    ///   - waiting: the shell's count, until the queue itself has answered.
    ///   - rowActions: what the Item menu does for one selected request.
    ///   - detail: one selected request, drawn at reading width.
    public init(
        model: NeedsYouModel,
        waiting: Int?,
        assistantName: String?,
        onGoToToday: @escaping () -> Void,
        rowActions: @escaping (RequestRow) -> ShellActionTable = { _ in [:] },
        @ViewBuilder detail: @escaping (RequestRow) -> Detail
    ) {
        self.model = model
        self.waiting = waiting
        self.assistantName = assistantName
        self.onGoToToday = onGoToToday
        self.rowActions = rowActions
        self.detail = detail
    }

    public var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: 0) {
            if model.isEmpty(waiting: waiting) {
                // Answering the last one leaves its band above *Nothing needs you*.
                band
                NeedsYouNothingWaiting(onGoToToday: onGoToToday)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                NeedsYouHeader(model: model, waiting: waiting, assistantName: assistantName)
                Divider()
                // Above the list it reports on (§3.1).
                band
                if let since = model.staleSince {
                    StaleBand(StaleBandModel("Showing requests", asOf: since, action: StateWords.tryAgain), now: model.now()) {
                        Task { await model.refresh() }
                    }
                }
                HStack(spacing: 0) {
                    list
                        .frame(minWidth: 260, idealWidth: 340, maxWidth: 420, maxHeight: .infinity)
                        .accessibilityElement(children: .contain)
                        .accessibilityLabel(Text(verbatim: "Requests"))
                    Divider()
                    detailColumn
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                        .accessibilityElement(children: .contain)
                        .accessibilityLabel(Text(verbatim: model.isBulk ? "Selection" : "Request"))
                }
            }
        }
        .background(p[.surface])
        .shellItemActions(model.itemActions(row: rowActions))
        .task {
            // The list's own tick. Until T5-7's stream lands, this is how an
            // answer made elsewhere leaves the list.
            while !Task.isCancelled {
                await model.refreshIfDue()
                try? await Task.sleep(for: .seconds(5))
            }
        }
        .task(id: model.queue.section.isFirstLoad) {
            waitedLong = false
            guard model.queue.section.isFirstLoad else { return }
            try? await Task.sleep(for: .seconds(FirstPaint.patience))
            waitedLong = true
        }
    }

    @ViewBuilder
    private var band: some View {
        if let outcome = model.outcome {
            NeedsYouOutcomeBand(outcome: outcome, disabledBecause: model.allowsDecisions ? nil : model.decisionsUnavailableReason) {
                Task { await model.retry() }
            } onDismiss: {
                model.dismissOutcome()
            }
        }
    }

    @ViewBuilder
    private var list: some View {
        let section = model.queue.section
        if section.isFirstLoad {
            PlaceholderRows(count: 4, waitingFor: waitedLong ? "Reading what needs you" : nil)
                .padding(MetistrySpace.s4)
                .frame(maxHeight: .infinity, alignment: .top)
        } else if !section.hasValue, case .failed(let why) = section.state {
            StatePanel(
                StatePanelModel(.failed, title: "Couldn't Read Requests", sentence: "The console didn't answer with the queue.", reason: why, action: StateWords.tryAgain),
                onAction: { Task { await model.refresh() } }
            )
        } else {
            List(selection: $model.selection) {
                ForEach(model.groups(assistantName: assistantName)) { group in
                    SwiftUI.Section {
                        ForEach(group.rows) { row in
                            NeedsYouRowView(row.presentation())
                                .tag(row.id)
                        }
                    } header: {
                        Text(verbatim: group.title)
                            .metistryFont(.caption2, weight: .semibold)
                            .textCase(.uppercase)
                            .accessibilityAddTraits(.isHeader)
                    }
                }
            }
            .listStyle(.inset)
            // The rows' inks are checked against `surface`; the list paints it.
            .scrollContentBackground(.hidden)
            .background(Palette(scheme)[.surface])
            .shellListFocus()
            #if os(macOS)
            // Esc clears a selection before anything else (screen 3 §5).
            .onExitCommand { if model.isBulk { model.clearSelection() } }
            #endif
        }
    }

    @ViewBuilder
    private var detailColumn: some View {
        if model.isBulk {
            ScrollView {
                NeedsYouBulkPanel(model: model)
                    .padding(MetistrySpace.s5)
            }
        } else if let row = model.selectedRow {
            detail(row)
        } else {
            StatePanel(StatePanelModel(.empty, title: "No Request Selected", sentence: "Choose one to read it, or several to answer them together."))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

// MARK: - Nothing waiting

/// Screen 3 §2 and §13.1: *Nothing needs you*, why, and the way back to Today.
/// No chips, no count — an empty queue does not need a filter. Not a
/// `StatePanel`: the shell's test reads these words as text, not a heading, and
/// a `StatePanel` here trips the accessibility probe's sidebar reading (the
/// outline's own selection stays right — see the T5-4a PR).
struct NeedsYouNothingWaiting: View {
    @Environment(\.colorScheme) private var scheme
    let onGoToToday: () -> Void

    var body: some View {
        let p = Palette(scheme)
        VStack(spacing: MetistrySpace.s2) {
            Image(systemName: MetistryGlyph.empty.rawValue)
                .metistryFont(.title1)
                .foregroundStyle(p[.textTertiary])
                .accessibilityHidden(true)
            Text(verbatim: "Nothing needs you")
                .metistryFont(.headline)
                .foregroundStyle(p[.textPrimary])
            Text(verbatim: "Agents are working and nothing is waiting on a decision.")
                .metistryFont(.subhead)
                .foregroundStyle(p[.textSecondary])
                .multilineTextAlignment(.center)
            ControlButton(ControlSpec("Back to Today", role: .secondary), action: onGoToToday)
                .padding(.top, MetistrySpace.s1)
        }
        .padding(MetistrySpace.s6)
    }
}

// MARK: - The header: the count and the filters

struct NeedsYouHeader: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: NeedsYouModel
    let waiting: Int?
    let assistantName: String?

    var body: some View {
        let p = Palette(scheme)
        let chips = model.typeChips
        let options = model.fromOptions(assistantName: assistantName)
        VStack(alignment: .leading, spacing: MetistrySpace.s3) {
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s3) {
                Text(verbatim: "Needs You")
                    .metistryFont(.title1, weight: .semibold)
                    .foregroundStyle(p[.textPrimary])
                    .accessibilityAddTraits(.isHeader)
                Text(verbatim: "\(waiting ?? model.rows.count) waiting")
                    .metistryFont(.subhead)
                    .foregroundStyle(p[.textSecondary])
            }
            // The filters show what is present, so they wait for the queue.
            if model.queue.section.hasValue {
                filters(p, chips: chips, options: options)
            }
        }
        .padding(.horizontal, MetistrySpace.s5)
        .padding(.vertical, MetistrySpace.s3)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func filters(_ p: Palette, chips: [NeedsYouTypeChip], options: [NeedsYouFromOption]) -> some View {
        FlowLayout(spacing: MetistrySpace.s2, lineSpacing: MetistrySpace.s2) {
            ForEach(chips) { chip in
                Button {
                    model.filter(type: chip.type)
                } label: {
                    // One run of text, so it wraps as one and never truncates a word.
                    Text(verbatim: "\(chip.label) ") + Text(verbatim: String(chip.count)).foregroundStyle(p[.textSecondary])
                }
                .buttonStyle(NeedsYouChipStyle(selected: model.typeFilter == chip.type))
                .focusEffectDisabled()
                .accessibilityLabel(Text(verbatim: "\(chip.label), \(chip.count)"))
                .accessibilityAddTraits(model.typeFilter == chip.type ? .isSelected : [])
            }
        }
        FlowLayout(spacing: MetistrySpace.s3, lineSpacing: MetistrySpace.s2) {
            Picker(selection: Binding(get: { model.fromFilter }, set: { model.filter(from: $0) })) {
                ForEach(options) { option in
                    Text(verbatim: "\(option.label) · \(option.count)").tag(option.from)
                }
            } label: {
                Text(verbatim: "From")
            }
            .pickerStyle(.menu)
            .fixedSize()
            ControlButton(ControlSpec("Select All on This Page", role: .plain)) { model.selectAllOnPage() }
        }
    }
}

/// A filter chip: `accent` on `accent-quiet` when chosen, outlined in
/// `border-control` when not, and the focus ring under Full Keyboard Access.
struct NeedsYouChipStyle: ButtonStyle {
    let selected: Bool

    func makeBody(configuration: Configuration) -> some View {
        Chip(configuration: configuration, selected: selected)
    }

    struct Chip: View {
        @Environment(\.colorScheme) private var scheme
        @Environment(\.isFocused) private var focused
        let configuration: ButtonStyle.Configuration
        let selected: Bool

        var body: some View {
            let p = Palette(scheme)
            configuration.label
                .metistryFont(.callout, weight: .medium)
                .foregroundStyle(p[selected ? .accent : .textSecondary])
                .padding(.horizontal, MetistrySpace.s3)
                .padding(.vertical, 3)
                .background(selected ? p[.accentQuiet] : .clear, in: Capsule())
                .overlay(Capsule().strokeBorder(selected ? .clear : p[.borderControl], lineWidth: 1))
                .overlay(Capsule().inset(by: -3).strokeBorder(focused ? p[.focusRing] : .clear, lineWidth: 2))
                .contentShape(Capsule())
        }
    }
}

// MARK: - A row

struct NeedsYouRowView: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dynamicTypeSize) private var size
    /// A selected row in a focused list sits on the selection highlight: its
    /// words take the system's own emphasised inks there, which clear that
    /// ground whatever colour the owner's system gives it.
    @Environment(\.backgroundProminence) private var prominence
    let row: NeedsYouRowModel.Presentation

    init(_ row: NeedsYouRowModel.Presentation) {
        self.row = row
    }

    var body: some View {
        let p = Palette(scheme)
        HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
            // One column wide for every type's glyph, so the words line up, and
            // grown with the text like everything else.
            Image(systemName: row.symbol)
                .metistryFont(.subhead)
                .foregroundStyle(ink(.textSecondary, p))
                .frame(width: MetistryType.pointSize(.subhead, size) * 1.7)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                    words(row.word, p)
                    Spacer(minLength: MetistrySpace.s1)
                    words(row.age, p)
                }
                if row.title.glyph == nil {
                    words(row.title, p)
                } else {
                    MarkView(row.title)
                }
                if !row.chips.isEmpty {
                    FlowLayout(spacing: MetistrySpace.s1, lineSpacing: 2) {
                        ForEach(Array(row.chips.enumerated()), id: \.offset) { MarkView($0.element) }
                    }
                }
            }
        }
        .padding(.vertical, MetistrySpace.s1)
        // One element, spoken as a sentence (components-01 §2.8).
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: row.spoken))
    }

    private func words(_ mark: Mark, _ p: Palette) -> some View {
        Text(verbatim: mark.text)
            .textCase(mark.uppercase ? .uppercase : nil)
            .metistryFont(mark.style, design: mark.design, weight: mark.weight)
            .foregroundStyle(ink(mark.ink, p))
            .fixedSize(horizontal: false, vertical: true)
    }

    private func ink(_ role: MetistryColorRole, _ p: Palette) -> AnyShapeStyle {
        guard prominence == .increased else { return AnyShapeStyle(p[role]) }
        return role == .textPrimary ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary)
    }
}

// MARK: - The selection's verbs

struct NeedsYouBulkPanel: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: NeedsYouModel

    var body: some View {
        let p = Palette(scheme)
        let count = model.bulkIDs.count
        VStack(alignment: .leading, spacing: MetistrySpace.s3) {
            Text(verbatim: "\(count) Selected")
                .metistryFont(.title2, weight: .semibold)
                .foregroundStyle(p[.textPrimary])
                .accessibilityAddTraits(.isHeader)
            Text(verbatim: "Later, Skip and Decline apply to each one. Approve and Revise stay one at a time — each does something of its own.")
                .metistryFont(.subhead)
                .foregroundStyle(p[.textSecondary])
                .fixedSize(horizontal: false, vertical: true)
            TextField("Reason for Decline", text: $model.declineReason, prompt: Text(verbatim: "A reason for Decline, sent with each (optional)"))
                .metistryFont(.body)
                .textFieldStyle(.roundedBorder)
                .labelsHidden()
                .accessibilityLabel(Text(verbatim: "Reason for Decline"))
            FlowLayout(spacing: MetistrySpace.s2, lineSpacing: MetistrySpace.s2) {
                ForEach(Array(zip(BulkVerb.allCases, model.bulkControls)), id: \.0) { verb, control in
                    ControlButton(control) { Task { await model.answerSelection(verb) } }
                        .disabled(model.isAnswering)
                }
            }
            if let why = model.allowsDecisions ? nil : model.decisionsUnavailableReason {
                FactNote(FactNoteModel(why))
            }
            ControlButton(ControlSpec("Clear Selection", role: .plain, shortcut: "Escape")) { model.clearSelection() }
        }
        .frame(maxWidth: 560, alignment: .leading)
    }
}

// MARK: - The band

struct NeedsYouOutcomeBand: View {
    @Environment(\.colorScheme) private var scheme
    let outcome: BulkOutcome
    let disabledBecause: String?
    let onRetry: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        let p = Palette(scheme)
        let view = outcome.presentation(on: .elevated, disabledBecause: disabledBecause)
        HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s3) {
            VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                MarkView(view.headline).accessibilityAddTraits(.isHeader)
                ForEach(Array(view.lines.enumerated()), id: \.offset) { MarkView($0.element) }
                if let why = disabledBecause, !outcome.retryable.isEmpty {
                    FactNote(FactNoteModel(why), on: .elevated)
                }
            }
            Spacer(minLength: 0)
            ForEach(Array(view.controls.enumerated()), id: \.offset) { item in
                ControlButton(item.element) {
                    item.element.label == "Dismiss" ? onDismiss() : onRetry()
                }
            }
        }
        .padding(.horizontal, MetistrySpace.s4)
        .padding(.vertical, MetistrySpace.s3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(p[.elevated])
        .overlay(alignment: .bottom) { Rectangle().fill(p[.border]).frame(height: 1) }
        .accessibilityElement(children: .contain)
    }
}

// MARK: - One request, until its body is drawn

/// The selected request's header and what it asks. Its body and its answers
/// are T5-4b's; until they land here, the detail says so and offers the web
/// app — a labelled *not yet*, never an empty pane (mac-app.md).
public struct NeedsYouRequestSummary: View {
    @Environment(\.colorScheme) private var scheme
    let row: NeedsYouRowModel
    let consoleURL: URL?

    public init(_ row: RequestRow, assistantName: String?, consoleURL: URL?, now: Date = Date(), calendar: Calendar = .current) {
        self.row = NeedsYouRowModel(row, assistantName: assistantName, now: now, calendar: calendar)
        self.consoleURL = consoleURL
    }

    public var body: some View {
        let p = Palette(scheme)
        let view = row.presentation(on: .surface)
        ScrollView {
            VStack(alignment: .leading, spacing: MetistrySpace.s3) {
                FlowLayout(spacing: MetistrySpace.s2) {
                    Image(systemName: view.symbol).metistryFont(.subhead).foregroundStyle(p[.textSecondary]).accessibilityHidden(true)
                    MarkView(view.word)
                    ForEach(Array(view.chips.enumerated()), id: \.offset) { MarkView($0.element) }
                    MarkView(view.age)
                }
                if let title = row.title {
                    Text(verbatim: title)
                        .metistryFont(.title2, weight: .semibold)
                        .foregroundStyle(p[.textPrimary])
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                } else {
                    MarkView(view.title)
                }
                Text(verbatim: "This request's body and answers aren't in the Mac app yet — the web app has them.")
                    .metistryFont(.subhead)
                    .foregroundStyle(p[.textSecondary])
                    .fixedSize(horizontal: false, vertical: true)
                if let consoleURL {
                    Link(destination: consoleURL) { Text(verbatim: "Open in Browser") }
                }
            }
            .padding(MetistrySpace.s5)
            .frame(maxWidth: 640, alignment: .leading)
        }
    }
}

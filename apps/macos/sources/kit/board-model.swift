// Work ▸ Board's model (design-build-plan T6-7; screen-06-board.md, the
// latest section winning; docs/ops/board.md "Drags, and Move to…").
//
// What the Board knows and asks for, kept apart from the drawing in
// board-view.swift so a test can hold the board without a window: the five
// columns as `GET /api/q/board` decides them, the column totals and the
// project filter from `GET /api/q/board_projects`, Has Thread, and the moves.
//
// THE BOARD OFFERS NO DROP THE SERVICE WOULD REFUSE. `BoardRules` reads each
// card's row against the statements in `packages/tasks` — the same rule, in
// the same words, as the PWA's `movesFor()` (apps/console/web/work.js) — and
// gives every other column either the ONE route that lands the card there or
// the reason none does. A drag draws a target only on the first kind; Move…
// lists the second kind disabled, with its reason. When the two still
// disagree (a claim that raced in, a dependency still open) the STATEMENT
// wins: the card goes back where it was and the server's own sentence is
// shown, never one this file invented.
//
// OPTIMISTIC, THEN AUTHORITATIVE. The card moves at once, the route runs, and
// the board is asked again either way — the server owns the columns.

import Foundation
import Observation

// MARK: - The rules

/// One route. Anything that needs two calls is not a move (screen 6 §4).
public enum BoardOp: String, Sendable, Equatable, CaseIterable {
    /// `PATCH /api/tasks/:id {owner}` — the one drop that needs a value.
    case assign
    /// `PATCH /api/tasks/:id {owner: null}`.
    case unassign
    /// `POST /api/tasks/:id/claim` — as the owner, never onto another's lease.
    case claim
    /// `POST /api/tasks/:id/release` — the holder's.
    case release
    /// `PATCH /api/tasks/:id {status: "open"}` — from Blocked only.
    case unblock
    /// `PATCH /api/tasks/:id {status: "closed"}` — the holder's.
    case close
}

/// One row of Move…: a column, and either what the move does or why the
/// service would refuse it.
public struct BoardMove: Sendable, Equatable, Identifiable {
    public let column: String
    public let label: String
    /// Set where the service would accept the move.
    public let op: BoardOp?
    /// What the move does, in words — set with `op`.
    public let what: String?
    /// Why the service would refuse it, in its words — set without `op`.
    public let why: String?

    public var id: String { column }
    public var isOffered: Bool { op != nil }

    /// Read with the row, never a tooltip: *Done, dimmed. Only the one holding
    /// a card closes it — claim it first*.
    public var spoken: String {
        if let what { return "\(label), \(what)" }
        return "\(label), dimmed. \(why ?? "")"
    }
}

/// The statements of `packages/tasks`, read off a row. Pure, so the rule a
/// drag follows and the rule a test checks are one rule.
public enum BoardRules {
    /// The one principal the console's task routes act as (task-routes.ts
    /// `USER`): a claim the owner makes is `claimed_by = "user"`, and a card
    /// addressed to the owner has `owner = "user"`.
    public static let owner = "user"

    /// Where a released or unblocked card LANDS — not the board's choice.
    /// `release()` and the unblock both clear the claim and set `open`, so the
    /// query's `CASE` puts it in Assigned or Backlog by whether `owner` is set.
    public static func home(_ card: BoardCard) -> String {
        card.owner == nil ? "backlog" : "assigned"
    }

    /// Who holds the card, or nil. An empty `claimed_by` is nobody.
    public static func holder(_ card: BoardCard) -> String? {
        guard let h = card.claimedBy, !h.isEmpty else { return nil }
        return h
    }

    static func whose(_ name: String) -> String {
        name == owner ? "your" : "\(name)'s"
    }

    /// Every move for ONE card: each column but its own, in board order.
    ///
    /// - claim takes an unclaimed card that is open, as the owner — nobody
    ///   moves a card onto another's lease;
    /// - release, close and "blocked" are the HOLDER's (the holder arm's WHERE
    ///   is `claimed_by = $agent`): the owner closes or releases only a card
    ///   they hold;
    /// - assign, unassign and the unblock are the board arm: no claim needed,
    ///   any card that is not closed — the unblock from Blocked only;
    /// - a released or unblocked card lands in its home column, never the other;
    /// - a closed card takes nothing.
    public static func moves(for card: BoardCard) -> [BoardMove] {
        let column = card.column
        let others = Board.columnOrder.filter { $0 != column }
        if card.status == "closed" || column == "done" {
            return others.map { BoardMove(column: $0, label: Board.label(for: $0), op: nil, what: nil, why: "it is closed — a closed card takes no more changes; make a follow-up instead") }
        }
        let holder = holder(card)
        let mine = holder == owner
        let home = home(card)
        let lands = card.owner.map { "it has \(whose($0)) name on it, so it goes back to Assigned" } ?? "nobody's name is on it, so it goes back to Backlog"
        let blockedWhy = "a card is marked blocked from its work, never moved there"
        let closeWhy = holder.map { "\($0) holds it — only the one holding a card closes it" } ?? "only the one holding a card closes it — claim it first"
        func closeMove() -> (BoardOp?, String?, String?) { mine ? (.close, "closes it", nil) : (nil, nil, closeWhy) }

        func move(_ k: String) -> (BoardOp?, String?, String?) {
            switch column {
            case "backlog", "assigned":
                switch k {
                case "assigned": return (.assign, "pick who it is for", nil)
                case "backlog": return (.unassign, "clears \(whose(card.owner ?? owner)) name", nil)
                case "in_progress": return (.claim, "you claim it", nil)
                case "blocked": return (nil, nil, blockedWhy)
                default: return (nil, nil, "only the one holding a card closes it — claim it first")
                }
            case "in_progress":
                if k == "blocked" { return (nil, nil, blockedWhy) }
                if k == "done" { return closeMove() }
                guard mine else {
                    return (nil, nil, holder.map { "\($0) holds it — only the holder hands a card back" } ?? "nobody holds it, so there is no claim to hand back")
                }
                if k == home { return (.release, "hands it back — releases your claim", nil) }
                return (nil, nil, "released, \(lands)")
            default: // blocked
                if k == "in_progress" { return (nil, nil, "nothing claims a blocked card — unblock it first") }
                if k == "done" { return closeMove() }
                if k == home {
                    if let holder, !mine { return (.unblock, "unblocks it — releases \(holder)'s claim", nil) }
                    return (.unblock, "unblocks it", nil)
                }
                return (nil, nil, "unblocked, \(lands)")
            }
        }

        return others.map { k in
            let (op, what, why) = move(k)
            return BoardMove(column: k, label: op == .assign ? "Assigned to…" : Board.label(for: k), op: op, what: what, why: why)
        }
    }

    /// The columns a drag may drop on, and the route each one runs — what the
    /// drag draws as a target, and nothing else.
    public static func drops(for card: BoardCard) -> [String: BoardOp] {
        Dictionary(uniqueKeysWithValues: moves(for: card).compactMap { m in m.op.map { (m.column, $0) } })
    }

    /// Whether the card can be picked up at all. A closed card gets no grab.
    public static func isMovable(_ card: BoardCard) -> Bool { !drops(for: card).isEmpty }

    /// Where a move lands: the target, except that release and the unblock
    /// land in the card's home, whatever was aimed at.
    public static func landsIn(_ op: BoardOp, _ card: BoardCard, target: String) -> String {
        switch op {
        case .release, .unblock: return home(card)
        case .assign: return "assigned"
        case .unassign: return "backlog"
        case .claim: return "in_progress"
        case .close: return "done"
        }
    }

    /// The server DECIDES `escalated`; this only names it, from fields already
    /// on the row, so a chip says why (board.md "`escalated`").
    public static func escalationLabel(_ card: BoardCard, now: Date) -> String {
        if let until = WireTime.date(card.leaseExpiresAt), until <= now { return "Lease Lapsed" }
        if card.status == "blocked" { return card.blockedByTaskOpen == true ? "Waiting on You" : "Blocked" }
        return "Overdue"
    }
}

// MARK: - A card's facet (screen 6 §2)

/// What one card shows: its column's facet, then whatever is exceptional.
/// Everything else is a mark, not a chip.
public struct BoardCardFacets: Sendable, Equatable {
    public enum Tone: Sendable, Equatable { case quiet, agent, degraded, report }

    public struct Chip: Sendable, Equatable {
        public let text: String
        public let tone: Tone
        public let spoken: String
    }

    /// The one column-specific facet.
    public let facet: Chip?
    /// Exceptional: an escalation the column's own facet does not already say.
    public let exception: Chip?
    /// The room's message count, when the card has a room.
    public let threadCount: Int?
    /// Promoted from a note in the vault (`external_ref` beginning `vault:`).
    public let fromNote: Bool

    public init(_ card: BoardCard, now: Date, assistantName: String?) {
        let holder = BoardRules.holder(card)
        switch card.column {
        case "backlog":
            let age = Self.age(hours: card.ageHours ?? 0)
            facet = Chip(text: "\(age) in backlog", tone: .quiet, spoken: "\(age) in backlog")
        case "assigned":
            if let who = card.owner {
                let name = Self.name(who, assistantName: assistantName)
                facet = Chip(text: who == BoardRules.owner ? "for you" : name, tone: who == BoardRules.owner ? .quiet : .agent, spoken: who == BoardRules.owner ? "for you" : "for \(name)")
            } else {
                facet = nil
            }
        case "in_progress":
            let lease = Self.lease(card, now: now)
            let who = holder.map { $0 == BoardRules.owner ? "held by you" : "held by \(Self.name($0, assistantName: assistantName))" }
            let text = [who, lease?.text].compactMap { $0 }.joined(separator: " · ")
            facet = text.isEmpty ? nil : Chip(text: text, tone: lease?.lapsed == true ? .degraded : .quiet, spoken: text)
        case "blocked":
            facet = Self.blockedReason(card)
        case "done":
            let closed = WireTime.date(card.updatedAt).map { "closed \(ClockTime.age(now.timeIntervalSince($0)))" } ?? "closed"
            facet = Chip(text: closed, tone: .quiet, spoken: closed)
        default:
            facet = nil
        }
        // The column's facet already says a lapse (In Progress) and a block
        // (Blocked); what is left to say is Overdue.
        if card.escalated, card.column != "blocked", card.column != "done" {
            let label = BoardRules.escalationLabel(card, now: now)
            exception = (card.column == "in_progress" && label == "Lease Lapsed") ? nil : Chip(text: label, tone: .degraded, spoken: label)
        } else if card.column == "done", card.reported {
            let when = WireTime.date(card.lastReportAt).map { " \(ClockTime.age(now.timeIntervalSince($0)))" } ?? ""
            exception = Chip(text: "Reported", tone: .report, spoken: "reported\(when)")
        } else {
            exception = nil
        }
        threadCount = card.hasThread ? card.threadCount : nil
        fromNote = card.externalRef?.hasPrefix("vault:") == true
    }

    /// The Blocked card's chip is the one-line reason — never the word
    /// *Blocked* again (screen 6, corrected 2026-09-23).
    static func blockedReason(_ card: BoardCard) -> Chip {
        if let task = card.blockedByTask {
            if card.blockedByTaskOpen == true {
                return Chip(text: "Waiting on you: \(task)", tone: .degraded, spoken: "waiting on you: \(task)")
            }
            return Chip(text: "Was waiting on: \(task) — done", tone: .quiet, spoken: "was waiting on \(task), which is done")
        }
        if let ref = card.blockedBy {
            return Chip(text: "Waiting on \(ref)", tone: .degraded, spoken: "waiting on \(ref)")
        }
        return Chip(text: "No reason on the card", tone: .quiet, spoken: "no reason on the card")
    }

    /// *2d* · *5h* · *12m* — the card's age.
    static func age(hours: Double) -> String {
        if hours < 1 { return "\(max(1, Int((hours * 60).rounded())))m" }
        if hours < 48 { return "\(Int(hours.rounded()))h" }
        return "\(Int((hours / 24).rounded()))d"
    }

    /// *4m left* · *1h 5m left* · *lease lapsed 12 minutes ago* — nil when no lease.
    static func lease(_ card: BoardCard, now: Date) -> (text: String, lapsed: Bool)? {
        guard let until = WireTime.date(card.leaseExpiresAt) else { return nil }
        if until <= now { return ("lease lapsed \(ClockTime.age(now.timeIntervalSince(until)))", true) }
        let minutes = max(1, Int((until.timeIntervalSince(now) / 60).rounded()))
        return (minutes < 60 ? "\(minutes)m left" : "\(minutes / 60)h \(minutes % 60)m left", false)
    }

    /// A principal as the app prints it: the assistant's principal is its
    /// configured name, the owner is *you*, anyone else their id.
    static func name(_ principal: String, assistantName: String?) -> String {
        if principal == BoardRules.owner { return "you" }
        if principal == AgentChipModel.assistantPrincipal { return assistantName ?? principal }
        return principal
    }

    /// The card, spoken as one row: *title, column, the facet, the exception,
    /// room with N messages, from a note*.
    public static func spoken(_ card: BoardCard, now: Date, assistantName: String?) -> String {
        let f = BoardCardFacets(card, now: now, assistantName: assistantName)
        var parts = [card.title, Board.label(for: card.column)]
        if let facet = f.facet { parts.append(facet.spoken) }
        if let e = f.exception { parts.append(e.spoken) }
        if let n = f.threadCount { parts.append("room with \(n) \(n == 1 ? "message" : "messages")") }
        if f.fromNote { parts.append("from a note") }
        return parts.joined(separator: ", ")
    }
}

// MARK: - The model

/// A move the service refused, or one that could not be sent: the card is
/// back where it was, and this says why — the server's sentence, verbatim.
public struct BoardRefusal: Sendable, Equatable {
    public let cardID: Int
    public let title: String
    public let op: BoardOp
    public let target: String
    public let assignee: String?
    public let message: String
    /// A refusal is the row's state saying no; *Try Again* is for a move that
    /// never reached the service.
    public let canRetry: Bool

    /// *Couldn't move "Freeze the store interface" — task 1 is held by …*
    public var sentence: String { "Couldn't move \u{201C}\(title)\u{201D} — \(message)" }
}

/// What the board's detail draws, in C135's order.
public enum BoardPanel: Sendable, Equatable {
    case placeholders(waitingFor: String?)
    case failed(String)
    case empty
    case board(staleSince: Date?)
}

@MainActor
@Observable
public final class BoardModel {
    /// Every 10 s while visible: `cache_ttl: 0`, because a board that lags
    /// lies about who holds a lease (screen 6 §3).
    public static let policy = RefreshPolicy(interval: 10)
    /// Past a minute unanswered — six polls — the band says when it is from.
    public static let ageLimit: TimeInterval = 60
    /// `board.yaml`'s default, per column — named so the header can say
    /// *showing N of M*.
    public static let limit = 50

    public private(set) var section = Section<Board>()
    public private(set) var counts = Section<BoardProjects>()
    /// Nil: all projects.
    public private(set) var project: String?
    /// Has Thread (C89): only cards with a room.
    public private(set) var hasThreadOnly = false
    /// Moves sent and not yet answered: card id → the column it was dropped on.
    public private(set) var inFlight: [Int: String] = [:]
    public private(set) var refusal: BoardRefusal?
    public private(set) var loadingSince: Date?
    public private(set) var consecutiveFailures = 0
    /// Who a card may be addressed to: the owner, then every agent that is not
    /// revoked (a HUMAN may address a card to any crew — collaboration rule 4).
    public private(set) var assignees: [String] = []
    /// The focused card.
    public var selection: Int?
    /// The card whose detail is open (C84: every click opens it).
    public var openCard: Int?
    /// The card whose Move… list is open.
    public var movingCard: Int?
    /// A drop on Assigned waits here for its name.
    public var assigningCard: Int?
    /// The open popover's reading of its card (screen 14).
    public private(set) var detail: CardDetailModel?
    /// The room open as a pane over the board, Board still selected (screen 16 §2).
    public private(set) var room: RoomModel?
    /// The card being dragged — what the columns check a drop against.
    public var dragging: Int?

    @ObservationIgnored public var now: @MainActor () -> Date
    @ObservationIgnored public let clock: ClockTime
    @ObservationIgnored weak var session: ConsoleSession?
    @ObservationIgnored private var question = 0
    @ObservationIgnored private var invalidated = false
    @ObservationIgnored private var askedAssignees = false

    public init(session: ConsoleSession, timeZone: TimeZone = .current, now: @escaping @MainActor () -> Date = { Date() }) {
        self.session = session
        self.now = now
        self.clock = ClockTime(timeZone: timeZone)
        session.register { [weak self] in
            guard let self else { return false }
            self.reset()
            return true
        }
        session.events.watch([.board]) { [weak self] _ in
            guard let self else { return false }
            self.invalidated = true
            return true
        }
    }

    // MARK: Reading

    /// The rows as the console last said, with every move in flight drawn
    /// where it was dropped (optimistic), and Has Thread applied.
    public var cards: [BoardCard] {
        let rows = section.value?.rows ?? []
        return rows.filter { !hasThreadOnly || $0.hasThread }
    }

    /// The column a card is drawn in: where it was dropped while its route is
    /// in flight, where the console says otherwise.
    public func drawnColumn(_ card: BoardCard) -> String {
        inFlight[card.id] ?? card.column
    }

    public var columns: [BoardColumnView] {
        let cards = self.cards
        return Board.columnOrder.map { key in
            let here = cards.filter { drawnColumn($0) == key }
            let total = counts.value?.total(column: key, project: project)
            return BoardColumnView(key: key, label: Board.label(for: key), cards: here, total: total?.cards, escalations: total?.escalations ?? here.filter(\.escalated).count, isFiltered: hasThreadOnly)
        }
    }

    public func card(_ id: Int?) -> BoardCard? {
        guard let id else { return nil }
        return section.value?.rows.first { $0.id == id }
    }

    /// The project filter's options: only projects that have cards.
    public var projects: [String] { counts.value?.projects ?? [] }

    public var panel: BoardPanel {
        switch FirstPaint.paint(section, loadingSince: loadingSince, ageLimit: Self.ageLimit, waitingFor: "Reading the board", now: now()) {
        case .placeholders(let waiting): return .placeholders(waitingFor: waiting)
        case .failed(let why): return .failed(why)
        case .content(let staleSince):
            if (section.value?.rows ?? []).isEmpty, !hasThreadOnly { return .empty }
            return .board(staleSince: staleSince)
        }
    }

    /// Moves are decisions: none while the console is not answering (O3).
    public var allowsMoves: Bool { section.allowsDecisions && section.hasValue }

    // MARK: Asking

    public func load() async {
        guard let session else { return }
        let asked = question
        let generation = session.generation
        let project = self.project
        invalidated = false
        if !section.hasValue { loadingSince = now() }
        section.beginLoading(background: section.hasValue)
        async let board = session.stores.board(project: project, limit: Self.limit)
        async let totals = session.stores.boardProjects(limit: nil)
        let (b, t) = await (board, totals)
        guard asked == question, session.generation == generation else { return }
        loadingSince = nil
        switch b {
        case .success(let value):
            section.loaded(value, asOf: WireTime.date(value.asOf), at: now())
            consecutiveFailures = 0
        case .failure(let error):
            section.failed(error)
            if case .unreachable = section.reachability { consecutiveFailures += 1 } else { consecutiveFailures = 0 }
        }
        switch t {
        case .success(let value): counts.loaded(value, asOf: WireTime.date(value.asOf), at: now())
        case .failure(let error): counts.failed(error)
        }
    }

    /// What the view's clock calls: asks when an event said so, or when the
    /// ten seconds are up.
    public func refreshIfDue() async {
        if !askedAssignees { await loadAssignees() }
        guard invalidated || Self.policy.isDue(lastAttemptAt: section.lastAttemptAt, consecutiveFailures: consecutiveFailures, now: now()) else { return }
        await load()
    }

    /// The owner picker's names, from `GET /api/agents` — asked once.
    public func loadAssignees() async {
        guard let session else { return }
        askedAssignees = true
        let generation = session.generation
        let answer = await session.stores.agents()
        guard session.generation == generation else { return }
        if case .success(let list) = answer {
            assignees = [BoardRules.owner] + list.agents.filter { !$0.revoked && $0.id != AgentChipModel.assistantPrincipal }.map(\.id)
        } else {
            assignees = [BoardRules.owner]
        }
    }

    // MARK: The card, and its room

    /// Every click on a card opens its detail (C84).
    public func open(_ card: BoardCard) {
        guard let session else { return }
        selection = card.id
        movingCard = nil
        detail = CardDetailModel(.work(card), session: session)
        openCard = card.id
    }

    public func closeDetail() {
        openCard = nil
        detail = nil
    }

    /// **Open Room →**: the thread as a pane over the board.
    public func openRoom(_ workID: Int) {
        guard let session else { return }
        closeDetail()
        room = RoomModel(workID: workID, session: session)
    }

    public func closeRoom() {
        room = nil
        invalidated = true
    }

    /// Item ▸ Move… (M): the focused card's list of every other column.
    public func showMoves(_ card: BoardCard) {
        selection = card.id
        closeDetail()
        movingCard = card.id
    }

    // MARK: The filter

    public func choose(project: String?) async {
        guard project != self.project else { return }
        self.project = project
        question += 1
        section = Section()
        await load()
    }

    public func setHasThreadOnly(_ on: Bool) {
        hasThreadOnly = on
    }

    // MARK: Moving

    /// Every move for a card, for Move… — offered or dimmed with the reason.
    /// None at all while the console is not answering: a decision is never
    /// queued (O3).
    public func moves(for card: BoardCard) -> [BoardMove] {
        guard allowsMoves else {
            return BoardRules.moves(for: card).map { BoardMove(column: $0.column, label: $0.label, op: nil, what: nil, why: StateWords.unreachable) }
        }
        return BoardRules.moves(for: card)
    }

    /// The columns a drag of this card may land on — and nothing else is drawn.
    public func dropTargets(for card: BoardCard) -> Set<String> {
        guard allowsMoves, inFlight[card.id] == nil else { return [] }
        return Set(BoardRules.drops(for: card).keys)
    }

    /// A drop, or a Move… row: exactly one route. Assigned needs a name first,
    /// so it waits in `assigningCard` until `assign(_:to:)`.
    @discardableResult
    public func drop(_ card: BoardCard, on column: String) async -> Bool {
        guard let op = BoardRules.drops(for: card)[column], dropTargets(for: card).contains(column) else { return false }
        if op == .assign {
            assigningCard = card.id
            return true
        }
        await run(op, card, target: column, assignee: nil)
        return true
    }

    /// The assign step's answer.
    public func assign(_ card: BoardCard, to assignee: String) async {
        assigningCard = nil
        guard BoardRules.drops(for: card)["assigned"] == .assign, dropTargets(for: card).contains("assigned") else { return }
        await run(.assign, card, target: "assigned", assignee: assignee)
    }

    /// The last refused move, sent again.
    public func retry() async {
        guard let r = refusal, let card = card(r.cardID) else { refusal = nil; return }
        refusal = nil
        await run(r.op, card, target: r.target, assignee: r.assignee)
    }

    public func dismissRefusal() { refusal = nil }

    private func run(_ op: BoardOp, _ card: BoardCard, target: String, assignee: String?) async {
        guard let session else { return }
        let generation = session.generation
        refusal = nil
        inFlight[card.id] = BoardRules.landsIn(op, card, target: target)
        let stores = session.stores
        let id = card.id
        let answer: Result<TaskMutation, ConsoleError>
        switch op {
        case .assign: answer = await stores.updateTask(id, .addressing(to: assignee ?? BoardRules.owner))
        case .unassign: answer = await stores.updateTask(id, .unassigning)
        case .claim: answer = await stores.claimTask(id, leaseSeconds: nil)
        case .release: answer = await stores.releaseTask(id, note: nil)
        case .unblock: answer = await stores.updateTask(id, .unblocking)
        case .close: answer = await stores.updateTask(id, .closing)
        }
        guard session.generation == generation else { return }
        if case .failure(let error) = answer {
            // The card goes back: the drawn column is the console's again.
            inFlight[id] = nil
            refusal = BoardRefusal(cardID: id, title: card.title, op: op, target: target, assignee: assignee, message: Self.sentence(error), canRetry: Self.isRetryable(error))
        }
        // Either way, the server owns the columns.
        await load()
        inFlight[id] = nil
    }

    /// The service's own sentence, verbatim — never one the interface wrote.
    public static func sentence(_ error: ConsoleError) -> String {
        if case .http(_, let envelope) = error, let message = envelope?.message, !message.isEmpty { return message }
        return error.localizedDescription
    }

    /// A 4xx is the row saying no; anything else never reached the service.
    static func isRetryable(_ error: ConsoleError) -> Bool {
        if case .http(let status, _) = error { return status >= 500 }
        return true
    }

    /// Drop everything. Called by the session on an instance switch.
    public func reset() {
        question += 1
        section = Section()
        counts = Section()
        project = nil
        hasThreadOnly = false
        inFlight = [:]
        refusal = nil
        loadingSince = nil
        consecutiveFailures = 0
        assignees = []
        askedAssignees = false
        selection = nil
        openCard = nil
        movingCard = nil
        assigningCard = nil
        detail = nil
        room = nil
        dragging = nil
        invalidated = false
    }
}

/// One column as the board draws it.
public struct BoardColumnView: Sendable, Equatable, Identifiable {
    public let key: String
    public let label: String
    public let cards: [BoardCard]
    /// Every card in the column, from `board_projects` — not the rendered ones.
    public let total: Int?
    public let escalations: Int
    /// Has Thread is on: the header says *showing N of M* whatever the cap.
    public let isFiltered: Bool

    public var id: String { key }

    /// *4* · *showing 50 of 212* · *showing 2 of 4*.
    public var countText: String {
        guard let total else { return "\(cards.count)" }
        return cards.count < total ? "showing \(cards.count) of \(total)" : "\(total)"
    }

    /// *In Progress, 4 cards, 1 wants you*.
    public var spoken: String {
        let n = total ?? cards.count
        var s = "\(label), \(countText == "\(n)" ? "\(n) \(n == 1 ? "card" : "cards")" : countText)"
        if escalations > 0 { s += ", \(escalations) \(escalations == 1 ? "wants" : "want") you" }
        return s
    }
}

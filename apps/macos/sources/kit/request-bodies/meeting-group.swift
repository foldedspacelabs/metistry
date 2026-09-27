// A meeting is one card (screen 3 §10.3; C81; §2.12): its notes and to-dos
// are separate requests that share one group id, and the card answers them
// together. Which rows are one meeting is the list's to say (`group_id` —
// not yet on `GET /api/proposals`); this file takes the parts it is given.
//
// ACCEPT ALL IS NOT A BATCH. `POST /api/proposals/batch` refuses Approve on
// purpose — each approval has its own consequence — so Accept All is one
// `allow` per part, IN ORDER, each waiting for the one before it and each
// with its own receipt. Decline All is one `deny` per part the same way.
//
// UNDO IS CLIENT-HELD (C136; §2.12: "Decline All = one `deny` per row after a
// 10 s client-held Undo"). There is no verb that takes an answer back, so the
// only honest Undo is one that sends nothing until the window closes: the
// card says what it is doing — *Declining all 5 parts* — with Undo for ten
// seconds, and only then do the answers go. Accept All is held the same way
// (T5-4b: "Accept All in order with a 10 s Undo"). Quitting inside the window
// sends nothing: the parts are still waiting, which is the safe side.
//
// PARTIAL SUCCESS IS THE NORMAL OUTCOME (screen 3 §3.1). A part answered on
// the phone meanwhile, one that moved while the card was open, one the
// console refused, one the gate held because the instance went away — each
// is its own statement, and the card says *4 of 5 accepted* and why, never
// "failed". Try Again sends again only what was never applied: a part
// someone else answered is settled, and one that moved must be read again.

import Foundation
import Observation

/// The parts of one meeting, in the order they are answered: oldest first.
public struct MeetingGroup: Sendable, Equatable, Identifiable {
    public let id: String
    public let parts: [RequestRow]

    public init(id: String, parts: [RequestRow]) {
        self.id = id
        self.parts = parts.sorted { ($0.ts, $0.id) < ($1.ts, $1.id) }
    }

    /// The meeting's name: what its parts say they came from, else the first part's ask.
    public func title(assistantName: String) -> String {
        for part in parts {
            if let name = part.payload?.string("meeting", "session_title") { return name }
        }
        return parts.first.map { RequestReading($0, assistantName: assistantName).ask } ?? "Meeting"
    }

    /// The parts a group verb reaches: those whose own answers store it.
    public func parts(taking decision: String) -> [RequestRow] {
        parts.filter { $0.isInQueue() && $0.shape.decisions.contains(decision) }
    }

    /// The to-dos block (§2.12: a meeting's body is its to-dos).
    public func todos(assistantName: String) -> [TodoItem] {
        parts.map { part in
            let facets = part.payload.flatMap { BodyReading.todo($0) }?.facets ?? TaskFacets()
            return TodoItem(RequestReading(part, assistantName: assistantName).ask, facets: facets)
        }
    }
}

/// What happened to one part.
public enum PartOutcome: Sendable, Equatable {
    case applied(RequestReceipt)
    /// Answered elsewhere first — settled, and not by this card.
    case alreadyAnswered(RequestReceipt)
    /// It moved while the card was open; nothing was sent for it.
    case stale
    /// The console's own words.
    case refused(String)
    /// O3: not sent — the instance was unreachable.
    case held

    public var isApplied: Bool {
        if case .applied = self { return true }
        return false
    }

    /// Worth sending again: nothing was applied and nothing else settled it.
    public var isRetryable: Bool {
        switch self {
        case .refused, .held: return true
        default: return false
        }
    }
}

public struct GroupOutcome: Sendable, Equatable {
    public let verb: GroupVerb
    /// Per part, in order.
    public let parts: [(id: Int, outcome: PartOutcome)]

    public static func == (a: GroupOutcome, b: GroupOutcome) -> Bool {
        a.verb == b.verb && a.parts.map(\.id) == b.parts.map(\.id) && a.parts.map(\.outcome) == b.parts.map(\.outcome)
    }

    public var applied: Int { parts.filter { $0.outcome.isApplied }.count }
    public var total: Int { parts.count }
    public var isPartial: Bool { applied < total }
    public var retryable: [Int] { parts.filter { $0.outcome.isRetryable }.map(\.id) }

    /// *4 of 5 accepted.* — or, when every part took, *5 accepted.*
    public var headline: String {
        isPartial ? "\(applied) of \(total) \(verb.past)." : "\(total) \(verb.past)."
    }

    /// Why the rest did not, one sentence per reason (screen 3 §3.1, §10.3).
    public var explanation: String? {
        func count(_ n: Int) -> String { n == 1 ? "One" : "\(n)" }
        func was(_ n: Int) -> String { n == 1 ? "was" : "were" }
        let already = parts.filter { if case .alreadyAnswered = $0.outcome { return true } else { return false } }.count
        let stale = parts.filter { $0.outcome == .stale }.count
        let held = parts.filter { $0.outcome == .held }.count
        let refused = parts.compactMap { p -> String? in if case .refused(let why) = p.outcome { return why } else { return nil } }
        var sentences: [String] = []
        if already > 0 { sentences.append("\(count(already)) \(was(already)) already answered elsewhere.") }
        if stale > 0 { sentences.append("\(count(stale)) changed while this was open, so nothing was sent for \(stale == 1 ? "it" : "them") — \(stale == 1 ? "it is" : "they are") shown as \(stale == 1 ? "it stands" : "they stand").") }
        if refused.count == 1 { sentences.append("One was refused: \(refused[0])" + (refused[0].hasSuffix(".") ? "" : ".")) }
        if refused.count > 1 { sentences.append("\(refused.count) were refused — each says why.") }
        if held > 0 { sentences.append("\(count(held)) \(held == 1 ? "wasn't" : "weren't") sent — \(StateWords.unreachable).") }
        guard !sentences.isEmpty else { return nil }
        return sentences.joined(separator: " ") + " Nothing was lost and nothing was re-sent."
    }
}

/// Accept All · Decline All.
public enum GroupVerb: String, Sendable, Equatable {
    case acceptAll, declineAll

    public var answer: RequestAnswer { self == .acceptAll ? .approve : .decline(nil) }
    public var decision: String { answer.wire }
    public var past: String { self == .acceptAll ? "accepted" : "declined" }
    public var doing: String { self == .acceptAll ? "Accepting" : "Declining" }
}

@MainActor
@Observable
public final class GroupAnswering {
    public enum Phase: Sendable, Equatable {
        case open
        /// Nothing sent yet; Undo is open.
        case holding(GroupVerb, UndoWindow)
        /// Sending, in order: `done` of `of`.
        case sending(GroupVerb, done: Int, of: Int)
        case done(GroupOutcome)
    }

    public private(set) var group: MeetingGroup
    public private(set) var phase: Phase = .open
    /// Every part's own receipt, as it lands (T8-7: "Accept All keeps every receipt").
    public private(set) var outcomes: [Int: PartOutcome] = [:]

    /// What each part's next answer claims to have seen: its row as rendered,
    /// or — after a `409 stale` — the row as it now stands.
    @ObservationIgnored private var seen: [Int: String] = [:]
    @ObservationIgnored private let store: any NeedsYouStore
    @ObservationIgnored private let assistantName: String
    @ObservationIgnored private let hold: @Sendable (TimeInterval) async throws -> Void
    @ObservationIgnored private var holding: Task<Void, Never>?

    /// `hold` waits out the Undo window; tests hand it a clock of their own.
    public init(_ group: MeetingGroup, store: any NeedsYouStore, assistantName: String, hold: @escaping @Sendable (TimeInterval) async throws -> Void = { try await Task.sleep(for: .seconds($0)) }) {
        self.group = group
        self.store = store
        self.assistantName = assistantName
        self.hold = hold
    }

    public var isBusy: Bool {
        switch phase {
        case .holding, .sending: return true
        default: return false
        }
    }

    /// The parts the verb would reach now: waiting, able to take it, and not already applied here.
    public func reach(_ verb: GroupVerb) -> [RequestRow] {
        group.parts(taking: verb.decision).filter { outcomes[$0.id]?.isApplied != true && !Self.settledElsewhere(outcomes[$0.id]) }
    }

    /// Press Accept All or Decline All: say what is happening, hold for ten seconds, then send.
    public func start(_ verb: GroupVerb, now: Date = Date()) {
        guard !isBusy else { return }
        let parts = reach(verb)
        guard !parts.isEmpty else { return }
        let noun = parts.count == 1 ? "part" : "parts"
        phase = .holding(verb, UndoWindow("\(verb.doing) all \(parts.count) \(noun)", actedAt: now))
        let ids = parts.map(\.id)
        // Held strongly on purpose: pressing Decline All and moving on to the
        // next request is not an Undo. Only Undo is.
        holding = Task { [self, hold] in
            do { try await hold(UndoWindow.seconds) } catch { return }
            guard !Task.isCancelled else { return }
            await self.send(verb, ids: ids)
        }
    }

    /// Undo, inside the window: nothing was sent, and nothing will be.
    public func undo() {
        guard case .holding = phase else { return }
        holding?.cancel()
        holding = nil
        phase = .open
    }

    /// Waits for a held verb to be sent (or undone) — for a caller that must know it landed.
    public func settled() async {
        await holding?.value
    }

    /// Try Again: only what was never applied and nothing else settled. No hold —
    /// the owner already waited out the window once for these.
    public func retry() async {
        guard case .done(let outcome) = phase, !outcome.retryable.isEmpty else { return }
        await send(outcome.verb, ids: outcome.retryable)
    }

    private func send(_ verb: GroupVerb, ids: [Int]) async {
        let parts = group.parts.filter { ids.contains($0.id) }
        var results: [(id: Int, outcome: PartOutcome)] = []
        phase = .sending(verb, done: 0, of: parts.count)
        for (i, part) in parts.enumerated() {
            // One at a time, in order: the next goes only once this one has answered.
            let result = await store.answer(part.id, verb.answer, seenAt: seen[part.id] ?? part.cursor ?? part.ts)
            let outcome = Self.outcome(result, verb: verb)
            if outcome == .stale, case .failure(let error) = result { repaint(part, from: error.details) }
            outcomes[part.id] = outcome
            results.append((part.id, outcome))
            phase = .sending(verb, done: i + 1, of: parts.count)
        }
        holding = nil
        phase = .done(GroupOutcome(verb: verb, parts: results))
    }

    /// A part that moved is shown as it now stands (components-01 §2.5), and
    /// the next answer to it claims that row — nothing is re-sent here.
    private func repaint(_ part: RequestRow, from details: [String: JSONValue]) {
        guard let proposal = details["proposal"],
              let data = try? JSONEncoder().encode(proposal),
              let fresh = try? JSONDecoder().decode(RequestRow.self, from: data),
              fresh.id == part.id
        else { return }
        let current = fresh.reading(part.shape)
        let patched = RequestRow(
            id: current.id, ts: current.ts, kind: current.kind, payload: current.payload, decision: current.decision,
            cursor: current.cursor, snoozedUntil: current.snoozedUntil, sourceAgent: current.sourceAgent, trust: current.trust,
            decidedAt: current.decidedAt, workID: current.workID, request: current.request, source: current.source ?? part.source
        )
        group = MeetingGroup(id: group.id, parts: group.parts.map { $0.id == part.id ? patched : $0 })
        seen[part.id] = proposal.string("changed_at") ?? fresh.ts
    }

    static func outcome(_ result: Result<RequestAnswerResult, ConsoleError>, verb: GroupVerb) -> PartOutcome {
        switch result {
        case .success:
            return .applied(RequestReceipt(verb == .acceptAll ? "Accepted" : "Declined", glyph: verb == .acceptAll ? .approve : .decline))
        case .failure(let error):
            if error.wasHeldForReachability { return .held }
            switch error.conflictReason {
            case "already_decided": return .alreadyAnswered(RequestAnswering.winner(error.details))
            case "stale": return .stale
            default: return .refused(error.refusal ?? error.localizedDescription)
            }
        }
    }

    static func settledElsewhere(_ outcome: PartOutcome?) -> Bool {
        if case .alreadyAnswered = outcome { return true }
        return false
    }
}

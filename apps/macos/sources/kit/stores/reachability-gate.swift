// O3, enforced at the tool (design-build-plan §3.3 T5-1; plan-refresh
// 2026-09-13 O3: "queue appends, never queue claims or answers — decision
// controls are disabled while unreachable").
//
// ONE GATE, IN FRONT OF EVERY ROUTE. `ReachabilityGate` is the transport every
// store method goes through (console-session.swift puts it between
// `ConsoleStores` and the session child), so O3 holds for all fourteen
// protocols without a guard in any of them — and a store method added
// tomorrow is gated the day it lands. It does two things and nothing else:
//
//   * **records** whether the console answered, from every answer — reported,
//     never inferred (P5). There is no timer here that decides a console is
//     down, and no ping: a read that fails says so, a read that succeeds says
//     so, and the newest request's answer is the one that counts;
//   * **refuses a decision before sending** while the last answer said the
//     console is unreachable, with the sentence the control under it prints
//     (components-01 §1.3). Nothing is queued: "a lease or a decision is a
//     statement about server state at delivery time" (docs/ops/client-api.md).
//
// WHAT IS A DECISION. `ConsoleAct` sorts a request by the one rule per verb in
// screen-18-pwa.md §4: a read is always sent (it is how a console that came
// back is noticed); an APPEND — capture, tick, defer (the table's `key` rows,
// "replayable from the offline outbox") and a 👍/👎 (O3's own examples) — is
// sent and may be kept by the composer that owns it (T5-5); everything else
// that changes something is a decision. The default is the strict one: a
// method and path this file does not name as an append is a decision.

import Foundation

/// What a request does, as O3 sorts it.
public enum ConsoleAct: Sendable, Equatable {
    /// A read. Always sent — a read is how reachability is re-established.
    case read
    /// A note to yourself, safe to resend with its key or by its own identity:
    /// capture, tick, defer and a rating. Never refused here.
    case append
    /// "Anything with a consequence for someone else, or that cannot be taken
    /// back, needs the server's answer before it happens" (screen-18-pwa.md
    /// §4): an answer, a claim, a move, a grant, Run Now, a message, a
    /// publish. Refused before sending while the console is unreachable.
    case decision

    /// The appends, by the client-API table's own route templates. `key` rows
    /// (`packages/core/src/client-api.ts`: `idempotent: "key"`) plus the two
    /// rating doors, which are `natural` — a replay sets the same rating.
    public static let appends: [String] = [
        "POST /capture",
        "POST /api/vault-tasks/:task_key/check",
        "POST /api/vault-tasks/:task_key/schedule",
        "POST /api/messages/:id/feedback",
        "DELETE /api/messages/:id/feedback",
        "POST /api/prose/:id/feedback",
        "DELETE /api/prose/:id/feedback",
    ]

    /// Sort one request. `path` is what goes on the wire, query included.
    public static func of(_ method: String, _ path: String) -> ConsoleAct {
        let verb = method.uppercased()
        if verb == "GET" || verb == "HEAD" { return .read }
        let concrete = String(path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
        let segments = concrete.split(separator: "/", omittingEmptySubsequences: false)
        for row in appends {
            let parts = row.split(separator: " ", maxSplits: 1)
            guard parts.count == 2, parts[0] == verb else { continue }
            let names = parts[1].split(separator: "/", omittingEmptySubsequences: false)
            guard names.count == segments.count else { continue }
            // a parameter matches any non-empty segment; a literal only itself
            if zip(names, segments).allSatisfy({ $0.hasPrefix(":") ? !$1.isEmpty : $0 == $1 }) { return .append }
        }
        return .decision
    }
}

/// Every store request passes through here: the answer is recorded as the
/// console's reachability, and a decision is refused before it is sent while
/// that reachability is `.unreachable`.
///
/// Main-actor bound so a view reads `reachability` directly and a refusal is
/// decided against exactly the state the view drew. The request itself runs
/// wherever the underlying transport runs; only the check and the record hop
/// to the main actor.
@MainActor
@Observable
public final class ReachabilityGate: ConsoleCallTransport {
    /// What the console last said about itself, connection-wide. `degraded` is
    /// never set here: a `503` or a `degraded` note is one section's fact
    /// (`Section.reachability` keeps it), and the console that said it answered.
    public private(set) var reachability: ConsoleReachability

    @ObservationIgnored private let base: any ConsoleCallTransport
    /// Requests handed to `base`, numbered in the order they were sent.
    @ObservationIgnored private var sent = 0
    /// The number of the request whose answer `reachability` came from.
    @ObservationIgnored private var recorded = 0

    /// `initially` is `.reachable` unless something already REPORTED otherwise
    /// — no runtime located, say. Before anything has been asked nothing has
    /// been said, and a gate that started closed would be an inference.
    public init(_ base: any ConsoleCallTransport, initially: ConsoleReachability = .reachable) {
        self.base = base
        self.reachability = initially
    }

    /// O3, for the control: false while the last answer said unreachable.
    public var allowsDecisions: Bool { reachability.allowsDecisions }

    public func call(_ method: String, _ path: String, body: Data?, idempotencyKey: String?) async -> Result<Data, ConsoleError> {
        if case .unreachable(let why) = reachability, ConsoleAct.of(method, path) == .decision {
            return .failure(Self.refusal(why))
        }
        sent += 1
        let ticket = sent
        let result = await base.call(method, path, body: body, idempotencyKey: idempotencyKey)
        record(result, ticket: ticket)
        return result
    }

    /// The newest request's answer is the one that counts: a request that
    /// timed out after 45 s must not mark a console unreachable that a later
    /// request has already heard from.
    private func record(_ result: Result<Data, ConsoleError>, ticket: Int) {
        guard ticket > recorded else { return }
        recorded = ticket
        switch result {
        case .success:
            reachability = .reachable
        case .failure(let error):
            if case .unreachable(let why) = ConsoleReachability.after(error) {
                reachability = .unreachable(why)
            } else {
                // A 4xx, a 503, a reply this app could not read: the console
                // answered. What it said is the caller's to show.
                reachability = .reachable
            }
        }
    }

    // MARK: - The refusal, in one sentence

    /// The line under a control O3 disabled — components-01 §1.3, word for word.
    nonisolated public static let decisionsNeedTheConnection = "the instance is unreachable — decisions are never queued"

    /// The error a decision gets instead of being sent. Its detail starts with
    /// `decisionsNeedTheConnection`, which is how `wasHeldForReachability`
    /// tells it apart from a request that was sent and failed.
    nonisolated public static func refusal(_ why: String) -> ConsoleError {
        .transport("\(decisionsNeedTheConnection) (nothing was sent): \(why)")
    }
}

public extension ConsoleError {
    /// True when O3 refused this request before it was sent — as opposed to a
    /// request that went out and did not come back. A view keeps the draft and
    /// the control's reason; it never offers "try again later" for it.
    var wasHeldForReachability: Bool {
        if case .transport(let detail) = self { return detail.hasPrefix(ReachabilityGate.decisionsNeedTheConnection) }
        return false
    }
}

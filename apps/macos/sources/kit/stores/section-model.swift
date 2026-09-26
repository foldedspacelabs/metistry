// One section of a screen, observable: the `Section` state machine
// (instance-store.swift — loading / loaded / failed / stale, P5 and P2), the
// store read that fills it, and when to ask again (T5-1).
//
// This is what a screen model is made of. `InstanceStore` hand-writes its
// Phase-A sections; a screen built on the §2.16 stores declares one of these
// per read instead of re-implementing the state machine:
//
//     let waiting = SectionModel(session: session, policy: .requests) { stores in
//         await stores.waitingCount().map { ($0, nil) }
//     }
//
// and gets, for nothing: a first load that is the only thing a spinner may
// draw from, a failed refresh that goes STALE and keeps what was on screen,
// the backoff that changes how often it asks and never what it claims,
// `invalidate()` for the live-changes stream to mark it due (§2.20, T5-7), and
// — because it is registered with its session — being dropped when the
// instance changes, including an answer that was in flight at the time.
//
// Decisions are not here: a screen calls the store method itself, and the
// session's gate refuses it before sending while unreachable (O3).

import Foundation
import Observation

@MainActor
@Observable
public final class SectionModel<Value: Sendable & Equatable> {
    public private(set) var section = Section<Value>()
    /// Consecutive unreachable answers, for `policy`'s backoff.
    public private(set) var consecutiveFailures = 0
    /// Something said this changed — an event, a write this screen made — so
    /// the next `refreshIfDue` asks whatever the clock says.
    public private(set) var isInvalidated = false
    public let policy: RefreshPolicy

    @ObservationIgnored private weak var session: ConsoleSession?
    @ObservationIgnored private let read: @Sendable (ConsoleStores) async -> Result<(Value, Date?), ConsoleError>
    @ObservationIgnored private let degraded: @Sendable (Value) -> String?

    /// `read` is one store call and its `as_of`. `degraded` reads a note the
    /// console put IN a successful answer (`writable: false`, a search's
    /// `degraded`), so it lands as a fact on a loaded section, not an error.
    public init(
        session: ConsoleSession,
        policy: RefreshPolicy,
        degraded: @escaping @Sendable (Value) -> String? = { _ in nil },
        read: @escaping @Sendable (ConsoleStores) async -> Result<(Value, Date?), ConsoleError>
    ) {
        self.session = session
        self.policy = policy
        self.read = read
        self.degraded = degraded
        session.register { [weak self] in
            guard let self else { return false }
            self.reset()
            return true
        }
    }

    /// Ask now. `background: true` over a value already on screen keeps the
    /// state `.loaded` and sets `isRefreshing` (P2).
    public func refresh(background: Bool = false) async {
        guard let session else { return }
        let generation = session.generation
        isInvalidated = false
        section.beginLoading(background: background)
        let answer = await read(session.stores)
        // The instance changed while this was being asked: the answer is the
        // other install's, and this section was already dropped for it.
        guard session.generation == generation else { return }
        switch answer {
        case .success(let (value, asOf)):
            if let note = degraded(value) {
                section.loadedDegraded(value, asOf: asOf, note: note)
            } else {
                section.loaded(value, asOf: asOf)
            }
            consecutiveFailures = 0
        case .failure(let error):
            section.failed(error)
            if case .unreachable = section.reachability { consecutiveFailures += 1 } else { consecutiveFailures = 0 }
        }
    }

    /// What a view's `.task` calls on every tick: asks only when invalidated,
    /// never asked, or `policy` says it is time — so a redraw is never a request.
    public func refreshIfDue(now: Date = Date()) async {
        guard isInvalidated || policy.isDue(lastAttemptAt: section.lastAttemptAt, consecutiveFailures: consecutiveFailures, now: now) else { return }
        await refresh(background: section.hasValue)
    }

    /// Mark due. Changes nothing on screen — the value stays until the next
    /// answer replaces it.
    public func invalidate() {
        isInvalidated = true
    }

    /// Drop the value. Called by the session on an instance switch.
    public func reset() {
        section.reset()
        consecutiveFailures = 0
        isInvalidated = false
    }
}

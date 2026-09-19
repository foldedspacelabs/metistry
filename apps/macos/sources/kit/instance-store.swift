// What the app is holding for the instance it is pointed at: one section's
// worth of data, when it arrived, and what state the section is in.
//
// THE RULES THIS ENCODES, so no screen re-opens them.
//
//   * **P5 — state is reported, never inferred.** A section that could not
//     answer says so and keeps what it had; it never blanks, and it never
//     shows a value it did not receive. `Section.asOf` is the console's own
//     `as_of`, not the moment the app asked.
//   * **P2 — calm.** A *background* refresh over data already on screen is not
//     a spinner. `isRefreshing` is a flag beside the state rather than a fifth
//     state, precisely so a view cannot render it as one; only `.loading` with
//     nothing yet earns a progress view.
//   * **O3 — decision controls are disabled while unreachable.** The Mac app is
//     a client of this machine only (app-ux-plan.md §7.3) and the rule still
//     applies: a button that cannot reach the service must not look like one
//     that can. `allowsDecisions` is that, in one place.
//   * **The cursors are the offline contract's client half.** The feed's
//     `since` is an inclusive timestamp and de-duplicates on `(ref, ts, kind)`;
//     the request queue's is an opaque cursor whose `since` page is
//     *everything that changed*, so a settled row leaves the queue instead of
//     lingering. Two different mechanisms, both in `console-data.swift`'s
//     `merging(_:)`, called from here and nowhere else.
//
// WHAT IS NOT HERE. No outbox and no instance switcher: §7.3 reserved O1–O4
// for iOS, and a queue of decisions would be a statement about server state at
// delivery time rather than now. No view. No timer started by this file — a
// view owns its own `.task`, hands the store a tick, and `RefreshPolicy` says
// whether it is too soon.

import Foundation
import Observation

// MARK: - One section's state

/// loading / loaded / failed / stale, and nothing else.
public enum LoadState: Sendable, Equatable {
    /// Asked, nothing yet. The only state a progress view is honest under.
    case loading
    /// The console answered and this is what it said.
    case loaded
    /// It did not answer, and there is nothing on screen to keep.
    case failed(String)
    /// It did not answer, and what is on screen is the last thing it said. The
    /// section shows the old value AND says it is old — which is the whole of
    /// P5 in one state.
    case stale(String)

    public var detail: String? {
        switch self {
        case .loading, .loaded: return nil
        case .failed(let d), .stale(let d): return d
        }
    }
}

/// One section of the instance: the latest data, when the console says it was
/// true, and how the last attempt went.
public struct Section<Value: Sendable & Equatable>: Sendable, Equatable {
    public private(set) var value: Value?
    /// The console's own `as_of`. Nil where a route carries none.
    public private(set) var asOf: Date?
    public private(set) var state: LoadState
    /// A refresh over data already on screen. See P2 above: this is not a
    /// spinner, and a view that draws one from it is the bug.
    public private(set) var isRefreshing: Bool
    public private(set) var reachability: ConsoleReachability
    /// When the app last finished asking — distinct from `asOf`, which is the
    /// console's claim about the data.
    public private(set) var lastAttemptAt: Date?

    public init(
        value: Value? = nil,
        asOf: Date? = nil,
        state: LoadState = .loading,
        isRefreshing: Bool = false,
        reachability: ConsoleReachability = .reachable,
        lastAttemptAt: Date? = nil
    ) {
        self.value = value
        self.asOf = asOf
        self.state = state
        self.isRefreshing = isRefreshing
        self.reachability = reachability
        self.lastAttemptAt = lastAttemptAt
    }

    public var hasValue: Bool { value != nil }
    /// The one case a progress view belongs in.
    public var isFirstLoad: Bool { state == .loading && value == nil }
    /// O3, per section.
    public var allowsDecisions: Bool { reachability.allowsDecisions }
    /// The sentence a §3.16 envelope prints: what could not be done, and why.
    public var problem: String? { state.detail ?? reachability.detail }

    /// About to ask. `background: true` is a refresh over a value already on
    /// screen and does not move the state.
    public mutating func beginLoading(background: Bool) {
        if background && value != nil {
            isRefreshing = true
        } else {
            state = .loading
            isRefreshing = false
        }
    }

    public mutating func loaded(_ value: Value, asOf: Date?, at now: Date = Date()) {
        self.value = value
        self.asOf = asOf
        state = .loaded
        isRefreshing = false
        reachability = .reachable
        lastAttemptAt = now
    }

    /// The console answered and reported something absent — a 503 naming the
    /// config field, or a read carrying its own `degraded` note. The value
    /// stands; the section says what is missing.
    public mutating func loadedDegraded(_ value: Value, asOf: Date?, note: String, at now: Date = Date()) {
        self.value = value
        self.asOf = asOf
        state = .loaded
        isRefreshing = false
        reachability = .degraded(note)
        lastAttemptAt = now
    }

    /// It did not answer. `stale` where there is something to keep, `failed`
    /// where there is not — never a blank pane over a working screen.
    public mutating func failed(_ error: ConsoleError, at now: Date = Date()) {
        let detail = error.localizedDescription
        state = value == nil ? .failed(detail) : .stale(detail)
        isRefreshing = false
        reachability = ConsoleReachability.after(error)
        lastAttemptAt = now
    }

    /// Switching instance drops the previous answer rather than carrying it
    /// over. A value belongs to the install it was asked about, and showing it
    /// beside a different one is the thing this must never do
    /// (`ConsoleSignInModel.adopt` holds the same line).
    public mutating func reset() {
        self = Section()
    }
}

// MARK: - When to ask again

/// How often a section refreshes itself, and how it backs off when nothing is
/// answering.
///
/// Every interval here is in the tens of seconds, because P2 asks for calm and
/// because each request is one `metistry console call` — a process, not a
/// socket on a pool. Nothing here polls faster than a person reads.
public struct RefreshPolicy: Sendable, Equatable {
    public let interval: TimeInterval
    /// After an unreachable answer the wait doubles, up to this. The backoff
    /// changes how often the app ASKS; it never changes what the app CLAIMS —
    /// a stale section says it is stale at every interval.
    public let backoffCeiling: TimeInterval

    public init(interval: TimeInterval, backoffCeiling: TimeInterval = 300) {
        self.interval = interval
        self.backoffCeiling = backoffCeiling
    }

    /// The feed is the only thing that moves on its own, and it moves at a
    /// human pace. Presence is the shortest because a lease expiring is the
    /// one fact that goes wrong quietly.
    public static let feed = RefreshPolicy(interval: 20)
    public static let requests = RefreshPolicy(interval: 30)
    public static let board = RefreshPolicy(interval: 30)
    public static let presence = RefreshPolicy(interval: 15)
    /// Configuration, not activity: asked when a pane opens, not on a clock.
    public static let configuration = RefreshPolicy(interval: 600)

    public func nextDelay(consecutiveFailures: Int) -> TimeInterval {
        guard consecutiveFailures > 0 else { return interval }
        let doubled = interval * pow(2, Double(min(consecutiveFailures, 8)))
        return min(doubled, backoffCeiling)
    }

    /// Whether enough time has passed. A view's `.task` can fire on every
    /// redraw; this is what stops that becoming a request.
    public func isDue(lastAttemptAt: Date?, consecutiveFailures: Int = 0, now: Date = Date()) -> Bool {
        guard let lastAttemptAt else { return true }
        return now.timeIntervalSince(lastAttemptAt) >= nextDelay(consecutiveFailures: consecutiveFailures)
    }
}

// MARK: - The store

/// Everything one instance's screens read, and the only thing that calls
/// `ConsoleAPI`. A view never holds a client.
@MainActor
@Observable
public final class InstanceStore {
    /// The instance this store is about. Pins are filed under it, and a store
    /// with none holds no pins rather than borrowing another instance's.
    public private(set) var instanceID: String?

    public private(set) var identity = Section<ConsoleIdentity>()
    public private(set) var feed = Section<ActivityFeed>()
    public private(set) var requests = Section<RequestPage>()
    public private(set) var board = Section<Board>()
    public private(set) var rooms = Section<RoomList>()
    public private(set) var agents = Section<AgentList>()
    public private(set) var presence = Section<AgentPresenceList>()
    public private(set) var compute = Section<ConsoleCompute>()
    public private(set) var commands = Section<CommandMenu>()
    public private(set) var knowledge = Section<KnowledgeSearchReply>()
    /// The Pages list, beside the search results rather than sharing a
    /// section with them: browsing the vault and searching it are two
    /// questions, and a search must not blank the list you were reading.
    public private(set) var pages = Section<KnowledgePageList>()

    /// The sidebar's Pinned area. Per-machine client state, keyed by instance.
    public private(set) var pins: PinnedItems

    /// The last thing the console said about itself, across every section — for
    /// the one place the window reports its own connection.
    public private(set) var reachability: ConsoleReachability = .reachable
    /// Consecutive unreachable answers, for `RefreshPolicy`'s backoff.
    public private(set) var consecutiveFailures = 0

    private var api: ConsoleAPI?

    public init(api: ConsoleAPI?, instanceID: String? = nil, defaults: UserDefaults = .standard) {
        self.api = api
        self.instanceID = instanceID
        self.pins = PinnedItems(instanceID: instanceID, defaults: defaults)
    }

    /// Point the store at a different install. Every section is dropped and the
    /// pins are re-read under the new instance's key: a pin points at something
    /// in ONE instance (app-ux-plan.md §3.4), and the same app against a second
    /// instance must not show the first one's.
    public func adopt(api: ConsoleAPI?, instanceID: String?, defaults: UserDefaults = .standard) {
        self.api = api
        self.instanceID = instanceID
        identity.reset()
        feed.reset()
        requests.reset()
        board.reset()
        rooms.reset()
        agents.reset()
        presence.reset()
        compute.reset()
        commands.reset()
        knowledge.reset()
        pages.reset()
        reachability = .reachable
        consecutiveFailures = 0
        pins = PinnedItems(instanceID: instanceID, defaults: defaults)
    }

    public var hasClient: Bool { api != nil }

    // MARK: identity

    public func refreshIdentity() async {
        await load(\.identity, background: false) { api in
            (await api.identity()).map { ($0, WireTime.date($0.asOf)) }
        }
    }

    // MARK: the feed

    /// A full pull: `hours` back, no cursor. What the Feed section does when it
    /// opens, and what "Refresh" does.
    public func reloadFeed(hours: Int = 24, limit: Int = 100) async {
        await load(\.feed, background: false) { api in
            (await api.activityFeed(hours: hours, limit: limit)).map { ($0, WireTime.date($0.asOf)) }
        }
    }

    /// An incremental pull from the newest `ts` already on screen, folded in.
    /// The background refresh (P2) — the list does not flash and the scroll
    /// position is the view's to keep.
    public func refreshFeed(limit: Int = 100) async {
        guard let since = feed.value?.cursor else { return await reloadFeed(limit: limit) }
        let onScreen = feed.value
        await load(\.feed, background: true) { api in
            (await api.activityFeed(limit: limit, since: since)).map { page in
                (onScreen?.merging(page) ?? page, WireTime.date(page.asOf))
            }
        }
    }

    // MARK: Needs You

    public func reloadRequests(limit: Int? = nil) async {
        await load(\.requests, background: false) { api in
            (await api.requests(limit: limit)).map { ($0, nil) }
        }
    }

    /// The reconnect pull: everything that CHANGED since the cursor, folded so
    /// a row answered elsewhere leaves the queue rather than lingering in it.
    public func refreshRequests(limit: Int? = nil) async {
        guard let since = requests.value?.cursor else { return await reloadRequests(limit: limit) }
        let onScreen = requests.value
        await load(\.requests, background: true) { api in
            (await api.requests(limit: limit, since: since)).map { page in
                (onScreen?.merging(page) ?? page, nil)
            }
        }
    }

    /// The unread count the bell shows. The only badge in the product (P2) — it
    /// moved to the bell, it did not multiply.
    public var pendingRequestCount: Int {
        requests.value?.proposals.filter { $0.isInQueue() }.count ?? 0
    }

    /// Answer one request. Refuses before sending where the answer itself is
    /// not sendable (Revise with an empty reason is a cancel) or where the
    /// console cannot be reached (O3) — a refusal explained here rather than a
    /// request that fails somewhere else (P4).
    public func answer(_ row: RequestRow, _ answer: RequestAnswer) async -> Result<RequestAnswerResult, ConsoleError> {
        guard let api else { return .failure(.notConfigured("no console client for this instance")) }
        guard requests.allowsDecisions else {
            return .failure(.transport("the console is not answering, so nothing can be decided from here yet"))
        }
        guard answer.isSendable else {
            return .failure(.http(status: 400, envelope: ConsoleErrorEnvelope(
                code: "invalid_request",
                message: "Revise needs a reason — the assistant has nothing to change without one",
                field: "feedback"
            )))
        }
        // `seen_at` is the `ts` of the row that was RENDERED, so the answer is
        // refused if the question changed after it was asked.
        let result = await api.answer(row.id, answer, seenAt: row.cursor ?? row.ts)
        await refreshRequests()
        return result
    }

    /// One verb, many rows. Only Later, Skip and Decline may be batched.
    public func answerMany(_ ids: [Int], _ answer: RequestAnswer) async -> Result<RequestBatchResult, ConsoleError> {
        guard let api else { return .failure(.notConfigured("no console client for this instance")) }
        guard requests.allowsDecisions else {
            return .failure(.transport("the console is not answering, so nothing can be decided from here yet"))
        }
        guard answer.isBatchable else {
            return .failure(.http(status: 400, envelope: ConsoleErrorEnvelope(
                code: "invalid_request",
                message: "only Later, Skip and Decline apply to many rows at once — \(answer.label) does something per request, so it stays one at a time",
                field: "decision"
            )))
        }
        let result = await api.answerMany(ids, answer)
        await refreshRequests()
        return result
    }

    // MARK: Work

    public func refreshBoard(project: String? = nil, limit: Int? = nil, background: Bool = false) async {
        await load(\.board, background: background) { api in
            (await api.board(project: project, limit: limit)).map { ($0, WireTime.date($0.asOf)) }
        }
    }

    /// A board drag. The refresh afterwards is what repaints the columns, so a
    /// refused drop shows the card where it actually is rather than where it
    /// was dropped.
    public func move(_ card: BoardCard, to column: String) async -> Result<TaskMutation, ConsoleError> {
        await mutateTask(card.id) { api in await api.updateTask(card.id, .moving(to: column)) }
    }

    public func address(_ card: BoardCard, to owner: String) async -> Result<TaskMutation, ConsoleError> {
        await mutateTask(card.id) { api in await api.updateTask(card.id, .addressing(to: owner)) }
    }

    public func dispatch(_ card: BoardCard, target: String? = nil) async -> Result<TaskDispatchResult, ConsoleError> {
        guard let api else { return .failure(.notConfigured("no console client for this instance")) }
        guard board.allowsDecisions else {
            return .failure(.transport("the console is not answering, so nothing can be dispatched from here yet"))
        }
        let result = await api.dispatchTask(card.id, target: target)
        await refreshBoard(background: true)
        return result
    }

    private func mutateTask(
        _ id: Int,
        _ call: (ConsoleAPI) async -> Result<TaskMutation, ConsoleError>
    ) async -> Result<TaskMutation, ConsoleError> {
        guard let api else { return .failure(.notConfigured("no console client for this instance")) }
        guard board.allowsDecisions else {
            return .failure(.transport("the console is not answering, so the board cannot be changed from here yet"))
        }
        let result = await call(api)
        await refreshBoard(background: true)
        return result
    }

    public func refreshRooms(state: String? = nil, project: String? = nil, background: Bool = false) async {
        await load(\.rooms, background: background) { api in
            (await api.rooms(state: state, project: project)).map { ($0, WireTime.date($0.asOf)) }
        }
    }

    // MARK: Agents

    public func refreshAgents(background: Bool = false) async {
        await load(\.agents, background: background) { api in
            (await api.agents()).map { ($0, nil) }
        }
    }

    public func refreshPresence(background: Bool = false) async {
        await load(\.presence, background: background) { api in
            (await api.agentPresence()).map { ($0, WireTime.date($0.asOf)) }
        }
    }

    // MARK: Compute

    /// `writable: false` is a fact the pane states rather than discovering on
    /// submit, so it lands as `degraded` with the reason on it.
    public func refreshCompute(background: Bool = false) async {
        await load(\.compute, background: background) { api in
            (await api.compute()).map { ($0, WireTime.date($0.asOf)) }
        } degraded: { report in
            report.writable ? nil : "read-only here — the console cannot reach this instance's compute.yaml to write it (docs/ops/auth.md, the compose caveat)"
        }
    }

    // MARK: Knowledge

    /// A search is a user action, not a poll: it always shows as a first load
    /// rather than a background refresh, because there is nothing honest to
    /// keep from the previous query's results.
    public func search(_ q: String, mode: String? = nil, limit: Int? = nil) async {
        guard !q.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            knowledge.reset()
            return
        }
        await load(\.knowledge, background: false) { api in
            (await api.knowledgeSearch(q, mode: mode, limit: limit)).map { ($0, WireTime.date($0.asOf)) }
        } degraded: { reply in
            reply.degraded
        }
    }

    /// The Pages list. A poll, unlike a search: the index is a fact about the
    /// vault rather than an answer to a question, so it refreshes in the
    /// background and the previous window stays on screen while it does.
    ///
    /// One window, not an accumulating list — the route has no `total` (a
    /// count over the unscoped filter would publish what it filtered), so
    /// `nextOffset` is the only honest way onward and the caller asks for it.
    public func refreshPages(area: String? = nil, prefix: String? = nil, limit: Int? = nil, offset: Int? = nil, background: Bool = false) async {
        await load(\.pages, background: background) { api in
            (await api.knowledgePages(area: area, prefix: prefix, limit: limit, offset: offset)).map { ($0, WireTime.date($0.asOf)) }
        }
    }

    // MARK: The composer's menu

    public func refreshCommands() async {
        await load(\.commands, background: false) { api in
            (await api.commands()).map { ($0, WireTime.date($0.asOf)) }
        }
    }

    // MARK: - The one place a section changes state

    /// Ask, then record. `degraded` reads the answer for a note the console put
    /// IN it — `degraded` on a search, `writable: false` on compute — so "the
    /// embedder is down" arrives as a fact on a loaded section rather than as
    /// an error that hides the results (P5).
    private func load<Value: Sendable & Equatable>(
        _ section: ReferenceWritableKeyPath<InstanceStore, Section<Value>>,
        background: Bool,
        _ call: (ConsoleAPI) async -> Result<(Value, Date?), ConsoleError>,
        degraded: (Value) -> String? = { _ in nil }
    ) async {
        guard let api else {
            self[keyPath: section].failed(.notConfigured(CLIReadError.noRuntime.localizedDescription))
            reachability = self[keyPath: section].reachability
            return
        }
        self[keyPath: section].beginLoading(background: background)
        switch await call(api) {
        case .success(let (value, asOf)):
            if let note = degraded(value) {
                self[keyPath: section].loadedDegraded(value, asOf: asOf, note: note)
            } else {
                self[keyPath: section].loaded(value, asOf: asOf)
            }
            consecutiveFailures = 0
            reachability = self[keyPath: section].reachability
        case .failure(let error):
            self[keyPath: section].failed(error)
            let state = self[keyPath: section].reachability
            if case .unreachable = state { consecutiveFailures += 1 } else { consecutiveFailures = 0 }
            reachability = state
        }
    }
}

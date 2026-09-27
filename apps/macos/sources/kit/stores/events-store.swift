// Live changes — `GET /api/events` (design-build-plan §2.20, §2.16). The
// console tells a client WHAT changed, as ids, never bodies; the client
// refetches through the route that already decides who may read it, so the
// stream opens no new read path (invariant 3). The vocabulary is
// `packages/core/src/events.ts`' `EVENT_CATALOGUE`, one case per type below.
//
// A stream is not a request and a reply, so it has its own seam:
// `ConsoleEventTransport`. F-12's `SessionConsoleCallTransport` is the
// production one (`{stream: true}` lines until cancelled, one subscription per
// app) and conforms below as it stands; the recorded fixture stream is the
// test one.
//
// THE SUBSCRIPTION (T5-7) is `LiveEvents`, one per `ConsoleSession`, so one
// per app. It holds the stream open, remembers the last id it heard (the
// console's cursor included), and hands each event to whatever watches the
// event's TOPICS — the "the client refetches" column of the catalogue, one
// `EventTopic` per store a screen reads. A `SectionModel` built with topics is
// invalidated by exactly its events and nothing else; the shell applies
// `needs_you.changed`'s count directly, because the count IS the payload.
//
// When the stream is down — never opened, dropped, a console that does not
// serve it — every reader polls on its own `RefreshPolicy` with the `since`
// cursors it always had: the contract's fallback. The subscription reopens on
// a backoff with `Last-Event-ID`; the console replays what was missed, or
// sends `resync`, and a resync marks every watcher due.

import Foundation

public protocol EventsStore: Sendable {
    /// route: GET /api/events
    func events(lastEventID: String?) -> AsyncThrowingStream<ConsoleEvent, any Error>
}

/// A transport that can hold `GET /api/events` open: raw frames — F-12's
/// `ConsoleLiveEvent` — until the stream ends or the consumer is cancelled.
/// `lastEventID` resumes: the console replays what was missed, or sends
/// `resync` when the gap is too large.
public protocol ConsoleEventTransport: Sendable {
    func events(lastEventID: String?) async -> AsyncThrowingStream<ConsoleLiveEvent, any Error>
}

extension SessionConsoleCallTransport: ConsoleEventTransport {}

/// One event from the catalogue, typed. Numeric ids are the `bigint` keys of
/// `runs`, `inbox`, `work` and `outbound_messages`; text ids are an agent's, a
/// turn's, an artifact's.
public struct ConsoleEvent: Sendable, Equatable {
    /// The SSE `id:` — what a resubscribe hands back as `lastEventID`.
    public let id: String?
    public let change: Change

    public enum Change: Sendable, Equatable {
        case runStarted(runID: Int, kind: String, turnID: String?)
        case runFinished(runID: Int, kind: String, turnID: String?)
        case turnProgress(turnID: String)
        case messageNew(messageID: Int, thread: String)
        case presenceChanged(agentID: String)
        /// A count, which is not a body.
        case needsYouChanged(waiting: Int)
        case workChanged(workID: Int)
        /// A task's room, or an artifact's comment threads.
        case threadChanged(workID: Int?, artifactID: String?)
        case captureNew(inboxID: Int)
        /// How many files the pass changed — a count, not the paths.
        case vaultReconciled(changed: Int)
        /// `commit`, `push`, `pull` or `conflict`.
        case vaultSync(state: String)
        case routineStatus(name: String)
        case syncStatus(name: String)
        case connectionHealth(connection: String)
        /// The protected path that was written, e.g. `.metistry/compute.yaml`.
        case configChanged(file: String)
        /// `instance`, or a provider's name.
        case budgetState(scope: String)
        case releaseAvailable(version: String)
        /// The replay gap was too large: refetch every visible screen.
        case resync
        /// A type this build does not know. Ignored — a new type is an
        /// additive change and keeps the API version.
        case unknown(type: String)
        /// Not an event: the stream's position (an SSE `id:` with no data),
        /// sent to a fresh subscriber. Nothing changed; only the id matters.
        case cursor
        /// A known type without a field it always carries — a contract
        /// disagreement. The stream carries on and it reads as `resync`: the
        /// one reaction that cannot miss whatever it was trying to say.
        case unreadable(type: String)

        /// The stores this change makes due — the catalogue's "the client
        /// refetches" column, per store. Empty: nothing to refetch.
        public var topics: Set<EventTopic> {
            switch self {
            case .runStarted(_, _, let turn), .runFinished(_, _, let turn):
                return turn == nil ? [.runs, .activity] : [.runs, .activity, .working]
            case .turnProgress: return [.working]
            case .messageNew: return [.chat]
            case .presenceChanged: return [.presence]
            case .needsYouChanged: return [.needsYou]
            case .workChanged: return [.board]
            case .threadChanged: return [.threads]
            case .captureNew: return [.activity]
            case .vaultReconciled: return [.today, .knowledge]
            case .vaultSync: return [.vault]
            // A routine's file — the Standup, the brief — lands on Today.
            case .routineStatus: return [.scheduled, .today]
            case .syncStatus: return [.scheduled]
            case .connectionHealth: return [.connections]
            case .configChanged(let file):
                var topics: Set<EventTopic> = [.configuration]
                if file.hasSuffix("identity.yaml") { topics.insert(.identity) }
                if file.hasSuffix("compute.yaml") { topics.insert(.usage) }
                return topics
            case .budgetState: return [.usage]
            case .releaseAvailable: return [.identity]
            case .resync, .unreadable: return Set(EventTopic.allCases)
            case .unknown, .cursor: return []
            }
        }
    }

    public init(id: String?, change: Change) {
        self.id = id
        self.change = change
    }

    /// A frame, read against the catalogue. A known type missing a field it
    /// always carries is a contract disagreement, and throws.
    public init(frame: ConsoleLiveEvent) throws {
        if frame.isCursor {
            self.init(id: frame.id, change: .cursor)
            return
        }
        let d = frame.data
        func int(_ key: String) throws -> Int {
            guard let v = d[key]?.intValue else { throw ConsoleEventError.missing(frame.type, key) }
            return v
        }
        func text(_ key: String) throws -> String {
            guard let v = d[key]?.stringValue else { throw ConsoleEventError.missing(frame.type, key) }
            return v
        }
        let change: Change
        switch frame.type {
        case "run.started": change = .runStarted(runID: try int("run_id"), kind: try text("kind"), turnID: d["turn_id"]?.stringValue)
        case "run.finished": change = .runFinished(runID: try int("run_id"), kind: try text("kind"), turnID: d["turn_id"]?.stringValue)
        case "turn.progress": change = .turnProgress(turnID: try text("turn_id"))
        case "message.new": change = .messageNew(messageID: try int("message_id"), thread: try text("thread"))
        case "presence.changed": change = .presenceChanged(agentID: try text("agent_id"))
        case "needs_you.changed": change = .needsYouChanged(waiting: try int("waiting"))
        case "work.changed": change = .workChanged(workID: try int("work_id"))
        case "thread.changed":
            let work = d["work_id"]?.intValue
            let artifact = d["artifact_id"]?.stringValue
            if work == nil && artifact == nil { throw ConsoleEventError.missing(frame.type, "work_id | artifact_id") }
            change = .threadChanged(workID: work, artifactID: artifact)
        case "capture.new": change = .captureNew(inboxID: try int("inbox_id"))
        case "vault.reconciled": change = .vaultReconciled(changed: try int("changed"))
        case "vault.sync": change = .vaultSync(state: try text("state"))
        case "routine.status": change = .routineStatus(name: try text("name"))
        case "sync.status": change = .syncStatus(name: try text("name"))
        case "connection.health": change = .connectionHealth(connection: try text("connection"))
        case "config.changed": change = .configChanged(file: try text("file"))
        case "budget.state": change = .budgetState(scope: try text("scope"))
        case "release.available": change = .releaseAvailable(version: try text("version"))
        case "resync": change = .resync
        default: change = .unknown(type: frame.type)
        }
        self.init(id: frame.id, change: change)
    }
}

public enum ConsoleEventError: LocalizedError, Equatable {
    case missing(String, String)
    case noStream

    public var errorDescription: String? {
        switch self {
        case .missing(let type, let key): return "a `\(type)` event arrived without `\(key)`"
        case .noStream: return "this transport cannot hold GET /api/events open — poll with `since` cursors instead"
        }
    }
}

extension ConsoleStores: EventsStore {
    public func events(lastEventID: String?) -> AsyncThrowingStream<ConsoleEvent, any Error> {
        guard let stream else {
            return AsyncThrowingStream { $0.finish(throwing: ConsoleEventError.noStream) }
        }
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await frame in await stream.events(lastEventID: lastEventID) {
                        // One unreadable frame does not end the stream: ending
                        // it would resubscribe from the same id and replay the
                        // same frame, forever.
                        let event = (try? ConsoleEvent(frame: frame)) ?? ConsoleEvent(id: frame.id, change: .unreadable(type: frame.type))
                        continuation.yield(event)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

// MARK: - What an event makes due

/// One store a screen reads, as the catalogue's "the client refetches" column
/// names it. A reader declares the topics it shows; an event makes due
/// exactly the readers whose topics it names.
public enum EventTopic: String, CaseIterable, Hashable, Sendable {
    /// The Needs You list, its row and the badge — `GET /api/proposals?since=`.
    case needsYou
    /// The working indicator — `GET /api/turns/:turn_id/progress`.
    case working
    /// One run's detail — `GET /api/runs/:id`.
    case runs
    /// The Activity feed — runs and captures.
    case activity
    /// Chat — `GET /api/messages?since=`.
    case chat
    /// `GET /api/q/agent_presence`.
    case presence
    /// `GET /api/q/board`.
    case board
    /// A task's room, an artifact's comment threads.
    case threads
    case today
    case knowledge
    /// `GET /api/vault/status`.
    case vault
    /// The Scheduled routes — routines and syncs.
    case scheduled
    /// `GET /api/connections/:name`.
    case connections
    /// A pane showing a protected file.
    case configuration
    /// `GET /api/compute` — the Usage gauge.
    case usage
    /// `GET /api/identity` — the name, a release available.
    case identity
}

// MARK: - The subscription

/// The app's one subscription to `GET /api/events` for the active instance
/// (§2.20: "one subscription per app"). `ConsoleSession` owns it; the shell
/// and every `SectionModel` with topics watch it.
///
/// It never decides what is on screen. An event marks readers due and the
/// readers refetch through their routes; while it is not `live`, they poll.
@MainActor
@Observable
public final class LiveEvents {
    public enum State: Sendable, Equatable {
        /// Not started.
        case off
        /// Asked; not yet heard from. Readers poll until it is live.
        case connecting
        /// Open — a frame arrived, or it has stayed open past `openGrace`.
        case live
        /// It ended, and why. Readers poll; it reopens after a backoff.
        case down(String)
        /// This session cannot hold a stream open at all — a transport with
        /// no stream, a CLI older than `console session`. Readers poll, and
        /// nothing retries until the instance changes.
        case unavailable(String)
    }

    /// How long to wait, and when.
    public struct Timing: Sendable {
        /// A resumed stream with nothing missed says nothing until the next
        /// event, so an open stream that has not failed by now is live.
        public var openGrace: Duration
        /// The wait before reopen number `attempt` (1, 2, …) after a drop.
        public var retry: @Sendable (Int) -> Duration

        public init(openGrace: Duration, retry: @escaping @Sendable (Int) -> Duration) {
            self.openGrace = openGrace
            self.retry = retry
        }

        /// The console's own `retry:` is 3 s (`RETRY_MS`); after that the wait
        /// doubles, to a minute. The replay makes the wait cost nothing.
        public static let standard = Timing(openGrace: .seconds(2)) { attempt in
            .seconds(min(60, 3 << min(max(attempt - 1, 0), 5)))
        }
    }

    public private(set) var state: State = .off
    /// What a reopen hands back as `Last-Event-ID`: the last id heard, the
    /// console's cursor included. Nil until the stream has said anything.
    public private(set) var lastEventID: String?
    /// How many times the stream has been opened since the last `adopt`.
    public private(set) var opened = 0

    /// Readers skip the clock only while this is true.
    public var isLive: Bool { state == .live }

    @ObservationIgnored private var stores: (any EventsStore)?
    @ObservationIgnored private let timing: Timing
    @ObservationIgnored private var watchers: [Watcher] = []
    @ObservationIgnored private var nextWatcher = 0
    @ObservationIgnored private var task: Task<Void, Never>?
    /// Moves on every start, stop and adopt: a loop from before drops what it hears.
    @ObservationIgnored private var generation = 0

    private struct Watcher {
        let id: Int
        let topics: Set<EventTopic>
        let handler: @MainActor (ConsoleEvent) -> Bool
    }

    public init(stores: (any EventsStore)?, timing: Timing = .standard) {
        self.stores = stores
        self.timing = timing
    }

    /// Opens the stream and keeps it open. Idempotent.
    public func start() {
        guard task == nil else { return }
        generation += 1
        let current = generation
        task = Task { [weak self] in await self?.run(current) }
    }

    /// Closes the stream (cancelling the consumer sends the session's
    /// `cancel`). Readers poll.
    public func stop() {
        generation += 1
        task?.cancel()
        task = nil
        state = .off
    }

    /// The instance changed: the old stream is closed, its cursor forgotten —
    /// an id means nothing to another console — and, if it was running, a
    /// stream to the new one is opened. Watchers stay: they are the screens,
    /// and the screens stay.
    public func adopt(_ stores: (any EventsStore)?) {
        let wasRunning = task != nil
        stop()
        self.stores = stores
        lastEventID = nil
        opened = 0
        if wasRunning { start() }
    }

    /// Call `handler` with every event naming one of `topics`. It answers
    /// false once its owner is gone, and is dropped.
    public func watch(_ topics: Set<EventTopic>, _ handler: @escaping @MainActor (ConsoleEvent) -> Bool) {
        guard !topics.isEmpty else { return }
        nextWatcher += 1
        watchers.append(Watcher(id: nextWatcher, topics: topics, handler: handler))
    }

    // MARK: the loop

    private func run(_ current: Int) async {
        var attempt = 0
        while current == generation, !Task.isCancelled {
            guard let stores else {
                state = .unavailable(ConsoleEventError.noStream.localizedDescription)
                return
            }
            state = .connecting
            opened += 1
            let resumeFrom = lastEventID
            // A resumed stream with nothing missed is silent: open is "not failed yet".
            let grace = Task { [weak self, timing] in
                try? await Task.sleep(for: timing.openGrace)
                guard !Task.isCancelled, let self, self.generation == current, self.state == .connecting else { return }
                self.becameLive(fresh: resumeFrom == nil, first: nil)
            }
            var reason = "the console closed the event stream"
            do {
                for try await event in stores.events(lastEventID: resumeFrom) {
                    guard current == generation else { grace.cancel(); return }
                    if state != .live { becameLive(fresh: resumeFrom == nil, first: event) }
                    receive(event)
                }
            } catch {
                grace.cancel()
                guard current == generation else { return }
                if Self.isPermanent(error) {
                    state = .unavailable(error.localizedDescription)
                    return
                }
                reason = error.localizedDescription
            }
            grace.cancel()
            guard current == generation, !Task.isCancelled else { return }
            // A stream that was open resets the backoff: this drop is news.
            attempt = state == .live ? 1 : attempt + 1
            state = .down(reason)
            try? await Task.sleep(for: timing.retry(attempt))
        }
    }

    /// A subscription with nothing to resume from cannot know what changed
    /// before it opened — a reader may have loaded just before — so it counts
    /// as a resync. A resume needs none: the console replays, or says `resync`.
    private func becameLive(fresh: Bool, first: ConsoleEvent?) {
        state = .live
        if fresh, first?.change != .resync {
            deliver(ConsoleEvent(id: nil, change: .resync))
        }
    }

    private func receive(_ event: ConsoleEvent) {
        if let id = event.id, !id.isEmpty { lastEventID = id }
        deliver(event)
    }

    private func deliver(_ event: ConsoleEvent) {
        let topics = event.change.topics
        guard !topics.isEmpty else { return }
        var gone: Set<Int> = []
        for watcher in watchers where !watcher.topics.isDisjoint(with: topics) {
            if !watcher.handler(event) { gone.insert(watcher.id) }
        }
        if !gone.isEmpty { watchers.removeAll { gone.contains($0.id) } }
    }

    /// Nothing a retry can change: no stream on this transport, or a CLI that
    /// predates `console session`.
    private static func isPermanent(_ error: any Error) -> Bool {
        if error as? ConsoleEventError == .noStream { return true }
        if case .cliUnavailable = error as? ConsoleError { return true }
        return false
    }
}

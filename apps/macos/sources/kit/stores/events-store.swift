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
// test one. Without a stream transport, or while it is down, a client polls
// with `since` cursors — the contract's fallback — and T5-7 is what switches
// between the two.

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
    }

    public init(id: String?, change: Change) {
        self.id = id
        self.change = change
    }

    /// A frame, read against the catalogue. A known type missing a field it
    /// always carries is a contract disagreement, and throws.
    public init(frame: ConsoleLiveEvent) throws {
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
                        continuation.yield(try ConsoleEvent(frame: frame))
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

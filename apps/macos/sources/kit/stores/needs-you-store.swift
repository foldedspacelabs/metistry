// Needs You — the one queue for everything that needs the owner (D7), and the
// count the sidebar row and the Dock badge read (design-build-plan §2.12,
// §2.16). The three routes `ConsoleAPI` already spoke keep their names and
// their typed replies (console-data.swift).

import Foundation

public protocol NeedsYouStore: Sendable {
    /// route: GET /api/proposals
    func requests(limit: Int?, since: String?) async -> Result<RequestPage, ConsoleError>
    /// route: POST /api/proposals/:id
    func answer(_ id: Int, _ answer: RequestAnswer, seenAt: String?) async -> Result<RequestAnswerResult, ConsoleError>
    /// route: POST /api/proposals/batch
    func answerMany(_ ids: [Int], _ answer: RequestAnswer) async -> Result<RequestBatchResult, ConsoleError>
    /// route: GET /api/needs-you/count
    func waitingCount() async -> Result<NeedsYouCount, ConsoleError>
}

public extension NeedsYouStore {
    /// The queue as it stands: pending, newest first, minus what Later put down.
    func requests() async -> Result<RequestPage, ConsoleError> { await requests(limit: nil, since: nil) }
    /// An answer without the staleness check.
    func answer(_ id: Int, _ answer: RequestAnswer) async -> Result<RequestAnswerResult, ConsoleError> {
        await self.answer(id, answer, seenAt: nil)
    }
}

/// `GET /api/needs-you/count` — `{waiting, oldest_ts}` through the
/// `pending_count` named query (T1-7, §2.10): a count and the oldest request's
/// time, and nothing else, which is what lets the Dock badge read it.
public struct NeedsYouCount: Codable, Sendable, Equatable {
    public let waiting: Int
    /// Nil when nothing waits.
    public let oldestTS: String?

    enum CodingKeys: String, CodingKey {
        case waiting
        case oldestTS = "oldest_ts"
    }
}

extension ConsoleStores: NeedsYouStore {
    public func requests(limit: Int?, since: String?) async -> Result<RequestPage, ConsoleError> {
        await api.requests(limit: limit, since: since)
    }

    public func answer(_ id: Int, _ answer: RequestAnswer, seenAt: String?) async -> Result<RequestAnswerResult, ConsoleError> {
        await api.answer(id, answer, seenAt: seenAt)
    }

    public func answerMany(_ ids: [Int], _ answer: RequestAnswer) async -> Result<RequestBatchResult, ConsoleError> {
        await api.answerMany(ids, answer)
    }

    public func waitingCount() async -> Result<NeedsYouCount, ConsoleError> { await get("/api/needs-you/count") }
}

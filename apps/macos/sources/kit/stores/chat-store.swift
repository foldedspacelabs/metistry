// Chat — the conversation, the composer's menu, the working indicator, and
// the archived session a run opens (design-build-plan §2.16).

import Foundation

public protocol ChatStore: Sendable {
    /// route: POST /message
    func send(_ text: String, threadID: String?, tier: String?) async -> Result<MessageAccepted, ConsoleError>
    /// route: GET /api/messages
    func messages(limit: Int?, since: String?) async -> Result<MessagePage, ConsoleError>
    /// route: POST /api/messages/:id/feedback
    func rate(message id: Int, _ rating: Rating, note: String?) async -> Result<MessageFeedbackResult, ConsoleError>
    /// route: DELETE /api/messages/:id/feedback
    func clearRating(message id: Int) async -> Result<MessageFeedbackResult, ConsoleError>
    /// route: GET /api/commands
    func commands() async -> Result<CommandMenu, ConsoleError>
    /// route: GET /api/turns/:turn_id/progress
    func turnProgress(_ turnID: String) async -> Result<TurnProgress, ConsoleError>
    /// route: GET /api/sessions/:id
    func session(_ sessionID: String) async -> Result<SessionDetail, ConsoleError>
}

public extension ChatStore {
    func send(_ text: String) async -> Result<MessageAccepted, ConsoleError> { await send(text, threadID: nil, tier: nil) }
    func messages() async -> Result<MessagePage, ConsoleError> { await messages(limit: nil, since: nil) }
}

/// `POST /message`'s `202`: `{message_id, reply?}` — durable before it
/// answers; `reply` only where a command or a fast path answered at once.
/// Not idempotent, and not meant to be queued (docs/ops/client-api.md).
public struct MessageAccepted: Codable, Sendable, Equatable {
    /// The console's bigint id, which `pg` hands back as a string.
    public let messageID: String
    public let reply: String?

    enum CodingKeys: String, CodingKey {
        case messageID = "message_id"
        case reply
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let text = try? c.decode(String.self, forKey: .messageID) {
            messageID = text
        } else {
            messageID = String(try c.decode(Int.self, forKey: .messageID))
        }
        reply = try c.decodeIfPresent(String.self, forKey: .reply)
    }
}

/// `GET /api/messages?limit=&since=` — `{messages, cursor, more}`, inbound and outbound.
public struct MessagePage: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `POST|DELETE /api/messages/:id/feedback` — `{ok, feedback}`; `feedback` is null once cleared.
public struct MessageFeedbackResult: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `GET /api/turns/:turn_id/progress` (T2-17): the `turn_progress` named query — the tool calls of a turn so far.
public struct TurnProgress: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `GET /api/sessions/:id` (T2-17): the `session_detail` named query — Run detail's conversation.
public struct SessionDetail: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }

extension ConsoleStores: ChatStore {
    public func send(_ text: String, threadID: String?, tier: String?) async -> Result<MessageAccepted, ConsoleError> {
        await perform("POST", "/message", .fields(["text": .string(text), "thread_id": .text(threadID), "tier": .text(tier)]))
    }

    public func messages(limit: Int?, since: String?) async -> Result<MessagePage, ConsoleError> {
        await get("/api/messages", ["limit": limit.map(String.init), "since": since])
    }

    public func rate(message id: Int, _ rating: Rating, note: String?) async -> Result<MessageFeedbackResult, ConsoleError> {
        await perform("POST", "/api/messages/\(id)/feedback", .fields(["rating": .int(rating.rawValue), "note": .text(note)]))
    }

    public func clearRating(message id: Int) async -> Result<MessageFeedbackResult, ConsoleError> {
        await perform("DELETE", "/api/messages/\(id)/feedback", nil)
    }

    public func commands() async -> Result<CommandMenu, ConsoleError> { await api.commands() }

    public func turnProgress(_ turnID: String) async -> Result<TurnProgress, ConsoleError> {
        await get("/api/turns/\(Self.segment(turnID))/progress")
    }

    public func session(_ sessionID: String) async -> Result<SessionDetail, ConsoleError> {
        await get("/api/sessions/\(Self.segment(sessionID))")
    }
}

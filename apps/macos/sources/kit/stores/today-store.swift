// Today — the day, the vault's own tasks, and the acts done on them: tick,
// defer, order, Close the Day; the day's meetings, invitations and mail; a
// task line sent to a tracker; a rating on the prose the routines write
// (design-build-plan §2.11, §2.13, §2.16).
//
// Every route here is frozen ahead of its ticket (T2-4 … T4-26). The replies
// are `ConsoleBody` types whose recorded-to-be shape is the contract fixture
// beside the route (`tests/kit/fixtures/`), which T2-7 and the rest must
// match when they serve it.
//
// `POST /api/today/add` (X-12, ruling 11) is the one exception: Ruling 11
// added it to the plan on 2026-09-27, after this file's own routes were
// frozen, with no scaffolding ticket ahead of X-12 — so its fixture is
// recorded, not a contract, from the day this method lands. Add to Today's
// own control (`request-answering.swift`'s `RequestDoorHandling`) is a
// separate, later ticket; this store method is plumbing only, no UI.

import Foundation

public protocol TodayStore: Sendable {
    /// route: GET /api/today
    func today(date: String?) async -> Result<TodayReply, ConsoleError>
    /// route: GET /api/vault-tasks
    func vaultTasks(where filter: String) async -> Result<VaultTaskList, ConsoleError>
    /// route: PUT /api/today/order
    func setOrder(date: String, taskKeys: [String]) async -> Result<TodayOrderResult, ConsoleError>
    /// route: POST /api/today/add
    func addToToday(key: String, date: String?) async -> Result<AddToTodayResult, ConsoleError>
    /// route: POST /api/vault-tasks/:task_key/check
    func check(_ taskKey: String, checked: Bool, seenText: String, idempotencyKey: String) async -> Result<VaultTaskWrite, ConsoleError>
    /// route: POST /api/vault-tasks/:task_key/schedule
    func schedule(_ taskKey: String, _ when: TaskDeferral, seenText: String, idempotencyKey: String) async -> Result<VaultTaskWrite, ConsoleError>
    /// route: POST /api/vault-tasks/:task_key/link
    func link(_ taskKey: String, ref: String, seenText: String) async -> Result<VaultTaskWrite, ConsoleError>
    /// route: POST /api/today/close
    func closeDay(_ day: String, line: String?) async -> Result<CloseDayResult, ConsoleError>
    /// route: POST /api/meetings/:event_id/note
    func meetingNote(eventID: String) async -> Result<MeetingNoteResult, ConsoleError>
    /// route: POST /api/calendar/events/:id/move
    func moveEvent(_ eventID: String, _ move: EventMove) async -> Result<EventMoveResult, ConsoleError>
    /// route: POST /api/calendar/invitations/:id/respond
    func respond(toInvitation eventID: String, _ response: InvitationResponse) async -> Result<InvitationResult, ConsoleError>
    /// route: POST /api/mail/messages/:id/draft
    func draftReply(toMessage messageID: String, body: String) async -> Result<MailDraftResult, ConsoleError>
    /// route: POST /api/trackers/:connection/issues
    func createIssue(connection: String, taskKey: String, title: String?) async -> Result<TrackerIssueResult, ConsoleError>
    /// route: POST /api/trackers/:connection/issues/:key/complete
    func completeIssue(connection: String, key: String) async -> Result<TrackerIssueResult, ConsoleError>
    /// route: POST /api/prose/:id/feedback
    func rateProse(_ proseID: String, _ rating: Rating, note: String?) async -> Result<ProseFeedbackResult, ConsoleError>
    /// route: DELETE /api/prose/:id/feedback
    func clearProseRating(_ proseID: String) async -> Result<ProseFeedbackResult, ConsoleError>
}

// MARK: - Replies

/// `GET /api/today?date=` (T2-7): the day's vault tasks (today's preset),
/// work, the owner's order, events, and the brief, standup and plan paths.
public struct TodayReply: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `GET /api/vault-tasks?where=` (T2-7): the rows `vault_tasks_query` returns for a filter.
public struct VaultTaskList: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `PUT /api/today/order` (T2-7): the order as stored.
public struct TodayOrderResult: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `POST /api/today/add` (X-12, ruling 11): the captured line — `id`, `path`, `sha256` and `line` — and `replayed`, true when this is the first Add to Today's own capture returned again, not a new one.
public struct AddToTodayResult: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// Tick, Defer and Link (T2-4, T2-5, T4-25): the line as written. A `409 stale` carries the line as it stands.
public struct VaultTaskWrite: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `POST /api/today/close` (T2-8): the section written, and `plan-tomorrow` enqueued.
public struct CloseDayResult: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `POST /api/meetings/:event_id/note` (T2-11): the note's path — the first one's, on a second call.
public struct MeetingNoteResult: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `POST /api/calendar/events/:id/move` (T2-12): the preview and its single-use token, or the move done.
public struct EventMoveResult: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `POST /api/calendar/invitations/:id/respond` (T4-17).
public struct InvitationResult: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `POST /api/mail/messages/:id/draft` (T4-17): a draft, never a sent message.
public struct MailDraftResult: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// The tracker doors (T4-25, T4-26): the issue's ref and URL.
public struct TrackerIssueResult: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `POST|DELETE /api/prose/:id/feedback` (T1-12): the rating as stored, or null once cleared.
public struct ProseFeedbackResult: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }

// MARK: - Requests

/// Defer (T2-5): a `do` date, or someday. Written through `formatTaskLine`,
/// so nothing else on the line changes.
public enum TaskDeferral: Sendable, Equatable {
    /// `YYYY-MM-DD`.
    case on(String)
    case someday

    var json: JSONValue {
        switch self {
        case .on(let day): return .fields(["do": .string(day)])
        case .someday: return .fields(["someday": .bool(true)])
        }
    }
}

/// Move a meeting (T2-12): preview first — no `confirmToken` — then confirm
/// with the single-use token the preview returned. The bridge refuses a
/// confirm for an event with others in it unless the owner's door sent it.
public struct EventMove: ConsoleRequestBody {
    /// ISO 8601 instants.
    public var start: String
    public var end: String
    public var confirmToken: String?

    public init(start: String, end: String, confirmToken: String? = nil) {
        self.start = start
        self.end = end
        self.confirmToken = confirmToken
    }

    public var json: JSONValue {
        .fields(["start": .string(start), "end": .string(end), "confirm_token": .text(confirmToken)])
    }
}

/// An invitation's answer, through the connection's `rsvp` capability (T4-17).
public enum InvitationResponse: String, Sendable, Equatable {
    case accept = "accepted"
    case tentative = "tentative"
    case decline = "declined"
}

// MARK: - Over the transport

extension ConsoleStores: TodayStore {
    public func today(date: String?) async -> Result<TodayReply, ConsoleError> {
        await get("/api/today", ["date": date])
    }

    public func vaultTasks(where filter: String) async -> Result<VaultTaskList, ConsoleError> {
        await get("/api/vault-tasks", ["where": filter])
    }

    public func setOrder(date: String, taskKeys: [String]) async -> Result<TodayOrderResult, ConsoleError> {
        await perform("PUT", "/api/today/order", .fields(["date": .string(date), "task_keys": .texts(taskKeys)]))
    }

    public func addToToday(key: String, date: String?) async -> Result<AddToTodayResult, ConsoleError> {
        await perform("POST", "/api/today/add", .fields(["key": .string(key), "date": .text(date)]))
    }

    public func check(_ taskKey: String, checked: Bool, seenText: String, idempotencyKey: String) async -> Result<VaultTaskWrite, ConsoleError> {
        await perform(
            "POST", "/api/vault-tasks/\(Self.segment(taskKey))/check",
            .fields(["checked": .bool(checked), "seen_text": .string(seenText)]),
            idempotencyKey: idempotencyKey
        )
    }

    public func schedule(_ taskKey: String, _ when: TaskDeferral, seenText: String, idempotencyKey: String) async -> Result<VaultTaskWrite, ConsoleError> {
        var body = when.json
        if case .object(var o) = body {
            o["seen_text"] = .string(seenText)
            body = .object(o)
        }
        return await perform("POST", "/api/vault-tasks/\(Self.segment(taskKey))/schedule", body, idempotencyKey: idempotencyKey)
    }

    public func link(_ taskKey: String, ref: String, seenText: String) async -> Result<VaultTaskWrite, ConsoleError> {
        await perform("POST", "/api/vault-tasks/\(Self.segment(taskKey))/link", .fields(["ref": .string(ref), "seen_text": .string(seenText)]))
    }

    public func closeDay(_ day: String, line: String?) async -> Result<CloseDayResult, ConsoleError> {
        await perform("POST", "/api/today/close", .fields(["day": .string(day), "line": .text(line)]))
    }

    public func meetingNote(eventID: String) async -> Result<MeetingNoteResult, ConsoleError> {
        await perform("POST", "/api/meetings/\(Self.segment(eventID))/note", .object([:]))
    }

    public func moveEvent(_ eventID: String, _ move: EventMove) async -> Result<EventMoveResult, ConsoleError> {
        await perform("POST", "/api/calendar/events/\(Self.segment(eventID))/move", move.json)
    }

    public func respond(toInvitation eventID: String, _ response: InvitationResponse) async -> Result<InvitationResult, ConsoleError> {
        await perform("POST", "/api/calendar/invitations/\(Self.segment(eventID))/respond", .fields(["response": .string(response.rawValue)]))
    }

    public func draftReply(toMessage messageID: String, body: String) async -> Result<MailDraftResult, ConsoleError> {
        await perform("POST", "/api/mail/messages/\(Self.segment(messageID))/draft", .fields(["body": .string(body)]))
    }

    public func createIssue(connection: String, taskKey: String, title: String?) async -> Result<TrackerIssueResult, ConsoleError> {
        await perform("POST", "/api/trackers/\(Self.segment(connection))/issues", .fields(["task_key": .string(taskKey), "title": .text(title)]))
    }

    public func completeIssue(connection: String, key: String) async -> Result<TrackerIssueResult, ConsoleError> {
        await perform("POST", "/api/trackers/\(Self.segment(connection))/issues/\(Self.segment(key))/complete", .object([:]))
    }

    public func rateProse(_ proseID: String, _ rating: Rating, note: String?) async -> Result<ProseFeedbackResult, ConsoleError> {
        await perform("POST", "/api/prose/\(Self.segment(proseID))/feedback", .fields(["rating": .int(rating.rawValue), "note": .text(note)]))
    }

    public func clearProseRating(_ proseID: String) async -> Result<ProseFeedbackResult, ConsoleError> {
        await perform("DELETE", "/api/prose/\(Self.segment(proseID))/feedback", nil)
    }
}

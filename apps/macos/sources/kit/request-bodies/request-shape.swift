// X-5's `request` field: every `GET /api/proposals` row carries its reading
// from F-5's type table — `describeRequest` in packages/core/src/requests.ts,
// plan §2.12 — decoded as `RequestShape` (console-data.swift; the list reads
// its type and word, T5-4a). This file is what the card needs of it: the
// three answers and what each sends. The Mac keeps NO kind → type map of its own:
// the type, the word the owner reads, the body block and the three answers
// are the server's, so a kind added tomorrow renders the day it lands, and a
// kind nobody taught the table reads as a report with Dismiss — never as its
// stored name (docs/ops/client-api.md, "Needs You").
//
// An answer SENDS one of two things, and the difference is the whole point
// of the type table:
//
//   * a decision on the row — `POST /api/proposals/:id` (`allow`, `deny`,
//     `accept_with_changes`, `accept_as_work`, `skip`, a question's `answers`);
//   * a DOOR onto another system (§2.11) — a pull request review, an RSVP, a
//     draft in Mail, a conflict settled, a report's act, a mirrored task sent
//     to Today or delegated. The request clears when the source does.
//
// Two readings are constants here, and each says why:
//
//   * `unknownKind` — what a row without a `request` reads as (a console that
//     predates X-5; the row a `409` carries back is patched from the one on
//     screen first). It is core's own reading of a kind it does not know, the
//     one reading that can fire no consequence this build has not reviewed.
//   * `meeting` — a meeting is not a kind (§2.12: "`group_id` over note,
//     to-do and transcript rows"), so no row is ever served its reading.
//     `REQUEST_TYPE_TABLE.meeting`, verbatim, until the group is.

import Foundation

public extension RequestShape {
    /// One answer a type offers at a body: its button's word and what it sends.
    struct Answer: Codable, Sendable, Equatable {
        /// HIG Title Case; nil for a report's act, whose word is the act's own.
        public let label: String?
        public let sends: Sends
        /// `feedback` or `area` — read through `carrying`.
        public let carries: String?
        public let required: Bool?

        public init(label: String?, sends: Sends, carries: String? = nil, required: Bool? = nil) {
            self.label = label
            self.sends = sends
            self.carries = carries
            self.required = required
        }
    }

    /// Exactly one of the two: a decision stored on the row, or a door (§2.11).
    struct Sends: Codable, Sendable, Equatable {
        public let decision: String?
        public let door: String?

        public init(decision: String? = nil, door: String? = nil) {
            self.decision = decision
            self.door = door
        }
    }

    init(type: String, word: String, body: String, primary: Answer? = nil, revise: Answer? = nil, decline: Answer? = nil, grouped: Bool = false, decisions: [String] = [], questions: JSONValue? = nil) {
        self.type = type
        self.word = word
        self.body = body
        self.primary = primary
        self.revise = revise
        self.decline = decline
        self.grouped = grouped
        self.decisions = decisions
        self.questions = questions
    }

    /// The block this row is drawn with. A body outside the closed set cannot
    /// come from core; if one ever did, the quoted excerpt is the block that
    /// claims least.
    var bodyKind: RequestBodyKind { RequestBodyKind(rawValue: body) ?? .excerpt }

    /// The answer in a slot, as served.
    func answer(_ slot: RequestAnswerSlot) -> Answer? {
        switch slot {
        case .primary: return primary
        case .revise: return revise
        case .decline: return decline
        }
    }

    /// Core's reading of a kind its table does not know (`UNKNOWN_KIND_TYPE`,
    /// `UNKNOWN_KIND_BODY`): a report, drawn as an excerpt, whose only answer
    /// is Dismiss.
    static let unknownKind = RequestShape(
        type: "report", word: "report", body: RequestBodyKind.excerpt.rawValue,
        decline: Answer(label: "Dismiss", sends: Sends(decision: "skip")),
        decisions: ["skip"]
    )

    /// `REQUEST_TYPE_TABLE.meeting` — see the file header for why it is here.
    static let meeting = RequestShape(
        type: "meeting", word: "meeting", body: RequestBodyKind.todos.rawValue,
        primary: Answer(label: "Accept All", sends: Sends(decision: "allow")),
        revise: Answer(label: "Revise", sends: Sends(decision: "accept_with_changes"), carries: "feedback"),
        decline: Answer(label: "Decline All", sends: Sends(decision: "deny")),
        grouped: true,
        decisions: ["allow", "accept_with_changes", "deny"]
    )
}

public extension RequestShape.Answer {
    /// What the answer carries beside its verb.
    enum Carry: String, Sendable {
        /// The owner's words.
        case feedback
        /// Access only: the narrower area (C40).
        case area
    }

    /// Nil for a `carries` this build does not know — it carries nothing rather than refusing the row.
    var carrying: Carry? { carries.flatMap(Carry.init(rawValue:)) }
    /// The words are not optional: Request Changes, Reply.
    var isRequired: Bool { required == true }
    /// `{decision}` or `{door}`, as one value.
    var send: RequestSend {
        if let decision = sends.decision { return .decision(decision) }
        return .door(sends.door ?? "")
    }
}

/// What an answer does on the wire.
public enum RequestSend: Sendable, Equatable {
    /// Stored on the row: `POST /api/proposals/:id`.
    case decision(String)
    /// Another system's door, by `REQUEST_DOORS` name — kept as the wire spells
    /// it; `RequestDoor(rawValue:)` is nil for a door this build does not know.
    case door(String)
}

/// Which of the three answers — the type's primary verb, Revise, Decline.
/// Later is not one of them: every request takes it, and it settles nothing.
public enum RequestAnswerSlot: String, CaseIterable, Sendable {
    case primary, revise, decline
}

/// `REQUEST_DOORS`: every other system an answer can post to. Closed, as core's is.
public enum RequestDoor: String, CaseIterable, Sendable {
    case prReview = "pr_review"
    case rsvp
    case draft
    case resolveConflict = "resolve_conflict"
    case act
    case today
    case delegate

    /// What answering through it does, in the owner's words — the fact a
    /// control prints when this build cannot reach it (components-01 §1.3).
    public var reach: String {
        switch self {
        case .prReview: return "post to GitHub"
        case .rsvp: return "answer calendar invitations"
        case .draft: return "draft replies in Mail"
        case .resolveConflict: return "settle a conflicted file"
        case .act: return "do what this report asks"
        case .today: return "add a tracker's tasks to Today"
        case .delegate: return "delegate a tracker's tasks"
        }
    }
}

public extension RequestRow {
    /// The row's reading: the one it was served, or — from a console that
    /// predates X-5 — the reading of a kind nobody taught the table.
    var shape: RequestShape { request ?? .unknownKind }

    /// The same row with a reading — the `409` repaint's patch: the row a
    /// conflict carries back is the stored row, without `request`, and its
    /// kind cannot have changed while it was open.
    func reading(_ shape: RequestShape?) -> RequestRow {
        RequestRow(
            id: id, ts: ts, kind: kind, payload: payload, decision: decision, cursor: cursor,
            snoozedUntil: snoozedUntil, sourceAgent: sourceAgent, trust: trust, decidedAt: decidedAt,
            workID: workID, request: request ?? shape, source: source
        )
    }
}

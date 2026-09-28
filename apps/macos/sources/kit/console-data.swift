// The wire shapes `docs/ops/console-api.md` documents, and nothing more.
//
// Two kinds of thing live here and they are not the same kind.
//
//   * **Route replies** — `/api/identity`, `/api/proposals`, `/api/compute`,
//     `/api/knowledge/*`, `/api/commands`, `/api/runs/:id`, `/api/tasks/*`.
//     Hand-written objects in `apps/console/src`, snake_case, a real contract.
//   * **Named-query results** — `/api/q/<name>` is always `{rows, as_of}` and
//     the row's columns are the query's `SELECT` list. Invariant 3 is why these
//     arrive this way: the SQL lives in the instance's `queries/` where the
//     owner can override it (D4), so these types restate a column list that a
//     local overlay may legitimately widen. Every added column is ignored; a
//     missing one is `nil` and the row still renders (P5).
//
// TWO THINGS THAT BITE, AND ARE HANDLED HERE RATHER THAN AT EVERY CALL SITE.
//
// **Postgres `numeric` arrives as a STRING.** `pg` installs no type parser, so
// `runs.cost_usd numeric(10,6)` is `"0.001234"` on the wire while an
// `::float8` column is a number. `wireDouble` decodes either and guesses
// neither; `packages/core/src/budget.ts`'s `money_()` is the same tolerance on
// the server side, for the same reason.
//
// **Timestamps are text.** `JSON.stringify` turns a `pg` Date into an ISO
// string, and these types keep them as `String` — the app renders what the
// console said. `WireTime.date(_:)` parses one where a comparison is needed
// (staleness, ordering), with and without fractional seconds.

import Foundation

// MARK: - Reading the wire's two number spellings, and its timestamps

extension KeyedDecodingContainer {
    /// A `numeric` column (a string) or a `float8` one (a number). Absent,
    /// null and a spelling that is neither are all nil, and none of them
    /// throws: one unexpected column type must not blank a whole pane (P5).
    /// `decodeIfPresent` is deliberately not used — it THROWS on a type
    /// mismatch, which is exactly the case this exists to absorb.
    func wireDouble(_ key: Key) -> Double? {
        if let d = try? decode(Double.self, forKey: key) { return d }
        if let s = try? decode(String.self, forKey: key) { return Double(s) }
        return nil
    }

    /// The same tolerance for a count. `count(*)` is a `bigint`, which `pg`
    /// also hands back as a string once it exceeds 2^53 — and the casts in
    /// `seed/queries/` are inconsistent about `::int`.
    func wireInt(_ key: Key) -> Int? {
        if let i = try? decode(Int.self, forKey: key) { return i }
        if let s = try? decode(String.self, forKey: key) { return Int(s) }
        return nil
    }

    /// An id that is TEXT on the wire — `cmt_…`, `art_…`, `ver_…` — kept as
    /// text. A number (an older row, a hand-written fixture) is kept as its
    /// digits rather than refused. Reading one of these with `wireInt` is the
    /// bug this exists to end: `Int("cmt_01M…")` is nil, and every room's id
    /// became 0.
    func wireID(_ key: Key) -> String? {
        if let s = try? decode(String.self, forKey: key) { return s }
        if let i = try? decode(Int.self, forKey: key) { return String(i) }
        return nil
    }
}

public enum WireTime {
    /// An ISO 8601 instant as the console prints it, with or without fractional
    /// seconds. Nil for anything else — never `Date()`, which would be a
    /// staleness claim nobody made.
    public static func date(_ text: String?) -> Date? {
        guard let text, !text.isEmpty else { return nil }
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = withFraction.date(from: text) { return d }
        return ISO8601DateFormatter().date(from: text)
    }
}

// MARK: - identity and whoami

/// `GET /api/identity`. `voice` and `mention` never cross this wire.
public struct ConsoleIdentity: Codable, Sendable, Equatable {
    /// The key everything else is filed under, because an origin can move.
    public let instanceID: String
    public let name: String
    public let icon: String?
    /// The fixed, deliberately uninformative vocabulary: `artifacts` ·
    /// `capture` · `dispatch` · `knowledge` · `queries` · `tasks`. A tool
    /// GROUP, never a tool name and never a count of anything.
    public let capabilities: [String]
    public let version: String?
    public let asOf: String?

    enum CodingKeys: String, CodingKey {
        case name, icon, capabilities, version
        case instanceID = "instance_id"
        case asOf = "as_of"
    }

    public init(instanceID: String, name: String, icon: String? = nil, capabilities: [String] = [], version: String? = nil, asOf: String? = nil) {
        self.instanceID = instanceID
        self.name = name
        self.icon = icon
        self.capabilities = capabilities
        self.version = version
        self.asOf = asOf
    }

    public func has(_ capability: String) -> Bool { capabilities.contains(capability) }
}

/// `GET /api/whoami`. There is no field a token could land in, which is the
/// same property `ConsoleWhoami` has for the CLI's answer.
public struct ConsoleWhoamiReply: Codable, Sendable, Equatable {
    public let principal: String
    public let via: String
    public let management: Bool
    public let origin: String?
    public let asOf: String?

    enum CodingKeys: String, CodingKey {
        case principal, via, management, origin
        case asOf = "as_of"
    }
}

// MARK: - the feed

/// `GET /api/q/activity_feed` — `{rows, as_of}`, newest first.
public struct ActivityFeed: Codable, Sendable, Equatable {
    public let rows: [ActivityFeedRow]
    public let asOf: String?

    enum CodingKeys: String, CodingKey {
        case rows
        case asOf = "as_of"
    }

    public init(rows: [ActivityFeedRow], asOf: String? = nil) {
        self.rows = rows
        self.asOf = asOf
    }

    /// The newest `ts` on the page — what to send back as `since`.
    public var cursor: String? { rows.map(\.ts).max() }

    /// Fold a `since` page into what is already on screen.
    ///
    /// `since` is **inclusive** (the query's own comment says why: two rows can
    /// share a microsecond across two branches of the union, and a strict `>`
    /// would drop the second forever), so the newest rows always come back
    /// again. De-duplication is on `(ref, ts, kind)` — the tuple the query
    /// names — and never on `ref` alone, because one work row produces many
    /// history events and they are all real.
    public func merging(_ page: ActivityFeed) -> ActivityFeed {
        var seen = Set(page.rows.map(\.identity))
        var merged = page.rows
        for row in rows where !seen.contains(row.identity) {
            seen.insert(row.identity)
            merged.append(row)
        }
        merged.sort { $0.ts > $1.ts }
        return ActivityFeed(rows: merged, asOf: page.asOf ?? asOf)
    }
}

public struct ActivityFeedRow: Codable, Sendable, Equatable, Identifiable {
    public let ts: String
    /// The exact row kind — `capture`, `tool`, `turn`, `task_op`, `proposal`, …
    public let kind: String
    /// The coarser closed vocabulary the chips read: capture | proposal |
    /// decision | run | work | message | routine. Decided in the query, not
    /// per surface.
    public let group: String?
    public let actor: String?
    public let subject: String?
    /// Truncated to 200 characters by the query. What is shown is what came.
    public let detail: String?
    /// `runs:<id>`, `inbox:<id>`, `work:<id>`, `outbound_messages:<id>` — what a
    /// tap opens.
    public let ref: String?
    /// The id stamped on every brain tool call made while answering one
    /// message; nil on everything that is not one.
    public let turnID: String?
    /// `false` only where a run failed — the glyph, not the row, takes
    /// `failed`; `true` for a run that did not; nil where the source has no
    /// notion of failing (a capture, a request, a work entry, a message).
    public let ok: Bool?

    enum CodingKeys: String, CodingKey {
        case ts, kind, group, actor, subject, detail, ref, ok
        case turnID = "turn_id"
    }

    public init(ts: String, kind: String, group: String? = nil, actor: String? = nil, subject: String? = nil, detail: String? = nil, ref: String? = nil, turnID: String? = nil, ok: Bool? = nil) {
        self.ts = ts
        self.kind = kind
        self.group = group
        self.actor = actor
        self.subject = subject
        self.detail = detail
        self.ref = ref
        self.turnID = turnID
        self.ok = ok
    }

    /// The de-duplication tuple, and the row's identity for a `ForEach`. `ref`
    /// alone is not unique: a work row emits one event per history entry.
    public var identity: String { "\(ref ?? "-")|\(ts)|\(kind)" }
    public var id: String { identity }

    /// The run this row drills into, when it is one.
    public var runID: Int? {
        guard let ref, ref.hasPrefix("runs:") else { return nil }
        return Int(ref.dropFirst(5))
    }
}

// MARK: - Needs You

/// `GET /api/proposals`. Without a cursor: the triage queue, pending only,
/// newest first. With one: **everything that changed**, oldest first, each row
/// carrying its decision — so a reconnect learns what was settled while it was
/// away instead of showing a stale queue.
public struct RequestPage: Codable, Sendable, Equatable {
    public let proposals: [RequestRow]
    /// Opaque. Handed back, never parsed.
    public let cursor: String?
    /// Whether a page was cut at `limit`.
    public let more: Bool

    public init(proposals: [RequestRow], cursor: String? = nil, more: Bool = false) {
        self.proposals = proposals
        self.cursor = cursor
        self.more = more
    }

    /// What is still in the queue, after folding a `since` page in.
    ///
    /// A changed row REPLACES the one on screen; a row that came back settled
    /// or snoozed into the future leaves the queue, because that is what the
    /// queue means. Order is the queue's own — newest first.
    public func merging(_ page: RequestPage, now: Date = Date()) -> RequestPage {
        var byID: [Int: RequestRow] = Dictionary(uniqueKeysWithValues: proposals.map { ($0.id, $0) })
        for row in page.proposals { byID[row.id] = row }
        let live = byID.values
            .filter { $0.isInQueue(now: now) }
            .sorted { $0.ts > $1.ts }
        return RequestPage(proposals: live, cursor: page.cursor ?? cursor, more: page.more)
    }
}

public struct RequestRow: Codable, Sendable, Equatable, Identifiable {
    public let id: Int
    public let ts: String
    /// One of the seven request types (`glossary.md`). `decision` is the kind
    /// whose answers come from its own `payload.options`.
    public let kind: String
    public let sourceAgent: String?
    public let trust: String?
    /// The payload as it stands. Held as JSON because every kind's is a
    /// different shape and a struct per kind would be a catalogue that goes
    /// stale (json-value.swift explains the rule).
    public let payload: JSONValue?
    /// `pending` until answered. `later` leaves it `pending` on purpose.
    public let decision: String?
    public let decidedAt: String?
    /// The `work` row this request came from or made.
    public let workID: Int?
    /// Set by Later. The row stays pending and comes back by itself.
    public let snoozedUntil: String?
    /// The cursor for THIS row, accepted as `if_unchanged.seen_at`.
    public let cursor: String?
    /// The row's reading from core's request type table (F-5, X-5): its type,
    /// the word the owner reads, its body block. The client draws
    /// the word it is given and holds no kind → word map of its own
    /// (docs/ops/client-api.md) — so the stored `kind` is never a label. Nil
    /// only from a console older than X-5.
    public let request: RequestShape?
    /// What this request mirrors — `{kind, external_ref, person}` (migration
    /// 0027, T1-8) — or nil for a request an agent or the assistant raised.
    public let source: RequestSource?

    enum CodingKeys: String, CodingKey {
        case id, ts, kind, trust, payload, decision, cursor, request, source
        case sourceAgent = "source_agent"
        case decidedAt = "decided_at"
        case workID = "work_id"
        case snoozedUntil = "snoozed_until"
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.wireInt(.id) ?? 0
        ts = try c.decodeIfPresent(String.self, forKey: .ts) ?? ""
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? ""
        trust = try c.decodeIfPresent(String.self, forKey: .trust)
        payload = try c.decodeIfPresent(JSONValue.self, forKey: .payload)
        decision = try c.decodeIfPresent(String.self, forKey: .decision)
        cursor = try c.decodeIfPresent(String.self, forKey: .cursor)
        sourceAgent = try c.decodeIfPresent(String.self, forKey: .sourceAgent)
        decidedAt = try c.decodeIfPresent(String.self, forKey: .decidedAt)
        workID = c.wireInt(.workID)
        snoozedUntil = try c.decodeIfPresent(String.self, forKey: .snoozedUntil)
        // Additive fields read tolerantly: a shape this build does not know
        // costs the row its reading, never the whole queue (P5).
        request = try? c.decodeIfPresent(RequestShape.self, forKey: .request)
        source = try? c.decodeIfPresent(RequestSource.self, forKey: .source)
    }

    public init(id: Int, ts: String, kind: String, payload: JSONValue? = nil, decision: String? = "pending", cursor: String? = nil, snoozedUntil: String? = nil, sourceAgent: String? = nil, trust: String? = nil, decidedAt: String? = nil, workID: Int? = nil, request: RequestShape? = nil, source: RequestSource? = nil) {
        self.id = id
        self.ts = ts
        self.kind = kind
        self.payload = payload
        self.decision = decision
        self.cursor = cursor
        self.snoozedUntil = snoozedUntil
        self.sourceAgent = sourceAgent
        self.trust = trust
        self.decidedAt = decidedAt
        self.workID = workID
        self.request = request
        self.source = source
    }

    public var isPending: Bool { (decision ?? "pending") == "pending" }

    /// Snoozed to an instant that has not arrived. It is hidden from the queue
    /// AND from the morning brief — a `later` that still pushes at 07:00 is a
    /// lie — and there is no un-snooze verb, because a queue you can pull items
    /// back into has two orders in it.
    public func isSnoozed(now: Date = Date()) -> Bool {
        guard let until = WireTime.date(snoozedUntil) else { return false }
        return until > now
    }

    public func isInQueue(now: Date = Date()) -> Bool { isPending && !isSnoozed(now: now) }

    /// The answers this row actually offers. The server validates the same set
    /// **against the stored row**, never against the request, so this is the
    /// client half of one rule rather than a second rule.
    public var answers: [RequestAnswer] {
        var offered: [RequestAnswer]
        if kind == "decision", let options = payload?["options"]?.arrayValue?.compactMap(\.stringValue), !options.isEmpty {
            // A blocking question is answered with its OWN options, plus
            // Decline, which is always available.
            offered = options.map { RequestAnswer.option($0) } + [.decline(nil)]
        } else if kind == "access_request", let area = payload?.string("area") {
            // Approve / Revise / Decline as everywhere else — but Revise on an
            // access request means "grant a NARROWER folder", so it carries the
            // prefix rather than a reason, pre-set to the one that was asked
            // for. The console validates the area against its own grants
            // validator and refuses a bare reason for this kind.
            offered = [.approve, .reviseArea(area), .decline(nil)]
        } else {
            offered = [.approve, .revise(""), .decline(nil)]
        }
        offered += [.later, .skip]
        if suggestedWork != nil { offered.append(.approveAsWork) }
        return offered
    }

    /// `payload.suggested_work` — the one thing Approve as Work builds a row
    /// from, and the only reason that answer appears.
    public var suggestedWork: SuggestedWork? {
        guard let s = payload?["suggested_work"], let title = s.string("title") else { return nil }
        return SuggestedWork(title: title, project: s.string("project"), kind: s.string("kind"))
    }

    /// The title a card shows, when the payload carries one.
    public var title: String? { payload?.string("title") }

    /// `access_request` (ruled 2026-09-19): an agent asking for one vault area
    /// it may already see the titles of. Nil for every other kind — the row is
    /// what says this is one, never the client.
    public var accessRequest: AccessRequest? {
        guard kind == "access_request", let area = payload?.string("area") else { return nil }
        return AccessRequest(
            area: area,
            reason: payload?.string("reason") ?? "",
            currentTier: payload?.string("current_tier") ?? "none",
            currentAreas: payload?["current_areas"]?.arrayValue?.compactMap(\.stringValue) ?? [],
            granted: payload?["granted"]?.string("area")
        )
    }
}

/// `request` on a `GET /api/proposals` row — `describeRequest` in
/// packages/core/src/requests.ts, served by the console (X-5). Read, never
/// derived: the type table lives in core and nowhere else. What the list
/// reads of it; the answers it also carries are the request card's to read.
public struct RequestShape: Codable, Sendable, Equatable {
    /// One of the twelve types (`question`, `pull_request`, `access`, …) —
    /// a key for filtering, never a label.
    public let type: String
    /// The word the owner reads: *question*, *pull request*, *access*.
    public let word: String
    /// The body block, from screen 3 §12.2's closed set.
    public let body: String
    /// The type's three answers at this body — the request card's to read
    /// (request-bodies/request-shape.swift). Nil: the type has no such answer.
    public let primary: Answer?
    public let revise: Answer?
    public let decline: Answer?
    /// A meeting: the answers apply to every row of the group, in order.
    public let grouped: Bool
    /// What this row's answers may store on it, `later` aside.
    public let decisions: [String]

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        type = try c.decode(String.self, forKey: .type)
        word = try c.decode(String.self, forKey: .word)
        body = try c.decode(String.self, forKey: .body)
        primary = try c.decodeIfPresent(Answer.self, forKey: .primary)
        revise = try c.decodeIfPresent(Answer.self, forKey: .revise)
        decline = try c.decodeIfPresent(Answer.self, forKey: .decline)
        grouped = try c.decodeIfPresent(Bool.self, forKey: .grouped) ?? false
        decisions = try c.decodeIfPresent([String].self, forKey: .decisions) ?? []
    }

    enum CodingKeys: String, CodingKey {
        case type, word, body, grouped, decisions
        case primary, revise, decline
    }
}

/// `proposals.source` (migration 0027): the system a mirrored request lives
/// in, the subject within it, and the person the source names.
public struct RequestSource: Codable, Sendable, Equatable {
    /// `github`, `calendar`, `mail`, `linear` — the source system.
    public let kind: String
    public let externalRef: String
    public let person: String?

    enum CodingKeys: String, CodingKey {
        case kind, person
        case externalRef = "external_ref"
    }

    public init(kind: String, externalRef: String, person: String? = nil) {
        self.kind = kind
        self.externalRef = externalRef
        self.person = person
    }
}

/// What an `access_request` is asking for, and what the credential holds while
/// it asks. Approving is not a pure widening and the card has to be able to say
/// so: a `current_tier` of `index` browses every title in the vault and reads
/// none, so granting it one folder trades that browse for the read
/// (docs/ops/actions.md).
public struct AccessRequest: Sendable, Equatable {
    public let area: String
    public let reason: String
    public let currentTier: String
    public let currentAreas: [String]
    /// Set once it has been answered with Approve or Revise: the area actually granted.
    public let granted: String?

    public init(area: String, reason: String, currentTier: String = "none", currentAreas: [String] = [], granted: String? = nil) {
        self.area = area
        self.reason = reason
        self.currentTier = currentTier
        self.currentAreas = currentAreas
        self.granted = granted
    }

    /// True when Approve would COST something as well as give: tier `index`
    /// sees titles vault-wide and tier `areas` sees them only inside its
    /// prefixes.
    public var tradesIndexBrowse: Bool { currentTier == "index" }
}

public struct SuggestedWork: Sendable, Equatable {
    public let title: String
    public let project: String?
    public let kind: String?

    public init(title: String, project: String? = nil, kind: String? = nil) {
        self.title = title
        self.project = project
        self.kind = kind
    }
}

/// The six answers (app-ux-plan.md §7.4; docs/ops/reply-feedback.md is the
/// normative account of what each does on the wire), plus the option form a
/// `decision` request is answered with.
public enum RequestAnswer: Sendable, Equatable {
    /// The verb with per-kind consequences: an `improvement` writes the prompt
    /// overlay, an enrolment lets the agent in, an `action` RUNS.
    case approve
    /// Keeps your reason on the row. An empty reason cancels rather than sends
    /// — the assistant has nothing to change without one, which is why
    /// `isSendable` is false for it.
    case revise(String)
    /// Revise on an `access_request`: the same wire verb, carrying the folder
    /// to grant INSTEAD of the one that was asked for. It is a separate case
    /// rather than a second meaning for `revise(_:)` because the field that
    /// must not be empty is a different one — an area, which the console
    /// validates with its own grants validator.
    case reviseArea(String)
    /// Also per-kind: declining an enrolment REVOKES the agent's token.
    case decline(String?)
    /// Offered only where the row carries `payload.suggested_work`.
    case approveAsWork
    /// A snooze. Settles nothing: the row stays pending and comes back by
    /// itself.
    case later
    /// Declines with nothing to say, and fires NONE of Decline's per-kind
    /// consequences. The server writes the fixed `SKIP_FEEDBACK` marker, not
    /// your words — a skip is you putting something down, and nothing may read
    /// it as feedback.
    case skip
    /// A `decision` request is answered with one of its own `payload.options`
    /// (an enrolment's are `approve` and `deny`), and the option set is
    /// validated against the stored row. The client sends the option it was
    /// SHOWN rather than a verb it chose. v1's wire: the console takes it only
    /// on a request that asks exactly one pick-one question.
    case option(String)
    /// Send Answers (T2-3): one answer per question the request asks, in
    /// order — the question's own options and/or, where it ends in *Something
    /// else…*, the owner's words. The console checks every one against the
    /// questions as STORED, and never executes any of them.
    case answers([QuestionAnswer])

    public var wire: String {
        switch self {
        case .approve: return "allow"
        case .revise, .reviseArea: return "accept_with_changes"
        case .decline: return "deny"
        case .approveAsWork: return "accept_as_work"
        case .later: return "later"
        case .skip: return "skip"
        case .option(let value): return value
        case .answers: return "answers"
        }
    }

    public var feedback: String? {
        switch self {
        case .revise(let reason): return reason
        case .decline(let reason): return reason
        default: return nil
        }
    }

    /// The folder a Revise on an `access_request` grants — the `area` field
    /// that answer sends, and nothing else ever does.
    public var area: String? {
        if case .reviseArea(let area) = self { return area }
        return nil
    }

    /// Only Later, Skip and Decline may be applied to many rows: the verbs that
    /// need nothing from the individual row. Approve, Revise and Approve as
    /// Work each DO something per kind — an `action` most of all, where a
    /// batched allow would dispatch five briefs on one gesture.
    public var isBatchable: Bool {
        switch self {
        case .later, .skip, .decline: return true
        default: return false
        }
    }

    /// Revise with an empty reason is a cancel, not a send — and on an access
    /// request the field that must not be empty is the area.
    public var isSendable: Bool {
        if case .revise(let reason) = self { return !reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        if case .reviseArea(let area) = self { return !area.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        if case .answers(let answers) = self { return !answers.isEmpty && answers.allSatisfy(\.isAnswered) }
        return true
    }

    /// Send Answers' list, and nothing else ever carries one.
    public var questionAnswers: [QuestionAnswer]? {
        if case .answers(let answers) = self { return answers }
        return nil
    }

    /// The button's label. A builder word must never reach one, so these are
    /// the product's words and not the wire's.
    public var label: String {
        switch self {
        case .approve: return "Approve"
        case .revise, .reviseArea: return "Revise"
        case .decline: return "Decline"
        case .approveAsWork: return "Approve as Work"
        case .later: return "Later"
        case .skip: return "Skip"
        case .option(let value): return value.replacingOccurrences(of: "_", with: " ").capitalized
        case .answers: return "Send Answers"
        }
    }
}

/// One question's answer (T2-3, `POST /api/proposals/:id` with `decision:
/// "answers"`): the options chosen — at most one on a pick-one question —
/// and/or the owner's own words where the question ends in *Something else…*.
public struct QuestionAnswer: Sendable, Equatable {
    public let choices: [String]
    public let other: String?

    public init(choices: [String] = [], other: String? = nil) {
        self.choices = choices
        self.other = other
    }

    /// Something chosen, or words written: an empty *Something else…* is not an answer.
    public var isAnswered: Bool {
        !choices.isEmpty || !(other ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The wire shape: `{choices, other?}`.
    var wire: [String: Any] {
        var out: [String: Any] = ["choices": choices]
        if let other { out["other"] = other }
        return out
    }
}

/// `POST /api/proposals/:id`'s 200. `work` on an Approve as Work, `action` on
/// an allowed `action` request, `granted` on an approved or revised
/// `access_request`.
public struct RequestAnswerResult: Codable, Sendable, Equatable {
    public let ok: Bool
    public let work: AnsweredWork?
    public let action: AnsweredAction?
    public let granted: AnsweredGrant?

    /// What the widening actually did: which agent, which folder, and the
    /// grant as it now stands — so a client repaints from the answer instead
    /// of re-reading the registry to find out.
    public struct AnsweredGrant: Codable, Sendable, Equatable {
        public let agent: String
        public let area: String
        public let grants: Grant?
        /// C41: the tier the credential held BEFORE this answer, read from the
        /// registry at the write. `index` means Approve was also a trade —
        /// vault-wide titles for titles inside its folders — and the receipt
        /// says so from this field, never from the ask's older snapshot.
        public let priorTier: String?

        enum CodingKeys: String, CodingKey {
            case agent, area, grants
            case priorTier = "prior_tier"
        }

        public struct Grant: Codable, Sendable, Equatable {
            public let tier: String
            public let areas: [String]
            public let queries: Bool?
        }
    }

    public struct AnsweredWork: Codable, Sendable, Equatable {
        public let id: Int
        public let title: String?
        public let project: String?
    }

    public struct AnsweredAction: Codable, Sendable, Equatable {
        public let kind: String
        public let ref: String?
        public let url: String?
        public let runID: Int?

        enum CodingKeys: String, CodingKey {
            case kind, ref, url
            case runID = "run_id"
        }
    }
}

/// `POST /api/proposals/batch` — always a 200; the per-row `ok` is the outcome.
public struct RequestBatchResult: Codable, Sendable, Equatable {
    public let results: [Row]

    public struct Row: Codable, Sendable, Equatable, Identifiable {
        public let id: Int
        public let ok: Bool
        /// `already_decided` or `stale` — the client branches on this field
        /// rather than on the message.
        public let reason: String?
        /// The winner, when this row lost: the first answer to arrive wins by
        /// delivery order, and the second gets the row as it stands so a client
        /// shows what actually happened rather than "failed".
        public let decision: String?
        public let decidedAt: String?
        public let error: Envelope?

        public struct Envelope: Codable, Sendable, Equatable {
            public let code: String
            public let message: String
        }

        enum CodingKeys: String, CodingKey {
            case id, ok, reason, decision, error
            case decidedAt = "decided_at"
        }
    }

    public var refused: [Row] { results.filter { !$0.ok } }
}

// MARK: - Work: the board and its drags

/// `GET /api/q/board`. Scalar columns, so a native client renders them without
/// server work; `limit` was per column, so `rows` is every column's page.
public struct Board: Codable, Sendable, Equatable {
    public let rows: [BoardCard]
    public let asOf: String?

    enum CodingKeys: String, CodingKey {
        case rows
        case asOf = "as_of"
    }

    public init(rows: [BoardCard], asOf: String? = nil) {
        self.rows = rows
        self.asOf = asOf
    }

    /// The five columns in the query's own order. The order is the query's
    /// because a second opinion about it would be a second board. Reported is
    /// not among them: it is `BoardCard.reported`, a facet of a Done card (C39).
    public static let columnOrder = ["backlog", "assigned", "in_progress", "blocked", "done"]

    /// Column key → the label. Each label is the word its key says (C2, C38):
    /// a label that disagrees with its own value is a bug waiting for someone
    /// to fix the wrong side of it, and "Needs You" names the request queue.
    public static func label(for column: String) -> String {
        switch column {
        case "backlog": return "Backlog"
        case "assigned": return "Assigned"
        case "in_progress": return "In Progress"
        case "blocked": return "Blocked"
        case "done": return "Done"
        default: return column
        }
    }

    /// Grouped in the fixed order, including a column with nothing in it —
    /// an empty column is a fact about the board and not a reason to hide it
    /// (§3.15's empty-vs-absent).
    public var columns: [BoardColumn] {
        Self.columnOrder.map { key in
            BoardColumn(key: key, label: Self.label(for: key), cards: rows.filter { $0.column == key })
        }
    }
}

public struct BoardColumn: Sendable, Equatable, Identifiable {
    public let key: String
    public let label: String
    public let cards: [BoardCard]

    public var id: String { key }

    public init(key: String, label: String, cards: [BoardCard]) {
        self.key = key
        self.label = label
        self.cards = cards
    }
}

public struct BoardCard: Codable, Sendable, Equatable, Identifiable {
    public let id: Int
    public let column: String
    public let title: String
    /// What the card is about (C85) — the card detail's first section. Set by
    /// whoever created the row; only the owner edits it (`TaskPatch`). Nil
    /// when nobody described it.
    public let description: String?
    /// `task` or `review`.
    public let kind: String?
    public let project: String?
    /// Who it is assigned to — a name, never a lease. Assignment is the
    /// human's alone: no agent verb has an `owner` key at all.
    public let owner: String?
    public let claimedBy: String?
    public let leaseExpiresAt: String?
    public let ageHours: Double?
    public let lastReportAt: String?
    /// Closed, and the agent that ran it reported back — the Done column's
    /// facet. False on every open card.
    public let reported: Bool
    /// Wants a human: an expired lease, a blocked row that is not queued, or a
    /// due date in the past. Three conditions on columns the row already has.
    public let escalated: Bool
    public let externalRef: String?
    /// The artifact a review bundle was cut from — a handle, never a payload.
    public let artifact: String?
    /// The card has a room — the Has Thread filter.
    public let hasThread: Bool
    /// The room's message count, root and replies — the number beside the
    /// thread glyph. Zero when there is no room.
    public let threadCount: Int
    /// `meta.blocked_by`: the human todo this card waits on, spelled
    /// `vault:<path>#^<anchor>`. It surfaces and never gates.
    public let blockedBy: String?
    /// That todo's text, when the index has the line; nil when it does not.
    public let blockedByTask: String?
    /// Whether that todo is still open — *waiting on you* — or nil when the
    /// ref resolved to nothing.
    public let blockedByTaskOpen: Bool?
    public let status: String?
    public let due: String?
    public let updatedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, column, title, description, kind, project, owner, escalated, artifact, status, due, reported
        case claimedBy = "claimed_by"
        case leaseExpiresAt = "lease_expires_at"
        case ageHours = "age_hours"
        case lastReportAt = "last_report_at"
        case externalRef = "external_ref"
        case hasThread = "has_thread"
        case threadCount = "thread_count"
        case blockedBy = "blocked_by"
        case blockedByTask = "blocked_by_task"
        case blockedByTaskOpen = "blocked_by_task_open"
        case updatedAt = "updated_at"
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.wireInt(.id) ?? 0
        column = try c.decodeIfPresent(String.self, forKey: .column) ?? "backlog"
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        description = try c.decodeIfPresent(String.self, forKey: .description)
        kind = try c.decodeIfPresent(String.self, forKey: .kind)
        project = try c.decodeIfPresent(String.self, forKey: .project)
        owner = try c.decodeIfPresent(String.self, forKey: .owner)
        claimedBy = try c.decodeIfPresent(String.self, forKey: .claimedBy)
        leaseExpiresAt = try c.decodeIfPresent(String.self, forKey: .leaseExpiresAt)
        ageHours = c.wireDouble(.ageHours)
        lastReportAt = try c.decodeIfPresent(String.self, forKey: .lastReportAt)
        reported = try c.decodeIfPresent(Bool.self, forKey: .reported) ?? false
        escalated = try c.decodeIfPresent(Bool.self, forKey: .escalated) ?? false
        externalRef = try c.decodeIfPresent(String.self, forKey: .externalRef)
        artifact = try c.decodeIfPresent(String.self, forKey: .artifact)
        hasThread = try c.decodeIfPresent(Bool.self, forKey: .hasThread) ?? false
        threadCount = c.wireInt(.threadCount) ?? 0
        blockedBy = try c.decodeIfPresent(String.self, forKey: .blockedBy)
        blockedByTask = try c.decodeIfPresent(String.self, forKey: .blockedByTask)
        blockedByTaskOpen = try c.decodeIfPresent(Bool.self, forKey: .blockedByTaskOpen)
        status = try c.decodeIfPresent(String.self, forKey: .status)
        due = try c.decodeIfPresent(String.self, forKey: .due)
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt)
    }

    /// The lease is live. `claimed_by` alone does not mean held: an expired
    /// lease still holds the column, which is what `interrupted` reads.
    public func isHeld(now: Date = Date()) -> Bool {
        guard let until = WireTime.date(leaseExpiresAt) else { return false }
        return until > now
    }
}

/// A `PATCH /api/tasks/:id` body, built so a request the route would refuse
/// cannot be sent by accident.
///
/// The route has **two arms and the fields pick which**:
/// `owner`/`title`/`project`/`description` need no claim; `in_progress | blocked | closed`
/// are the lease-holder's; `open` is the unblock and is legal from `blocked`
/// only. Mixing the arms in one body is a 400 naming both fields — "because
/// the looser gate must never carry the stricter arm's write" — so this type
/// refuses to build one rather than discovering it on submit.
public struct TaskPatch: Sendable, Equatable {
    public var status: String?
    public var owner: String?
    public var project: String?
    public var title: String?
    /// What the card is about (C85) — the owner's to rewrite; no agent verb
    /// has the key. An empty string clears it: the route stores blank as none.
    public var description: String?

    public static let statuses = ["open", "in_progress", "blocked", "closed"]
    public static let mixedArmsRefusal = "a status change and an owner/title/project/description change are two different arms of PATCH /api/tasks/:id and cannot travel in one body — send them as two requests"

    public init(status: String? = nil, owner: String? = nil, project: String? = nil, title: String? = nil, description: String? = nil) {
        self.status = status
        self.owner = owner
        self.project = project
        self.title = title
        self.description = description
    }

    /// The card detail's edit: rewrite what the card says it is about, or
    /// clear it with an empty string.
    public static func describing(_ description: String) -> TaskPatch {
        TaskPatch(description: description)
    }

    /// The drag a board column makes: one status, nothing else. The column
    /// keys that are statuses are the statuses' own words, `blocked` included.
    public static func moving(to column: String) -> TaskPatch {
        TaskPatch(status: column)
    }

    /// Assigning a card to a crew — human-only by the collaboration rule, and
    /// `owner` exists on this route and on no agent surface.
    public static func addressing(to owner: String) -> TaskPatch {
        TaskPatch(owner: owner)
    }

    public var isEmpty: Bool { status == nil && owner == nil && project == nil && title == nil && description == nil }

    /// Nil when the patch mixes the two arms, or says nothing.
    public var wireBody: [String: Any]? {
        if isEmpty { return nil }
        let carriesAttributes = owner != nil || project != nil || title != nil || description != nil
        if status != nil && carriesAttributes { return nil }
        var body: [String: Any] = [:]
        if let status { body["status"] = status }
        if let owner { body["owner"] = owner }
        if let project { body["project"] = project }
        if let title { body["title"] = title }
        if let description { body["description"] = description }
        return body
    }
}

/// `{"ok":true,"task":{…}}` from every task route.
public struct TaskMutation: Codable, Sendable, Equatable {
    public let ok: Bool
    public let task: JSONValue?
}

public struct TaskDispatchResult: Codable, Sendable, Equatable {
    public let ok: Bool
    public let runID: Int?
    public let ref: String?
    public let url: String?

    enum CodingKeys: String, CodingKey {
        case ok, ref, url
        case runID = "run_id"
    }
}

// MARK: - Rooms

/// `GET /api/q/rooms`. Nothing here reads a message body: a room is a handle,
/// a count and who is in it.
public struct RoomList: Codable, Sendable, Equatable {
    public let rows: [Room]
    public let asOf: String?

    enum CodingKeys: String, CodingKey {
        case rows
        case asOf = "as_of"
    }

    public init(rows: [Room], asOf: String? = nil) {
        self.rows = rows
        self.asOf = asOf
    }
}

public struct Room: Codable, Sendable, Equatable, Identifiable {
    /// The thread's own id — `cmt_<ULID>`, text on the wire.
    public let threadID: String
    /// `work` or `artifact` — what this room hangs off.
    public let anchor: String
    public let project: String?
    public let title: String?
    /// The one numeric key here: `work` is a `bigint` table.
    public let workID: Int?
    /// `art_<ULID>` — text, like every artifact id.
    public let artifactID: String?
    /// `ver_<ULID>`.
    public let versionID: String?
    public let path: String?
    /// `open` or `resolved`.
    public let state: String?
    public let resolvedBy: String?
    public let resolvedAt: String?
    public let messages: Int
    public let participants: [Participant]
    /// Consecutive agent messages at the end of the transcript — the ping-pong
    /// rule, counted in SQL so the client does not re-derive it.
    public let agentTail: Int
    /// What the tail is measured against.
    public let cap: Int?
    public let lastAt: String?
    public let lastAuthor: String?
    public let escalated: Bool
    public let reason: String?
    public let proposalID: Int?

    public struct Participant: Codable, Sendable, Equatable, Hashable {
        public let principal: String?
        /// `agent` or `user`. Nothing in a room may address anyone.
        public let kind: String?
    }

    public var id: String { threadID }

    enum CodingKeys: String, CodingKey {
        case anchor, project, title, path, state, messages, participants, cap, escalated, reason
        case threadID = "thread_id"
        case workID = "work_id"
        case artifactID = "artifact_id"
        case versionID = "version_id"
        case resolvedBy = "resolved_by"
        case resolvedAt = "resolved_at"
        case agentTail = "agent_tail"
        case lastAt = "last_at"
        case lastAuthor = "last_author"
        case proposalID = "proposal_id"
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        threadID = c.wireID(.threadID) ?? ""
        anchor = try c.decodeIfPresent(String.self, forKey: .anchor) ?? "artifact"
        project = try c.decodeIfPresent(String.self, forKey: .project)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        workID = c.wireInt(.workID)
        artifactID = c.wireID(.artifactID)
        versionID = c.wireID(.versionID)
        path = try c.decodeIfPresent(String.self, forKey: .path)
        state = try c.decodeIfPresent(String.self, forKey: .state)
        resolvedBy = try c.decodeIfPresent(String.self, forKey: .resolvedBy)
        resolvedAt = try c.decodeIfPresent(String.self, forKey: .resolvedAt)
        messages = c.wireInt(.messages) ?? 0
        participants = try c.decodeIfPresent([Participant].self, forKey: .participants) ?? []
        agentTail = c.wireInt(.agentTail) ?? 0
        cap = c.wireInt(.cap)
        lastAt = try c.decodeIfPresent(String.self, forKey: .lastAt)
        lastAuthor = try c.decodeIfPresent(String.self, forKey: .lastAuthor)
        escalated = try c.decodeIfPresent(Bool.self, forKey: .escalated) ?? false
        reason = try c.decodeIfPresent(String.self, forKey: .reason)
        proposalID = c.wireInt(.proposalID)
    }
}

// MARK: - Agents: the registry, and what each one is doing

/// `GET /api/agents`.
public struct AgentList: Codable, Sendable, Equatable {
    public let agents: [AgentRecord]
    /// The asks the escalation ceiling refused (C42, T2-2): after two
    /// declines a third `request_access` for the same area is refused at the
    /// tool and writes no proposal, so Needs You goes quiet — this list is the
    /// only place that quiet is said. `[]` against a console older than T2-2.
    public let accessCeilings: [AgentAccessCeiling]

    enum CodingKeys: String, CodingKey {
        case agents
        case accessCeilings = "access_ceilings"
    }

    public init(agents: [AgentRecord], accessCeilings: [AgentAccessCeiling] = []) {
        self.agents = agents
        self.accessCeilings = accessCeilings
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agents = try c.decode([AgentRecord].self, forKey: .agents)
        accessCeilings = try c.decodeIfPresent([AgentAccessCeiling].self, forKey: .accessCeilings) ?? []
    }
}

/// One (agent, area) pair the ceiling closed — `GET /api/agents`'
/// `access_ceilings` (docs/ops/client-api.md): `declines` is how many times
/// the owner said no, `hits` how many asks the ceiling has refused since.
public struct AgentAccessCeiling: Codable, Sendable, Equatable {
    public let agent: String
    public let area: String
    public let declines: Int
    public let hits: Int
    public let lastProposal: Int?
    public let lastDeclinedAt: String?
    public let lastAt: String?

    enum CodingKeys: String, CodingKey {
        case agent, area, declines, hits
        case lastProposal = "last_proposal"
        case lastDeclinedAt = "last_declined_at"
        case lastAt = "last_at"
    }

    public init(agent: String, area: String, declines: Int, hits: Int, lastProposal: Int? = nil, lastDeclinedAt: String? = nil, lastAt: String? = nil) {
        self.agent = agent
        self.area = area
        self.declines = declines
        self.hits = hits
        self.lastProposal = lastProposal
        self.lastDeclinedAt = lastDeclinedAt
        self.lastAt = lastAt
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agent = try c.decode(String.self, forKey: .agent)
        area = try c.decode(String.self, forKey: .area)
        declines = c.wireInt(.declines) ?? 0
        hits = c.wireInt(.hits) ?? 0
        lastProposal = c.wireInt(.lastProposal)
        lastDeclinedAt = try c.decodeIfPresent(String.self, forKey: .lastDeclinedAt)
        lastAt = try c.decodeIfPresent(String.self, forKey: .lastAt)
    }
}

public struct AgentRecord: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let displayName: String?
    /// `external`, `internal` (the instance's assistant) or `crew`. An
    /// internal agent's token comes from the user's own environment, which IS
    /// its approval; a crew's row from its manifest. Only `external` is ever
    /// minted over the API (T4-6).
    public let kind: String?
    /// Default-deny: `{tier: "none", areas: []}` at mint. Approval is NOT a
    /// grant — two different questions, answered separately.
    public let grants: JSONValue?
    public let projects: [String]?
    public let autonomy: JSONValue?
    /// The row **rendered** — `core`'s `describeScope`, the one vocabulary
    /// every surface uses (`docs/ops/auth.md`, `docs/ops/console-api.md`).
    /// Absent only against a console older than this app.
    public let scope: JSONValue?
    public let createdAt: String?
    public let lastSeenAt: String?
    public let revoked: Bool
    /// This bearer will be presented from off this machine, so the row starts
    /// pending and authenticates nothing until the owner approves it.
    public let remote: Bool
    public let approvedAt: String?
    /// Derived by the server: remote, unapproved, unrevoked.
    public let pending: Bool
    /// The actor's permissions table (T4-6): Resource × Read × Write, drawn
    /// by `core`'s `describePermissions` — which asks the same `may()` the
    /// doors ask — and drawn by the `PermissionsTable` component or said by
    /// `PermissionRowText`, never recomputed.
    /// `[]` holds nothing (a revoked row, a crew whose manifest is gone).
    /// Nil only against a console older than this app.
    public let permissions: [PermissionRow]?

    enum CodingKeys: String, CodingKey {
        case id, kind, grants, projects, autonomy, scope, revoked, remote, pending, permissions
        case displayName = "display_name"
        case createdAt = "created_at"
        case lastSeenAt = "last_seen_at"
        case approvedAt = "approved_at"
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        displayName = try c.decodeIfPresent(String.self, forKey: .displayName)
        kind = try c.decodeIfPresent(String.self, forKey: .kind)
        grants = try c.decodeIfPresent(JSONValue.self, forKey: .grants)
        projects = try c.decodeIfPresent([String].self, forKey: .projects)
        autonomy = try c.decodeIfPresent(JSONValue.self, forKey: .autonomy)
        scope = try c.decodeIfPresent(JSONValue.self, forKey: .scope)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
        lastSeenAt = try c.decodeIfPresent(String.self, forKey: .lastSeenAt)
        revoked = try c.decodeIfPresent(Bool.self, forKey: .revoked) ?? false
        remote = try c.decodeIfPresent(Bool.self, forKey: .remote) ?? false
        approvedAt = try c.decodeIfPresent(String.self, forKey: .approvedAt)
        pending = try c.decodeIfPresent(Bool.self, forKey: .pending) ?? false
        permissions = try c.decodeIfPresent([PermissionRow].self, forKey: .permissions)
    }

    /// `autonomy.level` — `observe`, `act_within_scope`, … Held as JSON
    /// because the record's shape is §4.21's and grows there, not here.
    public var autonomyLevel: String? { autonomy?.string("level") }
    public var grantTier: String? { grants?.string("tier") }
    public var grantAreas: [String] { grants?["areas"]?.arrayValue?.compactMap(\.stringValue) ?? [] }

    /// Every action kind, resolved AND why (`core`'s `effectiveActionsDetailed`,
    /// C46/C47 — `docs/ops/actions.md`): read off `scope.autonomy.detailed`,
    /// never recomputed here. `set` is the owner's own entry, honoured;
    /// `defaulted` is the level's own default, nothing named; `clamped` is the
    /// owner's own entry asking for more than the level allows — the ceiling
    /// wins, which is the ONE case where the owner's own setting is being
    /// overridden. Empty for a console too old to send `scope`, or a row with
    /// no table at all — never a guess at one.
    public var actionsDetailed: [String: AgentActionEntry] {
        guard case .object(let kinds) = scope?["autonomy"]?["detailed"] else { return [:] }
        return kinds.compactMapValues(AgentActionEntry.init(json:))
    }
}

/// One action kind, resolved and explained — the wire shape of `core`'s
/// `EffectiveActionEntry` (C46/C47). `mode` is what actually runs; `asked` is
/// the owner's own per-kind entry, present only for `set` and `clamped`, and
/// the only source where it disagrees with `mode` is `clamped` — that
/// mismatch IS "the owner's own setting is being overridden".
public struct AgentActionEntry: Sendable, Equatable {
    public let mode: String
    public let source: String
    public let asked: String?
    public let ceiling: String

    public init(mode: String, source: String, asked: String? = nil, ceiling: String) {
        self.mode = mode
        self.source = source
        self.asked = asked
        self.ceiling = ceiling
    }

    public init?(json: JSONValue) {
        guard let mode = json.string("mode"), let source = json.string("source"), let ceiling = json.string("ceiling") else { return nil }
        self.init(mode: mode, source: source, asked: json.string("asked"), ceiling: ceiling)
    }
}

/// **The permissions table in words** — `core`'s `permissionRowText`, said
/// the same way here, in `metistry agents list` and in the console's panel,
/// so the three surfaces print one table (a test holds this to the recorded
/// fixture, in the strings the TypeScript test holds core to). The rows are
/// the wire types the `PermissionsTable` component draws
/// (`components/permissions-table.swift`); this is the same table as text.
/// An empty cell is the dash: absence is the denial, drawn rather than left
/// blank.
public enum PermissionRowText {
    public static let emptyCell = PermissionWords.emptyCell
    public static let asksMark = "⏱"
    public static let connectionMark = "⧉"

    /// Where an entry came from, in words; nil for the base, which carries no marker.
    public static func provenanceText(_ p: PermissionProvenance) -> String? {
        switch p {
        case .approved(let id): return id.map { "approved in Needs You · #\($0)" } ?? "approved in Needs You"
        case .routine(let name): return "during \(name) only"
        case .project(let slug): return "via project \(slug)"
        case .base: return nil
        }
    }

    public static func entryText(_ e: PermissionEntry) -> String {
        var text = e.label
        if e.asks { text += " \(asksMark)" }
        if let why = provenanceText(e.provenance) { text += " (\(why))" }
        return text
    }

    public static func cellText(_ entries: [PermissionEntry]) -> String {
        entries.isEmpty ? emptyCell : entries.map(entryText).joined(separator: ", ")
    }

    /// One row: resource · read · write. A connection is marked ⧉.
    public static func rowText(_ row: PermissionRow) -> [String] {
        let label = row.resource.isConnection ? "\(row.label) \(connectionMark)" : row.label
        return [label, cellText(row.read), cellText(row.write)]
    }
}

/// `GET /api/q/agent_presence` — presence is derived state, so it comes through
/// a named query rather than as a field on the registry (invariant 3).
public struct AgentPresenceList: Codable, Sendable, Equatable {
    public let rows: [AgentPresence]
    public let asOf: String?

    enum CodingKeys: String, CodingKey {
        case rows
        case asOf = "as_of"
    }

    public init(rows: [AgentPresence], asOf: String? = nil) {
        self.rows = rows
        self.asOf = asOf
    }
}

public struct AgentPresence: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let displayName: String?
    public let kind: String?
    public let lastSeenAt: String?
    public let projects: [String]?
    /// `working` · `queued` · `interrupted` · `over-cap` · `idle`, decided in
    /// the query. The chip reports it; nothing here infers one.
    public let state: String
    public let currentClaims: [Claim]
    /// A claim whose lease has expired and still holds `claimed_by`.
    public let interruptedClaims: [Claim]
    public let blockedBundles: [Claim]
    public let spendTodayUSD: Double?

    public struct Claim: Codable, Sendable, Equatable, Identifiable {
        public let id: Int
        public let title: String?
        public let leaseExpiresAt: String?

        enum CodingKeys: String, CodingKey {
            case id, title
            case leaseExpiresAt = "lease_expires_at"
        }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = c.wireInt(.id) ?? 0
            title = try c.decodeIfPresent(String.self, forKey: .title)
            leaseExpiresAt = try c.decodeIfPresent(String.self, forKey: .leaseExpiresAt)
        }
    }

    enum CodingKeys: String, CodingKey {
        case id, kind, projects, state
        case displayName = "display_name"
        case lastSeenAt = "last_seen_at"
        case currentClaims = "current_claims"
        case interruptedClaims = "interrupted_claims"
        case blockedBundles = "blocked_bundles"
        case spendTodayUSD = "spend_today_usd"
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        displayName = try c.decodeIfPresent(String.self, forKey: .displayName)
        kind = try c.decodeIfPresent(String.self, forKey: .kind)
        lastSeenAt = try c.decodeIfPresent(String.self, forKey: .lastSeenAt)
        projects = try c.decodeIfPresent([String].self, forKey: .projects)
        state = try c.decodeIfPresent(String.self, forKey: .state) ?? "idle"
        currentClaims = try c.decodeIfPresent([Claim].self, forKey: .currentClaims) ?? []
        interruptedClaims = try c.decodeIfPresent([Claim].self, forKey: .interruptedClaims) ?? []
        blockedBundles = try c.decodeIfPresent([Claim].self, forKey: .blockedBundles) ?? []
        spendTodayUSD = c.wireDouble(.spendTodayUSD)
    }
}

/// A `PUT /api/agents/:id/autonomy` body. The record is **replaced**, so this
/// is built from a read and merged by the caller — `metistry agents autonomy`
/// does the same read-merge for the terminal.
public struct AgentAutonomyUpdate: Sendable, Equatable {
    /// May go either way, and this route is the door that permits it.
    public var level: String?
    /// Per-action-kind `allow`/`deny`. Also two-way.
    public var actions: [String: String]?
    /// §4.21's keys narrow and only narrow, as they always have.
    public var maxOpenBundles: Int?
    public var mayDispatchTo: [String]?
    public var acceptFrom: [String]?

    public init(level: String? = nil, actions: [String: String]? = nil, maxOpenBundles: Int? = nil, mayDispatchTo: [String]? = nil, acceptFrom: [String]? = nil) {
        self.level = level
        self.actions = actions
        self.maxOpenBundles = maxOpenBundles
        self.mayDispatchTo = mayDispatchTo
        self.acceptFrom = acceptFrom
    }

    public var wireBody: [String: Any] {
        var body: [String: Any] = [:]
        if let level { body["level"] = level }
        if let actions { body["actions"] = actions }
        if let maxOpenBundles { body["max_open_bundles"] = maxOpenBundles }
        if let mayDispatchTo { body["may_dispatch_to"] = mayDispatchTo }
        if let acceptFrom { body["accept_from"] = acceptFrom }
        return body
    }
}

public struct AgentAutonomyResult: Codable, Sendable, Equatable {
    public let ok: Bool
    public let autonomy: JSONValue?
    public let actions: JSONValue?
    /// Every raise, named. This is the sentence a §3.17 confirmation has to
    /// quote — and it is the server's sentence, not one composed on screen.
    public let widened: [String]?
}

public struct AgentApprovalResult: Codable, Sendable, Equatable {
    public let approved: Bool
    public let proposals: [Int]?
}

// MARK: - Compute

/// `GET /api/compute`. The body IS `metistry compute show --json`'s report plus
/// three keys, so the report half decodes into the same `ComputeFacts` the
/// Compute pane already reads from the CLI — one shape, two doors.
public struct ConsoleCompute: Decodable, Sendable, Equatable {
    public let facts: ComputeFacts
    /// Folded from the `spend` named query — the same read path the engine
    /// checks before every billable call. **nil when that query is not
    /// loaded**, never a guessed zero.
    public let spend: ComputeSpend?
    /// Whether the write verbs will work here, so a client greys the controls
    /// instead of discovering it on submit.
    public let writable: Bool
    public let asOf: String?

    public init(facts: ComputeFacts, spend: ComputeSpend? = nil, writable: Bool, asOf: String? = nil) {
        self.facts = facts
        self.spend = spend
        self.writable = writable
        self.asOf = asOf
    }

    public init(from decoder: any Decoder) throws {
        let json = try JSONValue(from: decoder)
        guard let facts = ComputeFacts(json: json) else {
            throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "not a compute report"))
        }
        self.init(
            facts: facts,
            spend: json["spend"].flatMap(ComputeSpend.init(json:)),
            writable: json.bool("writable") ?? false,
            asOf: json.string("as_of")
        )
    }
}

public struct ComputeSpend: Sendable, Equatable {
    public let instance: Window
    public let providers: [String: Window]

    public struct Window: Sendable, Equatable {
        public let daily: Double
        public let monthly: Double

        public init(daily: Double, monthly: Double) {
            self.daily = daily
            self.monthly = monthly
        }

        init?(json: JSONValue) {
            guard case .object = json else { return nil }
            self.init(daily: json.number("daily"), monthly: json.number("monthly"))
        }
    }

    public init(instance: Window, providers: [String: Window]) {
        self.instance = instance
        self.providers = providers
    }

    init?(json: JSONValue) {
        guard let instance = json["instance"].flatMap(Window.init(json:)) else { return nil }
        var providers: [String: Window] = [:]
        if let block = json["providers"] {
            for name in block.objectKeys {
                if let window = block[name].flatMap(Window.init(json:)) { providers[name] = window }
            }
        }
        self.init(instance: instance, providers: providers)
    }
}

// MARK: - Usage (screen 17)
//
// Three named queries the popover reads beside `/api/compute`'s windows: the
// month's days, who spent it, and AWS, which is not compute. Every column is
// the query's `SELECT` list, read tolerantly (numeric arrives as a string).

/// `GET /api/q/spend` — cost per day × provider × model × tier × crew, from the
/// runs ledger. `is_today` and `is_this_month` are Postgres's clock, so the
/// month a bar falls in is the month the budget window counted it in.
public struct SpendRows: Decodable, Sendable, Equatable {
    public let rows: [SpendRow]
    public let asOf: String?

    enum CodingKeys: String, CodingKey {
        case rows
        case asOf = "as_of"
    }

    public init(rows: [SpendRow], asOf: String? = nil) {
        self.rows = rows
        self.asOf = asOf
    }
}

public struct SpendRow: Decodable, Sendable, Equatable {
    /// A `date` column: `pg` hands it back as local midnight, so it arrives as
    /// an instant (`2026-09-26T04:00:00.000Z`) — or as `2026-09-26` from an
    /// overlay that casts it to text. `UsageReport.calendarDay` reads both.
    public let day: String
    public let isToday: Bool?
    public let isThisMonth: Bool?
    public let provider: String?
    public let model: String?
    public let tier: String?
    public let crew: String?
    public let calls: Int?
    public let tokensIn: Double?
    public let tokensOut: Double?
    public let cacheRead: Double?
    public let costUSD: Double?

    enum CodingKeys: String, CodingKey {
        case day, provider, model, tier, crew, calls
        case isToday = "is_today"
        case isThisMonth = "is_this_month"
        case tokensIn = "tokens_in"
        case tokensOut = "tokens_out"
        case cacheRead = "cache_read"
        case costUSD = "cost_usd"
    }

    public init(
        day: String, isToday: Bool? = nil, isThisMonth: Bool? = nil, provider: String? = nil, model: String? = nil,
        tier: String? = nil, crew: String? = nil, calls: Int? = nil, tokensIn: Double? = nil, tokensOut: Double? = nil,
        cacheRead: Double? = nil, costUSD: Double? = nil
    ) {
        self.day = day
        self.isToday = isToday
        self.isThisMonth = isThisMonth
        self.provider = provider
        self.model = model
        self.tier = tier
        self.crew = crew
        self.calls = calls
        self.tokensIn = tokensIn
        self.tokensOut = tokensOut
        self.cacheRead = cacheRead
        self.costUSD = costUSD
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        day = (try? c.decode(String.self, forKey: .day)) ?? ""
        isToday = try? c.decode(Bool.self, forKey: .isToday)
        isThisMonth = try? c.decode(Bool.self, forKey: .isThisMonth)
        provider = try? c.decode(String.self, forKey: .provider)
        model = try? c.decode(String.self, forKey: .model)
        tier = try? c.decode(String.self, forKey: .tier)
        crew = try? c.decode(String.self, forKey: .crew)
        calls = c.wireInt(.calls)
        tokensIn = c.wireDouble(.tokensIn)
        tokensOut = c.wireDouble(.tokensOut)
        cacheRead = c.wireDouble(.cacheRead)
        costUSD = c.wireDouble(.costUSD)
    }
}

/// `GET /api/q/spend_by_actor` — *Where it went*: cost by actor (the run's
/// component), highest first, and the calls nothing could price.
public struct SpendByActorList: Decodable, Sendable, Equatable {
    public let rows: [SpendByActor]
    public let asOf: String?

    enum CodingKeys: String, CodingKey {
        case rows
        case asOf = "as_of"
    }

    public init(rows: [SpendByActor], asOf: String? = nil) {
        self.rows = rows
        self.asOf = asOf
    }
}

public struct SpendByActor: Decodable, Sendable, Equatable {
    /// The run's `component`: `assistant` for chat, `crew:<name>` or an
    /// agent's id, a routine's name.
    public let actor: String
    public let calls: Int?
    /// Calls priced `unknown` — recorded at $0 and counted here, never read as free.
    public let callsUnpriced: Int?
    public let tokensIn: Double?
    public let tokensOut: Double?
    public let costUSD: Double?

    enum CodingKeys: String, CodingKey {
        case actor, calls
        case callsUnpriced = "calls_unpriced"
        case tokensIn = "tokens_in"
        case tokensOut = "tokens_out"
        case costUSD = "cost_usd"
    }

    public init(actor: String, calls: Int? = nil, callsUnpriced: Int? = nil, tokensIn: Double? = nil, tokensOut: Double? = nil, costUSD: Double? = nil) {
        self.actor = actor
        self.calls = calls
        self.callsUnpriced = callsUnpriced
        self.tokensIn = tokensIn
        self.tokensOut = tokensOut
        self.costUSD = costUSD
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        actor = (try? c.decode(String.self, forKey: .actor)) ?? ""
        calls = c.wireInt(.calls)
        callsUnpriced = c.wireInt(.callsUnpriced)
        tokensIn = c.wireDouble(.tokensIn)
        tokensOut = c.wireDouble(.tokensOut)
        costUSD = c.wireDouble(.costUSD)
    }
}

/// `GET /api/q/aws_costs_daily` — AWS's own bill per day, from the AWS sync.
/// Not compute, and never added to it.
public struct AwsCostDays: Decodable, Sendable, Equatable {
    public let rows: [AwsCostDay]
    public let asOf: String?

    enum CodingKeys: String, CodingKey {
        case rows
        case asOf = "as_of"
    }

    public init(rows: [AwsCostDay], asOf: String? = nil) {
        self.rows = rows
        self.asOf = asOf
    }
}

public struct AwsCostDay: Decodable, Sendable, Equatable {
    public let day: String
    public let usd: Double?

    enum CodingKeys: String, CodingKey { case day, usd }

    public init(day: String, usd: Double?) {
        self.day = day
        self.usd = usd
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        day = (try? c.decode(String.self, forKey: .day)) ?? ""
        usd = c.wireDouble(.usd)
    }
}

/// Exactly one of `tier` or `crew`: two targets in one body is a request nobody
/// can mean, and the route says so by name.
public enum ComputeAssignTarget: Sendable, Equatable {
    case tier(String)
    case crew(String)

    var key: String {
        switch self {
        case .tier: return "tier"
        case .crew: return "crew"
        }
    }

    var name: String {
        switch self {
        case .tier(let value), .crew(let value): return value
        }
    }
}

/// `GET /api/compute/models` — live `/v1/models` per provider, plus the local
/// servers this instance has not configured. Held as JSON above the per-provider
/// rows `ModelCatalogue` already decodes.
public struct ComputeModelsReply: Decodable, Sendable, Equatable {
    public let providers: [ModelCatalogue]
    public let asOf: String?

    public init(providers: [ModelCatalogue], asOf: String? = nil) {
        self.providers = providers
        self.asOf = asOf
    }

    public init(from decoder: any Decoder) throws {
        let json = try JSONValue(from: decoder)
        self.init(
            providers: (json["providers"]?.arrayValue ?? []).compactMap(ModelCatalogue.init(json:)),
            asOf: json.string("as_of")
        )
    }
}

/// `GET /api/compute/catalogue` (T4-18, C131) — every switched-on provider's
/// catalogue grouped by MODEL: one row per model, one place per provider that
/// serves it. An id the model identity table cannot map is a row of its own
/// (`kind == "unmapped"`), never merged with a look-alike. The pane filters
/// and sorts what this carries; nothing here is computed on the client.
public struct ComputeCatalogueReply: Decodable, Sendable, Equatable {
    public struct Searched: Sendable, Equatable {
        public let name: String
        /// `local` · `cloud` · `subscription` — the provider's one tag (C132)
        public let tag: String
        public let ok: Bool
        public let detail: String
        public let count: Int
        public let readAt: String?
    }

    public struct Skipped: Sendable, Equatable {
        public let name: String
        public let why: String
    }

    public struct Place: Sendable, Equatable {
        public let provider: String
        public let model: String
        /// `<provider>/<model>` — exactly what an assignment takes
        public let ref: String
        public let tag: String
        public let zdr: Bool?
        public let inPerM: Double?
        public let outPerM: Double?
        /// *Included in* the plan — a subscription's place carries no price
        public let included: Bool
        public let cheapest: Bool
    }

    public struct Row: Sendable, Equatable {
        /// `model` (the table maps it) or `unmapped`
        public let kind: String
        public let key: String
        public let name: String
        public let maker: String?
        public let context: Int?
        public let capabilities: [String]
        public let places: [Place]
        public let local: Bool
        public let cloud: Bool
        public let fromInPerM: Double?
    }

    public let query: String
    public let providers: [Searched]
    public let skipped: [Skipped]
    public let rows: [Row]
    public let asOf: String?

    public init(from decoder: any Decoder) throws {
        let json = try JSONValue(from: decoder)
        query = json.string("query") ?? ""
        providers = (json["providers"]?.arrayValue ?? []).compactMap { p in
            guard let name = p.string("name") else { return nil }
            return Searched(name: name, tag: p.string("tag") ?? "cloud", ok: p.bool("ok") ?? false, detail: p.string("detail") ?? "", count: p.int("count") ?? 0, readAt: p.string("read_at"))
        }
        skipped = (json["skipped"]?.arrayValue ?? []).compactMap { s in
            guard let name = s.string("name") else { return nil }
            return Skipped(name: name, why: s.string("why") ?? "")
        }
        rows = (json["rows"]?.arrayValue ?? []).compactMap { r in
            guard let key = r.string("key"), let name = r.string("name") else { return nil }
            let places: [Place] = (r["places"]?.arrayValue ?? []).compactMap { p in
                guard let ref = p.string("ref") else { return nil }
                return Place(
                    provider: p.string("provider") ?? "", model: p.string("model") ?? "", ref: ref, tag: p.string("tag") ?? "cloud",
                    zdr: p.bool("zdr"), inPerM: p["in_per_m"]?.doubleValue, outPerM: p["out_per_m"]?.doubleValue,
                    included: p.bool("included") ?? false, cheapest: p.bool("cheapest") ?? false
                )
            }
            return Row(
                kind: r.string("kind") ?? "unmapped", key: key, name: name, maker: r.string("maker"), context: r.int("context"),
                capabilities: (r["capabilities"]?.arrayValue ?? []).compactMap(\.stringValue), places: places,
                local: r["summary"]?.bool("local") ?? false, cloud: r["summary"]?.bool("cloud") ?? false,
                fromInPerM: r["summary"]?["from_in_per_m"]?.doubleValue
            )
        }
        asOf = json.string("as_of")
    }
}

/// `POST /api/compute/assign` and `/budget`. `notes` is the lines the CLI would
/// have printed — the non-ZDR warning, "nothing enforces this yet" — and they
/// are shown rather than dropped, because they are the reason the pane is
/// honest about what a write does.
public struct ComputeWriteResult: Decodable, Sendable, Equatable {
    public let ok: Bool
    public let target: String?
    public let provider: String?
    public let model: String?
    public let effort: String?
    public let warnNonZDR: Bool
    public let notes: [String]

    public init(from decoder: any Decoder) throws {
        let json = try JSONValue(from: decoder)
        ok = json.bool("ok") ?? false
        target = json.string("target")
        provider = json.string("provider")
        model = json.string("model")
        effort = json.string("effort")
        warnNonZDR = json.bool("warn_non_zdr") ?? false
        notes = (json["notes"]?.arrayValue ?? []).compactMap(\.stringValue)
    }
}

/// `POST /api/compute/providers/test`. Uses the credential and reports only
/// whether it worked — `ProviderTestFacts` is the same shape from the CLI.
public struct ComputeProviderTestReply: Decodable, Sendable, Equatable {
    public let facts: ProviderTestFacts
    public let notes: [String]

    public init(from decoder: any Decoder) throws {
        let json = try JSONValue(from: decoder)
        guard let facts = ProviderTestFacts(json: json) else {
            throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "not a provider test result"))
        }
        self.facts = facts
        self.notes = (json["notes"]?.arrayValue ?? []).compactMap(\.stringValue)
    }
}

// MARK: - Knowledge

/// `GET /api/knowledge/search`. The complete hit list the bridge will return,
/// capped at 100 with no offset and no cursor — RRF fuses over a pool, so an
/// offset would re-rank rather than continue. "Top 100, honestly" is the
/// contract, and the UI states it.
public struct KnowledgeSearchReply: Codable, Sendable, Equatable {
    public let q: String
    /// What the bridge actually did: `keyword`, `semantic` or `hybrid`. Omitting
    /// `mode` on the request means "choose for me" AT THE BRIDGE, so this is
    /// the answer and not the request echoed back.
    public let mode: String?
    public let hits: [KnowledgeHit]
    /// "keyword only — the embedder is down" is a fact the UI states, not an
    /// error it swallows (P5).
    public let degraded: String?
    public let asOf: String?

    enum CodingKeys: String, CodingKey {
        case q, mode, hits, degraded
        case asOf = "as_of"
    }

    public init(q: String, mode: String? = nil, hits: [KnowledgeHit] = [], degraded: String? = nil, asOf: String? = nil) {
        self.q = q
        self.mode = mode
        self.hits = hits
        self.degraded = degraded
        self.asOf = asOf
    }

    /// The bridge's own ceiling. A result list of exactly this length is "top
    /// 100, honestly" rather than "100 of N".
    public static let maximumHits = 100
    public var isAtCeiling: Bool { hits.count >= Self.maximumHits }
}

public struct KnowledgeHit: Codable, Sendable, Equatable, Identifiable {
    /// Vault-relative. The sensitive half of a hit — a hit outside the scope is
    /// DROPPED rather than flagged, so this list is never a directory listing
    /// of what was filtered.
    public let path: String
    public let title: String?
    public let description: String?
    /// Capped at 300 characters by the bridge (±120 around the match, for
    /// keyword).
    public let snippet: String?
    public let score: Double?
    /// Which arm of the search found it.
    public let source: String?

    public var id: String { path }

    enum CodingKeys: String, CodingKey {
        case path, title, description, snippet, score, source
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = try c.decode(String.self, forKey: .path)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        description = try c.decodeIfPresent(String.self, forKey: .description)
        snippet = try c.decodeIfPresent(String.self, forKey: .snippet)
        score = c.wireDouble(.score)
        source = try c.decodeIfPresent(String.self, forKey: .source)
    }

    public init(path: String, title: String? = nil, description: String? = nil, snippet: String? = nil, score: Double? = nil, source: String? = nil) {
        self.path = path
        self.title = title
        self.description = description
        self.snippet = snippet
        self.score = score
        self.source = source
    }
}

/// `GET /api/knowledge/page`. Page bytes come through the vault bridge and
/// never from a query: content is not derived state, and there is no column
/// holding it.
public struct KnowledgePage: Codable, Sendable, Equatable {
    public let path: String
    public let content: String
    public let sha256: String?
    public let bytes: Int?
    public let asOf: String?

    enum CodingKeys: String, CodingKey {
        case path, content, sha256, bytes
        case asOf = "as_of"
    }
}

/// `GET /api/knowledge/pages`. The other half of the same pane, and the one
/// that is NOT the bridge: a page LIST is derived state, so it comes from a
/// named query over the reconciler's index.
///
/// **There is no total**, and asking for one would be asking the console to
/// publish the size of what it filtered. So the end of the list is "a window
/// shorter than `limit`" — `isLastPage` — and `nextOffset` is what to ask for
/// when it is not.
public struct KnowledgePageList: Codable, Sendable, Equatable {
    public let pages: [KnowledgePageEntry]
    /// Echoed back the way `search` echoes `q`: the filters this list is of.
    public let area: String?
    public let prefix: String?
    public let limit: Int
    public let offset: Int
    public let asOf: String?

    enum CodingKeys: String, CodingKey {
        case pages, area, prefix, limit, offset
        case asOf = "as_of"
    }

    public init(pages: [KnowledgePageEntry] = [], area: String? = nil, prefix: String? = nil, limit: Int = 100, offset: Int = 0, asOf: String? = nil) {
        self.pages = pages
        self.area = area
        self.prefix = prefix
        self.limit = limit
        self.offset = offset
        self.asOf = asOf
    }

    /// The route's own ceiling, so a client cannot ask for a page it will be
    /// refused: out of range is a `400` naming it, never a silent clamp.
    public static let maximumLimit = 500

    /// A short window is the end of the list. A full one may or may not be —
    /// ask, and an empty answer settles it.
    public var isLastPage: Bool { pages.count < limit }
    public var nextOffset: Int? { isLastPage ? nil : offset + limit }
}

public struct KnowledgePageEntry: Codable, Sendable, Equatable, Identifiable {
    /// Vault-relative, and the row's identity. A row the scope does not cover
    /// is dropped before it is sent, so this list is never a directory listing
    /// of what was filtered.
    public let path: String
    /// DERIVED from the path, not stored: `Areas/<Name>` at any depth under
    /// `Areas/`, the top segment elsewhere (`Journal`, `Me`, `Inbox`), and
    /// **nil for a vault-root file** like `now.md` — which is a real answer
    /// rather than a missing one.
    public let area: String?
    /// The frontmatter title, else the basename. Never empty.
    public let title: String?
    public let description: String?
    /// `clean` or `dirty` — the index's own word for "edited since the last
    /// walk". A draft and an unsettled `conflict` are not in the list at all.
    public let status: String?
    /// Both timestamps are text on the wire, like every other one.
    public let modified: String?
    public let indexedAt: String?

    public var id: String { path }

    enum CodingKeys: String, CodingKey {
        case path, area, title, description, status, modified
        case indexedAt = "indexed_at"
    }

    public init(
        path: String,
        area: String? = nil,
        title: String? = nil,
        description: String? = nil,
        status: String? = nil,
        modified: String? = nil,
        indexedAt: String? = nil
    ) {
        self.path = path
        self.area = area
        self.title = title
        self.description = description
        self.status = status
        self.modified = modified
        self.indexedAt = indexedAt
    }
}

/// `GET /api/knowledge/links`. One page's links in ONE list — `direction`
/// says which way each edge runs — because the route filters both ends of
/// every edge through the same predicate, and two arrays would be two chances
/// to filter them unevenly.
///
/// No total, for the reason the page list has none: a count over the
/// unfiltered edges would be the size of what was withheld. `isLastPage` is
/// the end of the list.
public struct KnowledgePageLinkList: Codable, Sendable, Equatable {
    /// Echoed back the way `search` echoes `q`: the page these links are of.
    public let path: String
    public let links: [KnowledgePageLink]
    public let limit: Int
    public let offset: Int
    public let asOf: String?

    enum CodingKeys: String, CodingKey {
        case path, links, limit, offset
        case asOf = "as_of"
    }

    public init(path: String = "", links: [KnowledgePageLink] = [], limit: Int = 100, offset: Int = 0, asOf: String? = nil) {
        self.path = path
        self.links = links
        self.limit = limit
        self.offset = offset
        self.asOf = asOf
    }

    /// The route's own ceiling — the same one the page list has, so a client
    /// cannot ask for a window it will be refused.
    public static let maximumLimit = 500

    public var isLastPage: Bool { links.count < limit }
    public var nextOffset: Int? { isLastPage ? nil : offset + limit }

    /// The two directions, ready to render as sections. Order within each is
    /// the server's, which is total and stable under `offset`.
    public var outgoing: [KnowledgePageLink] { links.filter { $0.direction == "outgoing" } }
    public var incoming: [KnowledgePageLink] { links.filter { $0.direction == "incoming" } }
}

public struct KnowledgePageLink: Codable, Sendable, Equatable, Identifiable {
    /// `outgoing` — the page links there; `incoming` — that page links here.
    public let direction: String
    /// Always the OTHER end of the edge, vault-relative. An edge whose other
    /// end the scope does not cover is dropped before it is sent, so this
    /// list is never a directory listing of what was filtered.
    public let path: String
    /// `wikilink`, `frontmatter` or `embed` — the same target reached two
    /// ways is two edges, which is why `kind` is part of the identity.
    public let kind: String?
    /// The target's frontmatter title where the index knows the page, else
    /// its basename — decided server-side either way.
    public let title: String?
    public let description: String?
    /// `clean` or `dirty`, and nil for a link nothing lives at yet. A draft
    /// or an unsettled `conflict` is not in the list at all, at either end.
    public let status: String?
    /// Whether the index holds a settled page at `path`. `false` is an
    /// unresolved wikilink — a note that has not been written yet, which is
    /// how a vault gets written and not an error to swallow.
    public let resolved: Bool?

    /// The edge's identity is the triple, not the path: one page can link to
    /// another as both a wikilink and an embed.
    public var id: String { "\(direction)|\(kind ?? "")|\(path)" }

    enum CodingKeys: String, CodingKey {
        case direction, path, kind, title, description, status, resolved
    }

    public init(
        direction: String,
        path: String,
        kind: String? = nil,
        title: String? = nil,
        description: String? = nil,
        status: String? = nil,
        resolved: Bool? = nil
    ) {
        self.direction = direction
        self.path = path
        self.kind = kind
        self.title = title
        self.description = description
        self.status = status
        self.resolved = resolved
    }
}

// MARK: - The composer's menu

/// `GET /api/commands` — generated from this instance's own `rules.yaml` plus
/// the agent registry. Order is deterministic (`/` then `@`, each sorted by
/// id); the client re-ranks by prefix, then substring, then recency.
public struct CommandMenu: Codable, Sendable, Equatable {
    public let commands: [CommandEntry]
    public let agents: [CommandAgent]
    public let asOf: String?

    enum CodingKeys: String, CodingKey {
        case commands, agents
        case asOf = "as_of"
    }

    public init(commands: [CommandEntry], agents: [CommandAgent], asOf: String? = nil) {
        self.commands = commands
        self.agents = agents
        self.asOf = asOf
    }
}

public struct CommandEntry: Codable, Sendable, Equatable, Identifiable {
    /// `/status`, `/note`, `/model`, or whatever this instance calls its deep
    /// alias.
    public let id: String
    /// A fast path's line IS the named query's own description, so there is
    /// nothing to keep in sync.
    public let description: String?
    /// The router's own vocabulary: `note`, `fast_path`, `model_override`.
    public let routesTo: String?
    public let tier: String?
    /// What that tier resolves to right now, so a reassignment shows in the
    /// menu without a restart.
    public let model: String?
    public let effort: String?
    /// The named query that answers a fast path.
    public let query: String?
    public let takesArgument: Bool

    enum CodingKeys: String, CodingKey {
        case id, description, tier, model, effort, query
        case routesTo = "routes_to"
        case takesArgument = "takes_argument"
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        description = try c.decodeIfPresent(String.self, forKey: .description)
        routesTo = try c.decodeIfPresent(String.self, forKey: .routesTo)
        tier = try c.decodeIfPresent(String.self, forKey: .tier)
        model = try c.decodeIfPresent(String.self, forKey: .model)
        effort = try c.decodeIfPresent(String.self, forKey: .effort)
        query = try c.decodeIfPresent(String.self, forKey: .query)
        takesArgument = try c.decodeIfPresent(Bool.self, forKey: .takesArgument) ?? false
    }
}

public struct CommandAgent: Codable, Sendable, Equatable, Identifiable {
    /// `@drey` — the mention, as the menu shows it.
    public let id: String
    public let description: String?
    public let kind: String?
    /// An approved, unrevoked row that has authenticated at least once. A
    /// pending enrolment is listed and never present.
    public let present: Bool
    public let lastSeenAt: String?

    enum CodingKeys: String, CodingKey {
        case id, description, kind, present
        case lastSeenAt = "last_seen_at"
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        description = try c.decodeIfPresent(String.self, forKey: .description)
        kind = try c.decodeIfPresent(String.self, forKey: .kind)
        present = try c.decodeIfPresent(Bool.self, forKey: .present) ?? false
        lastSeenAt = try c.decodeIfPresent(String.self, forKey: .lastSeenAt)
    }
}

// MARK: - One run

/// `GET /api/runs/:id` — what the tap on a feed row's `runs:<id>` opens.
public struct RunDetailReply: Codable, Sendable, Equatable {
    public let run: RunDetail
    public let asOf: String?

    enum CodingKeys: String, CodingKey {
        case run
        case asOf = "as_of"
    }
}

public struct RunDetail: Codable, Sendable, Equatable, Identifiable {
    public let id: Int
    public let ts: String?
    public let startedAt: String?
    public let finishedAt: String?
    public let component: String?
    public let kind: String?
    public let sessionID: String?
    public let tool: String?
    public let ok: Bool?
    public let error: String?
    public let durationMs: Int?
    public let provider: String?
    public let model: String?
    public let tokensIn: Int?
    public let tokensOut: Int?
    public let cacheReadTokens: Int?
    public let cacheWriteTokens: Int?
    /// `numeric(10,6)` — a STRING on the wire. See the file header.
    public let costUSD: Double?
    public let meta: JSONValue?
    /// The calls the same reply made, joined **exactly** on `meta.turn_id` or
    /// `meta.message_id`. A run with neither reports none, which is the honest
    /// answer: a ±N-minute window would attribute another reply's calls here.
    public let toolCalls: [RunToolCall]
    public let toolCallsTotal: Int
    public let toolCallsFailed: Int
    /// nil on every unshadowed turn, which is also how "shadow mode is not
    /// configured" reads. The two transcripts are deliberately not returned.
    public let shadowProvider: String?
    public let shadowModel: String?
    public let shadowAgreement: Double?
    public let shadowCostUSD: Double?
    public let shadowSameToolSequence: Bool?
    public let shadowAnswerSimilarity: Double?
    public let shadowError: String?

    public struct RunToolCall: Codable, Sendable, Equatable, Identifiable {
        public let id: Int
        public let ts: String?
        public let component: String?
        public let tool: String?
        public let ok: Bool?
        public let error: String?
        public let durationMs: Int?

        enum CodingKeys: String, CodingKey {
            case id, ts, component, tool, ok, error
            case durationMs = "duration_ms"
        }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = c.wireInt(.id) ?? 0
            ts = try c.decodeIfPresent(String.self, forKey: .ts)
            component = try c.decodeIfPresent(String.self, forKey: .component)
            tool = try c.decodeIfPresent(String.self, forKey: .tool)
            ok = try c.decodeIfPresent(Bool.self, forKey: .ok)
            error = try c.decodeIfPresent(String.self, forKey: .error)
            durationMs = c.wireInt(.durationMs)
        }
    }

    enum CodingKeys: String, CodingKey {
        case id, ts, component, kind, tool, ok, error, provider, model, meta
        case startedAt = "started_at"
        case finishedAt = "finished_at"
        case sessionID = "session_id"
        case durationMs = "duration_ms"
        case tokensIn = "tokens_in"
        case tokensOut = "tokens_out"
        case cacheReadTokens = "cache_read_tokens"
        case cacheWriteTokens = "cache_write_tokens"
        case costUSD = "cost_usd"
        case toolCalls = "tool_calls"
        case toolCallsTotal = "tool_calls_total"
        case toolCallsFailed = "tool_calls_failed"
        case shadowProvider = "shadow_provider"
        case shadowModel = "shadow_model"
        case shadowAgreement = "shadow_agreement"
        case shadowCostUSD = "shadow_cost_usd"
        case shadowSameToolSequence = "shadow_same_tool_sequence"
        case shadowAnswerSimilarity = "shadow_answer_similarity"
        case shadowError = "shadow_error"
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.wireInt(.id) ?? 0
        ts = try c.decodeIfPresent(String.self, forKey: .ts)
        startedAt = try c.decodeIfPresent(String.self, forKey: .startedAt)
        finishedAt = try c.decodeIfPresent(String.self, forKey: .finishedAt)
        component = try c.decodeIfPresent(String.self, forKey: .component)
        kind = try c.decodeIfPresent(String.self, forKey: .kind)
        sessionID = try c.decodeIfPresent(String.self, forKey: .sessionID)
        tool = try c.decodeIfPresent(String.self, forKey: .tool)
        ok = try c.decodeIfPresent(Bool.self, forKey: .ok)
        error = try c.decodeIfPresent(String.self, forKey: .error)
        durationMs = c.wireInt(.durationMs)
        provider = try c.decodeIfPresent(String.self, forKey: .provider)
        model = try c.decodeIfPresent(String.self, forKey: .model)
        tokensIn = c.wireInt(.tokensIn)
        tokensOut = c.wireInt(.tokensOut)
        cacheReadTokens = c.wireInt(.cacheReadTokens)
        cacheWriteTokens = c.wireInt(.cacheWriteTokens)
        costUSD = c.wireDouble(.costUSD)
        meta = try c.decodeIfPresent(JSONValue.self, forKey: .meta)
        toolCalls = try c.decodeIfPresent([RunToolCall].self, forKey: .toolCalls) ?? []
        toolCallsTotal = c.wireInt(.toolCallsTotal) ?? 0
        toolCallsFailed = c.wireInt(.toolCallsFailed) ?? 0
        shadowProvider = try c.decodeIfPresent(String.self, forKey: .shadowProvider)
        shadowModel = try c.decodeIfPresent(String.self, forKey: .shadowModel)
        shadowAgreement = c.wireDouble(.shadowAgreement)
        shadowCostUSD = c.wireDouble(.shadowCostUSD)
        shadowSameToolSequence = try c.decodeIfPresent(Bool.self, forKey: .shadowSameToolSequence)
        shadowAnswerSimilarity = c.wireDouble(.shadowAnswerSimilarity)
        shadowError = try c.decodeIfPresent(String.self, forKey: .shadowError)
    }

    /// True where this turn was shadowed. "Not shadowed" and "shadow mode is
    /// not configured" read the same, and both are facts rather than faults.
    public var wasShadowed: Bool { shadowProvider != nil || shadowModel != nil }
}

// MARK: - one JSONValue convenience these shapes want

extension JSONValue {
    /// A number, or a Postgres `numeric`'s string spelling, or 0. Named
    /// `number` rather than `doubleValue` so it cannot be confused with
    /// json-value.swift's property of that name.
    func number(_ key: String) -> Double {
        if let d = self[key]?.doubleValue { return d }
        if let s = self[key]?.stringValue, let d = Double(s) { return d }
        return 0
    }
}

// What a request says, read off its row: screen 3 §12.2's five parts —
// header · the ask · context · ONE body · answers — minus the answers, which
// are request-answering.swift's.
//
// THE BODY IS THE SHAPE'S. The server names the block (`request.body`, F-5)
// and the payload fills it; a payload never picks a block its type does not
// draw. Where a payload carries the block itself — `payload.body` with
// `kind` from the closed set (screen 3 §12.6.6; the before-and-after of
// *Tidy Me/profile.md* is the first that does, apps/console/src/profile-tidy.ts)
// — that is read first, field for field. Every producer that predates it is
// read by the fields it actually writes, each named below with the file that
// writes it, so a reader can check the claim.
//
// WHAT IS MISSING IS SAID (the `partial` state, components-01 §1). A block
// the payload cannot fill is not invented and not left blank: the card draws
// what it has and one line says why the rest is not there. The ask, the
// asker and the answers never depend on the body.
//
// GENERATED AND RETRIEVED NEVER MIX (screen 3 §12.2, part 3). The context is
// the asker's own words — on the wash, in the serif — and only from fields
// that ARE words: an access request's and an action's `reason`, a message's
// reason, v2's `context.prose`. A review's `reason` is a code
// (`ping_pong_cap`) and is never shown as prose. What the asker read is
// `refs`, as chips.

import Foundation

public struct RequestReading: Sendable, Equatable {
    public let row: RequestRow
    public let shape: RequestShape
    /// The ask: one line (§12.2 part 2).
    public let ask: String
    /// Who asked, by the configured name for the assistant (C88).
    public let asker: AgentChipModel?
    /// `trust`: nothing for `internal`; `external` and `you` are neutral facts (C22).
    public let provenance: String?
    public let submitted: Date?
    /// The asker's own words.
    public let context: String?
    /// What the asker read — retrieved, never generated.
    public let refs: [String]
    /// What an access request's credential holds now, as `describeScope` said it (§9.1: rendered as given).
    public let holds: String?
    public let body: RequestBodyBlock?
    /// A question's steps; the body the card draws for it is the showing step's.
    public let questions: QuestionSteps?
    public let partial: PartialNoteModel?
    /// C45: the last answer was refused or failed, and the row still waits.
    public let failure: RequestFailure?
    /// The lines the answers need beside them: the tier trade (C41), a re-ask, the task Approve makes.
    public let notes: [RequestNote]
    /// A report's act — Try Again, Reconnect — named by what raised it. Nil: no act.
    public let act: String?

    public init(_ row: RequestRow, assistantName: String) {
        let shape = row.shape
        let payload = row.payload
        self.row = row
        self.shape = shape
        self.asker = row.sourceAgent.map { AgentChipModel(agentID: $0, assistantName: assistantName) }
        self.provenance = Self.provenance(row.trust)
        self.submitted = WireTime.date(row.ts)
        self.ask = Self.ask(payload, word: shape.word)
        self.context = Self.context(payload, type: shape.type)
        self.refs = Self.refs(payload)
        self.holds = shape.type == "access" ? payload?["current_scope"]?.string("line") : nil
        self.failure = RequestFailure(payload?["error"])
        self.act = payload?["act"]?.string("label")

        var questions: QuestionSteps?
        var body: RequestBodyBlock?
        var partial: PartialNoteModel?
        if shape.bodyKind == .choices {
            questions = QuestionSteps(payload: payload)
            if questions == nil { partial = PartialNoteModel("the questions did not arrive with this request — Revise to say so, or Decline it") }
        } else {
            (body, partial) = BodyReading.read(shape.bodyKind, row: row, shape: shape)
        }
        self.questions = questions
        self.body = body
        self.partial = partial
        self.notes = Self.notes(row, shape: shape)
    }

    // MARK: - The header and the ask

    static func provenance(_ trust: String?) -> String? {
        switch trust {
        case "external": return "external"
        case "user": return "you"
        default: return nil
        }
    }

    /// The title the asker gave, else what the inbox drain classified it as,
    /// else the path, else the type's own word — never the stored kind.
    static func ask(_ payload: JSONValue?, word: String) -> String {
        if let title = payload?.string("title"), !title.isEmpty { return title }
        let classified = payload?["classification"]
        if let t = classified?.string("action", "title"), !t.isEmpty { return t }
        if let path = payload?.string("path"), !path.isEmpty { return path }
        return word.prefix(1).uppercased() + word.dropFirst()
    }

    static func context(_ payload: JSONValue?, type: String) -> String? {
        if let prose = payload?["context"]?.string("prose"), !prose.isEmpty { return prose }
        guard ["access", "action", "message"].contains(type) else { return nil }
        return payload?.string("reason").flatMap { $0.isEmpty ? nil : $0 }
    }

    static func refs(_ payload: JSONValue?) -> [String] {
        let listed = payload?["context"]?["refs"]?.arrayValue ?? payload?["refs"]?.arrayValue ?? []
        return listed.compactMap { $0.stringValue ?? $0.string("label", "path", "ref") }
    }

    static func notes(_ row: RequestRow, shape: RequestShape) -> [RequestNote] {
        var notes: [RequestNote] = []
        let payload = row.payload
        if shape.type == "access" {
            if payload?.bool("escalated") == true {
                notes.append(.askedAgain(declinedAt: WireTime.date(payload?.string("prior_declined_at")), prior: payload?["prior_proposal"]?.intValue))
            }
            // C41: an area grant IS tier `areas`, so for a credential at
            // `index` Approve also takes the vault-wide title browse away. The
            // words carry it; the tint only seconds them (screen 3 §9.2).
            if payload?.string("current_tier") == "index", let area = payload?.string("area") {
                notes.append(.trade("Approving trades its whole-vault title browse for reads inside \(area)."))
            }
        }
        if shape.primary?.sends.decision == "accept_as_work", let work = row.suggestedWork {
            notes.append(.makesTask("Approve also adds the task “\(work.title)” to the board"))
        }
        return notes
    }
}

/// A line beside the answers.
public enum RequestNote: Sendable, Equatable {
    /// C41 — `degraded`, the words doing the work.
    case trade(String)
    /// §9.4 — a second ask after a decline: neutral, a chip, not a paragraph.
    case askedAgain(declinedAt: Date?, prior: Int?)
    /// components-01 §2.4 — Approve makes the task, and says so before it does.
    case makesTask(String)
}

/// `payload.error` (C45): `{code, message, decision, at, …details}`.
public struct RequestFailure: Sendable, Equatable {
    public let code: String
    public let message: String
    /// The answer that was refused; nil when it was the agent's own run that failed.
    public let decision: String?
    public let at: Date?

    public init?(_ json: JSONValue?) {
        guard let json, let message = json.string("message") else { return nil }
        self.code = json.string("code") ?? "internal"
        self.message = message
        self.decision = json.string("decision")
        self.at = WireTime.date(json.string("at"))
    }

    /// *Couldn't approve* — the States board's *Couldn't …* (amendments §8.1).
    public var lead: String {
        switch decision {
        case "allow", "accept_as_work": return "Couldn't approve this"
        case "accept_with_changes": return "Couldn't revise this"
        case "deny": return "Couldn't decline this"
        case nil: return "Couldn't do this on its own"
        default: return "Couldn't send that answer"
        }
    }
}

// MARK: - The body, from the payload

enum BodyReading {
    static func read(_ kind: RequestBodyKind, row: RequestRow, shape: RequestShape) -> (RequestBodyBlock?, PartialNoteModel?) {
        let payload = row.payload
        if let named = payload?["body"], named.string("kind") == kind.rawValue, let block = generic(kind, named) {
            return (block, nil)
        }
        switch kind {
        case .choices:
            return (nil, nil) // the steps draw it
        case .diff:
            return diff(payload)
        case .thread:
            return thread(payload)
        case .beforeAfter:
            return beforeAfter(payload, type: shape.type)
        case .preview:
            return preview(payload, row: row, type: shape.type)
        case .todos:
            let items = (payload?["todos"] ?? payload?["items"])?.arrayValue?.compactMap(todo) ?? []
            return items.isEmpty ? (nil, missing("the to-dos")) : (.todos(items), nil)
        case .excerpt:
            return excerpt(payload)
        }
    }

    static func missing(_ what: String) -> PartialNoteModel {
        PartialNoteModel("\(what) didn't come with this request — the rest of it is here")
    }

    // MARK: payload.body, field for field

    static func generic(_ kind: RequestBodyKind, _ b: JSONValue) -> RequestBodyBlock? {
        switch kind {
        case .choices:
            return nil
        case .diff:
            let lines = diffLines(b)
            guard !lines.isEmpty else { return nil }
            return .diff(DiffBody(title: b.string("title", "path") ?? "Changes", lines: lines))
        case .thread:
            let messages = threadMessages(b["messages"])
            guard !messages.isEmpty else { return nil }
            return .thread(ThreadBody(location: b.string("location"), code: b["code"]?.arrayValue?.compactMap(\.stringValue) ?? [], messages: messages))
        case .beforeAfter:
            let heading = b.string("heading") ?? "What Approve Does"
            if let before = b["before"], let after = b["after"], let bt = before.string("text"), let at = after.string("text") {
                return .beforeAfter(BeforeAfterBody(heading: heading, content: .versions(
                    before: .init(label: before.string("label") ?? "Before", text: bt),
                    after: .init(label: after.string("label") ?? "After", text: at)
                )))
            }
            let sets = b["sets"] ?? b
            if let before = sets["before"]?.arrayValue?.compactMap(\.stringValue), let after = sets["after"]?.arrayValue?.compactMap(\.stringValue) {
                return .beforeAfter(BeforeAfterBody(heading: heading, content: .sets(before: before, after: after, total: sets.string("total") ?? "\(after.count) in all")))
            }
            return nil
        case .preview:
            guard let text = b.string("text") else { return nil }
            return .preview(PreviewBody(heading: b.string("heading") ?? "What Approve Does", path: b.string("path"), text: text, agentWords: b.bool("agent_words") ?? false))
        case .todos:
            let items = b["items"]?.arrayValue?.compactMap(todo) ?? []
            return items.isEmpty ? nil : .todos(items)
        case .excerpt:
            guard let text = b.string("text") else { return nil }
            return .excerpt(ExcerptBody(text: text, source: b.string("source"), failedAt: WireTime.date(b.string("failed_at")), lastSucceeded: WireTime.date(b.string("last_succeeded")), reason: b.string("reason")))
        }
    }

    // MARK: diff — a pull request's changes (T2-13)

    static func diff(_ payload: JSONValue?) -> (RequestBodyBlock?, PartialNoteModel?) {
        let lines = payload.map(diffLines) ?? []
        guard !lines.isEmpty else { return (nil, missing("the changes")) }
        let title = payload?.string("path") ?? payload.flatMap(pullName) ?? "Changes"
        return (.diff(DiffBody(title: title, lines: lines)), nil)
    }

    /// `lines: [{kind, text}]`, or a unified `patch` — headers dropped, the rest by its first column.
    static func diffLines(_ b: JSONValue) -> [DiffLine] {
        if let listed = b["lines"]?.arrayValue {
            return listed.compactMap { l in
                guard let text = l.string("text") else { return nil }
                switch l.string("kind") {
                case "added", "+": return DiffLine(.added, text)
                case "removed", "-": return DiffLine(.removed, text)
                default: return DiffLine(.context, text)
                }
            }
        }
        guard let patch = b.string("patch", "diff") else { return [] }
        return patch.split(separator: "\n", omittingEmptySubsequences: false).compactMap { raw in
            let line = String(raw)
            if line.hasPrefix("+++") || line.hasPrefix("---") || line.hasPrefix("@@") || line.hasPrefix("diff ") || line.hasPrefix("index ") { return nil }
            if line.hasPrefix("+") { return DiffLine(.added, String(line.dropFirst())) }
            if line.hasPrefix("-") { return DiffLine(.removed, String(line.dropFirst())) }
            if line.hasPrefix(" ") { return DiffLine(.context, String(line.dropFirst())) }
            return line.isEmpty ? nil : DiffLine(.context, line)
        }
    }

    static func pullName(_ p: JSONValue) -> String? {
        guard let repo = p.string("repo"), let number = p["number"]?.intValue else { return nil }
        return "\(repo)#\(number)"
    }

    // MARK: thread — a pull request's review thread (T2-13)

    static func thread(_ payload: JSONValue?) -> (RequestBodyBlock?, PartialNoteModel?) {
        let messages = threadMessages(payload?["messages"] ?? payload?["thread"])
        guard !messages.isEmpty else { return (nil, missing("the conversation")) }
        return (.thread(ThreadBody(location: payload?.string("location", "path"), code: payload?["code"]?.arrayValue?.compactMap(\.stringValue) ?? [], messages: messages)), nil)
    }

    static func threadMessages(_ json: JSONValue?) -> [ThreadMessage] {
        (json?.arrayValue ?? []).compactMap { m in
            guard let text = m.string("text", "body") else { return nil }
            let author = m.string("author", "author_principal") ?? "unknown"
            let byAgent = m.bool("by_agent") ?? (m.string("author_kind") == "agent")
            return ThreadMessage(author: author, byAgent: byAgent, at: WireTime.date(m.string("at", "created_at")), text: text)
        }
    }

    // MARK: before and after — access, an improvement, a conflict

    static func beforeAfter(_ payload: JSONValue?, type: String) -> (RequestBodyBlock?, PartialNoteModel?) {
        if type == "access", let area = payload?.string("area") {
            // packages/mcp-brain/src/access.ts: `current_areas` is the machine-
            // readable half of what it holds; the ask adds one folder.
            let before = payload?["current_areas"]?.arrayValue?.compactMap(\.stringValue) ?? []
            let after = before.contains(area) ? before : before + [area]
            let total = after.count == 1 ? "It would then read 1 folder" : "It would then read \(after.count) folders"
            return (.beforeAfter(BeforeAfterBody(heading: "What Approve Does", content: .sets(before: before, after: after, total: total))), nil)
        }
        if let edit = payload?["suggested_edit"], let path = edit.string("path"), let content = edit.string("content") {
            // routines/reply-review/run.ts: an overlay section to APPEND. Only
            // the section travels; the file it joins is not in the request.
            let block = RequestBodyBlock.beforeAfter(BeforeAfterBody(heading: "What Approve Adds", content: .versions(
                before: .init(label: "\(path) · now", text: ""),
                after: .init(label: "\(path) · with this section", text: content)
            )))
            return (block, PartialNoteModel("only the new section is in this request — the rest of \(path) stays as it is"))
        }
        return (nil, missing(type == "access" ? "the area it asks for" : "what would change"))
    }

    // MARK: preview — what the affirming answer would do

    static func preview(_ payload: JSONValue?, row: RequestRow, type: String) -> (RequestBodyBlock?, PartialNoteModel?) {
        switch type {
        case "action":
            // packages/mcp-brain/src/action-tools.ts: `action: {kind, args}`.
            // Approving something unseen is not a decision (review 01): the
            // payload is shown, a comment's words on the wash.
            guard let action = payload?["action"], let kind = action.string("kind") else { return (nil, missing("what it would do")) }
            let args = action["args"]
            if kind == "comment", let words = args?.string("body", "text") {
                return (.preview(PreviewBody(heading: "What Approve Posts", path: target(args), text: words, agentWords: true)), nil)
            }
            let lines = (args?.objectKeys ?? []).map { key in "\(key): \(Self.verbatim(args?[key]))" }
            return (.preview(PreviewBody(heading: "What Approve Does", path: kind, text: lines.isEmpty ? kind : lines.joined(separator: "\n"))), nil)
        case "review":
            // packages/artifacts/src/service.ts: a thread past its ping-pong
            // cap carries the transcript; a held dispatch, its message.
            if let last = payload?["transcript"]?.arrayValue?.last, let words = last.string("body") {
                return (.preview(PreviewBody(heading: "The Latest Word", path: payload?.string("path"), text: words, agentWords: last.string("author_kind") == "agent")), nil)
            }
            if let message = payload?.string("message") {
                return (.preview(PreviewBody(heading: "What Approve Sends", path: payload?.string("to_agent"), text: message, agentWords: true)), nil)
            }
            return (nil, missing("what it is about"))
        default:
            // collectors/inbox-drain/run.ts: a note's `path`, the owner's `note`,
            // the drain's classification; a calendar or tracker mirror's summary.
            let text = payload?.string("summary", "note", "text", "description") ?? payload?["classification"]?.string("title", "action")
            guard let text, !text.isEmpty else { return (nil, missing("what it would write")) }
            let heading = type == "invitation" ? "The Invitation" : "Where It Would Be Written"
            return (.preview(PreviewBody(heading: heading, path: payload?.string("path"), text: text)), nil)
        }
    }

    static func target(_ args: JSONValue?) -> String? {
        if let work = args?["work_id"]?.intValue { return "work #\(work)" }
        return args?.string("ref", "target", "artifact")
    }

    static func verbatim(_ value: JSONValue?) -> String {
        switch value {
        case .string(let s)?: return s
        case .number(let n)?: return n.rounded() == n && abs(n) < 1e15 ? String(Int(n)) : String(n)
        case .bool(let b)?: return b ? "true" : "false"
        case .null?, nil: return "null"
        case let v?:
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            return (try? encoder.encode(v)).map { String(decoding: $0, as: UTF8.self) } ?? ""
        }
    }

    // MARK: to-dos

    static func todo(_ j: JSONValue) -> TodoItem? {
        guard let text = j.string("text", "title") else { return nil }
        return TodoItem(text, facets: TaskFacets(
            priority: j["priority"]?.intValue,
            due: TaskDay(j.string("due")),
            estimateMinutes: j["estimate_minutes"]?.intValue,
            people: j["people"]?.arrayValue?.compactMap(\.stringValue) ?? []
        ))
    }

    // MARK: excerpt — a report, a mirrored task, a message

    static func excerpt(_ payload: JSONValue?) -> (RequestBodyBlock?, PartialNoteModel?) {
        // A report's `body` is its text (packages/mcp-brain/src/report.ts,
        // apps/reconciler/src/indexer.ts); `summary` is plan-tomorrow's and
        // the fixture's. A failure carries both timestamps (C64, T2-9).
        let text = payload?.string("summary", "excerpt", "snippet", "body", "detail", "text")
        guard let text, !text.isEmpty else { return (nil, missing("the passage it quotes")) }
        let source = payload?.string("source_label", "from") ?? payload?["refs"]?.arrayValue?.first?.stringValue
        return (.excerpt(ExcerptBody(
            text: text,
            source: source,
            failedAt: WireTime.date(payload?.string("failed_at")),
            lastSucceeded: WireTime.date(payload?.string("last_succeeded", "last_success_at")),
            reason: payload?.string("failure", "error_reason")
        )), nil)
    }
}

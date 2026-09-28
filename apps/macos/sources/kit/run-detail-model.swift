// Run detail — what it reads and what it decides (design-build-plan T6-10;
// screen-12-run-detail.md, C78, C79, C95). The view is run-detail-view.swift.
//
// ONE PAGE FOR ANY RUN, opened over the screen it was opened from (an
// Activity row, a project's recent runs) and closed back to it. Three reads,
// each through its own door and nothing else:
//
//   the run            GET /api/runs/:id — `run_detail`: the row, what it
//                      cost, and the tool calls of its turn (joined exactly on
//                      `meta.turn_id`). The one read that outlives the archive.
//   the conversation   GET /api/sessions/:id?turn_id= — `session_detail`: the
//                      turn as the archive kept it (C78) — the system prompt as
//                      sent, the messages, each call's arguments and result.
//                      Keyed by the run's `meta.session_id` and `meta.turn_id`,
//                      which the drain stamps on every turn (drain.ts).
//   what was taken     GET /api/proposals — the session fold's waiting
//                      requests (C79) whose `payload.items` name this session
//                      and turn: *In Needs You*.
//
// WHEN THE TRANSCRIPT IS GONE (components-03 §2, review-01 R2.7). The archive
// keeps a turn 30 days; `session_detail` answers nothing past that, and the
// route says `404`. That is not a failure: the run, its cost and its tool
// calls are still the ledger's, so the page draws them and says, in one line,
// that the transcript expired. A run that names no session at all — a
// routine's own row, a tool call, a turn from before the archive — says that
// instead. Neither is ever drawn as the failed state.
//
// NOTHING IS INFERRED. A call's duration is the ledger's (the side column);
// the conversation shows what the archive kept and nothing joined by guess.
// A session's fold status is its turns' own `folded_at`. Accepted and
// Declined are not served per session (only the waiting queue is), so they
// are not drawn — see docs/ops/mac-app.md "Run detail".

import Foundation

// MARK: - The archive, typed (`GET /api/sessions/:id`)

/// One call as the archive keeps it (apps/assistant/src/archive.ts): what was
/// asked and what came back, both redacted before the row was written.
public struct ArchivedToolCall: Sendable, Equatable {
    /// The provider's call id — the `tool_call_id` its `tool` message answers.
    public let id: String
    public let tool: String
    public let args: JSONValue?
    public let result: JSONValue?
    public let isError: Bool

    public init(id: String, tool: String, args: JSONValue?, result: JSONValue?, isError: Bool) {
        self.id = id
        self.tool = tool
        self.args = args
        self.result = result
        self.isError = isError
    }

    init?(_ json: JSONValue) {
        guard let tool = json.string("tool") else { return nil }
        self.init(id: json.string("id") ?? "", tool: tool, args: json["args"], result: json["result"], isError: json["is_error"]?.boolValue ?? false)
    }
}

/// A call an assistant message asked for, as the message itself says it.
public struct RequestedCall: Sendable, Equatable {
    public let id: String
    public let name: String
    /// The arguments as the model wrote them — a JSON string, usually.
    public let arguments: JSONValue?
}

/// One message of a turn, in order — only the ones that turn added.
public struct ArchivedMessage: Sendable, Equatable {
    /// `system` · `user` · `assistant` · `tool`.
    public let role: String
    public let content: String?
    public let calls: [RequestedCall]
    public let toolCallID: String?

    public init(role: String, content: String?, calls: [RequestedCall] = [], toolCallID: String? = nil) {
        self.role = role
        self.content = content
        self.calls = calls
        self.toolCallID = toolCallID
    }

    init(_ json: JSONValue) {
        let calls: [RequestedCall] = (json["tool_calls"]?.arrayValue ?? []).compactMap { call in
            let name = call["function"]?.string("name") ?? call.string("name")
            guard let name else { return nil }
            return RequestedCall(id: call.string("id") ?? "", name: name, arguments: call["function"]?["arguments"] ?? call["arguments"])
        }
        self.init(role: json.string("role") ?? "", content: Self.text(json["content"]), calls: calls, toolCallID: json.string("tool_call_id"))
    }

    /// A message's words: a string, or the text parts of a parts array.
    static func text(_ content: JSONValue?) -> String? {
        if let s = content?.stringValue { return s }
        guard let parts = content?.arrayValue else { return nil }
        let texts = parts.compactMap { $0.string("text") }
        return texts.isEmpty ? nil : texts.joined(separator: "\n")
    }
}

/// One turn of an archived session.
public struct ArchivedTurn: Sendable, Equatable, Identifiable {
    /// `session_archive.id`.
    public let id: String
    public let sessionID: String
    public let thread: String
    public let turnID: String
    public let at: Date?
    /// The system prompt exactly as it was sent. Empty when the turn ran with none.
    public let systemPrompt: String
    public let messages: [ArchivedMessage]
    public let toolCalls: [ArchivedToolCall]
    /// When the session fold read it; nil is still in its queue.
    public let foldedAt: Date?
    public let expiresAt: Date?

    public init(id: String, sessionID: String, thread: String, turnID: String, at: Date?, systemPrompt: String, messages: [ArchivedMessage], toolCalls: [ArchivedToolCall], foldedAt: Date? = nil, expiresAt: Date? = nil) {
        self.id = id
        self.sessionID = sessionID
        self.thread = thread
        self.turnID = turnID
        self.at = at
        self.systemPrompt = systemPrompt
        self.messages = messages
        self.toolCalls = toolCalls
        self.foldedAt = foldedAt
        self.expiresAt = expiresAt
    }

    /// `{session_id, turns: […], as_of}`, oldest first as the query orders it.
    public static func list(_ json: JSONValue) -> [ArchivedTurn] {
        (json["turns"]?.arrayValue ?? []).map { t in
            ArchivedTurn(
                id: t.string("id") ?? t["id"]?.intValue.map(String.init) ?? "",
                sessionID: t.string("session_id") ?? "",
                thread: t.string("thread") ?? "",
                turnID: t.string("turn_id") ?? "",
                at: WireTime.date(t.string("ts")),
                systemPrompt: t.string("system_prompt") ?? "",
                messages: (t["messages"]?.arrayValue ?? []).map(ArchivedMessage.init),
                toolCalls: (t["tool_calls"]?.arrayValue ?? []).compactMap(ArchivedToolCall.init),
                foldedAt: WireTime.date(t.string("folded_at")),
                expiresAt: WireTime.date(t.string("expires_at"))
            )
        }
    }
}

// MARK: - The conversation, in order

/// One tool call in the conversation: what it asked and what it got (§1).
public struct RunCallEntry: Sendable, Equatable {
    public let tool: String
    public let asked: String
    /// Nil when the archive holds no result for it.
    public let got: String?
    public let failed: Bool

    /// *knowledge.read, failed* — the row, before it is opened.
    public var spoken: String { failed ? "\(tool), failed" : tool }
}

public enum RunConversationEntry: Sendable, Equatable, Identifiable {
    /// The definition layer: the system prompt as sent. Collapsed.
    case definition(id: String, prompt: String)
    /// What the turn was asked to do: the owner's words, or a routine's task.
    case task(id: String, text: String, at: Date?)
    /// The assistant's words.
    case reply(id: String, text: String, at: Date?)
    case call(id: String, RunCallEntry)
    /// A tool's answer with no archived call to hang it on.
    case toolText(id: String, text: String)

    public var id: String {
        switch self {
        case .definition(let id, _), .task(let id, _, _), .reply(let id, _, _), .call(let id, _), .toolText(let id, _): return id
        }
    }
}

public enum RunConversation {
    /// How much of an argument or a result is drawn. The archive keeps it
    /// whole; a page that drew a 200 KB result would be unreadable, and the
    /// ending says how much was left out.
    public static let shownCharacters = 4000

    /// The turns as one conversation: a definition wherever the system prompt
    /// changes, each message in order, each call where the message that asked
    /// for it stands (a `tool` message its call already shows is not drawn
    /// twice), and any call no message asked for at the end of its turn.
    public static func entries(_ turns: [ArchivedTurn]) -> [RunConversationEntry] {
        var out: [RunConversationEntry] = []
        var lastPrompt: String?
        for turn in turns {
            let key = turn.id
            if !turn.systemPrompt.isEmpty, turn.systemPrompt != lastPrompt {
                out.append(.definition(id: "\(key)-definition", prompt: turn.systemPrompt))
                lastPrompt = turn.systemPrompt
            }
            let archived = Dictionary(turn.toolCalls.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            var drawn: Set<String> = []
            for (index, message) in turn.messages.enumerated() {
                let id = "\(key)-\(index)"
                switch message.role {
                case "user":
                    if let text = message.content, !text.isEmpty { out.append(.task(id: id, text: text, at: turn.at)) }
                case "assistant":
                    if let text = message.content, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        out.append(.reply(id: id, text: text, at: turn.at))
                    }
                    for (n, asked) in message.calls.enumerated() {
                        if let call = archived[asked.id], !asked.id.isEmpty {
                            out.append(.call(id: "\(id)-call-\(n)", entry(call)))
                            drawn.insert(asked.id)
                        } else {
                            out.append(.call(id: "\(id)-call-\(n)", RunCallEntry(tool: RunDetailWords.shortTool(asked.name), asked: shown(asked.arguments), got: nil, failed: false)))
                        }
                    }
                case "tool":
                    if let answered = message.toolCallID, drawn.contains(answered) { continue }
                    if let text = message.content, !text.isEmpty { out.append(.toolText(id: id, text: clip(text))) }
                default:
                    // `system` is the definition layer above.
                    continue
                }
            }
            for (n, call) in turn.toolCalls.enumerated() where !drawn.contains(call.id) || call.id.isEmpty {
                out.append(.call(id: "\(key)-unasked-\(n)", entry(call)))
            }
        }
        return out
    }

    static func entry(_ call: ArchivedToolCall) -> RunCallEntry {
        RunCallEntry(tool: RunDetailWords.shortTool(call.tool), asked: shown(call.args), got: call.result.map { shown($0) }, failed: call.isError)
    }

    /// A value as the page shows it: text as it is (a JSON string pretty
    /// printed), anything else as indented JSON.
    static func shown(_ value: JSONValue?) -> String {
        guard let value else { return "—" }
        if case .string(let s) = value {
            if let data = s.data(using: .utf8), let parsed = try? JSONDecoder().decode(JSONValue.self, from: data), parsed.arrayValue != nil || !parsed.objectKeys.isEmpty {
                return shown(parsed)
            }
            return clip(s)
        }
        if case .null = value { return "—" }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(value), let text = String(data: data, encoding: .utf8) else { return "—" }
        return clip(text)
    }

    static func clip(_ text: String) -> String {
        guard text.count > shownCharacters else { return text }
        let rest = text.count - shownCharacters
        return String(text.prefix(shownCharacters)) + "\n… \(rest.formatted()) more characters, kept in the archive"
    }
}

// MARK: - What the assistant took from this (§2, C79)

/// One line the session fold proposed from this session, and where it stands.
public struct RunTakenItem: Sendable, Equatable, Identifiable {
    public let id: String
    /// *Preference* · *Lesson* · *Profile*.
    public let kind: String
    /// Where it would land — `Me/Working Style.md`, `Me/profile.md`.
    public let path: String
    /// What Approve writes.
    public let line: String
    /// Only the waiting queue is served per session, so every item drawn is
    /// *In Needs You* (see the file header).
    public let status: String
    public let requestID: Int

    public var spoken: String { "\(kind), \(line), lands in \(path), \(status)" }

    /// The fold's waiting requests, narrowed to the items this session (and,
    /// when the run names one, this turn) gave.
    public static func from(_ requests: [RequestRow], sessionID: String, turnID: String?) -> [RunTakenItem] {
        var out: [RunTakenItem] = []
        for request in requests where request.decision == nil || request.decision == "pending" {
            let items = request.payload?["items"]?.arrayValue ?? []
            let fallbackPath = request.payload?["edit"]?.string("path")
            for (index, item) in items.enumerated() {
                guard item.string("session_id") == sessionID else { continue }
                if let turnID, let theirs = item.string("turn_id"), theirs != turnID { continue }
                guard let line = item.string("line"), let path = item.string("path") ?? fallbackPath else { continue }
                out.append(RunTakenItem(id: "\(request.id)-\(index)", kind: RunDetailWords.takenKind(item.string("kind")), path: path, line: line, status: RunDetailWords.inNeedsYou, requestID: request.id))
            }
        }
        return out
    }
}

// MARK: - The run's own words

/// The header's pill (C95, amendments §8.3): *ran clean*, or *failed* in
/// `failed` with its own mark, so a failure never differs by colour alone.
public struct RunPill: Sendable, Equatable {
    public let text: String
    public let glyph: MetistryGlyph?
    public let ink: MetistryColorRole
    public let plate: MetistryColorRole

    public init(_ ok: Bool?) {
        switch ok {
        case true?:
            text = "ran clean"; glyph = nil; ink = .textPrimary; plate = .okQuiet
        case false?:
            text = "failed"; glyph = .failed; ink = .failed; plate = .failedQuiet
        case nil:
            text = "running"; glyph = nil; ink = .textSecondary; plate = .sunken
        }
    }
}

/// One line of *The run*: a label and what the ledger says.
public struct RunFact: Sendable, Equatable, Identifiable {
    public let label: String
    public let value: String
    public var id: String { label }
    public var spoken: String { "\(label), \(value)" }
}

/// One call in the side column's sequence, with its share of the longest.
public struct RunToolLine: Sendable, Equatable, Identifiable {
    public let id: Int
    public let tool: String
    public let duration: String?
    /// Of the longest call's duration; nil when the ledger has no duration.
    public let fraction: Double?
    public let failed: Bool
    public let error: String?

    public var spoken: String {
        [tool, duration.map { RunDetailWords.spokenDuration($0) }, failed ? "failed" : nil, error].compactMap { $0 }.joined(separator: ", ")
    }

    public static func lines(_ calls: [RunDetail.RunToolCall]) -> [RunToolLine] {
        let longest = calls.compactMap(\.durationMs).max() ?? 0
        return calls.map { call in
            RunToolLine(
                id: call.id,
                tool: RunDetailWords.shortTool(call.tool ?? "tool"),
                duration: call.durationMs.map(RunDetailWords.duration),
                fraction: call.durationMs.flatMap { longest > 0 ? max(Double($0) / Double(longest), 0.02) : nil },
                failed: call.ok == false,
                error: call.error
            )
        }
    }
}

public enum RunDetailWords {
    public static let inNeedsYou = "In Needs You"
    public static let definition = "Definition"
    public static let task = "Task"
    public static let asked = "Asked"
    public static let got = "Got"
    public static let theRun = "The Run"
    public static let theRoute = "The Route"
    public static let conversation = "Conversation"
    public static let noResult = "No result was kept for this call."
    /// components-03 §2's row, as a sentence.
    public static let expired = "The transcript expired after 30 days. The summary and cost remain."
    public static let purged = "The transcript is no longer in the archive — purged, or never kept. The summary and cost remain."
    public static let notKept = "This run names no archived session, so there is no conversation to show. Its summary and cost are below."
    public static let reading = "Reading the conversation…"
    /// How long the archive keeps a turn (apps/assistant/src/archive.ts `ARCHIVE_TTL_DAYS`).
    public static let archiveDays: TimeInterval = 30

    public static func took(_ name: String?) -> String { "What \(name ?? "It") Took From This" }

    public static func toolCalls(_ shown: Int, total: Int) -> String {
        total > shown ? "Tool Calls · \(shown) of \(total)" : "Tool Calls · \(shown)"
    }

    /// `mcp__brain__knowledge_search` → `knowledge_search`: the tool as the
    /// ledger's own rows name it, never re-cased (P10).
    public static func shortTool(_ name: String) -> String {
        guard name.hasPrefix("mcp__") else { return name }
        let parts = name.components(separatedBy: "__")
        return parts.count >= 3 ? parts.dropFirst(2).joined(separator: "__") : name
    }

    /// The page's title: the routine or component that ran, Title Cased —
    /// or, for the instance's own engine, the configured name (C88).
    public static func title(_ run: RunDetail, assistantName: String?) -> String {
        let component = run.component ?? ""
        if component == AgentChipModel.assistantPrincipal || component.isEmpty {
            return assistantName ?? "Run \(run.id)"
        }
        return component.split(whereSeparator: { $0 == "-" || $0 == "_" }).map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
    }

    /// *Tuesday 22 Sep · 6:02 AM*.
    public static func when(_ date: Date, clock: ClockTime) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = clock.timeZone
        f.dateFormat = "EEEE d MMM"
        return "\(f.string(from: date)) · \(clock.time(date))"
    }

    /// The failure in one sentence (§3): the ledger's own words.
    public static func failure(_ run: RunDetail) -> String? {
        guard run.ok == false else { return nil }
        let failedCalls = run.toolCallsFailed
        let lead: String
        switch failedCalls {
        case 0: lead = "It failed"
        case 1: lead = "It failed at one tool call"
        default: lead = "It failed at \(failedCalls) tool calls"
        }
        return run.error.map { "\(lead): \($0)" } ?? "\(lead)."
    }

    /// *2.1¢* under a dollar, *$1.23* from one.
    public static func cost(_ usd: Double) -> String {
        usd >= 1 ? String(format: "$%.2f", usd) : String(format: "%.1f¢", usd * 100)
    }

    /// *900* · *18.4k* · *1.2M*.
    public static func tokens(_ n: Int) -> String {
        if n < 1000 { return "\(n)" }
        if n < 1_000_000 { return String(format: "%.1fk", Double(n) / 1000) }
        return String(format: "%.1fM", Double(n) / 1_000_000)
    }

    /// *40ms* · *1.2s* · *1m 12s* — a duration, never a clock time.
    public static func duration(_ ms: Int) -> String {
        if ms < 1000 { return "\(ms)ms" }
        if ms < 60_000 { return String(format: "%.1fs", Double(ms) / 1000) }
        return ClockTime.duration(Double(ms) / 1000)
    }

    static func spokenDuration(_ shown: String) -> String {
        if shown.hasSuffix("ms") { return "\(shown.dropLast(2)) milliseconds" }
        if shown.hasSuffix("s"), !shown.contains("m") { return "\(shown.dropLast()) seconds" }
        return shown
    }

    /// The share the provider's cache served: read ÷ (read + fresh + written),
    /// the same sum the usage query uses (`claude_usage_daily`).
    public static func cacheShare(_ run: RunDetail) -> Double? {
        guard let read = run.cacheReadTokens, read > 0 else { return nil }
        let whole = read + (run.tokensIn ?? 0) + (run.cacheWriteTokens ?? 0)
        return whole > 0 ? Double(read) / Double(whole) : nil
    }

    /// *The run* (§1): provider and model, time, tokens, cache, cost — each
    /// only when the ledger has it.
    public static func facts(_ run: RunDetail) -> [RunFact] {
        var out: [RunFact] = []
        switch (run.model, run.provider) {
        case let (model?, provider?): out.append(RunFact(label: "Model", value: "\(model) · \(provider)"))
        case let (model?, nil): out.append(RunFact(label: "Model", value: model))
        case let (nil, provider?): out.append(RunFact(label: "Provider", value: provider))
        default: break
        }
        if let tier = run.meta?.string("tier") { out.append(RunFact(label: "Tier", value: tier)) }
        if let ms = run.durationMs { out.append(RunFact(label: "Time", value: duration(ms))) }
        if run.tokensIn != nil || run.tokensOut != nil {
            let parts = [run.tokensIn.map { "\(tokens($0)) in" }, run.tokensOut.map { "\(tokens($0)) out" }].compactMap { $0 }
            out.append(RunFact(label: "Tokens", value: parts.joined(separator: " · ")))
        }
        if let share = cacheShare(run) { out.append(RunFact(label: "Cache", value: "\(Int((share * 100).rounded()))% from cache")) }
        if let usd = run.costUSD { out.append(RunFact(label: "Cost", value: cost(usd))) }
        if let shadow = run.shadowModel ?? run.shadowProvider {
            let agreement = run.shadowAgreement.map { String(format: " · agreement %.2f", $0) } ?? ""
            out.append(RunFact(label: "Shadow", value: "\(shadow)\(agreement)"))
        }
        return out
    }

    /// *The route* (§2.8, T9-1): a `kind: route` row's own record — what the
    /// rules served, what the policy said, and whether they agree. Only this
    /// row's `meta`; a turn's route row is a separate row of the ledger.
    public static func route(_ run: RunDetail) -> [RunFact] {
        guard run.kind == "route", let meta = run.meta else { return [] }
        var out: [RunFact] = []
        if let served = meta["served"] {
            let words = [served.string("kind"), served.string("tier"), served.string("operation"), served.string("routed_by").map { "by \($0)" }].compactMap { $0 }
            if !words.isEmpty { out.append(RunFact(label: "Served", value: words.joined(separator: " · "))) }
        }
        if let outcome = meta["policy"]?.string("outcome") { out.append(RunFact(label: "Policy", value: outcome)) }
        if let would = meta["policy"]?["would_serve"] {
            let words = [would.string("operation"), would.string("tier")].compactMap { $0 }
            if !words.isEmpty { out.append(RunFact(label: "Would serve", value: words.joined(separator: " · "))) }
        }
        if let bounded = meta["policy"]?["bounded_by"]?.arrayValue?.compactMap(\.stringValue), !bounded.isEmpty {
            out.append(RunFact(label: "Bounded by", value: bounded.joined(separator: ", ")))
        }
        if let agrees = meta["agrees"]?.boolValue { out.append(RunFact(label: "Agrees", value: agrees ? "yes" : "no")) }
        return out
    }

    /// The fold's word for an item's kind, as the page names it (§2).
    static func takenKind(_ kind: String?) -> String {
        switch kind {
        case "preference": return "Preference"
        case "lesson": return "Lesson"
        case "profile": return "Profile"
        case "knowledge": return "Knowledge"
        case let other?: return other.prefix(1).uppercased() + other.dropFirst()
        case nil: return "Item"
        }
    }

    /// Where the fold stands on this session, from its turns' own `folded_at`.
    public static func foldLine(_ turns: [ArchivedTurn], clock: ClockTime, now: Date) -> String? {
        guard !turns.isEmpty else { return nil }
        if turns.allSatisfy({ $0.foldedAt != nil }) { return "The fold has read this. Nothing from it is waiting in Needs You." }
        let kept = turns.compactMap(\.expiresAt).min().map { " It is kept until \(clock.day($0))." } ?? ""
        return "The fold hasn't read this yet.\(kept)"
    }

    /// The session and turn the archive keys this run by (drain.ts).
    public static func archiveKey(_ run: RunDetail) -> (session: String, turn: String?)? {
        guard let session = run.meta?.string("session_id") ?? run.sessionID, !session.isEmpty else { return nil }
        return (session, run.meta?.string("turn_id"))
    }
}

// MARK: - The model

/// One of the page's reads, in one of three states.
public enum RunDetailRead<Value: Sendable & Equatable>: Sendable, Equatable {
    case waiting
    case loaded(Value)
    case failed(String)

    public var value: Value? { if case .loaded(let v) = self { return v } else { return nil } }
}

/// The conversation's read, in the states components-03 §2 names.
public enum RunConversationState: Sendable, Equatable {
    case waiting
    case loaded([ArchivedTurn])
    /// The run names no archived session.
    case notKept
    /// The archive answered nothing for it: past 30 days, or purged.
    case gone(expired: Bool)
    case failed(String)
}

@MainActor
@Observable
public final class RunDetailModel {
    /// A run on screen, and the screen it was opened over.
    public struct Opening: Sendable, Equatable {
        public let runID: Int
        public let over: Destination
    }

    public private(set) var opening: Opening?
    public private(set) var run: RunDetailRead<RunDetail> = .waiting
    public private(set) var conversation: RunConversationState = .waiting
    /// Nil where there is no session to ask about.
    public private(set) var taken: RunDetailRead<[RunTakenItem]>?

    @ObservationIgnored private weak var session: ConsoleSession?
    @ObservationIgnored public let now: () -> Date
    @ObservationIgnored public let clock: ClockTime

    public init(session: ConsoleSession, timeZone: TimeZone = .current, now: @escaping () -> Date = Date.init) {
        self.session = session
        self.now = now
        self.clock = ClockTime(timeZone: timeZone)
        session.register { [weak self] in
            self?.close()
            return self != nil
        }
    }

    /// Open a run over the screen it was chosen on. The view's task reads it.
    public func open(_ runID: Int, over destination: Destination) {
        opening = Opening(runID: runID, over: destination)
        run = .waiting
        conversation = .waiting
        taken = nil
    }

    /// Back to the screen it was opened over.
    public func close() {
        opening = nil
        run = .waiting
        conversation = .waiting
        taken = nil
    }

    /// Whether the page stands over this destination.
    public func isShowing(over destination: Destination) -> Bool {
        opening?.over == destination
    }

    /// The three reads, in order: the run first, because it names the rest.
    public func load() async {
        guard let session, let opening else { return }
        let generation = session.generation
        func current() -> Bool { session.generation == generation && self.opening == opening }

        let answer = await session.stores.run(opening.runID)
        guard current() else { return }
        let detail: RunDetail
        switch answer {
        case .success(let reply):
            detail = reply.run
            run = .loaded(detail)
        case .failure(let e):
            if case .loaded = run { return }
            run = .failed(Self.problem(e))
            return
        }

        guard let key = RunDetailWords.archiveKey(detail) else {
            conversation = .notKept
            taken = nil
            return
        }
        if case .loaded = conversation {} else { conversation = .waiting }
        let turns = await session.stores.session(key.session, turnID: key.turn)
        guard current() else { return }
        switch turns {
        case .success(let body):
            conversation = .loaded(ArchivedTurn.list(body.json))
        case .failure(.http(status: 404, _)):
            let age = WireTime.date(detail.ts).map { now().timeIntervalSince($0) } ?? 0
            conversation = .gone(expired: age >= RunDetailWords.archiveDays * 86_400)
        case .failure(let e):
            conversation = .failed(Self.problem(e))
        }

        if taken == nil { taken = .waiting }
        let queue = await session.stores.requests()
        guard current() else { return }
        switch queue {
        case .success(let page):
            taken = .loaded(RunTakenItem.from(page.proposals, sessionID: key.session, turnID: key.turn))
        case .failure(let e):
            if case .loaded? = taken { return }
            taken = .failed(Self.problem(e))
        }
    }

    public var detail: RunDetail? { run.value }

    /// The conversation's entries, when there are any.
    public var entries: [RunConversationEntry] {
        if case .loaded(let turns) = conversation { return RunConversation.entries(turns) }
        return []
    }

    public var turns: [ArchivedTurn] {
        if case .loaded(let turns) = conversation { return turns }
        return []
    }

    /// The vault file a routine run wrote, for Open in Obsidian.
    public var writtenPath: String? {
        detail?.meta?.string("path").flatMap { $0.isEmpty ? nil : $0 }
    }

    nonisolated static func problem(_ e: ConsoleError) -> String {
        e.refusal ?? e.localizedDescription
    }
}

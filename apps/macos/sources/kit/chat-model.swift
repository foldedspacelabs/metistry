// Chat — the screen's state (design-build-plan T6-2; screen-01-chat.md; C16,
// C69, C72; components-03 §2's Chat row).
//
// BUILT ON THE SERVED SHAPE, AND ONLY ON IT. Every fact on this screen is one
// route's answer, read through the F-7 stores:
//
//     the transcript        GET /api/messages?limit=30   (ChatStore.messages)
//     sending               POST /message                (ChatStore.send)
//     tapbacks              POST|DELETE /api/messages/:id/feedback
//     the tool strip        GET /api/turns/:turn_id/progress
//     which turn a message  GET /api/q/activity_feed?kind=turn, then
//       started               GET /api/runs/:id — its `meta.message_id`
//     the tier picker       GET /api/commands (the `model_override` rows)
//     the prompt card       GET /api/proposals — the `decision` row whose
//                           `payload.message_id` is the reply's id
//     the preview pane      GET /api/knowledge/page?path=
//
// WHAT THE WIRE DOES NOT SAY, THIS DOES NOT GUESS. A message row carries no
// `turn_id` and no `in_reply_to`, so a tool strip is attached to the message
// that STARTED a turn, joined exactly — the turn's `runs` row names that
// message in `meta.message_id` (apps/assistant/src/drain.ts) — and never to a
// reply by adjacency or a time window, which is how `run_detail` and
// `turn_progress` say a call must never be attributed. A turn is working while
// its message's own `status` says `new` or `processing`, finished at `done`,
// failed at `failed`: the server's word, never inferred from whether a reply
// has shown up. The 60-second line is the one client-side judgement, and it
// reports what it knows — nothing back for 62s — never that anything is stuck.
//
// P9, AS A RULE IN CODE. A reply that arrives while the reader is scrolled up
// is appended and nothing else: `arrival` says `.pill`, the view does not
// scroll, the rows already on screen keep their identity (so they do not
// redraw), and focus is never touched from here. Only the pill, pressed,
// scrolls.
//
// O3. `POST /message` is a decision (`ConsoleAct`: "a message" — a reply three
// hours late into a moved-on thread confuses more than it helps), so while the
// instance is unreachable Send is off with the gate's sentence under it, and a
// send the gate refuses anyway is kept on screen as *Not sent* with Retry. A
// rating is an append and is always sent.
//
// THE NAME. The assistant's configured name arrives from the shell; nothing
// here holds a default for it, and no string here says *assistant*.

import Foundation
import Observation
import SwiftUI

// MARK: - One message, typed

/// One row of `GET /api/messages`: `{id, ts, thread, text, status, direction,
/// feedback, tier, cursor}`. Inbound and outbound ids are separate sequences,
/// so a row is identified by its direction and its id together.
public struct ChatMessage: Sendable, Equatable, Identifiable {
    public enum Direction: String, Sendable {
        /// `in` — what the owner sent.
        case yours = "in"
        /// `out` — what came back: a reply, an ack, a brief, an alert.
        case reply = "out"
    }

    public let messageID: Int
    public let direction: Direction
    public let ts: Date?
    public let thread: String
    public let text: String
    /// Inbound: `new` · `processing` · `done` · `failed`. Outbound: its kind —
    /// `reply` · `ack` · `brief` · `review` · `alert`.
    public let status: String
    /// The tier the router (or the picker) put on an inbound row.
    public let tier: String?
    /// An outbound row's rating, when it has one.
    public let rating: Rating?
    public let note: String?

    public var id: String { "\(direction.rawValue):\(messageID)" }

    public init(messageID: Int, direction: Direction, ts: Date?, thread: String = "default", text: String, status: String, tier: String? = nil, rating: Rating? = nil, note: String? = nil) {
        self.messageID = messageID
        self.direction = direction
        self.ts = ts
        self.thread = thread
        self.text = text
        self.status = status
        self.tier = tier
        self.rating = rating
        self.note = note
    }

    /// Nil for a row this build cannot place: no id, or a direction it does not know.
    public init?(json: JSONValue) {
        guard let direction = json.string("direction").flatMap(Direction.init(rawValue:)),
              let id = json.string("id").flatMap({ Int($0) }) ?? json.int("id")
        else { return nil }
        let feedback = json["feedback"]
        self.init(
            messageID: id,
            direction: direction,
            ts: WireTime.date(json.string("ts")),
            thread: json.string("thread") ?? "default",
            text: json.string("text") ?? "",
            status: json.string("status") ?? "",
            tier: json.string("tier"),
            rating: feedback?.int("rating").flatMap(Rating.init(rawValue:)),
            note: feedback?.string("note")
        )
    }

    /// Order in the transcript: by time, the owner's turn before a reply that
    /// shares its instant, then by id.
    static func precedes(_ a: ChatMessage, _ b: ChatMessage) -> Bool {
        let ta = a.ts ?? .distantPast, tb = b.ts ?? .distantPast
        if ta != tb { return ta < tb }
        if a.direction != b.direction { return a.direction == .yours }
        return a.messageID < b.messageID
    }
}

public extension MessagePage {
    /// The page's rows, typed. A row that cannot be placed is left out, never a decode failure.
    var chatMessages: [ChatMessage] { (json["messages"]?.arrayValue ?? []).compactMap(ChatMessage.init(json:)) }
    var cursor: String? { json.string("cursor") }
    var more: Bool { json.bool("more") ?? false }
}

// MARK: - A turn's state, as its message says it

public enum ChatTurnState: String, Sendable, Equatable {
    /// `new` or `processing`: the assistant has it, or will next.
    case working
    /// `done`.
    case finished
    /// `failed` — the server said so, which is the only way a turn fails here.
    case failed

    public init?(inboundStatus status: String) {
        switch status {
        case "new", "processing": self = .working
        case "done": self = .finished
        case "failed": self = .failed
        default: return nil
        }
    }
}

// MARK: - The tool calls of a turn

/// One row of `turn_progress`: `{id, tool, started_at, finished_at, ok, error, duration_ms}`.
public struct ChatToolCall: Sendable, Equatable, Identifiable {
    public let id: Int
    public let tool: String
    public let ok: Bool?
    public let error: String?
    public let durationMs: Int?
    /// A row with an outcome has finished whether or not it carries a
    /// `finished_at` — `finishRun` writes all three, and a recorded fixture
    /// may write only the outcome. No outcome and no `finished_at` is the
    /// still-running call (`seed/queries/turn_progress.yaml`).
    public let isRunning: Bool

    public init(id: Int, tool: String, ok: Bool?, error: String? = nil, durationMs: Int? = nil, isRunning: Bool = false) {
        self.id = id
        self.tool = tool
        self.ok = ok
        self.error = error
        self.durationMs = durationMs
        self.isRunning = isRunning
    }

    public init?(json: JSONValue) {
        guard let id = json.string("id").flatMap({ Int($0) }) ?? json.int("id") else { return nil }
        let ok = json.bool("ok")
        let finished = json.string("finished_at") != nil
        self.init(
            id: id,
            tool: json.string("tool") ?? "",
            ok: ok,
            error: json.string("error"),
            durationMs: json.int("duration_ms"),
            isRunning: !finished && ok == nil
        )
    }

    public var failed: Bool { ok == false }
}

public extension TurnProgress {
    var calls: [ChatToolCall] { (json["calls"]?.arrayValue ?? []).compactMap(ChatToolCall.init(json:)) }
}

/// What a read of a `turn` run found: the message it answered, and its handle.
struct ChatTurnRun: Sendable, Equatable {
    let runID: Int
    let turnID: String
    let durationMs: Int?
    let costUSD: Double?
}

/// What the owner's one message set going: the turn the console ran for it,
/// joined exactly (`runs.meta.message_id`), and its calls so far.
public struct ChatTurnActivity: Sendable, Equatable {
    public let messageID: Int
    public var turnID: String?
    public var runID: Int?
    public var calls: [ChatToolCall] = []
    /// When the turn began, as this Mac knows it: the send, or the message's own `ts`.
    public var startedAt: Date
    /// The last moment anything new arrived for this turn — the 60 s line's clock.
    public var lastNewsAt: Date
    public var state: ChatTurnState
    /// The turn's own `runs` row, once it has finished.
    public var durationMs: Int?
    public var costUSD: Double?
    /// The owner opened or closed the strip; nil is the default — collapsed,
    /// and open only when a call failed (the one case the system opens something).
    public var expandedByOwner: Bool?

    public init(messageID: Int, startedAt: Date, state: ChatTurnState) {
        self.messageID = messageID
        self.startedAt = startedAt
        self.lastNewsAt = startedAt
        self.state = state
    }

    public var isExpanded: Bool { expandedByOwner ?? calls.contains(where: \.failed) }
    /// Drawn while it works, when it failed, or once it made a call — a turn
    /// that finished having called nothing leaves nothing to show.
    public var isShown: Bool { state != .finished || !calls.isEmpty }
    public var runningTool: String? { calls.last(where: \.isRunning)?.tool }
}

// MARK: - The four waiting moments (screen-01 §5.1, C16)

public enum ChatWaitingMoment: Sendable, Equatable {
    /// Nothing back yet: three dots and the word.
    case dots
    /// A tool name exists to print: the running one (or none between calls),
    /// the count and the elapsed seconds — every frame a fact.
    case tools(running: String?, count: Int, elapsed: TimeInterval)
    /// Sixty seconds and nothing new: the count of seconds, on `degraded-quiet`.
    case silent(nothingBackFor: TimeInterval, count: Int)

    /// The moment a working turn is in. Token streaming is not in v1 (§2.20), so
    /// *prose streaming* has nothing to draw from and is not one of these.
    public static func of(_ activity: ChatTurnActivity, now: Date) -> ChatWaitingMoment? {
        guard activity.state == .working else { return nil }
        let quiet = now.timeIntervalSince(activity.lastNewsAt)
        if quiet >= ChatModel.silentAfter {
            return .silent(nothingBackFor: quiet, count: activity.calls.count)
        }
        if activity.calls.isEmpty { return .dots }
        return .tools(running: activity.runningTool, count: activity.calls.count, elapsed: now.timeIntervalSince(activity.startedAt))
    }
}

/// The waiting dots (C16): the product's one loop, and it holds flat under
/// Reduce Motion — the elapsed count then carries the liveness on its own.
public enum ChatDots {
    /// The loop's period, and the flat value Reduce Motion holds.
    public static let period: TimeInterval = 1.45
    public static let flat: Double = 0.5

    /// Whether the dots move at all.
    public static func isAnimated(reduceMotion: Bool) -> Bool { !reduceMotion }

    /// The three opacities at a moment. Under Reduce Motion, flat at every moment.
    public static func opacities(at time: TimeInterval, reduceMotion: Bool) -> [Double] {
        guard isAnimated(reduceMotion: reduceMotion) else { return [flat, flat, flat] }
        let phase = (time.truncatingRemainder(dividingBy: period)) / period
        return (0..<3).map { i in
            // each dot a third of a period behind the one before; 0.3 … 1
            let t = (phase - Double(i) / 3).truncatingRemainder(dividingBy: 1)
            let wave = 0.5 + 0.5 * cos(2 * .pi * (t < 0 ? t + 1 : t))
            return 0.3 + 0.7 * wave
        }
    }
}

// MARK: - A send not yet in the transcript

/// The owner's turn, written before the request leaves (§5.1: "the optimistic
/// turn is written before the request leaves"), until the console's own row
/// for it arrives.
public struct ChatLocalTurn: Sendable, Equatable, Identifiable {
    public enum State: Sendable, Equatable {
        case sending
        /// Accepted (`202`); waiting for its row to come back in the transcript.
        case sent(messageID: Int)
        /// Not sent — the reason, and whether O3 held it before it left.
        case notSent(reason: String, held: Bool)
    }

    public let id: UUID
    public let text: String
    public let tier: String?
    public let sentAt: Date
    public var state: State

    public var messageID: Int? {
        if case .sent(let id) = state { return id }
        return nil
    }
}

// MARK: - The tier picker (§3c), from `GET /api/commands`

/// One tier the composer can pin, read from a command that routes to it.
public struct ChatTier: Sendable, Equatable, Identifiable {
    public let name: String
    /// What the tier resolves to right now — `compute.yaml`'s assignment, else
    /// `rules.yaml`'s `tiers:` — as the console reported it.
    public let model: String?
    public let effort: String?
    /// The command's own line, which says what the tier is for.
    public let about: String?

    public var id: String { name }

    /// The tiers `GET /api/commands` names in a field: every `model_override`
    /// row's `tier`, first spelling wins, in the console's own order. A tier
    /// that is only named inside a description's prose is not read out of it.
    public static func from(_ menu: CommandMenu) -> [ChatTier] {
        var seen = Set<String>()
        var out: [ChatTier] = []
        for entry in menu.commands where entry.routesTo == "model_override" {
            guard let name = entry.tier, !name.isEmpty, seen.insert(name).inserted else { continue }
            out.append(ChatTier(name: name, model: entry.model, effort: entry.effort, about: entry.description))
        }
        return out
    }
}

public enum ChatPinScope: String, Sendable, Equatable, CaseIterable {
    case turn = "This Turn"
    case conversation = "This Conversation"
}

public struct ChatPin: Sendable, Equatable {
    public let tier: String
    public let scope: ChatPinScope
}

// MARK: - Page references in a reply (§3a, §3b)

/// A vault page a reply links to — Obsidian's `[[wikilink]]`, the vault's own
/// convention — which the preview pane opens through `GET /api/knowledge/page`.
public struct ChatPageReference: Sendable, Equatable, Identifiable {
    /// The link as written, minus any alias or heading.
    public let target: String
    /// The vault path asked for: the target, with `.md` when it names no extension.
    public let path: String
    /// What the chip prints: the alias when there is one, else the last path component.
    public let name: String

    public var id: String { path }

    /// Every distinct page a text links to, in order, at most `limit`.
    public static func all(in text: String, limit: Int = 6) -> [ChatPageReference] {
        var out: [ChatPageReference] = []
        var seen = Set<String>()
        var rest = Substring(text)
        while let open = rest.range(of: "[["), let close = rest[open.upperBound...].range(of: "]]") {
            let inner = rest[open.upperBound..<close.lowerBound]
            rest = rest[close.upperBound...]
            let parts = inner.split(separator: "|", maxSplits: 1, omittingEmptySubsequences: false)
            let target = String(parts[0].split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false)[0]).trimmingCharacters(in: .whitespaces)
            guard !target.isEmpty, !target.contains("\n"), !target.hasPrefix("/"), !target.contains("..") else { continue }
            let last = target.split(separator: "/").last.map(String.init) ?? target
            let path = last.contains(".") ? target : target + ".md"
            guard seen.insert(path).inserted else { continue }
            let alias = parts.count > 1 ? String(parts[1]).trimmingCharacters(in: .whitespaces) : ""
            out.append(ChatPageReference(target: target, path: path, name: alias.isEmpty ? last : alias))
            if out.count == limit { break }
        }
        return out
    }
}

/// The preview pane's one page.
public struct ChatPreview: Sendable, Equatable {
    public enum State: Sendable, Equatable {
        case loading
        case loaded(KnowledgePage)
        /// The console's own reason, verbatim.
        case failed(String)
    }

    public let reference: ChatPageReference
    public var state: State
}

// MARK: - Arrival (P9)

/// What an arriving reply may do to the viewport. There is no case that
/// scrolls a reader who is not at the bottom.
public enum ChatArrival: Sendable, Equatable {
    /// At the bottom already: stay there.
    case follow
    /// Scrolled up: append silently and show *↓ New Reply*.
    case pill
    /// Nothing new arrived.
    case none

    public static func of(newReplies: Int, isAtBottom: Bool) -> ChatArrival {
        guard newReplies > 0 else { return .none }
        return isAtBottom ? .follow : .pill
    }
}

// MARK: - The model

@MainActor
@Observable
public final class ChatModel {
    /// `GET /api/messages?limit=30` (screen-01 §8).
    public nonisolated static let pageSize = 30
    /// The 60 s line (§5.1).
    public nonisolated static let silentAfter: TimeInterval = 60
    /// While a turn is in flight the transcript, the binding and the strip are
    /// asked this often — the pace the PWA polls a waiting chat at.
    public nonisolated static let inFlightInterval: TimeInterval = 1.5
    /// …and past the 60 s line, while nothing is coming back.
    public nonisolated static let silentInterval: TimeInterval = 5
    /// The one control on this screen with nothing behind it: the console has
    /// no route that cancels a turn. Drawn, off, and saying so (C138).
    public nonisolated static let stopUnavailable = "This build can't stop a turn yet — the console has no route that cancels one"

    /// The newest page. T5-7 invalidates it on `message.new`; the screen asks
    /// through it and merges what it answers into `messages`.
    public let transcript: SectionModel<MessagePage>
    public let commands: SectionModel<CommandMenu>
    /// The pending requests, for the prompt card a reply carries.
    public let requests: SectionModel<RequestPage>

    /// Every message this screen has read, in transcript order.
    public private(set) var messages: [ChatMessage] = []
    public private(set) var localTurns: [ChatLocalTurn] = []
    /// Keyed by the inbound message that started the turn.
    public private(set) var activities: [Int: ChatTurnActivity] = [:]

    public var draft = ""
    public private(set) var pin: ChatPin?
    /// *↓ New Reply* (P9).
    public private(set) var showsNewReplyPill = false
    /// Bumped when the transcript should move to its end: the owner sent, or a
    /// reply arrived while they were already there.
    public private(set) var followRequests = 0
    /// Where the reader is; the view reports it.
    public var isAtBottom = true
    public private(set) var preview: ChatPreview?
    /// A rating the console refused, and why — shown on that reply.
    public private(set) var ratingProblem: (messageID: Int, text: String)?

    /// Posts a VoiceOver announcement. Injected so a test can hear it.
    @ObservationIgnored public var announce: @MainActor (String) -> Void = { text in
        AccessibilityNotification.Announcement(text).post()
    }
    @ObservationIgnored public var now: @MainActor () -> Date
    /// Whether a working turn is watched off-screen. A test drives the clock itself.
    @ObservationIgnored public var watchesInBackground = true
    @ObservationIgnored private weak var session: ConsoleSession?
    /// A sent message's row is drawn under the local turn's identity, so the
    /// row the owner watched appear is never replaced by another.
    @ObservationIgnored private var renderIDs: [Int: UUID] = [:]
    /// Ratings sent and not yet reflected in a read: the value on screen until then.
    private var ratingOverrides: [Int: Rating?] = [:]
    /// `runs` ids already read for their `meta.message_id`.
    @ObservationIgnored private var examinedRuns: Set<Int> = []
    /// What those reads found: the turn each message started.
    @ObservationIgnored private var turnsByMessage: [Int: ChatTurnRun] = [:]
    @ObservationIgnored private var runsToExamine: [Int] = []
    @ObservationIgnored private var lastInFlightAsk: Date?
    @ObservationIgnored private var hasRead = false
    @ObservationIgnored private var tickInFlight: Task<Void, Never>?
    @ObservationIgnored private var watchTask: Task<Void, Never>?
    @ObservationIgnored private var requestCards: (name: String, generation: Int, cards: RequestCards)?
    /// Prompt cards once drawn stay, so an answered one keeps its receipt.
    @ObservationIgnored private var promptRows: [Int: RequestRow] = [:]

    public init(session: ConsoleSession, now: @escaping @MainActor () -> Date = { Date() }) {
        self.session = session
        self.now = now
        transcript = SectionModel(session: session, policy: .feed, topics: [.chat]) { stores in
            await stores.messages(limit: ChatModel.pageSize, since: nil).map { ($0, nil) }
        }
        commands = SectionModel(session: session, policy: .configuration, topics: [.configuration]) { stores in
            await stores.commands().map { ($0, WireTime.date($0.asOf)) }
        }
        requests = SectionModel(session: session, policy: .requests, topics: [.needsYou]) { stores in
            await stores.requests().map { ($0, nil) }
        }
        session.register { [weak self] in
            guard let self else { return false }
            self.reset()
            return true
        }
        // A turn's run starting or finishing, a call in it starting or ending:
        // the working indicator is due now, not at the next in-flight tick.
        session.events.watch([.working]) { [weak self] event in
            guard let self else { return false }
            self.apply(event)
            return true
        }
    }

    /// An instance switch: everything the last instance said is dropped.
    public func reset() {
        messages = []
        localTurns = []
        activities = [:]
        pin = nil
        showsNewReplyPill = false
        preview = nil
        ratingProblem = nil
        renderIDs = [:]
        ratingOverrides = [:]
        examinedRuns = []
        turnsByMessage = [:]
        runsToExamine = []
        lastInFlightAsk = nil
        hasRead = false
        requestCards = nil
        promptRows = [:]
        watchTask?.cancel()
        watchTask = nil
    }

    // MARK: Reading

    /// Something is working: a send on its way, or a turn the console has not finished.
    public var isWorking: Bool {
        localTurns.contains { $0.state == .sending } || activities.values.contains { $0.state == .working }
    }

    /// O3 — `POST /message` is a decision.
    public var allowsSending: Bool { session?.allowsDecisions ?? false }
    public var sendingUnavailableReason: String? {
        guard !allowsSending else { return nil }
        return StateWords.unreachable
    }

    /// One tick: every read that is due. A redraw is never a request. Ticks
    /// run one after another — the screen's clock, the background watch and a
    /// send's own read never interleave — and a tick that waited still asks
    /// only what is due by then.
    public func tick() async {
        while let other = tickInFlight { await other.value }
        let task = Task { @MainActor in await self.runTick() }
        tickInFlight = task
        await task.value
        tickInFlight = nil
    }

    private func runTick() async {
        let at = now()
        if isWorking, lastInFlightAsk.map({ at.timeIntervalSince($0) >= inFlightInterval(now: at) }) ?? true {
            lastInFlightAsk = at
            transcript.invalidate()
            await transcript.refreshIfDue(now: at)
            await settle(merge())
            await bindTurns()
            await readProgress()
        } else {
            await transcript.refreshIfDue(now: at)
            await settle(merge())
        }
        await commands.refreshIfDue(now: at)
        await requests.refreshIfDue(now: at)
        if isWorking { watchWhileWorking() }
    }

    /// How often a working turn is asked about: the in-flight pace, backed off
    /// like any read while the console is not answering, and slower once the
    /// 60 s line is showing — that line counts on the clock, not on requests.
    func inFlightInterval(now at: Date) -> TimeInterval {
        if transcript.consecutiveFailures > 0 {
            return max(Self.inFlightInterval, transcript.policy.nextDelay(consecutiveFailures: transcript.consecutiveFailures))
        }
        // While the stream is live, a run or a call moving says so at once
        // (`apply`), so the clock is only the net under it.
        if session?.events.isLive == true { return Self.silentInterval }
        let quiet = activities.values.filter { $0.state == .working }.map { at.timeIntervalSince($0.lastNewsAt) }.min() ?? 0
        return quiet >= Self.silentAfter ? Self.silentInterval : Self.inFlightInterval
    }

    /// Ask now, whatever the clock says — the first paint and Try Again.
    public func refresh() async {
        await transcript.refresh(background: transcript.section.hasValue)
        await settle(merge())
        await bindTurns()
        await readProgress()
        await commands.refreshIfDue(now: now())
        await requests.refreshIfDue(now: now())
        if isWorking { watchWhileWorking() }
    }

    /// Keeps asking while a turn works, whether or not the screen is showing —
    /// the sidebar's dot has to survive walking away (§5.1).
    public func watchWhileWorking() {
        guard watchesInBackground, watchTask == nil else { return }
        watchTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, self.isWorking else { break }
                await self.tick()
                try? await Task.sleep(for: .seconds(1))
            }
            self?.watchTask = nil
        }
    }

    /// Folds the newest page into what is on screen. A row already there is
    /// replaced only if the console changed it, so an unchanged row keeps its
    /// value — and its view is not redrawn (P9). Answers the turns that have
    /// just finished or failed, for `settle` to read once more.
    @discardableResult
    func merge() -> [Int] {
        guard let page = transcript.section.value else { return [] }
        let first = !hasRead
        hasRead = true
        var byID = Dictionary(uniqueKeysWithValues: messages.map { ($0.id, $0) })
        var newReplies = 0
        for message in page.chatMessages {
            if byID[message.id] == nil, message.direction == .reply { newReplies += 1 }
            if byID[message.id] != message { byID[message.id] = message }
            if message.direction == .reply, let override = ratingOverrides[message.messageID], override == message.rating {
                ratingOverrides[message.messageID] = nil
            }
        }
        let merged = byID.values.sorted(by: ChatMessage.precedes)
        if merged != messages { messages = merged }

        // A local turn whose row has come back is that row now.
        let arrived = Set(messages.filter { $0.direction == .yours }.map(\.messageID))
        localTurns.removeAll { turn in
            guard let id = turn.messageID, arrived.contains(id) else { return false }
            renderIDs[id] = turn.id
            return true
        }

        // The turns the owner's messages started, as each message's status says.
        let at = now()
        var settled: [Int] = []
        for message in messages where message.direction == .yours {
            guard let state = ChatTurnState(inboundStatus: message.status) else { continue }
            if var activity = activities[message.messageID] {
                if activity.state != state {
                    activity.state = state
                    activity.lastNewsAt = at
                    activities[message.messageID] = activity
                    if state != .working { settled.append(message.messageID) }
                }
            } else if state == .working {
                activities[message.messageID] = ChatTurnActivity(messageID: message.messageID, startedAt: message.ts ?? at, state: .working)
            }
        }
        attachTurns()

        if first {
            // The first paint lands at the end; that is not an arrival.
            followRequests += 1
            return settled
        }
        switch ChatArrival.of(newReplies: newReplies, isAtBottom: isAtBottom) {
        case .follow:
            followRequests += 1
        case .pill:
            showsNewReplyPill = true
            // The visible half of a polite announcement: spoken, never scrolled to.
            announce("New reply available")
        case .none:
            break
        }
        if newReplies > 0 { requests.invalidate() }
        return settled
    }

    /// The turns that just finished: their last calls, their own duration and cost.
    private func settle(_ finished: [Int]) async {
        for messageID in finished { await readFinishedRun(messageID) }
    }

    /// The rating a reply shows: what the owner just pressed, until a read agrees.
    public func rating(of message: ChatMessage) -> Rating? {
        if let override = ratingOverrides[message.messageID] { return override }
        return message.rating
    }

    /// The identity a message's row is drawn under.
    public func renderID(of message: ChatMessage) -> String {
        if message.direction == .yours, let local = renderIDs[message.messageID] { return "local:\(local.uuidString)" }
        return message.id
    }

    // MARK: Which turn a message started (exact, never by time)

    /// For every working turn with no `turn_id` yet: read the recent `turn`
    /// runs, and each one not read before for the message it names.
    func bindTurns() async {
        guard let session, activities.values.contains(where: { $0.state == .working && $0.turnID == nil }) else { return }
        let generation = session.generation
        if case .success(let feed) = await session.stores.activityFeed(hours: 1, limit: 20, kind: "turn", project: nil, agent: nil, since: nil, turnID: nil) {
            guard session.generation == generation else { return }
            for row in feed.rows where row.kind == "turn" {
                guard let runID = row.runID, !examinedRuns.contains(runID), !runsToExamine.contains(runID) else { continue }
                runsToExamine.append(runID)
            }
        }
        await examineRuns()
    }

    private func examineRuns() async {
        guard let session else { return }
        let generation = session.generation
        while let runID = runsToExamine.first {
            runsToExamine.removeFirst()
            guard !examinedRuns.contains(runID) else { continue }
            guard case .success(let reply) = await session.stores.run(runID) else { continue }
            guard session.generation == generation else { return }
            examinedRuns.insert(runID)
            let run = reply.run
            guard let named = Self.messageID(in: run.meta), let turnID = run.meta?.string("turn_id"), !turnID.isEmpty else { continue }
            let finished = run.finishedAt != nil || run.ok != nil
            turnsByMessage[named] = ChatTurnRun(runID: runID, turnID: turnID, durationMs: finished ? run.durationMs : nil, costUSD: finished ? run.costUSD : nil)
        }
        attachTurns()
    }

    /// Every working turn with a run found for its message takes that run's `turn_id`.
    private func attachTurns() {
        for (messageID, run) in turnsByMessage {
            guard var activity = activities[messageID], activity.turnID == nil else { continue }
            activity.runID = run.runID
            activity.turnID = run.turnID
            activity.durationMs = run.durationMs
            activity.costUSD = run.costUSD
            activity.lastNewsAt = now()
            activities[messageID] = activity
        }
    }

    /// `meta.message_id` — a number in some writers, a string in others.
    static func messageID(in meta: JSONValue?) -> Int? {
        guard let value = meta?["message_id"] else { return nil }
        return value.intValue ?? value.stringValue.flatMap { Int($0) }
    }

    /// The strip of every bound turn still working (and once more as it finishes).
    func readProgress() async {
        for (messageID, activity) in activities where activity.state == .working {
            guard let turnID = activity.turnID else { continue }
            await readProgress(messageID, turnID: turnID)
        }
    }

    private func readProgress(_ messageID: Int, turnID: String) async {
        guard let session else { return }
        let generation = session.generation
        guard case .success(let progress) = await session.stores.turnProgress(turnID), session.generation == generation else { return }
        guard var activity = activities[messageID] else { return }
        let calls = progress.calls
        if calls != activity.calls {
            activity.calls = calls
            activity.lastNewsAt = now()
            activities[messageID] = activity
        }
    }

    /// A turn just finished or failed: its last calls, and its own duration and cost.
    private func readFinishedRun(_ messageID: Int) async {
        guard let session, let activity = activities[messageID] else { return }
        if let turnID = activity.turnID { await readProgress(messageID, turnID: turnID) }
        guard let runID = activity.runID else { return }
        let generation = session.generation
        guard case .success(let reply) = await session.stores.run(runID), session.generation == generation else { return }
        guard var current = activities[messageID] else { return }
        current.durationMs = reply.run.durationMs
        current.costUSD = reply.run.costUSD
        activities[messageID] = current
    }

    /// The live stream's `working` frames (T5-7): each marks due exactly what it
    /// names. Polling reaches the same state without them.
    public func apply(_ event: ConsoleEvent) {
        switch event.change {
        case .messageNew:
            transcript.invalidate()
        case .runStarted(let runID, let kind, _), .runFinished(let runID, let kind, _):
            if kind == "turn", !examinedRuns.contains(runID), !runsToExamine.contains(runID) { runsToExamine.append(runID) }
            lastInFlightAsk = nil
        case .turnProgress:
            lastInFlightAsk = nil
        case .needsYouChanged:
            requests.invalidate()
        case .resync:
            transcript.invalidate()
            requests.invalidate()
            lastInFlightAsk = nil
        default:
            break
        }
    }

    // MARK: Sending

    /// Sends the draft. The owner's turn is on screen before the request
    /// leaves; the draft is emptied into it, so nothing typed is ever lost —
    /// a turn that is not sent keeps its words and offers Retry.
    public func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, allowsSending else { return }
        let turn = ChatLocalTurn(id: UUID(), text: text, tier: pin?.tier, sentAt: now(), state: .sending)
        draft = ""
        if pin?.scope == .turn { pin = nil }
        localTurns.append(turn)
        followRequests += 1
        await deliver(turn.id)
    }

    /// Sends a turn that was not sent, as it was written.
    public func retry(_ id: UUID) async {
        guard allowsSending, let index = localTurns.firstIndex(where: { $0.id == id }) else { return }
        guard case .notSent = localTurns[index].state else { return }
        localTurns[index].state = .sending
        await deliver(id)
    }

    private func deliver(_ id: UUID) async {
        guard let session, let turn = localTurns.first(where: { $0.id == id }) else { return }
        let generation = session.generation
        let result = await session.stores.send(turn.text, threadID: nil, tier: turn.tier)
        guard session.generation == generation, let index = localTurns.firstIndex(where: { $0.id == id }) else { return }
        switch result {
        case .success(let accepted):
            if let messageID = Int(accepted.messageID) {
                localTurns[index].state = .sent(messageID: messageID)
                activities[messageID] = ChatTurnActivity(messageID: messageID, startedAt: turn.sentAt, state: .working)
                watchWhileWorking()
            } else {
                localTurns[index].state = .notSent(reason: "the console accepted it but named no message id", held: false)
            }
            lastInFlightAsk = nil
            await tick()
        case .failure(let error):
            localTurns[index].state = .notSent(reason: error.localizedDescription, held: error.wasHeldForReachability)
        }
    }

    /// ↑ in an empty composer: the last turn the owner wrote, back in the
    /// field. A turn that was never sent is taken back whole; a sent one is
    /// copied — there is no route that edits a sent message.
    @discardableResult
    public func recallLast() -> Bool {
        guard draft.isEmpty else { return false }
        if let index = localTurns.lastIndex(where: { if case .notSent = $0.state { return true }; return false }) {
            draft = localTurns[index].text
            localTurns.remove(at: index)
            return true
        }
        guard let last = messages.last(where: { $0.direction == .yours }) else { return false }
        draft = last.text
        return true
    }

    // MARK: The tier (§3c)

    public var tiers: [ChatTier] { commands.section.value.map(ChatTier.from) ?? [] }

    /// The tier the router put on the owner's last message — what *auto* has been choosing.
    public var routerLastTier: String? {
        messages.last(where: { $0.direction == .yours && $0.tier != nil })?.tier
    }

    public func pinTier(_ name: String, scope: ChatPinScope) {
        pin = ChatPin(tier: name, scope: scope)
    }

    public func setPinScope(_ scope: ChatPinScope) {
        guard let pin else { return }
        self.pin = ChatPin(tier: pin.tier, scope: scope)
    }

    /// *Reset to the router's choice.*
    public func resetTier() {
        pin = nil
    }

    /// ⇧⌘N (C119): the tier goes back to the router's choice and the
    /// transcript to its end. POST /message carries no fresh-session flag, so
    /// the next message continues the thread's session as any message would.
    public func newConversation() {
        resetTier()
        showsNewReplyPill = false
        followRequests += 1
    }

    // MARK: P9

    /// The reader reached the end of the transcript, by the pill or on their own.
    public func reachedBottom() {
        if !isAtBottom { isAtBottom = true }
        if showsNewReplyPill { showsNewReplyPill = false }
    }

    /// The pill, pressed: the one thing that scrolls for an arrival.
    public func jumpToNewReply() {
        showsNewReplyPill = false
        followRequests += 1
    }

    // MARK: Tapbacks (P8)

    /// Rates a reply, or clears its rating with nil. An append: sent even while
    /// the console is unreachable, and on a refusal the rating goes back to
    /// what it was, with the reason on the reply.
    public func rate(_ message: ChatMessage, _ rating: Rating?, note: String? = nil) async {
        guard message.direction == .reply, let session else { return }
        let before = self.rating(of: message)
        ratingOverrides[message.messageID] = .some(rating)
        ratingProblem = nil
        let generation = session.generation
        let trimmed = note?.trimmingCharacters(in: .whitespacesAndNewlines)
        let result: Result<MessageFeedbackResult, ConsoleError>
        if let rating {
            result = await session.stores.rate(message: message.messageID, rating, note: (trimmed?.isEmpty ?? true) ? nil : trimmed)
        } else {
            result = await session.stores.clearRating(message: message.messageID)
        }
        guard session.generation == generation else { return }
        if case .failure(let error) = result {
            ratingOverrides[message.messageID] = .some(before)
            ratingProblem = (message.messageID, "Couldn't save the rating: \(error.localizedDescription)")
        } else {
            transcript.invalidate()
        }
    }

    // MARK: The toolstrip, opened and closed by the owner

    public func toggleStrip(_ messageID: Int) {
        guard var activity = activities[messageID] else { return }
        activity.expandedByOwner = !activity.isExpanded
        activities[messageID] = activity
    }

    // MARK: The prompt card (§3.5)

    /// The pending question a reply ended with — the `decision` row whose
    /// `payload.message_id` is this reply — as a card. A card once drawn stays,
    /// so an answered one shows its receipt; one answered elsewhere leaves.
    public func promptCard(for message: ChatMessage, assistantName: String?) -> RequestAnswering? {
        guard message.direction == .reply, let name = assistantName, let cards = cards(assistantName: name) else { return nil }
        let pending = (requests.section.value?.proposals ?? []).filter { $0.kind == "decision" && $0.isPending }
        if let row = pending.first(where: { Self.messageID(in: $0.payload) == message.messageID }) {
            promptRows[message.messageID] = row
            return cards.card(for: row)
        }
        guard let row = promptRows[message.messageID] else { return nil }
        let card = cards.card(for: row)
        if card.isSettled { return card }
        // Not pending any more and not answered here: answered elsewhere.
        if requests.section.hasValue { promptRows[message.messageID] = nil; return nil }
        return card
    }

    private func cards(assistantName: String) -> RequestCards? {
        guard let session else { return nil }
        if let held = requestCards, held.name == assistantName, held.generation == session.generation { return held.cards }
        let cards = RequestCards(store: session.stores, assistantName: assistantName)
        requestCards = (assistantName, session.generation, cards)
        return cards
    }

    // MARK: The preview pane (§3b)

    public func open(_ reference: ChatPageReference) async {
        guard let session else { return }
        preview = ChatPreview(reference: reference, state: .loading)
        let generation = session.generation
        let result = await session.stores.knowledgePage(path: reference.path)
        guard session.generation == generation, preview?.reference == reference else { return }
        switch result {
        case .success(let page): preview?.state = .loaded(page)
        case .failure(let error): preview?.state = .failed(error.localizedDescription)
        }
    }

    public func closePreview() {
        preview = nil
    }

    // MARK: Paint

    /// The transcript as drawn, in order: day separators, the owner's turns,
    /// what each one set working, and what came back.
    public func rows(calendar: Calendar) -> [ChatRow] {
        var dated: [(at: Date?, row: ChatRow)] = []
        for message in messages {
            switch message.direction {
            case .yours:
                dated.append((message.ts, .yours(ChatYoursRow(id: renderID(of: message), text: message.text, at: message.ts, local: nil))))
                if let activity = activities[message.messageID], activity.isShown {
                    dated.append((message.ts, .activity(activity)))
                }
            case .reply:
                dated.append((message.ts, .reply(message)))
            }
        }
        // What this Mac has sent and the console has not returned yet is the newest thing there is.
        for turn in localTurns {
            dated.append((turn.sentAt, .yours(ChatYoursRow(id: "local:\(turn.id.uuidString)", text: turn.text, at: turn.sentAt, local: turn))))
            if let id = turn.messageID, let activity = activities[id], activity.isShown {
                dated.append((turn.sentAt, .activity(activity)))
            }
        }
        var out: [ChatRow] = []
        var lastDay: String?
        for (at, row) in dated {
            if let at {
                let day = ChatDay(date: at, calendar: calendar)
                if day.key != lastDay {
                    out.append(.day(day))
                    lastDay = day.key
                }
            }
            out.append(row)
        }
        return out
    }

    /// Nothing has been said yet, and the console has said so.
    public var isEmpty: Bool { transcript.section.hasValue && messages.isEmpty && localTurns.isEmpty }
}

// MARK: - The transcript's rows

public enum ChatRow: Sendable, Equatable, Identifiable {
    case day(ChatDay)
    case yours(ChatYoursRow)
    /// What the owner's message set working: the waiting moments, then the strip.
    case activity(ChatTurnActivity)
    case reply(ChatMessage)

    public var id: String {
        switch self {
        case .day(let d): return "day:\(d.key)"
        case .yours(let y): return y.id
        case .activity(let a): return "turn:\(a.messageID)"
        case .reply(let m): return m.id
        }
    }

}

public struct ChatYoursRow: Sendable, Equatable {
    public let id: String
    public let text: String
    public let at: Date?
    /// Set while the turn is this Mac's and the console has not returned it.
    public let local: ChatLocalTurn?
}

/// A day separator: a hairline with the day centred (P8 — timestamps on demand).
public struct ChatDay: Sendable, Equatable {
    public let key: String
    public let date: Date

    init(date: Date, calendar: Calendar) {
        let d = calendar.dateComponents([.year, .month, .day], from: date)
        self.key = String(format: "%04d-%02d-%02d", d.year ?? 0, d.month ?? 0, d.day ?? 0)
        self.date = date
    }

    /// *Today* · *Yesterday* · *26 Sep*.
    public func label(now: Date, calendar: Calendar, clock: ClockTime) -> String {
        if calendar.isDate(date, inSameDayAs: now) { return "Today" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) { return "Yesterday" }
        return clock.day(date)
    }
}

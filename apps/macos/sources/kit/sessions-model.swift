// Settings ▸ Sessions (T6-15; screen-12 §4, plan §2.15, C136): the session
// archive — how long it is kept, whether the assistant learns from it, and
// Purge Now with its count.
//
// THREE READS, TWO WRITES, ALL THROUGH DOORS THAT EXIST. *Let <the assistant>
// learn from them* is the `session-fold` routine's pause: `GET
// /api/scheduled/routines/session-fold`, flipped with the Scheduled doors'
// pause and resume — reversible, so it acts at once. *Keep sessions* is
// `session-purge`'s `retention_days` config, read through the same route and
// shown with its origin; there is no door that writes a routine's config from
// a client, so the row says where it is set rather than offering a field. And
// Purge Now is `POST /api/sessions/purge` (T3-9, reach `local`) — two steps on
// one door: a body without `confirm: true` deletes nothing and answers what a
// purge would cost, and only the confirmed body, carrying the preview's own
// `as_of`, deletes. No console route is added for any of it (invariant 10).
//
// PURGE NOW IS IRREVERSIBLE, SO IT CONFIRMS, NAMING THE COST (C136;
// components-03 §3). The preview's `unfolded` rows — the sessions the fold has
// not read yet — are the cost, each one a line; *Fold First* runs the fold now
// instead and asks again. When nothing is unfolded the cost is the archive
// itself, and Fold First is not offered because there is nothing to fold. A
// `CostConfirmation` cannot be made without a cost or with a bare button
// (undo-and-confirm.swift), so a confirm that names nothing cannot appear.
//
// `purgeNow()` sends nothing. Only `choose(.confirm)` sends the confirmed
// body; `choose(.alternative)` runs the fold and re-reads the preview;
// `choose(.cancel)` closes the dialog. The tests hold each of those to the
// transport's log.

import Foundation
import Observation

// MARK: - The preview, as the wire carries it

/// One session the fold has not read yet — `POST /api/sessions/purge`'s
/// `unfolded[]` rows (the newest fifty, by name).
public struct UnfoldedSession: Sendable, Equatable, Identifiable {
    public let sessionID: String
    public let thread: String
    public let turns: Int
    public let unfoldedTurns: Int
    public let firstTS: Date?
    public let lastTS: Date?

    public var id: String { sessionID }

    public init(sessionID: String, thread: String, turns: Int, unfoldedTurns: Int, firstTS: Date?, lastTS: Date?) {
        self.sessionID = sessionID
        self.thread = thread
        self.turns = turns
        self.unfoldedTurns = unfoldedTurns
        self.firstTS = firstTS
        self.lastTS = lastTS
    }

    public init?(json: JSONValue) {
        guard let sessionID = json.string("session_id") else { return nil }
        self.init(
            sessionID: sessionID,
            thread: json.string("thread") ?? "default",
            turns: json.int("turns") ?? 0,
            unfoldedTurns: json.int("unfolded_turns") ?? 0,
            firstTS: WireTime.date(json.string("first_ts")),
            lastTS: WireTime.date(json.string("last_ts"))
        )
    }

    /// The thread as the owner knows it: the engine's `default` thread is the
    /// chat; any other is named as the engine spelled it.
    public var threadTitle: String { thread == "default" ? "Chat" : thread }

    /// The cost line the confirm names: *Chat — 28 Sep, 12:00 PM · 2 turns*.
    /// Twelve-hour times (screen-11, corrected).
    public func line(clock: ClockTime, now: Date) -> String {
        var parts = [threadTitle]
        if let lastTS { parts[0] += " — \(clock.moment(lastTS, now: now))" }
        parts.append(turns == 1 ? "1 turn" : "\(turns) turns")
        return parts.joined(separator: " · ")
    }
}

/// `POST /api/sessions/purge` without `confirm: true`: what a purge would
/// cost, and the `as_of` the confirmed call passes back.
public struct SessionPurgePreview: Sendable, Equatable {
    public let sessions: Int
    public let turns: Int
    public let sessionsUnfolded: Int
    public let unfolded: [UnfoldedSession]
    public let asOf: String?

    public init(sessions: Int, turns: Int, sessionsUnfolded: Int, unfolded: [UnfoldedSession], asOf: String?) {
        self.sessions = sessions
        self.turns = turns
        self.sessionsUnfolded = sessionsUnfolded
        self.unfolded = unfolded
        self.asOf = asOf
    }

    public init?(json: JSONValue) {
        guard let sessions = json.int("sessions"), let turns = json.int("turns") else { return nil }
        self.init(
            sessions: sessions,
            turns: turns,
            sessionsUnfolded: json.int("sessions_unfolded") ?? 0,
            unfolded: json["unfolded"]?.arrayValue?.compactMap(UnfoldedSession.init(json:)) ?? [],
            asOf: json.string("as_of")
        )
    }

    public var isEmpty: Bool { sessions == 0 }

    /// Beside the button — a destructive verb says what it will destroy
    /// (screen-11 §8): *2 sessions · 3 turns*, or *Nothing archived*.
    public var countLine: String {
        guard !isEmpty else { return "Nothing archived" }
        return "\(Self.count(sessions, "session")) · \(Self.count(turns, "turn"))"
    }

    /// The unfolded count, said: *1 not folded yet*. Nil when every session
    /// has been read.
    public var unfoldedLine: String? {
        sessionsUnfolded > 0 ? "\(sessionsUnfolded) not folded yet" : nil
    }

    /// C136: the confirm, naming exactly what a purge costs. The unfolded
    /// sessions, each a line, with *Fold First* as the way round; or, when
    /// every session has been folded, the archive itself and no alternative.
    /// Nil when there is nothing to purge — no dialog at all.
    public func confirmation(assistantName: String?, clock: ClockTime, now: Date) -> CostConfirmation? {
        guard !isEmpty else { return nil }
        let title = "Purge \(Self.count(sessions, "Session")) Now?"
        let name = assistantName ?? "the assistant"
        if sessionsUnfolded > 0 {
            var costs = unfolded.map { $0.line(clock: clock, now: now) }
            let unnamed = sessionsUnfolded - unfolded.count
            if unnamed > 0 { costs.append("and \(Self.count(unnamed, "more session")) not listed here") }
            return CostConfirmation(
                title: title,
                costHeading: sessionsUnfolded == 1
                    ? "One session has not been folded yet — what \(name) could learn from it is lost:"
                    : "\(sessionsUnfolded) sessions have not been folded yet — what \(name) could learn from them is lost:",
                costs: costs,
                confirm: SessionsWords.purgeNow,
                alternative: SessionsWords.foldFirst
            )
        }
        return CostConfirmation(
            title: title,
            costHeading: "Every session has been folded, so nothing \(name) learned is lost. Deleted for good:",
            costs: ["\(Self.count(sessions, "archived session")) — \(Self.count(turns, "turn")) of conversation"],
            confirm: SessionsWords.purgeNow
        )
    }

    static func count(_ n: Int, _ noun: String) -> String {
        "\(n) \(noun)\(n == 1 ? "" : "s")"
    }
}

// MARK: - The words

public enum SessionsWords {
    public static let purgeNow = "Purge Now"
    public static let foldFirst = "Fold First"
    /// Under *Keep sessions*, where the number is changed: the routine's own config.
    public static let retentionWhere = "Session Purge's own Retention Days setting — a whole number from 1 to 30, shown in Scheduled. A session past it is deleted on the next 4:00 AM run."
    /// Under *Let … learn*: what off means (the manifest's own words).
    public static let learnOff = "Off keeps sessions for reading and debugging and stops the fold."
    /// screen-12 §4: stored outside git.
    public static let storedOutsideGit = "Sessions are kept outside the vault and never committed — a transcript in git would be forever."
    /// Purge Now is reach `local`.
    public static let onlyTheMac = "Purge Now is this Mac's alone: a phone or another Mac can read the archive but not delete it."
    /// Fold First's receipt.
    public static let folding = "Folding now — the count is re-read when the fold has run."
}

// MARK: - The model

/// What Purge Now may do from this client (`POST /api/sessions/purge` is reach
/// `local`, docs/ops/client-api.md): the Mac itself, or not.
public enum SessionsReach: Sendable, Equatable {
    case unknown
    case local
    case remote(via: String)

    public var isLocal: Bool { self == .local }
}

@MainActor
@Observable
public final class SessionsModel {
    /// `session-fold`: paused means the assistant is not learning.
    public private(set) var fold: ScheduledRoutine?
    public private(set) var foldPhase: ReadPhase = .idle
    /// `session-purge`: its `retention_days` is *Keep sessions*.
    public private(set) var purgeRoutine: ScheduledRoutine?
    public private(set) var purgePhase: ReadPhase = .idle
    /// What a purge would cost now — the count beside the button.
    public private(set) var preview: SessionPurgePreview?
    public private(set) var previewPhase: ReadPhase = .idle
    /// The confirm on screen. `nil`: none. Presenting it sends nothing.
    public var confirmation: CostConfirmation?
    /// What the last act came to, under the section.
    public private(set) var note: ScheduledNote?
    public private(set) var busy = false
    public private(set) var reach: SessionsReach = .unknown

    public static let foldRoutine = "session-fold"
    public static let purgeRoutineName = "session-purge"
    public static let retentionKey = "retention_days"

    @ObservationIgnored private let session: ConsoleSession?
    @ObservationIgnored public var now: () -> Date = Date.init
    @ObservationIgnored public var clock = ClockTime()

    public init(session: ConsoleSession?) {
        self.session = session
    }

    /// Dropped on every instance switch: a count belongs to the install it was asked about.
    public func reset() {
        fold = nil
        foldPhase = .idle
        purgeRoutine = nil
        purgePhase = .idle
        preview = nil
        previewPhase = .idle
        confirmation = nil
        note = nil
        busy = false
        reach = .unknown
    }

    // MARK: Reading

    /// Everything the pane shows, re-read when it opens.
    public func refresh() async {
        guard let session else {
            foldPhase = .unavailable("no console session for this instance")
            purgePhase = foldPhase
            previewPhase = foldPhase
            return
        }
        await askReach(session)
        await readRoutines(session)
        await readPreview(session)
    }

    private func askReach(_ session: ConsoleSession) async {
        switch await session.stores.whoami() {
        case .success(let who): reach = who.via == "local_owner_token" ? .local : .remote(via: who.via)
        case .failure: reach = .unknown
        }
    }

    private func readRoutines(_ session: ConsoleSession) async {
        foldPhase = .reading
        purgePhase = .reading
        switch await session.stores.routine(Self.foldRoutine) {
        case .success(let reply):
            fold = reply["routine"].flatMap(ScheduledRoutine.init(json:))
            foldPhase = fold == nil ? .unavailable("the console did not describe \(Self.foldRoutine)") : .read
        case .failure(let error):
            fold = nil
            foldPhase = .unavailable(error.localizedDescription)
        }
        switch await session.stores.routine(Self.purgeRoutineName) {
        case .success(let reply):
            purgeRoutine = reply["routine"].flatMap(ScheduledRoutine.init(json:))
            purgePhase = purgeRoutine == nil ? .unavailable("the console did not describe \(Self.purgeRoutineName)") : .read
        case .failure(let error):
            purgeRoutine = nil
            purgePhase = .unavailable(error.localizedDescription)
        }
    }

    /// The preview: `{confirm: false}`, which deletes nothing.
    public func readPreview() async {
        guard let session else { return }
        await readPreview(session)
    }

    private func readPreview(_ session: ConsoleSession) async {
        previewPhase = .reading
        switch await session.stores.purgeSessions(SessionPurge(confirm: false)) {
        case .success(let reply):
            if let preview = SessionPurgePreview(json: reply.json) {
                self.preview = preview
                previewPhase = .read
            } else {
                previewPhase = .unavailable("the console's answer had no counts")
            }
        case .failure(let error):
            if case .http(403, let envelope) = error, envelope?.code == "local_only" { reach = .remote(via: "local_only") }
            previewPhase = .unavailable(error.localizedDescription)
        }
    }

    // MARK: Let the assistant learn

    /// On unless `session-fold` is paused. Nil until the routine has been read.
    public var learns: Bool? { fold.map { !$0.isPaused } }

    /// Reversible, so it acts at once: pause or resume `session-fold`.
    public func setLearns(_ on: Bool) async {
        guard let session, let fold, fold.isPaused == on, !busy else { return }
        busy = true
        defer { busy = false }
        let answer = on ? await session.stores.resume(routine: Self.foldRoutine) : await session.stores.pause(routine: Self.foldRoutine)
        switch answer {
        case .success(let reply):
            self.fold = reply["routine"].flatMap(ScheduledRoutine.init(json:)) ?? fold
            note = ScheduledNote(kind: .done, text: on ? "Learning from sessions again." : "Not learning from sessions; the archive is still kept for reading until the purge.")
        case .failure(let error):
            note = ScheduledNote(kind: .failed, text: error.localizedDescription)
        }
    }

    // MARK: Keep sessions

    /// `retention_days` as configured: *30 days (default)*. Nil until read.
    public var retentionLine: String? {
        guard let field = purgeRoutine?.config.first(where: { $0.key == Self.retentionKey }) else {
            return purgePhase == .read ? "30 days" : nil
        }
        let days = field.value == "1" ? "1 day" : "\(field.value) days"
        return "\(days) (\(field.origin.label))"
    }

    // MARK: Purge Now

    /// Why the button is off — a fact about the system, always shown
    /// (components-01 §1.3). Nil when Purge Now may be pressed.
    public var purgeUnavailableReason: String? {
        if case .remote = reach { return SessionsWords.onlyTheMac }
        if case .unavailable(let why) = previewPhase { return why }
        guard let preview else { return nil }
        return preview.isEmpty ? "Nothing to purge — the archive is empty." : nil
    }

    /// The count beside the button.
    public var countLine: String {
        switch previewPhase {
        case .idle, .reading: return preview?.countLine ?? "Counting…"
        case .unavailable: return "Count unavailable"
        case .read: return preview?.countLine ?? "Nothing archived"
        }
    }

    /// Purge Now pressed: the confirm, naming the cost. Sends nothing.
    public func purgeNow() {
        guard purgeUnavailableReason == nil, let preview else { return }
        confirmation = preview.confirmation(assistantName: assistantName, clock: clock, now: now())
    }

    /// The assistant's name, for the confirm's sentence. Set by the pane from the identity read.
    @ObservationIgnored public var assistantName: String?

    /// The dialog's answer. Only `.confirm` purges.
    public func choose(_ choice: CostConfirmView.Choice) async {
        confirmation = nil
        guard let session, let preview else { return }
        switch choice {
        case .cancel:
            return
        case .alternative:
            // Fold First: run the fold now, then re-read what a purge would cost.
            busy = true
            defer { busy = false }
            switch await session.stores.runNow(routine: Self.foldRoutine) {
            case .success: note = ScheduledNote(kind: .done, text: SessionsWords.folding)
            case .failure(let error): note = ScheduledNote(kind: .failed, text: error.localizedDescription)
            }
            await readPreview(session)
        case .confirm:
            busy = true
            defer { busy = false }
            // The preview's `as_of` goes back: exactly what was counted is deleted.
            switch await session.stores.purgeSessions(SessionPurge(confirm: true, asOf: preview.asOf)) {
            case .success(let reply):
                let sessions = reply.json.int("sessions") ?? preview.sessions
                let turns = reply.json.int("turns") ?? preview.turns
                note = ScheduledNote(kind: .done, text: "Purged \(SessionPurgePreview.count(sessions, "session")) — \(SessionPurgePreview.count(turns, "turn")).")
            case .failure(let error):
                if case .http(403, let envelope) = error, envelope?.code == "local_only" { reach = .remote(via: "local_only") }
                note = ScheduledNote(kind: .failed, text: error.localizedDescription)
            }
            await readPreview(session)
        }
    }
}

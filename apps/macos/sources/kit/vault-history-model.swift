// History in the app — the model (design-build-plan T10-7, §2.21).
//
// TWO PLACES, ONE HISTORY. Git is the record (invariant 1) and the reconciler
// is its sole committer (D5): the app runs no git and holds no copy. What it
// shows comes from four doors, each through `VaultStore`:
//
//   * Settings ▸ Instance ▸ History — `GET /api/vault/status` (T10-2): the
//     sync policy in force, ahead and behind, the last commit, the last push
//     and pull, any conflict — and **Roll Back…**, `POST /api/vault/rollback`
//     (T10-6), which changes nothing: it raises one Needs You request carrying
//     the preview, and this model names what that preview says Approve would
//     undo.
//   * a Knowledge page's History — `GET /api/knowledge/history` and
//     `GET /api/knowledge/version` (T10-4), and **Restore**,
//     `POST /api/knowledge/restore` (T10-5), which also only raises a request.
//     Its words live on `KnowledgeModel`; the pieces both places share —
//     a commit, who made it, the reach — are here.
//
// REACH `local`, AT THE TOOL (ruling 7, 2026-09-27). Restore and roll back
// are the owner's on THIS Mac alone: the console refuses both to a passkey
// session with `403 local_only`. The app draws neither unless
// `GET /api/whoami` says this client is the local owner token, refuses to
// send either otherwise, and a `local_only` answer takes the control away.
// A hidden control is never the control — the console refuses as well.
//
// THE POLICY IS NOT A ROUTE (M18). When the reconciler pushes and pulls is
// `metistry vault settings`, a protected write on the Mac; this pane shows
// the policy in force and names that verb, and offers no field to change it.

import Foundation
import Observation

// MARK: - A commit, and who made it

/// One commit as the vault's doors name it: `GET /api/vault/status`'s
/// `last_commit`, a rollback preview's `commits` and `base`.
public struct VaultCommitRef: Sendable, Equatable, Identifiable {
    public var sha: String
    public var subject: String
    /// The principal the reconciler stamped (`Brain-Source:`), or git's author.
    public var author: String?
    public var at: Date?
    public var id: String { sha }

    public init(sha: String, subject: String, author: String? = nil, at: Date? = nil) {
        self.sha = sha
        self.subject = subject
        self.author = author
        self.at = at
    }

    /// *9ab8c7d* — what `git log --oneline` prints, and what a person reads out.
    public var short: String { String(sha.prefix(7)) }

    static func from(_ j: JSONValue?) -> VaultCommitRef? {
        guard let j, let sha = j.string("sha") else { return nil }
        return VaultCommitRef(sha: sha, subject: j.string("subject") ?? "", author: j.string("author"), at: WireTime.date(j.string("at", "date")))
    }
}

/// Who made a commit, in the words a row prints. Provenance to show, never
/// authority (client-api.md, T10-4).
public enum VaultWho {
    /// `source` is the `Brain-Source:` trailer — `user`, the assistant's
    /// principal, an agent id; `author` is git's author name, `Metistry
    /// <principal>` for the reconciler's own commits. The assistant is named by
    /// the configured name and by nothing else: until it is known the row names
    /// no author rather than a default (C102).
    public static func name(source: String?, author: String?, assistantName: String?) -> String? {
        switch source {
        case "user": return "You"
        case "assistant": return assistantName
        case let principal?: return principal
        case nil:
            guard let author, !author.isEmpty else { return nil }
            let prefix = "Metistry "
            if author.hasPrefix(prefix) {
                return name(source: String(author.dropFirst(prefix.count)), author: nil, assistantName: assistantName)
            }
            return author
        }
    }
}

/// Whether this client may restore or roll back (§2.3, ruling 7): the local
/// owner token only. `ClientReach` is Scheduled's same question.
extension ClientReach {
    /// Restore and Roll Back are drawn, and sent, only here.
    public var rewindsHistory: Bool { self == .local }

    /// `GET /api/whoami`'s `via`.
    static func of(via: String) -> ClientReach {
        via == "local_owner_token" ? .local : .remote(via: via)
    }
}

// MARK: - Sync, as it stands

/// One push or pull attempt (`last_push`, `last_pull`).
public struct VaultSyncAttempt: Sendable, Equatable {
    public var at: Date?
    public var ok: Bool
    public var remote: String?
    /// git's last error line, any `user:secret@` already masked by the reconciler.
    public var error: String?

    public init(at: Date?, ok: Bool, remote: String? = nil, error: String? = nil) {
        self.at = at
        self.ok = ok
        self.remote = remote
        self.error = error
    }

    static func from(_ j: JSONValue?) -> VaultSyncAttempt? {
        guard let j, case .object = j else { return nil }
        return VaultSyncAttempt(at: WireTime.date(j.string("at")), ok: j.bool("ok") ?? false, remote: j.string("remote"), error: j.string("error"))
    }
}

/// `GET /api/vault/status`, read (T10-2).
public struct VaultSyncRead: Sendable, Equatable {
    public var branch: String?
    /// Nil: no remote — history stays on this Mac, and ahead/behind are nil too.
    public var remote: String?
    public var ahead: Int?
    public var behind: Int?
    public var lastCommit: VaultCommitRef?
    public var lastPush: VaultSyncAttempt?
    public var lastPull: VaultSyncAttempt?
    /// The paths holding the sync, or nil while nothing does (§2.21 rule 3).
    public var conflict: [String]?
    /// The policy's words: *After every commit* · *Manual* · *Every 15m*.
    public var push: String
    public var pull: String
    /// `METISTRY_PUSH_SCHEDULE`, while it overrides `push` (this release only).
    public var pushOverride: String?
    /// `deployment.yaml`'s `vault:` block does not validate; the last good policy keeps running.
    public var policyError: String?

    public init(branch: String? = nil, remote: String? = nil, ahead: Int? = nil, behind: Int? = nil, lastCommit: VaultCommitRef? = nil, lastPush: VaultSyncAttempt? = nil, lastPull: VaultSyncAttempt? = nil, conflict: [String]? = nil, push: String = VaultHistoryWords.afterEveryCommit, pull: String = "Every 5m", pushOverride: String? = nil, policyError: String? = nil) {
        self.branch = branch
        self.remote = remote
        self.ahead = ahead
        self.behind = behind
        self.lastCommit = lastCommit
        self.lastPush = lastPush
        self.lastPull = lastPull
        self.conflict = conflict
        self.push = push
        self.pull = pull
        self.pushOverride = pushOverride
        self.policyError = policyError
    }

    public static func from(_ j: JSONValue) -> VaultSyncRead {
        let policy = j["policy"]
        var conflict: [String]?
        if let c = j["conflict"], case .object = c {
            conflict = (c["paths"]?.arrayValue ?? []).compactMap(\.stringValue)
        }
        return VaultSyncRead(
            branch: j.string("branch"), remote: j.string("remote"),
            ahead: j["ahead"]?.intValue, behind: j["behind"]?.intValue,
            lastCommit: VaultCommitRef.from(j["last_commit"]),
            lastPush: VaultSyncAttempt.from(j["last_push"]), lastPull: VaultSyncAttempt.from(j["last_pull"]),
            conflict: conflict,
            push: Self.cadence(policy?["push"], words: VaultHistoryWords.afterEveryCommit),
            pull: Self.cadence(policy?["pull"], words: "Every 5m"),
            pushOverride: policy?.string("push_override"), policyError: policy?.string("error")
        )
    }

    /// `after_commit` · `manual` · `{every: "15m"}` — said, never worked out.
    static func cadence(_ j: JSONValue?, words fallback: String) -> String {
        if let every = j?.string("every") { return "Every \(every)" }
        switch j?.stringValue {
        case "after_commit": return VaultHistoryWords.afterEveryCommit
        case "manual": return VaultHistoryWords.manual
        case let other?: return other
        case nil: return fallback
        }
    }

    /// *2 ahead · 0 behind origin*, or that there is no remote.
    public var aheadBehind: String {
        guard let remote else { return VaultHistoryWords.noRemote }
        return "\(ahead.map(String.init) ?? "?") ahead · \(behind.map(String.init) ?? "?") behind \(remote)"
    }

    /// What VoiceOver says for the same fact, in words rather than arrows.
    public var aheadBehindSpoken: String {
        guard let remote else { return VaultHistoryWords.noRemote }
        func commits(_ n: Int?) -> String { n.map { $0 == 1 ? "1 commit" : "\($0) commits" } ?? "an unknown number of commits" }
        return "\(commits(ahead)) not yet pushed to \(remote), \(commits(behind)) from \(remote) not yet here"
    }

    /// The last push, with its error when it failed: *Failed 12:58 PM — fatal: …*.
    public func pushLine(clock: ClockTime, now: Date) -> String { Self.attempt(lastPush, verb: "Pushed", clock: clock, now: now) }
    public func pullLine(clock: ClockTime, now: Date) -> String { Self.attempt(lastPull, verb: "Pulled", clock: clock, now: now) }

    static func attempt(_ a: VaultSyncAttempt?, verb: String, clock: ClockTime, now: Date) -> String {
        guard let a else { return VaultHistoryWords.notSinceStart }
        let when = a.at.map { clock.moment($0, now: now) } ?? "at a time not reported"
        if a.ok { return "\(verb) \(when)" }
        return "Failed \(when)" + (a.error.map { " — \($0)" } ?? "")
    }

    public var lastPushFailed: Bool { lastPush?.ok == false }
}

// MARK: - Roll back

/// What Roll Back… asks to undo.
public enum RollbackChoice: String, Sendable, CaseIterable, Identifiable {
    /// The newest commit, as `GET /api/vault/status` names it.
    case lastCommit
    /// One commit, by its id.
    case commit
    /// Everything since a day: the vault as it was then.
    case day

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .lastCommit: return "The Last Commit"
        case .commit: return "One Commit"
        case .day: return "Back to a Day"
        }
    }
}

/// `POST /api/vault/rollback`'s answer: the request it raised, and the preview it carries.
public struct RollbackPreview: Sendable, Equatable {
    public var proposalID: Int?
    /// False: the same rollback was already waiting — this is that request.
    public var raised: Bool
    public var title: String?
    /// What Approve undoes, newest first.
    public var commits: [VaultCommitRef]
    /// What Approve puts back.
    public var files: [String]
    /// Configuration the history would change and the rollback leaves as it is.
    public var skippedConfig: [String]
    /// The commit the files go back to.
    public var base: VaultCommitRef?

    public init(proposalID: Int? = nil, raised: Bool = true, title: String? = nil, commits: [VaultCommitRef] = [], files: [String] = [], skippedConfig: [String] = [], base: VaultCommitRef? = nil) {
        self.proposalID = proposalID
        self.raised = raised
        self.title = title
        self.commits = commits
        self.files = files
        self.skippedConfig = skippedConfig
        self.base = base
    }

    public static func from(_ j: JSONValue) -> RollbackPreview {
        let p = j["preview"]
        let id = j["proposal_id"]?.stringValue.flatMap { Int($0) } ?? j["proposal_id"]?.intValue
        var commits = (p?["commits"]?.arrayValue ?? []).compactMap(VaultCommitRef.from)
        if commits.isEmpty {
            // A preview that names only ids still names them.
            commits = (p?["reverts"]?.arrayValue ?? []).compactMap(\.stringValue).map { VaultCommitRef(sha: $0, subject: "") }
        }
        return RollbackPreview(
            proposalID: id, raised: j.bool("raised") ?? true,
            title: j["proposal"]?["payload"]?.string("title"),
            commits: commits,
            files: (p?["files"]?.arrayValue ?? []).compactMap(\.stringValue),
            skippedConfig: (p?["skipped_config"]?.arrayValue ?? []).compactMap(\.stringValue),
            base: VaultCommitRef.from(p?["base"])
        )
    }

    /// *Undoes 1 commit and puts back 1 file.*
    public var summary: String {
        let c = commits.count == 1 ? "1 commit" : "\(commits.count) commits"
        let f = files.count == 1 ? "1 file" : "\(files.count) files"
        return "Undoes \(c) and puts back \(f)."
    }

    /// One line per commit undone: *9ab8c7d “Fold: the store interface” — by You, 27 Sep*.
    public func commitLines(assistantName: String?, clock: ClockTime) -> [String] {
        commits.map { c in
            var line = c.subject.isEmpty ? c.short : "\(c.short) “\(c.subject)”"
            var tail: [String] = []
            if let who = VaultWho.name(source: c.author, author: nil, assistantName: assistantName) { tail.append("by \(who)") }
            if let at = c.at { tail.append(clock.day(at)) }
            if !tail.isEmpty { line += " — " + tail.joined(separator: ", ") }
            return line
        }
    }
}

// MARK: - The model

/// Settings ▸ Instance ▸ History: the sync, and Roll Back….
@MainActor
@Observable
public final class VaultHistoryModel {
    public enum RollbackPhase: Equatable {
        case idle
        case sending
        /// Raised (or found waiting) in Needs You, with what Approve would undo.
        case raised(RollbackPreview)
        /// Refused — by the console in its own words, or here before sending.
        case refused(String)
    }

    public let status: SectionModel<VaultSyncRead>
    /// Whether this client is the local owner — asked once per instance.
    public private(set) var reach: ClientReach = .unknown
    /// The Roll Back… sheet.
    public var rollbackOpen = false
    public var choice: RollbackChoice = .lastCommit
    /// A commit id, as typed.
    public var commitText = ""
    /// The day to go back to.
    public var day: Date
    public private(set) var rollback: RollbackPhase = .idle
    /// A rollback was raised: the shell's count asks again.
    @ObservationIgnored public var onQueueChanged: (@MainActor () async -> Void)?

    @ObservationIgnored private weak var session: ConsoleSession?
    @ObservationIgnored private var reachAsked = false
    @ObservationIgnored public let now: () -> Date
    @ObservationIgnored public let clock: ClockTime

    public init(session: ConsoleSession, timeZone: TimeZone = .current, now: @escaping () -> Date = Date.init) {
        self.session = session
        self.now = now
        self.clock = ClockTime(timeZone: timeZone)
        self.day = now()
        status = SectionModel(session: session, policy: .configuration, topics: [.vault]) { stores in
            await stores.vaultStatus().map { (VaultSyncRead.from($0.json), WireTime.date($0["as_of"]?.stringValue)) }
        }
        session.register { [weak self] in
            guard let self else { return false }
            self.reach = .unknown
            self.reachAsked = false
            self.rollbackOpen = false
            self.rollback = .idle
            return true
        }
    }

    /// On first sight, when due, and when a `vault.sync` event says so.
    public func refreshIfDue() async {
        await status.refreshIfDue(now: now())
        await askReachIfNeeded()
    }

    public func refresh() async {
        await status.refresh(background: status.section.hasValue)
    }

    /// `GET /api/whoami`, once per instance. Unknown is not local.
    func askReachIfNeeded() async {
        guard !reachAsked, let session else { return }
        reachAsked = true
        let generation = session.generation
        let answer = await session.stores.whoami()
        guard session.generation == generation else { return }
        switch answer {
        case .success(let who): reach = .of(via: who.via)
        case .failure:
            reach = .unknown
            reachAsked = false
        }
    }

    public var allowsDecisions: Bool { session?.allowsDecisions ?? false }
    public var decisionsUnavailableReason: String? { session?.decisionsUnavailableReason }

    // MARK: Roll Back…

    public func openRollback() {
        guard reach.rewindsHistory else { return }
        rollback = .idle
        commitText = ""
        day = now()
        choice = status.section.value?.lastCommit == nil ? .day : .lastCommit
        rollbackOpen = true
    }

    public func closeRollback() {
        rollbackOpen = false
        if case .sending = rollback { return }
        rollback = .idle
    }

    /// What the chosen target sends, or nil while it cannot be sent.
    public var target: RollbackTarget? {
        switch choice {
        case .lastCommit:
            return status.section.value?.lastCommit.map { .commit($0.sha) }
        case .commit:
            let sha = commitText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            return Self.isCommitID(sha) ? .commit(sha) : nil
        case .day:
            return .to(Self.ymd(day, clock.timeZone))
        }
    }

    /// Why the target cannot be sent yet, said before sending — the console's own rule.
    public var targetProblem: String? {
        switch choice {
        case .lastCommit:
            return status.section.value?.lastCommit == nil ? "No commit has been reported yet." : nil
        case .commit:
            let sha = commitText.trimmingCharacters(in: .whitespacesAndNewlines)
            if sha.isEmpty { return "Paste a commit id — 7 to 64 hex characters." }
            return Self.isCommitID(sha.lowercased()) ? nil : "A commit id is 7 to 64 hex characters."
        case .day:
            return day > now() ? "That day has not happened yet." : nil
        }
    }

    /// What the choice names, before anything is sent.
    public func targetLine(assistantName: String?) -> String {
        switch choice {
        case .lastCommit:
            guard let c = status.section.value?.lastCommit else { return "No commit has been reported yet." }
            let who = VaultWho.name(source: c.author, author: nil, assistantName: assistantName).map { " by \($0)" } ?? ""
            return "Undo \(c.short) “\(c.subject)”\(who)."
        case .commit:
            return "Undo one commit, by its id."
        case .day:
            return "Put every note back as it was at the end of \(clock.day(day))."
        }
    }

    /// Ask — nothing changes until Approve in Needs You. Refused here, with
    /// nothing sent, unless this client is the local owner (ruling 7).
    public func requestRollback() async {
        guard reach.rewindsHistory else {
            rollback = .refused(VaultHistoryWords.onlyTheMac)
            return
        }
        guard let session, let target, rollback != .sending else { return }
        rollback = .sending
        let generation = session.generation
        let answer = await session.stores.rollback(target)
        guard session.generation == generation else { return }
        switch answer {
        case .success(let reply):
            rollback = .raised(RollbackPreview.from(reply.json))
            await onQueueChanged?()
        case .failure(let error):
            if case .http(403, let envelope) = error, envelope?.code == "local_only" {
                // The console says this client is not the Mac: the control goes.
                reach = .remote(via: "local_only")
                rollback = .refused(VaultHistoryWords.onlyTheMac)
            } else if error.wasHeldForReachability {
                rollback = .refused(StateWords.unreachable)
            } else {
                rollback = .refused(error.refusal ?? error.localizedDescription)
            }
        }
    }

    static func isCommitID(_ s: String) -> Bool {
        (7...64).contains(s.count) && s.allSatisfy { $0.isHexDigit && ($0.isNumber || $0.isLowercase) }
    }

    static func ymd(_ date: Date, _ zone: TimeZone) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = zone
        let d = cal.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", d.year ?? 1970, d.month ?? 1, d.day ?? 1)
    }
}

/// The history's fixed words, in one place.
public enum VaultHistoryWords {
    public static let history = "History"
    public static let rollBack = "Roll Back…"
    public static let restore = "Restore"
    public static let afterEveryCommit = "After every commit"
    public static let manual = "Manual — the reconciler never pushes on its own"
    public static let noRemote = "No remote — the history stays on this Mac"
    public static let notSinceStart = "Not since the reconciler started"
    public static let noConflict = "None"
    public static let onlyTheMac = "Restoring and rolling back happen only on this instance's Mac."
    public static let policyNote = "The policy is `deployment.yaml`'s vault: block, a protected file: change it on this Mac with `metistry vault settings --push … --pull …`. The reconciler is the sole committer, so the app runs no git of its own."
    public static let conflictNote = "A conflict stops the sync rather than guessing: nothing is pushed until it is resolved in Obsidian or a terminal, and the next clean pull clears it. Writes keep committing here meanwhile."
    public static let rollbackNote = "Roll Back never rewrites history. It asks in Needs You first, naming what it would undo; Approve makes one new commit, as you, and undoing it is rolling back that commit. Configuration is left as it is — that is the CLI's, with --include-config."
    public static let askToRollBack = "Ask in Needs You"
    public static let waitingInNeedsYou = "Waiting in Needs You — nothing has changed yet. Approve it there to roll back."
    public static let alreadyWaiting = "This rollback was already waiting in Needs You — nothing has changed yet."
    public static let current = "Current"
    public static let showVersion = "Show This Version"
    public static let hideVersion = "Hide This Version"
    public static let noHistory = "No commits name this page yet."
    public static let restoreWaiting = "A restore is waiting — answer it above."
    public static let renamedFrom = "Under its earlier name — restore from a commit after the rename."
    public static let deletedHere = "The page was deleted in this commit — restore from the one before."
    public static let restoreRule = "Restore never rewrites history: it asks first, and Approve writes the old words back as a new commit, as you. The history keeps every version, including the one it replaces."
}

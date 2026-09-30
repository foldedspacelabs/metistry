// Settings ▸ Secrets (T6-14; screen-19 §1, plan §2.14): the owner's named
// secrets, per instance, and what each is allowed to do.
//
// WHAT THIS PANE CAN HOLD. A secret's name, its *Sent only to* hosts, its
// *Who may use it* grants, when the service says it expires, whether this
// instance's Keychain account holds an item, and when a run last filled it
// in — `GET /api/secrets`, whose rows are built field by field and have no
// field a value could ride in (docs/ops/client-api.md). `NamedSecret` below
// mirrors that row and nothing else.
//
// THE ONE PLACE A VALUE PASSES THROUGH. New Secret and Replace take a value
// in a `SecureField` bound to `SecretDraft.value`. `saveSecret()` copies it
// into the command's standard input and clears the draft BEFORE the process
// starts, and the `ManagementCommand` holding it is a local that goes out of
// scope when the CLI returns. It is never in argv (the CLI reads it from
// stdin only — `metistry secrets set|replace`), never in an outcome, a log
// line or a confirmation, and `ManagementCommand`'s description redacts it
// (below). A refused write reopens the sheet with the name and hosts kept
// and the value field empty: the owner pastes it again rather than the app
// holding it across a failure.
//
// EVERY WRITE IS A §2.2 VERB (M7), CONFIRMED. Set and Replace are confirmed by
// their sheet, which shows the exact command before its button runs it (an
// alert over a closing sheet is not reliably presented on the Mac); Sent
// Only To, a grant and Delete are confirmed by the window's alert, naming
// what each costs. No console route is added for any of it (invariant 10).
//
// A REFUSAL IS THE CLI'S. The app checks nothing the CLI checks — a name, a
// host, a grantee. X-41 will make a secret an owner door holds refuse any
// `connection:` or `agent:` grantee at the tool; that refusal lands on the
// grantee's own row, in the CLI's words, and the switch stays where the file
// has it.

import Foundation
import Observation

// MARK: - The rows

/// *Who may use it*: On · Ask · Off. A grantee not listed is Off.
public enum SecretGrantMode: String, CaseIterable, Sendable, Identifiable {
    case on, ask, off

    public var id: String { rawValue }

    /// Title Case — a control label (design-system P10).
    public var title: String {
        switch self {
        case .on: return "On"
        case .ask: return "Ask"
        case .off: return "Off"
        }
    }

    /// What the mode means, as the confirmation says it.
    public var meaning: String {
        switch self {
        case .on: return "Metistry fills it in whenever it is used."
        case .ask: return "Each use waits for your answer in Needs You."
        case .off: return "Metistry refuses to fill it in."
        }
    }
}

public struct SecretGrant: Equatable, Sendable {
    /// `connection:<name>`, `agent:<id>` — or a kind a newer CLI adds, as spelled.
    public let to: String
    public let mode: SecretGrantMode

    public init(to: String, mode: SecretGrantMode) {
        self.to = to
        self.mode = mode
    }
}

/// Someone a secret can be granted to. The grantee is the CLI's own spelling
/// (`connection:github`); the kind is read off it and never decides anything
/// here — the CLI decides which grantees a secret accepts.
public struct SecretGrantee: Identifiable, Hashable, Sendable, Comparable {
    public let id: String

    public init(_ id: String) {
        self.id = id
    }

    public var kind: String {
        guard let colon = id.firstIndex(of: ":") else { return "" }
        return String(id[..<colon])
    }

    public var name: String {
        guard let colon = id.firstIndex(of: ":") else { return id }
        return String(id[id.index(after: colon)...])
    }

    /// *the github connection*, *agent devin* — sentence case, for prose.
    public var spoken: String {
        switch kind {
        case "connection": return "the \(name) connection"
        case "agent": return "agent \(name)"
        case "provider": return "the \(name) provider"
        default: return id
        }
    }

    /// What the kind is, under the name.
    public var kindLabel: String {
        switch kind {
        case "connection": return "Connection"
        case "agent": return "Agent"
        case "provider": return "Compute provider"
        default: return kind.isEmpty ? "Grantee" : kind
        }
    }

    /// How a granted secret reaches it (screen-19 §1.1, "with how it is used").
    public func howUsed(_ secret: NamedSecret) -> String {
        switch kind {
        case "agent":
            return "Run on this Mac, it gets the secret as the environment variable \(secret.environmentName); the transcript shows the name."
        case "connection", "provider":
            return secret.hosts.isEmpty
                ? "Filled in on the way out — for no server until Sent Only To names one."
                : "Filled in on the way out, only to \(secret.hosts.joined(separator: ", "))."
        default:
            return "Filled in on the way out."
        }
    }

    public static func < (a: SecretGrantee, b: SecretGrantee) -> Bool {
        func rank(_ k: String) -> Int { k == "connection" ? 0 : k == "agent" ? 1 : 2 }
        return (rank(a.kind), a.id) < (rank(b.kind), b.id)
    }
}

/// One row of `GET /api/secrets` — names and policy, never a value. There is
/// no field here a value could be put in.
public struct NamedSecret: Identifiable, Equatable, Sendable {
    public let name: String
    /// *Sent only to*.
    public let hosts: [String]
    /// *Who may use it*.
    public let grants: [SecretGrant]
    /// Where the service reports one: a date or a date-time, as the file has it.
    public let expires: String?
    /// Whether THIS instance's Keychain account holds an item; nil where the
    /// console has no Keychain to ask.
    public let present: Bool?
    /// The newest run that filled it in; nil for never.
    public let lastUsed: Date?

    public var id: String { name }

    public init(name: String, hosts: [String] = [], grants: [SecretGrant] = [], expires: String? = nil, present: Bool? = true, lastUsed: Date? = nil) {
        self.name = name
        self.hosts = hosts
        self.grants = grants
        self.expires = expires
        self.present = present
        self.lastUsed = lastUsed
    }

    public init?(json: JSONValue) {
        guard let name = json.string("name") else { return nil }
        var grants: [SecretGrant] = []
        if let rows = json["grants"]?.arrayValue {
            for row in rows {
                if let to = row.string("to"), let mode = row.string("mode").flatMap(SecretGrantMode.init(rawValue:)) {
                    grants.append(SecretGrant(to: to, mode: mode))
                }
            }
        } else if let map = json["grants"], case .object(let fields) = map {
            // the file's own spelling, `{connection:github: on}`
            for (to, mode) in fields.sorted(by: { $0.key < $1.key }) {
                if let m = mode.stringValue.flatMap(SecretGrantMode.init(rawValue:)) { grants.append(SecretGrant(to: to, mode: m)) }
            }
        }
        self.init(
            name: name,
            hosts: json["hosts"]?.arrayValue?.compactMap(\.stringValue) ?? [],
            grants: grants,
            expires: json.string("expires"),
            present: json.bool("present"),
            lastUsed: WireTime.date(json.string("last_used", "lastUsed"))
        )
    }

    /// `{secrets: […]}`, or a bare array.
    public static func list(_ json: JSONValue) -> [NamedSecret] {
        (json["secrets"]?.arrayValue ?? json.arrayValue ?? []).compactMap(NamedSecret.init(json:))
    }

    /// `github_write` → `GITHUB_WRITE`: how a local agent granted it sees it.
    public var environmentName: String { name.uppercased() }

    public func mode(for grantee: String) -> SecretGrantMode {
        grants.first { $0.to == grantee }?.mode ?? .off
    }

    /// Granted On or Ask — who uses it.
    public var usedBy: [SecretGrant] { grants.filter { $0.mode != .off } }

    public var expiryDate: Date? {
        guard let expires else { return nil }
        if let date = WireTime.date(expires) { return date }
        let day = DateFormatter()
        day.locale = Locale(identifier: "en_US_POSIX")
        day.timeZone = TimeZone(identifier: "UTC")
        day.dateFormat = "yyyy-MM-dd"
        // a date expires at the END of that day
        return day.date(from: expires).map { $0.addingTimeInterval(86_400) }
    }

    public func isExpired(now: Date) -> Bool {
        expiryDate.map { $0 <= now } ?? false
    }

    /// The list's **Used by** column.
    public var usedByLine: String {
        let used = usedBy
        guard !used.isEmpty else { return "No one yet" }
        return used.map { g in
            let who = SecretGrantee(g.to)
            return g.mode == .ask ? "\(who.id) (Ask)" : who.id
        }.joined(separator: ", ")
    }

    /// The list's **Sent only to** column.
    public var sentOnlyToLine: String {
        hosts.isEmpty ? "No host — filled in for no server" : hosts.joined(separator: ", ")
    }

    /// The list's last column: *Expired* (in the failed ink), the age, or *Never used*.
    public func lastUsedLine(now: Date) -> String {
        if isExpired(now: now) { return "Expired" }
        guard let lastUsed else { return "Never used" }
        return "Used \(ClockTime.age(now.timeIntervalSince(lastUsed)))"
    }

    /// The Value section's one line about the item.
    public var presenceLine: String {
        switch present {
        case .some(true): return "Set — in this Mac's Keychain, under this instance only"
        case .some(false): return "Missing from this Mac's Keychain — Replace puts a value back"
        case .none: return "The console has no Keychain to ask; `metistry secrets list --named` on the Mac says"
        }
    }
}

/// New Secret or Replace, as its sheet holds it. `value` is bound to a
/// `SecureField` and is read out once, by `saveSecret()`.
public struct SecretDraft: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public enum Mode: Equatable, Sendable {
        case new
        case replace(String)
    }

    public var mode: Mode
    public var name: String
    /// *Sent only to*, as typed: commas or spaces between hosts. New only.
    public var hosts: String
    /// `--expires`, when the service says one. Optional.
    public var expires: String
    /// The pasted value. Never displayed, never logged, never in argv.
    public var value: String
    /// The CLI's refusal of the last try, in its own words.
    public var refusal: String?

    public init(mode: Mode = .new, name: String = "", hosts: String = "", expires: String = "", value: String = "", refusal: String? = nil) {
        self.mode = mode
        if case .replace(let existing) = mode { self.name = existing } else { self.name = name }
        self.hosts = hosts
        self.expires = expires
        self.value = value
        self.refusal = refusal
    }

    public var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    public var isReplace: Bool {
        if case .replace = mode { return true }
        return false
    }

    /// `metistry secrets set|replace …` — without the value, which is not an
    /// argument and cannot become one.
    public func arguments(instanceDir: URL?) -> [String] {
        var out = ["secrets", isReplace ? "replace" : "set", trimmedName]
        if !isReplace {
            let list = Self.hostList(hosts)
            if !list.isEmpty { out += ["--hosts", list.joined(separator: ",")] }
        }
        let date = expires.trimmingCharacters(in: .whitespacesAndNewlines)
        if !date.isEmpty { out += ["--expires", date] }
        if let instanceDir { out += ["--instance", instanceDir.path] }
        return out
    }

    /// Whether the sheet's button can run: a name and a value. Everything else
    /// about them is the CLI's to judge.
    public var canSave: Bool {
        !trimmedName.isEmpty && !value.isEmpty
    }

    /// `api.github.com, uploads.github.com` → two hosts. Spelling is the CLI's to judge.
    public static func hostList(_ text: String) -> [String] {
        text.split(whereSeparator: { $0 == "," || $0.isWhitespace }).map(String.init)
    }

    // A draft printed, dumped or interpolated says whether it holds a value —
    // never the value (a `#expect` failure or a stray `print` included).
    public var description: String {
        "SecretDraft(\(isReplace ? "replace" : "new") \(trimmedName), value: \(value.isEmpty ? "empty" : "<redacted>"))"
    }

    public var debugDescription: String { description }

    public var customMirror: Mirror {
        Mirror(self, children: ["mode": isReplace ? "replace" : "new", "name": trimmedName, "value": value.isEmpty ? "empty" : "<redacted>"])
    }
}

// A command carrying a value on stdin is printed, dumped or interpolated
// without it. The value's only way out of a `ManagementCommand` is the
// runner's pipe to the child (management-runner.swift).
extension ManagementCommand: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public var description: String {
        (["metistry"] + arguments).joined(separator: " ") + (standardInput == nil ? "" : " < <redacted stdin>")
    }

    public var debugDescription: String { description }

    public var customMirror: Mirror {
        Mirror(self, children: ["row": row.rawValue, "arguments": arguments, "standardInput": standardInput == nil ? "none" : "<redacted>"])
    }
}

/// What deleting a secret stops (components-03 §3: an irreversible act is
/// confirmed naming its cost): every file `secrets remove`'s preview names,
/// said as what it is, and everyone still granted it.
public struct SecretRemovalCost: Equatable, Sendable {
    public let name: String
    /// Instance-relative files that reference `{{ secret.<name> }}` — the CLI's.
    public let referencedBy: [String]
    /// On or Ask grants the file still holds.
    public let granted: [SecretGrant]

    public init(name: String, referencedBy: [String], granted: [SecretGrant]) {
        self.name = name
        self.referencedBy = referencedBy
        self.granted = granted
    }

    /// `referencedBy` out of `secrets remove <name> --json`'s preview.
    public static func referenced(_ stdout: String) -> [String]? {
        guard let data = stdout.data(using: .utf8), let json = try? JSONValue.parse(data) else { return nil }
        guard let rows = json["referencedBy"]?.arrayValue ?? json["referenced_by"]?.arrayValue else { return nil }
        return rows.compactMap(\.stringValue)
    }

    /// A file, said as the thing it stands for.
    public static func thing(_ file: String) -> String {
        let parts = file.split(separator: "/").map(String.init)
        let base = (parts.last ?? file).split(separator: ".").first.map(String.init) ?? file
        if parts.contains("connections") { return "the \(base) connection (\(file))" }
        if parts.contains("agents") { return "agent \(base) (\(file))" }
        if base == "compute" { return "compute — a provider's key (\(file))" }
        return file
    }

    /// The things that stop, in order: the files, then grantees no file named.
    public var stops: [String] {
        var out = referencedBy.map(Self.thing)
        for grant in granted {
            let who = SecretGrantee(grant.to)
            let named = referencedBy.contains { $0.split(separator: "/").map(String.init).contains { $0.split(separator: ".").first.map(String.init) == who.name } }
            if !named { out.append("\(who.spoken), granted \(grant.mode.title)") }
        }
        return out
    }

    /// The confirmation's cost sentence.
    public var sentence: String {
        let gone = "The value is deleted from this Mac's Keychain and \(name) from secrets.yaml (a protected file, written as you). It cannot be read back — only pasted again."
        let what = stops
        guard !what.isEmpty else { return "Nothing under .metistry/ references it, and no one is granted it. \(gone)" }
        return "What stops: \(what.joined(separator: "; ")). \(gone)"
    }
}

/// A refusal said on one secret's row.
public struct SecretRowRefusal: Equatable, Sendable {
    public let name: String
    public let words: String

    public init(name: String, words: String) {
        self.name = name
        self.words = words
    }
}

// MARK: - The pane's state

@MainActor
@Observable
public final class SecretsModel {
    public private(set) var rows: [NamedSecret] = []
    public var phase: ReadPhase = .idle
    /// Connections and agents this instance has, to offer a grant to — from
    /// `GET /api/connections` and `GET /api/agents`. Best effort: a secret's
    /// own grantees are always listed.
    public private(set) var known: [SecretGrantee] = []
    /// The New Secret / Replace sheet. `nil`: closed.
    public var draft: SecretDraft?
    /// The secrets whose detail is open.
    public var expanded: Set<String> = []
    /// *Sent only to*, being edited, per secret.
    public var hostDrafts: [String: String] = [:]
    /// The CLI's refusal of a grant, on that grantee's row: `name|grantee` → words.
    public private(set) var grantRefusals: [String: String] = [:]
    /// The secret whose Delete preview is running.
    public var previewing: String?
    /// Delete's preview could not run: its words, on the secret's row.
    public var removalRefusal: SecretRowRefusal?

    public init() {}

    /// Dropped on every instance switch: a row belongs to the install it was asked about.
    public func reset() {
        rows = []
        phase = .idle
        known = []
        draft = nil
        expanded = []
        hostDrafts = [:]
        grantRefusals = [:]
        previewing = nil
        removalRefusal = nil
    }

    func adopt(rows: [NamedSecret]) {
        self.rows = rows
        phase = .read
        // an edit in progress survives a re-read; a secret that is gone takes its edit with it
        let names = Set(rows.map(\.name))
        hostDrafts = hostDrafts.filter { names.contains($0.key) }
        expanded = expanded.intersection(names)
    }

    func adopt(known: [SecretGrantee]) {
        self.known = known
    }

    /// Everyone a secret's *Who may use it* lists: this instance's connections
    /// and agents, and anyone the file grants whom neither read named.
    public func grantees(for secret: NamedSecret) -> [SecretGrantee] {
        Array(Set(known + secret.grants.map { SecretGrantee($0.to) })).sorted()
    }

    public static func refusalKey(_ name: String, _ grantee: String) -> String { "\(name)|\(grantee)" }

    public func grantRefusal(_ name: String, _ grantee: String) -> String? {
        grantRefusals[Self.refusalKey(name, grantee)]
    }

    func setGrantRefusal(_ name: String, _ grantee: String, _ words: String?) {
        grantRefusals[Self.refusalKey(name, grantee)] = words
    }

    /// The Sent Only To field's text: the edit in progress, or the file's.
    public func hostText(_ secret: NamedSecret) -> String {
        hostDrafts[secret.name] ?? secret.hosts.joined(separator: ", ")
    }

    public func hostsChanged(_ secret: NamedSecret) -> Bool {
        guard let text = hostDrafts[secret.name] else { return false }
        return SecretDraft.hostList(text) != secret.hosts
    }

    /// *Used, never read* (screen-19 §1.1), under the list.
    public static let usedNeverRead =
        "Used, never read. Metistry fills a secret in on the way out, only to the hosts it is sent to, and redacts it on the way back. "
        + "A model never sees a value, so a secret cannot go in instructions. Reference one as {{ secret.name }} anywhere a value is typed. "
        + "A value is never shown again after it is stored: Replace swaps it."

    /// Metistry's own, under their group.
    public static let ownNote =
        "The tokens and passwords the install itself runs on — its database, its bridges, the owner door — named here, never shown. "
        + "They are not granted to anyone and are not referenced as {{ secret.name }}. Rotating one is not a verb this app runs "
        + "(§2.2 M7 lists set, replace, remove, hosts and grant); `metistry secrets` in Terminal holds them (docs/ops/cli.md)."
}

// MARK: - Reading and writing, through Settings' session and runner

extension SettingsModel {
    /// `GET /api/secrets`, then who a grant could name: `GET /api/connections`
    /// and `GET /api/agents`. Values are not requested, not served, and could
    /// not be decoded into anything this pane holds.
    public func refreshSecretsPane() async {
        guard let session else {
            secretsPane.phase = .unavailable("no console session for this instance")
            return
        }
        secretsPane.phase = .reading
        switch await session.stores.secrets() {
        case .success(let list):
            secretsPane.adopt(rows: NamedSecret.list(list.json))
        case .failure(let error):
            secretsPane.phase = .unavailable(error.localizedDescription)
        }
        var known: [SecretGrantee] = []
        if case .success(let list) = await session.stores.connections() {
            known += (list.json["connections"]?.arrayValue ?? []).compactMap { $0.string("name") }.map { SecretGrantee("connection:\($0)") }
        }
        if case .success(let list) = await session.stores.agents() {
            // the assistant's own row is the instance, not a grantee; a revoked one authenticates nothing
            known += list.agents.filter { $0.kind != "internal" && !$0.revoked }.map { SecretGrantee("agent:\($0.id)") }
        }
        secretsPane.adopt(known: known)
    }

    private var instanceArguments: [String] {
        instanceDir.map { ["--instance", $0.path] } ?? []
    }

    // MARK: New Secret and Replace (confirmed by their sheet)

    public func beginNewSecret(name: String = "", value: String = "") {
        variablesPane.draft = nil
        secretsPane.draft = SecretDraft(mode: .new, name: name, value: value)
    }

    public func beginReplace(_ name: String) {
        variablesPane.draft = nil
        secretsPane.draft = SecretDraft(mode: .replace(name))
    }

    /// Cancel, Esc, or the sheet closing any other way: the value goes with it.
    public func cancelSecretDraft() {
        secretsPane.draft = nil
    }

    /// The exact command the sheet shows before its button runs it — the
    /// value is not in it, and cannot be.
    public func plannedSecretCommand(_ draft: SecretDraft) -> [String]? {
        guard let command = ManagementCommand(.secrets, draft.arguments(instanceDir: instanceDir)) else { return nil }
        return management?.plannedArguments(command) ?? (["metistry"] + command.arguments)
    }

    /// Store Secret / Replace Value. The value is read out of the draft into
    /// the command's standard input, and the draft is cleared BEFORE the
    /// process starts; when the CLI returns, the command — the only other
    /// holder — goes out of scope. A refusal reopens the sheet with the name,
    /// hosts and expiry kept and the value field empty.
    public func saveSecret() async {
        guard let draft = secretsPane.draft, draft.canSave else { return }
        secretsPane.draft = nil
        guard let command = ManagementCommand(.secrets, draft.arguments(instanceDir: instanceDir), standardInput: draft.value) else { return }
        await run(command, after: .secrets)
        if let outcome, !outcome.ok {
            var kept = draft
            kept.value = ""
            kept.refusal = outcome.words
            secretsPane.draft = kept
        }
    }

    // MARK: Sent only to, a grant, Delete (confirmed by the window's alert)

    public func proposeHosts(_ secret: NamedSecret) {
        let hosts = SecretDraft.hostList(secretsPane.hostText(secret))
        guard hosts != secret.hosts,
              let command = ManagementCommand(.secrets, ["secrets", "hosts", secret.name] + (hosts.isEmpty ? ["--clear"] : hosts) + instanceArguments)
        else { return }
        confirmation = SettingsConfirmation(
            title: hosts.isEmpty ? "Send \(secret.name) to no server?" : "Send \(secret.name) only to \(hosts.joined(separator: ", "))?",
            cost: (hosts.isEmpty
                ? "Metistry fills it in for no server; a local agent granted it still gets it as \(secret.environmentName)."
                : "Metistry refuses to fill it in for any other host.")
                + " secrets.yaml is a protected file: this is written as you, through the reconciler, and shows in Activity.",
            actionTitle: "Change Hosts",
            command: command,
            after: .secrets
        )
    }

    public func proposeGrant(_ secret: NamedSecret, to grantee: SecretGrantee, _ mode: SecretGrantMode) {
        guard secret.mode(for: grantee.id) != mode,
              let command = ManagementCommand(.secrets, ["secrets", "grant", secret.name, grantee.id, mode.rawValue] + instanceArguments)
        else { return }
        confirmation = SettingsConfirmation(
            title: "\(mode.title) for \(grantee.spoken)?",
            cost: "\(mode.meaning) \(mode == .off ? "" : grantee.howUsed(secret) + " ")Written to secrets.yaml as you, through the reconciler. Metistry may refuse a grantee a secret cannot have, and says why on its row.",
            actionTitle: mode == .off ? "Turn Off" : "Allow",
            command: command,
            after: .secrets
        )
    }

    /// Delete…: `secrets remove <name>`'s preview first — it writes nothing
    /// and names every file that references the secret — then the
    /// confirmation, naming what stops.
    public func proposeSecretRemoval(_ secret: NamedSecret) async {
        secretsPane.removalRefusal = nil
        guard let runner = management,
              let preview = ManagementCommand(.secrets, ["secrets", "remove", secret.name, "--json"] + instanceArguments),
              let remove = ManagementCommand(.secrets, ["secrets", "remove", secret.name, "--yes"] + instanceArguments)
        else {
            secretsPane.removalRefusal = SecretRowRefusal(name: secret.name, words: "No metistry runtime located — finish step 1 of first run.")
            return
        }
        secretsPane.previewing = secret.name
        defer { secretsPane.previewing = nil }
        let result: CommandResult
        do {
            result = try await runner.run(preview) { _ in }
        } catch {
            secretsPane.removalRefusal = SecretRowRefusal(name: secret.name, words: error.localizedDescription)
            return
        }
        guard result.ok, let referenced = SecretRemovalCost.referenced(result.stdout) else {
            secretsPane.removalRefusal = SecretRowRefusal(name: secret.name, words: Self.cliWords(result, command: preview.description))
            return
        }
        let cost = SecretRemovalCost(name: secret.name, referencedBy: referenced, granted: secret.usedBy)
        confirmation = SettingsConfirmation(
            title: "Delete \(secret.name)?",
            cost: cost.sentence,
            actionTitle: "Delete",
            command: remove,
            destructive: true,
            after: .secrets
        )
    }

    /// After an M7 write: a grant's refusal goes on its grantee's row, in the
    /// CLI's words; then the list is read again.
    func secretsWriteFinished(_ command: ManagementCommand) async {
        let args = command.arguments
        if args.starts(with: ["secrets", "grant"]), args.count >= 5 {
            let words = outcome.flatMap { $0.ok ? nil : Self.withoutVerbPrefix($0.words, "metistry secrets grant: ") }
            secretsPane.setGrantRefusal(args[2], args[3], words)
        }
        await refreshSecretsPane()
    }

    static func withoutVerbPrefix(_ words: String, _ prefix: String) -> String {
        words.hasPrefix(prefix) ? String(words.dropFirst(prefix.count)) : words
    }
}

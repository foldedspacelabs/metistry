// Remote access (design-build-plan §2.23, X-107): what `metistry remote`
// reports, the closed set of its argv shapes the Mac may run, and Settings ▸
// Remote Access's model — the choice and mode, the origin, the provider's
// doctor rows with when they were checked, Change… (the guided flow,
// remote-access-flow.swift), Test and Turn Off.
//
// EVERYTHING DRIVES `metistry remote` OVER THE CLI TRANSPORT (plan §2.2, M20).
// The app talks to no provider itself: it does not open Tailscale's socket,
// does not fetch a pack, does not write `deployment.yaml`. The CLI does each
// of those, and the app shows what the CLI said — its own words (§3.16), its
// doctor sentences, the links it printed.
//
// THE SET IS CLOSED AT THE TYPE (invariant 10). `ManagementRow.remoteAccess`
// does not take "anything starting with `remote`": `RemoteAccessArgv.accepts`
// is a grammar of exact shapes — `remote status --json`, `remote test
// --json`, `remote off [--yes] --json`, `remote set <provider> [that
// provider's flags] [--yes] --json` — no wider than what the app runs: each
// flag once, each value from a known list or a bare name, nothing positional
// after the provider, `--json` always (the app parses every answer), and
// `--token` only ever a switch. `remote authorize` is not here: the flow does
// not run it (X-106's `configure` signs in itself), so the door does not
// admit it — doctor's *Sign in to Tailscale* action is shown with Copy. A `ManagementCommand(.remoteAccess, …)` that
// does not fit is nil, so no runner can be handed it. A PASTED TOKEN NEVER
// REACHES ARGV: `RemoteSetPlan` puts it on the command's standard input and
// the grammar refuses `--token=<v>` and any value after `--token`.
//
// THE SWITCHING CEREMONY IS THE CLI'S (configure → wait for the new origin to
// answer from this Mac → the protected write → revoke the old). The app only
// drives it and shows it — and, before a switch away from a provider that has
// phones, a `CostConfirmation` naming what the old provider's revoke undoes
// and which phones stop signing in, in the CLI's own preview words.

import Foundation
import Observation

// MARK: - The words

public enum RemoteAccessWords {
    public static let title = "Remote Access"
    public static let question = "How should your phone reach this Mac?"
    public static let recommended = "Recommended"
    public static let notYetAvailable = "Not yet available"
    public static let change = "Change…"
    public static let test = "Test"
    public static let turnOff = "Turn Off"
    public static let turnOffTitle = "Turn Off Remote Access?"
    public static let cancel = "Cancel"
    /// Step 6's words (§2.23): what the check proves, and never more. A Mac on
    /// the same tailnet may reach a Funnel name over the tailnet, so the check
    /// is said as *answers from this Mac* — not as reaching the phone.
    public static let answersFromThisMac = "answers from this Mac"
    public static let checkTitle = "Check: answers from this Mac"
    public static let checkNote = "The provider's own status, then GET <origin>/health from this Mac naming this instance. It proves this Mac is published, not that your phone can open it — Add a Phone's *Opened on your phone* is that proof."
    public static let noneOrigin = "none — your phone can't reach this Mac"
    public static let continueWithNone = "Continuing with None is fine: nothing is exposed, and Settings ▸ Remote Access is here whenever you want to change it."
    public static let readCommand = "metistry remote status --json"
    public static let testCommand = "metistry remote test --json"
    public static let turnOffNote = "Turning it off runs the provider's revoke — what it undoes and what is left for you at the provider are named first — and your phone can't reach this Mac until a provider is chosen again."
    public static let strandedFallback = "Phones added under the current address stop signing in: a passkey is bound to the host it was created on. Add each phone again afterwards; Devices marks the ones to remove."
    public static let turnOffFallbackCost = "Your phone can't reach this Mac until a provider is chosen again."

    /// *Set Up Tailscale*, *Switch to Tailscale* — the act's own verb (P3).
    public static func setUp(_ label: String) -> String { "Set Up \(label)" }
    public static func switchTo(_ label: String) -> String { "Switch to \(label)" }
    public static func switchTitle(_ label: String) -> String { "Switch to \(label)?" }
    public static func switchHeading(from provider: String) -> String { "Before anything changes — \(provider) is undone only once the new address answers from this Mac:" }
    public static func turnOffHeading(_ provider: String) -> String { "Turning it off undoes what \(provider) set up:" }
    public static func leftForOwner(_ provider: String, _ what: String) -> String { "Left for you at \(provider): \(what)" }
    /// *Checked 9:41 AM* under the rows.
    public static func checked(_ when: String) -> String { "Checked \(when)" }
    /// Devices (§2.23): a passkey whose host is no longer a configured origin.
    public static func stranded(_ host: String) -> String { "Added for \(host). Remove it and add this phone again." }
    /// What `remote.provider` reads as, said as a person would — `AddPhoneWords.providerName`'s table.
    public static func providerName(_ id: String) -> String { AddPhoneWords.providerName(id) }
}

// MARK: - What `metistry remote --json` says

/// One row of the chooser, as `remote --json`'s `choices` carries it (plan
/// §2.23, "The choices"): the facts are the CLI's, so the wizard, the pane and
/// the terminal cannot disagree about them.
public struct RemoteChoice: Sendable, Equatable, Identifiable, Decodable {
    public let id: String
    public let label: String
    /// `default`, `recommended`, or nothing.
    public let tag: String?
    public let reachableFrom: String
    public let tlsEndsAt: String
    public let cost: String
    public let needs: String
    /// Whether this release has an adapter for it. False reads as *Not yet available*.
    public let available: Bool

    enum CodingKeys: String, CodingKey {
        case id, label, tag, cost, needs, available
        case reachableFrom = "reachable_from"
        case tlsEndsAt = "tls_ends_at"
    }

    public init(id: String, label: String, tag: String? = nil, reachableFrom: String, tlsEndsAt: String, cost: String, needs: String, available: Bool) {
        self.id = id
        self.label = label
        self.tag = tag
        self.reachableFrom = reachableFrom
        self.tlsEndsAt = tlsEndsAt
        self.cost = cost
        self.needs = needs
        self.available = available
    }

    public var isRecommended: Bool { tag == "recommended" }

    /// *Needs a Tailscale account · reachable from the internet; the phone needs no app · TLS ends at the Mac · $0 (all plans)*
    public var detail: String {
        "Needs \(needs) · reachable from \(reachableFrom) · TLS ends at \(tlsEndsAt) · \(cost)"
    }
}

/// `metistry remote [status] --json`: the record, the origins it renders, the
/// chooser and doctor's `remote` rows (docs/ops/cli.md).
public struct RemoteStatus: Sendable, Equatable, Decodable {
    public let provider: String
    public let mode: String?
    public let origin: String?
    public let settings: [String: String]
    /// Which file the record came from.
    public let from: String
    /// `METISTRY_ORIGIN` as the console runs with it — the remote origin first, loopback second.
    public let origins: [String]
    public let droppedOrigins: [String]
    /// The provider ids this release can run.
    public let available: [String]
    public let choices: [RemoteChoice]
    /// Doctor's `remote` rows — core's CheckResult shape, the same one `doctor --json` prints.
    public let rows: [DoctorRow]
    public let ok: Bool

    enum CodingKeys: String, CodingKey {
        case provider, mode, origin, settings, from, origins, available, choices, rows, ok
        case droppedOrigins = "dropped_origins"
    }

    public init(provider: String, mode: String?, origin: String?, settings: [String: String], from: String, origins: [String], droppedOrigins: [String], available: [String], choices: [RemoteChoice], rows: [DoctorRow], ok: Bool) {
        self.provider = provider
        self.mode = mode
        self.origin = origin
        self.settings = settings
        self.from = from
        self.origins = origins
        self.droppedOrigins = droppedOrigins
        self.available = available
        self.choices = choices
        self.rows = rows
        self.ok = ok
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        provider = try c.decode(String.self, forKey: .provider)
        mode = try c.decodeIfPresent(String.self, forKey: .mode)
        origin = try c.decodeIfPresent(String.self, forKey: .origin)
        settings = try c.decodeIfPresent([String: String].self, forKey: .settings) ?? [:]
        from = try c.decodeIfPresent(String.self, forKey: .from) ?? "deployment.yaml"
        origins = try c.decodeIfPresent([String].self, forKey: .origins) ?? []
        droppedOrigins = try c.decodeIfPresent([String].self, forKey: .droppedOrigins) ?? []
        available = try c.decodeIfPresent([String].self, forKey: .available) ?? []
        choices = try c.decodeIfPresent([RemoteChoice].self, forKey: .choices) ?? []
        rows = try c.decodeIfPresent([DoctorRow].self, forKey: .rows) ?? []
        ok = try c.decodeIfPresent(Bool.self, forKey: .ok) ?? !rows.contains { $0.status == .failed }
    }

    /// The trailing JSON object of what the verb printed, decoded.
    public static func parse(_ stdout: String) -> RemoteStatus? {
        RemoteAccessJSON.decode(RemoteStatus.self, trailing: stdout)
    }

    public var isNone: Bool { provider == "none" }
    public var choice: RemoteChoice? { choices.first { $0.id == provider } }
    /// *Tailscale — Any browser (Funnel)* or *Tailscale — Only my devices
    /// (tailnet)* — the chooser's label, the mode named where the label does
    /// not already; the id when the chooser does not name it.
    public var label: String {
        if provider == "tailscale", mode == "tailnet" { return "Tailscale — Only my devices (tailnet)" }
        guard let choice else { return RemoteAccessWords.providerName(provider) + (mode.map { " (\($0))" } ?? "") }
        if let mode, !choice.label.lowercased().contains(mode) { return "\(choice.label) (\(mode))" }
        return choice.label
    }
    /// The hosts a passkey may be bound to and still sign in: every configured origin's host, lowercased.
    public var configuredHosts: [String] {
        origins.compactMap { URL(string: $0)?.host?.lowercased() }
    }
}

/// `metistry remote set <provider> … --json` — a preview without `--yes`, the
/// change with it: `{from, provider, origin, applied, detail, revoked?,
/// detection, stranding?}` (docs/ops/cli.md).
public struct RemoteSetResult: Sendable, Equatable, Decodable {
    public struct Revoked: Sendable, Equatable, Decodable {
        public let undone: [String]
        public let leftForOwner: [String]
        enum CodingKeys: String, CodingKey {
            case undone
            case leftForOwner = "left_for_owner"
        }
        public init(undone: [String], leftForOwner: [String]) {
            self.undone = undone
            self.leftForOwner = leftForOwner
        }
    }

    public struct Detection: Sendable, Equatable, Decodable {
        public struct Tool: Sendable, Equatable, Decodable {
            public let present: Bool
            public let version: String?
            public let from: String?
            public init(present: Bool, version: String? = nil, from: String? = nil) {
                self.present = present
                self.version = version
                self.from = from
            }
        }
        public let tool: Tool
        public let signedIn: Bool?
        public let origin: String?
        public let wouldChange: [String]
        enum CodingKeys: String, CodingKey {
            case tool, origin
            case signedIn = "signed_in"
            case wouldChange = "would_change"
        }
        public init(tool: Tool, signedIn: Bool?, origin: String? = nil, wouldChange: [String]) {
            self.tool = tool
            self.signedIn = signedIn
            self.origin = origin
            self.wouldChange = wouldChange
        }
        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            tool = try c.decodeIfPresent(Tool.self, forKey: .tool) ?? Tool(present: false)
            signedIn = try c.decodeIfPresent(Bool.self, forKey: .signedIn)
            origin = try c.decodeIfPresent(String.self, forKey: .origin)
            wouldChange = try c.decodeIfPresent([String].self, forKey: .wouldChange) ?? []
        }
    }

    /// The provider the record named before.
    public let from: String
    public let provider: String
    public let origin: String?
    /// Whether the record was written. False for a preview.
    public let applied: Bool
    public let detail: String
    /// What the old provider's revoke undid — or, in a preview, would undo.
    public let revoked: Revoked?
    public let detection: Detection
    /// The CLI's own sentence about the phones a switch strands, when there are any.
    public let stranding: String?

    public init(from: String, provider: String, origin: String?, applied: Bool, detail: String, revoked: Revoked? = nil, detection: Detection, stranding: String? = nil) {
        self.from = from
        self.provider = provider
        self.origin = origin
        self.applied = applied
        self.detail = detail
        self.revoked = revoked
        self.detection = detection
        self.stranding = stranding
    }

    public static func parse(_ stdout: String) -> RemoteSetResult? {
        RemoteAccessJSON.decode(RemoteSetResult.self, trailing: stdout)
    }
}

/// `metistry remote test --json`: `{provider, origin, rows, ok}`.
public struct RemoteTestResult: Sendable, Equatable, Decodable {
    public let provider: String
    public let origin: String?
    public let rows: [DoctorRow]
    public let ok: Bool

    public init(provider: String, origin: String?, rows: [DoctorRow], ok: Bool) {
        self.provider = provider
        self.origin = origin
        self.rows = rows
        self.ok = ok
    }

    public static func parse(_ stdout: String) -> RemoteTestResult? {
        RemoteAccessJSON.decode(RemoteTestResult.self, trailing: stdout)
    }

    /// The rows that are not `ok` — each one's remediation is the doctor sentence the flow shows for its step.
    public var problems: [DoctorRow] { rows.filter { $0.status != .ok } }
}

/// The verbs narrate on the same pipe their `--json` document ends; the
/// document is the trailing object (cli-facts.swift, `parseTrailing`).
enum RemoteAccessJSON {
    static func decode<T: Decodable>(_ type: T.Type, trailing stdout: String) -> T? {
        guard let value = JSONValue.parseTrailing(in: stdout), let data = try? JSONEncoder().encode(value) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }
}

// MARK: - The closed set of argv shapes

/// The grammar of `metistry remote` as the Mac may run it (invariant 10). Each
/// shape is exact: the verb, its one positional where it has one, and a set of
/// flags each allowed at most once, with its value from a known list or a bare
/// name. Nothing here lets a value ride in argv that the plan says goes on
/// stdin — `--token` is a switch and only a switch.
public enum RemoteAccessArgv {
    /// The seven provider ids, in the chooser's order (core's `REMOTE_PROVIDERS`).
    public static let providers = ["none", "tailscale", "relay", "cloudflare", "zrok", "ngrok", "port-forward"]
    public static let tailscaleModes = ["funnel", "tailnet"]
    public static let ddnsProviders = ["desec", "cloudflare"]

    enum Flag: Equatable {
        /// A switch: present or not.
        case bare
        /// A value from a fixed list.
        case oneOf([String])
        /// A bare name: non-empty, no whitespace, not starting with `-`.
        case name
        /// A whole number.
        case number
    }

    /// The flags `remote set <provider>` takes, per provider (plan §2.23, "Provider flags").
    static func setFlags(for provider: String) -> [String: Flag] {
        let common: [String: Flag] = ["yes": .bare, "json": .bare]
        let own: [String: Flag]
        switch provider {
        case "none": own = [:]
        case "tailscale": own = ["mode": .oneOf(tailscaleModes), "use-app": .bare, "bundled": .bare]
        case "cloudflare": own = ["hostname": .name, "access": .bare, "token": .bare]
        case "zrok": own = ["name": .name, "token": .bare]
        case "ngrok": own = ["domain": .name, "token": .bare]
        case "port-forward": own = ["ddns": .oneOf(ddnsProviders), "hostname": .name, "manual": .number]
        default: own = [:]
        }
        return common.merging(own) { _, own in own }
    }

    /// True for exactly the shapes the Mac runs; false for everything else,
    /// including a `--flag=value` spelling, a repeated flag, a value where a
    /// switch goes, a positional after the provider, a missing `--json`, or a
    /// verb the app never runs (`authorize`).
    public static func accepts(_ arguments: [String]) -> Bool {
        guard arguments.first == "remote", arguments.count >= 2 else { return false }
        let verb = arguments[1]
        let parsed: [String: String]?
        switch verb {
        case "status", "test":
            parsed = flags(Array(arguments.dropFirst(2)), allowed: ["json": .bare])
        case "off":
            parsed = flags(Array(arguments.dropFirst(2)), allowed: ["yes": .bare, "json": .bare])
        case "set":
            guard arguments.count >= 3, providers.contains(arguments[2]) else { return false }
            parsed = flags(Array(arguments.dropFirst(3)), allowed: setFlags(for: arguments[2]))
        default:
            return false
        }
        // the app parses every answer, so every shape carries --json
        return parsed?["json"] != nil
    }

    /// The flags as `name → value`, or nil when anything is not in the grammar.
    static func flags(_ rest: [String], allowed: [String: Flag]) -> [String: String]? {
        var seen: [String: String] = [:]
        var index = 0
        while index < rest.count {
            let word = rest[index]
            // `--x=y` is refused outright: a value spelled into a flag is how a
            // token would slip past the stdin rule
            guard word.hasPrefix("--"), !word.contains("=") else { return nil }
            let name = String(word.dropFirst(2))
            guard let shape = allowed[name], seen[name] == nil else { return nil }
            switch shape {
            case .bare:
                seen[name] = ""
                index += 1
            case .oneOf, .name, .number:
                guard index + 1 < rest.count else { return nil }
                let value = rest[index + 1]
                guard isValue(value, shape) else { return nil }
                seen[name] = value
                index += 2
            }
        }
        return seen
    }

    static func isValue(_ value: String, _ shape: Flag) -> Bool {
        switch shape {
        case .bare: return false
        case .oneOf(let list): return list.contains(value)
        case .name: return !value.isEmpty && !value.hasPrefix("-") && value.rangeOfCharacter(from: .whitespacesAndNewlines) == nil
        case .number: return !value.isEmpty && value.allSatisfy(\.isNumber)
        }
    }
}

/// `metistry remote set <provider> …` as the flow builds it: the choice, its
/// flags, and — on standard input, never in the arguments — a pasted token.
public struct RemoteSetPlan: Sendable, Equatable {
    public var provider: String
    /// Tailscale's `--mode funnel|tailnet`.
    public var mode: String?
    /// Tailscale's `--use-app`: the owner's own app instead of the bundled node.
    public var useApp = false
    /// A hostname (cloudflare, port-forward), a reserved name (zrok), a dev domain (ngrok).
    public var hostname: String?
    public var name: String?
    public var domain: String?
    /// A pasted token, for a provider that takes one. It goes to stdin with `--token` as the switch.
    public var token: String?
    /// Without it the verb previews and changes nothing.
    public var yes = false

    public init(provider: String, mode: String? = nil, useApp: Bool = false, hostname: String? = nil, name: String? = nil, domain: String? = nil, token: String? = nil, yes: Bool = false) {
        self.provider = provider
        self.mode = mode
        self.useApp = useApp
        self.hostname = hostname
        self.name = name
        self.domain = domain
        self.token = token
        self.yes = yes
    }

    /// The arguments after `metistry`, always with `--json`.
    public var arguments: [String] {
        var args = ["remote", "set", provider]
        if let mode { args += ["--mode", mode] }
        if useApp { args.append("--use-app") }
        if let hostname { args += ["--hostname", hostname] }
        if let name { args += ["--name", name] }
        if let domain { args += ["--domain", domain] }
        if token != nil { args.append("--token") }
        if yes { args.append("--yes") }
        args.append("--json")
        return args
    }

    /// The command, or nil when the plan is outside the grammar (a value that
    /// is not a bare name, a flag the provider does not take). The token is
    /// the command's standard input and in no argument.
    public var command: ManagementCommand? {
        ManagementCommand(.remoteAccess, arguments, standardInput: token)
    }
}

// MARK: - Settings ▸ Remote Access

/// The pane's model: one read (`remote status --json`), re-done when the pane
/// opens and after every act; Test; Turn Off with its confirm; Change… hands
/// off to the guided flow.
@MainActor
@Observable
public final class RemoteAccessModel {
    public private(set) var status: RemoteStatus?
    public private(set) var phase: ReadPhase = .idle
    /// When the rows on screen were read.
    public private(set) var checkedAt: Date?
    /// `remote test --json`'s rows, while they are newer than the status read.
    public private(set) var testResult: RemoteTestResult?
    public private(set) var testing = false
    public private(set) var busy = false
    /// What the last act came to, under the section.
    public private(set) var note: ScheduledNote?
    /// Turn Off's confirm. Presenting it sends nothing.
    public var confirmation: CostConfirmation?
    /// The guided flow, while Change… is open.
    public private(set) var flow: RemoteAccessFlowModel?
    /// What the pane ran last, for the line under it.
    public private(set) var lastCommand: String?

    /// §2.2's runner — the session's, which follows every instance switch.
    @ObservationIgnored public var management: @MainActor () -> (any ManagementRunner)?
    @ObservationIgnored public var now: @MainActor () -> Date = Date.init
    @ObservationIgnored public var clock = ClockTime()
    /// Told every time the status is read: the Devices pane marks passkeys against it.
    @ObservationIgnored public var onStatus: @MainActor (RemoteStatus) -> Void = { _ in }
    /// The flow's Add a Phone…: the host decides which sheet (Settings ▸ Devices').
    @ObservationIgnored public var onAddPhone: @MainActor () -> Void = {}
    /// Builds the flow. A test hands in its own.
    @ObservationIgnored public var makeFlow: @MainActor (RemoteStatus?) -> RemoteAccessFlowModel = { _ in RemoteAccessFlowModel(management: nil) }

    public init(management: @escaping @MainActor () -> (any ManagementRunner)?) {
        self.management = management
        makeFlow = { [weak self] status in
            let flow = RemoteAccessFlowModel(management: self?.management())
            flow.preselect(status)
            return flow
        }
    }

    /// Dropped on every instance switch.
    public func reset() {
        status = nil
        phase = .idle
        checkedAt = nil
        testResult = nil
        testing = false
        busy = false
        note = nil
        confirmation = nil
        lastCommand = nil
        if let flow {
            self.flow = nil
            flow.cancel()
        }
    }

    // MARK: Reading

    /// `metistry remote status --json`.
    public func refresh() async {
        guard let runner = management(), let command = ManagementCommand(.remoteAccess, ["remote", "status", "--json"]) else {
            phase = .unavailable(CLIReadError.noRuntime.localizedDescription ?? "no runtime")
            return
        }
        phase = .reading
        lastCommand = RemoteAccessWords.readCommand
        do {
            // exit 1 means a row failed, not that the verb broke: the document is on stdout either way
            let result = try await runner.run(command) { _ in }
            if let read = RemoteStatus.parse(result.stdout) {
                status = read
                testResult = nil
                checkedAt = now()
                phase = .read
                onStatus(read)
            } else if CLIDegradation.isUnknownVerb(result) {
                phase = .unavailable(CLIDegradation.message(verb: "remote"))
            } else {
                phase = .unavailable(SettingsModel.cliWords(result, command: RemoteAccessWords.readCommand))
            }
        } catch {
            phase = .unavailable(error.localizedDescription)
        }
    }

    /// The configured origins' hosts — what a passkey must be bound to to sign in. Nil until read.
    public var configuredHosts: [String]? { status?.configuredHosts }

    /// The rows on screen: the test's when one ran since the last read, else the status read's.
    public var rows: [DoctorRow] { testResult?.rows ?? status?.rows ?? [] }

    /// *Checked 9:41 AM*, or nil before a read.
    public var checkedLine: String? {
        checkedAt.map { RemoteAccessWords.checked(clock.moment($0, now: now())) }
    }

    // MARK: Test

    /// `metistry remote test --json` — step 6: the provider's state, then
    /// `GET <origin>/health` from this Mac. Said as *answers from this Mac*.
    public func test() async {
        guard let runner = management(), let command = ManagementCommand(.remoteAccess, ["remote", "test", "--json"]) else { return }
        testing = true
        lastCommand = RemoteAccessWords.testCommand
        defer { testing = false }
        do {
            let result = try await runner.run(command) { _ in }
            if let read = RemoteTestResult.parse(result.stdout) {
                testResult = read
                checkedAt = now()
                let origin = read.origin ?? "nothing"
                note = read.ok
                    ? ScheduledNote(kind: .done, text: "\(origin) \(RemoteAccessWords.answersFromThisMac).")
                    : ScheduledNote(kind: .failed, text: read.problems.first?.remediation ?? "\(read.problems.count) \(read.problems.count == 1 ? "row" : "rows") not ok")
            } else if CLIDegradation.isUnknownVerb(result) {
                note = ScheduledNote(kind: .failed, text: CLIDegradation.message(verb: "remote test"))
            } else {
                note = ScheduledNote(kind: .failed, text: SettingsModel.cliWords(result, command: RemoteAccessWords.testCommand))
            }
        } catch {
            note = ScheduledNote(kind: .failed, text: error.localizedDescription)
        }
    }

    // MARK: Turn Off

    /// Turn Off pressed: the CLI's preview (`remote off --json`, no `--yes`)
    /// names what the provider's revoke would undo, what is left for the owner
    /// at the provider, and which phones stop signing in; the confirm lists
    /// exactly that. Sends nothing that changes anything.
    public func proposeTurnOff() async {
        guard let status, !status.isNone, let runner = management(), let preview = ManagementCommand(.remoteAccess, ["remote", "off", "--json"]) else { return }
        busy = true
        defer { busy = false }
        let name = RemoteAccessWords.providerName(status.provider)
        var costs: [String] = []
        if let result = try? await runner.run(preview, onOutput: { _ in }), let read = RemoteSetResult.parse(result.stdout) {
            costs += read.revoked?.undone ?? []
            costs += (read.revoked?.leftForOwner ?? []).map { RemoteAccessWords.leftForOwner(name, $0) }
            if let stranding = read.stranding { costs.append(stranding) }
            if costs.isEmpty { costs += read.detection.wouldChange }
        }
        if costs.isEmpty {
            // an older CLI, or a provider whose preview said nothing: the cost is still named
            costs = [RemoteAccessWords.turnOffFallbackCost]
            if status.origin != nil { costs.append(RemoteAccessWords.strandedFallback) }
        }
        confirmation = CostConfirmation(
            title: RemoteAccessWords.turnOffTitle,
            costHeading: RemoteAccessWords.turnOffHeading(name),
            costs: costs,
            confirm: RemoteAccessWords.turnOff
        )
    }

    /// Only `.confirm` runs `remote off --yes --json`. Cancel runs nothing.
    public func choose(_ choice: CostConfirmView.Choice) async {
        confirmation = nil
        guard choice == .confirm, let runner = management(), let command = ManagementCommand(.remoteAccess, ["remote", "off", "--yes", "--json"]) else { return }
        busy = true
        lastCommand = "metistry remote off --yes --json"
        do {
            let result = try await runner.run(command) { _ in }
            if result.ok, let read = RemoteSetResult.parse(result.stdout) {
                let undone = read.revoked?.undone ?? []
                note = ScheduledNote(kind: .done, text: undone.isEmpty ? "Remote access is off. \(read.detail)" : "Remote access is off — \(undone.joined(separator: "; ")).")
            } else {
                note = ScheduledNote(kind: .failed, text: SettingsModel.cliWords(result, command: "metistry remote off"))
            }
        } catch {
            note = ScheduledNote(kind: .failed, text: error.localizedDescription)
        }
        busy = false
        await refresh()
    }

    // MARK: Change…

    /// The guided flow, over this pane's status: the current choice preselected.
    public func beginChange() {
        guard flow == nil else { return }
        let model = makeFlow(status)
        model.onAddPhone = { [weak self] in
            guard let self else { return }
            self.closeChange()
            self.onAddPhone()
        }
        model.onApplied = { [weak self] in Task { await self?.refresh() } }
        flow = model
        Task { await model.load() }
    }

    /// Done, Esc, or the sheet dismissed: a running verb is cancelled, then the pane re-reads.
    public func closeChange() {
        guard let model = flow else { return }
        flow = nil
        model.cancel()
        Task { await refresh() }
    }
}

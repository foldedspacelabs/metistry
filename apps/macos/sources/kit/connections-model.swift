// Settings ▸ Connections: the list and one connection (T6-13a,
// screen-09-resources.md §10.1–§10.4, plan §2.6). The view is
// connections-view.swift.
//
// READ-ONLY OVER THE API. Everything on the pane is what three served routes
// say — `GET /api/connections`, `GET /api/connections/:name` and
// `GET /api/secrets` — and nothing else: no connection file is opened, no
// server is dialled, and a field the routes do not serve is not drawn (the
// last check, the agents a connection is lent to). Names, never values: the
// routes carry header, query-parameter, environment and secret NAMES and no
// value, so there is nothing here that could hold one.
//
// EVERY CHANGE IS A §2.2 VERB, CONFIRMED. A tool's mode and the offer switch
// are `metistry connections policy` (M13); Test is `metistry connections
// test` (M13, it dials); *Allow <host>* and *Grant* on a secret are `metistry
// secrets hosts|grant` (M7). Each is a `ManagementCommand` shown with its
// exact command in `SettingsConfirmation` before it runs, and the pane re-reads
// after it. No console route writes a connection (invariant 10).
//
// WHAT IT SENDS is worked out here from the served rows, the way core's egress
// door works it out (`packages/core/src/egress.ts`: `egressDestination`,
// `planEgress`): a secret leaves only for the exact destination — the host, and
// the port when it is not 443 — on its *Sent only to* list, only when granted
// to `connection:<name>`. A secret headed anywhere else is BLOCKED in the
// preview, never shown as sent: the preview says what the door would do, and
// when it cannot tell (the secret list did not read, a host is a variable) it
// says so and shows nothing as sent.

import Foundation
import Observation

// MARK: - The rows

/// What a connection is (plan §2.6's closed list).
public enum ConnectionKind: String, CaseIterable, Sendable {
    case mcp, agent, api, feed, files, calendar, mail, tracker

    /// The Type column's first word (screen 9 §10.1).
    public var title: String {
        switch self {
        case .mcp: return "MCP"
        case .agent: return "Agent"
        case .api: return "API"
        case .feed: return "Feed"
        case .files: return "Files"
        case .calendar: return "Calendar"
        case .mail: return "Mail"
        case .tracker: return "Tracker"
        }
    }

    /// The glyph beside the name. The Type column says the same in words, so
    /// the glyph is not spoken.
    public var symbolName: String {
        switch self {
        case .mcp: return "puzzlepiece.extension"
        case .agent: return "person.2"
        case .api: return "network"
        case .feed: return "dot.radiowaves.up.forward"
        case .files: return "folder"
        case .calendar: return "calendar"
        case .mail: return "envelope"
        case .tracker: return "checklist"
        }
    }
}

/// A tool's group — *by what it does* (screen 9 §10.3).
public enum ConnectionToolGroup: String, CaseIterable, Sendable {
    case reads
    case changes
    case startsAgent = "starts_agent"

    /// The CLI's words (`TOOL_GROUP_LABEL`, packages/cli/src/connections.ts).
    public var title: String {
        switch self {
        case .reads: return "Reads"
        case .changes: return "Changes things"
        case .startsAgent: return "Starts an agent"
        }
    }
}

/// The owner's per-tool policy. The file keeps `on | ask | off`; every surface
/// says *Allow · Ask First · Never* (the owner's W1 ruling over C93's
/// *On · Ask · Off*), in `PermissionWords`' words.
public enum ConnectionToolMode: String, CaseIterable, Sendable {
    case on, ask, off

    public var title: String {
        switch self {
        case .on: return PermissionWords.allow
        case .ask: return PermissionWords.ask
        case .off: return PermissionWords.never
        }
    }

    /// `metistry connections policy <name> <tool> allow|ask|never`.
    public var verbWord: String {
        switch self {
        case .on: return "allow"
        case .ask: return "ask"
        case .off: return "never"
        }
    }
}

public struct ConnectionTool: Identifiable, Equatable, Sendable {
    public let name: String
    /// Nil for a group this build does not know — drawn under *Other*, never guessed.
    public let group: ConnectionToolGroup?
    public let mode: ConnectionToolMode?
    public var id: String { name }
}

/// How Metistry reaches it — names only for headers, query parameters and
/// environment variables (`ReachSummary`, packages/connections/src/describe.ts).
public enum ConnectionReach: Equatable, Sendable {
    case http(url: String, auth: String?, headers: [String], query: [String], timeoutSeconds: Int?)
    case command(command: String, args: [String], cwd: String?, env: [String], runsOn: String?)
    case path(path: String, include: [String], skip: [String], watch: Bool)

    /// The Type column's second half when the provider is `custom`.
    var how: String {
        switch self {
        case .http: return "By URL"
        case .command: return "By command"
        case .path: return "A path"
        }
    }
}

/// Who reads it today. The route serves syncs (`ConnectionUser`); agents are
/// lent one through the lazy pair and are not in `used_by` yet.
public struct ConnectionUser: Equatable, Sendable, Identifiable {
    public let kind: String
    public let name: String
    public var id: String { "\(kind):\(name)" }
    public var said: String { "\(kind) \(name)" }
}

/// What a connection's provider — its connection-type unit — declares.
public struct ConnectionProviderUnit: Equatable, Sendable {
    public let name: String
    public let origin: String?
    public let capabilities: [String]
    public let sync: String?
    public let tools: [String]
}

/// One row of `GET /api/connections`, or the body of `GET /api/connections/:name`.
public struct ConnectionRow: Identifiable, Equatable, Sendable {
    public let name: String
    /// Nil when the file does not validate (the route serves `type: null`).
    public let kind: ConnectionKind?
    public let provider: String?
    public let description: String?
    public let status: CheckStatus
    /// Why it is not `ok` — names, never values.
    public let issues: [String]
    public let reach: ConnectionReach?
    public let secrets: [String]
    public let variables: [String]
    public let tools: [ConnectionTool]
    public let offerToAgents: Bool
    public let usedBy: [ConnectionUser]
    /// The detail route only.
    public let file: String?
    public let providerUnit: ConnectionProviderUnit?

    public var id: String { name }

    /// *MCP · By command*, *Calendar · icloud-calendar* (screen 9 §10.1).
    public var typeLabel: String {
        let kindWord = kind?.title ?? "Unknown type"
        if let provider, provider != "custom" { return "\(kindWord) · \(provider)" }
        if let reach { return "\(kindWord) · \(reach.how)" }
        return kindWord
    }

    /// The tools under one group, in the route's order (by name).
    public func tools(in group: ConnectionToolGroup?) -> [ConnectionTool] {
        tools.filter { $0.group == group }
    }

    /// Tools its provider declares that the file does not list: refused
    /// before anything is dialled until the owner lists one.
    public var declaredNotListed: [String] {
        let listed = Set(tools.map(\.name))
        return (providerUnit?.tools ?? []).filter { !listed.contains($0) }
    }

    static func parse(_ json: JSONValue) -> ConnectionRow? {
        guard let name = json.string("name") else { return nil }
        let tools = (json["tools"]?.arrayValue ?? []).compactMap { tool -> ConnectionTool? in
            guard let toolName = tool.string("name") else { return nil }
            return ConnectionTool(
                name: toolName,
                group: tool.string("group").flatMap(ConnectionToolGroup.init(rawValue:)),
                mode: tool.string("mode").flatMap(ConnectionToolMode.init(rawValue:))
            )
        }
        let unit = json["provider_unit"].flatMap { unit -> ConnectionProviderUnit? in
            guard let unitName = unit.string("name") else { return nil }
            return ConnectionProviderUnit(
                name: unitName,
                origin: unit.string("origin"),
                capabilities: strings(unit["capabilities"]),
                sync: unit.string("sync"),
                tools: (unit["tools"]?.arrayValue ?? []).compactMap { $0.string("name") }
            )
        }
        return ConnectionRow(
            name: name,
            kind: json.string("type").flatMap(ConnectionKind.init(rawValue:)),
            provider: json.string("provider"),
            description: json.string("description"),
            // doctor's words; anything else is not a state this build can draw, so it reads failed
            status: json.string("status").flatMap(CheckStatus.init(rawValue:)) ?? .failed,
            issues: strings(json["issues"]),
            reach: json["reach"].flatMap(reach),
            secrets: strings(json["secrets"]),
            variables: strings(json["variables"]),
            tools: tools,
            offerToAgents: json.bool("offer_to_agents") ?? false,
            usedBy: (json["used_by"]?.arrayValue ?? []).compactMap { user in
                guard let kind = user.string("kind"), let name = user.string("name") else { return nil }
                return ConnectionUser(kind: kind, name: name)
            },
            file: json.string("file"),
            providerUnit: unit
        )
    }

    private static func reach(_ json: JSONValue) -> ConnectionReach? {
        switch json.string("class") {
        case "http":
            guard let url = json.string("url") else { return nil }
            return .http(url: url, auth: json.string("auth"), headers: strings(json["headers"]), query: strings(json["query"]), timeoutSeconds: json.int("timeout_s"))
        case "command":
            guard let command = json.string("command") else { return nil }
            return .command(command: command, args: strings(json["args"]), cwd: json.string("cwd"), env: strings(json["env"]), runsOn: json.string("runs_on"))
        case "path":
            guard let path = json.string("path") else { return nil }
            return .path(path: path, include: strings(json["include"]), skip: strings(json["skip"]), watch: json.bool("watch") ?? false)
        default:
            return nil
        }
    }
}

/// One row of `GET /api/secrets` — names, hosts, grants; never a value.
public struct SecretPolicy: Identifiable, Equatable, Sendable {
    public let name: String
    /// *Sent only to* — host, or host:port when not 443.
    public let hosts: [String]
    /// `connection:<name>` / `agent:<id>` → `on | ask | off`. Not listed is Off.
    public let grants: [String: String]
    public let expires: Date?
    /// Whether this instance's Keychain holds an item. Nil: the console could not ask.
    public let present: Bool?

    public var id: String { name }

    public func isExpired(now: Date) -> Bool { expires.map { $0 <= now } ?? false }

    static func list(_ json: JSONValue) -> [SecretPolicy] {
        (json["secrets"]?.arrayValue ?? []).compactMap { row in
            guard let name = row.string("name") else { return nil }
            var grants: [String: String] = [:]
            for grant in row["grants"]?.arrayValue ?? [] {
                if let to = grant.string("to"), let mode = grant.string("mode") { grants[to] = mode }
            }
            return SecretPolicy(
                name: name,
                hosts: strings(row["hosts"]),
                grants: grants,
                expires: WireTime.date(row.string("expires")) ?? day(row.string("expires")),
                present: row.bool("present")
            )
        }
    }

    /// `expires` may be a date without a time (`2026-12-31`).
    private static func day(_ text: String?) -> Date? {
        guard let text else { return nil }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        return f.date(from: text)
    }
}

private func strings(_ json: JSONValue?) -> [String] {
    json?.arrayValue?.compactMap(\.stringValue) ?? []
}

// MARK: - What it sends

/// Where a request goes, as the egress door names it (`egressDestination`):
/// the host lowercased, and `host:port` unless the port is 443.
public struct EgressDestination: Equatable, Sendable {
    public let entry: String
    public let cleartext: Bool

    public init?(url: String) {
        guard let parts = URLComponents(string: url),
              let scheme = parts.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = parts.host?.lowercased(), !host.isEmpty
        else { return nil }
        let port = parts.port ?? (scheme == "http" ? 80 : 443)
        entry = port == 443 ? host : "\(host):\(port)"
        let loopback = host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]" || host.hasSuffix(".localhost")
        cleartext = scheme == "http" && !loopback
    }
}

/// One secret the connection names, and what the door would do with it.
public struct SecretSend: Identifiable, Equatable, Sendable {
    public enum Verdict: Equatable, Sendable {
        /// Filled for this destination — the host is on its list and it is granted.
        case sent(to: String)
        /// The same, and every call waits for the owner's approval first (Ask First).
        case sentAfterApproval(to: String)
        /// A command's environment: given to that command only.
        case givenToCommand
        /// The destination is not on the secret's *Sent only to* list.
        case hostNotListed(destination: String, listed: [String])
        /// Plain http to anything but this Mac.
        case cleartext(destination: String)
        /// Not granted to `connection:<name>` (Off, or not listed), or — for a
        /// command's environment, which is filled once at spawn — not On.
        case notGranted(mode: String?)
        /// `secrets.yaml` does not describe it: it lists no host at all.
        case notDescribed
        /// This instance's Keychain holds no item for it.
        case noItem
        /// The preview cannot tell — and so shows nothing as sent.
        case cannotTell(String)
    }

    public let secret: String
    public let verdict: Verdict
    public var id: String { secret }

    /// Whether the preview shows it blocked. Only a verdict that sends is not.
    public var blocks: Bool {
        switch verdict {
        case .sent, .sentAfterApproval, .givenToCommand: return false
        default: return true
        }
    }

    /// The secret masked, as screen 9 §10.5 writes it — the name, never a value.
    public var masked: String { "•••••• (\(secret))" }

    /// One sentence, the door's own reasons in the owner's words.
    public var said: String {
        switch verdict {
        case .sent(let to): return "Sent to \(to)"
        case .sentAfterApproval(let to): return "Sent to \(to) after you approve each call (Ask First)"
        case .givenToCommand: return "Given to this command only; never written to disk"
        case .hostNotListed(let destination, let listed):
            let list = listed.isEmpty ? "no host" : listed.joined(separator: ", ")
            return "Blocked — \(destination) is not on its Sent only to list (\(list))"
        case .cleartext(let destination): return "Blocked — \(destination) is plain http; a secret leaves this Mac over https only"
        case .notGranted(let mode):
            return mode == "ask"
                ? "Blocked — a command's environment is filled once, at start, so it needs Allow, not Ask First"
                : "Blocked — not granted to this connection"
        case .notDescribed: return "Blocked — not in secrets.yaml, so it may be sent nowhere"
        case .noItem: return "Blocked — this instance's Keychain holds no item for it"
        case .cannotTell(let why): return "Not shown as sent — \(why)"
        }
    }

    /// The host *Allow <host>* would add, when that is the one thing in the way.
    public var hostToAllow: String? {
        if case .hostNotListed(let destination, _) = verdict { return destination }
        return nil
    }
}

/// *What it sends* (screen 9 §10.3, §10.5): where the connection's requests
/// go, and each secret it names — masked — with the door's verdict.
public struct WhatItSends: Equatable, Sendable {
    /// The URL, the command line or the path, verbatim.
    public let target: String
    /// Header and query-parameter names (HTTP), environment names (command).
    public let names: [String]
    public let sends: [SecretSend]

    /// A single blocked secret blocks the preview.
    public var blocked: Bool { sends.contains { $0.blocks } }

    /// Worked out from the served rows. `secrets` nil: the list did not read.
    public static func of(_ row: ConnectionRow, secrets: [SecretPolicy]?) -> WhatItSends? {
        guard let reach = row.reach else { return nil }
        let grantee = "connection:\(row.name)"
        let byName = Dictionary((secrets ?? []).map { ($0.name, $0) }, uniquingKeysWith: { a, _ in a })
        func verdict(_ name: String, sentTo destination: EgressDestination?) -> SecretSend.Verdict {
            guard secrets != nil else { return .cannotTell("the secret list could not be read") }
            guard let policy = byName[name] else { return .notDescribed }
            let mode = policy.grants[grantee]
            if let destination {
                // the door's order: the host, then cleartext, then the grant
                guard policy.hosts.contains(destination.entry) else { return .hostNotListed(destination: destination.entry, listed: policy.hosts) }
                if destination.cleartext { return .cleartext(destination: destination.entry) }
                guard mode == "on" || mode == "ask" else { return .notGranted(mode: mode) }
                if policy.present == false { return .noItem }
                return mode == "ask" ? .sentAfterApproval(to: destination.entry) : .sent(to: destination.entry)
            }
            guard mode == "on" else { return .notGranted(mode: mode) }
            if policy.present == false { return .noItem }
            return .givenToCommand
        }
        switch reach {
        case .http(let url, _, let headers, let query, _):
            let destination = EgressDestination(url: url)
            let sends = row.secrets.map { name in
                SecretSend(secret: name, verdict: destination == nil
                    ? .cannotTell("the URL's host is not known until it is filled (\(url))")
                    : verdict(name, sentTo: destination))
            }
            return WhatItSends(target: url, names: headers + query.map { "?\($0)" }, sends: sends)
        case .command(let command, let args, _, let env, _):
            return WhatItSends(target: ([command] + args).joined(separator: " "), names: env, sends: row.secrets.map { SecretSend(secret: $0, verdict: verdict($0, sentTo: nil)) })
        case .path(let path, _, _, _):
            return WhatItSends(target: path, names: [], sends: row.secrets.map { SecretSend(secret: $0, verdict: .cannotTell("a path has nowhere to send a secret")) })
        }
    }
}

// MARK: - The model

@MainActor
@Observable
public final class ConnectionsModel {
    public private(set) var rows: [ConnectionRow] = []
    public private(set) var phase: ReadPhase = .idle
    /// The route answered 503: this deployment has no instance directory.
    public private(set) var noInstance = false
    public private(set) var asOf: Date?
    /// `GET /api/secrets` — for *Sent only to*, the grants and the preview.
    /// Nil: not read, or it did not read — the preview then shows nothing as sent.
    public private(set) var secrets: [SecretPolicy]?
    public private(set) var secretsProblem: String?

    /// The connection open in the pane. Nil: the list.
    public private(set) var selected: String?
    /// `GET /api/connections/:name` — the row, its file and its provider's unit.
    public private(set) var detail: ConnectionRow?
    public private(set) var detailPhase: ReadPhase = .idle

    @ObservationIgnored private let session: ConsoleSession?

    public init(session: ConsoleSession?) {
        self.session = session
        // A check or a call that fails or recovers, and a write to a file the
        // pane reads, make it due — re-read while the pane has been opened.
        session?.events.watch([.connections, .configuration]) { [weak self] event in
            guard let self else { return false }
            if self.phase != .idle, Self.isDue(event.change) { Task { await self.refresh() } }
            return true
        }
    }

    static func isDue(_ change: ConsoleEvent.Change) -> Bool {
        switch change {
        case .connectionHealth, .resync, .unreadable: return true
        case .configChanged(let file):
            return file.contains(".metistry/connections/") || file.hasSuffix("secrets.yaml") || file.hasSuffix("scheduled.yaml")
        default: return false
        }
    }

    /// Another instance: drop everything read from the last one.
    public func adopt() {
        rows = []
        phase = .idle
        noInstance = false
        asOf = nil
        secrets = nil
        secretsProblem = nil
        selected = nil
        detail = nil
        detailPhase = .idle
    }

    /// The list and the secret list, and the open connection when there is one.
    public func refresh() async {
        guard let session else {
            phase = .unavailable("no console session for this instance")
            return
        }
        let generation = session.generation
        if rows.isEmpty { phase = .reading }
        async let list = session.stores.connections()
        async let named = session.stores.secrets()
        let (listed, secretList) = await (list, named)
        guard session.generation == generation else { return }
        switch listed {
        case .success(let body):
            rows = (body.json["connections"]?.arrayValue ?? []).compactMap(ConnectionRow.parse)
            asOf = WireTime.date(body.json.string("as_of"))
            noInstance = false
            phase = .read
        case .failure(let error):
            if case .http(status: 503, envelope: _) = error { noInstance = true; rows = [] }
            phase = .unavailable(error.localizedDescription)
        }
        switch secretList {
        case .success(let body):
            secrets = SecretPolicy.list(body.json)
            secretsProblem = nil
        case .failure(let error):
            secrets = nil
            secretsProblem = error.localizedDescription
        }
        if let selected { await readDetail(selected) }
    }

    /// Open one connection.
    public func open(_ name: String) async {
        selected = name
        detail = nil
        await readDetail(name)
    }

    /// Back to the list.
    public func close() {
        selected = nil
        detail = nil
        detailPhase = .idle
    }

    private func readDetail(_ name: String) async {
        guard let session else { return }
        let generation = session.generation
        detailPhase = .reading
        let answer = await session.stores.connection(name)
        guard session.generation == generation, selected == name else { return }
        switch answer {
        case .success(let body):
            detail = body.json["connection"].flatMap(ConnectionRow.parse)
            detailPhase = detail == nil ? .unavailable("the console's answer carried no connection") : .read
        case .failure(let error):
            if case .http(status: 404, envelope: _) = error {
                // removed since the list was read: back to the list, which is re-read
                close()
                return
            }
            detailPhase = .unavailable(error.localizedDescription)
        }
    }

    /// What the open connection shows: the detail route's row, or — until it
    /// answers, or when it cannot — the list's.
    public var shown: ConnectionRow? {
        guard let selected else { return nil }
        return detail ?? rows.first { $0.name == selected }
    }

    public func policy(for secret: String) -> SecretPolicy? {
        secrets?.first { $0.name == secret }
    }

    /// *Key expired* — a secret the connection names that the service says has
    /// stopped working (screen 9 §10.1).
    public func expiredKeys(_ row: ConnectionRow, now: Date = Date()) -> [String] {
        row.secrets.filter { policy(for: $0)?.isExpired(now: now) == true }
    }

    /// A key that is expired or has no item: *Replace Key* (components-03 §2).
    public func keyNeedsReplacing(_ row: ConnectionRow, now: Date = Date()) -> Bool {
        row.secrets.contains { name in
            guard let p = policy(for: name) else { return false }
            return p.isExpired(now: now) || p.present == false
        }
    }

    public func whatItSends(_ row: ConnectionRow) -> WhatItSends? {
        WhatItSends.of(row, secrets: secrets)
    }

    // MARK: The §2.2 verbs, each confirmed

    /// `metistry connections policy <name> <tool> allow|ask|never`.
    public func setMode(_ tool: ConnectionTool, of row: ConnectionRow, to mode: ConnectionToolMode) -> SettingsConfirmation? {
        guard tool.mode != mode,
              let command = ManagementCommand(.connections, ["connections", "policy", row.name, tool.name, mode.verbWord])
        else { return nil }
        let cost: String
        switch mode {
        case .on: cost = "\(tool.name) runs when a caller that reaches \(row.name) calls it — no preview for a Read, preview-then-confirm for anything else."
        case .ask: cost = "Each call to \(tool.name) waits for you in Needs You; from an unattended run it is deferred and reported."
        case .off: cost = "\(tool.name) is refused at the proxy and not offered to anyone."
        }
        return SettingsConfirmation(
            title: "\(tool.name): \(mode.title)?",
            cost: cost + " Written to .metistry/connections/\(row.name).yaml, a protected file, as you.",
            actionTitle: mode.title,
            command: command,
            after: .connections
        )
    }

    /// `metistry connections policy <name> --offer on|off` (C115).
    public func setOffer(_ on: Bool, of row: ConnectionRow, assistantName: String) -> SettingsConfirmation? {
        guard row.offerToAgents != on,
              let command = ManagementCommand(.connections, ["connections", "policy", row.name, "--offer", on ? "on" : "off"])
        else { return nil }
        return SettingsConfirmation(
            title: on ? "Offer \(row.name) to agents?" : "Stop offering \(row.name) to agents?",
            cost: on
                ? "Agents you grant it to can call its tools through Metistry's proxy, at the modes set here. They never hold its key."
                : "Only \(assistantName) and syncs reach it. Agents it was lent to are refused at once.",
            actionTitle: on ? "Offer" : "Stop Offering",
            command: command,
            destructive: !on,
            after: .connections
        )
    }

    /// `metistry connections test <name>`: dial it once and compare what it
    /// offers with what the file lists. Its answer is the CLI's own words.
    public func test(_ row: ConnectionRow) -> SettingsConfirmation? {
        guard let command = ManagementCommand(.connections, ["connections", "test", row.name]) else { return nil }
        let reaches: String
        switch row.reach {
        case .command(let cmd, _, _, _, _): reaches = "starts \(cmd) on this Mac"
        case .http(let url, _, _, _, _): reaches = "connects to \(EgressDestination(url: url)?.entry ?? url)"
        default: reaches = "reaches it"
        }
        return SettingsConfirmation(
            title: "Test \(row.name)?",
            cost: "This \(reaches), asks what it offers and calls no tool.",
            actionTitle: "Test",
            command: command,
            after: .connections
        )
    }

    /// *Allow <host>*: `metistry secrets hosts <secret> <hosts…> <host>` —
    /// the verb replaces the list, so it names every host already on it.
    public func allowHost(_ host: String, for secret: String) -> SettingsConfirmation? {
        guard let policy = policy(for: secret), !policy.hosts.contains(host),
              let command = ManagementCommand(.secrets, ["secrets", "hosts", secret] + policy.hosts + [host])
        else { return nil }
        return SettingsConfirmation(
            title: "Allow \(secret) to be sent to \(host)?",
            cost: "\(host) joins \(secret)'s Sent only to list, for every connection and agent granted it. Written to secrets.yaml as you; the value is not read.",
            actionTitle: "Allow \(host)",
            command: command,
            after: .connections
        )
    }

    /// *Grant*: `metistry secrets grant <secret> connection:<name> on`.
    public func grant(_ secret: String, to row: ConnectionRow) -> SettingsConfirmation? {
        guard policy(for: secret) != nil,
              let command = ManagementCommand(.secrets, ["secrets", "grant", secret, "connection:\(row.name)", "on"])
        else { return nil }
        return SettingsConfirmation(
            title: "Let \(row.name) use \(secret)?",
            cost: "\(secret) is filled in for \(row.name) — only for a host on its Sent only to list. Written to secrets.yaml as you; the value is not read.",
            actionTitle: "Grant",
            command: command,
            after: .connections
        )
    }
}

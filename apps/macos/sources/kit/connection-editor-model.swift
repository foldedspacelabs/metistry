// Add Connection, and Configure one (T6-13b, screen-09-resources.md §10.5
// C118, plan §2.6–§2.7). The view is connection-editor-view.swift; the pane's
// rows and the installed connection types are connections-model.swift.
//
// TYPE FIRST, THEN A KNOWN SERVICE OR CUSTOM. A known service is one of the
// connection types the console lists (`GET /api/connections` → `types`: the
// product's seed and the owner's extensions through one registry, §2.7), and
// its form is RENDERED FROM ITS FIELDS — a field of each closed kind (text ·
// secret · variable · url · choice · oauth) has one drawing here, and no
// service has Swift of its own. Custom is configured by how it is reached:
// HTTP, a command, a path (C118's table), and — for a mailbox — IMAP.
//
// THE DRAFT HOLDS NO VALUE A SECRET COULD BE. A `secret` field, a bearer, an
// API key, an app password: each is the NAME of a secret, picked from the
// list `GET /api/secrets` serves or stored first through the Secrets sheet
// (the one place a value is typed, on the CLI's stdin). The only free text
// here is a URL, a command line, a path, a header or environment VALUE — and
// a value that looks like a key is refused by the CLI before anything is
// written (`looksLikeKey`), never by a sentence in this file.
//
// EVERYTHING IT DOES IS ONE §2.2 VERB. The draft becomes exactly one argument
// array — `metistry connections add … [--config KEY=VALUE]…` or `connections
// set …` (M13) — shown in the editor before its button runs it, and a secret
// field rides as `--config KEY=<name>`: a name, which the CLI turns into the
// `{{ secret.name }}` reference and refuses anything else. Signing an OAuth
// connection in is `connections authorize`, a second confirmed verb.

import Foundation

// MARK: - The installed connection types, as the list serves them

/// What a connection-type's config fields may be (core's `FIELD_KINDS`, closed). A kind this build does not know is not drawn.
public enum ConnectionFieldKind: String, CaseIterable, Sendable {
    case text, secret, variable, url, choice, oauth
}

/// One config field of a connection type, as `GET /api/connections` serves it under `types[].fields` — a KIND and a shape, never a value.
public struct ConnectionTypeField: Identifiable, Equatable, Sendable {
    public let key: String
    public let kind: ConnectionFieldKind
    public let label: String
    public let help: String?
    public let required: Bool
    /// `text`, `url` and `choice` may carry one; a `secret` never does.
    public let defaultValue: String?
    /// `choice` only.
    public let choices: [ConnectionFieldChoice]

    public var id: String { key }

    /// A field the owner must fill: required, and nothing to fall back on.
    public var mustBeGiven: Bool { required && defaultValue == nil && kind != .oauth }

    static func parse(_ json: JSONValue) -> ConnectionTypeField? {
        guard let key = json.string("key"), let kind = json.string("kind").flatMap(ConnectionFieldKind.init(rawValue:)), let label = json.string("label") else { return nil }
        return ConnectionTypeField(
            key: key,
            kind: kind,
            label: label,
            help: json.string("help"),
            required: json.bool("required") ?? true,
            defaultValue: json.string("default"),
            choices: (json["choices"]?.arrayValue ?? []).compactMap { c in
                guard let value = c.string("value") else { return nil }
                return ConnectionFieldChoice(value: value, label: c.string("label") ?? value)
            }
        )
    }
}

public struct ConnectionFieldChoice: Identifiable, Equatable, Sendable {
    public let value: String
    public let label: String
    public var id: String { value }
}

/// One installed connection type — a known service (screen 9 §10.5) — as
/// `GET /api/connections` serves it under `types`: the product's seed and the
/// owner's extensions through one registry (§2.7), so a type an extension
/// adds renders its form here with no per-service Swift.
public struct ConnectionTypeSummary: Identifiable, Equatable, Sendable {
    public let name: String
    public let title: String
    public let description: String?
    /// `product` or `extension`.
    public let origin: String?
    /// Nil for a type this build does not know.
    public let provides: ConnectionKind?
    /// The reach classes a connection of it may use: `http` · `command` · `path` · `imap`.
    public let transports: [String]
    /// The sign-in schemes it declares; nil when it declares none (any but `basic`).
    public let auth: [String]?
    public let capabilities: [String]
    public let fields: [ConnectionTypeField]
    public let tools: [String]

    public var id: String { name }
    public var isExtension: Bool { origin == "extension" }

    /// *Known service* or *Extension* — the tag on its tile (§10.5).
    public var originTag: String { isExtension ? "Extension" : "Known service" }

    static func parse(_ json: JSONValue) -> ConnectionTypeSummary? {
        guard let name = json.string("name") else { return nil }
        return ConnectionTypeSummary(
            name: name,
            title: json.string("title") ?? name,
            description: json.string("description"),
            origin: json.string("origin"),
            provides: json.string("provides").flatMap(ConnectionKind.init(rawValue:)),
            transports: strings(json["transports"]),
            auth: json["auth"]?.arrayValue == nil ? nil : strings(json["auth"]),
            capabilities: strings(json["capabilities"]),
            fields: (json["fields"]?.arrayValue ?? []).compactMap(ConnectionTypeField.parse),
            tools: (json["tools"]?.arrayValue ?? []).compactMap { $0.string("name") }
        )
    }
}

/// A name=value row: a header, a query parameter, an environment variable. The
/// value may reference a secret or a variable (`{{ secret.x }}`); the CLI lists
/// every name a value uses for the grant check.
public struct ConnectionNameValue: Identifiable, Equatable, Sendable {
    public var id = UUID()
    public var name: String
    public var value: String

    public init(name: String = "", value: String = "") {
        self.name = name
        self.value = value
    }

    var isBlank: Bool { name.trimmingCharacters(in: .whitespaces).isEmpty }
    var pair: String { "\(name.trimmingCharacters(in: .whitespaces))=\(value)" }
}

/// How a connection is reached (core's `REACH_CLASSES`, C118).
public enum ConnectionReachClass: String, CaseIterable, Sendable {
    case http, command, path, imap

    /// The tile's words (§10.5's *Reached by* column).
    public var title: String {
        switch self {
        case .http: return "HTTP"
        case .command: return "Command"
        case .path: return "Path"
        case .imap: return "Mailbox (IMAP)"
        }
    }

    /// *Used for* (§10.5).
    public var usedFor: String {
        switch self {
        case .http: return "MCP · A2A · API · Feed · a web page"
        case .command: return "MCP · ACP"
        case .path: return "Files"
        case .imap: return "Mail"
        }
    }
}

/// The authentication shortcut (core's `AUTH_SCHEMES`, §10.5).
public enum ConnectionAuth: String, CaseIterable, Sendable {
    case none, bearer, basic, apiKey = "api_key", oauth

    public var title: String {
        switch self {
        case .none: return "None"
        case .bearer: return "Bearer"
        case .basic: return "Basic"
        case .apiKey: return "API Key"
        case .oauth: return "OAuth"
        }
    }

    /// Whether the shortcut names a secret — the token, the key, the app password.
    var takesSecret: Bool { self == .bearer || self == .basic || self == .apiKey }
}

extension ConnectionKind {
    /// The reach a custom connection of this type may use — core's
    /// `NATIVE_REACH`. Empty: a custom one has nothing to run it (calendar,
    /// mail, tracker need a connection type), and the editor says so.
    public var customReaches: [ConnectionReachClass] {
        switch self {
        case .mcp, .agent: return [.http, .command]
        case .api, .feed: return [.http]
        case .files: return [.path, .http]
        case .calendar, .mail, .tracker: return []
        }
    }

    /// What the type is, in a line (screen 9 §10.2).
    public var explained: String {
        switch self {
        case .mcp: return "A server that offers tools"
        case .agent: return "Somewhere Metistry sends work — A2A, ACP, a crew on this Mac"
        case .api: return "An HTTP service with a key"
        case .feed: return "RSS, Atom or a calendar feed"
        case .files: return "A folder, a file or a web page"
        case .calendar: return "Events and invitations, on Today"
        case .mail: return "Messages — who wrote and about what; nothing sends"
        case .tracker: return "Issues and tasks another system tracks"
        }
    }
}

/// The editor's state: one connection, being added or configured.
public struct ConnectionDraft: Equatable, Sendable {
    public enum Mode: Equatable, Sendable {
        case add
        /// `connections set <name>` over this row: only what changes is sent.
        case configure(ConnectionRow)
    }

    public var mode: Mode
    public var name: String
    /// Step one: the type (screen 9 §10.5).
    public var kind: ConnectionKind?
    /// Step two: a known service (a connection type's name) or `custom`. Nil: not chosen yet.
    public var provider: String?
    /// The known service, when one is chosen and installed.
    public var type: ConnectionTypeSummary?
    public var reach: ConnectionReachClass

    // HTTP
    public var url = ""
    public var auth: ConnectionAuth = .none
    /// The NAME of the secret the shortcut sends — never its value.
    public var secretName = ""
    /// `api_key`: the header the service spells the key into.
    public var authHeader = ""
    /// `basic`: the username is written; the app password is `secretName`.
    public var username = ""
    public var headers: [ConnectionNameValue] = []
    // a custom OAuth client (C118): the owner's own
    public var authorizeURL = ""
    public var tokenURL = ""
    /// Space-separated.
    public var scopes = ""
    public var clientIdSecret = ""
    public var clientSecretSecret = ""

    // Command
    /// The command and its arguments, one line, split on whitespace.
    public var commandLine = ""
    public var env: [ConnectionNameValue] = []
    public var runsInContainer = false

    // Path
    public var path = ""
    /// Comma- or space-separated patterns.
    public var include = ""
    public var skip = ""

    // IMAP
    public var imapHost = ""
    public var imapPort = ""
    /// Without TLS — a server on this Mac only; the CLI refuses it anywhere else.
    public var imapPlain = false

    /// A known service's fields, by key. A `secret` or `variable` field holds a NAME.
    public var fields: [String: String] = [:]
    public var description = ""
    /// `add` dials once by default (`--no-discover` writes without reaching it).
    public var discover = true
    /// The CLI's refusal of the last try, in its own words.
    public var refusal: String?

    public init(mode: Mode = .add) {
        self.mode = mode
        name = ""
        reach = .http
    }

    /// The editor over an existing connection: what the row serves is the
    /// starting point — its reach's names, never a value (the routes carry
    /// none), so a header or environment row starts with its name and an
    /// empty value, and is sent only when a value is typed.
    public init(configuring row: ConnectionRow, type: ConnectionTypeSummary?) {
        mode = .configure(row)
        name = row.name
        kind = row.kind
        provider = row.provider
        self.type = type
        description = row.description ?? ""
        switch row.reach {
        case .http(let url, let auth, let headers, _, _):
            reach = .http
            self.url = url
            self.auth = auth.flatMap(ConnectionAuth.init(rawValue:)) ?? .none
            self.headers = headers.map { ConnectionNameValue(name: $0) }
        case .command(let command, let args, _, let env, let runsOn):
            reach = .command
            commandLine = ([command] + args).joined(separator: " ")
            self.env = env.map { ConnectionNameValue(name: $0) }
            runsInContainer = runsOn == "container"
        case .path(let path, let include, let skip, _):
            reach = .path
            self.path = path
            self.include = include.joined(separator: ", ")
            self.skip = skip.joined(separator: ", ")
        case .imap(let host, let port, let security):
            reach = .imap
            imapHost = host
            imapPort = port == 993 ? "" : String(port)
            imapPlain = security == "plain"
        case nil:
            reach = .http
        }
    }

    public var isAdd: Bool { mode == .add }

    public var configuring: ConnectionRow? {
        if case .configure(let row) = mode { return row }
        return nil
    }

    public var isCustom: Bool { provider == "custom" }
    public var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// `github`, `work-calendar`: the CLI's `NAME_RE`.
    public static func isName(_ text: String) -> Bool {
        text.range(of: #"^[a-z][a-z0-9-]{0,63}$"#, options: .regularExpression) != nil
    }

    /// A secret's or a variable's name (lowercase snake_case, §2.14).
    public static func isSnakeName(_ text: String) -> Bool {
        text.range(of: #"^[a-z][a-z0-9_]*$"#, options: .regularExpression) != nil
    }

    // MARK: What the chosen type and service allow

    /// The reach classes on offer: the known service's `transports`, or what a custom one of this type can run.
    public var reaches: [ConnectionReachClass] {
        if let type { return type.transports.compactMap(ConnectionReachClass.init(rawValue:)) }
        return kind?.customReaches ?? []
    }

    /// The sign-in shortcuts on offer: what the type declares, or any but Basic (an app password is a declared type's alone).
    public var auths: [ConnectionAuth] {
        if let declared = type?.auth { return declared.compactMap(ConnectionAuth.init(rawValue:)) }
        return ConnectionAuth.allCases.filter { $0 != .basic }
    }

    /// The known service's fields to draw; an `oauth` field is drawn as a note, and is signed in after adding.
    public var typeFields: [ConnectionTypeField] { type?.fields ?? [] }

    /// Choosing the type again: the service and everything under it start over.
    public mutating func choose(kind newKind: ConnectionKind) {
        kind = newKind
        provider = nil
        type = nil
        fields = [:]
        reach = newKind.customReaches.first ?? .http
        auth = .none
    }

    /// A known service, or `custom`.
    public mutating func choose(service: ConnectionTypeSummary?) {
        type = service
        provider = service?.name ?? "custom"
        fields = [:]
        let allowed = reaches
        if !allowed.contains(reach) { reach = allowed.first ?? .http }
        if !auths.contains(auth) { auth = auths.first ?? .none }
    }

    // MARK: What is still missing

    /// Why the button is off — in order, the first thing to fix. Empty: it can run.
    public var missing: [String] {
        var out: [String] = []
        if isAdd {
            if trimmedName.isEmpty { out.append("a name") }
            else if !Self.isName(trimmedName) { out.append("a name in lowercase kebab-case, like work-calendar") }
            guard let kind else { return out + ["the type"] }
            guard provider != nil else { return out + ["a known service, or custom"] }
            if isCustom, kind.customReaches.isEmpty { return out + ["a connection type — a custom \(kind.title.lowercased()) has nothing to run it"] }
        }
        // configuring: a served header or environment row starts with an empty value, which keeps what the file holds;
        // a sign-in that did not change needs no secret named again
        let served = Set(servedNames)
        let authChanged = isAdd || auth.rawValue != servedAuth || !secretName.isEmpty
        switch reach {
        case .http:
            if url.trimmingCharacters(in: .whitespaces).isEmpty { out.append("the URL") }
            else if !(url.hasPrefix("https://") || url.hasPrefix("http://") || url.hasPrefix("{{")) { out.append("a URL that starts with https:// (or a {{ variable }} holding one)") }
            if auth.takesSecret, authChanged, !Self.isSnakeName(secretName) { out.append("the secret the \(auth.title.lowercased()) is kept in") }
            if auth == .apiKey, authChanged, authHeader.trimmingCharacters(in: .whitespaces).isEmpty { out.append("the header the key is sent in") }
            if auth == .basic, authChanged, username.trimmingCharacters(in: .whitespaces).isEmpty { out.append("the username") }
            if auth == .oauth, isCustom, authChanged {
                if !authorizeURL.hasPrefix("https://") { out.append("the authorize URL (https)") }
                if !tokenURL.hasPrefix("https://") { out.append("the token URL (https)") }
                if scopeList.isEmpty { out.append("at least one scope") }
                if !Self.isSnakeName(clientIdSecret) { out.append("the secret your client id is kept in — a custom connection brings its own") }
            }
            if headers.contains(where: { !$0.isBlank && $0.value.isEmpty && !served.contains($0.name) }) { out.append("a value for every header, or remove the row") }
        case .command:
            if commandWords.isEmpty { out.append("the command") }
            if env.contains(where: { !$0.isBlank && $0.value.isEmpty && !served.contains($0.name) }) { out.append("a value for every environment variable, or remove the row") }
        case .path:
            if path.trimmingCharacters(in: .whitespaces).isEmpty { out.append("the folder or file") }
        case .imap:
            if imapHost.trimmingCharacters(in: .whitespaces).isEmpty { out.append("the mail server") }
            if !imapPort.isEmpty, Int(imapPort) == nil { out.append("a port number, or none for 993") }
            if username.trimmingCharacters(in: .whitespaces).isEmpty { out.append("the username") }
            if !Self.isSnakeName(secretName) { out.append("the secret the app password is kept in") }
        }
        if isAdd {
            for field in typeFields where field.mustBeGiven && (fields[field.key] ?? "").isEmpty {
                out.append(field.label)
            }
        }
        for field in typeFields where field.kind == .secret || field.kind == .variable {
            if let given = fields[field.key], !given.isEmpty, !Self.isSnakeName(given) { out.append("\(field.label): the name of a \(field.kind.rawValue)") }
        }
        if !isAdd, arguments == nil { out.append("a change") }
        return out
    }

    public var canRun: Bool { missing.isEmpty }

    /// The header or environment names the row being configured serves — rows that keep their value when left empty.
    var servedNames: [String] {
        switch configuring?.reach {
        case .http(_, _, let headers, _, _): return headers
        case .command(_, _, _, let env, _): return env
        default: return []
        }
    }

    /// The sign-in the row being configured has; nil when adding.
    var servedAuth: String? {
        if case .http(_, let auth, _, _, _) = configuring?.reach { return auth ?? "none" }
        return nil
    }

    var commandWords: [String] { commandLine.split(whereSeparator: \.isWhitespace).map(String.init) }
    var scopeList: [String] { scopes.split(whereSeparator: \.isWhitespace).map(String.init) }
    static func patterns(_ text: String) -> [String] { text.split(whereSeparator: { $0 == "," || $0.isWhitespace }).map(String.init) }

    // MARK: The verb

    /// `metistry connections add|set …`, exactly as argv — nil while nothing can be sent.
    public var arguments: [String]? {
        isAdd ? addArguments : setArguments
    }

    private var addArguments: [String]? {
        guard let kind, let provider else { return nil }
        var out = ["connections", "add", trimmedName, "--type", kind.rawValue]
        if provider != "custom" { out += ["--provider", provider] }
        out += reachArguments(all: true)
        out += fieldArguments(all: true)
        let about = description.trimmingCharacters(in: .whitespacesAndNewlines)
        if !about.isEmpty { out += ["--description", about] }
        if !discover { out.append("--no-discover") }
        if reach == .command { out += ["--"] + commandWords }
        return out
    }

    private var setArguments: [String]? {
        guard let row = configuring else { return nil }
        var out = ["connections", "set", row.name]
        let before = out.count
        out += reachArguments(all: false)
        out += fieldArguments(all: false)
        let about = description.trimmingCharacters(in: .whitespacesAndNewlines)
        if about != (row.description ?? "") { out += ["--description", about] }
        if reach == .command, commandWords != Self.commandWords(of: row) { out += ["--"] + commandWords }
        return out.count == before ? nil : out
    }

    private static func commandWords(of row: ConnectionRow) -> [String] {
        if case .command(let command, let args, _, _, _) = row.reach { return [command] + args }
        return []
    }

    /// `all`: every reach flag (add). Otherwise only what differs from the row (set).
    private func reachArguments(all: Bool) -> [String] {
        let row = configuring
        var out: [String] = []
        switch reach {
        case .http:
            let rowURL: String? = { if case .http(let u, _, _, _, _) = row?.reach { return u } else { return nil } }()
            if all || url != rowURL { out += ["--url", url.trimmingCharacters(in: .whitespaces)] }
            out += authArguments(all: all)
            for header in headers where !header.isBlank && !header.value.isEmpty { out += ["--header", header.pair] }
        case .command:
            for variable in env where !variable.isBlank && !variable.value.isEmpty { out += ["--env", variable.pair] }
            let rowContainer: Bool = { if case .command(_, _, _, _, let r) = row?.reach { return r == "container" } else { return false } }()
            if runsInContainer, all || !rowContainer { out += ["--runs-on", "container"] }
            if !runsInContainer, !all, rowContainer { out += ["--runs-on", "host"] }
        case .path:
            guard all else { return [] } // `set` changes no path reach today: remove and add again
            out += ["--path", path.trimmingCharacters(in: .whitespaces)]
            for pattern in Self.patterns(include) { out += ["--include", pattern] }
            for pattern in Self.patterns(skip) { out += ["--skip", pattern] }
        case .imap:
            guard all else { return [] }
            let host = imapHost.trimmingCharacters(in: .whitespaces).lowercased()
            out += ["--imap", imapPort.isEmpty ? host : "\(host):\(imapPort)", "--username", username.trimmingCharacters(in: .whitespaces), "--secret", secretName]
            if imapPlain { out.append("--plain") }
        }
        return out
    }

    private func authArguments(all: Bool) -> [String] {
        let rowAuth: String? = { if case .http(_, let a, _, _, _) = configuring?.reach { return a ?? "none" } else { return nil } }()
        let secretGiven = !secretName.isEmpty || !clientIdSecret.isEmpty || !clientSecretSecret.isEmpty
        guard all || auth.rawValue != rowAuth || secretGiven else { return [] }
        if !all, auth == .oauth, auth.rawValue == rowAuth {
            // bring your own client, or move the sign-in: the references alone
            var out: [String] = []
            if !clientIdSecret.isEmpty { out += ["--client-id-secret", clientIdSecret] }
            if !clientSecretSecret.isEmpty { out += ["--client-secret-secret", clientSecretSecret] }
            return out
        }
        switch auth {
        case .none:
            return all ? [] : ["--auth", "none"]
        case .bearer:
            return ["--auth", "bearer", "--secret", secretName]
        case .apiKey:
            return ["--auth", "api_key", "--auth-header", authHeader.trimmingCharacters(in: .whitespaces), "--secret", secretName]
        case .basic:
            return ["--auth", "basic", "--username", username.trimmingCharacters(in: .whitespaces), "--secret", secretName]
        case .oauth:
            var out = ["--auth", "oauth"]
            if isCustom {
                out += ["--authorize-url", authorizeURL.trimmingCharacters(in: .whitespaces), "--token-url", tokenURL.trimmingCharacters(in: .whitespaces)]
                for scope in scopeList { out += ["--scope", scope] }
                out += ["--client-id-secret", clientIdSecret]
            } else if !clientIdSecret.isEmpty {
                out += ["--client-id-secret", clientIdSecret]
            }
            if !clientSecretSecret.isEmpty { out += ["--client-secret-secret", clientSecretSecret] }
            return out
        }
    }

    /// `--config KEY=VALUE` per filled field — a secret or variable field as its NAME; the CLI writes the reference and refuses a value.
    private func fieldArguments(all: Bool) -> [String] {
        var out: [String] = []
        for field in typeFields where field.kind != .oauth {
            guard let value = fields[field.key]?.trimmingCharacters(in: .whitespaces), !value.isEmpty else { continue }
            out += ["--config", "\(field.key)=\(value)"]
        }
        return out
    }

    // MARK: What it sends, and the guards

    /// Every secret the draft names — the auth shortcut's, a field's, and any `{{ secret.x }}` typed into a header or environment value.
    public var referencedSecrets: [String] {
        var names: [String] = []
        func add(_ n: String) { if !n.isEmpty, !names.contains(n) { names.append(n) } }
        if reach == .http || reach == .imap, auth.takesSecret || reach == .imap { add(secretName) }
        if reach == .http, auth == .oauth {
            add(clientIdSecret)
            add(clientSecretSecret)
            if !isAdd || !trimmedName.isEmpty { add("\(trimmedName.replacingOccurrences(of: "-", with: "_"))_oauth_token") }
        }
        for field in typeFields where field.kind == .secret { add((fields[field.key] ?? "").trimmingCharacters(in: .whitespaces)) }
        for row in (reach == .http ? headers : reach == .command ? env : []) { for n in Self.secretReferences(in: row.value) { add(n) } }
        return names
    }

    /// `{{ secret.name }}` references in a typed value.
    static func secretReferences(in text: String) -> [String] {
        guard let re = try? NSRegularExpression(pattern: #"\{\{\s*secret\.([a-z][a-z0-9_]*)\s*\}\}"#) else { return [] }
        return re.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { m in Range(m.range(at: 1), in: text).map { String(text[$0]) } }
    }

    /// The reach as a served row would summarise it — for the preview and its guards.
    public var previewReach: ConnectionReach? {
        switch reach {
        case .http:
            guard !url.isEmpty else { return nil }
            return .http(url: url.trimmingCharacters(in: .whitespaces), auth: auth.rawValue, headers: headers.filter { !$0.isBlank }.map(\.name), query: [], timeoutSeconds: nil)
        case .command:
            guard let first = commandWords.first else { return nil }
            return .command(command: first, args: Array(commandWords.dropFirst()), cwd: nil, env: env.filter { !$0.isBlank }.map(\.name), runsOn: runsInContainer ? "container" : "host")
        case .path:
            guard !path.isEmpty else { return nil }
            return .path(path: path, include: Self.patterns(include), skip: Self.patterns(skip), watch: false)
        case .imap:
            guard !imapHost.isEmpty else { return nil }
            return .imap(host: imapHost.trimmingCharacters(in: .whitespaces).lowercased(), port: Int(imapPort) ?? 993, security: imapPlain ? "plain" : "tls")
        }
    }

    /// The connection as the list would serve it once written — `WhatItSends.of` reads it exactly as it reads a served row.
    public var previewRow: ConnectionRow? {
        guard let previewReach else { return nil }
        return ConnectionRow(
            name: trimmedName.isEmpty ? "new" : trimmedName, kind: kind, provider: provider, description: nil, status: .ok, issues: [],
            reach: previewReach, secrets: referencedSecrets, variables: [], tools: [], offerToAgents: false, usedBy: [], file: nil, providerUnit: nil
        )
    }

    /// The guards §10.5 names on the draft itself, before the CLI's own: a secret in a URL, a secret on a command line.
    public var guards: [String] {
        var out: [String] = []
        if reach == .http, !Self.secretReferences(in: url).isEmpty { out.append("A secret in the URL is refused — a URL lands in logs and histories. Send it in a header instead.") }
        if reach == .command, !Self.secretReferences(in: commandLine).isEmpty { out.append("A secret on the command line is refused — every process on this Mac can read another's arguments. Put it in the environment, where it is given to this command only.") }
        if reach == .http, url.hasPrefix("http://"), !url.hasPrefix("http://127.0.0.1"), !url.hasPrefix("http://localhost"), !referencedSecrets.isEmpty { out.append("Plain http off this Mac: a secret leaves over https only, so the door would block every one below.") }
        return out
    }

    // MARK: Nothing here holds a value — say so wherever the draft is printed

    /// What a `secret` or `variable` field's entry is: a picker of names, never a text field (the form's contract, held by a test).
    public static func isNamed(_ kind: ConnectionFieldKind) -> Bool { kind == .secret || kind == .variable }
}

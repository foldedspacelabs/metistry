// The four read verbs the app asks the CLI for, instead of reading its files.
//
// This replaces the scaffold's two file readers — a ~60-line YAML scalar reader
// over `identity.yaml`/`metistry.lock`, and a `package.json` read for the
// product version — which docs/ops/mac-app.md named as the thing
// `metistry identity --json` and `metistry --version` would delete. They have,
// and this is what took their place:
//
//   metistry identity --json      instance_id + the assistant's name
//   metistry version --json       the product, the runtime and the lock's pin
//   metistry secrets list --json  names and scope, never a value
//   metistry deployment --json    the resolved shape and where it came from
//
// WHY THIS IS NOT A SECOND IMPLEMENTATION. The app holds no parser for any file
// the CLI owns any more. It runs a verb and decodes what the verb said; a key
// that is missing is `nil` and the pane that wanted it says so, exactly the way
// a doctor row's `meta` already behaves (json-value.swift). Nothing here can
// disagree with the CLI about a value, because nothing here reads the value's
// source.
//
// ON KEY SPELLINGS. The CLI's JSON is not internally consistent — `doctor
// --json` is snake_case (`as_of`, `latency_ms`, `product_dir`), `restart --json`
// is single words (`service`, `action`, `ok`), and `SecretListing` in
// `packages/cli/src/secrets.ts` is camelCase (`inKeychain`, `foundUnder`). These
// readers therefore accept both spellings of a two-word key rather than
// guessing one and blanking a pane over a convention. That is deliberately a
// reader-side tolerance, not a wire contract: the CLI's shape is the CLI's.

import Foundation

// MARK: - What the app says when this install's CLI is older than this app

public enum CLIDegradation {
    /// A CLI that predates a verb answers `unknown command: <verb>` with exit 2
    /// (`packages/cli/src/main.ts`'s default branch). That is not "the verb
    /// failed" — it is "this install's CLI is older than this app", and saying
    /// so points at the fix. One sentence, one place, so every caller says it
    /// the same way.
    public static func message(verb: String) -> String {
        "this CLI has no `\(verb)` verb yet — update it (metistry update, or Check for Updates…)"
    }

    /// Exit 2 plus `unknown command` on stderr. A usage error for a verb the CLI
    /// *does* have prints `usage:` instead and must not be mistaken for one.
    public static func isUnknownVerb(_ result: CommandResult) -> Bool {
        result.exitCode == 2 && result.stderr.contains("unknown command")
    }

    /// What a refusal says, when the CLI's answer might be a `--json` result
    /// rather than a line of prose.
    ///
    /// Most `metistry compute …` verbs print their `--json` object even when
    /// `ok` is false: `providers test`, `models list` and `models
    /// install|load` all answer a failure as `{"ok": false, …, "detail":
    /// "<why>"}` on STDOUT, pretty-printed, with exit 1
    /// (`packages/cli/src/compute.ts`). The LAST LINE of that is the closing
    /// `}` of `JSON.stringify(_, null, 2)` — never the reason — so a caller
    /// that took "the last line of stdout" as its fallback showed exactly
    /// that brace and nothing else.
    ///
    /// This tries the trailing JSON object first: `error.message` (with
    /// `error.code` alongside it, for the envelope shape `{ok:false,
    /// error:{code,message}}`), else the bare `detail` (or `error`) string
    /// these verbs actually print, before falling back to the last
    /// non-empty line of stderr, then of stdout — a plain-text refusal
    /// (`metistry compute: <message>` on stderr, for a verb that threw
    /// rather than returned) reads exactly as it did before.
    public static func refusalMessage(_ result: CommandResult, verb: String) -> String {
        if let json = JSONValue.parseTrailing(in: result.stdout), json.bool("ok") == false {
            if let message = json["error"]?.string("message") {
                let code = json["error"]?.string("code")
                return code.map { "\(message) (\($0))" } ?? message
            }
            if let detail = json.string("detail", "error") {
                return detail
            }
        }
        let line = lastNonEmptyLine(result.stderr) ?? lastNonEmptyLine(result.stdout)
        return line ?? "`metistry \(verb)` exited \(result.exitCode) with no output"
    }

    private static func lastNonEmptyLine(_ text: String) -> String? {
        text.split(separator: "\n").last { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.map(String.init)
    }
}

/// Why a read did not produce a value. Every case is a sentence the pane prints
/// verbatim — §3.16's error envelope: what could not be done, and the reason.
public enum CLIReadError: LocalizedError, Equatable {
    /// This install's CLI predates the verb.
    case noSuchVerb(String)
    /// The verb ran and failed.
    case failed(verb: String, detail: String)
    /// The verb ran, exited 0, and printed something this app could not read.
    case undecodable(verb: String, detail: String)
    /// There is no runtime to ask.
    case noRuntime

    public var errorDescription: String? {
        switch self {
        case .noSuchVerb(let verb):
            return CLIDegradation.message(verb: verb)
        case .failed(let verb, let detail):
            return "`metistry \(verb)` failed: \(detail)"
        case .undecodable(let verb, let detail):
            return "could not read `metistry \(verb)`'s output: \(detail)"
        case .noRuntime:
            return "no metistry runtime located — choose an instance in Settings"
        }
    }
}

// MARK: - identity --json

/// `metistry identity --json`.
///
/// The assistant is named in `identity.yaml` and nowhere else (CLAUDE.md), so
/// this is the app's only route to the name — and the app renders it, never
/// stores it, and offers no field to change it: `identity.yaml` is a §4.7
/// protected path.
public struct InstanceIdentity: Sendable, Equatable {
    /// The v4 UUID `metistry init` minted — this directory's stable identity and
    /// the Keychain account its own secrets are filed under
    /// (docs/product/desktop-app-plan.md, "Instance directories are
    /// self-contained"). The scaffold's Instance pane had to say there was no
    /// such thing; there is one now.
    public let instanceID: String?
    public let assistantName: String?
    public let mention: String?
    public let icon: String?

    public init(instanceID: String?, assistantName: String?, mention: String?, icon: String?) {
        self.instanceID = instanceID
        self.assistantName = assistantName
        self.mention = mention
        self.icon = icon
    }

    public init(json: JSONValue) {
        self.init(
            instanceID: json.string("instance_id", "instanceId"),
            assistantName: json.string("name", "assistant_name", "assistantName"),
            mention: json.string("mention"),
            icon: json.string("icon")
        )
    }

    /// A reply that named neither the instance nor the assistant is not an
    /// identity, whatever else it holds — better to report that than to render
    /// a pane of blanks.
    public var isEmpty: Bool { instanceID == nil && assistantName == nil }
}

// MARK: - version --json

/// `metistry version --json` — three versions that can legitimately differ, so
/// the pane shows all three rather than picking one and calling it "the
/// version".
public struct VersionFacts: Sendable, Equatable {
    /// The product runtime this app is driving: what `productVersion()` reads,
    /// and what the scaffold got by parsing the checkout's `package.json`.
    public let product: String?
    /// The bundled runtime pack (Node, Postgres, git) beside it, when there is
    /// one. `nil` for a checkout that uses the machine's own node.
    public let runtime: String?
    /// `<instance>/metistry.lock` — the release this INSTANCE is pinned to,
    /// which is not the same question as which product is installed (plan
    /// §4.16).
    public let lock: InstancePin?

    public init(product: String?, runtime: String?, lock: InstancePin?) {
        self.product = product
        self.runtime = runtime
        self.lock = lock
    }

    public init(json: JSONValue) {
        // Both shapes: a flat `{product, runtime, lock}` of strings, and a
        // nested `{product: {version}, …}`. Which one the verb settles on is the
        // CLI's to decide.
        self.init(
            product: json.string("product", "product_version", "version") ?? json["product"]?.string("version"),
            // the verb says `runtime_pack: {version, commit, built_at}` (packages/cli/src/version.ts)
            runtime: json.string("runtime", "runtime_version") ?? json["runtime"]?.string("version") ?? json["runtime_pack"]?.string("version"),
            lock: json["lock"].map(InstancePin.init(json:))
        )
    }

    public var isEmpty: Bool { product == nil && runtime == nil && lock == nil }
}

/// The instance's pin, as `metistry.lock` records it.
public struct InstancePin: Sendable, Equatable {
    public let version: String?
    public let commit: String?
    /// `git` (this install is a checkout) or `release` (published artifacts).
    public let source: String?
    public let updatedAt: String?
    public let migrationsApplied: Int

    public init(version: String?, commit: String?, source: String?, updatedAt: String?, migrationsApplied: Int) {
        self.version = version
        self.commit = commit
        self.source = source
        self.updatedAt = updatedAt
        self.migrationsApplied = migrationsApplied
    }

    public init(json: JSONValue) {
        self.init(
            version: json.string("version"),
            commit: json.string("commit"),
            // `version --json` calls it `channel`; metistry.lock itself, `source`
            source: json.string("source", "channel"),
            updatedAt: json.string("updated_at", "updatedAt"),
            migrationsApplied: json.int("migrations_applied", "migrationsApplied")
                ?? json["migrations_applied"]?.arrayValue?.count
                ?? 0
        )
    }
}

// MARK: - deployment --json

/// `metistry deployment --json` — the same facts doctor's `deployment` row
/// carries, from a verb that does not need a full sweep to answer.
///
/// The wizard asks this one before it offers to change the shape, because
/// "compose, resolved from `<instance>/deployment.yaml`" is the sentence that
/// makes the choice meaningful.
public struct DeploymentShapeFacts: Sendable, Equatable {
    public let shape: String
    /// e.g. `seed/deployment.yaml`, `<instance>/deployment.yaml`.
    public let from: String
    /// The keep-awake switch and its two sub-switches as stored — the
    /// verb's `keep_awake_setting` (T4-20), else its legacy `keep_awake`
    /// value. `nil` from a CLI that reports neither.
    public let keepAwake: KeepAwakeSwitches?
    /// The CLI's own sentence for this setting on this install, when it has one.
    public let keepAwakeNote: String?

    public init(shape: String, from: String, keepAwake: KeepAwakeSwitches? = nil, keepAwakeNote: String? = nil) {
        self.shape = shape
        self.from = from
        self.keepAwake = keepAwake
        self.keepAwakeNote = keepAwakeNote
    }

    public init?(json: JSONValue) {
        guard let shape = json.string("shape") else { return nil }
        self.init(
            shape: shape,
            from: json.string("from") ?? "unknown",
            keepAwake: json["keep_awake_setting"].flatMap(KeepAwakeSwitches.init(json:)) ?? json["keep_awake"].flatMap(KeepAwakeSwitches.init(json:)),
            keepAwakeNote: json.string("keep_awake_note")
        )
    }
}

// MARK: - JSONValue conveniences these readers need

public extension JSONValue {
    var arrayValue: [JSONValue]? {
        if case .array(let a) = self { return a }
        return nil
    }

    /// The first of these keys that holds a string. See "ON KEY SPELLINGS".
    func string(_ keys: String...) -> String? {
        for key in keys {
            if let value = self[key]?.stringValue { return value }
        }
        return nil
    }

    func int(_ keys: String...) -> Int? {
        for key in keys {
            if let value = self[key]?.intValue { return value }
        }
        return nil
    }

    func bool(_ keys: String...) -> Bool? {
        for key in keys {
            if let value = self[key]?.boolValue { return value }
        }
        return nil
    }

    static func parse(_ data: Data) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: data)
    }
}

// MARK: - The CLI prints prose and JSON down the same pipe

public extension JSONValue {
    /// The last top-level JSON value in a stream that also carried prose.
    ///
    /// Most `metistry compute …` verbs narrate what they did through the SAME
    /// `out()` the `--json` result goes to: `providers add` says where it filed
    /// the key, `assign` warns about a non-ZDR provider, `budget` says nothing
    /// enforces it yet, and every protected write prints its own step lines
    /// (`packages/cli/src/main.ts` — `JSON.stringify(r, null, 2)` is printed
    /// AFTER all of that). So stdout is lines of prose followed by one
    /// pretty-printed object, and a whole-stream parse fails on the first word.
    ///
    /// `JSON.stringify(_, null, 2)` puts the opening brace and the closing one
    /// in column zero, which is what this finds. Candidates are tried from the
    /// last backwards, so a prose line that happens to start with a brace costs
    /// an attempt rather than the answer.
    ///
    /// The app does no other repair: if nothing here parses, the caller says
    /// the verb printed something it could not read and shows the stream.
    static func parseTrailing(in text: String) -> JSONValue? {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var starts: [Int] = []
        for (index, line) in lines.enumerated() where line.hasPrefix("{") || line.hasPrefix("[") {
            starts.append(index)
        }
        for start in starts.reversed() {
            let candidate = lines[start...].joined(separator: "\n")
            if let data = candidate.data(using: .utf8), let value = try? JSONValue.parse(data) {
                return value
            }
        }
        return nil
    }
}

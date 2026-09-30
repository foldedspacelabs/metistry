// `metistry compute show --json` — where this instance's work runs, what it may
// cost, and whether the key each provider names is present. Never a key's value:
// the verb has no code path that can print one (`packages/cli/src/compute.ts`,
// `ProviderRow.secret` is a NAME and `secret_present` is a boolean).
//
// The same rule `SecretListing` is built on, for the same reason: a type that
// cannot hold a secret is a control; a promise not to display one is not.

import Foundation

public struct ComputeProviderFacts: Sendable, Equatable, Identifiable {
    public let name: String
    public let kind: String
    public let locality: String
    public let baseURL: String
    /// Zero data retention as the provider states it. `false`/`nil` on an
    /// off-machine provider is a warning, never a block (C13).
    public let zdr: Bool?
    /// The NAME of the secret this provider authenticates with, if any.
    public let secret: String?
    /// Whether an item of that name is in the login Keychain. Presence only.
    public let secretPresent: Bool?
    /// The models this file already points at this provider, from the report's
    /// own `models_assigned` — the app does not derive it a second time.
    public let modelsAssigned: [String]
    /// `budgets.providers.<name>`, when this instance sets one.
    public let budget: ComputeBudgetFacts?
    /// The switch (C130): off = not searched, not offered, and nothing may be
    /// assigned to it. A report from before the switch existed has no key,
    /// which is on — the CLI's own reading of an absent `enabled`.
    public let enabled: Bool
    /// The provider's one tag (C132), as the report states it — never derived
    /// here when the report says.
    public let tag: ComputeTag
    /// The NAME of the instance secret the key is, when the reference is a
    /// `{{ secret.<name> }}` — what the gear's key field shows and what
    /// `providers set --secret` takes. Never a value.
    public let secretName: String?

    public var id: String { name }

    public init(
        name: String,
        kind: String,
        locality: String,
        baseURL: String,
        zdr: Bool? = nil,
        secret: String? = nil,
        secretPresent: Bool? = nil,
        modelsAssigned: [String] = [],
        budget: ComputeBudgetFacts? = nil,
        enabled: Bool = true,
        tag: ComputeTag? = nil,
        secretName: String? = nil
    ) {
        self.name = name
        self.kind = kind
        self.locality = locality
        self.baseURL = baseURL
        self.zdr = zdr
        self.secret = secret
        self.secretPresent = secretPresent
        self.modelsAssigned = modelsAssigned
        self.budget = budget
        self.enabled = enabled
        self.tag = tag ?? (locality == "on_machine" ? .local : .cloud)
        self.secretName = secretName
    }

    public init?(json: JSONValue) {
        guard let name = json.string("name") else { return nil }
        self.init(
            name: name,
            kind: json.string("kind") ?? "",
            locality: json.string("locality") ?? "",
            baseURL: json.string("base_url", "baseUrl") ?? "",
            zdr: json.bool("zdr"),
            secret: json.string("secret"),
            secretPresent: json.bool("secret_present", "secretPresent"),
            modelsAssigned: (json["models_assigned"]?.arrayValue ?? json["modelsAssigned"]?.arrayValue ?? []).compactMap(\.stringValue),
            budget: json["budget"].flatMap(ComputeBudgetFacts.init(json:)),
            enabled: json.bool("enabled") ?? true,
            tag: json.string("tag").flatMap(ComputeTag.init(rawValue:)),
            secretName: json.string("secret_name", "secretName")
        )
    }

    /// Off this machine and claiming no zero data retention. A WARNING, never a
    /// block (C13): the pane badges it and the person decides.
    public var isOffMachineWithoutZDR: Bool { locality == "off_machine" && zdr != true }

    /// True when this provider names a key that is not there. The one thing
    /// that turns a provider row amber without the CLI having failed at
    /// anything.
    public var isMissingSecret: Bool { secret != nil && secretPresent != true }

    /// Sentence case: prose, not a name.
    public var summary: String {
        var parts = [locality == "on_machine" ? "on this machine, no cost" : "off this machine"]
        if locality == "off_machine" && zdr != true { parts.append("no zero-retention claim") }
        if let secret {
            parts.append(secretPresent == true ? "\(secret) is in the Keychain" : "\(secret) is NOT set")
        }
        return parts.joined(separator: " · ")
    }
}

public struct ComputeAssignmentFacts: Sendable, Equatable, Identifiable {
    /// `default`, a tier name, or `crew:<name>`.
    public let target: String
    public let provider: String
    public let model: String
    public let effort: String
    public let warnNonZDR: Bool

    public var id: String { target }

    public init(target: String, provider: String, model: String, effort: String, warnNonZDR: Bool = false) {
        self.target = target
        self.provider = provider
        self.model = model
        self.effort = effort
        self.warnNonZDR = warnNonZDR
    }

    public init?(json: JSONValue) {
        guard let target = json.string("target"), let provider = json.string("provider"), let model = json.string("model") else { return nil }
        self.init(
            target: target,
            provider: provider,
            model: model,
            effort: json.string("effort") ?? "medium",
            warnNonZDR: json.bool("warn_non_zdr", "warnNonZdr") ?? false
        )
    }

    public var ref: String { "\(provider)/\(model)" }
}

public struct ComputeFacts: Sendable, Equatable {
    /// The file the effective configuration came from; `nil` = none exists yet.
    public let file: String?
    /// The instance's own file — what the verbs edit, whether or not it exists.
    public let instanceFile: String?
    public let providers: [ComputeProviderFacts]
    public let assignments: [ComputeAssignmentFacts]
    /// True while nothing is assigned — which now means there is no engine.
    public let assignsNothing: Bool
    /// `budgets.instance`, when this instance sets one.
    public let instanceBudget: ComputeBudgetFacts?

    public init(
        file: String?,
        instanceFile: String?,
        providers: [ComputeProviderFacts],
        assignments: [ComputeAssignmentFacts],
        assignsNothing: Bool,
        instanceBudget: ComputeBudgetFacts? = nil
    ) {
        self.file = file
        self.instanceFile = instanceFile
        self.providers = providers
        self.assignments = assignments
        self.assignsNothing = assignsNothing
        self.instanceBudget = instanceBudget
    }

    public init?(json: JSONValue) {
        guard case .object = json else { return nil }
        self.init(
            file: json.string("file"),
            instanceFile: json.string("instance_file", "instanceFile"),
            providers: (json["providers"]?.arrayValue ?? []).compactMap(ComputeProviderFacts.init(json:)),
            assignments: (json["assignments"]?.arrayValue ?? []).compactMap(ComputeAssignmentFacts.init(json:)),
            assignsNothing: json.bool("assigns_nothing", "assignsNothing") ?? true,
            instanceBudget: (json["instance_budget"] ?? json["instanceBudget"]).flatMap(ComputeBudgetFacts.init(json:))
        )
    }

    public func provider(named name: String) -> ComputeProviderFacts? {
        providers.first { $0.name == name }
    }

    /// Every assignment target this file already names, `default` first and the
    /// rest in the CLI's own order. The pane edits exactly these plus whatever
    /// a person types — it never invents a tier `rules.yaml` has not heard of.
    public var assignmentTargets: [String] {
        let rest = assignments.map(\.target).filter { $0 != "default" }
        return assignments.contains { $0.target == "default" } ? ["default"] + rest : rest
    }

    /// What `assignments.default` resolves to, as `<provider>/<model>`.
    public var defaultRef: String? {
        assignments.first { $0.target == "default" }?.ref
    }

    /// The one line Settings and the wizard both show. Sentence case.
    public var engineSummary: String {
        guard let row = assignments.first(where: { $0.target == "default" }) else {
            return "no engine — compute.yaml assigns no default, so the assistant is not started and queued turns wait"
        }
        return "\(row.ref) at \(row.effort) effort"
    }
}

// MARK: - the one tag (C132)

/// *Local* (free), *Cloud* (by the token), *Subscription* — a provider's one
/// tag, as the console reports it (`tag` on `GET /api/compute` and on every
/// catalogue place). There is no *By token* tag (screen-15 §5.3).
public enum ComputeTag: String, CaseIterable, Sendable, Equatable {
    case local
    case cloud
    case subscription

    /// Title Case: a tag names a kind of thing (design-system P10).
    public var label: String {
        switch self {
        case .local: return "Local"
        case .cloud: return "Cloud"
        case .subscription: return "Subscription"
        }
    }

    /// Where the model runs, for the dropdown's and the list's two groups:
    /// *On this Mac*, then *Cloud* — a subscription runs in the cloud.
    public var runsOnThisMac: Bool { self == .local }

    /// A tag the wire does not know yet reads as Cloud: off this Mac is the
    /// cautious reading of an unknown place.
    public init(wire: String?) {
        self = wire.flatMap(ComputeTag.init(rawValue:)) ?? .cloud
    }
}

// MARK: - spending limits (T4-19)

/// `limits` on `GET /api/compute` (T4-19, `spendingLimits` in
/// `packages/core/src/budget.ts`): every spending limit side by side — the
/// instance's, each provider's, each project's daily budget. The pane renders
/// this and computes none of it: a subscription is its plan's window because
/// the SERVER says `kind: window`, not because the app read a tag.
public struct ComputeLimits: Sendable, Equatable {
    /// A limit in dollars: the instance's, or a provider's billed by the token.
    public struct Dollar: Sendable, Equatable {
        /// `instance` or `provider:<name>` — what `POST /api/compute/budget` takes.
        public let scope: String
        /// The dotted path in `compute.yaml` a refusal names.
        public let field: String
        public let dailyUSD: Double?
        public let monthlyUSD: Double?
        /// Nil = no limit is set here, so nothing happens.
        public let action: ComputeBudgetAction?
        /// Nil when the `spend` query is not loaded — never a guessed zero.
        public let spentToday: Double?
        public let spentThisMonth: Double?

        init?(json: JSONValue) {
            guard json.string("kind") == "usd", let scope = json.string("scope") else { return nil }
            self.scope = scope
            field = json.string("field") ?? scope
            dailyUSD = json["daily_usd"]?.doubleValue
            monthlyUSD = json["monthly_usd"]?.doubleValue
            action = json.string("action").flatMap(ComputeBudgetAction.init(rawValue:))
            spentToday = json["spent"]?["daily"]?.doubleValue
            spentThisMonth = json["spent"]?["monthly"]?.doubleValue
        }
    }

    /// A provider's line: the provider, then its limit — dollars, or its
    /// plan's window when it is billed by subscription.
    public struct Provider: Sendable, Equatable, Identifiable {
        public let name: String
        public let tag: ComputeTag
        public let enabled: Bool
        /// Nil for a subscription: its window is its limit (C133).
        public let dollar: Dollar?
        /// A subscription's calls in each window; nil when `spend` is not loaded.
        public let callsToday: Int?
        public let callsThisMonth: Int?

        public var id: String { name }
        public var isWindow: Bool { dollar == nil }

        init?(json: JSONValue) {
            guard let name = json.string("name") else { return nil }
            self.name = name
            tag = ComputeTag(wire: json.string("tag"))
            enabled = json.bool("enabled") ?? true
            dollar = Dollar(json: json)
            callsToday = json["used"]?.int("calls_today")
            callsThisMonth = json["used"]?.int("calls_this_month")
        }
    }

    /// A project's daily budget — set by `PUT /api/projects/:slug`, and at
    /// the limit an autonomous project switches to review, never a refusal.
    public struct Project: Sendable, Equatable, Identifiable {
        public let id: String
        public let title: String?
        public let dailyUSD: Double?
        public let spentToday: Double?
        public let mode: String

        init?(json: JSONValue) {
            guard let id = json.string("id") else { return nil }
            self.id = id
            title = json.string("title")
            dailyUSD = json["daily_usd"]?.doubleValue
            spentToday = json["spent"]?["daily"]?.doubleValue
            mode = json.string("mode") ?? "autonomous"
        }
    }

    public let instance: Dollar?
    public let providers: [Provider]
    /// Nil when `projects_rollup` is not loaded — never a guessed empty list.
    public let projects: [Project]?

    public init?(json: JSONValue) {
        guard case .object = json else { return nil }
        instance = json["instance"].flatMap(Dollar.init(json:))
        providers = (json["providers"]?.arrayValue ?? []).compactMap(Provider.init(json:))
        projects = json["projects"]?.arrayValue?.compactMap(Project.init(json:))
    }
}

// MARK: - budgets

/// `budgets.instance` and `budgets.providers.<name>` as `compute show --json`
/// reports them, and as `metistry compute budget` writes them back.
///
/// Enforced in the engine, before the call, against what the window has
/// already spent (docs/ops/compute.md) — the pane names the action, not
/// just the number, so a limit here reads as a cap that exists.
public struct ComputeBudgetFacts: Sendable, Equatable {
    public let dailyUSD: Double?
    public let monthlyUSD: Double?
    public let action: ComputeBudgetAction

    public init(dailyUSD: Double?, monthlyUSD: Double?, action: ComputeBudgetAction) {
        self.dailyUSD = dailyUSD
        self.monthlyUSD = monthlyUSD
        self.action = action
    }

    public init?(json: JSONValue) {
        guard case .object = json else { return nil }
        self.init(
            dailyUSD: json["daily_usd"]?.doubleValue ?? json["dailyUsd"]?.doubleValue,
            monthlyUSD: json["monthly_usd"]?.doubleValue ?? json["monthlyUsd"]?.doubleValue,
            action: ComputeBudgetAction(rawValue: json.string("action") ?? "") ?? .allow
        )
    }

    /// Sentence case, and "-" where the CLI's own table prints "-".
    public var summary: String {
        let daily = dailyUSD.map { "$\(Self.money($0))/day" } ?? "no daily limit"
        let monthly = monthlyUSD.map { "$\(Self.money($0))/month" } ?? "no monthly limit"
        return "\(daily) · \(monthly) · \(action.label)"
    }

    static func money(_ value: Double) -> String {
        value == value.rounded() ? String(Int(value)) : String(format: "%.2f", value)
    }
}

/// `--action allow|stop|critical_only` — `BUDGET_ACTIONS` in
/// `packages/core/src/compute.ts`. An action the CLI does not accept would be a
/// control that can only fail, so the app offers exactly these three.
public enum ComputeBudgetAction: String, CaseIterable, Sendable, Identifiable {
    case allow
    case stop
    case criticalOnly = "critical_only"

    public var id: String { rawValue }

    /// Title Case: these are control labels (design-system P10).
    public var label: String {
        switch self {
        case .allow: return "Allow"
        case .stop: return "Stop"
        case .criticalOnly: return "Critical Only"
        }
    }

    public var detail: String {
        switch self {
        case .allow: return "Record the overrun and keep going."
        case .stop: return "Refuse every turn on this provider until the window rolls over."
        case .criticalOnly: return "Only turns marked critical may spend past the limit."
        }
    }
}

/// `--effort low|medium|high` — `EFFORTS` in `packages/core/src/tiers.ts`.
public enum ComputeEffort: String, CaseIterable, Sendable, Identifiable {
    case low
    case medium
    case high

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .low: return "Low"
        case .medium: return "Medium"
        case .high: return "High"
        }
    }
}

// MARK: - providers test --json

/// `metistry compute providers test <name> --json` — one live `GET /v1/models`
/// with the provider's own credential, spoken by the CLI and never by this app.
public struct ProviderTestFacts: Sendable, Equatable {
    public let name: String
    public let ok: Bool
    public let url: String
    public let models: [String]
    /// One line: an HTTP status, a model count, or why it failed. Never a secret.
    public let detail: String

    public init(name: String, ok: Bool, url: String, models: [String], detail: String) {
        self.name = name
        self.ok = ok
        self.url = url
        self.models = models
        self.detail = detail
    }

    public init?(json: JSONValue) {
        guard let name = json.string("name"), let ok = json.bool("ok") else { return nil }
        self.init(
            name: name,
            ok: ok,
            url: json.string("url") ?? "",
            models: (json["models"]?.arrayValue ?? []).compactMap(\.stringValue),
            detail: json.string("detail") ?? ""
        )
    }

    public var status: CheckStatus { ok ? .ok : .failed }
}

// MARK: - models list --json

/// `metistry compute models list --provider <name> --json`, for one provider.
/// This is what fills a model picker: the ids the provider itself served back,
/// so the app never keeps a catalogue of its own to go stale.
public struct ModelCatalogue: Sendable, Equatable {
    public let provider: String
    public let ok: Bool
    public let detail: String
    public let models: [String]

    public init(provider: String, ok: Bool, detail: String, models: [String]) {
        self.provider = provider
        self.ok = ok
        self.detail = detail
        self.models = models
    }

    public init?(json: JSONValue) {
        guard let name = json.string("name") else { return nil }
        self.init(
            provider: name,
            ok: json.bool("ok") ?? false,
            detail: json.string("detail") ?? "",
            models: (json["models"]?.arrayValue ?? []).compactMap(\.stringValue)
        )
    }

    /// `<provider>/<model>` — the reference every assign and install verb takes.
    public func ref(for model: String) -> String { "\(provider)/\(model)" }

    /// The whole reply, which carries one entry per provider asked about.
    public static func decode(_ json: JSONValue) -> [ModelCatalogue] {
        (json["providers"]?.arrayValue ?? []).compactMap(ModelCatalogue.init(json:))
    }
}

// MARK: - models install / load / unload --json

/// What `metistry compute models install|load|unload --json` answered.
///
/// `noop` is the honest half: LM Studio is the only one of the three local
/// servers with an addressable load, so the other two answer with a MESSAGE
/// about what actually governs their residency rather than a silent success
/// (`packages/cli/src/compute.ts`, `modelsLoad`). The pane prints that message
/// instead of a tick.
public struct ModelActionFacts: Sendable, Equatable {
    public let provider: String
    public let server: String
    public let model: String
    public let ok: Bool
    public let noop: Bool
    public let detail: String
    /// llamaserver only: the `serve.model_path` the verb wrote into compute.yaml.
    public let modelPath: String?
    public let bytes: Int?

    public init(provider: String, server: String, model: String, ok: Bool, noop: Bool = false, detail: String, modelPath: String? = nil, bytes: Int? = nil) {
        self.provider = provider
        self.server = server
        self.model = model
        self.ok = ok
        self.noop = noop
        self.detail = detail
        self.modelPath = modelPath
        self.bytes = bytes
    }

    public init?(json: JSONValue) {
        guard let provider = json.string("provider"), let ok = json.bool("ok") else { return nil }
        self.init(
            provider: provider,
            server: json.string("server") ?? "",
            model: json.string("model") ?? "",
            ok: ok,
            noop: json.bool("noop") ?? false,
            detail: json.string("detail") ?? "",
            modelPath: json.string("model_path", "modelPath"),
            bytes: json.int("bytes")
        )
    }
}

// MARK: - the local servers, from doctor's own rows

/// One `local:<server>` row of `metistry doctor --json` (kind `local-model`).
///
/// Discovery is doctor's, not the app's: `probeLocalServers` asks every known
/// server at the URL compute.yaml gives it, or at the server's default port
/// when nothing dials it. The row is NEVER `failed` — a Mac that runs no local
/// server is a supported install — so this section can never turn the pane red.
public struct LocalServerFacts: Sendable, Equatable, Identifiable {
    /// `lmstudio`, `ollama`, `llamaserver` or `applefm`.
    public let server: String
    public let status: CheckStatus
    /// The API root doctor actually probed.
    public let url: String?
    /// The model ids it served back.
    public let models: [String]
    /// The compute.yaml provider that dials it, when one does.
    public let provider: String?
    public let remediation: String?

    public var id: String { server }

    public init(server: String, status: CheckStatus, url: String?, models: [String], provider: String?, remediation: String?) {
        self.server = server
        self.status = status
        self.url = url
        self.models = models
        self.provider = provider
        self.remediation = remediation
    }

    public init?(row: DoctorRow) {
        guard row.kind == "local-model", row.name.hasPrefix("local:") else { return nil }
        self.init(
            server: String(row.name.dropFirst("local:".count)),
            status: row.status,
            url: row.meta?.string("url"),
            models: (row.meta?["models"]?.arrayValue ?? []).compactMap(\.stringValue),
            provider: row.meta?.string("provider"),
            remediation: row.remediation
        )
    }

    /// The template's own label where the app knows one; the identifier
    /// otherwise, because a server nobody has written a label for is still a
    /// row (invariant 5).
    public var label: String { ComputeTemplate(rawValue: server)?.label ?? server }

    /// Whether `metistry compute models install` has a mechanism for this
    /// server at all. Apple's Foundation Models are the OS's — there is nothing
    /// to pull — so the pane offers no button rather than one that refuses.
    public var canInstall: Bool {
        server == "lmstudio" || server == "ollama" || server == "llamaserver"
    }

    /// LM Studio is the only one of them with an addressable load/unload.
    public var canLoad: Bool { server == "lmstudio" }

    /// What "install a model" means here, in the words of the mechanism that
    /// does it — so nobody types a Hugging Face path into Ollama.
    public var installHint: String {
        switch server {
        case "lmstudio": return "An LM Studio model id — `lms get <id>` fetches it into LM Studio's own model directory."
        case "ollama": return "An Ollama model name (e.g. `qwen3:8b`) — pulled over this server's own /api/pull, with its progress."
        case "llamaserver": return "A Hugging Face GGUF, as `<owner>/<repo>/<file>.gguf` — downloaded into the instance's state/models/ and checked against the digest Hugging Face publishes, then written into compute.yaml as serve.model_path."
        default: return "This server has no install mechanism Metistry speaks."
        }
    }

    public var isConfigured: Bool { provider != nil }

    /// `doctor`'s `local:applefm` row, and the BRIDGE whose process serves it.
    /// Two names for one thing, because doctor reports them separately: the
    /// bridge is a component with a lifecycle, the local server is a URL that
    /// answers `/v1/models`.
    public static let foundationModelServer = "applefm"
    public static let foundationModelBridge = "apple-fm"
}

public extension DoctorReport {
    /// Every local model server doctor probed, in doctor's own order.
    var localServers: [LocalServerFacts] {
        rows.compactMap(LocalServerFacts.init(row:))
    }

    /// The engine row. `absent` here is the supported no-engine install, not a
    /// fault (docs/ops/assistant-tools.md), and its remediation is the CLI's
    /// own sentence about which of the two reasons applies.
    var assistantRow: DoctorRow? {
        rows.first { $0.kind == "service" && $0.name == "assistant" }
    }

    /// What a bridge row adds to its own name in the menu, when this install
    /// has wired it to something beyond being up.
    ///
    /// There is exactly one today, and it is worth the sentence: the apple-fm
    /// bridge is a bridge like any other until `compute.yaml` declares a
    /// provider that dials it — and then it is also where turns can run, at no
    /// cost and without leaving the Mac. Doctor already knows, because the
    /// `local:applefm` row carries the provider that points at it; the menu
    /// reads that rather than asking `compute show` a second time.
    func bridgeNote(for component: String) -> String? {
        guard component == LocalServerFacts.foundationModelBridge else { return nil }
        let row = localServers.first { $0.server == LocalServerFacts.foundationModelServer }
        return row?.isConfigured == true ? "serves foundation-model" : nil
    }
}

// MARK: - how much memory is left for a model

/// What the pane says about RAM, and it says **estimate** every time.
///
/// `ProcessInfo.physicalMemory` is how much memory the machine HAS, which is
/// not how much is free: macOS compresses, caches and swaps, and the honest
/// free figure changes second to second. Rather than pretend to measure it, the
/// pane subtracts a reserve — a quarter of physical memory, never less than
/// 4 GB, for macOS itself and whatever else is open — and labels the remainder
/// an estimate. A model whose weights exceed it will still load; it will just
/// be slow, and that is the person's call, not the app's.
public enum MemoryHeadroom: Sendable {
    public static let minimumReserveBytes: UInt64 = 4 * 1024 * 1024 * 1024

    public static func reserveBytes(physical: UInt64) -> UInt64 {
        max(minimumReserveBytes, physical / 4)
    }

    public static func headroomBytes(physical: UInt64) -> UInt64 {
        let reserve = reserveBytes(physical: physical)
        return physical > reserve ? physical - reserve : 0
    }

    /// One line, with the word "estimate" in it, for the local-models section.
    public static func summary(physical: UInt64) -> String {
        "\(gigabytes(headroomBytes(physical: physical))) GB free for a model (estimate) — \(gigabytes(physical)) GB installed, "
            + "less \(gigabytes(reserveBytes(physical: physical))) GB held back for macOS and everything else open. "
            + "Not a measurement: nothing here reads free memory, and a model larger than this still loads, just slowly."
    }

    public static func gigabytes(_ bytes: UInt64) -> String {
        String(format: "%.1f", Double(bytes) / 1_073_741_824)
    }
}

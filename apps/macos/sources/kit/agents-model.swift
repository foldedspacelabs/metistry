// Agents — what the assistant delegates to, and what connects in (design-build-
// plan T6-5; screen-07-agents.md; §2.4 the actor model; C42, C52, C128, C136,
// C138). The view is agents-view.swift (the roster, New Agent) and
// agent-detail-view.swift (one agent); this file is what they draw from.
//
// THE ASSISTANT IS NOT HERE (C52). It is unscoped because it IS the owner, so
// drawing it with a grant would imply its reach could be less. The registry
// lists its row (`kind: internal`); the roster drops it by kind and by its
// principal id, and nothing on this screen can open it.
//
// FOUR READS, NO NEW ROUTE. The registry (`GET /api/agents`, with the
// escalation ceiling's `access_ceilings`, T2-2), presence (`agent_presence`),
// the routines that name an actor (`GET /api/scheduled`, D3), and — for one
// agent — its definition (`GET /api/agents/:id/definition`, T4-6) and what it
// did (`activity_feed` with `agent`). Every write is a door that already
// exists: the registry's PUT/POST routes, Run Now on a routine, and — for a
// definition, a protected file — `metistry agents define` (M12), a management
// verb only the Mac that runs Metistry has.
//
// A REMOTE CLIENT DOES NOT GET THE EDITOR (§2.3, Q8). Editing a definition,
// registering a tool and rotating a token change the boundary; the kit knows it
// is on that Mac because the session has a management runner. Without one the
// editor is not drawn at all — not dimmed — and the console's `local` reach is
// what refuses the rest (a client hiding a control is never the control).
//
// A WIDENING IS CONFIRMED WITH THE CONSOLE'S OWN WORDS (screen 7 §5). `PUT
// /api/agents/:id/autonomy` widens the moment it lands, so the confirm has to
// come first: `AgentAutonomy.widenings` is core's `autonomyWidenings`
// (packages/core/src/actions.ts) carried over line for line — the strings
// the route answers in `widened` — and a test holds the two to the same
// cases. A narrowing is applied on commit with no ceremony. Before anything is
// sent the record is read again: a record that moved while the editor was open
// sends NOTHING, and the edit is offered again against the new values.

import Foundation
import Observation

// MARK: - core's autonomy arithmetic, carried over

/// `packages/core/src/actions.ts`: the four kinds, three modes, three levels,
/// and the one function that names what a change widens. Pure, and held to
/// core's own test cases (agents-view-tests.swift).
public enum AgentAutonomy {
    public static let kinds = ["dispatch", "task_update", "comment", "capture"]
    public static let modes = ["deny", "propose", "allow"]
    public static let levels = ["observe", "propose", "act_within_scope"]
    public static let defaultLevel = "observe"

    /// `LEVEL_CEILING`: the most a level allows any kind.
    static let ceiling: [String: String] = ["observe": "deny", "propose": "propose", "act_within_scope": "allow"]
    /// `ACTION_DEFAULTS`: what a level means with no per-kind entry.
    static let defaults: [String: [String: String]] = [
        "observe": ["dispatch": "deny", "task_update": "deny", "comment": "deny", "capture": "deny"],
        "propose": ["dispatch": "propose", "task_update": "propose", "comment": "propose", "capture": "propose"],
        "act_within_scope": ["dispatch": "propose", "task_update": "allow", "comment": "allow", "capture": "allow"],
    ]

    /// The two keys of `agents.autonomy` core's arithmetic reads.
    public struct Record: Sendable, Equatable {
        public var level: String?
        public var actions: [String: String]

        public init(level: String? = nil, actions: [String: String] = [:]) {
            self.level = level
            self.actions = actions
        }

        /// A stored record as the console coerces it: a key it does not know is
        /// dropped — never widened, never guessed at.
        public init(json: JSONValue?) {
            let level = json?["level"]?.stringValue
            self.level = level.flatMap { AgentAutonomy.levels.contains($0) ? $0 : nil }
            var actions: [String: String] = [:]
            if case .object(let raw)? = json?["actions"] {
                for (kind, mode) in raw {
                    if AgentAutonomy.kinds.contains(kind), let m = mode.stringValue, AgentAutonomy.modes.contains(m) { actions[kind] = m }
                }
            }
            self.actions = actions
        }

        public var effectiveLevel: String { level ?? AgentAutonomy.defaultLevel }
    }

    static func modeRank(_ mode: String) -> Int { modes.firstIndex(of: mode) ?? 0 }
    static func levelRank(_ level: String) -> Int { levels.firstIndex(of: level) ?? 0 }

    /// `effectiveActions`: every kind, the lower of its entry and the level's ceiling.
    public static func effective(_ record: Record) -> [String: String] {
        let level = record.effectiveLevel
        let top = ceiling[level] ?? "deny"
        var out: [String: String] = [:]
        for kind in kinds {
            let asked = record.actions[kind] ?? defaults[level]?[kind] ?? "deny"
            out[kind] = modeRank(asked) > modeRank(top) ? top : asked
        }
        return out
    }

    /// `autonomyWidenings(prev, next)`, word for word: the level rising, then
    /// every kind whose EFFECTIVE mode rises. Empty is a narrowing or a no-op.
    public static func widenings(_ prev: Record, _ next: Record) -> [String] {
        var out: [String] = []
        let before = prev.effectiveLevel
        let after = next.effectiveLevel
        if levelRank(after) > levelRank(before) { out.append("level \(before) → \(after)") }
        let was = effective(prev)
        let now = effective(next)
        for kind in kinds {
            let a = was[kind] ?? "deny", b = now[kind] ?? "deny"
            if modeRank(b) > modeRank(a) { out.append("actions.\(kind) \(a) → \(b)") }
        }
        return out
    }

    /// The level as the owner reads it.
    public static func levelLabel(_ level: String) -> String {
        switch level {
        case "observe": return "Observe"
        case "propose": return "Propose"
        case "act_within_scope": return "Act Within Scope"
        default: return level
        }
    }

    /// The kind as the owner reads it — the permissions table's own words.
    public static func kindLabel(_ kind: String) -> String {
        switch kind {
        case "dispatch": return "Dispatch"
        case "task_update": return "Update"
        case "comment": return "Comment"
        case "capture": return "Capture"
        default: return kind
        }
    }
}

// MARK: - Reach: the grant, the projects, the query axis

/// What an external agent may read: `agents.grants` and `agents.projects`.
public struct AgentReach: Sendable, Equatable {
    /// `none · index · areas` — said `none · titles · folders` (core's TIER_LABEL).
    public var tier: String
    public var areas: [String]
    public var queries: Bool
    public var projects: [String]

    public static let tiers = ["none", "index", "areas"]

    public init(tier: String = "none", areas: [String] = [], queries: Bool = false, projects: [String] = []) {
        self.tier = tier
        self.areas = areas
        self.queries = queries
        self.projects = projects
    }

    public init(_ record: AgentRecord) {
        let tier = record.grantTier ?? "none"
        self.tier = Self.tiers.contains(tier) ? tier : "none"
        self.areas = record.grantAreas
        self.queries = record.grants?["queries"]?.boolValue == true
        self.projects = record.projects ?? []
    }

    /// core's TIER_LABEL.
    public static func tierLabel(_ tier: String) -> String {
        switch tier {
        case "none": return "None"
        case "index": return "Titles"
        case "areas": return "Folders"
        default: return tier
        }
    }

    /// The folders this reach actually reads: only an `areas` tier holds any.
    var effectiveAreas: [String] { tier == "areas" ? areas : [] }

    /// What `next` reaches that `prev` did not, in the same `key a → b` shape
    /// core's `autonomyWidenings` speaks — so one confirm lists both.
    public static func widenings(_ prev: AgentReach, _ next: AgentReach) -> [String] {
        var out: [String] = []
        let rank = { (t: String) in tiers.firstIndex(of: t) ?? 0 }
        if rank(next.tier) > rank(prev.tier) { out.append("tier \(prev.tier) → \(next.tier)") }
        let held = prev.effectiveAreas
        for area in next.effectiveAreas where !held.contains(where: { area == $0 || area.hasPrefix($0 + "/") }) {
            out.append("areas + \(area)")
        }
        if next.queries && !prev.queries { out.append("queries off → on") }
        for project in next.projects where !prev.projects.contains(project) {
            out.append("projects + \(project)")
        }
        return out
    }
}

// MARK: - The roster

/// `agent_presence`'s five states, said (screen 7 §2.1): two filled, one
/// hollow with no word, and only the two that are wrong take `degraded`.
public enum AgentPresenceMark: String, Sendable, Equatable {
    case working, queued, interrupted, overCap = "over-cap", idle
    /// Not in presence — the registry lists it and the query does not (a row
    /// that has not been read yet, or a console older than the query).
    case unknown

    public init(state: String?) {
        self = state.flatMap(AgentPresenceMark.init(rawValue:)) ?? .unknown
    }

    public var isFilled: Bool { self == .working || self == .queued }
    public var isWrong: Bool { self == .interrupted || self == .overCap }

    /// The word beside the dot. Idle carries none at all.
    public var word: String? {
        switch self {
        case .working: return "working"
        case .queued: return "queued"
        case .interrupted: return "interrupted"
        case .overCap: return "over its cap"
        case .idle, .unknown: return nil
        }
    }

    /// What VoiceOver says in the row — idle is still said, because a hollow
    /// dot is a shape, not a word (§2.18.3).
    public var spoken: String { word ?? (self == .idle ? "idle" : "presence not known") }
}

public enum AgentKind: String, Sendable, Equatable {
    /// Defined by the owner: a crew, a markdown file in the vault.
    case yours
    /// Authenticated in with a token: someone else's code.
    case connected
}

public struct AgentRosterRow: Sendable, Equatable, Identifiable {
    public let id: String
    public let kind: AgentKind
    /// The four words that carry the taxonomy (screen 7 §2).
    public let whatItIs: String
    public let presence: AgentPresenceMark
    /// *6m* — since it last ran or was seen; `—` for never.
    public let time: String
    public let pending: Bool

    /// One sentence: who, what, whether it is working, when.
    public var spoken: String {
        var parts = [id, whatItIs, presence.spoken]
        parts.append(time == AgentWords.never ? "never seen" : "\(time) ago")
        return parts.joined(separator: ", ")
    }
}

/// A revoked credential — a fact about the past, drawn `absent`, never `failed`.
public struct AgentRevokedRow: Sendable, Equatable, Identifiable {
    public let id: String
    public let displayName: String?
}

public struct AgentRoster: Sendable, Equatable {
    public var yours: [AgentRosterRow] = []
    public var connected: [AgentRosterRow] = []
    public var revoked: [AgentRevokedRow] = []

    public var isEmpty: Bool { yours.isEmpty && connected.isEmpty && revoked.isEmpty }
    public var ids: [String] { yours.map(\.id) + connected.map(\.id) }

    /// Is this row the assistant's own? By kind, and by the principal id the
    /// console gives it — either is enough (C52).
    public static func isAssistant(_ record: AgentRecord) -> Bool {
        record.kind == "internal" || record.id == AgentChipModel.assistantPrincipal
    }

    public static func build(
        registry: AgentList,
        presence: AgentPresenceList?,
        routines: [AgentRoutine],
        assistantName: String?,
        now: Date
    ) -> AgentRoster {
        var roster = AgentRoster()
        let states = Dictionary((presence?.rows ?? []).map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        for record in registry.agents.sorted(by: { $0.id < $1.id }) where !isAssistant(record) {
            if record.revoked {
                roster.revoked.append(AgentRevokedRow(id: record.id, displayName: record.displayName))
                continue
            }
            let kind: AgentKind = record.kind == "crew" ? .yours : .connected
            let own = routines.filter { $0.actor == record.id }
            let presenceRow = states[record.id]
            let lastRun = own.compactMap { WireTime.date($0.lastRunAt) }.max()
            let lastSeen = WireTime.date(presenceRow?.lastSeenAt ?? record.lastSeenAt)
            let when = [lastRun, lastSeen].compactMap { $0 }.max()
            let row = AgentRosterRow(
                id: record.id,
                kind: kind,
                whatItIs: kind == .yours ? yoursLine(own, assistantName: assistantName) : connectedLine(record),
                presence: AgentPresenceMark(state: presenceRow?.state),
                time: when.map { ActivityTime.short(now.timeIntervalSince($0)) } ?? AgentWords.never,
                pending: record.pending
            )
            if kind == .yours { roster.yours.append(row) } else { roster.connected.append(row) }
        }
        return roster
    }

    /// Yours: names its routine, or says it runs when delegated to, or `paused`
    /// and nothing else — a paused agent has no schedule to report.
    static func yoursLine(_ routines: [AgentRoutine], assistantName: String?) -> String {
        guard !routines.isEmpty else { return AgentWords.whenDelegated(assistantName) }
        let live = routines.filter { !$0.paused }
        guard let first = live.first else { return AgentWords.paused }
        let more = live.count > 1 ? " +\(live.count - 1)" : ""
        return "\(first.describe) · \(first.title)\(more)"
    }

    /// Connected: who it is, then its project — or what it was granted.
    static func connectedLine(_ record: AgentRecord) -> String {
        if record.pending { return AgentWords.waitingForApproval }
        let who = record.displayName ?? AgentWords.external
        let projects = record.projects ?? []
        if !projects.isEmpty { return "\(who) · \(projects.joined(separator: ", "))" }
        return "\(who) · \(AgentWords.reachSummary(AgentReach(record)))"
    }
}

// MARK: - The routines that name an actor (D3)

/// A routine from `GET /api/scheduled` whose `actor` is an agent.
public struct AgentRoutine: Sendable, Equatable, Identifiable {
    public let name: String
    public let title: String
    public let actor: String
    /// *fri at 15:00* — the Scheduled model's own sentence.
    public let describe: String
    public let paused: Bool
    /// Why the runner keeps it without running it, verbatim.
    public let held: String?
    public let nextRun: String?
    public let lastRunAt: String?
    public let lastRunOK: Bool?
    public let lastRunCost: Double?

    public var id: String { name }

    public static func from(_ list: ScheduledList?) -> [AgentRoutine] {
        (list?.json["routines"]?.arrayValue ?? []).compactMap { r in
            guard let name = r["name"]?.stringValue, let actor = r["actor"]?.stringValue, !actor.isEmpty else { return nil }
            let paused = r["paused"]?["value"]?.boolValue ?? r["paused"]?.boolValue ?? false
            return AgentRoutine(
                name: name,
                title: r["title"]?.stringValue ?? name,
                actor: actor,
                describe: r["describe"]?.stringValue ?? "",
                paused: paused,
                held: r["held"]?.stringValue,
                nextRun: r["next_run"]?.stringValue,
                lastRunAt: r["last_run"]?["at"]?.stringValue,
                lastRunOK: r["last_run"]?["ok"]?.boolValue,
                lastRunCost: r["last_run"]?["cost_usd"]?.doubleValue
            )
        }
    }
}

// MARK: - A definition

/// `GET /api/agents/:id/definition` for a crew, read.
public struct AgentDefinitionReading: Sendable, Equatable {
    public let area: String?
    public let description: String?
    public let prompt: String
    /// The file an edit is made against, instance-relative (or the release's).
    public let path: String?
    public let origin: String?
    public let sha256: String?
    /// `provider/model`, or `same_as_assistant`, or nil (the router — the assistant's own).
    public let model: String?
    public let effort: String?
    public let maxTurns: Int?
    public let budgetUSDPerRun: Double?

    public init(_ body: AgentDefinition) {
        let d = body.json["definition"]
        let file = d?["files"]?.arrayValue?.first
        area = d?["area"]?.stringValue
        description = d?["description"]?.stringValue
        prompt = d?["prompt"]?.stringValue ?? ""
        path = file?["path"]?.stringValue
        origin = file?["origin"]?.stringValue
        sha256 = file?["sha256"]?.stringValue
        let compute = body.json["compute"]
        switch compute?["kind"]?.stringValue {
        case "model": model = compute?["ref"]?.stringValue
        case AgentModelChoice.sameAsDefaultWire: model = AgentModelChoice.sameAsDefaultWire
        default: model = nil
        }
        effort = compute?["effort"]?.stringValue
        maxTurns = body.json["limits"]?["maxTurns"]?.intValue
        budgetUSDPerRun = body.json["limits"]?["budgetUsdPerRun"]?.doubleValue
    }

    public init(area: String?, description: String?, prompt: String, path: String?, origin: String? = "instance", sha256: String?, model: String?, effort: String?, maxTurns: Int? = nil, budgetUSDPerRun: Double? = nil) {
        self.area = area
        self.description = description
        self.prompt = prompt
        self.path = path
        self.origin = origin
        self.sha256 = sha256
        self.model = model
        self.effort = effort
        self.maxTurns = maxTurns
        self.budgetUSDPerRun = budgetUSDPerRun
    }
}

/// One entry in the one model dropdown (C128, C132): a model the owner's
/// compute already names, or the default model.
public struct AgentModelChoice: Sendable, Equatable, Identifiable, Hashable {
    /// The wire's value for *Same as* the assistant's default tier model — a
    /// crew frontmatter spelling (`same_as_assistant`), never a label.
    public static let sameAsDefaultWire = "same_as_assistant"

    /// `provider/model`, or `sameAsDefaultWire`.
    public let value: String
    public let label: String

    public var id: String { value }

    public static func sameAsDefault(_ assistantName: String?) -> AgentModelChoice {
        AgentModelChoice(value: sameAsDefaultWire, label: assistantName.map { "Same as \($0)" } ?? "Same as the default model")
    }

    /// Every model `GET /api/compute` names — an assignment's, or one a
    /// provider already serves — with its provider, once each; then the
    /// definition's own when the list does not hold it, so the dropdown never
    /// shows a value it cannot say.
    public static func options(compute: ConsoleCompute?, current: String?, assistantName: String?) -> [AgentModelChoice] {
        var out = [sameAsDefault(assistantName)]
        var seen: Set<String> = [sameAsDefaultWire]
        func add(_ provider: String, _ model: String) {
            let value = "\(provider)/\(model)"
            guard seen.insert(value).inserted else { return }
            out.append(AgentModelChoice(value: value, label: "\(model) — \(provider)"))
        }
        for a in compute?.facts.assignments ?? [] { add(a.provider, a.model) }
        for p in compute?.facts.providers ?? [] { for m in p.modelsAssigned { add(p.name, m) } }
        if let current, !seen.contains(current) {
            let parts = current.split(separator: "/", maxSplits: 1).map(String.init)
            out.append(AgentModelChoice(value: current, label: parts.count == 2 ? "\(parts[1]) — \(parts[0])" : current))
        }
        return out
    }
}

/// The definition editor's contents — what `metistry agents define` writes.
public struct DefinitionDraft: Sendable, Equatable {
    public let agentID: String
    /// The hash the edit is made against (`--if-sha256`).
    public var baseSHA: String?
    public var prompt: String
    public var description: String
    public var model: String
    public var effort: String
    /// What was read, so Save sends only what changed.
    public let original: AgentDefinitionReading

    public init(agentID: String, reading: AgentDefinitionReading) {
        self.agentID = agentID
        self.baseSHA = reading.sha256
        self.prompt = reading.prompt
        self.description = reading.description ?? ""
        self.model = reading.model ?? AgentModelChoice.sameAsDefaultWire
        self.effort = reading.effort ?? ComputeEffort.low.rawValue
        self.original = reading
    }

    public var isChanged: Bool { !changeArguments.isEmpty }

    /// The flags for what changed, in `define`'s own spelling. The prompt is
    /// never among them: it goes on standard input (`--prompt-file -`).
    var changeArguments: [String] {
        var args: [String] = []
        if model != (original.model ?? AgentModelChoice.sameAsDefaultWire) { args += ["--model", model] }
        if effort != (original.effort ?? ComputeEffort.low.rawValue) { args += ["--effort", effort] }
        if description != (original.description ?? "") { args += ["--description", description] }
        if prompt.trimmingCharacters(in: .whitespacesAndNewlines) != original.prompt.trimmingCharacters(in: .whitespacesAndNewlines) { args += ["--prompt-file", "-"] }
        return args
    }

    /// The whole `metistry agents define` command; nil when nothing changed.
    public var command: ManagementCommand? {
        let change = changeArguments
        guard !change.isEmpty else { return nil }
        var args = ["agents", "define", agentID] + change
        if let baseSHA { args += ["--if-sha256", baseSHA] }
        args.append("--json")
        return ManagementCommand(.agentDefinitions, args, standardInput: change.contains("--prompt-file") ? prompt : nil)
    }
}

// MARK: - Editing reach and autonomy

/// The permissions editor: an external agent's grant, projects and autonomy.
public struct AccessDraft: Sendable, Equatable {
    public let agentID: String
    public var reach: AgentReach
    public var autonomy: AgentAutonomy.Record
    /// What the editor was opened against — the comparison for "it moved".
    public var base: AgentReach
    public var baseAutonomy: AgentAutonomy.Record
    /// The record's other autonomy keys (§4.21), carried through the PUT
    /// untouched: the route REPLACES the record.
    public var baseAutonomyJSON: JSONValue?

    public init(_ record: AgentRecord) {
        agentID = record.id
        reach = AgentReach(record)
        base = reach
        autonomy = AgentAutonomy.Record(json: record.autonomy)
        baseAutonomy = autonomy
        baseAutonomyJSON = record.autonomy
    }

    /// Everything this edit widens: reach first, then autonomy in core's words.
    public var widenings: [String] {
        AgentReach.widenings(base, reach) + AgentAutonomy.widenings(baseAutonomy, autonomy)
    }

    public var changesGrants: Bool { reach.tier != base.tier || reach.effectiveAreas != base.effectiveAreas || reach.queries != base.queries }
    public var changesProjects: Bool { reach.projects != base.projects }
    public var changesAutonomy: Bool { autonomy != baseAutonomy }
    public var isChanged: Bool { changesGrants || changesProjects || changesAutonomy }

    /// The PUT body: `level` and `actions` from the editor, every other key
    /// as it was read.
    public var autonomyUpdate: AgentAutonomyUpdate {
        let old = baseAutonomyJSON
        return AgentAutonomyUpdate(
            level: autonomy.level,
            actions: autonomy.actions.isEmpty ? nil : autonomy.actions,
            maxOpenBundles: old?["max_open_bundles"]?.intValue,
            mayDispatchTo: old?["may_dispatch_to"]?.arrayValue?.compactMap(\.stringValue),
            acceptFrom: old?["accept_from"]?.arrayValue?.compactMap(\.stringValue)
        )
    }
}

/// Asked before a widening goes: core's strings, verbatim, and *Widen*.
public struct WideningConfirmation: Sendable, Equatable {
    public let draft: AccessDraft
    public let confirmation: CostConfirmation

    init?(_ draft: AccessDraft) {
        let lines = draft.widenings
        guard let c = CostConfirmation(
            title: "Widen \(draft.agentID)'s Access?",
            costHeading: "This gives \(draft.agentID) more room:",
            costs: lines,
            confirm: AgentWords.widen,
            destructive: false
        ) else { return nil }
        self.draft = draft
        self.confirmation = c
    }
}

// MARK: - New Agent (C138)

/// New Agent first asks which kind — three, each leading somewhere.
public enum NewAgentKind: String, CaseIterable, Sendable, Identifiable {
    /// A crew: a markdown file, blank or from one the owner has (`agents define`, M12).
    case local
    /// Another agent service over A2A or ACP, added as a connection (M13).
    case connectAgent
    /// Claude Code, Cursor, OpenCode — a token minted here (`POST /api/agents`, reach `local`).
    case tool

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .local: return "A Local Agent"
        case .connectAgent: return "Connect an Agent"
        case .tool: return "A Tool That Works for You"
        }
    }

    public var sentence: String {
        switch self {
        case .local: return "An agent is a markdown file describing how it should work. Start blank or from one you have."
        case .connectAgent: return "Another agent service, over A2A or ACP, added as a connection in Settings › Connections."
        case .tool: return "Claude Code, Cursor, OpenCode — it gets a token here, and nothing else gives it one."
        }
    }

    /// Why a remote client cannot take this path, or nil. Every one of them
    /// changes the boundary — a file, a connection, a credential (§2.3).
    public func unavailableBecause(isLocalClient: Bool) -> String? {
        isLocalClient ? nil : AgentWords.onlyTheMac
    }
}

/// Registering a tool: the bearer crosses the wire once, in the answer.
public struct RegistrationDraft: Sendable, Equatable {
    public var id = ""
    public var displayName = ""
    public var remote = false

    public init() {}

    /// `^[a-z][a-z0-9-]{0,39}$` — the console's own rule, said before sending.
    public var idProblem: String? { AgentWords.idProblem(id) }
    public var isSendable: Bool { idProblem == nil && !displayName.trimmingCharacters(in: .whitespaces).isEmpty }
}

/// A new local agent: `agents define <id> --area --model --prompt-file -`.
public struct NewLocalAgentDraft: Sendable, Equatable {
    public var id = ""
    public var area = ""
    public var description = ""
    public var model = AgentModelChoice.sameAsDefaultWire
    public var effort = ComputeEffort.low.rawValue
    public var prompt = ""
    /// The agent it started from, when not blank.
    public var template: String?

    public init() {}

    public var idProblem: String? { AgentWords.idProblem(id) }
    public var areaProblem: String? {
        area.range(of: #"^[a-z][a-z0-9-]*$"#, options: .regularExpression) == nil ? "The area is lowercase kebab-case — the folder under .metistry/agents/." : nil
    }
    public var isSendable: Bool { idProblem == nil && areaProblem == nil && !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    public var command: ManagementCommand? {
        guard isSendable else { return nil }
        var args = ["agents", "define", id, "--area", area, "--model", model, "--effort", effort]
        let text = description.trimmingCharacters(in: .whitespaces)
        if !text.isEmpty { args += ["--description", text] }
        args += ["--prompt-file", "-", "--json"]
        return ManagementCommand(.agentDefinitions, args, standardInput: prompt)
    }
}

// MARK: - Words

public enum AgentWords {
    public static let title = "Agents"
    public static let newAgent = "New Agent"
    public static let yours = "Yours"
    public static let connected = "Connected"
    public static let revoked = "Revoked"
    public static let never = "—"
    public static let paused = "paused"
    public static let external = "external"
    public static let widen = "Widen"
    public static let waitingForApproval = "waiting for you to approve"
    public static let versionedInTheVault = "versioned in the vault"
    public static let onlyTheMac = "Only the Mac that runs Metistry can do this."
    public static let editOnTheMac = "The definition is edited on the Mac that runs Metistry."
    public static let giveItOne = "Give It One"

    public static func whenDelegated(_ assistantName: String?) -> String {
        assistantName.map { "when \($0) delegates" } ?? "when delegated to"
    }

    /// Said once, next to the editor (screen 7 §3.1): invariant 2, plainly.
    public static func neverWrites(_ assistantName: String?) -> String {
        let who = assistantName ?? "Nothing Metistry runs"
        return "Only you write this file. \(who) can never change how its own delegates work."
    }

    public static func reachSummary(_ reach: AgentReach) -> String {
        switch reach.tier {
        case "areas": return reach.areas.count == 1 ? "1 folder" : "\(reach.areas.count) folders"
        case "index": return "titles"
        default: return "nothing granted"
        }
    }

    public static func idProblem(_ id: String) -> String? {
        id.range(of: #"^[a-z][a-z0-9-]{0,39}$"#, options: .regularExpression) == nil
            ? "An id is lowercase letters, digits and dashes, starting with a letter — at most 40."
            : nil
    }

    /// C42, in the words screen 7 §4 draws.
    public static func ceiling(_ c: AgentAccessCeiling) -> String {
        let asked = c.declines == 2 ? "twice" : c.declines == 1 ? "once" : "\(c.declines) times"
        let declined = c.declines == 2 ? "declined both" : c.declines == 1 ? "declined it" : "declined all \(c.declines)"
        var line = "Asked \(asked) for \(c.area) · \(declined) · it can no longer ask"
        if c.hits > 0 { line += " (refused \(c.hits == 1 ? "once" : "\(c.hits) times") since)" }
        return line
    }

    public static func nothingScheduled(_ id: String) -> String { "Nothing is scheduled for \(id)." }
    public static func draftKept(_ id: String) -> String { "Draft of \(id) kept" }
    public static let changedWhileOpen = "The record changed while the editor was open. Nothing was sent — these are its new values, and your edit is offered again against them."
}

// MARK: - A read that belongs to one agent

public enum AgentRead<Value: Sendable & Equatable>: Sendable, Equatable {
    case loading
    case loaded(Value)
    /// Nothing is there to read — a definition file that is missing. Not a fault.
    case absent(String)
    case failed(String)

    public var value: Value? {
        if case .loaded(let v) = self { return v }
        return nil
    }
}

// MARK: - The model

@MainActor
@Observable
public final class AgentsModel {
    /// How long the roster may go unrefreshed before its header says how old it is.
    public static let ageLimit: TimeInterval = 120

    /// `GET /api/agents` — every row, the revoked ones and the ceiling included.
    public let registry: SectionModel<AgentList>
    /// `agent_presence` — the five computed states and today's spend.
    public let presence: SectionModel<AgentPresenceList>
    /// `GET /api/scheduled` — which routines name which agent (D3).
    public let scheduled: SectionModel<ScheduledList>
    /// `GET /api/compute` — the models the dropdown offers (C128).
    public let compute: SectionModel<ConsoleCompute>

    /// The roster's selection.
    public var selection: String?
    /// The agent open in detail; nil is the roster.
    public private(set) var openID: String?
    public var showsRevoked = false

    public private(set) var definitions: [String: AgentRead<AgentDefinitionReading>] = [:]
    public private(set) var runs: [String: AgentRead<[ActivityFeedRow]>] = [:]

    /// The definition editor, when open.
    public var editor: DefinitionDraft?
    /// Esc keeps a draft (C136): by agent, until saved or discarded.
    public private(set) var drafts: [String: DefinitionDraft] = [:]
    /// *Draft of collator kept* — until the owner opens it or leaves.
    public private(set) var keptDraft: String?
    public private(set) var isSaving = false
    /// The CLI's own words when a save was refused.
    public private(set) var saveProblem: String?

    /// The permissions editor, when open.
    public var access: AccessDraft?
    public private(set) var widening: WideningConfirmation?
    /// Why the editor is showing new values (a 409, or a record that moved).
    public private(set) var accessNotice: String?
    public private(set) var accessProblem: String?

    public private(set) var revokeConfirmation: CostConfirmation?
    public private(set) var rotateConfirmation: CostConfirmation?
    /// A token, shown once: register or rotate answered it. Never stored.
    public private(set) var credential: AgentCredential?
    /// What the last act said — a refusal verbatim, or what it did.
    public private(set) var notice: String?

    public var isChoosingNewAgent = false
    public var registration: RegistrationDraft?
    public var newLocal: NewLocalAgentDraft?

    /// The pasteboard is the app's; the kit is handed it.
    @ObservationIgnored public var copyText: (@MainActor (String) -> Void)?
    @ObservationIgnored public var now: @MainActor () -> Date
    @ObservationIgnored public let clock: ClockTime
    @ObservationIgnored private weak var session: ConsoleSession?

    public init(session: ConsoleSession, timeZone: TimeZone = .current, now: @escaping @MainActor () -> Date = { Date() }) {
        self.session = session
        self.now = now
        self.clock = ClockTime(timeZone: timeZone)
        registry = SectionModel(session: session, policy: .requests, topics: [.presence]) { stores in
            await stores.agents().map { ($0, nil) }
        }
        presence = SectionModel(session: session, policy: .presence, topics: [.presence]) { stores in
            await stores.agentPresence(limit: nil).map { ($0, WireTime.date($0.asOf)) }
        }
        scheduled = SectionModel(session: session, policy: .configuration, topics: [.scheduled]) { stores in
            await stores.scheduled().map { ($0, WireTime.date($0["as_of"]?.stringValue)) }
        }
        compute = SectionModel(session: session, policy: .configuration, topics: [.usage]) { stores in
            await stores.compute().map { ($0, WireTime.date($0.asOf)) }
        }
        session.register { [weak self] in
            guard let self else { return false }
            self.reset()
            return true
        }
    }

    // MARK: Where this client stands

    /// This is the Mac that runs Metistry: it has the management verbs.
    /// Editing a definition, registering and rotating are drawn only here.
    public var isLocalClient: Bool { session?.management != nil }
    public var allowsDecisions: Bool { session?.allowsDecisions ?? false }
    public var decisionsUnavailableReason: String? { session?.decisionsUnavailableReason }

    // MARK: Reading

    public func refreshIfDue() async {
        await registry.refreshIfDue(now: now())
        await presence.refreshIfDue(now: now())
        await scheduled.refreshIfDue(now: now())
    }

    public func load() async {
        await registry.refresh(background: registry.section.hasValue)
        await presence.refresh(background: presence.section.hasValue)
        await scheduled.refresh(background: scheduled.section.hasValue)
    }

    public var routines: [AgentRoutine] { AgentRoutine.from(scheduled.section.value) }

    public func roster(assistantName: String?) -> AgentRoster? {
        guard let list = registry.section.value else { return nil }
        return AgentRoster.build(registry: list, presence: presence.section.value, routines: routines, assistantName: assistantName, now: now())
    }

    public func record(_ id: String) -> AgentRecord? {
        registry.section.value?.agents.first { $0.id == id }
    }

    public func presenceRow(_ id: String) -> AgentPresence? {
        presence.section.value?.rows.first { $0.id == id }
    }

    public func routines(of id: String) -> [AgentRoutine] { routines.filter { $0.actor == id } }

    public func ceilings(of id: String) -> [AgentAccessCeiling] {
        (registry.section.value?.accessCeilings ?? []).filter { $0.agent == id }
    }

    /// What the roster panel is: the first load, a failure with nothing to
    /// show (never drawn empty — nothing is known), or the list and whether
    /// it is stale.
    public enum Panel: Sendable, Equatable {
        case placeholders(String?)
        case failed(StatePanelModel)
        case roster(staleSince: Date?)
    }

    public var panel: Panel {
        let at = now()
        let s = registry.section
        switch FirstPaint.paint(s, loadingSince: s.isFirstLoad ? s.lastAttemptAt : nil, ageLimit: Self.ageLimit, waitingFor: "the registry", now: at) {
        case .placeholders(let waiting):
            return .placeholders(waiting)
        case .failed(let why):
            return .failed(StatePanelModel(.failed, title: "Couldn't Load Agents", sentence: "Nothing is known about them until the registry answers.", reason: why, action: StateWords.tryAgain))
        case .content(let registryStale):
            // Presence is a snapshot: its age rides the header, and the rows
            // keep their last values.
            var stale = registryStale
            if presence.section.hasValue, case .content(let since?) = FirstPaint.paint(presence.section, loadingSince: nil, ageLimit: Self.ageLimit, waitingFor: "", now: at) {
                stale = min(stale ?? since, since)
            }
            return .roster(staleSince: stale)
        }
    }

    // MARK: Opening and going back

    public func open(_ id: String) async {
        guard record(id) != nil else { return }
        selection = id
        openID = id
        keptDraft = nil
        notice = nil
        credential = nil
        await readDetail(id)
    }

    /// Esc from detail: back to the roster, the selection where it was.
    public func back() {
        if let editor { abandonEdit(editor) }
        openID = nil
        access = nil
        widening = nil
        revokeConfirmation = nil
        rotateConfirmation = nil
        credential = nil
    }

    func readDetail(_ id: String) async {
        guard let session, let record = record(id) else { return }
        let generation = session.generation
        if record.kind == "crew" {
            if definitions[id]?.value == nil { definitions[id] = .loading }
            let answer = await session.stores.agentDefinition(id)
            guard session.generation == generation else { return }
            switch answer {
            case .success(let body):
                if body.json["definition"] == nil || body.json["definition"] == .null {
                    definitions[id] = .absent(Self.manifestPath(record) ?? id)
                } else {
                    definitions[id] = .loaded(AgentDefinitionReading(body))
                }
            case .failure(let error):
                // A crew whose manifest is not loaded answers 404: the file is
                // not there. That is absent — nothing broke (screen 7 §6).
                if case .http(404, _) = error {
                    definitions[id] = .absent(Self.manifestPath(record) ?? ".metistry/agents/…/\(id).md")
                } else {
                    definitions[id] = .failed(error.localizedDescription)
                }
            }
            if compute.section.value == nil { await compute.refresh() }
        }
        if runs[id]?.value == nil { runs[id] = .loading }
        let feed = await session.stores.activityFeed(hours: 24 * 7, limit: 10, kind: nil, project: nil, agent: id, since: nil, turnID: nil)
        guard session.generation == generation else { return }
        switch feed {
        // the query filters by actor already; a console older than `agent`
        // would not, and another agent's rows must never read as this one's
        case .success(let f): runs[id] = .loaded(Array(f.rows.filter { $0.actor == id }.prefix(10)))
        case .failure(let error): runs[id] = .failed(error.localizedDescription)
        }
    }

    /// The manifest path the registry says a crew came from.
    static func manifestPath(_ record: AgentRecord) -> String? {
        record.scope?["source"]?["manifest"]?.stringValue
    }

    // MARK: The definition (M12)

    /// The editor is drawn only on the Mac that runs Metistry, for a crew
    /// whose file was read.
    public func canEditDefinition(_ id: String) -> Bool {
        isLocalClient && record(id)?.kind == "crew" && definitions[id]?.value != nil
    }

    public func beginEdit(_ id: String) {
        guard canEditDefinition(id), let reading = definitions[id]?.value else { return }
        keptDraft = nil
        saveProblem = nil
        if let draft = drafts[id], draft.original == reading {
            editor = draft
        } else {
            editor = DefinitionDraft(agentID: id, reading: reading)
        }
    }

    /// Esc: the editor closes and what was typed is kept (C136).
    public func abandonEdit(_ draft: DefinitionDraft) {
        if draft.isChanged {
            drafts[draft.agentID] = draft
            keptDraft = draft.agentID
        } else {
            drafts[draft.agentID] = nil
        }
        editor = nil
        saveProblem = nil
    }

    public func discardDraft(_ id: String) {
        drafts[id] = nil
        if keptDraft == id { keptDraft = nil }
        if editor?.agentID == id { editor = nil }
    }

    /// Save: `metistry agents define` with the prompt on standard input,
    /// against the hash it was read at. A file that moved is refused by the
    /// CLI (`stale: …`), read again, and the edit offered against it.
    public func saveDefinition() async {
        guard let draft = editor, let runner = session?.management else { return }
        guard let command = draft.command else {
            editor = nil
            drafts[draft.agentID] = nil
            return
        }
        isSaving = true
        saveProblem = nil
        defer { isSaving = false }
        let result: CommandResult
        do {
            result = try await runner.run(command) { _ in }
        } catch {
            saveProblem = error.localizedDescription
            return
        }
        if result.ok {
            drafts[draft.agentID] = nil
            editor = nil
            notice = "Saved \(draft.original.path ?? draft.agentID) — \(AgentWords.versionedInTheVault)."
            definitions[draft.agentID] = nil
            await readDetail(draft.agentID)
            return
        }
        let words = Self.cliWords(result)
        saveProblem = words
        if words.hasPrefix("stale:") {
            // The file moved: read it again and offer the edit against it.
            await readDetail(draft.agentID)
            if let fresh = definitions[draft.agentID]?.value {
                var again = DefinitionDraft(agentID: draft.agentID, reading: fresh)
                again.prompt = draft.prompt
                again.description = draft.description
                again.model = draft.model
                again.effort = draft.effort
                editor = again
            }
        }
    }

    /// The CLI's refusal, verbatim: its last non-empty stderr line, or stdout's.
    static func cliWords(_ result: CommandResult) -> String {
        let lines = (result.stderr + "\n" + result.stdout).split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        let text = lines.first { $0.hasPrefix("stale:") } ?? lines.last ?? "metistry agents define exited \(result.exitCode)"
        return text.hasPrefix("error: ") ? String(text.dropFirst(7)) : text
    }

    public func modelChoices(current: String?, assistantName: String?) -> [AgentModelChoice] {
        AgentModelChoice.options(compute: compute.section.value, current: current, assistantName: assistantName)
    }

    // MARK: Reach and autonomy (external agents)

    /// The permissions editor is on a connected agent only: a crew's reach is
    /// its definition, edited in the file by hand (`agents define` keeps every
    /// line it does not own).
    public func canEditAccess(_ id: String) -> Bool {
        guard let r = record(id) else { return false }
        return r.kind == "external" && !r.revoked
    }

    public func beginAccessEdit(_ id: String) {
        guard canEditAccess(id), let r = record(id) else { return }
        access = AccessDraft(r)
        accessNotice = nil
        accessProblem = nil
    }

    public func cancelAccessEdit() {
        access = nil
        widening = nil
        accessNotice = nil
        accessProblem = nil
    }

    /// Commit. Read the record again first: if it moved, NOTHING is sent and
    /// the edit is offered against the new values. A narrowing goes at once; a
    /// widening waits for *Widen*.
    public func commitAccess() async {
        guard let draft = access, allowsDecisions else { return }
        accessProblem = nil
        guard draft.isChanged else {
            cancelAccessEdit()
            return
        }
        guard await recordIsUnchanged(draft) else { return }
        if let confirm = WideningConfirmation(draft) {
            widening = confirm
            return
        }
        await send(draft)
    }

    public func confirmWidening() async {
        guard let pending = widening else { return }
        widening = nil
        guard await recordIsUnchanged(pending.draft) else { return }
        await send(pending.draft)
    }

    public func cancelWidening() {
        widening = nil
    }

    /// The compare half of a compare-and-set the route does not offer: the
    /// record is read again, and an edit made against an older one is not sent.
    private func recordIsUnchanged(_ draft: AccessDraft) async -> Bool {
        await registry.refresh(background: true)
        guard let fresh = record(draft.agentID), !fresh.revoked else {
            accessProblem = "\(draft.agentID) was revoked while the editor was open. Nothing was sent."
            return false
        }
        let now = AccessDraft(fresh)
        if now.base == draft.base && now.baseAutonomy == draft.baseAutonomy && now.baseAutonomyJSON == draft.baseAutonomyJSON { return true }
        offerAgain(draft, against: fresh)
        return false
    }

    private func offerAgain(_ draft: AccessDraft, against fresh: AgentRecord) {
        var again = AccessDraft(fresh)
        again.reach = draft.reach
        again.autonomy = draft.autonomy
        access = again
        accessNotice = AgentWords.changedWhileOpen
    }

    private func send(_ draft: AccessDraft) async {
        guard let stores = session?.stores else { return }
        if draft.changesGrants {
            let r = draft.reach
            switch await stores.setGrants(draft.agentID, tier: r.tier, areas: r.tier == "areas" ? r.areas : [], queries: r.queries) {
            case .success: break
            case .failure(let error): return await refused(error, draft)
            }
        }
        if draft.changesProjects {
            switch await stores.setProjects(draft.agentID, draft.reach.projects) {
            case .success: break
            case .failure(let error): return await refused(error, draft)
            }
        }
        if draft.changesAutonomy {
            switch await stores.setAutonomy(draft.agentID, draft.autonomyUpdate) {
            case .success: break
            case .failure(let error): return await refused(error, draft)
            }
        }
        access = nil
        accessNotice = nil
        await registry.refresh(background: true)
    }

    private func refused(_ error: ConsoleError, _ draft: AccessDraft) async {
        if case .http(409, _) = error {
            await registry.refresh(background: true)
            if let fresh = record(draft.agentID) { offerAgain(draft, against: fresh) }
            return
        }
        accessProblem = error.localizedDescription
        await registry.refresh(background: true)
    }

    // MARK: Revoke, rotate, approve

    /// The cascade, stated before the button (screen 7 §5).
    public func askToRevoke(_ id: String) {
        guard let r = record(id), !r.revoked else { return }
        let approved = (r.permissions ?? []).flatMap { $0.read + $0.write }.filter {
            if case .approved = $0.provenance { return true }
            return false
        }.map(\.label)
        var costs = ["Its token stops working at once. A revoked credential can't be restored."]
        costs.append("Anything it asked for that you haven't answered is settled.")
        costs.append(approved.isEmpty
            ? "Grant overrides go with it — it has none now."
            : "The access you approved in Needs You goes with it: \(approved.joined(separator: ", ")).")
        revokeConfirmation = CostConfirmation(title: "Revoke \(id)?", costHeading: "Revoking \(id):", costs: costs, confirm: "Revoke", destructive: true)
    }

    public func cancelRevoke() { revokeConfirmation = nil }

    public func confirmRevoke() async {
        guard revokeConfirmation != nil, let id = openID, let stores = session?.stores else { return }
        revokeConfirmation = nil
        switch await stores.revokeAgent(id) {
        case .success:
            notice = "Revoked \(id)."
            await registry.refresh(background: true)
            await presence.refresh(background: true)
        case .failure(let error):
            notice = error.localizedDescription
        }
    }

    public func askToRotate(_ id: String) {
        guard isLocalClient, let r = record(id), r.kind == "external", !r.revoked else { return }
        rotateConfirmation = CostConfirmation(
            title: "Rotate \(id)'s Token?",
            costHeading: "A new token is made now:",
            costs: ["The one \(id) holds stops working at once — give it the new one."],
            confirm: "Rotate Token",
            destructive: true
        )
    }

    public func cancelRotate() { rotateConfirmation = nil }

    public func confirmRotate() async {
        guard rotateConfirmation != nil, let id = openID, let stores = session?.stores else { return }
        rotateConfirmation = nil
        switch await stores.rotateAgent(id) {
        case .success(let credential): self.credential = credential
        case .failure(let error): notice = error.localizedDescription
        }
    }

    public func approve(_ id: String) async {
        guard let stores = session?.stores else { return }
        switch await stores.approveAgent(id) {
        case .success: notice = "Approved \(id). It can authenticate now; it still holds no reach until you grant some."
        case .failure(let error): notice = error.localizedDescription
        }
        await registry.refresh(background: true)
    }

    /// The token was copied or the owner closed it: it is gone from the app.
    public func dismissCredential() { credential = nil }

    public func copyCredential() {
        guard let token = credential?.token else { return }
        copyText?(token)
    }

    // MARK: Run Now (C138)

    /// Run Now on an agent: its one routine. With none it is dimmed with the
    /// reason, and *Give It One* leads to Scheduled; with several, each runs
    /// from its own row.
    public func runNowControl(_ id: String) -> ControlSpec {
        let own = routines(of: id)
        if own.isEmpty { return ControlSpec("Run Now", role: .secondary, disabledBecause: AgentWords.nothingScheduled(id)) }
        if own.count > 1 { return ControlSpec("Run Now", role: .secondary, disabledBecause: "\(own.count) routines assign \(id) work — run one below.") }
        if !allowsDecisions { return ControlSpec("Run Now", role: .secondary, disabledBecause: decisionsUnavailableReason ?? StateWords.unreachable) }
        return ControlSpec("Run Now", role: .secondary, shortcut: ShellCommand.runNow.shortcut?.glyphs, name: "Run \(own[0].title) Now")
    }

    public func runNow(_ id: String) async {
        let own = routines(of: id)
        guard own.count == 1 else { return }
        await run(own[0])
    }

    public func run(_ routine: AgentRoutine) async {
        guard let stores = session?.stores, allowsDecisions else { return }
        switch await stores.runNow(routine: routine.name) {
        case .success(let reply):
            if reply["started"]?.boolValue == true {
                notice = "\(routine.title) started."
            } else {
                notice = reply["refused"]?.stringValue ?? reply["refused"]?["message"]?.stringValue ?? "\(routine.title) did not start."
            }
            await scheduled.refresh(background: true)
        case .failure(let error):
            notice = error.localizedDescription
        }
    }

    // MARK: New Agent

    public func chooseNewAgent(_ kind: NewAgentKind) {
        guard kind.unavailableBecause(isLocalClient: isLocalClient) == nil else { return }
        isChoosingNewAgent = false
        switch kind {
        case .local:
            newLocal = NewLocalAgentDraft()
            Task { if compute.section.value == nil { await compute.refresh() } }
        case .tool: registration = RegistrationDraft()
        case .connectAgent: break  // the view leads to Settings › Connections
        }
    }

    /// The local agents a new one can start from.
    public var templates: [String] {
        (registry.section.value?.agents ?? []).filter { $0.kind == "crew" && !$0.revoked }.map(\.id).sorted()
    }

    public func startFrom(_ template: String?) async {
        guard var draft = newLocal else { return }
        draft.template = template
        guard let template, let session else {
            newLocal = draft
            return
        }
        if case .success(let body) = await session.stores.agentDefinition(template) {
            let reading = AgentDefinitionReading(body)
            draft.prompt = reading.prompt
            draft.area = reading.area ?? draft.area
            draft.model = reading.model ?? draft.model
            draft.effort = reading.effort ?? draft.effort
        }
        newLocal = draft
    }

    public private(set) var isCreating = false
    public private(set) var createProblem: String?

    public func createLocal() async {
        guard let draft = newLocal, let command = draft.command, let runner = session?.management else { return }
        isCreating = true
        createProblem = nil
        defer { isCreating = false }
        do {
            let result = try await runner.run(command) { _ in }
            if result.ok {
                newLocal = nil
                notice = "Wrote .metistry/agents/\(draft.area)/\(draft.id).md — \(AgentWords.versionedInTheVault). It is listed here once the console next reads its agents, within five minutes."
                await registry.refresh(background: true)
            } else {
                createProblem = Self.cliWords(result)
            }
        } catch {
            createProblem = error.localizedDescription
        }
    }

    public private(set) var registrationProblem: String?

    public func register() async {
        guard let draft = registration, draft.isSendable, isLocalClient, let stores = session?.stores else { return }
        registrationProblem = nil
        let body = AgentRegistration(id: draft.id, displayName: draft.displayName.trimmingCharacters(in: .whitespaces), kind: "external", remote: draft.remote)
        switch await stores.registerAgent(body) {
        case .success(let credential):
            registration = nil
            self.credential = credential
            await registry.refresh(background: true)
        case .failure(let error):
            registrationProblem = error.localizedDescription
        }
    }

    // MARK: The keys (C119)

    /// What the selection offers the Item menu: ↩ opens the selected row; in
    /// detail, ⌘R runs its one routine.
    public var itemActions: ShellActionTable {
        var table: ShellActionTable = [:]
        if openID == nil, let id = selection, record(id) != nil {
            table[.open] = { [weak self] in Task { await self?.open(id) } }
        }
        if let id = openID, runNowControl(id).isEnabled, record(id)?.kind == "crew" {
            table[.runNow] = { [weak self] in Task { await self?.runNow(id) } }
        }
        return table
    }

    // MARK: Instance switch

    func reset() {
        selection = nil
        openID = nil
        definitions = [:]
        runs = [:]
        editor = nil
        drafts = [:]
        keptDraft = nil
        access = nil
        widening = nil
        revokeConfirmation = nil
        rotateConfirmation = nil
        credential = nil
        notice = nil
        registration = nil
        newLocal = nil
        isChoosingNewAgent = false
    }
}

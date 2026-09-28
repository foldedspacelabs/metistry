// Projects — the model (design-build-plan T6-8; screen-13-projects.md, C83,
// C94). The view is projects-view.swift.
//
// WHAT A PROJECT IS. A view over agents, work, artifacts and runs plus one
// small row of the owner's decisions — the mode, the daily budget, the handoff
// cap and, since 0032, the project's own read grant. Projects appear on first
// use (migration 0011), so there is no New Project: the empty list leads to
// the Board (plan §1.4).
//
// THE MODE USES THE CHANNELS HONESTLY (C83). Autonomous is a quiet outline.
// Review the owner chose takes WEIGHT — a heavier outline and the review
// mark — because it matters more and nothing is wrong. Only Review the budget
// forced takes the TINT, because that one is a fault. Why a project is in
// review is the console's `last_mode_change` (a `project_mode` run is the
// budget's flip, a `project_admin` run the owner's toggle), read and never
// inferred from the spend: a project over its budget the owner then set
// back to Autonomous and into Review again is a choice, not a fault.
//
// JOINING IS A GRANT (D13, T4-7). Every member inherits the project's own read
// grant; the door unions it per request. So the permissions section draws the
// project's grant as *every member gets these*, each member shows only what
// it holds BEYOND it, and adding an agent confirms exactly what it will
// inherit. The instance's own agent is different: an internal row with no
// project list is a member of every project in the rollup, and inherits
// nothing from any of them — its reach is its configuration (C52). It is not
// counted among a project's agents and is drawn apart, saying so.
//
// WHAT IS NOT DECIDED HERE. What an agent may do is `core`'s
// `describePermissions`, carried on `GET /api/agents` and read, never
// recomputed; the project's grant is drawn in the words `core` gives the same
// lines (*Titles only*, *Named queries*). The only comparison made here is
// which of a member's lines the project already holds — to leave them out.

import Foundation
import Observation

// MARK: - A project, as the console serves it

/// A project's own read grant (0032) — `{tier, areas, queries?}`, the same
/// envelope an agent's grant is.
public struct ProjectGrant: Sendable, Equatable {
    /// `none`, `index` or `areas`. Anything else is read as `none`, as `core`
    /// reads a stored grant (fail closed).
    public let tier: String
    public let areas: [String]
    public let queries: Bool

    public init(tier: String = "none", areas: [String] = [], queries: Bool = false) {
        self.tier = ["none", "index", "areas"].contains(tier) ? tier : "none"
        self.areas = self.tier == "areas" ? areas : []
        self.queries = queries
    }

    init(json: JSONValue?) {
        self.init(
            tier: json?.string("tier") ?? "none",
            areas: json?["areas"]?.arrayValue?.compactMap(\.stringValue) ?? [],
            queries: json?["queries"]?.boolValue ?? false
        )
    }

    /// Grants nothing a member could read.
    public var isEmpty: Bool { rows.isEmpty }

    /// The grant as the permissions table's rows, in `core`'s words and order:
    /// Knowledge (an area verbatim, *The whole vault*, or *Titles only*), then
    /// Queries (*Named queries*). Read only — a project grants no writes.
    public var rows: [PermissionRow] {
        var rows: [PermissionRow] = []
        let knowledge: [PermissionEntry]
        switch tier {
        case "index": knowledge = [PermissionEntry(key: "titles", label: ProjectsWords.titlesOnly)]
        case "areas": knowledge = areas.map { $0 == "/" ? PermissionEntry(key: "/", label: ProjectsWords.wholeVault) : PermissionEntry(key: $0, label: $0) }
        default: knowledge = []
        }
        if !knowledge.isEmpty { rows.append(PermissionRow(resource: PermissionResource(kind: "knowledge"), label: "Knowledge", read: knowledge)) }
        if queries {
            rows.append(PermissionRow(resource: PermissionResource(kind: "queries"), label: "Queries", read: [PermissionEntry(key: "named", label: ProjectsWords.namedQueries)]))
        }
        return rows
    }
}

/// The last time the mode moved, and who moved it.
public struct ProjectModeChange: Sendable, Equatable {
    public let at: Date?
    /// `user` — the owner's toggle — or what flipped it (`budget`).
    public let by: String
    public let reason: String
    /// `autonomous` or `review`.
    public let to: String

    public init(at: Date?, by: String, reason: String, to: String) {
        self.at = at
        self.by = by
        self.reason = reason
        self.to = to
    }

    init?(json: JSONValue?) {
        guard let json, let to = json.string("to") else { return nil }
        self.init(at: WireTime.date(json.string("ts")), by: json.string("by") ?? "", reason: json.string("reason") ?? "", to: to)
    }
}

public struct ProjectRecord: Sendable, Equatable, Identifiable {
    public let id: String
    public let title: String?
    /// The vault folder the project lives in, when one is set.
    public let area: String?
    /// `autonomous` or `review`, as stored.
    public let mode: String
    public let dailyBudgetUSD: Double?
    /// How many handoffs may be in flight at once.
    public let maxOpenBundles: Int
    /// The rollup's members — agents whose projects include it, and an
    /// internal agent with no project list (a member of every project).
    public let members: [String]
    public let openTasks: Int
    public let bundlesInFlight: Int
    public let bundlesQueued: Int
    public let openThreads: Int
    public let pendingReviews: Int
    public let spendTodayUSD: Double
    public let lastActivity: Date?
    public let lastModeChange: ProjectModeChange?
    public let grants: ProjectGrant

    public init(
        id: String, title: String? = nil, area: String? = nil, mode: String = "autonomous", dailyBudgetUSD: Double? = nil,
        maxOpenBundles: Int = 20, members: [String] = [], openTasks: Int = 0, bundlesInFlight: Int = 0, bundlesQueued: Int = 0,
        openThreads: Int = 0, pendingReviews: Int = 0, spendTodayUSD: Double = 0, lastActivity: Date? = nil,
        lastModeChange: ProjectModeChange? = nil, grants: ProjectGrant = ProjectGrant()
    ) {
        self.id = id
        self.title = title
        self.area = area
        self.mode = mode
        self.dailyBudgetUSD = dailyBudgetUSD
        self.maxOpenBundles = maxOpenBundles
        self.members = members
        self.openTasks = openTasks
        self.bundlesInFlight = bundlesInFlight
        self.bundlesQueued = bundlesQueued
        self.openThreads = openThreads
        self.pendingReviews = pendingReviews
        self.spendTodayUSD = spendTodayUSD
        self.lastActivity = lastActivity
        self.lastModeChange = lastModeChange
        self.grants = grants
    }

    init?(json: JSONValue) {
        guard let id = json.string("id") else { return nil }
        self.init(
            id: id,
            title: json.string("title"),
            area: json.string("area"),
            mode: json.string("mode") ?? "autonomous",
            dailyBudgetUSD: Self.number(json["daily_budget_usd"]),
            maxOpenBundles: Int(Self.number(json["max_open_bundles"]) ?? 20),
            members: json["members"]?.arrayValue?.compactMap(\.stringValue) ?? [],
            openTasks: Int(Self.number(json["open_tasks"]) ?? 0),
            bundlesInFlight: Int(Self.number(json["bundles_in_flight"]) ?? 0),
            bundlesQueued: Int(Self.number(json["bundles_queued"]) ?? 0),
            openThreads: Int(Self.number(json["open_threads"]) ?? 0),
            pendingReviews: Int(Self.number(json["pending_reviews"]) ?? 0),
            spendTodayUSD: Self.number(json["spend_today_usd"]) ?? 0,
            lastActivity: WireTime.date(json.string("last_activity")),
            lastModeChange: ProjectModeChange(json: json["last_mode_change"]),
            grants: ProjectGrant(json: json["grants"])
        )
    }

    /// `GET /api/projects`' `projects`, in the console's order (last activity first).
    static func list(_ json: JSONValue) -> [ProjectRecord] {
        (json["projects"]?.arrayValue ?? []).compactMap(ProjectRecord.init(json:))
    }

    /// A Postgres numeric can cross the wire as a string; a count as a number.
    static func number(_ v: JSONValue?) -> Double? {
        if let d = v?.doubleValue { return d }
        if let s = v?.stringValue { return Double(s) }
        return nil
    }

    /// What the owner calls it: the title, else the slug.
    public var name: String { title ?? id }
}

// MARK: - The mode, and why

/// Autonomous, Review the owner chose, or Review the budget forced (C83).
public enum ProjectMode: Sendable, Equatable {
    case autonomous
    /// The owner's choice — weight, never tint. `since` when the change is known.
    case review(since: Date?)
    /// The budget put it here — the one case that takes the tint.
    case overBudget(since: Date?)

    public init(_ p: ProjectRecord) {
        guard p.mode == "review" else {
            self = .autonomous
            return
        }
        guard let change = p.lastModeChange, change.to == "review" else {
            // In review with no change on record — set when the row was made:
            // someone's choice, never a fault.
            self = .review(since: nil)
            return
        }
        // The console's own words for the budget's flip (projects.ts: a
        // `project_mode` run is `by: <reason>`; the owner's toggle is `by: user`).
        self = change.by != "user" && change.reason == "budget" ? .overBudget(since: change.at) : .review(since: change.at)
    }

    public var isReview: Bool { self != .autonomous }
    /// The wire's word.
    public var wire: String { isReview ? "review" : "autonomous" }
}

/// The chip, decided: its words, its mark, and which channel it uses. The
/// view draws exactly this, so a test reads the channel off the value.
public struct ProjectModeChip: Sendable, Equatable {
    public let text: String
    public let glyph: MetistryGlyph?
    public let glyphInk: MetistryColorRole?
    public let ink: MetistryColorRole
    public let weight: TypeWeight
    /// The quiet plate, when it paints one.
    public let plate: MetistryColorRole?
    public let outline: MetistryColorRole
    /// 1 for a quiet outline, 2 for the weight channel's heavier one.
    public let outlineWidth: Double
    public let spoken: String

    /// Every role that says *something is wrong* (amendments §1.1: the tint is
    /// for the four states and nothing merely notable).
    public static let tints: Set<MetistryColorRole> = [
        .ok, .okQuiet, .degraded, .degradedQuiet, .failed, .failedQuiet, .stale, .staleQuiet,
        .presenceBlocked, .presenceBlockedQuiet, .presenceInterruptedQuiet, .presenceOverCapQuiet,
    ]

    /// Whether any part of the chip is painted in a state's colour.
    public var isTinted: Bool {
        [glyphInk, ink, plate, outline].contains { $0.map(Self.tints.contains) ?? false }
    }

    public init(_ mode: ProjectMode) {
        switch mode {
        case .autonomous:
            text = ProjectsWords.autonomous
            glyph = nil
            glyphInk = nil
            ink = .textSecondary
            weight = .medium
            plate = nil
            outline = .borderControl
            outlineWidth = 1
            spoken = ProjectsWords.autonomous
        case .review:
            text = ProjectsWords.review
            glyph = .reviewMode
            glyphInk = .textPrimary
            ink = .textPrimary
            weight = .semibold
            plate = nil
            // A mark that carries meaning takes an ink token, never a border
            // token (amendments §1.2): the heavier outline is text-primary.
            outline = .textPrimary
            outlineWidth = 2
            spoken = ProjectsWords.review
        case .overBudget:
            text = "\(ProjectsWords.review) · \(ProjectsWords.overBudget)"
            glyph = .degraded
            glyphInk = .degraded
            ink = .textPrimary
            weight = .semibold
            plate = .degradedQuiet
            outline = .degraded
            outlineWidth = 1
            spoken = "\(ProjectsWords.review), \(ProjectsWords.overBudget)"
        }
    }
}

// MARK: - Money

/// Today's spend against the day's budget: a line, and a bar that turns
/// `degraded` at the budget — a budget reached is a fault, so it takes the tint.
public struct ProjectSpend: Sendable, Equatable {
    public let spent: Double
    public let budget: Double?

    public init(spent: Double, budget: Double?) {
        self.spent = spent
        self.budget = budget
    }

    public var isOver: Bool { budget.map { spent >= $0 } ?? false }
    /// 0…1 of the budget; nil with no budget to fill against.
    public var fraction: Double? {
        guard let budget else { return nil }
        guard budget > 0 else { return 1 }
        return min(max(spent / budget, 0), 1)
    }
    public var barInk: MetistryColorRole { isOver ? .degraded : .accent }

    /// *$1.20 of $5 today*, or *$0.00 today · no budget*.
    public var line: String {
        let amount = UsageGauge.dollars(spent)
        guard let budget else { return "\(amount) today · \(ProjectsWords.noBudget)" }
        return "\(amount) of \(ProjectsWords.money(budget)) today"
    }

    public var spoken: String { isOver ? "\(line), \(ProjectsWords.overBudget)" : line }
}

// MARK: - A member, beyond the project

/// One member of a project, as the Agents section draws it.
public struct ProjectMember: Sendable, Equatable, Identifiable {
    public enum Reach: Sendable, Equatable {
        /// Exactly what the project gives, and nothing more.
        case projectOnly
        /// What it holds beyond the project, with each line's provenance.
        case beyond([PermissionEntry])
        /// Its record is not in the registry the app last read.
        case unknown
    }

    public let id: String
    public let name: String
    public let kind: String?
    public let reach: Reach

    public init(id: String, name: String, kind: String?, reach: Reach) {
        self.id = id
        self.name = name
        self.kind = kind
        self.reach = reach
    }

    /// *+ Areas/Finance · Named queries*, or *project access only*.
    public var line: String {
        switch reach {
        case .projectOnly: return ProjectsWords.projectAccessOnly
        case .unknown: return ProjectsWords.notInRegistry
        case .beyond(let entries):
            return "+ " + entries.map { e in e.provenance.marker.map { "\(e.label) (\($0))" } ?? e.label }.joined(separator: " · ")
        }
    }

    public var spoken: String { "\(name), \(line)" }

    /// The resources a project's grant can hold; a member's other lines are
    /// its own tools on the project's work, not access beyond the project.
    static let grantResources: Set<String> = ["knowledge", "queries"]

    /// What `agent` holds, on the lines a project grant speaks to, that
    /// `project` does not already give it — its own areas, its approvals,
    /// another project's grant. Entries inherited from THIS project are the
    /// project's, and so are entries the project's grant already names.
    static func beyond(_ agent: AgentRecord, in project: ProjectRecord) -> Reach {
        guard let rows = agent.permissions else { return .unknown }
        let given = Set(project.grants.rows.flatMap { row in row.read.map { "\(row.resource.kind)|\($0.key)" } })
        var extra: [PermissionEntry] = []
        for row in rows where grantResources.contains(row.resource.kind) {
            for entry in row.read {
                if case .project(let slug) = entry.provenance, slug == project.id { continue }
                if given.contains("\(row.resource.kind)|\(entry.key)") { continue }
                extra.append(entry)
            }
        }
        return extra.isEmpty ? .projectOnly : .beyond(extra)
    }

    /// What joining would ADD for `agent`: the project's lines it does not
    /// already hold on its own. The union at the door keeps the member's own
    /// areas first and adds each project area they do not cover (T4-7), so an
    /// area under one it already reads adds nothing; *Titles only* adds
    /// nothing to a member that reads content; the queries flag adds nothing
    /// to a member that has it.
    static func inherits(_ agent: AgentRecord, from project: ProjectRecord) -> [PermissionRow] {
        let own = agent.permissions ?? []
        let ownAreas = own.first { $0.resource.kind == "knowledge" }?.read.map(\.key) ?? []
        let ownQueries = own.first { $0.resource.kind == "queries" }.map { !$0.read.isEmpty } ?? false
        func covered(_ area: String) -> Bool {
            ownAreas.contains { $0 == "/" || $0 == area || area.hasPrefix($0 + "/") }
        }
        var rows: [PermissionRow] = []
        for row in project.grants.rows {
            let read = row.read.filter { entry in
                switch row.resource.kind {
                case "knowledge": return entry.key == "titles" ? ownAreas.isEmpty : !covered(entry.key)
                case "queries": return !ownQueries
                default: return true
                }
            }
            if !read.isEmpty { rows.append(PermissionRow(resource: row.resource, label: row.label, read: read)) }
        }
        return rows
    }
}

// MARK: - A run, in the project's recent list

public struct ProjectRun: Sendable, Equatable, Identifiable {
    public let runID: Int
    public let at: Date?
    public let actor: String?
    public let what: String
    /// False only where the run failed.
    public let ok: Bool?
    public var id: Int { runID }

    init?(_ row: ActivityFeedRow) {
        guard let runID = row.runID else { return nil }
        self.runID = runID
        at = WireTime.date(row.ts)
        actor = row.actor
        what = [row.subject, row.detail].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " · ")
        ok = row.ok
    }
}

// MARK: - The confirmations (screen 13 §4)

/// What a confirmation does once confirmed.
public enum ProjectAct: Sendable, Equatable {
    case setMode(project: String, to: String)
    /// The agent's projects, the new one appended — `PUT` replaces the list.
    case addAgent(project: String, agent: String, projects: [String])
}

public struct ProjectConfirmation: Sendable, Equatable, Identifiable {
    public let act: ProjectAct
    public let cost: CostConfirmation
    public var id: String { "\(act)" }
}

// MARK: - The model

@MainActor
@Observable
public final class ProjectsModel {
    public let projects: SectionModel<[ProjectRecord]>
    /// The registry: each member's kind and permissions (`GET /api/agents`).
    public let agents: SectionModel<[AgentRecord]>
    /// Blocked cards per project — the board's Blocked column, counted.
    public let blocked: SectionModel<[String: Int]>

    /// The list's selection; ↩ opens it.
    public var selection: String?
    /// The project on screen; nil is the list.
    public private(set) var opened: String?
    /// Each opened project's recent runs, as last read.
    public private(set) var runs: [String: ProjectsRead<[ProjectRun]>] = [:]
    /// A confirmation waiting for the owner.
    public var confirmation: ProjectConfirmation?
    /// What the last act did, or why it did not.
    public private(set) var notice: String?
    /// An act is on the wire.
    public private(set) var isActing = false

    @ObservationIgnored private weak var session: ConsoleSession?
    @ObservationIgnored public let now: () -> Date
    @ObservationIgnored public let clock: ClockTime

    /// How many recent runs a project shows.
    public static let recentRuns = 5
    /// Past this the list's spend is stale (components-03 §2: *Spend as of 40
    /// minutes ago* · Sync Now) — the rollup's spend moves with every call.
    public static let ageLimit: TimeInterval = 15 * 60

    public init(session: ConsoleSession, timeZone: TimeZone = .current, now: @escaping () -> Date = Date.init) {
        self.session = session
        self.now = now
        self.clock = ClockTime(timeZone: timeZone)
        projects = SectionModel(session: session, policy: .board, topics: [.board, .runs, .presence, .usage]) { stores in
            await stores.projects().map { (ProjectRecord.list($0.json), WireTime.date($0["as_of"]?.stringValue)) }
        }
        agents = SectionModel(session: session, policy: .configuration, topics: [.presence, .configuration]) { stores in
            await stores.agents().map { ($0.agents, nil) }
        }
        blocked = SectionModel(session: session, policy: .board, topics: [.board]) { stores in
            await stores.board(project: nil, limit: 200).map { board in
                var counts: [String: Int] = [:]
                for card in board.rows where card.column == "blocked" {
                    if let p = card.project { counts[p, default: 0] += 1 }
                }
                return (counts, WireTime.date(board.asOf))
            }
        }
        session.register { [weak self] in
            guard let self else { return false }
            self.selection = nil
            self.opened = nil
            self.runs = [:]
            self.confirmation = nil
            self.notice = nil
            return true
        }
    }

    // MARK: Reading

    public func refreshIfDue() async {
        await projects.refreshIfDue(now: now())
        await agents.refreshIfDue(now: now())
        await blocked.refreshIfDue(now: now())
    }

    /// Ask everything now (Try Again, Sync Now).
    public func load() async {
        await projects.refresh(background: projects.section.hasValue)
        await agents.refresh(background: agents.section.hasValue)
        await blocked.refresh(background: blocked.section.hasValue)
        if let opened { await readRuns(opened) }
    }

    public var list: [ProjectRecord] { projects.section.value ?? [] }

    public func project(_ id: String) -> ProjectRecord? { list.first { $0.id == id } }

    /// The list as a whole (C135): placeholders only on the very first load; a
    /// failure with nothing on screen is the failed panel; otherwise the list,
    /// with the stale band when it is old or its last refresh failed.
    public var paint: FirstPaint {
        FirstPaint.paint(projects.section, loadingSince: nil, ageLimit: Self.ageLimit, waitingFor: ProjectsWords.reading, now: now())
    }

    /// Blocked cards in a project; nil until the board has answered.
    public func blockedCount(_ id: String) -> Int? {
        blocked.section.value.map { $0[id] ?? 0 }
    }

    // MARK: Moving about

    public func open(_ id: String) async {
        guard project(id) != nil else { return }
        selection = id
        opened = id
        notice = nil
        await readRuns(id)
    }

    public func back() {
        opened = nil
        notice = nil
    }

    func readRuns(_ id: String) async {
        guard let session else { return }
        let generation = session.generation
        if runs[id] == nil { runs[id] = .waiting }
        let answer = await session.stores.activityFeed(hours: 24 * 7, limit: 50, kind: nil, project: id, agent: nil, since: nil, turnID: nil)
        guard session.generation == generation else { return }
        switch answer {
        case .success(let feed):
            runs[id] = .loaded(Array(feed.rows.compactMap(ProjectRun.init).prefix(Self.recentRuns)))
        case .failure(let e):
            if case .loaded = runs[id] { return }
            runs[id] = .failed(Self.problem(e))
        }
    }

    // MARK: The registry, per project

    /// Every member but the instance's own agent, with what it holds beyond
    /// the project. Without the registry, every member is listed by id.
    public func members(of p: ProjectRecord) -> [ProjectMember] {
        let registry = agents.section.value
        return p.members.compactMap { id in
            guard let registry else { return ProjectMember(id: id, name: id, kind: nil, reach: .unknown) }
            guard let agent = registry.first(where: { $0.id == id }) else { return ProjectMember(id: id, name: id, kind: nil, reach: .unknown) }
            if agent.kind == "internal" { return nil }
            return ProjectMember(id: id, name: agent.displayName ?? id, kind: agent.kind, reach: ProjectMember.beyond(agent, in: p))
        }
    }

    /// The instance's own agent, when the rollup lists it: a member of every
    /// project that inherits nothing from any.
    public func ownAgent(of p: ProjectRecord) -> AgentRecord? {
        agents.section.value?.first { p.members.contains($0.id) && $0.kind == "internal" }
    }

    /// The count the list shows: the agents that joined.
    public func agentCount(_ p: ProjectRecord) -> Int {
        members(of: p).count
    }

    /// The agents that may be added: connected agents, let in, not revoked,
    /// not already members. A crew's projects are its definition's, and the
    /// instance's own agent is in every project already.
    public func candidates(for p: ProjectRecord) -> [AgentRecord] {
        (agents.section.value ?? []).filter { a in
            a.kind == "external" && !a.revoked && !a.pending && !p.members.contains(a.id)
        }
    }

    // MARK: Acting

    public var allowsDecisions: Bool { session?.allowsDecisions ?? false }
    public var decisionsUnavailableReason: String? { session?.decisionsUnavailableReason }

    /// The toggle, asked: a confirmation naming what changes (§4). Nothing is
    /// sent until it is confirmed.
    public func requestMode(review: Bool, for p: ProjectRecord) {
        guard review != ProjectMode(p).isReview else { return }
        confirmation = Self.modeConfirmation(review: review, for: p)
    }

    public func requestAdd(_ agent: AgentRecord, to p: ProjectRecord) {
        confirmation = Self.addConfirmation(agent, to: p)
    }

    public func cancel() {
        confirmation = nil
    }

    /// Send what was confirmed. The row is read again either way: the list
    /// shows what the console says, never what was asked for.
    public func confirm() async {
        guard let pending = confirmation, let session else { return }
        confirmation = nil
        isActing = true
        defer { isActing = false }
        switch pending.act {
        case .setMode(let slug, let to):
            switch await session.stores.updateProject(slug, ProjectUpdate(mode: to)) {
            case .success:
                notice = to == "review" ? ProjectsWords.nowInReview(project(slug)?.name ?? slug) : ProjectsWords.nowAutonomous(project(slug)?.name ?? slug)
            case .failure(let e):
                notice = ProjectsWords.notChanged(Self.problem(e))
            }
        case .addAgent(let slug, let agent, let list):
            switch await session.stores.setProjects(agent, list) {
            case .success:
                notice = ProjectsWords.added(agents.section.value?.first { $0.id == agent }?.displayName ?? agent, to: project(slug)?.name ?? slug)
            case .failure(let e):
                notice = ProjectsWords.notAdded(Self.problem(e))
            }
            await agents.refresh(background: true)
        }
        await projects.refresh(background: true)
    }

    // MARK: The words of the confirmations

    nonisolated static func modeConfirmation(review: Bool, for p: ProjectRecord) -> ProjectConfirmation? {
        if review {
            let n = p.bundlesInFlight
            let cost = n > 0
                ? "\(n) \(n == 1 ? "handoff" : "handoffs") in flight will wait for you."
                : "Handoffs between its agents will come to you."
            guard let c = CostConfirmation(title: "Set \(p.name) to Review?", costHeading: ProjectsWords.whatChanges, costs: [cost], confirm: ProjectsWords.setToReview, destructive: false) else { return nil }
            return ProjectConfirmation(act: .setMode(project: p.id, to: "review"), cost: c)
        }
        // The destructive direction (§3.12, P3): trust goes back to every member.
        guard let c = CostConfirmation(title: "Set \(p.name) Back to Autonomous?", costHeading: ProjectsWords.whatChanges, costs: [ProjectsWords.backToAutonomous], confirm: ProjectsWords.setToAutonomous, destructive: true) else { return nil }
        return ProjectConfirmation(act: .setMode(project: p.id, to: "autonomous"), cost: c)
    }

    /// Joining is a grant, and this is the one place inheritance could hide
    /// one: the confirmation names exactly what the agent gains.
    nonisolated static func addConfirmation(_ agent: AgentRecord, to p: ProjectRecord) -> ProjectConfirmation? {
        let name = agent.displayName ?? agent.id
        var costs = ["\(p.name)'s tasks and artifacts, as far as its own permissions reach them"]
        let inherited = ProjectMember.inherits(agent, from: p)
        if inherited.isEmpty {
            costs.append(p.grants.isEmpty ? "Nothing to inherit — \(p.name) grants no reading of its own" : "Nothing more to inherit — it already reads what \(p.name) grants")
        } else {
            for row in inherited {
                costs.append("\(row.label), read: \(row.read.map(\.label).joined(separator: ", ")) — inherited from \(p.name)")
            }
        }
        guard let c = CostConfirmation(title: "Add \(name) to \(p.name)?", costHeading: "Joining is a grant. \(name) will reach:", costs: costs, confirm: ProjectsWords.addToProject, destructive: false) else { return nil }
        return ProjectConfirmation(act: .addAgent(project: p.id, agent: agent.id, projects: (agent.projects ?? []) + [p.id]), cost: c)
    }

    nonisolated static func problem(_ e: ConsoleError) -> String {
        e.refusal ?? e.localizedDescription
    }
}

/// One of the screen's own reads, in one of three states.
public enum ProjectsRead<Value: Sendable & Equatable>: Sendable, Equatable {
    case waiting
    case loaded(Value)
    case failed(String)

    public var value: Value? { if case .loaded(let v) = self { return v } else { return nil } }
}

// MARK: - The words

/// The screen's fixed words, in one place. No agent's name is here: the
/// instance's own agent is named from its row or the configured name.
public enum ProjectsWords {
    public static let title = "Projects"
    public static let autonomous = "Autonomous"
    public static let review = "Review"
    public static let overBudget = "over budget"
    public static let noBudget = "no budget"
    public static let reading = "Reading your projects"
    public static let back = "Projects"
    public static let whatChanges = "What changes:"
    public static let backToAutonomous = "Its agents will hand work to each other without you again."
    public static let setToReview = "Set to Review"
    public static let setToAutonomous = "Set to Autonomous"
    public static let addToProject = "Add to Project"
    public static let addAgent = "Add Agent"
    public static let raiseBudget = "Raise Budget"
    public static let syncNow = "Sync Now"
    public static let openBoard = "Open Board"
    public static let projectAccessOnly = "project access only"
    public static let notInRegistry = "not in the agent registry"
    public static let everyMemberGetsThese = "Every member gets these"
    public static let grantsNothing = "Nothing to read beyond its own work — members reach this project's tasks and artifacts, and inherit nothing else from it."
    public static let noMembers = "No agents have joined it."
    public static let noCandidates = "Every connected agent is already in it."
    public static let noRuns = "No runs in the last week."
    public static let titlesOnly = "Titles only"
    public static let wholeVault = "The whole vault"
    public static let namedQueries = "Named queries"

    // The section headings.
    public static let inFlight = "In Flight"
    public static let permissions = "Permissions"
    public static let agents = "Agents"
    public static let recentRuns = "Recent Runs"

    /// Components-03's Projects empty state, with plan §1.4's reading: projects
    /// appear on first use, so the way on is the Board, never New Project.
    public static let emptyTitle = "No projects yet"
    public static let emptySentence = "A project appears the first time a task, an agent or an artifact names one."

    /// `$5`, or `$2.50` — a budget as the owner set it.
    public static func money(_ value: Double) -> String { "$" + ComputeBudgetFacts.money(value) }

    /// *$5 a day · 20 handoffs at once*.
    public static func budgetLine(_ p: ProjectRecord) -> String {
        let budget = p.dailyBudgetUSD.map { "\(money($0)) a day" } ?? "No daily budget"
        return "\(budget) · \(p.maxOpenBundles) \(p.maxOpenBundles == 1 ? "handoff" : "handoffs") at once"
    }

    /// *review since 2:40 PM (over budget)*, *review since 27 Sep, 2:40 PM (you set it)*.
    public static func sinceLine(_ p: ProjectRecord, now: Date, clock: ClockTime) -> String? {
        switch ProjectMode(p) {
        case .overBudget(let since):
            return since.map { "review since \(clock.moment($0, now: now)) (\(overBudget))" } ?? "in review (\(overBudget))"
        case .review(let since):
            return since.map { "review since \(clock.moment($0, now: now)) (you set it)" }
        case .autonomous:
            guard let change = p.lastModeChange, change.to == "autonomous", let at = change.at else { return nil }
            return "autonomous since \(clock.moment(at, now: now))"
        }
    }

    /// §3, in one sentence: when, why, and what changed for the owner.
    public static func overBudgetSentence(_ p: ProjectRecord, now: Date, clock: ClockTime) -> String? {
        guard case .overBudget(let since) = ProjectMode(p) else { return nil }
        let budget = p.dailyBudgetUSD.map { "its \(money($0)) budget" } ?? "its budget"
        let when = since.map { " at \(clock.moment($0, now: now))" } ?? ""
        return "Went over \(budget)\(when). Handoffs between agents now come to you."
    }

    /// *4 open · 1 blocked*.
    public static func work(_ p: ProjectRecord, blocked: Int?) -> String {
        (["\(p.openTasks) open"] + (blocked.map { ["\($0) blocked"] } ?? [])).joined(separator: " · ")
    }

    /// *2 agents*.
    public static func agentCount(_ n: Int) -> String {
        n == 0 ? "No agents" : "\(n) \(n == 1 ? "agent" : "agents")"
    }

    /// *active 2 hours ago*.
    public static func lastActive(_ at: Date?, now: Date) -> String? {
        at.map { "active \(ClockTime.age(now.timeIntervalSince($0)))" }
    }

    /// The instance's own agent, on a project's page.
    public static func ownAgentLine(_ name: String) -> String {
        "\(name) works in every project on its own access. It inherits nothing from a project."
    }

    public static func nowInReview(_ name: String) -> String { "\(name) is in Review. Handoffs between its agents come to you." }
    public static func nowAutonomous(_ name: String) -> String { "\(name) is Autonomous." }
    public static func notChanged(_ why: String) -> String { "Not changed — \(why)" }
    public static func added(_ agent: String, to project: String) -> String { "\(agent) joined \(project)." }
    public static func notAdded(_ why: String) -> String { "Not added — \(why)" }
}

// The wire shape of `metistry doctor --json`, and nothing more.
//
// `packages/cli/src/doctor.ts` owns it: a `DoctorReport` is `as_of`,
// `product_dir`, `shape`, `ok` and one row per thing that can be wrong; every
// row is a `core` `CheckResult` (`packages/core/src/check.ts` — the frozen
// check() shape, review CRIT-2) plus a `kind`. The app decodes it and renders
// it. It does not compute health itself, and it never reaches Postgres or git
// to second-guess a row (invariant 3; "the app is a front end for the CLI").
//
// Decoding is deliberately STRICT about `status`: the four values are frozen,
// so a fifth one means the app and the CLI disagree about the contract, and
// saying so beats quietly colouring it grey (design-system P5 — state is
// reported, never inferred).

import Foundation

public enum CheckStatus: String, Codable, Sendable, CaseIterable {
    case ok
    case degraded
    case failed
    case absent
}

public extension CheckStatus {
    /// The label the Status panel and the menu bar print. `absent` reads as
    /// "not configured" everywhere in the product — it is a fact, not a fault
    /// (design-system §3.13).
    var label: String {
        switch self {
        case .ok: return "ok"
        case .degraded: return "degraded"
        case .failed: return "failed"
        case .absent: return "not configured"
        }
    }

    /// SF Symbol for the state glyph. Shape carries the meaning as well as
    /// colour, so the row is readable with Increase Contrast or colour-blind
    /// (design-system §6).
    var symbolName: String {
        switch self {
        case .ok: return "checkmark.circle.fill"
        case .degraded: return "exclamationmark.triangle.fill"
        case .failed: return "xmark.octagon.fill"
        case .absent: return "circle.dashed"
        }
    }

    var colorRole: MetistryColorRole {
        switch self {
        case .ok: return .ok
        case .degraded: return .degraded
        case .failed: return .failed
        case .absent: return .absent
        }
    }
}

public struct DoctorRow: Codable, Sendable, Identifiable, Equatable {
    public let name: String
    public let kind: String
    public let status: CheckStatus
    public let latencyMs: Double
    /// What was actually attempted and observed — a behavioural assertion, not
    /// a permission check (Phase 0 hard requirement 3).
    public let probe: String
    /// Human-actionable fix, present when the status is not `ok`.
    public let remediation: String?
    /// Whatever else the check reported. A different shape per row kind, so it
    /// is held as JSON and read through the typed accessors below rather than
    /// modelled per kind (json-value.swift explains why).
    public let meta: JSONValue?
    /// The fix doctor can NAME, as a button (T4-21): open Secrets, open System
    /// Settings, or run a verb. Absent when the row is `ok` or doctor has
    /// nothing more specific than `remediation` — never derived here by
    /// reading the prose.
    public let action: DoctorAction?
    /// Who puts the row right (X-123): doctor (`fixable`), the owner (`hand`),
    /// or nobody, because it is a fact (`info`). `nil` from a CLI older than
    /// the class, or one that sent a class this build does not know — and a row
    /// with no class is never offered to Fix All (P5: state is reported, never
    /// inferred, and never read off the remediation sentence).
    public let fix: FixClass?
    /// After a fix ran for this row: whether the re-check cleared it. `nil`
    /// when no fix ran for it.
    public let fixed: Bool?
    /// The fix doctor applies for a `fixable` row: what it does, and whether it
    /// asks first. The app shows it; the CLI decides and runs it.
    public let repair: DoctorRepair?

    public var id: String { "\(kind)/\(name)" }

    enum CodingKeys: String, CodingKey {
        case name, kind, status, probe, remediation, meta, action, fix, fixed, repair
        case latencyMs = "latency_ms"
    }

    public init(
        name: String,
        kind: String,
        status: CheckStatus,
        latencyMs: Double,
        probe: String,
        remediation: String? = nil,
        meta: JSONValue? = nil,
        action: DoctorAction? = nil,
        fix: FixClass? = nil,
        fixed: Bool? = nil,
        repair: DoctorRepair? = nil
    ) {
        self.name = name
        self.kind = kind
        self.status = status
        self.latencyMs = latencyMs
        self.probe = probe
        self.remediation = remediation
        self.meta = meta
        self.action = action
        self.fix = fix
        self.fixed = fixed
        self.repair = repair
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        kind = try c.decode(String.self, forKey: .kind)
        status = try c.decode(CheckStatus.self, forKey: .status)
        latencyMs = try c.decode(Double.self, forKey: .latencyMs)
        probe = try c.decode(String.self, forKey: .probe)
        remediation = try c.decodeIfPresent(String.self, forKey: .remediation)
        meta = try c.decodeIfPresent(JSONValue.self, forKey: .meta)
        // An action of a kind this build does not know is no button, never a
        // report that fails to decode: the row and its remediation still show.
        action = try? c.decodeIfPresent(DoctorAction.self, forKey: .action)
        // The same for the repair contract: a class or a repair this build does
        // not understand is a row Fix All leaves alone, not a failed report.
        fix = try? c.decodeIfPresent(FixClass.self, forKey: .fix)
        fixed = try? c.decodeIfPresent(Bool.self, forKey: .fixed)
        repair = try? c.decodeIfPresent(DoctorRepair.self, forKey: .repair)
    }

    /// A finding doctor can fix, and says how. Fix All is made of exactly these
    /// rows: an `ok` row has nothing to fix, a `hand` or `info` row is never
    /// run, and a `fixable` row with no `repair` has no named fix to show.
    public var isFixable: Bool { fix == .fixable && repair != nil && status != .ok }

    /// A finding only the owner can put right; the row says what to do.
    public var isYoursToDo: Bool { fix == .hand && status != .ok }
}

/// `packages/cli/src/doctor.ts`'s `FixClass` (X-123).
public enum FixClass: String, Codable, Sendable, Equatable {
    case fixable
    case hand
    case info
}

/// `packages/cli/src/doctor.ts`'s `Repair` (X-123): an entry of doctor's closed
/// table of fixes, as the row names it. The app never builds one and never
/// sends one back — it displays `does`, and the CLI door runs the table's own
/// function (`doctor --fix --yes --json`, M6).
public struct DoctorRepair: Codable, Sendable, Equatable {
    /// The table's id (`restart`, `migrate`, `render`, …). Held as text: an id
    /// this build does not know is still a fix to show, and the app never maps
    /// an id to anything to run.
    public let id: String
    /// What the fix acts on — the service name for `restart`.
    public let target: String?
    /// Moves files or restarts a running service: previewed and asked first.
    public let confirm: Bool
    /// One line: what applying it does.
    public let does: String

    public init(id: String, target: String? = nil, confirm: Bool, does: String) {
        self.id = id
        self.target = target
        self.confirm = confirm
        self.does = does
    }

    /// One run of the fix per id and target, however many rows asked for it —
    /// the CLI's own `fixKey`.
    public var key: String { target.map { "\(id):\($0)" } ?? id }
}

/// One entry of `doctor --fix --json`'s `fixes[]`: what ran for which rows,
/// how it went, and the statuses either side of the one re-check.
public struct DoctorFixRecord: Codable, Sendable, Equatable, Identifiable {
    /// The table's id, as `DoctorRepair.id`.
    public let repairID: String
    public let target: String?
    public let rows: [String]
    public let does: String
    public let confirm: Bool
    /// `fixed` · `applied` · `failed` · `declined` · `needs_confirm`.
    public let outcome: String
    /// Every command and action the fix ran, in order — the CLI's own ledger.
    public let steps: [String]
    public let error: String?
    public let before: [String: String]
    public let after: [String: String]?

    enum CodingKeys: String, CodingKey {
        case repairID = "id"
        case target, rows, does, confirm, outcome, steps, error, before, after
    }

    public init(
        repairID: String, target: String? = nil, rows: [String], does: String, confirm: Bool, outcome: String,
        steps: [String] = [], error: String? = nil, before: [String: String] = [:], after: [String: String]? = nil
    ) {
        self.repairID = repairID
        self.target = target
        self.rows = rows
        self.does = does
        self.confirm = confirm
        self.outcome = outcome
        self.steps = steps
        self.error = error
        self.before = before
        self.after = after
    }

    /// What the owner reads: the CLI's own outcome, said plainly. An outcome
    /// this build does not know is printed as it came.
    public var outcomeLabel: String {
        switch outcome {
        case "fixed": return "Fixed"
        case "applied": return "Ran — still failing"
        case "failed": return "Failed"
        case "declined": return "Not run"
        case "needs_confirm": return "Not run — waiting for a confirm"
        default: return outcome
        }
    }

    public var cleared: Bool { outcome == "fixed" }

    /// One per id and target, as the CLI runs them.
    public var id: String { target.map { "\(repairID):\($0)" } ?? repairID }
}

/// `packages/cli/src/doctor.ts`'s `DoctorAction` (T4-21). `command` is argv
/// beginning with `metistry`, never a shell string; doctor never appends
/// `--yes`, so the app's own preview-then-confirm stands between the button
/// and any mutation.
public enum DoctorAction: Codable, Sendable, Equatable {
    case openSecrets(label: String)
    case openSystemSettings(label: String)
    case runVerb(command: [String], label: String)

    public var label: String {
        switch self {
        case .openSecrets(let label), .openSystemSettings(let label), .runVerb(_, let label): return label
        }
    }

    enum CodingKeys: String, CodingKey { case kind, label, command }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let label = try c.decode(String.self, forKey: .label)
        switch try c.decode(String.self, forKey: .kind) {
        case "open_secrets": self = .openSecrets(label: label)
        case "open_system_settings": self = .openSystemSettings(label: label)
        case "run_verb": self = .runVerb(command: try c.decode([String].self, forKey: .command), label: label)
        case let other:
            throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "unknown doctor action \(other)")
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(label, forKey: .label)
        switch self {
        case .openSecrets: try c.encode("open_secrets", forKey: .kind)
        case .openSystemSettings: try c.encode("open_system_settings", forKey: .kind)
        case .runVerb(let command, _):
            try c.encode("run_verb", forKey: .kind)
            try c.encode(command, forKey: .command)
        }
    }
}

public struct DoctorReport: Codable, Sendable, Equatable {
    public let asOf: String
    public let productDir: String
    /// Where this install's services run, from `deployment.yaml`
    /// (docs/ops/deployment-shapes.md). Every remediation below is written
    /// for this shape, so it belongs on screen.
    public let shape: String
    public let ok: Bool
    public let rows: [DoctorRow]
    /// `check` or `fix` (X-123); absent from a CLI that predates the modes.
    public let mode: String?
    /// A `fix` run only: what ran, in order, and how each went. The rows above
    /// are the re-check's — the rows as they are now.
    public let fixes: [DoctorFixRecord]?

    enum CodingKeys: String, CodingKey {
        case shape, ok, rows, mode, fixes
        case asOf = "as_of"
        case productDir = "product_dir"
    }

    public init(asOf: String, productDir: String, shape: String, ok: Bool, rows: [DoctorRow], mode: String? = nil, fixes: [DoctorFixRecord]? = nil) {
        self.asOf = asOf
        self.productDir = productDir
        self.shape = shape
        self.ok = ok
        self.rows = rows
        self.mode = mode
        self.fixes = fixes
    }

    public static func decode(from data: Data) throws -> DoctorReport {
        try JSONDecoder().decode(DoctorReport.self, from: data)
    }
}

public extension DoctorReport {
    func count(of status: CheckStatus) -> Int {
        rows.filter { $0.status == status }.count
    }

    /// The one-line summary the panel leads with, so the page answers before
    /// it is read (design-system §3.13).
    var summary: String {
        let parts = CheckStatus.allCases
            .map { ($0, count(of: $0)) }
            .filter { $0.1 > 0 }
            .map { "\($0.1) \($0.0.label)" }
        return parts.isEmpty ? "no checks" : parts.joined(separator: " · ")
    }

    /// The state the menu-bar glyph shows: the worst *fault* across
    /// components. `absent` never drives it — a Linux-only box with no
    /// apple-fm bridge is not a degraded install (docs/ops/cli.md, and it is
    /// why `absent` does not change doctor's exit code either).
    var worstFault: CheckStatus {
        if rows.contains(where: { $0.status == .failed }) { return .failed }
        if rows.contains(where: { $0.status == .degraded }) { return .degraded }
        return .ok
    }

    /// Rows grouped for display. Doctor's `kind` is the grouping the CLI's own
    /// table uses, and keeping it means a new component kind appears without
    /// a change here (invariant 5).
    var groupedByKind: [(kind: String, rows: [DoctorRow])] {
        var order: [String] = []
        var byKind: [String: [DoctorRow]] = [:]
        for row in rows {
            if byKind[row.kind] == nil { order.append(row.kind) }
            byKind[row.kind, default: []].append(row)
        }
        return order.map { (kind: $0, rows: byKind[$0] ?? []) }
    }
}

// MARK: - The two meta shapes the app has an opinion about

/// The `deployment` row's meta: this install's shape, which file it came from,
/// and every service with the shape it runs in (or `disabled`). This is how the
/// Services settings pane gets its list without the app parsing
/// `deployment.yaml` itself — `packages/cli/src/deployment.ts` resolves the D4
/// overlay (product `seed/` then the instance's own file), and the app reads its
/// answer.
public struct DeploymentFacts: Sendable, Equatable {
    public let shape: String
    /// e.g. `seed/deployment.yaml`, `<instance>/deployment.yaml`, or
    /// `METISTRY_DEPLOYMENT_SHAPE (overriding …)`.
    public let from: String
    /// service name → the shape it runs in, or `disabled`.
    public let services: [String: String]
    /// This instance's own labels and ports, when `metistry up --namespace`
    /// gave it some (`state/ports.yaml`). `nil` is the un-namespaced install:
    /// the product's default labels and ports, which the app does not copy.
    public let namespace: DeploymentNamespace?

    public init(shape: String, from: String, services: [String: String], namespace: DeploymentNamespace? = nil) {
        self.shape = shape
        self.from = from
        self.services = services
        self.namespace = namespace
    }

    public init?(row: DoctorRow) {
        guard let meta = row.meta, let shape = meta["shape"]?.stringValue else { return nil }
        self.shape = shape
        self.from = meta["from"]?.stringValue ?? "unknown"
        var services: [String: String] = [:]
        if case .object(let o)? = meta["services"] {
            for (name, value) in o { services[name] = value.stringValue }
        }
        self.services = services
        self.namespace = meta["namespace"].flatMap(DeploymentNamespace.init(json:))
    }

    /// Name and shape, ordered the way a person reads an install: the data
    /// store, then the things that talk to it.
    public var ordered: [(name: String, shape: String)] {
        services.keys.sorted().map { (name: $0, shape: services[$0] ?? "unknown") }
    }
}

/// The deployment row's `meta.namespace`: `{label_suffix, base, ports}`.
public struct DeploymentNamespace: Sendable, Equatable {
    public let labelSuffix: String
    public let base: Int?
    /// service → port, for the services that bind one.
    public let ports: [String: Int]

    public init(labelSuffix: String, base: Int?, ports: [String: Int]) {
        self.labelSuffix = labelSuffix
        self.base = base
        self.ports = ports
    }

    init?(json: JSONValue) {
        guard let suffix = json["label_suffix"]?.stringValue else { return nil }
        var ports: [String: Int] = [:]
        if case .object(let o)? = json["ports"] {
            for (name, value) in o { if let port = value.intValue { ports[name] = port } }
        }
        self.init(labelSuffix: suffix, base: json["base"]?.intValue, ports: ports)
    }
}

/// The reconciler row's `bridge_meta`. It is the CLI's own read path for "is
/// this instance backed up?" — the reconciler is the sole committer, so its
/// last push is the answer, and the app never runs git to find out (invariant 9
/// applied to the client).
public struct ReconcilerFacts: Sendable, Equatable {
    public let head: String?
    public let queueDepth: Int?
    public let pushAttempted: Bool
    public let pushOK: Bool?
    public let remote: String?
    public let pushedAt: String?

    public init?(row: DoctorRow) {
        guard let bridge = row.meta?["bridge_meta"] else { return nil }
        head = bridge["head"]?.stringValue
        queueDepth = bridge["queue_depth"]?.intValue
        let push = bridge["last_push"]
        pushAttempted = push?["attempted"]?.boolValue ?? false
        pushOK = push?["ok"]?.boolValue
        remote = push?["remote"]?.stringValue
        pushedAt = push?["at"]?.stringValue
    }
}

/// The name of doctor's layout row, and the `meta.layout` values it reports —
/// `packages/cli/src/doctor.ts`'s `layoutRow`. This is the AUTHORITATIVE
/// reading of which layout an instance is in: `instance-files.swift` makes the
/// same existence test locally so the wizard can answer before any verb has
/// run, but once doctor has answered, doctor wins.
public enum InstanceLayoutRow {
    public static let name = "instance layout"

    /// `nil` when there is no such row (a CLI older than the row, or older than
    /// this app). An unrecognised value decodes as `.unknown` rather than being
    /// guessed at `flat` — a fifth value would mean the app and the CLI
    /// disagree about the contract, and saying so beats assuming the good case.
    public static func layout(in report: DoctorReport) -> InstanceFiles.Layout? {
        guard let row = report.rows.first(where: { $0.name == name }),
              let raw = row.meta?["layout"]?.stringValue else { return nil }
        return InstanceFiles.Layout(rawValue: raw) ?? .unknown
    }
}

public extension DoctorReport {
    var deployment: DeploymentFacts? {
        rows.first { $0.kind == "deployment" }.flatMap { DeploymentFacts(row: $0) }
    }

    /// Which layout this install's instance directory is in, per doctor.
    /// `nil` when this install's CLI predates the row.
    var instanceLayout: InstanceFiles.Layout? { InstanceLayoutRow.layout(in: self) }

    /// The one sentence the Status panel and the wizard both print when the
    /// instance is not on the flat layout yet. Stated once, so the two surfaces
    /// cannot drift apart.
    var instanceLayoutNotice: String? { instanceLayout?.notice }

    var reconciler: ReconcilerFacts? {
        rows.first { $0.kind == "service" && $0.name == "reconciler" }.flatMap { ReconcilerFacts(row: $0) }
    }

    /// Every bridge doctor knows about, in doctor's order. The Connections pane
    /// lists these; an `absent` one is not configured, which is a fact
    /// (§3.13) and the wizard's bridge step is where it gets configured.
    var bridges: [DoctorRow] { rows.filter { $0.kind == "bridge" } }
}

// MARK: - Fix All (X-125)

/// What Fix All would apply, read off a doctor report — the preview the owner
/// sees BEFORE the door runs, and the thing the run is held to afterwards.
///
/// Built only from rows doctor itself classified `fixable` and gave a `repair`
/// (never from the remediation text), grouped the way the CLI runs them: once
/// per repair id and target, however many rows asked for it. The CLI decides
/// the order and prunes a fix another makes moot; this lists what it may run,
/// not a schedule the app keeps.
public struct FixAllPlan: Sendable, Equatable {
    public struct Item: Sendable, Equatable, Identifiable {
        /// The repair's `id` and `target`, as the CLI's `fixKey`.
        public let id: String
        public let does: String
        /// The rows this fix is for, in doctor's order.
        public let rows: [String]
        /// Moves files or restarts a running service: asked first.
        public let confirm: Bool
    }

    public let items: [Item]

    /// Nil when no row is fixable — Fix All is not offered, never drawn dead.
    public init?(report: DoctorReport) {
        var order: [String] = []
        var byKey: [String: Item] = [:]
        for row in report.rows where row.isFixable {
            guard let repair = row.repair else { continue }
            if let existing = byKey[repair.key] {
                // one row asking to confirm makes the shared fix a confirm — the CLI's own rule
                byKey[repair.key] = Item(id: existing.id, does: existing.does, rows: existing.rows + [row.name], confirm: existing.confirm || repair.confirm)
            } else {
                order.append(repair.key)
                byKey[repair.key] = Item(id: repair.key, does: repair.does, rows: [row.name], confirm: repair.confirm)
            }
        }
        guard !order.isEmpty else { return nil }
        self.items = order.compactMap { byKey[$0] }
    }

    /// Whether any of it moves files or restarts a running service — the
    /// destructive case, which keeps its confirm in the app.
    public var asks: Bool { items.contains { $0.confirm } }

    /// Every fix a finished run executed that this plan did not name, or named
    /// as one that does not ask. `--yes` answers a CLI question, so a confirm
    /// that appeared between the read and the run (a service that went down in
    /// between) would run unpreviewed; the app cannot stop that without a flag
    /// the CLI does not have, so it says so, loudly, after.
    public func unpreviewed(in fixes: [DoctorFixRecord]) -> [DoctorFixRecord] {
        let known = Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0) })
        return fixes.filter { fix in
            guard fix.outcome != "declined", fix.outcome != "needs_confirm" else { return false }
            guard let planned = known[fix.id] else { return true }
            return fix.confirm && !planned.confirm
        }
    }
}

public extension DoctorReport {
    /// Fix All's preview of this report, or nil when nothing is fixable.
    var fixAllPlan: FixAllPlan? { FixAllPlan(report: self) }

    /// Findings only the owner can put right.
    var yoursToDo: [DoctorRow] { rows.filter(\.isYoursToDo) }
}

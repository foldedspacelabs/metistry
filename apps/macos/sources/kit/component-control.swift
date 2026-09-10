// Turning a doctor row into something the menu can act on.
//
// Doctor names a row for a person reading a table: `compose:console`,
// `launchd:com.foldedspacelabs.metistry.watchdog`. The lifecycle verbs
// (`metistry restart|stop|start|logs <name>`) take the COMPONENT name —
// `console`, `watchdog` — which is also what the `service` and `bridge` rows are
// already called, and what `deployment.yaml`'s service plan calls them. This
// file is that one mapping, in one place, with tests, because getting it wrong
// means the menu restarts the wrong thing.
//
// It decides nothing about health: a row's status comes from doctor and is
// rendered as-is (invariant 3, and §3.13's four frozen states).

import Foundation

/// What the menu offers for a row.
public enum ControlAffordance: Sendable, Equatable {
    /// Restart · Stop · Start · View Log.
    case lifecycle
    /// Nothing to start or stop: the row is an assertion about the install
    /// rather than a process (a manifest that validates, a `SELECT 1`, the
    /// resolved deployment shape). The app does not invent a control the CLI
    /// has no verb for.
    case none
}

public struct ComponentControl: Sendable, Equatable, Identifiable {
    public let row: DoctorRow
    /// The argument the lifecycle verbs get.
    public let name: String
    public let affordance: ControlAffordance

    public var id: String { row.id }
    public var canControl: Bool { affordance == .lifecycle }

    public init(row: DoctorRow) {
        self.row = row
        self.name = Self.componentName(for: row)
        self.affordance = Self.affordance(forKind: row.kind)
    }

    /// The launchd label prefix every Metistry job shares
    /// (`ops/launchd/*.plist`). Stripping it is what turns
    /// `launchd:com.foldedspacelabs.metistry.watchdog` into `watchdog`.
    public static let launchdLabelPrefix = "com.foldedspacelabs.metistry."

    /// `compose:console` → `console`; `launchd:com.…metistry.watchdog` →
    /// `watchdog`; anything else is already a component name.
    ///
    /// A label that does not carry our prefix keeps its full name: a job
    /// somebody else installed is not ours to guess a short name for.
    public static func componentName(for row: DoctorRow) -> String {
        let name = row.name
        if let colon = name.firstIndex(of: ":") {
            let tail = String(name[name.index(after: colon)...])
            if tail.hasPrefix(launchdLabelPrefix) {
                return String(tail.dropFirst(launchdLabelPrefix.count))
            }
            return tail
        }
        return name
    }

    static func affordance(forKind kind: String) -> ControlAffordance {
        switch kind {
        // Things with a process behind them, in one shape or another.
        case "service", "bridge", "launchd", "container": return .lifecycle
        // `collector`, `routine`, `target` are manifests that validate;
        // `db`/`migrations` are probes; `deployment` is the resolved shape.
        default: return .none
        }
    }
}

/// One menu group: a doctor `kind` and its rows, ready to render.
public struct ComponentGroup: Sendable, Equatable, Identifiable {
    public let kind: String
    public let components: [ComponentControl]

    public var id: String { kind }

    /// Title Case names things (design-system P10). Doctor's `kind` is an
    /// identifier, so the heading is a *label* derived from it rather than the
    /// identifier itself — and an unknown kind still gets a heading, because
    /// invariant 5 says a new component kind appears without a change here.
    public var title: String {
        switch kind {
        case "service": return "Services"
        case "bridge": return "Bridges"
        case "launchd": return "Launchd Jobs"
        case "container": return "Containers"
        case "collector": return "Collectors"
        case "routine": return "Routines"
        case "target": return "Targets"
        case "db": return "Database"
        case "deployment": return "Deployment"
        default: return kind.capitalized
        }
    }

    /// The worst *fault* in the group, for the group's own dot. `absent` never
    /// counts, the same rule the menu-bar glyph follows.
    public var worstFault: CheckStatus {
        if components.contains(where: { $0.row.status == .failed }) { return .failed }
        if components.contains(where: { $0.row.status == .degraded }) { return .degraded }
        return .ok
    }
}

public extension DoctorReport {
    /// The menu's shape: doctor's own `kind` grouping, in doctor's own order,
    /// each row carrying the name the lifecycle verbs take.
    var componentGroups: [ComponentGroup] {
        groupedByKind.map { ComponentGroup(kind: $0.kind, components: $0.rows.map(ComponentControl.init(row:))) }
    }
}

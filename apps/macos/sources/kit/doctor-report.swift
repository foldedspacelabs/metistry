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

    public var id: String { "\(kind)/\(name)" }

    enum CodingKeys: String, CodingKey {
        case name, kind, status, probe, remediation
        case latencyMs = "latency_ms"
    }

    public init(name: String, kind: String, status: CheckStatus, latencyMs: Double, probe: String, remediation: String? = nil) {
        self.name = name
        self.kind = kind
        self.status = status
        self.latencyMs = latencyMs
        self.probe = probe
        self.remediation = remediation
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

    enum CodingKeys: String, CodingKey {
        case shape, ok, rows
        case asOf = "as_of"
        case productDir = "product_dir"
    }

    public init(asOf: String, productDir: String, shape: String, ok: Bool, rows: [DoctorRow]) {
        self.asOf = asOf
        self.productDir = productDir
        self.shape = shape
        self.ok = ok
        self.rows = rows
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

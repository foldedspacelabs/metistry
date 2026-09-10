// The app decodes a wire shape the CLI owns. These are the misuse tests for
// that boundary (invariant 8: every boundary testable, misuse tests ship with
// the interface) — if `packages/cli/src/doctor.ts` renames a field, this fails
// here rather than showing an empty panel to a user.

import Foundation
import Testing

@testable import MetistryKit

/// Verbatim from `metistry doctor --json` on the Studio install (2026-09-09),
/// trimmed to three rows plus two hand-written ones for the statuses a healthy
/// install does not produce. `meta` is present on purpose: the model ignores it,
/// and that must stay true rather than becoming a decode failure.
private let sampleJSON = """
{
  "as_of": "2026-09-10T01:35:29.488Z",
  "product_dir": "/Users/you/src/metistry",
  "shape": "compose",
  "ok": true,
  "rows": [
    {
      "kind": "deployment",
      "name": "deployment",
      "status": "ok",
      "latency_ms": 0,
      "probe": "deployment.yaml shape (seed/deployment.yaml)",
      "meta": { "shape": "compose", "from": "seed/deployment.yaml" }
    },
    {
      "kind": "bridge",
      "name": "eventkit",
      "status": "degraded",
      "latency_ms": 4,
      "probe": "read 1 calendar event from the default store",
      "remediation": "re-grant Calendars in System Settings"
    },
    {
      "kind": "bridge",
      "name": "apple-fm",
      "status": "absent",
      "latency_ms": 0,
      "probe": "GET /check",
      "remediation": "set METISTRY_AFM_URL in .env"
    },
    {
      "kind": "db",
      "name": "migrations",
      "status": "ok",
      "latency_ms": 3,
      "probe": "schema_migrations vs db/migrations/*.sql"
    },
    {
      "kind": "container",
      "name": "compose:console",
      "status": "failed",
      "latency_ms": 12,
      "probe": "docker compose ps",
      "remediation": "container exited — docker compose logs console"
    }
  ]
}
"""

@Test func decodesADoctorReport() throws {
    let report = try DoctorReport.decode(from: Data(sampleJSON.utf8))
    #expect(report.shape == "compose")
    #expect(report.productDir == "/Users/you/src/metistry")
    #expect(report.asOf == "2026-09-10T01:35:29.488Z")
    #expect(report.rows.count == 5)

    let eventkit = try #require(report.rows.first { $0.name == "eventkit" })
    #expect(eventkit.status == .degraded)
    #expect(eventkit.kind == "bridge")
    #expect(eventkit.latencyMs == 4)
    #expect(eventkit.remediation == "re-grant Calendars in System Settings")
    // A row with no remediation decodes; the panel falls back to the probe.
    #expect(report.rows.first { $0.name == "migrations" }?.remediation == nil)
}

@Test func rowIdsAreUniquePerKindAndName() throws {
    // ForEach needs stable unique ids; doctor emits the same name under two
    // kinds (a bridge and its launchd job), so the kind has to be in the id.
    let report = try DoctorReport.decode(from: Data(sampleJSON.utf8))
    #expect(Set(report.rows.map(\.id)).count == report.rows.count)
}

@Test func absentNeverDrivesTheMenuBarGlyph() throws {
    // `absent` is a fact, not a fault — the same rule that keeps it out of
    // doctor's exit code (docs/ops/cli.md).
    let onlyAbsent = DoctorReport(
        asOf: "now", productDir: "/x", shape: "launchd", ok: true,
        rows: [DoctorRow(name: "apple-fm", kind: "bridge", status: .absent, latencyMs: 0, probe: "GET /check")]
    )
    #expect(onlyAbsent.worstFault == .ok)

    let report = try DoctorReport.decode(from: Data(sampleJSON.utf8))
    #expect(report.worstFault == .failed) // failed outranks degraded
}

@Test func summaryCountsEveryStatusThatOccurred() throws {
    let report = try DoctorReport.decode(from: Data(sampleJSON.utf8))
    #expect(report.summary == "2 ok · 1 degraded · 1 failed · 1 not configured")
}

@Test func groupingKeepsDoctorsOwnOrder() throws {
    let report = try DoctorReport.decode(from: Data(sampleJSON.utf8))
    #expect(report.groupedByKind.map(\.kind) == ["deployment", "bridge", "db", "container"])
    #expect(report.groupedByKind.first { $0.kind == "bridge" }?.rows.count == 2)
}

@Test func anUnknownStatusIsARefusalNotAGuess() {
    // The four statuses are frozen (packages/core/src/check.ts). A fifth means
    // the app and the CLI disagree, and saying so beats colouring it grey.
    let json = #"{"as_of":"x","product_dir":"/x","shape":"compose","ok":true,"rows":[{"kind":"k","name":"n","status":"maybe","latency_ms":0,"probe":"p"}]}"#
    #expect(throws: (any Error).self) {
        try DoctorReport.decode(from: Data(json.utf8))
    }
}

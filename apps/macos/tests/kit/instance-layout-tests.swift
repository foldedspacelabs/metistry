// The two ways the app learns which layout an instance directory is in, and
// the one sentence both of them produce.
//
//   * `InstanceFiles.layout(of:)` — an existence test, made before any verb has
//     run, so the wizard can answer while the user is still in the file picker.
//   * `DoctorReport.instanceLayout` — the CLI's own `instance layout` row,
//     which is authoritative once doctor has answered.
//
// The misuse tests here (invariant 8) are the ones that matter for adoption:
// a legacy instance must still LOOK like an instance, or the wizard refuses the
// user's own folder and the migration verb they need can never be reached.

import Foundation
import Testing

@testable import MetistryKit

private func tempDir() throws -> URL {
    let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("metistry-layout-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

@Suite("instance layout, off the filesystem")
struct InstanceFilesLayoutTests {
    @Test("the flat layout: .metistry/identity.yaml")
    func flat() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir.appendingPathComponent(".metistry"), withIntermediateDirectories: true)
        try "name: Seed\n".write(to: InstanceFiles.metistryPath(dir, "identity.yaml"), atomically: true, encoding: .utf8)

        #expect(InstanceFiles.layout(of: dir) == .flat)
        #expect(InstanceFiles.looksLikeInstance(dir))
        #expect(InstanceFiles.identityURL(dir)?.lastPathComponent == "identity.yaml")
        #expect(InstanceFiles.identityURL(dir)?.path.contains("/.metistry/") == true)
        #expect(InstanceFiles.Layout.flat.notice == nil)
    }

    @Test("a legacy instance is still an instance, and is named as one")
    func legacy() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        try "name: Seed\n".write(to: dir.appendingPathComponent("identity.yaml"), atomically: true, encoding: .utf8)

        #expect(InstanceFiles.layout(of: dir) == .legacy)
        // the whole point: the wizard must not refuse the user's own folder
        #expect(InstanceFiles.looksLikeInstance(dir))
        #expect(InstanceFiles.identityURL(dir)?.path.contains("/.metistry/") == false)
        #expect(InstanceFiles.Layout.legacy.notice == "Legacy layout — run `metistry migrate-layout`")
    }

    @Test("a Knowledge/ vault with no identity.yaml yet is legacy too")
    func legacyByVault() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("Knowledge"), withIntermediateDirectories: true)
        #expect(InstanceFiles.layout(of: dir) == .legacy)
    }

    @Test("an ordinary folder is not an instance, and the notice says what to do")
    func unknown() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        #expect(InstanceFiles.layout(of: dir) == .unknown)
        #expect(!InstanceFiles.looksLikeInstance(dir))
        #expect(InstanceFiles.identityURL(dir) == nil)
        #expect(InstanceFiles.Layout.unknown.notice?.contains(".metistry/identity.yaml") == true)
    }
}

@Suite("instance layout, off doctor --json")
struct DoctorInstanceLayoutTests {
    private func report(_ meta: String?) throws -> DoctorReport {
        let row = meta.map {
            """
            { "kind": "instance", "name": "instance layout", "status": "degraded", "latency_ms": 0,
              "probe": "which layout", "meta": \($0) }
            """
        }
        let json = """
        { "as_of": "2026-09-17T00:00:00.000Z", "product_dir": "/p", "shape": "launchd", "ok": true,
          "rows": [\(row ?? "")] }
        """
        return try DoctorReport.decode(from: Data(json.utf8))
    }

    @Test("legacy is read off the row, and produces the same sentence the wizard shows")
    func legacy() throws {
        let r = try report(#"{ "layout": "legacy" }"#)
        #expect(r.instanceLayout == .legacy)
        #expect(r.instanceLayoutNotice == "Legacy layout — run `metistry migrate-layout`")
    }

    @Test("flat says nothing")
    func flat() throws {
        let r = try report(#"{ "layout": "flat" }"#)
        #expect(r.instanceLayout == .flat)
        #expect(r.instanceLayoutNotice == nil)
    }

    @Test("a CLI with no such row, and a value this app does not know")
    func degradations() throws {
        #expect(try report(nil).instanceLayout == nil) // older CLI: nothing to say
        #expect(try report(#"{ "layout": "sideways" }"#).instanceLayout == .unknown) // never guessed at flat
    }
}

// The cases core's own tests run, read from the one file both suites share.
//
// MetistryKit carries a few of core's decisions over by hand — the autonomy
// arithmetic (`AgentAutonomy`), the key-shape check (`KeyShape`) — because the
// app cannot import TypeScript. A test that "holds" the copy to core with
// cases typed again here passes until someone recopies them, so those cases
// do not live here: they live in `packages/core/test/held-to-core/*.json`,
// core's own tests run every one of them through the real function, and these
// tests run the same file through the copy. Change a case and both suites
// move; change core's behaviour and core's suite fails until the file is
// edited, at which point this one fails until the copy follows (X-100).
// `ops/scripts/check-held-to-core.mjs` keeps the Swift tests reading the file
// (and the CI path filter running this job when it changes).

import Foundation

@testable import MetistryKit

enum HeldToCore {
    /// The repository root, found from this file (this file, tests/kit, tests, macos, apps: five up).
    static let repoRoot: URL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    /// `packages/core/test/held-to-core/<name>.json`.
    static func url(_ name: String) -> URL {
        repoRoot.appendingPathComponent("packages/core/test/held-to-core/\(name).json")
    }

    /// The whole file, or a thrown error naming the path — never an empty set
    /// that would let a loop over "every case" pass over nothing.
    static func cases(_ name: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url(name)))
    }

    static func strings(_ value: JSONValue?) -> [String] {
        guard case .array(let items)? = value else { return [] }
        return items.compactMap(\.stringValue)
    }

    static func array(_ value: JSONValue?) -> [JSONValue] {
        guard case .array(let items)? = value else { return [] }
        return items
    }

    static func object(_ value: JSONValue?) -> [String: JSONValue] {
        guard case .object(let o)? = value else { return [:] }
        return o
    }

    /// `key-shape.json`'s credentials, joined from their segments.
    static func keyShapeKeys() -> [String: String] {
        guard let file = try? cases("key-shape") else { return [:] }
        return object(file["keys"]).mapValues { strings($0).joined() }
    }

    static func keyShapePlain() -> [String] {
        guard let file = try? cases("key-shape") else { return [] }
        return strings(file["plain"])
    }
}

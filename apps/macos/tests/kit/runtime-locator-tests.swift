// First-run step 1 has three shapes and a documented precedence. These are the
// tests that keep the precedence honest, and that keep the "nothing found"
// screen from being a shrug — every rejection has to say what was wrong.

import Foundation
import Testing

@testable import MetistryKit

private struct Sandbox: ~Copyable {
    let root: URL
    init() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("metistry-locator-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }
    deinit { try? FileManager.default.removeItem(at: root) }

    func touch(_ relative: String, executable: Bool = false) throws -> URL {
        let url = root.appendingPathComponent(relative)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        FileManager.default.createFile(
            atPath: url.path,
            contents: Data("#!/bin/sh\n".utf8),
            attributes: executable ? [.posixPermissions: 0o755] : nil
        )
        return url
    }
}

@Test func bundledRuntimeWinsAndResolvesThroughCurrent() throws {
    let box = try Sandbox()
    let resources = box.root.appendingPathComponent("Resources")
    _ = try box.touch("Resources/metistry/runtime/node/bin/node", executable: true)
    _ = try box.touch("Resources/metistry/releases/0.3.1/packages/cli/dist/main.js")
    // `metistry update` release mode points `current` at the release; build-app.sh
    // lays the bundle out the same way, so the locator must follow the symlink.
    // A RELATIVE link, as `metistry update` writes it — so the bundle stays
    // relocatable and `current` survives being moved to /Applications.
    // (`withDestinationURL:` would absolutise it against the CWD.)
    try FileManager.default.createSymbolicLink(
        atPath: resources.appendingPathComponent("metistry/current").path,
        withDestinationPath: "releases/0.3.1"
    )

    let resolved = RuntimeLocator.locate(bundleResourceURL: resources, environment: [:])
    let runtime = try #require(resolved.runtime)
    #expect(runtime.source == .bundled)
    #expect(runtime.executable.path.hasSuffix("/runtime/node/bin/node"))
    #expect(runtime.leadingArguments.first?.contains("/current/packages/cli/dist/main.js") == true)
    #expect(runtime.productDir?.lastPathComponent == "current")
}

@Test func aBundleWithoutCurrentUsesTheDirectoryItself() throws {
    let box = try Sandbox()
    let resources = box.root.appendingPathComponent("Resources")
    _ = try box.touch("Resources/metistry/runtime/node/bin/node", executable: true)
    _ = try box.touch("Resources/metistry/packages/cli/dist/main.js")

    let runtime = try #require(RuntimeLocator.locate(bundleResourceURL: resources, environment: [:]).runtime)
    #expect(runtime.source == .bundled)
    #expect(runtime.productDir?.lastPathComponent == "metistry")
}

@Test func anIncompleteBundleFallsThroughAndSaysWhy() throws {
    let box = try Sandbox()
    let resources = box.root.appendingPathComponent("Resources")
    // A metistry/ directory with no node and no CLI: present, unusable.
    try FileManager.default.createDirectory(
        at: resources.appendingPathComponent("metistry"), withIntermediateDirectories: true
    )

    let resolved = RuntimeLocator.locate(bundleResourceURL: resources, environment: [:])
    #expect(resolved.runtime == nil)
    #expect(resolved.attempts.contains { $0.contains("incomplete") })
    #expect(resolved.attempts.contains { $0.contains("no `metistry` in") })
}

@Test func aCheckoutIsUsedWithItsOwnBundledNode() throws {
    let box = try Sandbox()
    let checkout = box.root.appendingPathComponent("checkout")
    _ = try box.touch("checkout/packages/cli/dist/main.js")
    _ = try box.touch("checkout/runtime/node/bin/node", executable: true)

    let resolved = RuntimeLocator.locate(bundleResourceURL: nil, environment: [:], userProductDir: checkout)
    let runtime = try #require(resolved.runtime)
    #expect(runtime.source == .checkout)
    // A checkout's own runtime/node is preferred over anything on PATH: it is
    // the node `metistry up` renders into the launchd plists.
    #expect(runtime.executable.path.hasSuffix("checkout/runtime/node/bin/node"))
    #expect(runtime.productDir == checkout)
}

@Test func anUnbuiltCheckoutIsRejectedWithTheFix() throws {
    let box = try Sandbox()
    let checkout = box.root.appendingPathComponent("checkout")
    try FileManager.default.createDirectory(at: checkout, withIntermediateDirectories: true)

    let resolved = RuntimeLocator.locate(bundleResourceURL: nil, environment: [:], userProductDir: checkout)
    #expect(resolved.runtime == nil)
    #expect(resolved.attempts.contains { $0.contains("pnpm -r build") })
}

@Test func metistryOnPathIsTheLastResort() throws {
    let box = try Sandbox()
    let bin = box.root.appendingPathComponent("bin")
    _ = try box.touch("bin/metistry", executable: true)

    let resolved = RuntimeLocator.locate(bundleResourceURL: nil, environment: ["PATH": bin.path])
    let runtime = try #require(resolved.runtime)
    #expect(runtime.source == .path)
    #expect(runtime.leadingArguments.isEmpty)
}

@Test func productDirIsAlwaysPassedExplicitly() throws {
    // A GUI process has no meaningful working directory, so every verb carries
    // --product-dir rather than trusting where it happens to have been started.
    let runtime = MetistryRuntime(
        source: .checkout,
        executable: URL(fileURLWithPath: "/usr/bin/node"),
        leadingArguments: ["/src/packages/cli/dist/main.js"],
        productDir: URL(fileURLWithPath: "/src")
    )
    let cli = MetistryCLI(runtime: runtime, runner: NeverRunner())
    #expect(cli.arguments(for: ["doctor", "--json"]) == [
        "/src/packages/cli/dist/main.js", "doctor", "--json", "--product-dir", "/src",
    ])
}

private struct NeverRunner: CommandRunner {
    func run(
        executable: URL, arguments: [String], environment: [String: String],
        currentDirectory: URL?, onOutput: @escaping @Sendable (OutputLine) -> Void
    ) async throws -> CommandResult {
        Issue.record("nothing in these tests should spawn a process")
        return CommandResult(exitCode: 0, stdout: "", stderr: "")
    }
}

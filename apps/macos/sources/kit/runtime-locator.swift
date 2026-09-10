// First-run step 1: WHERE IS THE CLI.
//
// Three shapes, in this order (docs/product/desktop-app-plan.md, "Bundled
// runtime"):
//
//   1. bundled  — `Metistry.app/Contents/Resources/metistry/`, the runtime pack
//                 plus the runtime-deps pack (Node, Postgres, git) that
//                 ops/release/build-app.sh embedded and notarized with the app.
//                 Nothing on the user's machine is required.
//   2. checkout — a product checkout the user pointed the app at, or
//                 METISTRY_PRODUCT_DIR: run `node packages/cli/dist/main.js`.
//                 This is the developer's shape and the terminal user's shape.
//   3. path     — a `metistry` on PATH (`npx @foldedspacelabs/metistry-cli`
//                 installed it, or a global install).
//
// A GUI app inherits no shell environment, so "on PATH" cannot mean
// `/usr/bin/env metistry`: the candidate directories are listed explicitly and
// PATH is only consulted when launchd happened to pass one.
//
// This type answers *where*, and records what it tried. It does not copy the
// bundled runtime anywhere — see the open question in
// docs/product/desktop-app-plan.md about the writable product dir a
// `metistry update` needs (a signed bundle's Resources cannot be written to).

import Foundation

public struct MetistryRuntime: Sendable, Equatable {
    public enum Source: String, Sendable {
        case bundled
        case checkout
        case path

        public var label: String {
            switch self {
            case .bundled: return "bundled in the app"
            case .checkout: return "product checkout"
            case .path: return "metistry on PATH"
            }
        }
    }

    public let source: Source
    /// What is actually spawned: the bundled/located `node`, or the `metistry`
    /// bin itself.
    public let executable: URL
    /// Arguments that come before the verb — `[…/packages/cli/dist/main.js]`
    /// when the executable is `node`, empty when it is the `metistry` bin.
    public let leadingArguments: [String]
    /// The checkout or unpacked release doctor/up/update walk. `nil` only for a
    /// bare `metistry` on PATH that will resolve its own.
    public let productDir: URL?

    public init(source: Source, executable: URL, leadingArguments: [String] = [], productDir: URL? = nil) {
        self.source = source
        self.executable = executable
        self.leadingArguments = leadingArguments
        self.productDir = productDir
    }

    /// One line for the Status panel: what will run, so there is never a
    /// question about which install the app is talking to.
    public var describedCommand: String {
        ([executable.path] + leadingArguments + ["<verb>"]).joined(separator: " ")
    }
}

public struct RuntimeResolution: Sendable {
    public let runtime: MetistryRuntime?
    /// Every candidate considered and why it was rejected — this is what the
    /// "no runtime" screen shows instead of "something went wrong".
    public let attempts: [String]

    public init(runtime: MetistryRuntime?, attempts: [String]) {
        self.runtime = runtime
        self.attempts = attempts
    }
}

public enum RuntimeLocator {
    /// Directories a `metistry` bin realistically lands in, for a process that
    /// was launched by Finder and therefore has a near-empty PATH.
    public static let binaryCandidateDirectories = [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
    ]

    /// Same, for `node` — needed for the checkout shape.
    public static let nodeCandidateDirectories = [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
    ]

    public static func locate(
        bundleResourceURL: URL?,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        userProductDir: URL? = nil,
        fileManager: FileManager = .default
    ) -> RuntimeResolution {
        var attempts: [String] = []

        // ---- 1. bundled ----
        if let resources = bundleResourceURL {
            let bundled = resources.appendingPathComponent("metistry", isDirectory: true)
            if fileManager.fileExists(atPath: bundled.path) {
                // `metistry update` release mode lays a product dir out as
                // releases/<version>/ with `current` pointing at one
                // (docs/ops/releases.md); build-app.sh embeds the pack the same
                // way, so prefer `current` and fall back to the directory itself.
                let current = bundled.appendingPathComponent("current", isDirectory: true)
                let productDir = fileManager.fileExists(atPath: current.path) ? current : bundled
                let cliMain = productDir.appendingPathComponent("packages/cli/dist/main.js")
                // The runtime-deps pack unpacks beside releases/, never inside
                // one, so a version flip never orphans it (docs/ops/releases.md).
                let bundledNode = bundled.appendingPathComponent("runtime/node/bin/node")
                if fileManager.isExecutableFile(atPath: bundledNode.path), fileManager.fileExists(atPath: cliMain.path) {
                    return RuntimeResolution(
                        runtime: MetistryRuntime(
                            source: .bundled,
                            executable: bundledNode,
                            leadingArguments: [cliMain.path],
                            productDir: productDir
                        ),
                        attempts: attempts
                    )
                }
                attempts.append("bundled runtime at \(bundled.path): incomplete (needs runtime/node/bin/node and \(cliMain.lastPathComponent))")
            } else {
                attempts.append("no bundled runtime at \(bundled.path) — this build did not embed one")
            }
        } else {
            attempts.append("no app bundle resources to search (running the raw executable from .build/)")
        }

        // ---- 2. a product checkout ----
        let checkoutCandidates: [(URL, String)] = [
            userProductDir.map { ($0, "chosen in the app") },
            environment["METISTRY_PRODUCT_DIR"].map { (URL(fileURLWithPath: $0), "METISTRY_PRODUCT_DIR") },
        ].compactMap { $0 }

        for (dir, why) in checkoutCandidates {
            let cliMain = dir.appendingPathComponent("packages/cli/dist/main.js")
            guard fileManager.fileExists(atPath: cliMain.path) else {
                attempts.append("checkout \(dir.path) (\(why)): no packages/cli/dist/main.js — run `pnpm -r build` there")
                continue
            }
            guard let node = findNode(in: dir, environment: environment, fileManager: fileManager) else {
                attempts.append("checkout \(dir.path) (\(why)): found the CLI but no node to run it with")
                continue
            }
            return RuntimeResolution(
                runtime: MetistryRuntime(source: .checkout, executable: node, leadingArguments: [cliMain.path], productDir: dir),
                attempts: attempts
            )
        }
        if checkoutCandidates.isEmpty {
            attempts.append("no product checkout chosen, and METISTRY_PRODUCT_DIR is unset")
        }

        // ---- 3. a `metistry` on PATH ----
        if let bin = findExecutable(named: "metistry", environment: environment, extraDirectories: binaryCandidateDirectories, fileManager: fileManager) {
            return RuntimeResolution(
                runtime: MetistryRuntime(source: .path, executable: bin, productDir: userProductDir),
                attempts: attempts
            )
        }
        attempts.append("no `metistry` in \(searchDirectories(environment: environment, extra: binaryCandidateDirectories).joined(separator: ", "))")

        return RuntimeResolution(runtime: nil, attempts: attempts)
    }

    /// A checkout's own bundled `runtime/node/bin/node` first — that is the one
    /// `metistry up` renders into the launchd plists — then the usual bins.
    static func findNode(in productDir: URL, environment: [String: String], fileManager: FileManager) -> URL? {
        let bundled = productDir.appendingPathComponent("runtime/node/bin/node")
        if fileManager.isExecutableFile(atPath: bundled.path) { return bundled }
        return findExecutable(named: "node", environment: environment, extraDirectories: nodeCandidateDirectories, fileManager: fileManager)
    }

    static func searchDirectories(environment: [String: String], extra: [String]) -> [String] {
        let fromPath = (environment["PATH"] ?? "").split(separator: ":").map(String.init).filter { !$0.isEmpty }
        var seen = Set<String>()
        return (fromPath + extra).filter { seen.insert($0).inserted }
    }

    static func findExecutable(named name: String, environment: [String: String], extraDirectories: [String], fileManager: FileManager) -> URL? {
        for dir in searchDirectories(environment: environment, extra: extraDirectories) {
            let candidate = URL(fileURLWithPath: dir).appendingPathComponent(name)
            if fileManager.isExecutableFile(atPath: candidate.path) { return candidate }
        }
        return nil
    }
}

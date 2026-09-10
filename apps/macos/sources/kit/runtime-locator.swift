// First-run step 1: WHERE IS THE CLI.
//
// Four shapes, in this order (docs/product/desktop-app-plan.md, "Bundled
// runtime"):
//
//   1. installed — `~/Library/Application Support/Metistry/product/`, which
//                 `metistry runtime install --from <bundle> --to <dir>` wrote
//                 out of the bundle. THE WRITABLE ONE, and therefore the one
//                 `metistry update` can lay a new `releases/<version>/` into.
//   2. bundled  — `Metistry.app/Contents/Resources/metistry/`, the runtime pack
//                 plus the runtime-deps pack (Node, Postgres, git) that
//                 ops/release/build-app.sh embedded and notarized with the app.
//                 Nothing on the user's machine is required — but a signed
//                 bundle's `Resources` cannot be written to, so this is a SEED.
//   3. checkout — a product checkout the user pointed the app at, or
//                 METISTRY_PRODUCT_DIR: run `node packages/cli/dist/main.js`.
//                 This is the developer's shape and the terminal user's shape.
//   4. path     — a `metistry` on PATH (`npx @foldedspacelabs/metistry-cli`
//                 installed it, or a global install).
//
// A GUI app inherits no shell environment, so "on PATH" cannot mean
// `/usr/bin/env metistry`: the candidate directories are listed explicitly and
// PATH is only consulted when launchd happened to pass one.
//
// THE DECISION THIS ENCODES. The scaffold left an open question: a bundled
// install's `Resources/metistry/` is read-only, so where does the writable
// product dir a `metistry update` needs live? It is
// `~/Library/Application Support/Metistry/product`, and the bundle is a seed
// copied there once by `metistry runtime install` — the first of the two options
// docs/product/desktop-app-plan.md set out, which is also the one its own "Two
// channels, both signed" paragraph already reads as. The COPY is a CLI verb, not
// something this app does: an app that laid out `releases/<version>/` and flipped
// `current` itself would be a second implementation of `metistry update`'s
// release mode. This type only answers *where*, and records what it tried.

import Foundation

public struct MetistryRuntime: Sendable, Equatable {
    public enum Source: String, Sendable {
        case installed
        case bundled
        case checkout
        case path

        public var label: String {
            switch self {
            case .installed: return "installed by the app"
            case .bundled: return "bundled in the app (read-only)"
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
    /// The bundle's read-only copy, when this build has one:
    /// `Metistry.app/Contents/Resources/metistry`. It is what
    /// `metistry runtime install --from` is pointed at.
    public let bundledSeed: URL?
    /// Where that copy is installed to: the writable product dir.
    public let installTarget: URL

    public init(
        runtime: MetistryRuntime?,
        attempts: [String],
        bundledSeed: URL? = nil,
        installTarget: URL = RuntimeLocator.installedProductDirectory
    ) {
        self.runtime = runtime
        self.attempts = attempts
        self.bundledSeed = bundledSeed
        self.installTarget = installTarget
    }

    /// True when the app is running out of the bundle's read-only seed and the
    /// writable copy has not been made yet. That is not a fault — the seed runs
    /// every verb perfectly well — but `metistry update` cannot write to it, so
    /// the wizard offers the one-command install and says why.
    public var needsRuntimeInstall: Bool {
        bundledSeed != nil && runtime?.source == .bundled
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

    /// `~/Library/Application Support/Metistry/product` — the writable product
    /// dir a bundled install's `metistry update` writes into.
    ///
    /// Application Support rather than the bundle, because a signed bundle's
    /// `Resources` cannot be written to; and rather than the instance directory,
    /// because the product is CODE and one copy serves every instance
    /// (docs/product/desktop-app-plan.md, "What lives where": "the product
    /// runtime, releases/, runtime/, current — the install/product dir").
    public static let installedProductDirectory: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support", isDirectory: true)
        return base.appendingPathComponent("Metistry/product", isDirectory: true)
    }()

    public static func locate(
        bundleResourceURL: URL?,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        userProductDir: URL? = nil,
        installedDir: URL = RuntimeLocator.installedProductDirectory,
        fileManager: FileManager = .default
    ) -> RuntimeResolution {
        var attempts: [String] = []
        let bundledSeed = bundleResourceURL?.appendingPathComponent("metistry", isDirectory: true)

        // ---- 1. the writable install ----
        if let runtime = packShape(at: installedDir, source: .installed, fileManager: fileManager) {
            return RuntimeResolution(runtime: runtime, attempts: attempts, bundledSeed: bundledSeed, installTarget: installedDir)
        }
        attempts.append(fileManager.fileExists(atPath: installedDir.path)
            ? "installed runtime at \(installedDir.path): incomplete (needs runtime/node/bin/node and packages/cli/dist/main.js) — `metistry runtime install` lays it out"
            : "no installed runtime at \(installedDir.path) yet — first run copies the bundled one there")

        // ---- 2. the bundle's read-only seed ----
        if let bundled = bundledSeed {
            if fileManager.fileExists(atPath: bundled.path) {
                if let runtime = packShape(at: bundled, source: .bundled, fileManager: fileManager) {
                    return RuntimeResolution(runtime: runtime, attempts: attempts, bundledSeed: bundled, installTarget: installedDir)
                }
                attempts.append("bundled runtime at \(bundled.path): incomplete (needs runtime/node/bin/node and packages/cli/dist/main.js)")
            } else {
                attempts.append("no bundled runtime at \(bundled.path) — this build did not embed one")
            }
        } else {
            attempts.append("no app bundle resources to search (running the raw executable from .build/)")
        }

        // ---- 3. a product checkout ----
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
                attempts: attempts,
                bundledSeed: bundledSeed,
                installTarget: installedDir
            )
        }
        if checkoutCandidates.isEmpty {
            attempts.append("no product checkout chosen, and METISTRY_PRODUCT_DIR is unset")
        }

        // ---- 4. a `metistry` on PATH ----
        if let bin = findExecutable(named: "metistry", environment: environment, extraDirectories: binaryCandidateDirectories, fileManager: fileManager) {
            return RuntimeResolution(
                runtime: MetistryRuntime(source: .path, executable: bin, productDir: userProductDir),
                attempts: attempts,
                bundledSeed: bundledSeed,
                installTarget: installedDir
            )
        }
        attempts.append("no `metistry` in \(searchDirectories(environment: environment, extra: binaryCandidateDirectories).joined(separator: ", "))")

        return RuntimeResolution(runtime: nil, attempts: attempts, bundledSeed: bundledSeed, installTarget: installedDir)
    }

    /// A release install's layout, wherever it sits: `releases/<version>/` with a
    /// `current` symlink and `runtime/` BESIDE it, never inside one, so a version
    /// flip never orphans Node (docs/ops/releases.md). `build-app.sh` embeds the
    /// bundle's copy in exactly that shape and `metistry runtime install` writes
    /// the same one, which is what lets the app and the CLI agree about a
    /// product directory without either describing it to the other.
    static func packShape(at root: URL, source: MetistryRuntime.Source, fileManager: FileManager) -> MetistryRuntime? {
        guard fileManager.fileExists(atPath: root.path) else { return nil }
        let current = root.appendingPathComponent("current", isDirectory: true)
        let productDir = fileManager.fileExists(atPath: current.path) ? current : root
        let cliMain = productDir.appendingPathComponent("packages/cli/dist/main.js")
        let node = root.appendingPathComponent("runtime/node/bin/node")
        guard fileManager.isExecutableFile(atPath: node.path), fileManager.fileExists(atPath: cliMain.path) else { return nil }
        return MetistryRuntime(source: source, executable: node, leadingArguments: [cliMain.path], productDir: productDir)
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

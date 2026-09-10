// What the whole app knows: which install it is talking to, the last doctor
// report, and where first run got to.
//
// The runtime is resolved once and can be re-resolved (the user picks a
// checkout, or a bundled runtime is installed). Nothing here computes health —
// it holds what the CLI said.

import Foundation
import SwiftUI

@MainActor
@Observable
public final class AppModel {
    /// Where the app looked for the app bundle's embedded runtime. Injected so
    /// the model is testable and so a raw `.build/` executable can pass nil.
    public let bundleResourceURL: URL?
    private let runner: any CommandRunner
    private let defaults: UserDefaults

    /// The checkout the user pointed the app at, remembered across launches.
    /// This is the developer and terminal-user shape; a shipped app finds its
    /// bundled runtime instead and never needs it.
    public private(set) var chosenProductDir: URL?

    public private(set) var resolution: RuntimeResolution
    public var status: StatusModel
    public var firstRun: FirstRunModel

    private static let productDirKey = "productDirectory"

    public init(bundleResourceURL: URL?, runner: any CommandRunner, defaults: UserDefaults = .standard) {
        self.bundleResourceURL = bundleResourceURL
        self.runner = runner
        self.defaults = defaults
        let stored = defaults.string(forKey: Self.productDirKey).map { URL(fileURLWithPath: $0) }
        self.chosenProductDir = stored
        let resolution = RuntimeLocator.locate(bundleResourceURL: bundleResourceURL, userProductDir: stored)
        self.resolution = resolution
        let cli = resolution.runtime.map { MetistryCLI(runtime: $0, runner: runner) }
        self.status = StatusModel(cli: cli)
        self.firstRun = FirstRunModel(cli: cli, resolution: resolution)
    }

    public var runtime: MetistryRuntime? { resolution.runtime }

    public func chooseProductDirectory(_ url: URL?) {
        chosenProductDir = url
        if let url {
            defaults.set(url.path, forKey: Self.productDirKey)
        } else {
            defaults.removeObject(forKey: Self.productDirKey)
        }
        relocate()
    }

    /// Re-run step 1. Called after the user picks a folder, and offered on the
    /// "no runtime" screen so a `metistry` installed while the app was open is
    /// found without a relaunch.
    public func relocate() {
        resolution = RuntimeLocator.locate(bundleResourceURL: bundleResourceURL, userProductDir: chosenProductDir)
        let cli = resolution.runtime.map { MetistryCLI(runtime: $0, runner: runner) }
        status.cli = cli
        firstRun.adopt(cli: cli, resolution: resolution)
    }
}

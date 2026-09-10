// What the whole app knows: which install it is talking to, and the sub-models
// that read it.
//
// The app persists three pointers and nothing else (app-preferences.swift). Both
// of the ones that matter here feed the same resolution: the ACTIVE INSTANCE is
// the folder every verb runs against (`METISTRY_INSTANCE_DIR`), and the
// DEVELOPER OVERRIDE is a product checkout for a build with no runtime bundled
// inside it. Change either and everything downstream is rebuilt from the CLI —
// nothing here caches a value the CLI owns.
//
// Nothing in this file computes health, reads a database, or runs git. It holds
// what the CLI said.

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

    /// The active instance and the recents, persisted.
    public let instances: InstanceBookmarks
    /// A product checkout, for a build whose bundle has no runtime in it.
    /// Persisted, and surfaced only under Settings → Advanced.
    public private(set) var developerProductDir: URL?

    public private(set) var resolution: RuntimeResolution
    public var status: StatusModel
    public var firstRun: FirstRunModel
    public var settings: SettingsModel
    public var wizard: WizardModel
    public var menu: MenuBarModel
    public var logs: LogViewerModel
    /// Filled in by the platform (Sparkle on macOS); a plain box here.
    public let updates: UpdateStatus
    /// Start at login. `nil` service on a platform with no `SMAppService`.
    public let loginItem: LoginItemModel

    public init(
        bundleResourceURL: URL?,
        runner: any CommandRunner,
        defaults: UserDefaults = .standard,
        appVersion: String = UpdateStatus.devBuildVersion,
        loginItemService: (any LoginItemService)? = nil,
        passkeyRegistrar: (any PasskeyRegistrar)? = nil,
        terminalOpener: (any TerminalOpener)? = nil
    ) {
        let instances = InstanceBookmarks(defaults: defaults)
        let developerProductDir = Self.loadDeveloperProductDir(defaults)
        let resolution = RuntimeLocator.locate(bundleResourceURL: bundleResourceURL, userProductDir: developerProductDir)
        let cli = resolution.runtime.map { MetistryCLI(runtime: $0, runner: runner, instanceDir: instances.active) }
        let status = StatusModel(cli: cli)
        let firstRun = FirstRunModel(
            cli: cli,
            resolution: resolution,
            passkey: PasskeyEnrolmentModel(registrar: passkeyRegistrar),
            claude: ClaudeTokenModel(
                cli: cli,
                terminal: terminalOpener,
                claudeBinary: ClaudeCodeLocator.locate(productDir: resolution.runtime?.productDir)
            )
        )

        self.bundleResourceURL = bundleResourceURL
        self.runner = runner
        self.defaults = defaults
        self.instances = instances
        self.developerProductDir = developerProductDir
        self.updates = UpdateStatus(appVersion: appVersion)
        self.loginItem = LoginItemModel(service: loginItemService)
        self.resolution = resolution
        self.status = status
        self.firstRun = firstRun
        self.settings = SettingsModel(status: status, cli: cli, instanceDir: instances.active)
        self.wizard = WizardModel(steps: firstRun)
        self.menu = MenuBarModel(status: status, cli: cli)
        self.logs = LogViewerModel(cli: cli)

        // The wizard's step 2 hands the folder back the moment it is known, so
        // every later verb runs against it.
        wizard.onInstanceChosen = { [weak self] url in self?.activateInstance(url) }
        // Step 1's `runtime install` writes the copy the app should be using;
        // re-resolving is what makes it start using it.
        firstRun.onRuntimeInstalled = { [weak self] in self?.relocate() }
        // An install with no instance chosen has one useful screen, and it is the
        // wizard. This is the only thing that presents it automatically.
        if instances.active == nil {
            wizard.isPresented = true
        } else {
            firstRun.instanceDirectory = instances.active
        }
    }

    public var runtime: MetistryRuntime? { resolution.runtime }
    public var cli: MetistryCLI? {
        resolution.runtime.map { MetistryCLI(runtime: $0, runner: runner, instanceDir: instances.active) }
    }

    // MARK: - The instance

    public func activateInstance(_ url: URL) {
        instances.activate(url)
        firstRun.instanceDirectory = instances.active
        relocate()
    }

    public func forgetInstance(_ url: URL) {
        instances.forget(url)
        relocate()
    }

    // MARK: - The developer override

    /// Settings → Advanced. `nil` clears it.
    public func chooseDeveloperProductDirectory(_ url: URL?) {
        developerProductDir = url
        if let url {
            defaults.set(url.path, forKey: AppPreference.developerProductDirectory.rawValue)
        } else {
            defaults.removeObject(forKey: AppPreference.developerProductDirectory.rawValue)
        }
        relocate()
    }

    /// Reads the override, migrating the scaffold's `productDirectory` key once
    /// so a developer who set it does not have to find the folder again.
    static func loadDeveloperProductDir(_ defaults: UserDefaults) -> URL? {
        if let path = defaults.string(forKey: AppPreference.developerProductDirectory.rawValue) {
            return URL(fileURLWithPath: path)
        }
        guard let legacy = defaults.string(forKey: AppPreference.legacyProductDirectory) else { return nil }
        defaults.set(legacy, forKey: AppPreference.developerProductDirectory.rawValue)
        defaults.removeObject(forKey: AppPreference.legacyProductDirectory)
        return URL(fileURLWithPath: legacy)
    }

    /// Re-resolve the runtime and re-point every sub-model at it. Called after
    /// the instance or the override changes, and offered on the "no runtime"
    /// screen so a `metistry` installed while the app was open is found without
    /// a relaunch.
    public func relocate() {
        resolution = RuntimeLocator.locate(bundleResourceURL: bundleResourceURL, userProductDir: developerProductDir)
        let cli = self.cli
        status.cli = cli
        menu.cli = cli
        logs.cli = cli
        firstRun.adopt(
            cli: cli,
            resolution: resolution,
            claudeBinary: ClaudeCodeLocator.locate(productDir: resolution.runtime?.productDir)
        )
        settings.adopt(cli: cli, instanceDir: instances.active)
    }
}

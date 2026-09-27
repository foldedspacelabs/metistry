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
    /// Start at login — the APP. `nil` service on a platform with no
    /// `SMAppService`.
    public let loginItem: LoginItemModel
    /// The install's ONE background item, registered from this bundle's
    /// `Contents/Library/LaunchAgents` (background-agent.swift). A different
    /// registration from `loginItem`, and a different promise.
    public let backgroundAgent: BackgroundAgentModel
    /// Who the console takes this Mac to be — asked on launch and on every
    /// instance switch, by `metistry console whoami --json` and nothing else
    /// (console-sign-in.swift).
    public let consoleSignIn: ConsoleSignInModel
    /// The active instance's console: the §2.16 stores over one long-lived
    /// `metistry console session` child, O3's gate in front of them, and §2.2's
    /// management verbs beside them (stores/console-session.swift). The child
    /// starts on the first request a screen makes, not here.
    public let console: ConsoleSession
    /// The window's frame: where the owner is, the Needs You row and the Dock
    /// badge, the Usage gauge, the configured name (shell-model.swift). It
    /// reads `console.stores` through three F-7 protocols and nothing else.
    public let shell: ShellModel
    /// Needs You's list: the queue, its filters, the selection and the bulk
    /// verbs (needs-you-view.swift). Held here rather than by its view, so the
    /// list the owner left is the list they come back to (C135: show what
    /// Metistry last had, at once); dropped with everything else on an
    /// instance switch.
    public let needsYou: NeedsYouModel
    /// Activity: the filter, the painted page, the held rows and what was read
    /// on demand (activity-view.swift). Held here rather than by its view, so
    /// the list the owner left is the list they come back to; dropped with
    /// everything else on an instance switch.
    public let activity: ActivityModel

    public init(
        bundleResourceURL: URL?,
        runner: any CommandRunner,
        defaults: UserDefaults = .standard,
        appVersion: String = UpdateStatus.devBuildVersion,
        loginItemService: (any LoginItemService)? = nil,
        backgroundAgentService: (any BackgroundAgentService)? = nil,
        passkeyRegistrar: (any PasskeyRegistrar)? = nil,
        sessionSpawner: (any SessionSpawner)? = nil
    ) {
        let instances = InstanceBookmarks(defaults: defaults)
        let developerProductDir = Self.loadDeveloperProductDir(defaults)
        let resolution = RuntimeLocator.locate(bundleResourceURL: bundleResourceURL, userProductDir: developerProductDir, instanceDir: instances.active)
        let cli = resolution.runtime.map { MetistryCLI(runtime: $0, runner: runner, instanceDir: instances.active) }
        let status = StatusModel(cli: cli)
        // ONE sign-in model for the whole app. The Status header, Settings →
        // Connections, the menu bar's console row and the wizard's step 6 all
        // render it, so they cannot disagree about who this Mac is — and the
        // question is asked once per launch and per instance switch rather than
        // four times.
        let consoleSignIn = ConsoleSignInModel(cli: cli)
        let firstRun = FirstRunModel(
            cli: cli,
            resolution: resolution,
            passkey: PasskeyEnrolmentModel(registrar: passkeyRegistrar),
            compute: ComputeStepModel(cli: cli),
            consoleSignIn: consoleSignIn
        )

        self.bundleResourceURL = bundleResourceURL
        self.runner = runner
        self.defaults = defaults
        self.instances = instances
        self.developerProductDir = developerProductDir
        self.updates = UpdateStatus(appVersion: appVersion)
        self.loginItem = LoginItemModel(service: loginItemService)
        let backgroundAgent = BackgroundAgentModel(service: backgroundAgentService)
        self.backgroundAgent = backgroundAgent
        self.resolution = resolution
        self.status = status
        self.consoleSignIn = consoleSignIn
        self.firstRun = firstRun
        let console = ConsoleSession(cli: cli, spawner: sessionSpawner, defaults: defaults)
        self.console = console
        self.settings = SettingsModel(status: status, cli: cli, instanceDir: instances.active, consoleSignIn: consoleSignIn)
        self.wizard = WizardModel(steps: firstRun)
        self.menu = MenuBarModel(status: status, cli: cli)
        self.logs = LogViewerModel(cli: cli)
        let shell = ShellModel(stores: console.stores, defaults: defaults)
        self.shell = shell
        let needsYou = NeedsYouModel(session: console)
        self.needsYou = needsYou
        // An answer here moves the count: the row and the Dock hear it now,
        // not at the shell's next tick.
        needsYou.onQueueChanged = { [weak shell] in await shell?.refreshCount() }
        self.activity = ActivityModel(session: console)

        // The wizard's step 2 hands the folder back the moment it is known, so
        // every later verb runs against it.
        wizard.onInstanceChosen = { [weak self] url in self?.activateInstance(url) }
        // Step 1's `runtime install` writes the copy the app should be using;
        // re-resolving is what makes it start using it.
        firstRun.onRuntimeInstalled = { [weak self] in self?.relocate() }
        // Step 5 (`up`) has to know which registrar will own the one background
        // item BEFORE it runs, because the flag goes on the command line: when
        // this build carries an agent to register, `up` installs everything
        // except that one and the app registers its bundled copy.
        firstRun.registersSupervisorAgent = backgroundAgent.bundlesAgent
        // …and then actually registers it, once `up` has written the config and
        // the launcher file the agent reads. Doing it before would register an
        // agent with nothing to point at (docs/ops/mac-app.md).
        firstRun.onSupervisorInstalled = { [weak self] in self?.backgroundAgent.set(true) }
        // An install with no instance chosen has one useful screen, and it is the
        // wizard. This is the only thing that presents it automatically.
        if instances.active == nil {
            wizard.isPresented = true
        } else {
            firstRun.instanceDirectory = instances.active
        }
    }

    /// Starts the shell's poll and the live-changes stream it follows, and
    /// keeps `apply` fed with the Dock badge's label. Called once by the app,
    /// never from `init`: a model built by a test starts nothing.
    public func startShell(dockBadge apply: @escaping @MainActor (String?) -> Void) {
        shell.observeBadge(apply)
        shell.follow(console.events)
        shell.start()
        console.events.start()
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
        resolution = RuntimeLocator.locate(bundleResourceURL: bundleResourceURL, userProductDir: developerProductDir, instanceDir: instances.active)
        let cli = self.cli
        status.cli = cli
        menu.cli = cli
        logs.cli = cli
        firstRun.adopt(cli: cli, resolution: resolution)
        settings.adopt(cli: cli, instanceDir: instances.active)
        // The previous instance's answer is dropped, not carried over: a "signed
        // in" belongs to the install it was asked about. Then it is asked again,
        // because "on instance switch" is exactly when the answer changes.
        consoleSignIn.adopt(cli: cli, shape: status.report?.shape)
        Task { await consoleSignIn.refresh() }
        // The same line for the console itself: the old instance's child is
        // ended and every section built on it is dropped.
        console.adopt(cli: cli, defaults: defaults)
        // The shell forgets the last instance's count, name, pins and history,
        // reads through the new session, and asks now rather than at its next tick.
        shell.adopt(stores: console.stores)
        Task { await shell.refresh() }
    }
}

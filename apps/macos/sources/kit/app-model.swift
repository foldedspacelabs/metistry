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
    /// Chat: the transcript, what each message set working, the composer and
    /// its tier (chat-model.swift). Held here, not by its view, so a turn keeps
    /// being watched — and the sidebar's dot keeps its word — after the owner
    /// walks away from the screen (screen-01 §5.1).
    public let chat: ChatModel
    /// The capture composer behind the toolbar's + and ⌘N (capture-view.swift).
    /// Held here, not by the popover, so Esc keeps the draft and a queued
    /// capture keeps resending with every window closed.
    public let composer: CaptureComposerModel
    /// Today's top — the brief's fold, Next Up, calendar help, Close the Day —
    /// and the day under it (today-view.swift). Held here so a closed day and a
    /// dismissed offer outlive a trip to another screen; dropped with
    /// everything else on an instance switch.
    public let today: TodayModel
    /// Knowledge: the fold, Needs your eye, the areas, the sources line, and
    /// where in the vault the owner is (knowledge-view.swift). Held here so a
    /// conflict's Keep Mine, held ten seconds for Undo, is still sent — or
    /// undone — after the owner walks away; dropped on an instance switch.
    public let knowledge: KnowledgeModel
    /// Scheduled: the routines and syncs, the week, the selection and what
    /// each detail read (scheduled-view.swift). Held here so the routine the
    /// owner left open is the one they come back to; dropped with everything
    /// else on an instance switch.
    public let scheduled: ScheduledModel
    /// Agents: the roster, one agent's page, the definition editor and its
    /// kept drafts (agents-model.swift). Held here so a draft kept with Esc
    /// outlives a trip to another screen; dropped with everything else on an
    /// instance switch.
    public let agents: AgentsModel
    /// Work ▸ Board: the columns, the filter, the moves, the open card and its
    /// room (board-view.swift). Held here so the board the owner left — its
    /// filter, a refused move's sentence — is the board they come back to.
    public let board: BoardModel
    /// Work ▸ Projects: the list, the project on screen, its recent runs and
    /// the confirmation waiting for the owner (projects-view.swift). Held here
    /// so the project the owner left is the one they come back to; dropped
    /// with everything else on an instance switch.
    public let projects: ProjectsModel
    /// Settings ▸ Instance ▸ History: the vault's sync and Roll Back…
    /// (settings-panes/instance-pane.swift). Held here so a rollback asked for
    /// keeps its preview while the Settings window is closed and reopened;
    /// dropped on an instance switch.
    public let vaultHistory: VaultHistoryModel
    /// Work ▸ Artifacts: the list, the artifact on screen, its version, its
    /// threads and Compare (artifacts-view.swift). Held here so the version
    /// the owner left is the one they come back to; dropped with everything
    /// else on an instance switch.
    public let artifacts: ArtifactsModel
    /// Run detail: the run on screen and the screen it was opened over
    /// (run-detail-view.swift). Held here so any screen that lists runs opens
    /// the same page; closed on an instance switch.
    public let runDetail: RunDetailModel
    /// The floating bar (capture-bar-model.swift, T8-5): drawn only while the
    /// live-capture bridge answers on this Mac. Its Note and To-do go through
    /// `composer`, its Ask is `chat`, and it lights the Capture menu's bar
    /// items through `shell.captureActions`.
    public let captureBar: CaptureBarModel
    /// Settings ▸ Keyboard's shortcuts in any app (hotkeys.swift): off until
    /// the owner turns them on, and registered only once the app target
    /// attaches `RegisterEventHotKey` — a model built by a test registers nothing.
    public let hotKeys: AnyAppShortcutsModel
    /// The floating bar's switch and placement — this Mac's, not an
    /// instance's (app-preferences.swift, T6-15): Settings ▸ Live Capture
    /// writes it, the bar's window reads it.
    public let barPlacement: CaptureBarPreferences

    public init(
        bundleResourceURL: URL?,
        runner: any CommandRunner,
        defaults: UserDefaults = .standard,
        appVersion: String = UpdateStatus.devBuildVersion,
        loginItemService: (any LoginItemService)? = nil,
        backgroundAgentService: (any BackgroundAgentService)? = nil,
        passkeyRegistrar: (any PasskeyRegistrar)? = nil,
        sessionSpawner: (any SessionSpawner)? = nil,
        liveCapture: (transport: any LiveCaptureTransport, keys: any LiveCaptureKeySource)? = nil
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
        self.barPlacement = CaptureBarPreferences(defaults: defaults)
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
        self.settings = SettingsModel(status: status, cli: cli, instanceDir: instances.active, consoleSignIn: consoleSignIn, session: console)
        self.wizard = WizardModel(steps: firstRun)
        self.menu = MenuBarModel(status: status, cli: cli)
        self.logs = LogViewerModel(cli: cli)
        let shell = ShellModel(stores: console.stores, defaults: defaults)
        self.shell = shell
        let needsYou = NeedsYouModel(session: console)
        self.needsYou = needsYou
        let chat = ChatModel(session: console)
        self.chat = chat
        // An answer here moves the count: the row and the Dock hear it now,
        // not at the shell's next tick.
        needsYou.onQueueChanged = { [weak shell] in await shell?.refreshCount() }
        self.activity = ActivityModel(session: console)
        let composer = CaptureComposerModel(session: console, queueStore: JSONCaptureQueueStore())
        self.composer = composer
        // The one door the composer opens by: Capture ▸ New Capture, the
        // toolbar's + and ⌘N are all this entry.
        shell.captureActions[.newCapture] = { [weak composer] in composer?.present() }
        // The queue file's key (ruling 19): the same pointer every recents
        // list and `METISTRY_INSTANCE_DIR` use, not `metistry identity`'s id
        // — that resolves over a CLI round trip, this is already known.
        composer.currentInstanceID = { [weak instances] in instances?.active?.path }
        composer.loadPersistedQueue()
        self.today = TodayModel(session: console, defaults: defaults)
        let knowledge = KnowledgeModel(session: console)
        self.knowledge = knowledge
        // An answer or a settled conflict on Knowledge is Needs You's too: the row and the Dock hear it now.
        knowledge.onQueueChanged = { [weak shell] in await shell?.refreshCount() }
        self.scheduled = ScheduledModel(session: console)
        self.agents = AgentsModel(session: console)
        self.board = BoardModel(session: console)
        self.projects = ProjectsModel(session: console)
        let vaultHistory = VaultHistoryModel(session: console)
        self.vaultHistory = vaultHistory
        // A rollback asked for is a request: the row and the Dock hear it now.
        vaultHistory.onQueueChanged = { [weak shell] in await shell?.refreshCount() }
        self.artifacts = ArtifactsModel(session: console)
        self.runDetail = RunDetailModel(session: console)
        // The bar: no bridge wired (every test) is no bar. The key is filed
        // under the instance's id, which only the console's identity says.
        let liveCaptureClient: any LiveCaptureClient = liveCapture.map { wired in
            BridgeLiveCaptureClient(transport: wired.transport, keys: wired.keys, instanceID: { [weak shell] in shell?.identity?.instanceID })
        } ?? AbsentLiveCaptureClient()
        let captureBar = CaptureBarModel(client: liveCaptureClient, composer: composer, chat: chat)
        captureBar.assistantName = { [weak shell] in shell?.assistantName }
        captureBar.onActions = { [weak shell] lit in
            guard let shell else { return }
            for command in CaptureBarModel.menuItems { shell.captureActions[command] = lit[command] }
        }
        self.captureBar = captureBar
        let hotKeys = AnyAppShortcutsModel(defaults: defaults)
        // A key pressed in any app runs its Capture item — the same door the
        // menu uses, so it can light nothing the menu could not.
        hotKeys.perform = { [weak shell] command in
            guard let shell, shell.canPerform(command) else { return false }
            shell.perform(command)
            return true
        }
        self.hotKeys = hotKeys

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

    /// Starts following the live-capture bridge — the bar appears once it
    /// answers. Called once by the app, never from `init`.
    public func startCaptureBar() {
        captureBar.start()
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
        // The bar's key belongs to the instance it was read for.
        captureBar.adopt()
    }
}

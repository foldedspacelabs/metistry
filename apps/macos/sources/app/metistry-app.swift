// The Metistry Mac app.
//
// Six scenes: the window, the `Settings` scene (⌘, and the app menu — every
// configuration the app has, and each one a front for a file the CLI owns), a
// log window the menu bar opens, the Status window (doctor's panel, which left
// the sidebar when the eight rows arrived — T5-2), Help ▸ Keyboard Shortcuts,
// and the menu-bar item itself. The menus are `ShellCommands` (MetistryKit):
// every shortcut in the app is one of its items (C119). Everything the
// app knows how to do, it does by running a `metistry` verb — it opens no
// database connection and shells out to no git of its own (invariant 3;
// invariant 9's spirit applied to the client).
//
// This target is where the platform lives: `MenuBarExtra`, Sparkle, `Process`,
// and the three AppKit calls MetistryKit will not make (reveal in Finder, quit,
// and Sparkle's own UI). MetistryKit has no AppKit and no `Process` in it, so an
// iOS target shares every model and every view unchanged.
//
// The assistant's name is nowhere in this target, or in MetistryKit. It comes
// from the instance's identity.yaml — Settings reads it there and offers no
// field to change it, because it is a §4.7 protected path.

import AppKit
import MetistryKit
import SwiftUI

@main
struct MetistryApp: App {
    @State private var model: AppModel
    #if os(macOS)
    @State private var updater: UpdaterController
    #endif
    @Environment(\.openWindow) private var openWindow

    init() {
        // Resources/metistry/ is where build-app.sh embeds the runtime pack and
        // the runtime-deps pack. Running the raw executable out of .build/ has
        // no bundle resources, and the locator says so rather than guessing.
        let resources = Bundle.main.resourceURL
        let runner = ProcessCommandRunner(extraPathDirectories: RuntimeLocator.binaryCandidateDirectories)
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        let model = AppModel(
            bundleResourceURL: resources,
            runner: runner,
            appVersion: version ?? UpdateStatus.devBuildVersion,
            // The platform seams MetistryKit declares and does not have:
            // ServiceManagement — twice, because the app as a login item and
            // the install's one background item are two registrations —
            // AuthenticationServices…
            loginItemService: SMAppServiceLoginItem(),
            backgroundAgentService: SMAppServiceBackgroundAgent(),
            passkeyRegistrar: ASAuthorizationPasskeyRegistrar(),
            // …and `Process` a second time, held open: the one
            // `metistry console session --stdio` child the stores speak through.
            sessionSpawner: runner
        )
        _model = State(initialValue: model)
        // The shell polls for the app's lifetime, not a window's, and the Dock
        // tile carries the Needs You badge (N9) — the same label as the row,
        // nothing at zero.
        model.startShell(dockBadge: { label in NSApplication.shared.dockTile.badgeLabel = label })
        #if os(macOS)
        // Sparkle fills in the kit's plain UpdateStatus box: the kit stays free
        // of the framework, and the Updates pane and the menu read one type.
        _updater = State(initialValue: UpdaterController(status: model.updates))
        #endif
    }

    var body: some Scene {
        // The title is the product's on every screen (brand-kit, 2026-09-19).
        WindowGroup(ShellTitle.window, id: Self.mainWindowID) {
            RootView(model: model)
                .frame(minWidth: 720, minHeight: 460)
                .sheet(isPresented: Binding(get: { model.wizard.isPresented }, set: { model.wizard.isPresented = $0 })) {
                    WizardView(
                        model: model.wizard,
                        bridges: model.status.report?.bridges ?? [],
                        resolvedShape: model.status.report?.deployment?.shape,
                        consoleURL: PasskeyRouting.consoleURL(in: model.status.report),
                        developerProductDir: model.developerProductDir,
                        onRelocate: { model.relocate() },
                        onChooseDeveloperProductDirectory: { model.chooseDeveloperProductDirectory($0) }
                    )
                }
        }
        .defaultSize(width: 980, height: 640)
        #if os(macOS)
        .commands {
            CommandGroup(after: .appInfo) {
                CheckForUpdatesCommand(updater: updater)
            }
            ShellCommands(shell: model.shell)
        }
        #endif

        #if os(macOS)
        Settings {
            SettingsView(
                model: model,
                onOpenInFinder: { url in NSWorkspace.shared.activateFileViewerSelecting([url]) },
                onSetUpAgain: { model.wizard.present(); openWindow(id: Self.mainWindowID) }
            )
        }

        Window("Log", id: Self.logWindowID) {
            LogWindowView(model: model.logs)
        }
        .defaultSize(width: 760, height: 520)

        // Doctor's panel, reached from the Window menu. Settings' Services pane
        // says "Run doctor from the Status window", and this is that window.
        Window("Status", id: ShellWindowID.status) {
            StatusPanel(model: model.status, signIn: model.consoleSignIn, runtime: model.runtime)
                .frame(minWidth: 560, minHeight: 420)
        }
        .defaultSize(width: 760, height: 600)

        // Help ▸ Keyboard Shortcuts (⌘/): the menus' own table, on one page.
        Window("Keyboard Shortcuts", id: ShellWindowID.keyboardShortcuts) {
            KeyboardShortcutsView(shell: model.shell)
        }
        .defaultSize(width: 560, height: 640)

        MenuBarExtra {
            // MenuBarContent's own summary item carries the open/close hook, so
            // doctor is re-run when the menu appears and every 30s while it
            // stays open (menu-model.swift explains why not continuously).
            MenuBarContent(
                model: model.menu,
                updates: model.updates,
                signIn: model.consoleSignIn,
                openWindow: { openWindow(id: Self.mainWindowID) },
                openLog: { component in
                    Task { await model.logs.load(component: component) }
                    openWindow(id: Self.logWindowID)
                },
                onQuit: { NSApplication.shared.terminate(nil) }
            )
        } label: {
            // The worst *fault* across components becomes the glyph; `absent`
            // never drives it, because a bridge that was never configured is
            // not a fault (§3.13, and doctor's own exit-code rule).
            Image(systemName: model.status.menuBarState?.symbolName ?? "circle.dotted")
        }
        #endif
    }

    static let mainWindowID = ShellWindowID.main
    static let logWindowID = "log"
}

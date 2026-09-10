// The Metistry Mac app.
//
// Four scenes: the window, the `Settings` scene (⌘, and the app menu — every
// configuration the app has, and each one a front for a file the CLI owns), a
// log window the menu bar opens, and the menu-bar item itself. Everything the
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
            // The three platform seams MetistryKit declares and does not have:
            // ServiceManagement, AuthenticationServices, and a terminal.
            loginItemService: SMAppServiceLoginItem(),
            passkeyRegistrar: ASAuthorizationPasskeyRegistrar(),
            terminalOpener: DotCommandTerminalOpener()
        )
        _model = State(initialValue: model)
        #if os(macOS)
        // Sparkle fills in the kit's plain UpdateStatus box: the kit stays free
        // of the framework, and the Updates pane and the menu read one type.
        _updater = State(initialValue: UpdaterController(status: model.updates))
        #endif
    }

    var body: some Scene {
        WindowGroup(id: Self.mainWindowID) {
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

        MenuBarExtra {
            // MenuBarContent's own summary item carries the open/close hook, so
            // doctor is re-run when the menu appears and every 30s while it
            // stays open (menu-model.swift explains why not continuously).
            MenuBarContent(
                model: model.menu,
                updates: model.updates,
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

    static let mainWindowID = "main"
    static let logWindowID = "log"
}

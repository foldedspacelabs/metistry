// The Metistry Mac app.
//
// One window and one menu-bar item (design-system §3.13: the menu-bar item
// mirrors doctor). Everything the app knows how to do, it does by running a
// `metistry` verb — it opens no database connection and shells out to no git
// of its own (invariant 3; invariant 9's spirit applied to the client).
//
// The assistant's name is nowhere in this target, or in MetistryKit. It comes
// from the instance's identity.yaml, and the only place the app touches it is
// the text field on first-run step 2, which sends it to `metistry init --name`.

import MetistryKit
import SwiftUI

@main
struct MetistryApp: App {
    @State private var model: AppModel
    #if os(macOS)
    @State private var updater = UpdaterController()
    #endif
    @Environment(\.openWindow) private var openWindow

    init() {
        // Resources/metistry/ is where build-app.sh embeds the runtime pack and
        // the runtime-deps pack. Running the raw executable out of .build/ has
        // no bundle resources, and the locator says so rather than guessing.
        let resources = Bundle.main.resourceURL
        let runner = ProcessCommandRunner(extraPathDirectories: RuntimeLocator.binaryCandidateDirectories)
        _model = State(initialValue: AppModel(bundleResourceURL: resources, runner: runner))
    }

    var body: some Scene {
        WindowGroup(id: Self.mainWindowID) {
            RootView(model: model)
                .frame(minWidth: 720, minHeight: 460)
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
        MenuBarExtra {
            MenuBarContent(model: model.status) {
                openWindow(id: Self.mainWindowID)
            }
        } label: {
            // The worst *fault* across components becomes the glyph; `absent`
            // never drives it, because a bridge that was never configured is
            // not a fault (§3.13, and doctor's own exit-code rule).
            Image(systemName: model.status.menuBarState?.symbolName ?? "circle.dotted")
        }
        #endif
    }

    static let mainWindowID = "main"
}

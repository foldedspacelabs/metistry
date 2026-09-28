// Settings ▸ Account (screen-15 §1): the old *Connections* — who the console
// takes this Mac to be, and the instance repository. Renamed because the old
// name read as a sibling of the external servers, which are Connections now.

import SwiftUI

struct AccountPane: View {
    @Environment(\.colorScheme) private var scheme
    let model: AppModel
    let actions: SettingsActions

    private var settings: SettingsModel { model.settings }

    var body: some View {
        let p = Palette(scheme)
        SettingsSection("Console Sign-In") {
            ConsoleSignInCard(model: settings.consoleSignIn, title: "This Mac")
            Text(SettingsModel.consoleSignInNote)
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .task(id: model.instances.active) { await settings.consoleSignIn.refreshIfNeeded() }

        SettingsSection("Instance Repository") {
            FactRow("Status", settings.repositoryStatus)
            if let facts = settings.reconciler {
                if let head = facts.head {
                    FactRow("HEAD", String(head.prefix(12)), mono: true)
                }
                if let depth = facts.queueDepth {
                    FactRow("Queue depth", String(depth), help: "Writes waiting for the reconciler's next commit.", mono: true)
                }
            }
            Text("Reported by the reconciler, which is the sole committer — the app runs no git of its own. `metistry connect-repo` adds or changes a remote; Set Up Again's step 3 runs it.")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
            Button("Connect a Repository…", action: actions.setUpAgain)
        }
    }
}

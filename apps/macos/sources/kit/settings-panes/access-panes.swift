// Settings ▸ the panes whose own tickets have not landed (Live Capture,
// Sessions). Connections is connections-view.swift (T6-13a); Secrets and
// Variables are secrets-view.swift and variables-view.swift (T6-14).
//
// A pane not built yet says what it will hold and which verb does it today:
// never a dead end (C138).

import SwiftUI

struct PendingPane: View {
    @Environment(\.colorScheme) private var scheme
    let section: SettingsModel.Section

    var body: some View {
        let p = Palette(scheme)
        SettingsSection(section.title) {
            Text(section.pendingNote ?? "")
                .metistryText(.callout, p, .textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

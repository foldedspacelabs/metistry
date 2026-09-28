// Settings ▸ Keyboard (screen-15 §5.5, components-02 §2, C120/C127): one
// switch, *Shortcuts in any app*, off by default, and the five shortcuts under
// it. In-app shortcuts are always on — Show All opens Help ▸ Keyboard
// Shortcuts (⌘/).
//
// Registering a system-wide hot key is T6-16's (the recorder, the Taken /
// System checks, nothing registered until every row is clear). Until it lands
// the switch is off and dimmed with its reason, and this app registers
// nothing — which is exactly what *off* means (§2.18.2).

import SwiftUI

struct KeyboardPane: View {
    @Environment(\.colorScheme) private var scheme
    let assistantName: String?
    let actions: SettingsActions

    var body: some View {
        let p = Palette(scheme)
        SettingsSection("Shortcuts in Any App") {
            Toggle("Shortcuts in any app", isOn: .constant(false))
                .disabled(true)
            Text(AnyAppShortcut.notYet)
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(AnyAppShortcut.allCases, id: \.self) { shortcut in
                HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s3) {
                    Text(shortcut.command.title(assistantName: assistantName))
                        .metistryText(.callout, p, .textSecondary)
                    Spacer(minLength: MetistrySpace.s2)
                    Text(shortcut.suggested)
                        .metistryText(.mono, p, .textTertiary)
                }
                .accessibilityElement(children: .combine)
            }
        }
        SettingsSection("In This App") {
            Text("The in-app shortcuts are always on, and every one is also a menu item.")
                .metistryText(.callout, p)
                .fixedSize(horizontal: false, vertical: true)
            SettingsControls {
                Button("Show All", action: actions.showShortcuts)
                    .accessibilityLabel("Show all keyboard shortcuts, Command slash")
                Text("⌘/").metistryText(.mono, p, .textTertiary).accessibilityHidden(true)
            }
        }
    }
}

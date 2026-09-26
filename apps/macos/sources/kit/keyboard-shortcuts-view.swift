// Help ▸ Keyboard Shortcuts (⌘/): every shortcut in the app, on one page
// (C119, components-02 §1). The menu half is read from `ShellCommand` — the
// table the menus are built from — so the page cannot list a key the menus do
// not have. The per-screen half is components-02's second table, verbatim.

import SwiftUI

/// components-02 §1, "Per screen".
public struct ScreenKeys: Sendable, Equatable, Identifiable {
    public let screen: String
    public let keys: String
    public var id: String { screen }

    public static let all: [ScreenKeys] = [
        ScreenKeys(screen: "Any list", keys: "↑ ↓ move · ↩ open · Space select · ⌘A select all · M move to…"),
        ScreenKeys(screen: "Needs You", keys: "A R D approve, revise, decline · L later · 1–9 pick an answer · ⌘↩ send answers"),
        ScreenKeys(screen: "Today", keys: "Space complete · ⌘Z undo · ⌥⌘T Today / All · ⇧⌘P hand to an agent · ⌘C copy standup"),
        ScreenKeys(screen: "Chat", keys: "⌘↩ send · ↑ edit last message · ⇧⌘N new conversation"),
        ScreenKeys(screen: "Activity", keys: "⌘R take pending rows"),
        ScreenKeys(screen: "Scheduled", keys: "⌘R Run Now / Sync Now · ⌥⌘P Pause"),
        ScreenKeys(screen: "Agents", keys: "⌘S save definition · ⌘⌫ revoke, confirmed"),
        ScreenKeys(screen: "Board", keys: "← → between columns · M move"),
        ScreenKeys(screen: "Knowledge, Projects, Artifacts, Run detail", keys: "the list keys and ⌘O"),
        ScreenKeys(screen: "Settings, Connections, Secrets, Variables, Usage", keys: "the list keys; Tab through fields"),
    ]
}

public struct KeyboardShortcutsView: View {
    @Environment(\.colorScheme) private var scheme
    private let shell: ShellModel

    public init(shell: ShellModel) {
        self.shell = shell
    }

    /// Each menu's items that carry a key, in menu order.
    nonisolated static func rows(_ menu: ShellMenu) -> [ShellCommand] {
        menu.groups.joined().filter { $0.shortcut != nil }
    }

    public var body: some View {
        let p = Palette(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: MetistrySpace.s5) {
                ForEach(ShellMenu.allCases.filter { !Self.rows($0).isEmpty }, id: \.self) { menu in
                    VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                        Text(menu.rawValue)
                            .metistryText(.headline, p)
                            .accessibilityAddTraits(.isHeader)
                        ForEach(Self.rows(menu), id: \.self) { command in
                            row(command.title(assistantName: shell.assistantName), keys: command.shortcut?.glyphs ?? "", spokenKeys: command.shortcut?.spoken ?? "", p)
                        }
                    }
                }
                VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                    Text("By Screen")
                        .metistryText(.headline, p)
                        .accessibilityAddTraits(.isHeader)
                    ForEach(ScreenKeys.all) { entry in
                        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                            Text(entry.screen).metistryText(.subhead, p)
                            Text(entry.keys)
                                .metistryText(.callout, p, .textSecondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
                Text("Single keys work while a list has focus, never in a text field. Shortcuts in any app are off until you turn them on in Settings › Keyboard.")
                    .metistryText(.footnote, p, .textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(MetistrySpace.s5)
            .frame(maxWidth: MetistrySize.contentMax, alignment: .leading)
        }
        .background(p[.bg])
    }

    private func row(_ title: String, keys: String, spokenKeys: String, _ p: Palette) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s3) {
            Text(title)
                .metistryText(.body, p)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: MetistrySpace.s3)
            Text(keys)
                .metistryText(.body, p, .textSecondary)
                .monospacedDigit()
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title), \(spokenKeys)")
    }
}

// Help ▸ Keyboard Shortcuts (⌘/): every shortcut in the app, on one page
// (C119, components-02 §1). The menu half is read from `ShellCommand` — the
// table the menus are built from — so the page cannot list a key the menus do
// not have. The per-screen half is components-02's second table, verbatim,
// from `ScreenKeys` (hotkeys.swift), and a key it documents that the build
// does not bind says so here, with why — never a key that silently does
// nothing (T6-16). *Everywhere* is what macOS gives every sheet and field, and
// *In Any App* is the five of Settings ▸ Keyboard as they stand.

import SwiftUI

public struct KeyboardShortcutsView: View {
    @Environment(\.colorScheme) private var scheme
    private let shell: ShellModel
    private let anyApp: AnyAppShortcutsModel?

    public init(shell: ShellModel, anyApp: AnyAppShortcutsModel? = nil) {
        self.shell = shell
        self.anyApp = anyApp
    }

    /// A row of *In Any App*: the key while it is registered, otherwise why not.
    nonisolated static func anyAppKeys(_ row: AnyAppShortcut, isOn: Bool, key: MenuShortcut?, registered: Bool) -> (glyphs: String, spoken: String) {
        guard isOn else { return ("Off", "off") }
        guard let key else { return ("Not set", "not set") }
        guard registered else { return ("\(key.glyphs), not registered", "\(key.spoken), not registered") }
        return (key.glyphs, key.spoken)
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
                        keysBlock(entry.screen, keys: entry.keys, unbound: entry.unbound.compactMap(\.unboundNote), p)
                    }
                }
                VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                    Text("Everywhere")
                        .metistryText(.headline, p)
                        .accessibilityAddTraits(.isHeader)
                    ForEach(KeyTable.everywhere) { key in
                        row(key.meaning.prefix(1).uppercased() + key.meaning.dropFirst(), keys: key.keys, spokenKeys: DocumentedKey.spoken(key.keys), p)
                    }
                }
                if let anyApp {
                    VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                        Text("In Any App")
                            .metistryText(.headline, p)
                            .accessibilityAddTraits(.isHeader)
                        ForEach(AnyAppShortcut.allCases, id: \.self) { item in
                            let keys = Self.anyAppKeys(item, isOn: anyApp.isOn, key: anyApp.keys[item], registered: anyApp.registered.contains(item))
                            row(item.command.title(assistantName: shell.assistantName), keys: keys.glyphs, spokenKeys: keys.spoken, p)
                        }
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

    /// A screen's keys, and under them each one it documents and does not bind.
    private func keysBlock(_ screen: String, keys: String, unbound: [String], _ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            Text(screen).metistryText(.subhead, p)
            Text(keys)
                .metistryText(.callout, p, .textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(unbound, id: \.self) { note in
                Text(note)
                    .metistryText(.footnote, p, .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
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

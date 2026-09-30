// Settings ▸ Keyboard (screen-15 §5.5, components-02 §2, C120/C127): one
// switch, *Shortcuts in any app*, off by default, and the five shortcuts under
// it. In-app shortcuts are always on — Show All opens Help ▸ Keyboard
// Shortcuts (⌘/).
//
// Each of the five is a recorder: *Record Shortcut* · *Press a shortcut…* ·
// the keys with ×. A row is checked as it is set (hotkeys.swift): *Another app
// already uses this* in failed ink when macOS refused the registration,
// *macOS uses this to …* as a warning for a system shortcut, and nothing is
// registered until every row is clear. Off registers nothing, and the rows
// are dimmed. A row whose command nothing answers yet (the capture bar is
// T8's) says so rather than letting its key do nothing silently.

import SwiftUI

struct KeyboardPane: View {
    @Environment(\.colorScheme) private var scheme
    let assistantName: String?
    let actions: SettingsActions
    @Bindable var shortcuts: AnyAppShortcutsModel
    /// Whether a command has something behind it now (`ShellModel.canPerform`).
    let isAnswered: (ShellCommand) -> Bool

    var body: some View {
        let p = Palette(scheme)
        SettingsSection("Shortcuts in Any App") {
            Toggle("Shortcuts in any app", isOn: Binding(get: { shortcuts.isOn }, set: { shortcuts.setOn($0) }))
            Text(KeyboardPaneWords.summary(isOn: shortcuts.isOn, registered: shortcuts.registered.count, conflicts: shortcuts.conflicts.count))
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(AnyAppShortcut.allCases, id: \.self) { row in
                AnyAppShortcutRow(
                    row: row,
                    title: row.command.title(assistantName: assistantName),
                    shortcuts: shortcuts,
                    conflict: shortcuts.conflicts[row],
                    conflictSentence: shortcuts.conflicts[row]?.sentence(assistantName: assistantName),
                    unanswered: isAnswered(row.command) ? nil : KeyboardPaneWords.unanswered
                )
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

/// The pane's sentences, in one place for the tests.
enum KeyboardPaneWords {
    static let unanswered = "Nothing answers this yet: the capture bar is not in this build, so the key only beeps."
    static let recording = "Press a shortcut…"
    static let record = "Record Shortcut"

    static func summary(isOn: Bool, registered: Int, conflicts: Int) -> String {
        guard isOn else { return "Off: nothing is registered with macOS." }
        if conflicts > 0 { return "Nothing is registered until every row is clear." }
        if registered == 0 { return "On, with nothing registered." }
        return "On: these work in any app."
    }
}

/// One of the five: its name, the recorder, and what is wrong with it.
struct AnyAppShortcutRow: View {
    @Environment(\.colorScheme) private var scheme
    let row: AnyAppShortcut
    let title: String
    @Bindable var shortcuts: AnyAppShortcutsModel
    let conflict: HotKeyConflict?
    let conflictSentence: String?
    let unanswered: String?
    @FocusState private var recorderFocused: Bool

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s3) {
                Text(title)
                    .metistryText(.callout, p, shortcuts.isOn ? .textPrimary : .textSecondary)
                    .accessibilityHidden(true)
                Spacer(minLength: MetistrySpace.s2)
                recorder(p)
            }
            if let conflictSentence, let conflict {
                Text(conflictSentence)
                    .metistryText(.caption1, p, conflict.isWarning ? .degraded : .failed)
                    .fixedSize(horizontal: false, vertical: true)
            } else if shortcuts.isOn, shortcuts.keys[row] != nil, let unanswered {
                Text(unanswered)
                    .metistryText(.caption1, p, .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .disabled(!shortcuts.isOn)
    }

    @ViewBuilder
    private func recorder(_ p: Palette) -> some View {
        if shortcuts.recording == row {
            Text(KeyboardPaneWords.recording)
                .metistryText(.callout, p, .textSecondary)
                .padding(.horizontal, MetistrySpace.s3)
                .padding(.vertical, MetistrySpace.s1)
                .overlay(Capsule().strokeBorder(p[.focusRing], lineWidth: 2))
                .focusable()
                .focused($recorderFocused)
                .focusEffectDisabled()
                .onAppear { recorderFocused = true }
                .onChange(of: recorderFocused) { _, focused in if !focused { shortcuts.cancelRecording() } }
                .onKeyPress(phases: .down) { press in
                    if press.key == .escape {
                        shortcuts.cancelRecording()
                        return .handled
                    }
                    if let shortcut = MenuShortcut.recorded(character: press.characters, modifiers: MenuShortcut.Modifiers(press.modifiers)) {
                        shortcuts.record(shortcut)
                    }
                    return .handled
                }
                .accessibilityLabel("\(title), press a shortcut")
                .accessibilityAddTraits(.isButton)
        } else if let key = shortcuts.keys[row] {
            HStack(spacing: MetistrySpace.s1) {
                Button(key.glyphs) { shortcuts.beginRecording(row) }
                    .accessibilityLabel("\(title), \(key.spoken). Change")
                Button { shortcuts.clear(row) } label: { Image(systemName: "xmark.circle.fill") }
                    .buttonStyle(.plain)
                    .foregroundStyle(p[.textTertiary])
                    .accessibilityLabel("Clear the \(title) shortcut")
                    .help("Clear")
            }
        } else {
            Button(KeyboardPaneWords.record) { shortcuts.beginRecording(row) }
                .accessibilityLabel("\(title), no shortcut. \(KeyboardPaneWords.record)")
        }
    }
}

extension MenuShortcut.Modifiers {
    /// SwiftUI's modifiers, as the table's.
    init(_ modifiers: EventModifiers) {
        self = []
        if modifiers.contains(.control) { insert(.control) }
        if modifiers.contains(.option) { insert(.option) }
        if modifiers.contains(.shift) { insert(.shift) }
        if modifiers.contains(.command) { insert(.command) }
    }
}

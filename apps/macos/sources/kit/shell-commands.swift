// The menus (design-build-plan §2.18.1; components-02 §1, C119): every shortcut
// in the Mac app is a menu item, and every menu item is one `ShellCommand`.
//
// ONE TABLE, THREE READERS. `ShellCommand` is the closed list — its menu, its
// title, its key — and the menus, Help ▸ Keyboard Shortcuts and the tests all
// read it. A shortcut that is not here does not exist; a second place to
// declare one would be the drift this file exists to prevent.
//
// WHO ANSWERS AN ITEM. The shell answers Go and Capture (shell-model.swift).
// The focused screen answers its own few (Command Palette, Filter, New
// Conversation, Today / All) and the selection answers Item, each by
// publishing an action table (`shellScreenActions`, `shellItemActions`). A
// table can only light up a command of its own kind — the filter below is the
// enforcement — so no screen can add a menu item or take over another's. An
// item nobody answers is dimmed (components-02: "items that don't apply are
// dimmed").
//
// SINGLE KEYS ONLY WHILE A LIST HAS FOCUS. ↩ A R D L Space M are bare keys, and a
// bare key in the main menu is taken before a text field sees it: bound all the
// time, Approve would fire on the letter a. So those items carry their key only
// while a list publishes `shellListFocus()` — the key is not attached at all
// otherwise, not merely dimmed (a dimmed item still swallows its key).

import SwiftUI

// MARK: - A shortcut

/// A key and its modifiers, independent of SwiftUI so the table can be tested
/// and printed.
public struct MenuShortcut: Hashable, Sendable {
    public enum Key: Hashable, Sendable {
        case character(Character)
        case `return`
        case space
    }

    public struct Modifiers: OptionSet, Hashable, Sendable {
        public let rawValue: Int
        public init(rawValue: Int) { self.rawValue = rawValue }
        public static let control = Modifiers(rawValue: 1 << 0)
        public static let option = Modifiers(rawValue: 1 << 1)
        public static let shift = Modifiers(rawValue: 1 << 2)
        public static let command = Modifiers(rawValue: 1 << 3)
    }

    public let key: Key
    public let modifiers: Modifiers

    public init(_ key: Key, _ modifiers: Modifiers = []) {
        self.key = key
        self.modifiers = modifiers
    }

    static func command(_ c: Character, _ extra: Modifiers = []) -> MenuShortcut {
        MenuShortcut(.character(c), extra.union(.command))
    }

    /// No modifier: only while a list has focus.
    public var isSingleKey: Bool { modifiers.isEmpty }

    /// ⌃⌥⇧⌘, in Apple's order: `⌥⌘T`.
    public var glyphs: String {
        var out = ""
        if modifiers.contains(.control) { out += "⌃" }
        if modifiers.contains(.option) { out += "⌥" }
        if modifiers.contains(.shift) { out += "⇧" }
        if modifiers.contains(.command) { out += "⌘" }
        switch key {
        case .character(let c): out += String(c).uppercased()
        case .return: out += "↩"
        case .space: out += "Space"
        }
        return out
    }

    /// How VoiceOver says it after a control's name (components-02 §3):
    /// *Control-Option-Command-N*.
    public var spoken: String {
        var parts: [String] = []
        if modifiers.contains(.control) { parts.append("Control") }
        if modifiers.contains(.option) { parts.append("Option") }
        if modifiers.contains(.shift) { parts.append("Shift") }
        if modifiers.contains(.command) { parts.append("Command") }
        switch key {
        case .character(let c):
            switch c {
            case "[": parts.append("Left Bracket")
            case "]": parts.append("Right Bracket")
            case "/": parts.append("Slash")
            default: parts.append(String(c).uppercased())
            }
        case .return: parts.append("Return")
        case .space: parts.append("Space")
        }
        return parts.joined(separator: "-")
    }

    public var keyboardShortcut: KeyboardShortcut {
        var mods: EventModifiers = []
        if modifiers.contains(.control) { mods.insert(.control) }
        if modifiers.contains(.option) { mods.insert(.option) }
        if modifiers.contains(.shift) { mods.insert(.shift) }
        if modifiers.contains(.command) { mods.insert(.command) }
        switch key {
        case .character(let c): return KeyboardShortcut(KeyEquivalent(c), modifiers: mods)
        case .return: return KeyboardShortcut(.return, modifiers: mods)
        case .space: return KeyboardShortcut(.space, modifiers: mods)
        }
    }
}

// MARK: - The menus

public enum ShellMenu: String, CaseIterable, Sendable {
    case file = "File"
    case go = "Go"
    case capture = "Capture"
    case item = "Item"
    case view = "View"
    case help = "Help"

    /// The items, in order, a divider between groups.
    public var groups: [[ShellCommand]] {
        switch self {
        case .file:
            return [[.newConversation]]
        case .go:
            return [
                [.needsYou, .today, .chat, .activity, .work, .knowledge, .agents, .scheduled],
                [.back, .forward],
                [.commandPalette, .filter],
            ]
        case .capture:
            return [
                [.newCapture],
                [.ask, .note, .todo, .startRecording, .stopRecording],
                [.hideCaptureBar, .shortcutsInAnyApp],
            ]
        case .item:
            return [
                [.open, .openInObsidian],
                [.approve, .revise, .decline, .later],
                [.complete, .move, .handToAgent],
                [.runNow, .pause],
            ]
        case .view:
            return [[.todayOrAll, .toggleSidebar]]
        case .help:
            return [[.keyboardShortcuts]]
        }
    }
}

/// Every command the Mac app's menus hold (C119). Closed: a new one is a
/// product change to this enum, never a screen's own invention.
public enum ShellCommand: String, CaseIterable, Sendable {
    // File
    case newConversation
    // Go
    case needsYou, today, chat, activity, work, knowledge, agents, scheduled
    case back, forward, commandPalette, filter
    // Capture
    case newCapture, ask, note, todo, startRecording, stopRecording, hideCaptureBar, shortcutsInAnyApp
    // Item
    case open, openInObsidian, approve, revise, decline, later, complete, move, handToAgent, runNow, pause
    // View
    case todayOrAll, toggleSidebar
    // Help
    case keyboardShortcuts

    /// Who answers it.
    public enum Owner: Sendable, Equatable {
        /// `ShellModel`: Go, and Capture through `captureActions`.
        case shell
        /// The focused screen, through `shellScreenActions`.
        case screen
        /// The selection, through `shellItemActions`.
        case item
        /// A window the app opens.
        case window
        /// SwiftUI's own (`SidebarCommands`).
        case system
    }

    public var owner: Owner {
        switch self {
        case .newConversation, .commandPalette, .filter, .todayOrAll: return .screen
        case .open, .openInObsidian, .approve, .revise, .decline, .later, .complete, .move, .handToAgent, .runNow, .pause: return .item
        case .keyboardShortcuts: return .window
        case .toggleSidebar: return .system
        default: return .shell
        }
    }

    public var menu: ShellMenu {
        ShellMenu.allCases.first { $0.groups.joined().contains(self) } ?? .go
    }

    /// The Go item's section, for the eight rows.
    public var section: ShellSection? {
        switch self {
        case .today: return .today
        case .chat: return .chat
        case .activity: return .activity
        case .work: return .work
        case .knowledge: return .knowledge
        case .agents: return .agents
        case .scheduled: return .scheduled
        default: return nil
        }
    }

    /// HIG title case (C3). Ask carries the configured name, and with no name
    /// known yet it is just *Ask* — never a default name, never "assistant".
    public func title(assistantName: String?) -> String {
        switch self {
        case .newConversation: return "New Conversation"
        case .needsYou: return "Needs You"
        case .back: return "Back"
        case .forward: return "Forward"
        case .commandPalette: return "Command Palette"
        case .filter: return "Filter"
        case .newCapture: return "New Capture"
        case .ask: return assistantName.map { "Ask \($0)" } ?? "Ask"
        case .note: return "Note"
        case .todo: return "To-do"
        case .startRecording: return "Start Recording"
        case .stopRecording: return "Stop Recording"
        case .hideCaptureBar: return "Hide Capture Bar"
        case .shortcutsInAnyApp: return "Shortcuts in Any App…"
        case .open: return "Open"
        case .openInObsidian: return "Open in Obsidian"
        case .approve: return "Approve"
        case .revise: return "Revise"
        case .decline: return "Decline"
        case .later: return "Later"
        case .complete: return "Complete"
        case .move: return "Move…"
        case .handToAgent: return "Hand to an Agent…"
        case .runNow: return "Run Now"
        case .pause: return "Pause"
        case .todayOrAll: return "Today / All"
        case .toggleSidebar: return "Show Sidebar"
        case .keyboardShortcuts: return "Keyboard Shortcuts"
        default: return section?.title ?? rawValue
        }
    }

    /// components-02 §1, verbatim. The any-app five carry none here: they are
    /// system-wide hot keys, off until the owner turns them on (C120, T6-16).
    public var shortcut: MenuShortcut? {
        switch self {
        case .newConversation: return .command("n", .shift)
        case .needsYou: return .command("0")
        case .back: return .command("[")
        case .forward: return .command("]")
        case .commandPalette: return .command("k")
        case .filter: return .command("f")
        case .newCapture: return .command("n")
        case .open: return MenuShortcut(.return)
        case .openInObsidian: return .command("o")
        case .approve: return MenuShortcut(.character("a"))
        case .revise: return MenuShortcut(.character("r"))
        case .decline: return MenuShortcut(.character("d"))
        case .later: return MenuShortcut(.character("l"))
        case .complete: return MenuShortcut(.space)
        case .move: return MenuShortcut(.character("m"))
        case .handToAgent: return .command("p", .shift)
        case .runNow: return .command("r")
        case .pause: return .command("p", .option)
        case .todayOrAll: return .command("t", .option)
        case .toggleSidebar: return MenuShortcut(.character("s"), [.control, .command])
        case .keyboardShortcuts: return .command("/")
        default:
            if let section { return .command(Character(String(section.digit))) }
            return nil
        }
    }

    /// The key the menu item carries now. A single key is attached only while
    /// a list has focus — the tool, not the prompt, keeps *a* out of a text field.
    public func shortcut(listHasFocus: Bool) -> MenuShortcut? {
        guard let shortcut else { return nil }
        return shortcut.isSingleKey && !listHasFocus ? nil : shortcut
    }

    /// The name and the key, for a glyph-only control (components-02 §3).
    public func spokenLabel(assistantName: String?) -> String {
        let name = title(assistantName: assistantName).replacingOccurrences(of: "…", with: "")
        guard let shortcut else { return name }
        return "\(name), \(shortcut.spoken)"
    }
}

// MARK: - What screens publish

/// Actions a screen or a selection offers the menus, keyed by the command they
/// answer.
public typealias ShellActionTable = [ShellCommand: @MainActor () -> Void]

private struct ScreenActionsKey: FocusedValueKey {
    typealias Value = ShellActionTable
}

private struct ItemActionsKey: FocusedValueKey {
    typealias Value = ShellActionTable
}

private struct ListFocusKey: FocusedValueKey {
    typealias Value = Bool
}

public extension FocusedValues {
    var metistryScreenActions: ShellActionTable? {
        get { self[ScreenActionsKey.self] }
        set { self[ScreenActionsKey.self] = newValue }
    }

    var metistryItemActions: ShellActionTable? {
        get { self[ItemActionsKey.self] }
        set { self[ItemActionsKey.self] = newValue }
    }

    var metistryListFocus: Bool? {
        get { self[ListFocusKey.self] }
        set { self[ListFocusKey.self] = newValue }
    }
}

public extension ShellActionTable {
    /// Only the commands `owner` may answer — everything else is dropped.
    func answerable(by owner: ShellCommand.Owner) -> ShellActionTable {
        filter { $0.key.owner == owner }
    }
}

public extension View {
    /// A screen's own commands — Command Palette, Filter, New Conversation,
    /// Today / All. Anything else in the table is ignored.
    func shellScreenActions(_ actions: ShellActionTable) -> some View {
        focusedSceneValue(\.metistryScreenActions, actions.answerable(by: .screen))
    }

    /// What the selection offers the Item menu. Anything else is ignored.
    func shellItemActions(_ actions: ShellActionTable) -> some View {
        focusedSceneValue(\.metistryItemActions, actions.answerable(by: .item))
    }

    /// Put on a list: while it has focus, the Item menu's single keys work.
    func shellListFocus() -> some View {
        focusedValue(\.metistryListFocus, true)
    }
}

// MARK: - The window ids the menus open

public enum ShellWindowID {
    public static let main = "main"
    public static let keyboardShortcuts = "keyboard-shortcuts"
    public static let status = "status"
}

// MARK: - The menus

public struct ShellCommands: Commands {
    private let shell: ShellModel
    @FocusedValue(\.metistryScreenActions) private var screenActions
    @FocusedValue(\.metistryItemActions) private var itemActions
    @FocusedValue(\.metistryListFocus) private var listFocus
    @Environment(\.openWindow) private var openWindow

    public init(shell: ShellModel) {
        self.shell = shell
    }

    public var body: some Commands {
        // File: New Conversation takes ⇧⌘N (C119), and ⌘N goes to New Capture,
        // so the window group's New Window item is replaced rather than kept.
        CommandGroup(replacing: .newItem) { items(.file) }

        SwiftUI.CommandMenu(ShellMenu.go.rawValue) { items(.go) }
        SwiftUI.CommandMenu(ShellMenu.capture.rawValue) { items(.capture) }
        SwiftUI.CommandMenu(ShellMenu.item.rawValue) { items(.item) }

        // View: Today / All above SwiftUI's own Show Sidebar (⌃⌘S).
        CommandGroup(before: .sidebar) { item(.todayOrAll) }
        SidebarCommands()

        // Help: the one page of every shortcut. It replaces the default help
        // item, which would open a help book this app does not have.
        CommandGroup(replacing: .help) { item(.keyboardShortcuts) }
    }

    @ViewBuilder
    private func items(_ menu: ShellMenu) -> some View {
        ForEach(Array(menu.groups.enumerated()), id: \.offset) { index, group in
            if index > 0 { Divider() }
            ForEach(group.filter { $0.owner != .system }, id: \.self) { command in
                item(command)
            }
        }
    }

    @ViewBuilder
    private func item(_ command: ShellCommand) -> some View {
        let button = Button(command.title(assistantName: shell.assistantName)) { run(command) }
            .disabled(!isEnabled(command))
        if let shortcut = command.shortcut(listHasFocus: listFocus == true) {
            button.keyboardShortcut(shortcut.keyboardShortcut)
        } else {
            button
        }
    }

    private func isEnabled(_ command: ShellCommand) -> Bool {
        switch command.owner {
        case .shell: return shell.canPerform(command)
        case .screen: return screenActions?[command] != nil
        case .item: return itemActions?[command] != nil
        case .window, .system: return true
        }
    }

    private func run(_ command: ShellCommand) {
        switch command.owner {
        case .shell: shell.perform(command)
        case .screen: screenActions?[command]?()
        case .item: itemActions?[command]?()
        case .window: openWindow(id: ShellWindowID.keyboardShortcuts)
        case .system: break
        }
    }
}

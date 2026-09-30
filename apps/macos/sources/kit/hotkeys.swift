// Hot keys and the audit (T6-16; components-02 §1–§2, C119, C120, C127;
// design-build-plan §2.18.1–2).
//
// TWO THINGS LIVE HERE, and they are one idea: a key this app answers is a
// row in a closed table.
//
// THE CLOSED TABLE. `ShellCommand` (shell-commands.swift) is the menus: every
// shortcut is a menu item. `ScreenKeys` below is components-02 §1's second
// table, "Per screen", verbatim — and each of its keys says how it is bound:
// through a menu item, by a focused view's own handler in a named file, by
// macOS itself, or NOT AT ALL, with the reason. A key the design documents and
// the build does not bind is said to be unbound on Help ▸ Keyboard Shortcuts,
// never left to do nothing silently. `KeyTable.everywhere` is what macOS gives
// every sheet, popover and field, named so the audit can hold it too.
// `KeyTable.sites` is every place in the sources that binds a key, and
// `hotkeys-tests.swift` scans the sources and fails on a binding that is not
// one of them — so a screen cannot grow a key the table does not know.
//
// SHORTCUTS IN ANY APP (C120, C127). Settings ▸ Keyboard: one switch, off by
// default, and the five under it — Ask, Note, To-do, Start Recording, Stop
// Recording — each a recorder, suggested on ⌃⌥⌘ A N T R S. A row is checked
// when it is set: against macOS's own shortcuts (the symbolic-hotkeys domain —
// *System*, a warning), against this app's menus and the other four, and by
// registering it (`RegisterEventHotKey`, whose `eventHotKeyExistsErr` is
// *Taken* — another app holds it). NOTHING IS REGISTERED UNTIL EVERY ROW IS
// CLEAR: a registration pass that meets a conflict takes back every key it
// already registered, and off means nothing is registered at all. The Carbon
// call is the app target's (`sources/app/carbon-hot-keys.swift`); the kit
// holds the decision and a `HotKeyRegistrar` seam, so the rule is tested
// without touching the system.
//
// DEVICE-LOCAL (plan §2.2: "global hot keys … no CLI and no API"). The switch
// and the five keys are this Mac's, so they are the one setting the app keeps
// in its own defaults (`AppPreference.anyAppShortcuts`) — there is no file the
// CLI owns for them to front.

import Foundation
import Observation
import SwiftUI

// MARK: - The closed table: keys by screen

/// How a documented key is bound.
public enum KeyBinding: Sendable, Equatable {
    /// Menu items of the closed table (C119): the key is the item's.
    case menu([ShellCommand])
    /// A focused view's own handler; `KeyTable.sites` names the file.
    case view
    /// macOS's own — a list's selection, Edit ▸ Undo, Tab.
    case platform(String)
    /// Documented, and not bound. The reason is said wherever the key is listed.
    case unbound(String)

    public var isBound: Bool {
        if case .unbound = self { return false }
        return true
    }
}

/// One key of components-02's tables, and how the build binds it.
public struct DocumentedKey: Sendable, Equatable, Identifiable {
    /// Stable, for the audit: `KeySite.implements` points here.
    public let id: String
    /// The keys, as the design writes them: `A R D`, `⌘↩`.
    public let keys: String
    /// What they do, as the design writes it.
    public let meaning: String
    public let binding: KeyBinding

    public init(_ id: String, _ keys: String, _ meaning: String, _ binding: KeyBinding) {
        self.id = id
        self.keys = keys
        self.meaning = meaning
        self.binding = binding
    }

    /// `⌘R take pending rows`, or `the list keys` where the design names no key.
    public var text: String { keys.isEmpty ? meaning : "\(keys) \(meaning)" }

    /// Glyphs as VoiceOver should say them: `⌘, ⌘Q` → *Command-Comma, Command-Q*.
    public static func spoken(_ glyphs: String) -> String {
        let modifierNames: [Character: String] = ["⌃": "Control", "⌥": "Option", "⇧": "Shift", "⌘": "Command"]
        let keyNames: [String: String] = [
            "↩": "Return", "←": "Left Arrow", "→": "Right Arrow", "↑": "Up Arrow", "↓": "Down Arrow",
            "⌫": "Delete", ",": "Comma", "/": "Slash", "[": "Left Bracket", "]": "Right Bracket",
        ]
        return glyphs.split(separator: " ").map { token -> String in
            var parts: [String] = []
            var rest = Substring(token)
            while let first = rest.first, let name = modifierNames[first] {
                parts.append(name)
                rest = rest.dropFirst()
            }
            let key = rest.hasSuffix(",") && rest.count > 1 ? String(rest.dropLast()) : String(rest)
            if !key.isEmpty { parts.append(keyNames[key] ?? key) }
            return parts.joined(separator: "-")
        }.joined(separator: ", ")
    }

    /// What Help ▸ Keyboard Shortcuts says of an unbound key.
    public var unboundNote: String? {
        guard case .unbound(let why) = binding else { return nil }
        return "\(text): not bound. \(why)"
    }
}

/// components-02 §1, "Per screen": one row per screen, each key with its binding.
public struct ScreenKeys: Sendable, Equatable, Identifiable {
    public let screen: String
    public let entries: [DocumentedKey]
    public var id: String { screen }

    /// The row as components-02 prints it.
    public var keys: String { entries.map(\.text).joined(separator: " · ") }
    /// The keys on this row that are documented and not bound.
    public var unbound: [DocumentedKey] { entries.filter { !$0.binding.isBound } }

    public static let all: [ScreenKeys] = [
        ScreenKeys(screen: "Any list", entries: [
            DocumentedKey("list.move", "↑ ↓", "move", .platform("the list's own selection")),
            DocumentedKey("list.open", "↩", "open", .menu([.open])),
            DocumentedKey("list.select", "Space", "select", .unbound("Space is Item ▸ Complete where a row can be completed; ↑ ↓ or a click selects.")),
            DocumentedKey("list.selectAll", "⌘A", "select all", .platform("Edit ▸ Select All, in a list that takes several")),
            DocumentedKey("list.moveTo", "M", "move to…", .menu([.move])),
        ]),
        ScreenKeys(screen: "Needs You", entries: [
            DocumentedKey("needsYou.decide", "A R D", "approve, revise, decline", .menu([.approve, .revise, .decline])),
            DocumentedKey("needsYou.later", "L", "later", .menu([.later])),
            DocumentedKey("needsYou.pick", "1–9", "pick an answer", .view),
            DocumentedKey("needsYou.send", "⌘↩", "send answers", .view),
        ]),
        ScreenKeys(screen: "Today", entries: [
            DocumentedKey("today.complete", "Space", "complete", .unbound("A task ticks with one click; Today does not answer Item ▸ Complete yet.")),
            DocumentedKey("today.undo", "⌘Z", "undo", .platform("Edit ▸ Undo: a tick registers its undo")),
            DocumentedKey("today.mode", "⌥⌘T", "Today / All", .menu([.todayOrAll])),
            DocumentedKey("today.hand", "⇧⌘P", "hand to an agent", .unbound("No route hands a task to an agent yet.")),
            DocumentedKey("today.copy", "⌘C", "copy standup", .unbound("Copy Standup is the standup's own button.")),
        ]),
        ScreenKeys(screen: "Chat", entries: [
            DocumentedKey("chat.send", "⌘↩", "send", .view),
            DocumentedKey("chat.recall", "↑", "edit last message", .view),
            DocumentedKey("chat.new", "⇧⌘N", "new conversation", .menu([.newConversation])),
        ]),
        ScreenKeys(screen: "Activity", entries: [
            DocumentedKey("activity.take", "⌘R", "take pending rows", .unbound("Screen 2's keys were dropped for now (W2 ruling 24); Take Pending is a control.")),
        ]),
        ScreenKeys(screen: "Scheduled", entries: [
            DocumentedKey("scheduled.run", "⌘R", "Run Now / Sync Now", .menu([.runNow])),
            DocumentedKey("scheduled.pause", "⌥⌘P", "Pause", .menu([.pause])),
        ]),
        ScreenKeys(screen: "Agents", entries: [
            DocumentedKey("agents.save", "⌘S", "save definition", .unbound("Save is a button (W2 ruling 24).")),
            DocumentedKey("agents.revoke", "⌘⌫", "revoke, confirmed", .unbound("Revoke is a button, and it confirms (W2 ruling 24).")),
        ]),
        ScreenKeys(screen: "Board", entries: [
            DocumentedKey("board.columns", "← →", "between columns", .view),
            DocumentedKey("board.move", "M", "move", .menu([.move])),
        ]),
        ScreenKeys(screen: "Knowledge, Projects, Artifacts, Run detail", entries: [
            DocumentedKey("detail.list", "", "the list keys", .platform("the Any list row")),
            DocumentedKey("detail.obsidian", "⌘O", "open in Obsidian", .menu([.openInObsidian])),
        ]),
        ScreenKeys(screen: "Settings, Connections, Secrets, Variables, Usage", entries: [
            DocumentedKey("settings.list", "", "the list keys", .platform("the Any list row")),
            DocumentedKey("settings.tab", "Tab", "through fields", .platform("macOS's own")),
        ]),
    ]
}

// MARK: - The closed table: what macOS gives everything

public enum KeyTable {
    /// Keys every sheet, popover and field answers the way macOS's own do.
    /// Not components-02's to list, and bound all the same — so named here,
    /// and shown on Help ▸ Keyboard Shortcuts under *Everywhere*.
    public static let everywhere: [DocumentedKey] = [
        DocumentedKey("everywhere.default", "↩", "the default button of a sheet", .platform("the sheet's default action")),
        DocumentedKey("everywhere.escape", "Esc", "cancels a sheet, closes a popover, the capture bar's panel or an editor, leaves a field", .platform("cancel")),
        DocumentedKey("everywhere.press", "↩", "presses the focused New Reply pill", .platform("a focused control")),
        DocumentedKey("everywhere.fold", "← →", "fold and unfold a row that folds", .platform("an outline's own keys")),
        DocumentedKey("everywhere.capture", "⌘↩", "Capture, in New Capture", .platform("the composer's send")),
        DocumentedKey("everywhere.app", "⌘, ⌘Q", "Settings… and Quit, in the menu bar item", .platform("the app menu's own")),
    ]

    /// Every documented key, by id.
    public static var documented: [DocumentedKey] {
        ScreenKeys.all.flatMap(\.entries) + everywhere
    }

    /// `KeySite.implements` for the menus themselves: every `ShellCommand`.
    public static let menuTable = "menus"
    /// `KeySite.implements` for Settings ▸ Keyboard's recorder: it takes the
    /// next key pressed while a row is recording, and binds nothing.
    public static let recorder = "recorder"
    /// `KeySite.implements` for the any-app five (components-02 §2).
    public static let anyApp = "any-app"

    /// EVERY place in `apps/macos/sources/` that binds a key, as written. The
    /// audit (`hotkeys-tests.swift`) scans the sources for `.keyboardShortcut(`,
    /// `.onKeyPress(`, `.onExitCommand`, `RegisterEventHotKey(` and the event
    /// monitors, and the two lists must match exactly — a new binding is a new
    /// row here and a row in the design's table, never a screen's own idea.
    public static let sites: [KeySite] = [
        // The menus: one `.keyboardShortcut` per item, read from `ShellCommand`.
        KeySite("kit/shell-commands.swift", ".keyboardShortcut(shortcut.keyboardShortcut)", menuTable),
        // Shortcuts in any app, and the recorder that sets them.
        KeySite("app/carbon-hot-keys.swift", "RegisterEventHotKey(", anyApp),
        KeySite("kit/settings-panes/keyboard-pane.swift", ".onKeyPress(phases: .down)", recorder),
        // Per screen.
        KeySite("kit/request-bodies/request-card-view.swift", ".onKeyPress(characters: .decimalDigits, phases: .down)", "needsYou.pick"),
        KeySite("kit/request-bodies/request-card-view.swift", ".keyboardShortcut(.return, modifiers: .command)", "needsYou.send"),
        KeySite("kit/request-bodies/request-card-view.swift", ".keyboardShortcut(.return, modifiers: .command)", "needsYou.send"),
        KeySite("kit/chat-view.swift", ".keyboardShortcut(.return, modifiers: .command)", "chat.send"),
        KeySite("kit/chat-view.swift", ".onKeyPress(.upArrow)", "chat.recall"),
        KeySite("kit/board-view.swift", ".onKeyPress(.leftArrow)", "board.columns"),
        KeySite("kit/board-view.swift", ".onKeyPress(.rightArrow)", "board.columns"),
        KeySite("kit/board-view.swift", ".onKeyPress(.upArrow)", "list.move"),
        KeySite("kit/board-view.swift", ".onKeyPress(.downArrow)", "list.move"),
        // Everywhere.
        KeySite("kit/activity-view.swift", ".onKeyPress(.rightArrow)", "everywhere.fold"),
        KeySite("kit/activity-view.swift", ".onKeyPress(.leftArrow)", "everywhere.fold"),
        KeySite("kit/chat-view.swift", ".onKeyPress(.return)", "everywhere.press"),
        KeySite("kit/capture-view.swift", ".keyboardShortcut(Self.captureShortcut.keyboardShortcut)", "everywhere.capture"),
        KeySite("kit/menu-bar-view.swift", ".keyboardShortcut(\",\", modifiers: .command)", "everywhere.app"),
        KeySite("kit/menu-bar-view.swift", ".keyboardShortcut(\"q\", modifiers: .command)", "everywhere.app"),
        KeySite("kit/chat-view.swift", ".keyboardShortcut(.defaultAction)", "everywhere.default"),
        KeySite("kit/wizard-view.swift", ".keyboardShortcut(.defaultAction)", "everywhere.default"),
        KeySite("kit/variables-view.swift", ".keyboardShortcut(.defaultAction)", "everywhere.default"),
        KeySite("kit/variables-view.swift", ".keyboardShortcut(.defaultAction)", "everywhere.default"),
        KeySite("kit/compute-view.swift", ".keyboardShortcut(.defaultAction)", "everywhere.default"),
        KeySite("kit/compute-view.swift", ".keyboardShortcut(.defaultAction)", "everywhere.default"),
        KeySite("kit/compute-view.swift", ".keyboardShortcut(.defaultAction)", "everywhere.default"),
        KeySite("kit/secrets-view.swift", ".keyboardShortcut(.defaultAction)", "everywhere.default"),
        KeySite("kit/settings-panes/instance-sheets.swift", ".keyboardShortcut(.defaultAction)", "everywhere.default"),
        KeySite("kit/settings-panes/instance-sheets.swift", ".keyboardShortcut(.defaultAction)", "everywhere.default"),
        KeySite("kit/components/undo-and-confirm.swift", ".keyboardShortcut(.defaultAction)", "everywhere.default"),
        KeySite("kit/chat-view.swift", ".keyboardShortcut(.cancelAction)", "everywhere.escape"),
        KeySite("kit/variables-view.swift", ".keyboardShortcut(.cancelAction)", "everywhere.escape"),
        KeySite("kit/secrets-view.swift", ".keyboardShortcut(.cancelAction)", "everywhere.escape"),
        KeySite("kit/request-bodies/request-card-view.swift", ".keyboardShortcut(.cancelAction)", "everywhere.escape"),
        KeySite("kit/settings-panes/instance-sheets.swift", ".keyboardShortcut(.cancelAction)", "everywhere.escape"),
        KeySite("kit/settings-panes/instance-sheets.swift", ".keyboardShortcut(.cancelAction)", "everywhere.escape"),
        KeySite("kit/settings-panes/services-pane.swift", ".keyboardShortcut(.cancelAction)", "everywhere.escape"),
        KeySite("kit/chat-view.swift", ".onExitCommand", "everywhere.escape"),
        KeySite("kit/agent-detail-view.swift", ".onExitCommand", "everywhere.escape"),
        KeySite("kit/agent-detail-view.swift", ".onExitCommand", "everywhere.escape"),
        KeySite("kit/agent-detail-view.swift", ".onExitCommand", "everywhere.escape"),
        KeySite("kit/needs-you-view.swift", ".onExitCommand", "everywhere.escape"),
        KeySite("kit/room-view.swift", ".onExitCommand", "everywhere.escape"),
        KeySite("kit/capture-view.swift", ".onExitCommand", "everywhere.escape"),
        KeySite("kit/capture-bar-view.swift", ".onExitCommand", "everywhere.escape"),
        KeySite("kit/agents-view.swift", ".onExitCommand", "everywhere.escape"),
        KeySite("kit/agents-view.swift", ".onExitCommand", "everywhere.escape"),
        KeySite("kit/components/undo-and-confirm.swift", ".onExitCommand", "everywhere.escape"),
    ]
}

/// One place in the sources that binds a key.
public struct KeySite: Sendable, Hashable {
    /// Relative to `apps/macos/sources/`.
    public let file: String
    /// The call as written, whitespace collapsed; for `.onExitCommand`, just that.
    public let source: String
    /// The `DocumentedKey.id` it implements, or `KeyTable.menuTable` /
    /// `.recorder` / `.anyApp`.
    public let implements: String

    public init(_ file: String, _ source: String, _ implements: String) {
        self.file = file
        self.source = source
        self.implements = implements
    }
}

// MARK: - Shortcuts in any app: the five

/// Settings ▸ Keyboard's five: the any-app shortcuts (components-02 §2, C120).
public enum AnyAppShortcut: String, CaseIterable, Sendable {
    case ask, note, todo, startRecording, stopRecording

    public var command: ShellCommand {
        switch self {
        case .ask: return .ask
        case .note: return .note
        case .todo: return .todo
        case .startRecording: return .startRecording
        case .stopRecording: return .stopRecording
        }
    }

    /// components-02 §2's suggestion: ⌃⌥⌘ A N T R S.
    public var suggestedShortcut: MenuShortcut {
        let letter: Character
        switch self {
        case .ask: letter = "a"
        case .note: letter = "n"
        case .todo: letter = "t"
        case .startRecording: letter = "r"
        case .stopRecording: letter = "s"
        }
        return MenuShortcut(.character(letter), [.control, .option, .command])
    }

    /// The suggestion as the pane prints it: `⌃⌥⌘A`.
    public var suggested: String { suggestedShortcut.glyphs }

    /// The id macOS hands back on a press — 1…5, fixed.
    public var hotKeyID: UInt32 { UInt32(Self.allCases.firstIndex(of: self)! + 1) }

    public init?(hotKeyID: UInt32) {
        let index = Int(hotKeyID) - 1
        guard Self.allCases.indices.contains(index) else { return nil }
        self = Self.allCases[index]
    }
}

// MARK: - A shortcut, as macOS's key APIs take it

extension MenuShortcut {
    /// The ANSI virtual key code (`kVK_ANSI_*`, HIToolbox Events.h) for a key
    /// the recorder can take. A hot key is registered by key POSITION, so on a
    /// layout other than US the letter printed is the US one at that position.
    public var virtualKeyCode: UInt32? {
        switch key {
        case .return: return 0x24
        case .space: return 0x31
        case .character(let c): return Self.ansiKeyCodes[Character(c.lowercased())]
        }
    }

    /// Carbon's modifier mask (`cmdKey`, `shiftKey`, `optionKey`, `controlKey`).
    public var carbonModifiers: UInt32 {
        var out: UInt32 = 0
        if modifiers.contains(.command) { out |= 0x0100 }
        if modifiers.contains(.shift) { out |= 0x0200 }
        if modifiers.contains(.option) { out |= 0x0800 }
        if modifiers.contains(.control) { out |= 0x1000 }
        return out
    }

    /// How many of ⌃ ⌥ ⌘ it holds — ⇧ alone changes the letter, not the app.
    var appModifierCount: Int {
        [Modifiers.control, .option, .command].filter { modifiers.contains($0) }.count
    }

    /// The form kept in defaults: `control+option+command+a`.
    public var storageForm: String {
        var parts: [String] = []
        if modifiers.contains(.control) { parts.append("control") }
        if modifiers.contains(.option) { parts.append("option") }
        if modifiers.contains(.shift) { parts.append("shift") }
        if modifiers.contains(.command) { parts.append("command") }
        switch key {
        case .return: parts.append("return")
        case .space: parts.append("space")
        case .character(let c): parts.append(String(c).lowercased())
        }
        return parts.joined(separator: "+")
    }

    public init?(storageForm: String) {
        // `+` is itself a key, so the key is whatever follows the last modifier.
        var rest = Substring(storageForm)
        var mods: Modifiers = []
        let names: [(String, Modifiers)] = [("control+", .control), ("option+", .option), ("shift+", .shift), ("command+", .command)]
        var matched = true
        while matched {
            matched = false
            for (name, mod) in names where rest.hasPrefix(name) && rest.count > name.count {
                mods.insert(mod)
                rest = rest.dropFirst(name.count)
                matched = true
            }
        }
        let key: Key
        switch rest {
        case "return": key = .return
        case "space": key = .space
        default:
            guard rest.count == 1, let c = rest.first else { return nil }
            key = .character(c)
        }
        self.init(key, mods)
        guard virtualKeyCode != nil else { return nil }
    }

    /// The recorder's reading of a key press: the character the key prints
    /// with no modifier, which is how a menu names it. Shift's symbols on a US
    /// layout are folded back to their key.
    public static func recorded(character: String, modifiers: Modifiers) -> MenuShortcut? {
        let key: Key
        switch character {
        case " ": key = .space
        case "\r", "\n": key = .return
        default:
            guard character.count == 1, let first = character.first else { return nil }
            let lowered = Character(first.lowercased())
            let base = shiftedSymbols[lowered] ?? lowered
            key = .character(base)
        }
        let shortcut = MenuShortcut(key, modifiers)
        return shortcut.virtualKeyCode == nil ? nil : shortcut
    }

    static let ansiKeyCodes: [Character: UInt32] = [
        "a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04, "g": 0x05, "z": 0x06, "x": 0x07,
        "c": 0x08, "v": 0x09, "b": 0x0B, "q": 0x0C, "w": 0x0D, "e": 0x0E, "r": 0x0F, "y": 0x10,
        "t": 0x11, "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "6": 0x16, "5": 0x17, "=": 0x18,
        "9": 0x19, "7": 0x1A, "-": 0x1B, "8": 0x1C, "0": 0x1D, "]": 0x1E, "o": 0x1F, "u": 0x20,
        "[": 0x21, "i": 0x22, "p": 0x23, "l": 0x25, "j": 0x26, "'": 0x27, "k": 0x28, ";": 0x29,
        "\\": 0x2A, ",": 0x2B, "/": 0x2C, "n": 0x2D, "m": 0x2E, ".": 0x2F, "`": 0x32,
    ]

    static let shiftedSymbols: [Character: Character] = [
        "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
        "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/", "~": "`",
    ]
}

// MARK: - What macOS says

/// `RegisterEventHotKey`'s answer, in the kit's words.
public enum HotKeyRegistration: Sendable, Equatable {
    case registered
    /// `eventHotKeyExistsErr`: another app holds this combination.
    case taken
    /// Any other refusal, with macOS's status.
    case refused(Int32)

    /// `eventHotKeyExistsErr` (CarbonEvents.h).
    public static let existsStatus: Int32 = -9878

    public init(status: Int32) {
        switch status {
        case 0: self = .registered
        case Self.existsStatus: self = .taken
        default: self = .refused(status)
        }
    }
}

/// The seam the app target fills with `RegisterEventHotKey`. A test fills it
/// with a fake that says Taken on cue.
@MainActor
public protocol HotKeyRegistrar: AnyObject {
    func register(_ shortcut: MenuShortcut, id: UInt32) -> HotKeyRegistration
    func unregister(id: UInt32)
    /// Called with the id of a registered key when it is pressed, in any app.
    var onPress: (@MainActor (UInt32) -> Void)? { get set }
}

/// macOS's own shortcuts: the symbolic-hotkeys domain (System Settings ›
/// Keyboard › Keyboard Shortcuts).
public struct SystemShortcuts: Sendable, Equatable {
    public struct Entry: Sendable, Equatable {
        public let shortcut: MenuShortcut
        /// Completes *macOS uses this to …*
        public let use: String
    }

    public let entries: [Entry]

    public init(entries: [Entry]) {
        self.entries = entries
    }

    /// What macOS uses `shortcut` for, if it does.
    public func use(of shortcut: MenuShortcut) -> String? {
        entries.first { $0.shortcut == shortcut }?.use
    }

    /// The domain this Mac has: read, never written.
    public static func current() -> SystemShortcuts {
        let domain = UserDefaults.standard.persistentDomain(forName: domainName)
        return SystemShortcuts(appleSymbolicHotKeys: domain?["AppleSymbolicHotKeys"] as? [String: Any])
    }

    public static let domainName = "com.apple.symbolichotkeys"

    /// Reads `AppleSymbolicHotKeys`: `{ "<id>": { enabled, value: { parameters:
    /// [character, key code, modifier flags] } } }`. An id the domain does not
    /// mention keeps macOS's default; one it disables is not a conflict.
    public init(appleSymbolicHotKeys: [String: Any]?) {
        var byID: [Int: Entry?] = [:]
        for (id, use, shortcut) in Self.defaults {
            byID[id] = Entry(shortcut: shortcut, use: use)
        }
        for (key, raw) in appleSymbolicHotKeys ?? [:] {
            guard let id = Int(key), let item = raw as? [String: Any] else { continue }
            let enabled = (item["enabled"] as? Bool) ?? ((item["enabled"] as? NSNumber)?.boolValue ?? false)
            guard enabled,
                  let value = item["value"] as? [String: Any],
                  let parameters = value["parameters"] as? [Any], parameters.count >= 3,
                  let code = (parameters[1] as? NSNumber)?.uint32Value,
                  let flags = (parameters[2] as? NSNumber)?.intValue,
                  let shortcut = Self.shortcut(keyCode: code, cocoaFlags: flags)
            else {
                byID[id] = .some(nil)
                continue
            }
            let use = Self.uses[id] ?? "run one of its own shortcuts (System Settings › Keyboard › Keyboard Shortcuts)"
            byID[id] = Entry(shortcut: shortcut, use: use)
        }
        entries = byID.keys.sorted().compactMap { byID[$0] ?? nil }
    }

    /// A key code and `NSEvent.ModifierFlags` bits, as the domain stores them.
    static func shortcut(keyCode: UInt32, cocoaFlags: Int) -> MenuShortcut? {
        let key: MenuShortcut.Key
        switch keyCode {
        case 0x24: key = .return
        case 0x31: key = .space
        default:
            guard let c = MenuShortcut.ansiKeyCodes.first(where: { $0.value == keyCode })?.key else { return nil }
            key = .character(c)
        }
        var mods: MenuShortcut.Modifiers = []
        if cocoaFlags & 0x20000 != 0 { mods.insert(.shift) }
        if cocoaFlags & 0x40000 != 0 { mods.insert(.control) }
        if cocoaFlags & 0x80000 != 0 { mods.insert(.option) }
        if cocoaFlags & 0x100000 != 0 { mods.insert(.command) }
        return MenuShortcut(key, mods)
    }

    /// What an id does, for the ones this table knows.
    static let uses: [Int: String] = Dictionary(uniqueKeysWithValues: defaults.map { ($0.0, $0.1) })

    /// macOS's defaults for the ids the recorder can collide with.
    static let defaults: [(Int, String, MenuShortcut)] = [
        (27, "move focus to the next window", MenuShortcut(.character("`"), [.command])),
        (28, "save a picture of the screen", MenuShortcut(.character("3"), [.shift, .command])),
        (29, "copy a picture of the screen", MenuShortcut(.character("3"), [.control, .shift, .command])),
        (30, "save a picture of a selected area", MenuShortcut(.character("4"), [.shift, .command])),
        (31, "copy a picture of a selected area", MenuShortcut(.character("4"), [.control, .shift, .command])),
        (52, "turn Dock hiding on or off", MenuShortcut(.character("d"), [.option, .command])),
        (60, "select the previous input source", MenuShortcut(.space, [.control])),
        (61, "select the next input source", MenuShortcut(.space, [.control, .option])),
        (64, "show Spotlight search", MenuShortcut(.space, [.command])),
        (65, "show the Finder search window", MenuShortcut(.space, [.option, .command])),
        (98, "show the Help menu", MenuShortcut(.character("/"), [.shift, .command])),
        (184, "open Screenshot", MenuShortcut(.character("5"), [.shift, .command])),
    ]
}

// MARK: - A conflict

/// Why a row is not clear. Every case blocks registration: nothing registers
/// until every row is clear (C120).
public enum HotKeyConflict: Sendable, Equatable {
    /// Another app holds it: macOS refused the registration (`eventHotKeyExistsErr`).
    case taken
    /// macOS uses it for something of its own — a warning.
    case system(String)
    /// This app's menus use it.
    case inApp(ShellCommand)
    /// Another of the five has it.
    case duplicate(AnyAppShortcut)
    /// Fewer than two of ⌃ ⌥ ⌘: ⌘ alone is every app's menus, ⌥ alone types.
    case tooFewModifiers
    /// macOS would not take it, for a reason other than another app.
    case refused(Int32)

    /// Failed ink; `system` is the warning.
    public var isWarning: Bool {
        if case .system = self { return true }
        return false
    }

    public func sentence(assistantName: String?) -> String {
        switch self {
        case .taken: return "Another app already uses this. Pick another."
        case .system(let use): return "macOS uses this to \(use)."
        case .inApp(let command):
            let item = command.title(assistantName: assistantName).replacingOccurrences(of: "…", with: "")
            return "Metistry's \(item) uses this. Pick another."
        case .duplicate(let other):
            let row = other.command.title(assistantName: assistantName)
            return "\(row) already uses this. Pick another."
        case .tooFewModifiers: return "Use two of Control, Option and Command: one alone belongs to every app. Pick another."
        case .refused(let status): return "macOS would not take this (\(status)). Pick another."
        }
    }
}

// MARK: - The model

/// Settings ▸ Keyboard ▸ Shortcuts in any app, and the registrations it makes.
@MainActor
@Observable
public final class AnyAppShortcutsModel {
    /// The switch. Off — the default — registers nothing at all.
    public private(set) var isOn: Bool
    /// Each row's key; a row the owner cleared has none.
    public private(set) var keys: [AnyAppShortcut: MenuShortcut]
    /// Why a row is not clear. While any row is here, nothing is registered.
    public private(set) var conflicts: [AnyAppShortcut: HotKeyConflict] = [:]
    /// What macOS holds for this app right now.
    public private(set) var registered: Set<AnyAppShortcut> = []
    /// The row waiting for a key, if any. While one waits, nothing is registered.
    public private(set) var recording: AnyAppShortcut?

    /// Runs a pressed row's command; false when nothing answers it yet.
    @ObservationIgnored public var perform: @MainActor (ShellCommand) -> Bool = { _ in false }
    /// Said when a pressed key has nothing behind it (the app target beeps).
    @ObservationIgnored public var unanswered: @MainActor (AnyAppShortcut) -> Void = { _ in }
    /// macOS's own shortcuts, read at each check so a change in System Settings is seen.
    @ObservationIgnored public var systemShortcuts: () -> SystemShortcuts = { SystemShortcuts.current() }

    @ObservationIgnored private var registrar: (any HotKeyRegistrar)?
    @ObservationIgnored private let defaults: UserDefaults

    public init(defaults: UserDefaults) {
        self.defaults = defaults
        let stored = defaults.dictionary(forKey: AppPreference.anyAppShortcuts.rawValue)
        isOn = (stored?["on"] as? Bool) ?? false
        var keys: [AnyAppShortcut: MenuShortcut] = [:]
        let storedKeys = stored?["keys"] as? [String: String]
        for row in AnyAppShortcut.allCases {
            if let form = storedKeys?[row.rawValue] {
                // "" is a row the owner cleared; anything unreadable is too.
                if let shortcut = MenuShortcut(storageForm: form) { keys[row] = shortcut }
            } else {
                keys[row] = row.suggestedShortcut
            }
        }
        self.keys = keys
    }

    /// The app target hands over `RegisterEventHotKey`; with none (a test, an
    /// iOS build) nothing is ever registered.
    public func attach(_ registrar: any HotKeyRegistrar) {
        unregisterAll()
        self.registrar = registrar
        registrar.onPress = { [weak self] id in self?.pressed(id) }
        apply()
    }

    public func setOn(_ on: Bool) {
        isOn = on
        if !on { recording = nil }
        persist()
        apply()
    }

    /// *Record Shortcut*, or a click on the keys: the row waits for a key, and
    /// every registration is taken back meanwhile — a hot key would otherwise
    /// swallow the very press being recorded.
    public func beginRecording(_ row: AnyAppShortcut) {
        guard isOn else { return }
        recording = row
        unregisterAll()
    }

    public func cancelRecording() {
        guard recording != nil else { return }
        recording = nil
        apply()
    }

    /// The key the waiting row was given, checked as it is set.
    public func record(_ shortcut: MenuShortcut) {
        guard let row = recording else { return }
        recording = nil
        keys[row] = shortcut
        persist()
        apply()
    }

    /// The row's ×.
    public func clear(_ row: AnyAppShortcut) {
        keys[row] = nil
        if recording == row { recording = nil }
        persist()
        apply()
    }

    /// A row's own conflict, before macOS is asked: the cases that need no
    /// registration to know.
    public func staticConflicts() -> [AnyAppShortcut: HotKeyConflict] {
        var out: [AnyAppShortcut: HotKeyConflict] = [:]
        let system = systemShortcuts()
        for row in AnyAppShortcut.allCases {
            guard let shortcut = keys[row] else { continue }
            if shortcut.appModifierCount < 2 {
                out[row] = .tooFewModifiers
            } else if let command = ShellCommand.allCases.first(where: { $0.shortcut == shortcut }) {
                out[row] = .inApp(command)
            } else if let other = AnyAppShortcut.allCases.first(where: { $0 != row && keys[$0] == shortcut }) {
                out[row] = .duplicate(other)
            } else if let use = system.use(of: shortcut) {
                out[row] = .system(use)
            }
        }
        return out
    }

    /// Takes every registration back, checks every row, and — only when the
    /// switch is on, nothing is recording and every row is clear — registers
    /// the five. A registration macOS refuses makes its row Taken and takes
    /// back the rest, so a conflict never leaves some keys live.
    public func apply() {
        unregisterAll()
        conflicts = staticConflicts()
        guard isOn, recording == nil, let registrar, conflicts.isEmpty else { return }
        var refused: [AnyAppShortcut: HotKeyConflict] = [:]
        for row in AnyAppShortcut.allCases {
            guard let shortcut = keys[row] else { continue }
            switch registrar.register(shortcut, id: row.hotKeyID) {
            case .registered: registered.insert(row)
            case .taken: refused[row] = .taken
            case .refused(let status): refused[row] = .refused(status)
            }
        }
        if !refused.isEmpty {
            unregisterAll()
            conflicts = refused
        }
    }

    /// A registered key, pressed in any app.
    func pressed(_ id: UInt32) {
        guard isOn, let row = AnyAppShortcut(hotKeyID: id), registered.contains(row) else { return }
        if !perform(row.command) { unanswered(row) }
    }

    private func unregisterAll() {
        guard let registrar else {
            registered = []
            return
        }
        for row in registered { registrar.unregister(id: row.hotKeyID) }
        registered = []
    }

    private func persist() {
        var stored: [String: String] = [:]
        for row in AnyAppShortcut.allCases { stored[row.rawValue] = keys[row]?.storageForm ?? "" }
        defaults.set(["on": isOn, "keys": stored] as [String: Any], forKey: AppPreference.anyAppShortcuts.rawValue)
    }
}

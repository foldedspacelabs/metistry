// Hot keys and the audit (T6-16; components-02 §1–§2, C119, C120; plan
// §2.18.1–2). Two halves:
//
//   * THE AUDIT. Every key the sources bind is a row of the closed table
//     (`KeyTable.sites`), found by scanning the sources — so a screen cannot
//     grow a key the table does not know — and every key the design documents
//     is bound, or says on Help ▸ Keyboard Shortcuts that it is not, and why.
//   * SHORTCUTS IN ANY APP. Off registers nothing; nothing registers while
//     any row conflicts; a registration macOS refuses (Taken) takes back every
//     other; the rows say Taken and System in the spec's words.

import Foundation
import Testing

@testable import MetistryKit

// MARK: - The audit: every binding in the sources is in the table

@Test func everyKeyTheSourcesBindIsARowOfTheClosedTable() throws {
    let found = try scanKeyBindings()
    #expect(found.count > 30, "the scan found almost nothing — is it reading the sources?")
    let table = KeyTable.sites.map { "\($0.file) \($0.source)" }
    var unlisted = found
    for row in table {
        if let i = unlisted.firstIndex(of: row) { unlisted.remove(at: i) }
    }
    var stale = table
    for binding in found {
        if let i = stale.firstIndex(of: binding) { stale.remove(at: i) }
    }
    #expect(unlisted.isEmpty, "bound in the sources but not in KeyTable.sites (hotkeys.swift) — add it to the design's table first: \(unlisted)")
    #expect(stale.isEmpty, "in KeyTable.sites but bound nowhere: \(stale)")
}

@Test func theScanCatchesEveryWayToBindAKeyAndIgnoresCommentsAndStrings() {
    let source = #"""
    // .keyboardShortcut("x") in a comment is not a binding
    let words = ".onKeyPress(.space) in a string is not one either"
    /* nor .onExitCommand in a block comment */
    Button("Go") {}.keyboardShortcut( "g",
        modifiers: .command )
    view.onKeyPress(.tab) { .handled }.onExitCommand { }
    NSEvent.addLocalMonitorForEvents(matching: .keyDown) { $0 }
    RegisterEventHotKey(code, mods, id, target, 0, &ref)
    let label = "\(name.isEmpty ? "none" : ".onKeyPress(.a)")"
    """#
    #expect(keyBindings(in: source) == [
        #".keyboardShortcut( "g", modifiers: .command )"#,
        ".onKeyPress(.tab)",
        ".onExitCommand",
        "addLocalMonitorForEvents",
        "RegisterEventHotKey(",
    ])
}

@Test func everyRowOfTheTableImplementsADocumentedKey() {
    let documented = Set(KeyTable.documented.map(\.id))
    #expect(documented.count == KeyTable.documented.count, "two documented keys share an id")
    let special: Set<String> = [KeyTable.menuTable, KeyTable.recorder, KeyTable.anyApp]
    for site in KeyTable.sites {
        #expect(documented.contains(site.implements) || special.contains(site.implements), "\(site.file): \(site.implements) is no key of the table")
    }
    // a key the table says a view binds is bound by a view
    let implemented = Set(KeyTable.sites.map(\.implements))
    for key in KeyTable.documented where key.binding == .view {
        #expect(implemented.contains(key.id), "\(key.id) (\(key.text)) says a view binds it, and none does")
    }
    // the any-app five are registered in exactly one place, and the menus in one
    #expect(KeyTable.sites.filter { $0.implements == KeyTable.anyApp }.count == 1)
    #expect(KeyTable.sites.filter { $0.implements == KeyTable.menuTable }.count == 1)
}

@Test func aKeyBoundThroughTheMenusIsExactlyTheMenuItemsKey() {
    for key in KeyTable.documented {
        guard case .menu(let commands) = key.binding else { continue }
        let glyphs = commands.compactMap(\.shortcut?.glyphs).joined(separator: " ")
        #expect(glyphs == key.keys, "\(key.id): the design says \(key.keys), the menu binds \(glyphs)")
    }
}

@Test func aDocumentedKeyThatIsNotBoundSaysSoAndWhy() {
    let unbound = KeyTable.documented.filter { !$0.binding.isBound }
    #expect(Set(unbound.map(\.id)) == [
        "list.select", "today.complete", "today.hand", "today.copy", "activity.take", "agents.save", "agents.revoke",
    ])
    for key in unbound {
        let note = key.unboundNote ?? ""
        #expect(note.hasPrefix("\(key.text): not bound."), "\(note)")
        #expect(note.count > "\(key.text): not bound. ".count + 10, "\(key.id) gives no reason")
    }
    // W2 ruling 24: Agents' ⌘S and ⌘⌫, and screen 2's keys, stay unbound
    let agents = ScreenKeys.all.first { $0.screen == "Agents" }
    #expect(agents?.unbound.map(\.keys) == ["⌘S", "⌘⌫"])
    #expect(ScreenKeys.all.first { $0.screen == "Activity" }?.unbound.map(\.keys) == ["⌘R"])
}

@Test func thePerScreenTableIsComponents02sVerbatim() {
    #expect(ScreenKeys.all.map(\.screen) == [
        "Any list", "Needs You", "Today", "Chat", "Activity", "Scheduled", "Agents", "Board",
        "Knowledge, Projects, Artifacts, Run detail", "Settings, Connections, Secrets, Variables, Usage",
    ])
    #expect(ScreenKeys.all.map(\.keys) == [
        "↑ ↓ move · ↩ open · Space select · ⌘A select all · M move to…",
        "A R D approve, revise, decline · L later · 1–9 pick an answer · ⌘↩ send answers",
        "Space complete · ⌘Z undo · ⌥⌘T Today / All · ⇧⌘P hand to an agent · ⌘C copy standup",
        "⌘↩ send · ↑ edit last message · ⇧⌘N new conversation",
        "⌘R take pending rows",
        "⌘R Run Now / Sync Now · ⌥⌘P Pause",
        "⌘S save definition · ⌘⌫ revoke, confirmed",
        "← → between columns · M move",
        "the list keys · ⌘O open in Obsidian",
        "the list keys · Tab through fields",
    ])
    // ⌘9 is retired, and Chat's bare `/` (screen 1 §6) is not in the table
    #expect(!KeyTable.documented.contains { $0.keys.contains("⌘9") || $0.keys == "/" })
}

@Test func glyphsAreSpokenInWords() {
    #expect(DocumentedKey.spoken("⌘, ⌘Q") == "Command-Comma, Command-Q")
    #expect(DocumentedKey.spoken("← →") == "Left Arrow, Right Arrow")
    #expect(DocumentedKey.spoken("⌘↩") == "Command-Return")
    #expect(DocumentedKey.spoken("Esc") == "Esc")
}

// MARK: - Shortcuts in any app: nothing registers while any row conflicts

@MainActor
@Test func offByDefaultRegistersNothingAtAll() {
    let (model, registrar, cleanup) = hotKeysModel()
    defer { cleanup() }
    #expect(!model.isOn)
    #expect(model.keys == Dictionary(uniqueKeysWithValues: AnyAppShortcut.allCases.map { ($0, $0.suggestedShortcut) }))
    #expect(AnyAppShortcut.allCases.map(\.suggested) == ["⌃⌥⌘A", "⌃⌥⌘N", "⌃⌥⌘T", "⌃⌥⌘R", "⌃⌥⌘S"])
    #expect(registrar.live.isEmpty)
    #expect(registrar.attempts == 0, "off does not even ask macOS")
    // recording is refused while off
    model.beginRecording(.note)
    #expect(model.recording == nil)
}

@MainActor
@Test func onWithEveryRowClearRegistersTheFiveAndOffTakesThemBack() {
    let (model, registrar, cleanup) = hotKeysModel()
    defer { cleanup() }
    model.setOn(true)
    #expect(model.conflicts.isEmpty)
    #expect(model.registered == Set(AnyAppShortcut.allCases))
    #expect(registrar.live.count == 5)
    // ⌃⌥⌘N: kVK_ANSI_N with controlKey | optionKey | cmdKey
    let controlOptionCommand: UInt32 = 0x1000 | 0x0800 | 0x0100
    let note = FakeHotKeys.Key(keyCode: 0x2D, modifiers: controlOptionCommand)
    #expect(registrar.live[AnyAppShortcut.note.hotKeyID] == note)
    model.setOn(false)
    #expect(registrar.live.isEmpty)
    #expect(model.registered.isEmpty)
}

@MainActor
@Test func aTakenRowTakesBackEveryOtherRegistrationAndSaysSo() {
    let (model, registrar, cleanup) = hotKeysModel()
    defer { cleanup() }
    registrar.takenByAnotherApp = [AnyAppShortcut.todo.suggestedShortcut]
    model.setOn(true)
    #expect(registrar.live.isEmpty, "a conflict left keys registered: \(registrar.live)")
    #expect(model.registered.isEmpty)
    #expect(model.conflicts == [.todo: .taken])
    #expect(HotKeyConflict.taken.sentence(assistantName: nil) == "Another app already uses this. Pick another.")
    #expect(!HotKeyConflict.taken.isWarning)

    // a new key on the Taken row clears it, and then all five register
    model.beginRecording(.todo)
    model.record(MenuShortcut(.character("y"), [.control, .option, .command]))
    #expect(model.conflicts.isEmpty)
    #expect(registrar.live.count == 5)
}

@MainActor
@Test func aSystemShortcutIsAWarningAndStillBlocksEveryRow() {
    let (model, registrar, cleanup) = hotKeysModel(system: SystemShortcuts(entries: [
        .init(shortcut: MenuShortcut(.character("a"), [.control, .option, .command]), use: "show the Accessibility shortcuts"),
    ]))
    defer { cleanup() }
    model.setOn(true)
    #expect(model.conflicts == [.ask: .system("show the Accessibility shortcuts")])
    #expect(registrar.attempts == 0, "nothing is registered — not even the four clear rows")
    let sentence = model.conflicts[.ask]!.sentence(assistantName: "Aide")
    #expect(sentence == "macOS uses this to show the Accessibility shortcuts.")
    #expect(model.conflicts[.ask]!.isWarning)

    // clearing the row (its ×) leaves four clear rows, and they register
    model.clear(.ask)
    #expect(model.conflicts.isEmpty)
    #expect(model.registered == [.note, .todo, .startRecording, .stopRecording])
}

@MainActor
@Test func theMenusTheOtherRowsAndABareCommandKeyAreConflictsToo() {
    let (model, registrar, cleanup) = hotKeysModel()
    defer { cleanup() }
    model.setOn(true)
    // ⌃⌘S is View ▸ Show Sidebar
    model.beginRecording(.note)
    model.record(MenuShortcut(.character("s"), [.control, .command]))
    #expect(model.conflicts[.note] == .inApp(.toggleSidebar))
    #expect(model.conflicts[.note]?.sentence(assistantName: nil) == "Metistry's Show Sidebar uses this. Pick another.")
    #expect(registrar.live.isEmpty)
    // the Ask row's key on the Note row: both say so
    model.beginRecording(.note)
    model.record(AnyAppShortcut.ask.suggestedShortcut)
    #expect(model.conflicts[.note] == .duplicate(.ask))
    #expect(model.conflicts[.ask] == .duplicate(.note))
    #expect(model.conflicts[.note]?.sentence(assistantName: "Aide") == "Ask Aide already uses this. Pick another.")
    // ⌘K alone is every app's (and this one's Command Palette): two of ⌃⌥⌘ are asked for first
    model.beginRecording(.note)
    model.record(MenuShortcut(.character("k"), [.command]))
    #expect(model.conflicts[.note] == .tooFewModifiers)
    #expect(registrar.live.isEmpty)
}

@MainActor
@Test func recordingTakesEveryKeyBackUntilItEnds() {
    let (model, registrar, cleanup) = hotKeysModel()
    defer { cleanup() }
    model.setOn(true)
    #expect(registrar.live.count == 5)
    model.beginRecording(.stopRecording)
    #expect(model.recording == .stopRecording)
    #expect(registrar.live.isEmpty, "a live hot key would swallow the press being recorded")
    model.cancelRecording()
    #expect(model.keys[.stopRecording] == AnyAppShortcut.stopRecording.suggestedShortcut)
    #expect(registrar.live.count == 5)
}

@MainActor
@Test func theSwitchAndTheKeysSurviveARelaunchInTheOneDeviceLocalKey() {
    let name = "com.foldedspacelabs.metistry.tests.hotkeys.\(UUID().uuidString)"
    defer { UserDefaults.standard.removePersistentDomain(forName: name) }
    let defaults = UserDefaults(suiteName: name)!
    let first = AnyAppShortcutsModel(defaults: defaults)
    first.systemShortcuts = { SystemShortcuts(entries: []) }
    #expect(defaults.persistentDomain(forName: name) == nil, "nothing is written until the owner changes something")
    first.setOn(true)
    first.beginRecording(.note)
    first.record(MenuShortcut(.character("9"), [.control, .option, .shift, .command]))
    first.clear(.stopRecording)

    let domain = UserDefaults.standard.persistentDomain(forName: name) ?? [:]
    #expect(Set(domain.keys) == [AppPreference.anyAppShortcuts.rawValue])

    let second = AnyAppShortcutsModel(defaults: defaults)
    #expect(second.isOn)
    #expect(second.keys[.note]?.glyphs == "⌃⌥⇧⌘9")
    #expect(second.keys[.stopRecording] == nil, "a cleared row stays cleared")
    #expect(second.keys[.ask] == AnyAppShortcut.ask.suggestedShortcut)
}

@MainActor
@Test func aPressRunsItsCaptureItemAndOneNothingAnswersBeeps() throws {
    let name = "com.foldedspacelabs.metistry.tests.hotkeys-app.\(UUID().uuidString)"
    defer { UserDefaults.standard.removePersistentDomain(forName: name) }
    let app = AppModel(bundleResourceURL: nil, runner: ShellNoopRunner(), defaults: UserDefaults(suiteName: name)!)
    let registrar = FakeHotKeys()
    var noted = 0
    var beeped: [AnyAppShortcut] = []
    app.shell.captureActions[.note] = { noted += 1 }
    app.hotKeys.unanswered = { beeped.append($0) }
    app.hotKeys.systemShortcuts = { SystemShortcuts(entries: []) }
    app.hotKeys.attach(registrar)
    #expect(registrar.live.isEmpty, "a model built with the switch off registers nothing on attach")

    app.hotKeys.setOn(true)
    registrar.press(AnyAppShortcut.note.hotKeyID)
    #expect(noted == 1)
    // To-do has nothing behind it (no bar running): it says so
    registrar.press(AnyAppShortcut.todo.hotKeyID)
    #expect(beeped == [.todo])
    // an id that is not one of the five, and any press while off, do nothing
    registrar.press(99)
    app.hotKeys.setOn(false)
    registrar.press(AnyAppShortcut.note.hotKeyID)
    #expect(noted == 1)
    #expect(beeped == [.todo])
}

// MARK: - What macOS says, read

@Test func eventHotKeyExistsErrIsTaken() {
    #expect(HotKeyRegistration(status: 0) == .registered)
    #expect(HotKeyRegistration(status: -9878) == .taken)
    #expect(HotKeyRegistration(status: -50) == .refused(-50))
}

@Test func theSymbolicHotkeysDomainNamesWhatMacOSUsesAKeyFor() {
    // Spotlight moved to ⌃⌥⌘N; the input-source switch turned off; an id this table does not name
    let domain: [String: Any] = [
        "64": ["enabled": true, "value": ["parameters": [110, 0x2D, 0x40000 | 0x80000 | 0x100000], "type": "standard"]],
        "61": ["enabled": false, "value": ["parameters": [32, 0x31, 0x40000 | 0x80000], "type": "standard"]],
        "118": ["enabled": NSNumber(value: 1), "value": ["parameters": [49, 0x12, 0x40000 | 0x80000 | 0x100000], "type": "standard"]],
    ]
    let system = SystemShortcuts(appleSymbolicHotKeys: domain)
    #expect(system.use(of: MenuShortcut(.character("n"), [.control, .option, .command])) == "show Spotlight search")
    #expect(system.use(of: MenuShortcut(.space, [.command])) == nil, "Spotlight is not on ⌘Space any more")
    #expect(system.use(of: MenuShortcut(.space, [.control, .option])) == nil, "a disabled shortcut is no conflict")
    #expect(system.use(of: MenuShortcut(.character("1"), [.control, .option, .command]))?.hasPrefix("run one of its own shortcuts") == true)
    // an id the domain does not mention keeps macOS's default
    #expect(system.use(of: MenuShortcut(.character("d"), [.option, .command])) == "turn Dock hiding on or off")
    // with no domain at all, the defaults stand
    #expect(SystemShortcuts(appleSymbolicHotKeys: nil).use(of: MenuShortcut(.character("4"), [.control, .shift, .command])) == "copy a picture of a selected area")
}

@Test func aRecordedKeyIsTheKeyAsAMenuNamesItAndKeepsInDefaults() {
    let all: MenuShortcut.Modifiers = [.control, .option, .shift, .command]
    #expect(MenuShortcut.recorded(character: "A", modifiers: all)?.glyphs == "⌃⌥⇧⌘A")
    #expect(MenuShortcut.recorded(character: "!", modifiers: [.shift, .command, .option]) == MenuShortcut(.character("1"), [.shift, .command, .option]))
    #expect(MenuShortcut.recorded(character: " ", modifiers: [.control, .option]) == MenuShortcut(.space, [.control, .option]))
    #expect(MenuShortcut.recorded(character: "é", modifiers: [.control, .option]) == nil, "no key position for it")
    for shortcut in AnyAppShortcut.allCases.map(\.suggestedShortcut) + [MenuShortcut(.character("="), [.control, .command]), MenuShortcut(.return, [.option, .command])] {
        #expect(MenuShortcut(storageForm: shortcut.storageForm) == shortcut, "\(shortcut.storageForm)")
    }
    #expect(AnyAppShortcut.note.suggestedShortcut.storageForm == "control+option+command+n")
    #expect(MenuShortcut(storageForm: "") == nil)
    #expect(MenuShortcut(storageForm: "command+é") == nil)
    #expect(AnyAppShortcut.allCases.map(\.hotKeyID) == [1, 2, 3, 4, 5])
    #expect(AnyAppShortcut.allCases.allSatisfy { AnyAppShortcut(hotKeyID: $0.hotKeyID) == $0 })
}

// MARK: - Fakes and the scan

/// `RegisterEventHotKey`, with a list of combinations another app holds.
@MainActor
final class FakeHotKeys: HotKeyRegistrar {
    struct Key: Equatable { let keyCode: UInt32; let modifiers: UInt32 }
    var onPress: (@MainActor (UInt32) -> Void)?
    var takenByAnotherApp: [MenuShortcut] = []
    private(set) var live: [UInt32: Key] = [:]
    private(set) var attempts = 0

    func register(_ shortcut: MenuShortcut, id: UInt32) -> HotKeyRegistration {
        attempts += 1
        if takenByAnotherApp.contains(shortcut) { return HotKeyRegistration(status: HotKeyRegistration.existsStatus) }
        live[id] = Key(keyCode: shortcut.virtualKeyCode!, modifiers: shortcut.carbonModifiers)
        return .registered
    }

    func unregister(id: UInt32) { live[id] = nil }

    /// macOS delivering a press — only of a key it holds for us.
    func press(_ id: UInt32) {
        guard live[id] != nil || id == 99 else { return }
        onPress?(id)
    }
}

@MainActor
private func hotKeysModel(system: SystemShortcuts = SystemShortcuts(entries: [])) -> (AnyAppShortcutsModel, FakeHotKeys, () -> Void) {
    let name = "com.foldedspacelabs.metistry.tests.hotkeys.\(UUID().uuidString)"
    let model = AnyAppShortcutsModel(defaults: UserDefaults(suiteName: name)!)
    model.systemShortcuts = { system }
    let registrar = FakeHotKeys()
    model.attach(registrar)
    return (model, registrar, { UserDefaults.standard.removePersistentDomain(forName: name) })
}

/// Every key binding under `apps/macos/sources/`, as `<file> <call>`.
func scanKeyBindings() throws -> [String] {
    let sources = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("sources")
    let files = FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil)?
        .compactMap { $0 as? URL }
        .filter { $0.pathExtension == "swift" }
        .sorted { $0.path < $1.path } ?? []
    var out: [String] = []
    for file in files {
        let relative = String(file.path.dropFirst(sources.path.count + 1))
        let text = try String(contentsOf: file, encoding: .utf8)
        out += keyBindings(in: text).map { "\(relative) \($0)" }
    }
    return out
}

/// The ways SwiftUI, AppKit and Carbon bind a key. A call is taken with its
/// arguments; the rest are taken by name — `.onExitCommand` has one meaning
/// whatever it runs, and an event monitor or an event tap is never allowed.
private let bindingCalls = [".keyboardShortcut(", ".onKeyPress(", ".onMoveCommand(", ".onDeleteCommand(", ".onCommand("]
private let bindingNames = [
    ".onExitCommand", "addLocalMonitorForEvents", "addGlobalMonitorForEvents", "tapCreate", "keyEquivalent:",
    "RegisterEventHotKey(", "RegisterEventHotKeyWithOptions",
]

/// The bindings in one file, in order, outside comments and string literals.
/// A match is found in the code with every literal blanked, and its call is
/// read back from the source as written, arguments and all.
func keyBindings(in source: String) -> [String] {
    let original = Array(source)
    let code = Array(codeOnly(source))
    func find(_ needle: String, from start: Int) -> Int? {
        let pattern = Array(needle)
        guard pattern.count <= code.count else { return nil }
        var i = start
        search: while i + pattern.count <= code.count {
            for (k, c) in pattern.enumerated() where code[i + k] != c {
                i += 1
                continue search
            }
            return i
        }
        return nil
    }
    var hits: [(Int, String)] = []
    for call in bindingCalls {
        var from = 0
        while let at = find(call, from: from) {
            var depth = 1
            var end = at + call.count
            while end < code.count, depth > 0 {
                if code[end] == "(" { depth += 1 }
                if code[end] == ")" { depth -= 1 }
                end += 1
            }
            let text = String(original[at..<end]).split(whereSeparator: \.isWhitespace).joined(separator: " ")
            hits.append((at, text))
            from = at + call.count
        }
    }
    for name in bindingNames {
        var from = 0
        while let at = find(name, from: from) {
            hits.append((at, name))
            from = at + name.count
        }
    }
    return hits.sorted { $0.0 < $1.0 }.map(\.1)
}

/// `source` with comments blanked and every string literal's contents
/// replaced by spaces — interpolated code inside a literal is kept as code,
/// so a quote inside `\( … )` does not end the literal.
private func codeOnly(_ source: String) -> String {
    enum Context {
        case code(interpolationDepth: Int?)
        case string(multiline: Bool, hashes: Int)
    }
    let chars = Array(source)
    var out = chars
    var stack: [Context] = [.code(interpolationDepth: nil)]
    var i = 0
    func blank(_ j: Int) { if j < out.count, out[j] != "\n" { out[j] = " " } }
    func matches(_ s: String, at j: Int) -> Bool {
        var k = j
        for c in s {
            guard k < chars.count, chars[k] == c else { return false }
            k += 1
        }
        return true
    }
    while i < chars.count {
        let c = chars[i]
        switch stack.last! {
        case .string(let multiline, let hashes):
            let hashMarks = String(repeating: "#", count: hashes)
            if c == "\\" {
                if matches("\\" + hashMarks + "(", at: i) {
                    for j in i..<(i + hashes + 2) { blank(j) }
                    i += hashes + 2
                    stack.append(.code(interpolationDepth: 1))
                    continue
                }
                if hashes == 0 {
                    blank(i)
                    blank(i + 1)
                    i += 2
                    continue
                }
            }
            let close = (multiline ? "\"\"\"" : "\"") + hashMarks
            if matches(close, at: i) {
                for j in i..<(i + close.count) { blank(j) }
                i += close.count
                stack.removeLast()
                continue
            }
            blank(i)
            i += 1
        case .code(let depth):
            if let depth {
                let next = c == "(" ? depth + 1 : c == ")" ? depth - 1 : depth
                if next == 0 {
                    blank(i)
                    stack.removeLast()
                    i += 1
                    continue
                }
                stack[stack.count - 1] = .code(interpolationDepth: next)
            }
            if matches("//", at: i) {
                while i < chars.count && chars[i] != "\n" { blank(i); i += 1 }
                continue
            }
            if matches("/*", at: i) {
                var nest = 0
                while i < chars.count {
                    if matches("/*", at: i) { nest += 1; blank(i); blank(i + 1); i += 2; continue }
                    if matches("*/", at: i) { nest -= 1; blank(i); blank(i + 1); i += 2; if nest == 0 { break }; continue }
                    blank(i)
                    i += 1
                }
                continue
            }
            if c == "#" || c == "\"" {
                var j = i
                while j < chars.count && chars[j] == "#" { j += 1 }
                if j < chars.count && chars[j] == "\"" {
                    let multiline = matches("\"\"\"", at: j)
                    let end = j + (multiline ? 3 : 1)
                    for k in i..<end { blank(k) }
                    stack.append(.string(multiline: multiline, hashes: j - i))
                    i = end
                    continue
                }
            }
            i += 1
        }
    }
    return String(out)
}

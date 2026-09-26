// The menus and the words (design-build-plan §2.18.1; components-02 §1, C119;
// C88). The command table is the one place a shortcut exists, so these tests
// hold the table to the spec's own list — and hold every label the shell can
// produce, and every string literal in its source, to the rule that no label
// says "assistant" and none hardcodes a name.

import Foundation
import Testing

@testable import MetistryKit

// MARK: - The keys, verbatim

@Test func theGoMenuIsNeedsYouThenTheEightRowsInSidebarOrderThenHistoryPaletteAndFilter() {
    let go = ShellMenu.go.groups.joined().map { "\($0.title(assistantName: nil)) \($0.shortcut?.glyphs ?? "")" }
    #expect(go == [
        "Needs You ⌘0", "Today ⌘1", "Chat ⌘2", "Activity ⌘3", "Work ⌘4", "Knowledge ⌘5", "Agents ⌘6", "Scheduled ⌘7",
        "Back ⌘[", "Forward ⌘]", "Command Palette ⌘K", "Filter ⌘F",
    ])
    // ⌘1–⌘7 are the sidebar's own order, read from the sidebar's own enum
    #expect(ShellSection.allCases.map(\.digit) == Array(1...7))
    #expect(ShellSection.allCases.map(\.title) == ["Today", "Chat", "Activity", "Work", "Knowledge", "Agents", "Scheduled"])
}

@Test func everyOtherMenuHoldsExactlyTheItemsAndKeysOfC119() {
    func menu(_ m: ShellMenu) -> [String] {
        m.groups.joined().map { [$0.title(assistantName: "Aide"), $0.shortcut?.glyphs].compactMap { $0 }.joined(separator: " ") }
    }
    #expect(menu(.file) == ["New Conversation ⇧⌘N"])
    #expect(menu(.capture) == [
        "New Capture ⌘N", "Ask Aide", "Note", "To-do", "Start Recording", "Stop Recording",
        "Hide Capture Bar", "Shortcuts in Any App…",
    ])
    #expect(menu(.item) == [
        "Open ↩", "Open in Obsidian ⌘O", "Approve A", "Revise R", "Decline D", "Later L",
        "Complete Space", "Move… M", "Hand to an Agent… ⇧⌘P", "Run Now ⌘R", "Pause ⌥⌘P",
    ])
    #expect(menu(.view) == ["Today / All ⌥⌘T", "Show Sidebar ⌃⌘S"])
    #expect(menu(.help) == ["Keyboard Shortcuts ⌘/"])
    // every command is in exactly one menu
    let placed = ShellMenu.allCases.flatMap { $0.groups.joined() }
    #expect(placed.count == ShellCommand.allCases.count)
    #expect(Set(placed) == Set(ShellCommand.allCases))
}

@Test func nineIsRetiredAndNoTwoItemsShareAKey() {
    let keyed = ShellCommand.allCases.compactMap(\.shortcut)
    #expect(!keyed.contains(.command("9")), "⌘9 is retired (C119)")
    #expect(Set(keyed).count == keyed.count, "two items share a key")
    // ⌘N is New Capture; New Conversation moved to ⇧⌘N
    #expect(ShellCommand.newCapture.shortcut == .command("n"))
    #expect(ShellCommand.newConversation.shortcut == .command("n", .shift))
    // the any-app five are system-wide hot keys, off by default — never menu keys (C120)
    for command in [ShellCommand.ask, .note, .todo, .startRecording, .stopRecording] {
        #expect(command.shortcut == nil, "\(command)")
    }
}

@Test func singleKeysAttachOnlyWhileAListHasFocus() {
    let single = ShellCommand.allCases.filter { $0.shortcut?.isSingleKey == true }
    #expect(Set(single) == [.open, .approve, .revise, .decline, .later, .complete, .move])
    for command in single {
        #expect(command.shortcut(listHasFocus: false) == nil, "\(command) would take its key from a text field")
        #expect(command.shortcut(listHasFocus: true) == command.shortcut)
    }
    // a key with a modifier is bound either way
    #expect(ShellCommand.runNow.shortcut(listHasFocus: false) == .command("r"))
}

@Test func aShortcutIsSpokenTheWayVoiceOverSaysIt() {
    #expect(ShellCommand.newCapture.spokenLabel(assistantName: nil) == "New Capture, Command-N")
    #expect(ShellCommand.pause.shortcut?.spoken == "Option-Command-P")
    #expect(ShellCommand.toggleSidebar.shortcut?.spoken == "Control-Command-S")
    #expect(ShellCommand.handToAgent.spokenLabel(assistantName: nil) == "Hand to an Agent, Shift-Command-P")
    #expect(ShellCommand.back.shortcut?.spoken == "Command-Left Bracket")
    #expect(ShellCommand.ask.spokenLabel(assistantName: "Aide") == "Ask Aide")
}

// MARK: - Who may answer what

@MainActor
@Test func aScreenCanLightOnlyItsOwnItemsAndNeverAddOne() {
    var fired: [ShellCommand] = []
    let table: ShellActionTable = [
        .filter: { fired.append(.filter) },
        .approve: { fired.append(.approve) },
        .today: { fired.append(.today) },
        .newCapture: { fired.append(.newCapture) },
    ]
    #expect(Set(table.answerable(by: .screen).keys) == [.filter])
    #expect(Set(table.answerable(by: .item).keys) == [.approve])
    // a screen table never reaches the shell's own commands
    #expect(table.answerable(by: .screen)[.today] == nil)
    #expect(table.answerable(by: .item)[.newCapture] == nil)
}

@MainActor
@Test func aCaptureItemWithNothingBehindItIsDimmedAndRunsNothing() {
    let shell = ShellModel(stores: nil, defaults: shellDefaults())
    #expect(!shell.canPerform(.newCapture))
    shell.perform(.newCapture)   // nothing to run, and nothing crashes

    var composed = 0
    shell.captureActions[.newCapture] = { composed += 1 }
    #expect(shell.canPerform(.newCapture))
    shell.perform(.newCapture)
    #expect(composed == 1)

    // the capture table cannot light anything outside the Capture menu
    shell.captureActions[.approve] = { Issue.record("an Item command ran from the capture table") }
    shell.captureActions[.newConversation] = { Issue.record("a screen command ran from the capture table") }
    #expect(!shell.canPerform(.approve))
    #expect(!shell.canPerform(.newConversation))
    shell.perform(.approve)
    shell.perform(.newConversation)
}

// MARK: - No label says "assistant"

/// Every word the shell can put on screen or say, for a given name.
@MainActor
private func everyShellLabel(assistantName: String?) -> [String] {
    var labels: [String] = []
    labels += ShellCommand.allCases.map { $0.title(assistantName: assistantName) }
    labels += ShellCommand.allCases.map { $0.spokenLabel(assistantName: assistantName) }
    labels += ShellMenu.allCases.map(\.rawValue)
    labels += ShellSection.allCases.map(\.title)
    let destinations: [Destination] = [.needsYou, .today, .chat, .activity, .board, .projects, .artifacts, .knowledge, .agents, .scheduled]
    labels += destinations.map(\.title)
    labels += destinations.map { ShellDetail.notYet($0, waiting: 3) }
    labels += [0, 1, 150].map(NeedsYouBadge.spoken)
    labels += [
        UsageGauge.unknown,
        UsageGauge(today: 1.84, month: 20, dailyLimit: 5, monthlyLimit: 60),
        UsageGauge(today: 1, month: 30, dailyLimit: nil, monthlyLimit: 60),
    ].map(\.spokenLabel)
    labels += ScreenKeys.all.flatMap { [$0.screen, $0.keys] }
    labels += [ShellTitle.window]
    return labels
}

@MainActor
@Test func noLabelSaysAssistant() {
    for name in ["Aide", nil] as [String?] {
        for label in everyShellLabel(assistantName: name) {
            #expect(!label.localizedCaseInsensitiveContains("assistant"), "\"\(label)\" says assistant")
            #expect(!containsHardcodedName(label), "\"\(label)\" names the assistant without asking identity")
        }
    }
    // the configured name is what reaches the label
    #expect(everyShellLabel(assistantName: "Aide").contains("Ask Aide"))
    #expect(everyShellLabel(assistantName: "Ada").contains("Ask Ada"))
}

@Test func noStringInTheShellsSourceSaysAssistantOrNamesOne() throws {
    let root = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let files = [
        "sources/kit/root-view.swift",
        "sources/kit/shell-model.swift",
        "sources/kit/shell-commands.swift",
        "sources/kit/keyboard-shortcuts-view.swift",
        "sources/app/metistry-app.swift",
    ]
    for file in files {
        let text = try String(contentsOf: root.appendingPathComponent(file), encoding: .utf8)
        let literals = stringLiterals(in: text)
        #expect(literals.count > 3, "\(file): the scan found almost nothing")
        for literal in literals {
            #expect(!literal.localizedCaseInsensitiveContains("assistant"), "\(file): \"\(literal)\"")
            #expect(!containsHardcodedName(literal), "\(file): \"\(literal)\"")
        }
    }
}

// MARK: - Help ▸ Keyboard Shortcuts

@Test func theKeyboardShortcutsPageListsEveryKeyTheMenusHaveAndNoOther() {
    let listed = ShellMenu.allCases.flatMap(KeyboardShortcutsView.rows)
    let keyed = ShellCommand.allCases.filter { $0.shortcut != nil }
    #expect(Set(listed) == Set(keyed))
    #expect(listed.count == keyed.count)
    // components-02's per-screen table, all ten rows
    #expect(ScreenKeys.all.count == 10)
    #expect(ScreenKeys.all.first { $0.screen == "Chat" }?.keys.contains("⇧⌘N new conversation") == true)
}

// MARK: - Helpers

/// "Metis" as a word — not "Metistry", which is the product.
private func containsHardcodedName(_ text: String) -> Bool {
    text.range(of: #"\bMetis\b"#, options: .regularExpression) != nil
}

/// The contents of every `"…"` literal outside comments, one line at a time —
/// enough for this code, which has no multi-line literals.
private func stringLiterals(in source: String) -> [String] {
    var out: [String] = []
    for line in source.split(separator: "\n", omittingEmptySubsequences: false) {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard !trimmed.hasPrefix("//") else { continue }
        var inside = false
        var escaped = false
        var current = ""
        var previous: Character = " "
        for c in line {
            if inside {
                if escaped { current.append(c); escaped = false; continue }
                if c == "\\" { escaped = true; current.append(c); continue }
                if c == "\"" { out.append(current); current = ""; inside = false; continue }
                current.append(c)
            } else {
                // a trailing `//` comment ends the code on this line
                if c == "/" && previous == "/" { break }
                if c == "\"" { inside = true }
            }
            previous = c
        }
    }
    return out
}

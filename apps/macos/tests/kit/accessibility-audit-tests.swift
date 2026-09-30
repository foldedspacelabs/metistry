// The audit's accessibility half (T6-16; plan §2.18.7: "a SwiftUI
// accessibility test per view fails on an unlabeled control").
//
// EVERY VIEW IS PROBED. `viewCoverage` names, for each file under
// `sources/kit/` that declares a SwiftUI view, the test that puts it in a real
// window and walks its accessibility tree (`AccessibilityProbe`). The first
// test scans the sources, so a new view file with no probe fails here rather
// than shipping unheard. The views no screen's own tests reached — the Status
// window, the log window, the menu bar's menu, the wizard's every step, the
// CLI cards, the shared components and Settings ▸ Keyboard — are probed below.

#if os(macOS)
import AppKit
import Foundation
import SwiftUI
import Testing

@testable import MetistryKit

/// A view file, and where its probe lives: the test file, and a view type of
/// the source file that test constructs. `via` is the file that draws this
/// one's views when the test constructs a container instead.
private struct Coverage {
    let test: String
    let probes: String
    var via: String? = nil
}

private let viewCoverage: [String: Coverage] = [
    "activity-view.swift": Coverage(test: "activity-view-tests.swift", probes: "ActivityView"),
    "agent-detail-view.swift": Coverage(test: "agents-view-tests.swift", probes: "AccessEditorSheet"),
    "agents-view.swift": Coverage(test: "agents-view-tests.swift", probes: "AgentsView"),
    "artifacts-view.swift": Coverage(test: "artifacts-view-tests.swift", probes: "ArtifactsView"),
    "board-view.swift": Coverage(test: "board-view-tests.swift", probes: "BoardView"),
    "capture-bar-view.swift": Coverage(test: "capture-bar-tests.swift", probes: "CaptureBarView"),
    "capture-view.swift": Coverage(test: "capture-view-tests.swift", probes: "CaptureComposerView"),
    "card-detail-view.swift": Coverage(test: "board-view-tests.swift", probes: "CardDetailView"),
    "chat-view.swift": Coverage(test: "chat-view-tests.swift", probes: "ChatView"),
    "cli-cards.swift": Coverage(test: "accessibility-audit-tests.swift", probes: "CommandCard"),
    "components/component-kit.swift": Coverage(test: "accessibility-audit-tests.swift", probes: "ControlButton"),
    "compute-view.swift": Coverage(test: "compute-pane-tests.swift", probes: "ComputePaneView"),
    "connections-view.swift": Coverage(test: "connections-view-tests.swift", probes: "ConnectionsListView"),
    "keyboard-shortcuts-view.swift": Coverage(test: "shell-accessibility-tests.swift", probes: "KeyboardShortcutsView"),
    "knowledge-view.swift": Coverage(test: "knowledge-view-tests.swift", probes: "KnowledgeView"),
    "log-window-view.swift": Coverage(test: "accessibility-audit-tests.swift", probes: "LogWindowView"),
    "menu-bar-view.swift": Coverage(test: "accessibility-audit-tests.swift", probes: "MenuBarContent"),
    "needs-you-view.swift": Coverage(test: "needs-you-view-tests.swift", probes: "NeedsYouView"),
    "projects-view.swift": Coverage(test: "projects-view-tests.swift", probes: "ProjectsView"),
    "request-bodies/meeting-card.swift": Coverage(test: "request-bodies-accessibility-tests.swift", probes: "MeetingCardView"),
    "request-bodies/request-card-view.swift": Coverage(test: "request-bodies-accessibility-tests.swift", probes: "RequestCardView"),
    "room-view.swift": Coverage(test: "board-view-tests.swift", probes: "RoomPane"),
    "root-view.swift": Coverage(test: "shell-accessibility-tests.swift", probes: "RootView"),
    "routine-detail-view.swift": Coverage(test: "scheduled-view-tests.swift", probes: "SyncDetailView"),
    "run-detail-view.swift": Coverage(test: "run-detail-view-tests.swift", probes: "RunDetailView"),
    "scheduled-view.swift": Coverage(test: "scheduled-view-tests.swift", probes: "ScheduledView"),
    "secrets-view.swift": Coverage(test: "secrets-variables-tests.swift", probes: "SecretEditorView"),
    "settings-view.swift": Coverage(test: "settings-window-tests.swift", probes: "SettingsSidebar"),
    // Every Settings pane is probed by settings-window-tests' walk over every section.
    "settings-panes/account-pane.swift": Coverage(test: "settings-window-tests.swift", probes: "SettingsPaneContent", via: "settings-view.swift"),
    "settings-panes/advanced-pane.swift": Coverage(test: "settings-window-tests.swift", probes: "SettingsPaneContent", via: "settings-view.swift"),
    "settings-panes/updates-pane.swift": Coverage(test: "settings-window-tests.swift", probes: "SettingsPaneContent", via: "settings-view.swift"),
    "settings-panes/instance-pane.swift": Coverage(test: "history-view-tests.swift", probes: "InstanceHistorySection"),
    "settings-panes/instance-sheets.swift": Coverage(test: "settings-window-tests.swift", probes: "IdentityEditorView"),
    "settings-panes/keyboard-pane.swift": Coverage(test: "accessibility-audit-tests.swift", probes: "KeyboardPane"),
    "settings-panes/live-capture-pane.swift": Coverage(test: "live-capture-pane-tests.swift", probes: "LiveCapturePaneBody"),
    "settings-panes/sessions-pane.swift": Coverage(test: "sessions-pane-tests.swift", probes: "SessionsPaneBody"),
    "settings-panes/services-pane.swift": Coverage(test: "settings-window-tests.swift", probes: "LidClosedDialogView"),
    "status-panel.swift": Coverage(test: "accessibility-audit-tests.swift", probes: "StatusPanel"),
    "today-brief-view.swift": Coverage(test: "today-view-tests.swift", probes: "TodayView", via: "today-view.swift"),
    "today-view.swift": Coverage(test: "today-view-tests.swift", probes: "TodayView"),
    "usage-view.swift": Coverage(test: "shell-accessibility-tests.swift", probes: "UsageView"),
    "variables-view.swift": Coverage(test: "secrets-variables-tests.swift", probes: "VariableEditorView"),
    "wizard-step-views.swift": Coverage(test: "accessibility-audit-tests.swift", probes: "PasskeyStepView"),
    "wizard-view.swift": Coverage(test: "accessibility-audit-tests.swift", probes: "WizardView"),
]

// MARK: - Every view file has a probe

@Test func everyViewInTheKitIsProbedByAnAccessibilityTest() throws {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let kit = root.appendingPathComponent("sources/kit")
    let tests = root.appendingPathComponent("tests/kit")
    let files = FileManager.default.enumerator(at: kit, includingPropertiesForKeys: nil)?
        .compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" } ?? []
    var viewFiles: [String: [String]] = [:]
    for file in files {
        let text = try String(contentsOf: file, encoding: .utf8)
        let types = viewTypes(in: text)
        guard !types.isEmpty else { continue }
        viewFiles[String(file.path.dropFirst(kit.path.count + 1))] = types
    }
    #expect(viewFiles.count > 40, "the scan found almost nothing")

    // the shared components: each is drawn and probed from its samples, below
    let components = viewFiles.keys.filter { $0.hasPrefix("components/") && viewCoverage[$0] == nil }
    let sampled = Set(try componentSampleStems())
    for file in components {
        let stem = String(file.dropFirst("components/".count).dropLast(".swift".count))
        #expect(sampled.contains(stem), "\(file): no component sample draws it, so nothing probes it")
    }

    for (file, types) in viewFiles.sorted(by: { $0.key < $1.key }) where !components.contains(file) {
        guard let coverage = viewCoverage[file] else {
            Issue.record("\(file) declares \(types) and no accessibility test probes it — add one and a row to viewCoverage")
            continue
        }
        let test = try String(contentsOf: tests.appendingPathComponent(coverage.test), encoding: .utf8)
        #expect(test.contains("AccessibilityProbe.snapshot("), "\(coverage.test) probes nothing")
        #expect(test.contains("\(coverage.probes)("), "\(coverage.test) never constructs \(coverage.probes)")
        if let via = coverage.via {
            let container = try String(contentsOf: kit.appendingPathComponent(via), encoding: .utf8)
            #expect(viewTypes(in: container).contains(coverage.probes) || via == "settings-view.swift", "\(coverage.probes) is not \(via)'s")
            #expect(types.contains { container.contains("\($0)(") }, "\(via) draws none of \(file)'s views")
        } else {
            #expect(types.contains(coverage.probes), "\(coverage.probes) is not declared in \(file)")
        }
    }
    #expect(Set(viewCoverage.keys).isSubset(of: Set(viewFiles.keys)), "a coverage row names a file with no view: \(Set(viewCoverage.keys).subtracting(viewFiles.keys))")
}

// MARK: - The views no other test reached

@MainActor
@Test func theSharedComponentsSpeakEveryControl() async throws {
    let samples = try await componentSamples()
    #expect(samples.count > 10)
    for sample in samples {
        guard let view = sample.view else { continue }
        let tree = try await AccessibilityProbe.snapshot(view().frame(width: 520))
        defer { tree.close() }
        // (no "assistant" check: a sample's actor ids are the wire's data, `assistant` among them)
        #expect(tree.unlabeledControls.isEmpty, "\(sample.component)/\(sample.name) unlabeled: \(tree.unlabeledControls)")
    }
}

@MainActor
@Test func theStatusLogAndMenuBarWindowsSpeakEveryControl() async throws {
    let app = auditApp()
    let views: [(String, AnyView)] = [
        ("status", AnyView(StatusPanel(model: app.status, signIn: app.consoleSignIn, runtime: nil).frame(width: 760, height: 600))),
        ("log", AnyView(LogWindowView(model: app.logs).frame(width: 760, height: 520))),
        ("menu bar", AnyView(VStack(alignment: .leading) {
            MenuBarContent(model: app.menu, updates: app.updates, signIn: app.consoleSignIn, openWindow: {}, openLog: { _ in }, onQuit: {})
        }.frame(width: 320))),
        ("cards", AnyView(VStack(alignment: .leading) {
            CommandCard(arguments: [["metistry", "doctor", "--json"]])
            NotYetCard(reason: "Not in this build yet.")
            UnavailableCard(what: "Doctor", reason: "the CLI did not answer", command: "metistry doctor")
            FactRow("Runtime", "0.9.0", help: "The runtime this app runs.")
            ConsoleSignInCard(model: app.consoleSignIn)
            ChoiceRow(title: "Git checkout", detail: "A product checkout", selected: true, choose: {})
            StatusDot(.ok)
            ControlButton(ControlSpec("Save", role: .primary)) {}
            ControlButton(ControlSpec("", glyph: .undo, role: .plain, name: "Undo")) {}
        }.frame(width: 560))),
    ]
    for (name, view) in views {
        let tree = try await AccessibilityProbe.snapshot(view)
        defer { tree.close() }
        #expect(tree.unlabeledControls.isEmpty, "\(name) unlabeled: \(tree.unlabeledControls)")
        #expect(tree.saysAssistant.isEmpty, "\(name): \(tree.saysAssistant)")
    }
}

@MainActor
@Test func everyStepOfTheWizardSpeaksEveryControl() async throws {
    let app = auditApp()
    for step in FirstRunStep.allCases {
        app.wizard.present(from: step)
        let tree = try await AccessibilityProbe.snapshot(
            WizardView(model: app.wizard, bridges: [], resolvedShape: nil, developerProductDir: nil, onRelocate: {}, onChooseDeveloperProductDirectory: { _ in })
                .frame(width: 720, height: 640)
        )
        defer { tree.close() }
        // (no "assistant" check: the wizard runs before identity.yaml names one)
        #expect(tree.unlabeledBesidesFields.isEmpty, "\(step) unlabeled: \(tree.unlabeledBesidesFields)")
    }
    for view in [
        AnyView(PasskeyStepView(steps: app.firstRun)),
        AnyView(PasskeyDiagnosticView(model: app.firstRun.passkey)),
        AnyView(ComputeStepView(model: app.firstRun.compute)),
    ] {
        let tree = try await AccessibilityProbe.snapshot(view.frame(width: 640))
        defer { tree.close() }
        #expect(tree.unlabeledBesidesFields.isEmpty, "unlabeled: \(tree.unlabeledBesidesFields)")
    }
}

// MARK: - Settings ▸ Keyboard, spoken

@MainActor
@Test func theKeyboardPaneSaysEachRowItsKeyAndWhatIsWrongInWords() async throws {
    let app = auditApp()
    let registrar = FakeHotKeys()
    registrar.takenByAnotherApp = [AnyAppShortcut.todo.suggestedShortcut]
    app.hotKeys.systemShortcuts = { SystemShortcuts(entries: []) }
    app.hotKeys.attach(registrar)

    func pane() -> some View {
        VStack(alignment: .leading) {
            KeyboardPane(assistantName: "Aide", actions: SettingsActions(), shortcuts: app.hotKeys, isAnswered: { $0 == .note })
        }
        .frame(width: SettingsLayout.pane)
    }

    // off: the switch, the five dimmed with their suggested keys, nothing registered
    let off = try await AccessibilityProbe.snapshot(pane())
    defer { off.close() }
    #expect(off.unlabeledControls.isEmpty, "unlabeled: \(off.unlabeledControls)")
    #expect(off.controlNames.contains("Shortcuts in any app"), "controls: \(off.controlNames)")
    #expect(off.controlNames.contains("Ask Aide, Control-Option-Command-A. Change"), "controls: \(off.controlNames)")
    #expect(off.texts.contains("Off: nothing is registered with macOS."), "texts: \(off.texts)")
    #expect(registrar.live.isEmpty)

    // on, with To-do held by another app: it says so, and nothing is registered
    app.hotKeys.setOn(true)
    let taken = try await AccessibilityProbe.snapshot(pane())
    defer { taken.close() }
    #expect(taken.unlabeledControls.isEmpty, "unlabeled: \(taken.unlabeledControls)")
    #expect(taken.texts.contains("Another app already uses this. Pick another."), "texts: \(taken.texts)")
    #expect(taken.texts.contains("Nothing is registered until every row is clear."), "texts: \(taken.texts)")
    #expect(taken.controlNames.contains("Clear the To-do shortcut"), "controls: \(taken.controlNames)")
    #expect(registrar.live.isEmpty)

    // cleared: the other four register, and a row nothing answers says so
    app.hotKeys.clear(.todo)
    let on = try await AccessibilityProbe.snapshot(pane())
    defer { on.close() }
    #expect(on.controlNames.contains("To-do, no shortcut. Record Shortcut"), "controls: \(on.controlNames)")
    #expect(on.texts.contains("On: these work in any app."), "texts: \(on.texts)")
    #expect(on.texts.filter { $0 == KeyboardPaneWords.unanswered }.count == 3, "Ask and the two recording rows have nothing behind them: \(on.texts)")
    #expect(registrar.live.count == 4)

    // recording: the row asks for a key
    app.hotKeys.beginRecording(.ask)
    let recording = try await AccessibilityProbe.snapshot(pane())
    defer { recording.close() }
    #expect(recording.nodes.contains { $0.name == "Ask Aide, press a shortcut" }, "nodes: \(recording.nodes.map(\.name))")
    #expect(registrar.live.isEmpty)
}

@MainActor
@Test func helpSaysWhichDocumentedKeysAreNotBoundAndWhatTheAnyAppFiveDo() async throws {
    let app = auditApp()
    let tree = try await AccessibilityProbe.snapshot(KeyboardShortcutsView(shell: app.shell, anyApp: app.hotKeys).frame(width: 560, height: 1600))
    defer { tree.close() }
    let spoken = tree.nodes.map(\.name).joined(separator: "\n")
    for key in KeyTable.documented where !key.binding.isBound {
        #expect(spoken.contains(key.unboundNote!), "\(key.id) is listed without saying it is not bound")
    }
    #expect(tree.headings.contains("Everywhere"), "headings: \(tree.headings)")
    #expect(tree.headings.contains("In Any App"), "headings: \(tree.headings)")
    #expect(tree.nodes.contains { $0.name == "To-do, off" }, "the five say they are off: \(tree.nodes.map(\.name))")
    #expect(tree.nodes.contains { $0.name == "Settings… and Quit, in the menu bar item, Command-Comma, Command-Q" })
}

// MARK: - Helpers

@MainActor
private func auditApp() -> AppModel {
    let name = "com.foldedspacelabs.metistry.tests.audit.\(UUID().uuidString)"
    return AppModel(bundleResourceURL: nil, runner: ShellNoopRunner(), defaults: UserDefaults(suiteName: name)!)
}

/// The view types a source file declares.
private func viewTypes(in source: String) -> [String] {
    let pattern = #"(?m)^(?:public |private |fileprivate |internal )?struct ([A-Za-z]+)(?:<[^>]*>)?\s*:\s*View\b"#
    let regex = try! NSRegularExpression(pattern: pattern)
    let range = NSRange(source.startIndex..., in: source)
    return regex.matches(in: source, range: range).compactMap { Range($0.range(at: 1), in: source).map { String(source[$0]) } }
}

/// The component stems component-samples.swift draws (`add("stem", …)`).
private func componentSampleStems() throws -> [String] {
    let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("component-samples.swift")
    let text = try String(contentsOf: file, encoding: .utf8)
    let regex = try NSRegularExpression(pattern: #"add\("([a-z-]+)""#)
    return regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { Range($0.range(at: 1), in: text).map { String(text[$0]) } }
}
#endif

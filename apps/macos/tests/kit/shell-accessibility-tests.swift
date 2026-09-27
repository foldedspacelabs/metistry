// §2.18.7: a SwiftUI accessibility test per view that fails on an unlabeled
// control. Each view is put in a real window and its accessibility tree — the
// one VoiceOver reads — is walked: every control must say something, and
// nothing may say "assistant". The shell's own Spoken rows (components-02 §3)
// are then checked word for word, and the window's title is the product's.
//
// How the tree is read. AppKit builds SwiftUI's accessibility elements only for
// a client that asks, so the probe asks the way an assistive app does
// (`AXManualAccessibility` on the application), then walks both halves of the
// API: AppKit's views answer the attribute form, SwiftUI's nodes the protocol
// form.

#if os(macOS)
import AppKit
import SwiftUI
import Testing

@testable import MetistryKit

// MARK: - The window

@MainActor
@Test func theWindowSpeaksEveryControlAndTheSpokenRowsVerbatim() async throws {
    let model = try await fixtureAppModel()
    model.shell.pins.pin(.project("lease", displayName: "Lease Renewal"))
    let tree = try await AccessibilityProbe.snapshot(RootView(model: model).frame(width: 980, height: 640))
    defer { tree.close() }

    #expect(tree.window.title == "Metistry", "the title is the product's on every screen")
    #expect(tree.selectedSidebarRow == "Today", "the window opens on Today")
    #expect(tree.unlabeledControls.isEmpty, "unlabeled: \(tree.unlabeledControls)")
    #expect(tree.saysAssistant.isEmpty, "says assistant: \(tree.saysAssistant)")

    // the sidebar: the Needs You row first, then the eight in order
    let rows = tree.sidebarRows
    #expect(rows == [
        "Needs You, 4 waiting", "Today", "Chat", "Activity", "Work", "Knowledge", "Agents", "Scheduled",
        "Pinned", "Lease Renewal",
    ], "sidebar: \(rows)")
    // the toolbar's two glyph-only controls say their names (and the shortcut the + has)
    #expect(tree.toolbarButtons.contains("New Capture, Command-N"), "toolbar: \(tree.toolbarButtons)")
    #expect(tree.toolbarButtons.contains("Usage, $0.00 today"), "toolbar: \(tree.toolbarButtons)")
    #expect(!tree.toolbarButtons.contains { $0.localizedCaseInsensitiveContains("bell") || $0 == "Needs You" }, "no bell on the Mac toolbar (C110)")
}

@MainActor
@Test func nothingNeedsYouKeepsTheRowUntilTheOwnerGoesElsewhere() async throws {
    let model = try await fixtureAppModel()
    model.shell.navigate(to: .needsYou)
    model.shell.apply(waiting: 0)
    let tree = try await AccessibilityProbe.snapshot(RootView(model: model).frame(width: 980, height: 640))
    defer { tree.close() }

    #expect(tree.sidebarRows.first == "Needs You, nothing waiting")
    #expect(tree.selectedSidebarRow == "Needs You, nothing waiting", "selected: \(String(describing: tree.selectedSidebarRow))")
    #expect(tree.texts.contains("Nothing needs you"), "texts: \(tree.texts)")
    #expect(tree.unlabeledControls.isEmpty, "unlabeled: \(tree.unlabeledControls)")
}

@MainActor
@Test func aSelectedChildOfWorkIsShownWithItsGroupOpen() async throws {
    let model = try await fixtureAppModel()
    model.shell.perform(.work)
    let tree = try await AccessibilityProbe.snapshot(RootView(model: model).frame(width: 980, height: 640))
    defer { tree.close() }

    let rows = tree.sidebarRows
    let work = try #require(rows.firstIndex(of: "Work"))
    #expect(Array(rows[(work + 1)...].prefix(3)) == ["Board", "Projects", "Artifacts"], "sidebar: \(rows)")
    #expect(tree.selectedSidebarRow == "Board", "selected: \(String(describing: tree.selectedSidebarRow))")
    #expect(tree.unlabeledControls.isEmpty, "unlabeled: \(tree.unlabeledControls)")
}

// MARK: - Help ▸ Keyboard Shortcuts, and the gauge's popover

@MainActor
@Test func theKeyboardShortcutsPageSpeaksEachItemWithItsKeys() async throws {
    let model = try await fixtureAppModel()
    let tree = try await AccessibilityProbe.snapshot(KeyboardShortcutsView(shell: model.shell).frame(width: 560, height: 900))
    defer { tree.close() }

    #expect(tree.unlabeledControls.isEmpty, "unlabeled: \(tree.unlabeledControls)")
    #expect(tree.saysAssistant.isEmpty, "says assistant: \(tree.saysAssistant)")
    #expect(tree.labels.contains("New Capture, Command-N"), "labels: \(tree.labels)")
    #expect(tree.labels.contains("Approve, A"))
}

@MainActor
@Test func theGaugesPopoverSpeaksAndLeadsToTheLimits() async throws {
    let gauge = UsageGauge(today: 1.84, month: 20, dailyLimit: 5, monthlyLimit: 60)
    let tree = try await AccessibilityProbe.snapshot(UsageGaugeSummary(gauge: gauge))
    defer { tree.close() }

    #expect(tree.unlabeledControls.isEmpty, "unlabeled: \(tree.unlabeledControls)")
    #expect(tree.texts.contains("$1.84 today"), "texts: \(tree.texts)")
    #expect(tree.texts.contains("37% of the day's budget"))
    #expect(tree.controlNames.contains("Spending Limits in Settings…"), "controls: \(tree.controlNames)")
}

// MARK: - The probe fails when it should

/// The test for the test: a glyph-only button with no name is caught.
@MainActor
@Test func theProbeCatchesAnUnlabeledGlyphButton() async throws {
    // (An SF Symbol is never caught here: the system names it for its glyph —
    // `plus` says "Add" — which is why the shell's glyph controls are held to
    // their Spoken names word for word above, not merely to saying something.)
    let view = HStack {
        Button {} label: { Circle().frame(width: 12, height: 12) }
        Button("Named") {}
    }
    let tree = try await AccessibilityProbe.snapshot(view)
    defer { tree.close() }
    #expect(tree.unlabeledControls.count == 1, "caught: \(tree.unlabeledControls)")
}

// MARK: - Helpers

@MainActor
private func fixtureAppModel() async throws -> AppModel {
    let name = "com.foldedspacelabs.metistry.tests.shell-ax.\(UUID().uuidString)"
    let model = AppModel(bundleResourceURL: nil, runner: ShellNoopRunner(), defaults: UserDefaults(suiteName: name)!)
    model.shell.adopt(stores: ConsoleStores(transport: try FixtureConsole.recorded()))
    await model.shell.refresh()
    return model
}

struct AXNode: Sendable, CustomStringConvertible {
    let type: String
    let role: String
    let label: String
    let title: String
    let value: String
    let selected: Bool
    let path: [String]

    var name: String { [label, title, value].first { !$0.isEmpty } ?? "" }
    var description: String { "\(role) \(type) “\(name)” in \(path.suffix(3).joined(separator: " › "))" }
}

@MainActor
struct AXTree {
    let window: NSWindow
    let nodes: [AXNode]

    func close() { window.orderOut(nil); window.close() }

    static let controlRoles: Set<String> = [
        "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXLink",
        "AXTextField", "AXTextArea", "AXSlider", "AXComboBox", "AXIncrementor", "AXSegmentedControl",
    ]

    /// The window's own chrome — close, zoom, minimise, a scroll bar's arrows
    /// — is AppKit's, not ours.
    private func isChrome(_ node: AXNode) -> Bool {
        node.type.hasPrefix("_NSTheme") || node.path.contains { $0.hasPrefix("_NSTheme") || $0 == "AXScrollBar" }
    }

    var controls: [AXNode] { nodes.filter { Self.controlRoles.contains($0.role) && !isChrome($0) } }
    var controlNames: [String] { controls.map(\.name) }
    var unlabeledControls: [AXNode] { controls.filter { $0.name.trimmingCharacters(in: .whitespaces).isEmpty } }
    var labels: [String] { nodes.map(\.label).filter { !$0.isEmpty } }
    var texts: [String] { nodes.filter { $0.role == "AXStaticText" }.map(\.name) }
    var saysAssistant: [AXNode] { nodes.filter { $0.name.localizedCaseInsensitiveContains("assistant") } }

    /// What each sidebar row says, in order.
    var sidebarRows: [String] {
        nodes.filter { $0.path.contains("AXOutline") && $0.role != "AXRow" && $0.role != "AXCell" && $0.role != "AXOutline" && $0.role != "AXColumn" && $0.role != "AXDisclosureTriangle" && !$0.name.isEmpty }
            .map(\.name)
    }

    /// What the selected sidebar row says: the text inside the one selected AXRow.
    var selectedSidebarRow: String? {
        guard let row = nodes.firstIndex(where: { $0.role == "AXRow" && $0.selected && $0.path.contains("AXOutline") }) else { return nil }
        return nodes[(row + 1)...].first { $0.role != "AXCell" && !$0.name.isEmpty }?.name
    }

    var toolbarButtons: [String] {
        nodes.filter { $0.path.contains("AXToolbar") && $0.role == "AXButton" }.map(\.name)
    }
}

@MainActor
enum AccessibilityProbe {
    /// Asks for SwiftUI's accessibility elements the way an assistive app does.
    static func enable() {
        let app = NSApplication.shared
        let set = NSSelectorFromString("accessibilitySetValue:forAttribute:")
        if app.responds(to: set) {
            app.perform(set, with: NSNumber(value: true), with: "AXManualAccessibility")
            app.perform(set, with: NSNumber(value: true), with: "AXEnhancedUserInterface")
        }
    }

    static func snapshot<V: View>(_ view: V) async throws -> AXTree {
        enable()
        let host = NSHostingView(rootView: view)
        let size = host.fittingSize
        let frame = NSRect(x: 0, y: 0, width: max(size.width, 200), height: max(size.height, 120))
        let window = NSWindow(contentRect: frame, styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.orderFront(nil)
        host.layoutSubtreeIfNeeded()
        // let SwiftUI settle: layout, the toolbar, and the accessibility tree
        try await Task.sleep(for: .milliseconds(500))
        var nodes: [AXNode] = []
        walk(window, path: [], into: &nodes)
        return AXTree(window: window, nodes: nodes)
    }

    private static func attribute(_ element: Any, _ name: String) -> Any? {
        guard let object = element as? NSObject else { return nil }
        let selector = NSSelectorFromString("accessibilityAttributeValue:")
        guard object.responds(to: selector) else { return nil }
        return object.perform(selector, with: name)?.takeUnretainedValue()
    }

    private static func walk(_ element: Any, path: [String], into nodes: inout [AXNode]) {
        guard path.count < 60 else { return }
        let object = element as AnyObject
        let type = String(describing: Swift.type(of: element))
        let oldRole = attribute(element, "AXRole") as? String
        let role = oldRole ?? object.accessibilityRole?()?.rawValue ?? "?"
        var label = (attribute(element, "AXDescription") as? String) ?? ""
        var title = (attribute(element, "AXTitle") as? String) ?? ""
        var value = ""
        if oldRole == nil {
            if label.isEmpty { label = object.accessibilityLabel?() ?? "" }
            if title.isEmpty { title = object.accessibilityTitle?() ?? "" }
            let raw: Any?? = object.accessibilityValue?()
            if let raw, let raw { value = "\(raw)" }
        } else if let v = attribute(element, "AXValue") as? String {
            value = v
        }
        let selected = (attribute(element, "AXSelected") as? NSNumber)?.boolValue ?? false
        nodes.append(AXNode(type: type, role: role, label: label, title: title, value: value, selected: selected, path: path))
        // AppKit's children, then SwiftUI's where AppKit's are not the whole
        // story: a hosting scroll view answers its scroll bars one way and its
        // content the other. (An outline answers its rows both ways.)
        var children = (attribute(element, "AXChildren") as? [Any]) ?? []
        if children.isEmpty || type.contains("Hosting") {
            var seen = Set(children.map { ObjectIdentifier($0 as AnyObject) })
            for child in (object.accessibilityChildren?()).flatMap({ $0 }) ?? [] where seen.insert(ObjectIdentifier(child as AnyObject)).inserted {
                children.append(child)
            }
        }
        for child in children {
            walk(child, path: path + [role, type], into: &nodes)
        }
    }
}
#endif

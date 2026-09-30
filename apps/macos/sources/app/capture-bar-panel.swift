// The floating bar's window (screen 11; design-build-plan T8-5). Everything
// drawn in it is MetistryKit's (`CaptureBarView`, capture-bar-view.swift) and
// everything decided is `CaptureBarModel`'s; this file is the part only a
// Mac has — a floating, non-activating panel docked to a screen edge, which
// joins every Space and sits over full-screen apps, and the running apps
// *Audio only* may list.
//
// PLACEMENT. The right edge of the main display, centred vertically, until
// Settings ▸ Live Capture offers the edge and the display (screen 11 §8 —
// not this ticket's). Top and bottom are never offered: the menu bar owns
// the top, the Dock and the system's recording pill the bottom. The panel
// is exactly the size of what it shows, anchored at its top-right corner, so
// a panel opening beside the rail grows leftward and the rail never moves —
// and nothing transparent sits over the desktop catching clicks.
//
// FOCUS. The panel never activates the app: a click on the rail leaves the
// meeting's window where it was. It becomes key only when a field needs the
// keyboard (Note, To-do, Ask), so typing lands in the bar and Return saves.
//
// macOS's own orange recording indicator is untouched: never suppressed,
// never imitated.

import AppKit
import MetistryKit
import Observation
import SwiftUI

@MainActor
final class CaptureBarPanelController {
    private let model: CaptureBarModel
    private let panel: CaptureBarWindow
    private let host: NSHostingView<AnyView>
    /// The bar's top-right corner, kept while its content changes size.
    private var anchor: NSPoint?

    /// The gap between the rail and the screen's edge (the board's 9pt).
    static let edgeGap: CGFloat = 9

    init(model: CaptureBarModel) {
        self.model = model
        host = NSHostingView(rootView: AnyView(EmptyView()))
        panel = CaptureBarWindow(
            contentRect: NSRect(x: 0, y: 0, width: 60, height: 200),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: true
        )
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false        // the glass draws its own ground
        panel.isMovableByWindowBackground = false
        panel.isReleasedWhenClosed = false
        panel.setAccessibilityRole(.group)
        panel.setAccessibilityLabel(CaptureBarWords.group)

        host.rootView = AnyView(
            CaptureBarView(model: model)
                .background(SizeReader { [weak self] size in self?.fit(size) })
        )
        host.sizingOptions = []
        panel.contentView = host
        follow()
    }

    /// Shows or hides the panel as the model says, and gives it the keyboard
    /// when a field is open — re-armed on every change it reads.
    private func follow() {
        withObservationTracking {
            _ = model.isShown
            _ = model.panel
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in self?.follow() }
        }
        if model.isShown {
            if !panel.isVisible {
                fit(host.fittingSize)
                panel.orderFrontRegardless()
            }
            switch model.panel {
            case .note, .todo, .ask, .record: panel.makeKey()
            case nil: if panel.isKeyWindow { panel.resignKey() }
            }
        } else if panel.isVisible {
            panel.orderOut(nil)
        }
    }

    /// Resizes the panel to its content, keeping the top-right corner where it
    /// was — the rail stays put while a panel opens beside it.
    private func fit(_ size: CGSize) {
        guard size.width > 0, size.height > 0 else { return }
        let top = anchor ?? defaultAnchor()
        anchor = top
        let frame = NSRect(x: top.x - size.width, y: top.y - size.height, width: size.width, height: size.height)
        if panel.frame != frame { panel.setFrame(frame, display: true) }
    }

    /// The right edge of the main display, the rail centred on it.
    private func defaultAnchor() -> NSPoint {
        let screen = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        return NSPoint(x: screen.maxX - Self.edgeGap + MetistrySpace.s3, y: screen.midY + 150)
    }

    /// The regular apps running now — what *Audio only* may tap. Never
    /// Metistry itself or its recorder: a recording of the bar is not a meeting.
    static func runningApps() -> [CaptureBarApp] {
        let own = Bundle.main.bundleIdentifier ?? ""
        return NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular }
            .compactMap { app -> CaptureBarApp? in
                guard let id = app.bundleIdentifier, id != own, !id.hasPrefix("com.foldedspacelabs.metistry") else { return nil }
                return CaptureBarApp(bundleID: id, name: app.localizedName ?? id)
            }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }
}

/// A borderless panel that can take the keyboard (a borderless window
/// cannot by default) without ever making Metistry the active app.
final class CaptureBarWindow: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

/// Reports the content's size to the panel.
private struct SizeReader: View {
    let onChange: (CGSize) -> Void

    var body: some View {
        GeometryReader { proxy in
            Color.clear
                .onAppear { onChange(proxy.size) }
                .onChange(of: proxy.size) { _, size in onChange(size) }
        }
    }
}

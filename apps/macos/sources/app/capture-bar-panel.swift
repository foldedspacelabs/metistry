// The floating bar's window (screen 11; design-build-plan T8-5). Everything
// drawn in it is MetistryKit's (`CaptureBarView`, capture-bar-view.swift) and
// everything decided is `CaptureBarModel`'s; this file is the part only a
// Mac has — a floating, non-activating panel docked to a screen edge, which
// joins every Space and sits over full-screen apps, and the running apps
// *Audio only* may list.
//
// PLACEMENT (Settings ▸ Live Capture, screen 11 §8, T6-15). The edge and the
// display are `CaptureBarPreferences`' — left or right, centred vertically on
// the chosen display (the main one when none is chosen or it is unplugged) —
// and its switch off is no panel at all, whatever the bridge says. Top and
// bottom are never offered: the menu bar owns the top, the Dock and the
// system's recording pill the bottom. The panel is exactly the size of what it
// shows, anchored at the corner on the screen's edge, so a panel opening
// beside the rail grows toward the screen and the rail never moves — and
// nothing transparent sits over the desktop catching clicks.
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
    private let placement: CaptureBarPreferences
    private let panel: CaptureBarWindow
    private let host: NSHostingView<AnyView>
    /// The bar's top corner on the screen's edge, kept while its content changes size.
    private var anchor: NSPoint?
    /// The placement the anchor was computed for; a change recomputes it.
    private var anchoredFor: CaptureBarPlacement?

    /// The gap between the rail and the screen's edge (the board's 9pt).
    static let edgeGap: CGFloat = 9

    init(model: CaptureBarModel, placement: CaptureBarPreferences) {
        self.model = model
        self.placement = placement
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

    /// Shows or hides the panel as the model and the placement say, and gives
    /// it the keyboard when a field is open — re-armed on every change it reads.
    private func follow() {
        withObservationTracking {
            _ = model.isShown
            _ = model.panel
            _ = placement.placement
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in self?.follow() }
        }
        let where_ = placement.placement
        if model.edge != where_.edge { model.edge = where_.edge }
        if anchoredFor != where_ {
            anchor = nil
            anchoredFor = where_
            if panel.isVisible { fit(host.fittingSize) }
        }
        if model.isShown && where_.enabled {
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

    /// Resizes the panel to its content, keeping the corner on the screen's
    /// edge where it was — the rail stays put while a panel opens beside it.
    private func fit(_ size: CGSize) {
        guard size.width > 0, size.height > 0 else { return }
        let top = anchor ?? defaultAnchor()
        anchor = top
        let x = placement.placement.edge == .left ? top.x : top.x - size.width
        let frame = NSRect(x: x, y: top.y - size.height, width: size.width, height: size.height)
        if panel.frame != frame { panel.setFrame(frame, display: true) }
    }

    /// The chosen edge of the chosen display, the rail centred on it. The
    /// display falls back to the main one when none is chosen or it is gone.
    private func defaultAnchor() -> NSPoint {
        let chosen = placement.placement.displayID.flatMap { id in NSScreen.screens.first { Self.displayID(of: $0) == id } }
        let screen = (chosen ?? NSScreen.main ?? NSScreen.screens.first)?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let y = screen.midY + 150
        switch placement.placement.edge {
        case .left: return NSPoint(x: screen.minX + Self.edgeGap - MetistrySpace.s3, y: y)
        case .right: return NSPoint(x: screen.maxX - Self.edgeGap + MetistrySpace.s3, y: y)
        }
    }

    /// `NSScreenNumber` — the id `CaptureBarDisplay` carries and the preference stores.
    static func displayID(of screen: NSScreen) -> Int? {
        (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.intValue
    }

    /// The displays Settings ▸ Live Capture offers.
    static func displays() -> [CaptureBarDisplay] {
        NSScreen.screens.compactMap { screen in
            displayID(of: screen).map { CaptureBarDisplay(id: $0, name: screen.localizedName, isMain: screen == NSScreen.main) }
        }
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

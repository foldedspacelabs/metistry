// What the menu-bar item drops down (design-system §3.13: "the worst state
// across components becomes the menu-bar glyph, and the menu lists the rows").
//
// The scaffold's version listed 24 rows as flat text and offered "Check Again".
// This one is the thing a person actually opens a menu-bar item for: the summary
// first, then every component GROUPED BY DOCTOR'S OWN `kind` with a status dot
// and a submenu that can restart it, stop it, start it, or show its last 200 log
// lines. Every one of those is a `metistry` verb (menu-model.swift), and a CLI
// that does not have the verb yet is told about, not worked around.

import SwiftUI

public struct MenuBarContent: View {
    private let model: MenuBarModel
    private let updates: UpdateStatus
    private let signIn: ConsoleSignInModel
    private let openWindow: () -> Void
    private let openLog: (String) -> Void
    private let onQuit: () -> Void

    public init(
        model: MenuBarModel,
        updates: UpdateStatus,
        signIn: ConsoleSignInModel,
        openWindow: @escaping () -> Void,
        openLog: @escaping (String) -> Void,
        onQuit: @escaping () -> Void
    ) {
        self.model = model
        self.updates = updates
        self.signIn = signIn
        self.openWindow = openWindow
        self.openLog = openLog
        self.onQuit = onQuit
    }

    /// The component whose row carries the sign-in dot. The console is the only
    /// thing in the install this app authenticates TO, so it is the only row
    /// where "and it takes me as the owner" is a second, separate fact worth a
    /// second, separate dot.
    public static let signInComponent = "console"

    public var body: some View {
        // The summary answers before the menu is read — and it carries the
        // refresh hook, because SwiftUI has no "menu opened" callback and a
        // `MenuBarExtra`'s content is realised when the menu is presented. The
        // modifiers ride on a real menu item rather than on a zero-size spacer
        // view, which a menu would render as a blank row.
        summary
            .onAppear { model.menuOpened() }
            .onDisappear { model.menuClosed() }
        if let outcome = model.lastOutcome {
            Text("\(outcome.ok ? "" : "failed — ")\(outcome.message)")
        }

        Divider()

        // Whole-install actions, above the per-component list.
        Button(MenuBarModel.Lifecycle.restart.allLabel) {
            Task { await model.perform(.restart) }
        }
        .disabled(model.isBusyWholeInstall)
        Button(MenuBarModel.Lifecycle.stop.allLabel) {
            Task { await model.perform(.stop) }
        }
        .disabled(model.isBusyWholeInstall)
        if let available = updates.availableVersion {
            Button("Update Available: \(available)") { updates.checkNow() }
        }

        Divider()

        ForEach(model.groups) { group in
            Menu("\(dotPrefix(group.worstFault)) \(group.title)") {
                ForEach(group.components) { component in
                    componentMenu(component)
                }
            }
        }

        Divider()

        Button("Check Again") { Task { await model.status.refresh() } }
            .disabled(model.status.isChecking)
        Button("Open Metistry", action: openWindow)
        #if os(macOS)
        SettingsLink { Text("Settings…") }
            .keyboardShortcut(",", modifiers: .command)
        #endif
        Button("Quit Metistry", action: onQuit)
            .keyboardShortcut("q", modifiers: .command)
    }

    @ViewBuilder
    private var summary: some View {
        if let report = model.report {
            Text(report.summary)
            Text("shape \(report.shape) · as of \(report.asOf)")
        } else if case .unavailable(let why) = model.status.phase {
            Text("doctor did not answer: \(why)")
        } else {
            Text(model.status.isChecking ? "running metistry doctor…" : "not checked yet")
        }
    }

    @ViewBuilder
    private func componentMenu(_ component: ComponentControl) -> some View {
        let row = component.row
        let isConsole = component.name == Self.signInComponent
        // What this component IS, beyond being up: today only the apple-fm
        // bridge has a second sentence, and only once compute.yaml dials it.
        let note = model.report?.bridgeNote(for: component.name)
        Menu("\(dotPrefix(row.status)) \(row.name)\(note.map { " · \($0)" } ?? "")\(isConsole ? signInSuffix : "")") {
            // The probe or the remediation, as a disabled item: the reason the
            // row is the colour it is, without leaving the menu.
            Text(row.remediation ?? row.probe)
            // And, on the console row only, the second fact: whether it takes
            // this Mac as the owner. A service that is up and a service that
            // knows who you are are different questions, so they are different
            // dots rather than one blended verdict.
            if isConsole {
                Text(signIn.headline)
            }
            if let note {
                Text(note)
            }
            if component.canControl {
                Divider()
                ForEach(MenuBarModel.Lifecycle.allCases, id: \.rawValue) { lifecycle in
                    Button(lifecycle.label) {
                        Task { await model.perform(lifecycle, component: component.name) }
                    }
                    .disabled(model.isBusy(component.name))
                }
                Divider()
                Button("View Log") { openLog(component.name) }
            } else {
                Divider()
                Text("nothing to start or stop — this row is a check, not a process")
            }
        }
    }

    /// The sign-in dot, appended to the console row's label. Empty while the
    /// answer is not known — a menu that has not asked yet must not show a tick
    /// it has not earned (design-system P5).
    private var signInSuffix: String {
        guard let status = signIn.status else { return "" }
        return "  \(dotPrefix(status))"
    }

    /// A text dot, because a `MenuBarExtra` menu renders `Text` and `Button`
    /// labels rather than arbitrary views, and shape carries the meaning as well
    /// as colour (§6). `absent` is a hollow ring — a fact, not a fault.
    private func dotPrefix(_ status: CheckStatus) -> String {
        switch status {
        case .ok: return "●"
        case .degraded: return "▲"
        case .failed: return "✕"
        case .absent: return "○"
        }
    }
}

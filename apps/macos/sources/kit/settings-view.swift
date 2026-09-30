// Settings, in the place macOS users look for it: the app menu, ⌘, and its own
// window (`Settings` scene in the executable target) — never a pane in the main
// one (T6-11, screen-15-settings.md).
//
// THE WINDOW (screen-15 §2–§4). A sidebar, grouped (§1), at a FIXED 840 × 600 —
// a 200 pt sidebar and a 640 pt pane — because the owner ruled it is not
// resizable. So larger text cannot widen it, and every pane is a vertical
// `ScrollView`: at the largest macOS text size a pane grows LONGER, never
// wider (§3, C62; plan §2.18.5), and rows whose controls cannot fit side by
// side stack instead (`SettingsControls`).
//
// Every value on a pane is one of three things, and the pane says which: a
// POINTER the app remembers (the instance directory, the recents, the developer
// override), a READ-THROUGH of a file or a verb the CLI owns, or a labelled
// "not yet". There is no fourth category — no app-private configuration, and no
// second copy of anything in identity.yaml, deployment.yaml or .env. Every
// write is a §2.2 verb, confirmed here with the exact command before it runs
// (settings-model.swift).
//
// docs/ops/mac-app.md carries the same split as a table.

import SwiftUI

/// The window's fixed size (screen-15 §2).
public enum SettingsLayout {
    public static let width: CGFloat = 840
    public static let height: CGFloat = 600
    public static let sidebar: CGFloat = 200
    /// What a pane is given — the widest pane was tightened to fit it.
    public static let pane: CGFloat = 640
}

/// What a pane asks the platform to do: things only the app target can (the
/// Finder, a window, System Settings).
public struct SettingsActions {
    public var openInFinder: (URL) -> Void
    public var setUpAgain: () -> Void
    /// A service's log, in the Log window.
    public var openLog: (String) -> Void
    /// Help ▸ Keyboard Shortcuts (⌘/).
    public var showShortcuts: () -> Void
    public var openSystemSettings: () -> Void

    public init(
        openInFinder: @escaping (URL) -> Void = { _ in },
        setUpAgain: @escaping () -> Void = {},
        openLog: @escaping (String) -> Void = { _ in },
        showShortcuts: @escaping () -> Void = {},
        openSystemSettings: @escaping () -> Void = {}
    ) {
        self.openInFinder = openInFinder
        self.setUpAgain = setUpAgain
        self.openLog = openLog
        self.showShortcuts = showShortcuts
        self.openSystemSettings = openSystemSettings
    }
}

public struct SettingsView: View {
    private let model: AppModel
    private let actions: SettingsActions

    public init(
        model: AppModel,
        onOpenInFinder: @escaping (URL) -> Void,
        onSetUpAgain: @escaping () -> Void,
        onOpenLog: @escaping (String) -> Void = { _ in },
        onShowShortcuts: @escaping () -> Void = {},
        onOpenSystemSettings: @escaping () -> Void = {}
    ) {
        self.model = model
        self.actions = SettingsActions(
            openInFinder: onOpenInFinder,
            setUpAgain: onSetUpAgain,
            openLog: onOpenLog,
            showShortcuts: onShowShortcuts,
            openSystemSettings: onOpenSystemSettings
        )
    }

    private var settings: SettingsModel { model.settings }

    public var body: some View {
        NavigationSplitView(columnVisibility: .constant(.all)) {
            SettingsSidebar(settings: settings)
                .navigationSplitViewColumnWidth(SettingsLayout.sidebar)
                .toolbar(removing: .sidebarToggle)
        } detail: {
            SettingsPaneView(section: settings.section, model: model, actions: actions)
                .navigationTitle(settings.section.title)
        }
        .frame(width: SettingsLayout.width, height: SettingsLayout.height)
        .settingsDialogs(settings)
    }
}

/// The grouped sidebar (screen-15 §1).
struct SettingsSidebar: View {
    let settings: SettingsModel

    var body: some View {
        List(selection: Binding<SettingsModel.Section?>(get: { settings.section }, set: { if let s = $0 { settings.section = s } })) {
            ForEach(SettingsModel.SectionGroup.allCases) { group in
                section(group)
            }
        }
        .listStyle(.sidebar)
    }

    @ViewBuilder
    private func section(_ group: SettingsModel.SectionGroup) -> some View {
        if let title = group.title {
            SwiftUI.Section(title) { rows(group) }
        } else {
            SwiftUI.Section { rows(group) }
        }
    }

    @ViewBuilder
    private func rows(_ group: SettingsModel.SectionGroup) -> some View {
        ForEach(group.sections) { section in
            Label(section.title, systemImage: section.symbolName).tag(section)
        }
    }
}

/// One pane: the verb running or its answer, then the pane's own sections, in
/// a vertical scroll view at the pane's width.
public struct SettingsPaneView: View {
    @Environment(\.colorScheme) private var scheme
    let section: SettingsModel.Section
    let model: AppModel
    let actions: SettingsActions

    public init(section: SettingsModel.Section, model: AppModel, actions: SettingsActions = SettingsActions()) {
        self.section = section
        self.model = model
        self.actions = actions
    }

    public var body: some View {
        let p = Palette(scheme)
        ScrollView(.vertical) {
            SettingsPaneContent(section: section, model: model, actions: actions)
                .padding(MetistrySpace.s5)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(p[.bg])
    }
}

/// A pane's sections, unscrolled — what the window scrolls, and what a test
/// measures at the pane's width.
struct SettingsPaneContent: View {
    let section: SettingsModel.Section
    let model: AppModel
    let actions: SettingsActions

    var body: some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s5) {
            SettingsRunBanner(settings: model.settings)
            switch section {
            case .instance: InstancePane(model: model, actions: actions)
            case .services: ServicesPane(model: model, actions: actions)
            case .compute:
                ComputePaneView(model: model.settings.computePane)
                    // Re-read on open and on every instance switch. There is no
                    // file watcher anywhere in this app, so this IS the refresh.
                    .task(id: model.instances.active) { await model.settings.computePane.refresh() }
            case .updates: UpdatesPane(model: model)
            case .account: AccountPane(model: model, actions: actions)
            case .connections: ConnectionsPane(model: model)
            case .secrets: SecretsPaneView(model: model)
            case .variables: VariablesPaneView(model: model)
            case .liveCapture, .sessions: PendingPane(section: section)
            case .keyboard: KeyboardPane(assistantName: model.settings.identity?.assistantName, actions: actions)
            case .advanced: AdvancedPane(model: model, actions: actions)
            }
        }
    }
}

// MARK: - The dialogs every pane shares

extension View {
    /// The confirmation, the lid dialog, and the two editors — attached once,
    /// to the window, so a pane only sets the model's state.
    func settingsDialogs(_ settings: SettingsModel) -> some View {
        self
            .alert(
                settings.confirmation?.title ?? "",
                isPresented: Binding(get: { settings.confirmation != nil }, set: { if !$0 { settings.cancelConfirmation() } }),
                presenting: settings.confirmation
            ) { pending in
                Button(pending.actionTitle, role: pending.destructive ? .destructive : nil) {
                    Task { await settings.confirm(pending) }
                }
                Button("Cancel", role: .cancel) { settings.cancelConfirmation() }
            } message: { pending in
                Text("\(pending.cost)\n\n\(pending.said)")
            }
            .sheet(isPresented: Binding(get: { settings.lidDialogPresented }, set: { if !$0 { settings.dismissLidDialog() } })) {
                LidClosedDialogView(
                    onCopy: { settings.copyLidCommand() },
                    onCancel: { settings.dismissLidDialog() },
                    onTurnOff: { Task { await settings.storeLidClosedAwake() } }
                )
            }
            .sheet(isPresented: Binding(get: { settings.identityDraft != nil }, set: { if !$0 { settings.identityDraft = nil } })) {
                IdentityEditorView(settings: settings)
            }
            .sheet(isPresented: Binding(get: { settings.linkOrigin != nil }, set: { if !$0 { settings.linkOrigin = nil } })) {
                LinkInstanceView(settings: settings)
            }
    }
}

/// While a verb runs: which one. After: its answer in the CLI's words, and
/// everything it printed under View Log.
struct SettingsRunBanner: View {
    @Environment(\.colorScheme) private var scheme
    let settings: SettingsModel

    var body: some View {
        let p = Palette(scheme)
        if let running = settings.running {
            HStack(spacing: MetistrySpace.s2) {
                ProgressView().controlSize(.small)
                Text("Running \(running)…")
                    .metistryText(.footnote, p, .textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)
        } else if let outcome = settings.outcome {
            VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                    Image(systemName: (outcome.ok ? CheckStatus.ok : CheckStatus.failed).symbolName)
                        .foregroundStyle(p[outcome.ok ? .ok : .failed])
                        .accessibilityHidden(true)
                    Text(outcome.words)
                        .metistryText(.callout, p)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityLabel("\(outcome.ok ? "Done" : "Failed"): \(outcome.words)")
                    Spacer(minLength: 0)
                    Button("Dismiss") { settings.dismissOutcome() }
                }
                Text(outcome.command)
                    .metistryText(.caption1, p, .textTertiary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                if !outcome.lines.isEmpty {
                    DisclosureGroup("View Log") {
                        Text(outcome.lines.joined(separator: "\n"))
                            .metistryText(.mono, p, .textSecondary)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .metistryCard(p)
        }
    }
}

/// A row of controls that stacks when it cannot fit side by side — how a
/// fixed-width pane stays whole at the largest text size.
struct SettingsControls<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: MetistrySpace.s3) { content() }
            VStack(alignment: .leading, spacing: MetistrySpace.s2) { content() }
        }
    }
}

/// Where a launchd job's output lands today, and why the app does not pretend to
/// own that.
///
/// `ops/launchd/*.plist` sets `StandardOutPath` to `/tmp/metistry-<name>.log`.
/// That is a convention, not an interface: a container's log is docker's, and a
/// future systemd unit's is journald's. `metistry logs` is the read path each
/// service's Log button uses for exactly that reason, and "Open in Finder" here
/// is a convenience for the shape this Mac happens to run.
public enum MetistryLogs {
    public static let conventionalDirectory = "/tmp"
    public static let note =
        "Where the launchd jobs write today (StandardOutPath in ops/launchd/*.plist: /tmp/metistry-<name>.log). "
        + "Each service's Log in Services — like the menu bar's View Log — runs `metistry logs <name>` instead, because a container's or a systemd unit's log is not a file here — "
        + "and once `metistry logs --json` reports its own paths, this row can stop assuming one."
}

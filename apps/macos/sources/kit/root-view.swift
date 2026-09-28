// The window (design-build-plan T5-2; DEVELOPER-HANDOFF §2.1): the sidebar's
// eight rows — Today · Chat · Activity · Work ▸ · Knowledge · Agents ·
// Scheduled — with Needs You above them only while something waits, Pinned
// below; the toolbar's + and Usage gauge; and the title, **Metistry**, on every
// screen (brand-kit 2026-09-19: the window's identity, not a breadcrumb — the
// highlighted row already says where you are).
//
// WHAT IS NOT HERE. No bell: C110 moved it into the sidebar as the Needs You
// row, and that row carries the product's only badge — no count on any other
// row (C15). No Status row: the doctor panel is its own window (Window ▸ Status)
// until Settings ▸ Services takes it (T6-11). No Rooms (C89).
//
// THE SCREENS ARE NOT HERE YET. Each destination's view is its own ticket
// (T6-*). Until one lands, its detail says so in a sentence and offers the web
// app — a labelled "not yet", never an empty pane pretending to be a screen
// (mac-app.md, "Not yet, and labelled as such on screen"). Needs You
// (needs-you-view.swift, T5-4a), Activity (activity-view.swift, T6-3),
// Chat (chat-view.swift, T6-2), Today's top — the brief, Next Up,
// calendar help, Close the Day (today-view.swift, T6-1b) — and Knowledge
// (knowledge-view.swift, T6-4) have landed.
//
// ACCESSIBILITY (§2.18). Every control speaks its name, and a glyph-only one its
// shortcut too; the Needs You row says *Needs You, 10 waiting*; the gauge says
// *Usage, $1.84 today, 37% of the daily spending limit*; the sidebar and the detail are
// the two landmarks; under Reduce Motion the Needs You row appears without
// sliding. Text is semantic styles only, so the system's text size reaches
// every label, and nothing here fixes a height a label has to fit in.

import SwiftUI

public enum ShellTitle {
    /// The window's title on every screen.
    public static let window = "Metistry"
}

public struct RootView: View {
    @Environment(\.colorScheme) private var scheme
    private let model: AppModel
    @State private var isUsagePresented = false
    #if os(macOS)
    @Environment(\.openSettings) private var openSettings
    #endif

    public init(model: AppModel) {
        self.model = model
    }

    public var body: some View {
        let p = Palette(scheme)
        let shell = model.shell
        NavigationSplitView {
            ShellSidebar(shell: shell, chatIsWorking: model.chat.isWorking)
                .navigationSplitViewColumnWidth(min: 180, ideal: MetistrySize.sidebar, max: 320)
        } detail: {
            ShellDetail(shell: shell, needsYou: model.needsYou, activity: model.activity, chat: model.chat, today: model.today, instanceDir: model.instances.active, consoleURL: PasskeyRouting.consoleURL(in: model.status.report).flatMap(URL.init(string:)), knowledge: model.knowledge, onChooseFolder: chooseFolder, scheduled: model.scheduled, agents: model.agents, onOpenConnections: showConnections)
                // The detail landmark, named for where the owner is.
                .accessibilityElement(children: .contain)
                .accessibilityLabel(shell.selection.title)
                .navigationTitle(ShellTitle.window)
        }
        .toolbar { toolbar(shell, p) }
        .background(p[.bg])
        .tint(p[.accent])
        .task {
            // What the Status destination used to start on launch: doctor, then
            // whoami — the wizard, Settings and the menu bar read both.
            if model.status.phase == .idle { await model.status.refresh() }
            model.consoleSignIn.shape = model.status.report?.shape
            await model.consoleSignIn.refreshIfNeeded()
        }
    }

    @ToolbarContentBuilder
    private func toolbar(_ shell: ShellModel, _ p: Palette) -> some ToolbarContent {
        ToolbarItem(placement: .navigation) {
            MetistryMark()
                .stroke(p[.accent], style: StrokeStyle(lineWidth: MetistryMark.strokeWidth(at: 17), lineJoin: .miter))
                .frame(width: 17, height: 17)
                .accessibilityHidden(true)
        }
        ToolbarItemGroup(placement: .primaryAction) {
            let canCapture = shell.canPerform(.newCapture)
            // Glyph-only, so the name is the accessibility label and not the
            // symbol's own ("plus" says "Add"). It opens the composer
            // (capture-view.swift) anchored under itself; Esc closes it and
            // keeps the draft.
            Button {
                shell.perform(.newCapture)
            } label: {
                Image(systemName: "plus")
            }
            .accessibilityLabel(ShellCommand.newCapture.spokenLabel(assistantName: shell.assistantName))
            .help(canCapture ? "New Capture (⌘N)" : "New Capture (⌘N) isn't in this build yet")
            .disabled(!canCapture)
            .popover(isPresented: Bindable(model.composer).isPresented, arrowEdge: .bottom) {
                CaptureComposerView(model: model.composer)
            }

            Button {
                isUsagePresented.toggle()
            } label: {
                Image(systemName: shell.gauge.symbolName)
                    .foregroundStyle(p[shell.gauge.inkRole])
            }
            .accessibilityLabel(shell.gauge.spokenLabel)
            .help(shell.gauge.spokenLabel)
            .popover(isPresented: $isUsagePresented, arrowEdge: .bottom) {
                UsagePopover(shell: shell, showLimits: showSpendingLimits)
            }
        }
    }

    /// **Raise** and the popover's last line both lead here (C138): Settings,
    /// on Compute, where the spending limits are set.
    private func showSpendingLimits() {
        isUsagePresented = false
        Self.showSpendingLimits(in: model.settings)
        #if os(macOS)
        openSettings()
        #endif
    }

    /// Agents ▸ New Agent ▸ Connect an Agent: Settings, on Connections (M13).
    private func showConnections() {
        model.settings.section = .connections
        #if os(macOS)
        openSettings()
        #endif
    }

    /// Knowledge's *vault not found* leads here: Settings, on the instance.
    private func chooseFolder() {
        model.settings.section = .instance
        #if os(macOS)
        openSettings()
        #endif
    }

    /// The pane Settings opens on for the limits.
    static func showSpendingLimits(in settings: SettingsModel) {
        settings.section = .compute
    }
}

// MARK: - The sidebar

struct ShellSidebar: View {
    let shell: ShellModel
    /// A turn is working: one `agent` dot on Chat — presence, not a badge; it
    /// carries no count (screen-01 §5.1, P2).
    var chatIsWorking = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        List(selection: Binding(
            get: { Optional(shell.selection) },
            // A click on empty space deselects; the window always has a place.
            set: { if let destination = $0 { shell.navigate(to: destination) } }
        )) {
            if shell.showsNeedsYouRow {
                NeedsYouRow(badge: shell.badgeLabel, spoken: shell.needsYouSpokenLabel, isSelected: shell.selection == .needsYou)
                    .tag(Destination.needsYou)
            }
            ForEach(ShellSection.allCases) { section in
                if section.children.isEmpty {
                    DestinationRow(destination: section.landing, working: section == .chat && chatIsWorking ? shell.assistantName.map { "\($0) is working" } ?? "working" : nil)
                        .tag(section.landing)
                } else {
                    // Work has no screen of its own, so its label is not a
                    // selection: the disclosure opens it, ⌘4 lands on Board.
                    DisclosureGroup(isExpanded: Binding(get: { shell.isWorkExpanded }, set: { shell.isWorkExpanded = $0 })) {
                        ForEach(section.children) { child in
                            DestinationRow(destination: child)
                                .tag(child)
                        }
                    } label: {
                        Label(section.title, systemImage: section.symbolName)
                    }
                }
            }
            if !shell.pins.items.isEmpty {
                SwiftUI.Section("Pinned") {
                    ForEach(shell.pins.items) { pin in
                        DestinationRow(destination: .pinned(pin))
                            .contextMenu {
                                Button("Unpin") { shell.unpin(pin) }
                            }
                            .tag(Destination.pinned(pin))
                    }
                    .onMove { shell.pins.move(fromOffsets: $0, toOffset: $1) }
                }
            }
        }
        .listStyle(.sidebar)
        // C122: without Reduce Motion the row slides in; with it, it is there.
        .animation(ShellMotion.needsYouRow(reduceMotion: reduceMotion), value: shell.showsNeedsYouRow)
    }
}

struct DestinationRow: View {
    @Environment(\.colorScheme) private var scheme
    let destination: Destination
    /// Set while something on the screen works: the dot, and what it means in words.
    var working: String? = nil

    var body: some View {
        if let working {
            HStack(spacing: MetistrySpace.s2) {
                Label(destination.title, systemImage: destination.symbolName)
                Spacer(minLength: MetistrySpace.s1)
                Circle().fill(Palette(scheme)[.agent]).frame(width: 6, height: 6)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(verbatim: "\(destination.title), \(working)"))
        } else {
            Label(destination.title, systemImage: destination.symbolName)
        }
    }
}

/// The conditional row: the bell glyph, the words, and the one badge.
struct NeedsYouRow: View {
    @Environment(\.colorScheme) private var scheme
    let badge: String?
    let spoken: String
    let isSelected: Bool

    var body: some View {
        let p = Palette(scheme)
        HStack(spacing: MetistrySpace.s2) {
            Label {
                Text(Destination.needsYou.title).fontWeight(.semibold)
            } icon: {
                Image(systemName: Destination.needsYou.symbolName).foregroundStyle(p[.accent])
            }
            Spacer(minLength: MetistrySpace.s1)
            if let badge {
                // `accent` on `on-accent`: a decision, not a failure, so never a state colour (screen-03 §1).
                Text(badge)
                    .font(MetistryTextStyle.caption1.font.weight(.bold))
                    .monospacedDigit()
                    .foregroundStyle(p[.onAccent])
                    .padding(.horizontal, 7)
                    .padding(.vertical, 1)
                    .background(p[.accent], in: Capsule())
            }
        }
        // One element, spoken as components-02 §3 has it.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spoken)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }
}

// MARK: - The detail

struct ShellDetail: View {
    @Environment(\.openURL) private var openURL
    let shell: ShellModel
    let needsYou: NeedsYouModel
    let activity: ActivityModel
    let chat: ChatModel
    let today: TodayModel
    let instanceDir: URL?
    let consoleURL: URL?
    var knowledge: KnowledgeModel? = nil
    var onChooseFolder: (() -> Void)? = nil
    let scheduled: ScheduledModel
    var agents: AgentsModel? = nil
    var onOpenConnections: (() -> Void)? = nil

    var body: some View {
        let destination = shell.selection
        if destination == .today {
            // A vault path — the meeting's note — opens where the owner reads
            // the vault. Record waits for the capture bar (#253), so it is
            // dimmed with its reason. The close's request is in Needs You.
            TodayView(
                model: today,
                assistantName: shell.assistantName,
                onOpenPath: instanceDir.map { dir in { path in if let url = ObsidianLink.url(for: path, in: dir) { openURL(url) } } },
                onGoToNeedsYou: { Task { await shell.refreshCount(); shell.goToNeedsYou() } }
            )
        } else if destination == .activity {
            // A row's destination is a screen the Mac does not draw yet — the
            // capture, the request, the task, the message — so it opens in the
            // web app, which has them. A run's detail is drawn nowhere (§6.2).
            ActivityView(model: activity, assistantName: shell.assistantName, onOpen: consoleURL.map { url in { _ in openURL(url) } })
        } else if destination == .needsYou {
            // C110: answering the last request leaves the owner here, on
            // *Nothing needs you*, with the row still in the sidebar until they
            // go elsewhere. One request is its card (T5-4b): the detail draws
            // it and the Item menu answers through it — the same card, so the
            // menu and the button never disagree.
            NeedsYouView(
                model: needsYou,
                waiting: shell.waiting,
                assistantName: shell.assistantName,
                onGoToToday: { shell.go(to: .today) },
                rowActions: { row in
                    guard let name = shell.assistantName, let cards = needsYou.cards(assistantName: name) else { return [:] }
                    return cards.card(for: row).itemActions(allowsDecisions: needsYou.allowsDecisions)
                }
            ) { row in
                if let name = shell.assistantName, let cards = needsYou.cards(assistantName: name) {
                    let card = cards.card(for: row)
                    ScrollView {
                        RequestCardView(card, allowsDecisions: needsYou.allowsDecisions, today: needsYou.today)
                            .frame(maxWidth: MetistrySize.contentMax, alignment: .leading)
                            .padding(MetistrySpace.s5)
                    }
                    .id(row.id)
                    // An answer changed the queue: the shell's count asks again.
                    .task(id: card.isSettled) { if card.isSettled { await needsYou.onQueueChanged?() } }
                } else {
                    // The name is not known yet; the card would print none.
                    NeedsYouRequestSummary(row, assistantName: shell.assistantName, consoleURL: consoleURL, calendar: needsYou.calendar)
                }
            }
        } else if destination == .chat {
            ChatView(model: chat, assistantName: shell.assistantName)
        } else if destination == .knowledge, let knowledge {
            // A page opens where the owner reads the vault; the vault missing
            // leads to the instance's folder in Settings.
            KnowledgeView(
                model: knowledge,
                assistantName: shell.assistantName,
                onOpenInObsidian: instanceDir.map { dir in { path in if let url = ObsidianLink.url(for: path, in: dir) { openURL(url) } } },
                onChooseFolder: onChooseFolder
            )
        } else if destination == .scheduled {
            // A vault path opens where the vault is read; the definition a
            // task is added to is edited on Agents; a stopped sync's one
            // request is in Needs You.
            ScheduledView(
                model: scheduled,
                assistantName: shell.assistantName,
                onOpenPath: instanceDir.map { dir in { path in if let url = ObsidianLink.url(for: path, in: dir) { openURL(url) } } },
                onGoToAgents: { shell.go(to: .agents) },
                onGoToNeedsYou: { Task { await shell.refreshCount(); shell.goToNeedsYou() } }
            )
        } else if destination == .agents, let agents {
            // Give It One and a routine's row lead to Scheduled; Connect an
            // Agent to Settings › Connections (C138).
            AgentsView(model: agents, assistantName: shell.assistantName, onGoToScheduled: { shell.go(to: .scheduled) }, onOpenConnections: onOpenConnections)
        } else {
            ContentUnavailableView {
                Label(destination.title, systemImage: destination.symbolName)
            } description: {
                Text(ShellDetail.notYet(destination, waiting: shell.waiting))
            } actions: {
                if let consoleURL {
                    Link("Open in Browser", destination: consoleURL)
                }
            }
        }
    }

    static func notYet(_ destination: Destination, waiting: Int?) -> String {
        let screen = "\(destination.title) isn't in the Mac app yet — the web app has it."
        if destination == .needsYou, let waiting, waiting > 0 {
            return "\(waiting) waiting. \(screen)"
        }
        return screen
    }
}

/// `obsidian://open?path=` for a vault path under this Mac's instance — the
/// app that renders the vault is where a note is read (CLAUDE.md, casing).
public enum ObsidianLink {
    public static func url(for vaultPath: String, in instanceDir: URL) -> URL? {
        let file = instanceDir.appendingPathComponent(vaultPath).standardizedFileURL
        // Never a path that leaves the instance.
        guard file.path.hasPrefix(instanceDir.standardizedFileURL.path + "/") else { return nil }
        var parts = URLComponents()
        parts.scheme = "obsidian"
        parts.host = "open"
        parts.queryItems = [URLQueryItem(name: "path", value: file.path)]
        return parts.url
    }
}

// MARK: - The mark

/// brand-kit.md "The mark": a square from 12 to 52 in a 64 grid, the
/// bottom-left corner cut by 26, stroked on the centre line. Never filled.
public struct MetistryMark: Shape {
    public init() {}

    public func path(in rect: CGRect) -> Path {
        let side = min(rect.width, rect.height)
        let unit = side / 64
        let origin = CGPoint(x: rect.midX - side / 2, y: rect.midY - side / 2)
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: origin.x + x * unit, y: origin.y + y * unit) }
        var path = Path()
        path.move(to: point(12, 12))
        path.addLine(to: point(52, 12))
        path.addLine(to: point(52, 52))
        path.addLine(to: point(38, 52))
        path.addLine(to: point(12, 26))
        path.closeSubpath()
        return path
    }

    /// The stroke thickens as the mark shrinks (brand-kit "The optical ramp"):
    /// 11 grid units at 16 px, 8 at 128 and up.
    public static func strokeWidth(at points: CGFloat) -> CGFloat {
        let units: CGFloat = points <= 16 ? 11 : points <= 32 ? 10 : points <= 64 ? 9 : 8
        return units * points / 64
    }
}

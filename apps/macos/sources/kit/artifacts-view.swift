// Work ▸ Artifacts (design-build-plan T6-9; screen-16-artifacts-and-rooms.md
// §1). The model is artifacts-model.swift.
//
// THE LIST: one row per artifact — its slug, then project · kind · when it was
// updated, and its open threads across every version. ↩ opens one. Empty:
// *No Artifacts Yet* (components-03 §2). The list carries no title and no
// latest version's author: `GET /api/artifacts` serves neither (docs/ops/
// mac-app.md, "Work ▸ Artifacts").
//
// AN ARTIFACT: the version rail on the left (version, author, message, when,
// and that version's open threads); the version at reading width; its threads
// in the right margin, LEVEL WITH THEIR HIGHLIGHTED LINES. When two would
// collide the lower one moves down, 8 pt below the card above, and keeps a
// leader to its line (`ThreadMarginLayout`); replies fold to a count.
// Switching version shows that version's threads. A thread with no line
// here — another file, no anchor, a version that could not be drawn — is
// listed under the text, never placed on a line it is not about.
//
// COMPARE: the diff between two versions, and — when the FROM version has
// open threads on lines the diff changed — the sentence *1 thread on v2 is
// about a line v3 changed. It stays on v2.* with **Open on v2 →**.
//
// THE STATES (components-03 §2): *No artifacts yet*; waiting past a second,
// *Opening vendor-summary · v3 · 2.1 MB*; a version the console cannot serve
// (an older file replaced on disk) is the failed panel with **Show v2**.
//
// ACCESSIBILITY (§2.18). A row is one element — *store-interface, metistry,
// markdown, 1 open thread, updated 1 hour ago*; a version row says its
// number, author, message and threads; a highlighted line says it has a
// thread; each margin card says its line, author, time and words, and its
// replies control says how many. Every section is a heading. Nothing moves,
// so Reduce Motion has nothing to stop. No key is bound here: Open (↩) and
// Open in Obsidian (⌘O) are the Item menu's (C119). Text is semantic styles
// only: the largest size makes a row longer, never wider.

import SwiftUI

// MARK: - The screen

public struct ArtifactsView: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: ArtifactsModel
    let assistantName: String?
    let tickInterval: Duration
    /// Opens a vault path where the owner reads the vault. Nil: ⌘O is dimmed.
    let onOpenInObsidian: ((String) -> Void)?

    public init(model: ArtifactsModel, assistantName: String?, tick: Duration = .seconds(15), onOpenInObsidian: ((String) -> Void)? = nil) {
        self.model = model
        self.assistantName = assistantName
        self.tickInterval = tick
        self.onOpenInObsidian = onOpenInObsidian
    }

    public var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: 0) {
            ArtifactsHeader(model: model)
                .padding(.horizontal, MetistrySpace.s5)
                .padding(.vertical, MetistrySpace.s3)
                .background(p[.surface])
            Divider()
            content
        }
        // Flexible down to nothing, as every screen is: the window's minimum
        // is the shell's to set (#392).
        .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .topLeading)
        .background(p[.surface])
        .shellItemActions(itemActions)
        .task {
            await model.refreshIfDue()
            while !Task.isCancelled {
                try? await Task.sleep(for: tickInterval)
                if Task.isCancelled { break }
                await model.refreshIfDue()
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if let id = model.opened, let artifact = model.artifact(id) {
            ArtifactPage(model: model, artifact: artifact, assistantName: assistantName, onOpenInObsidian: onOpenInObsidian)
        } else {
            switch model.paint {
            case .placeholders(let waiting):
                VStack(alignment: .leading) {
                    PlaceholderRows(count: 4, waitingFor: waiting)
                    Spacer(minLength: 0)
                }
                .padding(MetistrySpace.s4)
            case .failed(let why):
                VStack {
                    StatePanel(
                        StatePanelModel(.failed, title: "Couldn't Read Artifacts", sentence: "The console didn't answer with the artifacts.", reason: why, action: StateWords.tryAgain),
                        now: model.now(), clock: model.clock
                    ) { Task { await model.load() } }
                    Spacer(minLength: 0)
                }
            case .content:
                if model.list.isEmpty {
                    VStack {
                        StatePanel(StatePanelModel(.empty, title: ArtifactsWords.emptyTitle, sentence: ArtifactsWords.emptySentence), now: model.now(), clock: model.clock)
                        Spacer(minLength: 0)
                    }
                } else {
                    ArtifactsList(model: model)
                }
            }
        }
    }

    /// The Item menu: Open (↩) for the selected row; Open in Obsidian (⌘O)
    /// for the file on screen.
    private var itemActions: ShellActionTable {
        var table: ShellActionTable = [:]
        if model.opened == nil, let id = model.selection, model.artifact(id) != nil {
            table[.open] = { Task { await model.open(id) } }
        }
        if model.opened != nil, let path = model.obsidianPath, let onOpenInObsidian {
            table[.openInObsidian] = { onOpenInObsidian(path) }
        }
        return table
    }
}

/// The title, or the way back to the list.
struct ArtifactsHeader: View {
    @Environment(\.colorScheme) private var scheme
    let model: ArtifactsModel

    var body: some View {
        let p = Palette(scheme)
        HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s3) {
            if model.opened != nil {
                ControlButton(ControlSpec(ArtifactsWords.back, glyph: .disclosure, role: .plain, name: "Back to Artifacts")) { model.back() }
            } else {
                Text(verbatim: ArtifactsWords.title)
                    .metistryFont(.title2)
                    .foregroundStyle(p[.textPrimary])
                    .accessibilityAddTraits(.isHeader)
            }
            Spacer(minLength: 0)
        }
    }
}

// MARK: - The list

struct ArtifactsList: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: ArtifactsModel

    var body: some View {
        let p = Palette(scheme)
        List(selection: $model.selection) {
            ForEach(model.list) { artifact in
                ArtifactRowView(row: ArtifactRowWords(artifact, openThreads: model.openThreadCount(artifact.id), now: model.now()))
                    .tag(artifact.id)
            }
        }
        .listStyle(.inset)
        .scrollContentBackground(.hidden)
        .background(p[.surface])
        .contextMenu(forSelectionType: String.self) { ids in
            if let id = ids.first {
                Button("Open") { Task { await model.open(id) } }
            }
        } primaryAction: { ids in
            if let id = ids.first { Task { await model.open(id) } }
        }
        .shellListFocus()
        .accessibilityLabel(Text(verbatim: ArtifactsWords.title))
    }
}

/// One row's words, decided — what the row draws and what VoiceOver says.
public struct ArtifactRowWords: Sendable, Equatable {
    public let name: String
    /// *metistry · markdown · updated 1 hour ago*.
    public let facts: String
    /// *1 open thread*; nil until the rooms have answered.
    public let threads: String?

    public init(_ a: ArtifactRecord, openThreads: ArtifactsWords.Count?, now: Date) {
        name = a.slug
        facts = ([a.project, a.kind] + (ArtifactsWords.updated(a.updatedAt, now: now).map { [$0] } ?? [])).joined(separator: " · ")
        threads = openThreads.map(ArtifactsWords.openThreads)
    }

    public var spoken: String {
        let parts = facts.components(separatedBy: " · ")
        return ([name] + parts.prefix(2) + (threads.map { [$0] } ?? []) + parts.dropFirst(2)).joined(separator: ", ")
    }
}

struct ArtifactRowView: View {
    @Environment(\.colorScheme) private var scheme
    let row: ArtifactRowWords

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            Text(verbatim: row.name)
                .metistryFont(.headline)
                .foregroundStyle(p[.textPrimary])
                .fixedSize(horizontal: false, vertical: true)
            Text(verbatim: row.facts)
                .metistryFont(.subhead)
                .foregroundStyle(p[.textSecondary])
                .fixedSize(horizontal: false, vertical: true)
            if let threads = row.threads {
                Text(verbatim: threads)
                    .metistryFont(.subhead)
                    .monospacedDigit()
                    .foregroundStyle(p[.textSecondary])
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, MetistrySpace.s1)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: row.spoken))
    }
}

// MARK: - An artifact

struct ArtifactPage: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: ArtifactsModel
    let artifact: ArtifactRecord
    let assistantName: String?
    let onOpenInObsidian: ((String) -> Void)?

    nonisolated static let railWidth: CGFloat = 220

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: 0) {
            header(p)
                .padding(.horizontal, MetistrySpace.s5)
                .padding(.vertical, MetistrySpace.s3)
            Divider()
            switch model.versions {
            case .failed(let why, _)?:
                VStack {
                    StatePanel(
                        StatePanelModel(.failed, title: "Couldn't Read Versions", sentence: "The console didn't answer with \(artifact.slug)'s versions.", reason: why, action: StateWords.tryAgain),
                        now: model.now(), clock: model.clock
                    ) { Task { await model.open(artifact.id) } }
                    Spacer(minLength: 0)
                }
            case .loaded?:
                HStack(alignment: .top, spacing: 0) {
                    VersionRail(model: model, assistantName: assistantName)
                        .frame(width: Self.railWidth)
                    Divider()
                    if model.comparison != nil {
                        CompareView(model: model)
                    } else {
                        ReadingView(model: model, slug: artifact.slug, assistantName: assistantName, onOpenInObsidian: onOpenInObsidian)
                    }
                }
            default:
                VStack(alignment: .leading) {
                    PlaceholderRows(count: 4, waitingFor: nil)
                    Spacer(minLength: 0)
                }
                .padding(MetistrySpace.s4)
            }
        }
    }

    @ViewBuilder
    private func header(_ p: Palette) -> some View {
        FlowLayout(spacing: MetistrySpace.s3) {
            VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                Text(verbatim: artifact.slug)
                    .metistryFont(.title2)
                    .foregroundStyle(p[.textPrimary])
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                Text(verbatim: "\(artifact.project) · \(artifact.kind)")
                    .metistryFont(.footnote)
                    .foregroundStyle(p[.textSecondary])
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let v = model.shown, v.files.count > 1 {
                Picker(selection: Binding(get: { model.shownPath ?? "" }, set: { path in Task { await model.show(file: path) } })) {
                    ForEach(v.files) { f in Text(verbatim: f.path).tag(f.path) }
                } label: {
                    Text(verbatim: "File")
                }
                .fixedSize()
            }
            let comparing = model.comparison != nil
            ControlButton(ControlSpec(ArtifactsWords.compare, role: .secondary, selected: comparing, disabledBecause: model.canCompare ? nil : "Compare needs two versions")) {
                if comparing { model.endCompare() } else { Task { await model.beginCompare() } }
            }
        }
    }
}

// MARK: - The version rail

struct VersionRail: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: ArtifactsModel
    let assistantName: String?

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: 0) {
            Text(verbatim: ArtifactsWords.versions)
                .metistryFont(.caption1, weight: .semibold)
                .foregroundStyle(p[.textSecondary])
                .accessibilityLabel(Text(verbatim: ArtifactsWords.versions))
                .accessibilityAddTraits(.isHeader)
                .padding(.horizontal, MetistrySpace.s4)
                .padding(.top, MetistrySpace.s3)
            List(selection: Binding(get: { model.comparison == nil ? model.shownVersion : nil }, set: { id in if let id { Task { await model.show(version: id) } } })) {
                ForEach(model.versionList) { v in
                    VersionRowView(row: VersionRowWords(v, latest: v.id == model.artifact(model.opened ?? "")?.currentVersion, openThreads: model.openThreadCount(version: v.id), assistantName: assistantName, now: model.now()))
                        .tag(v.id)
                }
            }
            .listStyle(.sidebar)
            .scrollContentBackground(.hidden)
            .shellListFocus()
            .accessibilityLabel(Text(verbatim: ArtifactsWords.versions))
        }
        .background(p[.surface])
    }
}

/// A version in the rail: number, author, message, when (§1).
public struct VersionRowWords: Sendable, Equatable {
    /// *v2 · latest*.
    public let title: String
    public let message: String
    /// *You · 1 hour ago*.
    public let byline: String
    public let threads: String?

    public init(_ v: ArtifactVersionRecord, latest: Bool, openThreads: ArtifactsWords.Count?, assistantName: String?, now: Date) {
        title = latest ? "\(v.label) · \(ArtifactsWords.latest)" : v.label
        message = v.message
        byline = ([ArtifactsWords.author(v.author, assistantName: assistantName)] + (v.createdAt.map { [ClockTime.age(now.timeIntervalSince($0))] } ?? [])).joined(separator: " · ")
        threads = openThreads.flatMap { $0.n == 0 && !$0.atLeast ? nil : ArtifactsWords.openThreads($0) }
    }

    public var spoken: String {
        ([title.replacingOccurrences(of: " · ", with: ", "), byline.replacingOccurrences(of: " · ", with: ", "), message] + (threads.map { [$0] } ?? [])).joined(separator: ", ")
    }
}

struct VersionRowView: View {
    @Environment(\.colorScheme) private var scheme
    let row: VersionRowWords

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: row.title)
                .metistryFont(.subhead, weight: .semibold)
                .foregroundStyle(p[.textPrimary])
            Text(verbatim: row.byline)
                .metistryFont(.caption1)
                .foregroundStyle(p[.textSecondary])
                .fixedSize(horizontal: false, vertical: true)
            if !row.message.isEmpty {
                Text(verbatim: row.message)
                    .metistryFont(.caption1)
                    .foregroundStyle(p[.textSecondary])
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let threads = row.threads {
                Text(verbatim: threads)
                    .metistryFont(.caption1)
                    .monospacedDigit()
                    .foregroundStyle(p[.textPrimary])
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: row.spoken))
    }
}

// MARK: - The version at reading width, its threads in the margin

struct ReadingView: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: ArtifactsModel
    let slug: String
    let assistantName: String?
    let onOpenInObsidian: ((String) -> Void)?

    nonisolated static let marginWidth: CGFloat = 280

    var body: some View {
        let p = Palette(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: MetistrySpace.s5) {
                if let v = model.shown {
                    content(v, p)
                    let others = model.otherThreads
                    if !others.isEmpty {
                        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                            Text(verbatim: model.text?.value == nil ? ArtifactsWords.threads : ArtifactsWords.notOnALine)
                                .metistryFont(.headline)
                                .foregroundStyle(p[.textPrimary])
                                .accessibilityAddTraits(.isHeader)
                            ForEach(others) { t in
                                ThreadCard(thread: t, unfolded: model.unfolded.contains(t.id), assistantName: assistantName, now: model.now(), clock: model.clock) { model.toggleReplies(t.id) }
                                    .frame(maxWidth: Self.marginWidth + MetistrySize.contentMax / 2, alignment: .leading)
                            }
                        }
                    }
                }
            }
            .padding(MetistrySpace.s5)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder
    private func content(_ v: ArtifactVersionRecord, _ p: Palette) -> some View {
        if let file = model.shownFile, !file.isText {
            VStack(alignment: .leading, spacing: MetistrySpace.s3) {
                Text(verbatim: ArtifactsWords.notDrawn(file))
                    .metistryFont(.body)
                    .foregroundStyle(p[.textPrimary])
                    .fixedSize(horizontal: false, vertical: true)
                if let path = model.obsidianPath, let onOpenInObsidian {
                    ControlButton(ControlSpec(ArtifactsWords.openInObsidian, role: .secondary, shortcut: "⌘O")) { onOpenInObsidian(path) }
                }
            }
        } else {
            switch model.text {
            case .loaded(let text)?:
                VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                    if text.kind == "html" {
                        Text(verbatim: ArtifactsWords.htmlAsSource)
                            .metistryFont(.footnote)
                            .foregroundStyle(p[.textSecondary])
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    ArtifactTextWithMargin(model: model, text: text, assistantName: assistantName)
                        .id("\(v.id)|\(text.path)")
                }
            case .failed(let why, let code)?:
                let fallback = model.fallbackVersion
                StatePanel(
                    StatePanelModel(
                        .failed,
                        title: ArtifactsWords.unreadableTitle(v),
                        sentence: code == "not_available" ? ArtifactsWords.replaced(model.shownPath ?? v.label, v) : "The console didn't answer with \(model.shownPath ?? v.label) at \(v.label).",
                        reason: why,
                        action: fallback.map(ArtifactsWords.show)
                    ),
                    now: model.now(), clock: model.clock
                ) {
                    if let fallback { Task { await model.show(version: fallback.id) } }
                }
            case .waiting(let since)?:
                // A wait past a second says what it waits for (C135).
                TimelineView(.periodic(from: since, by: 1)) { _ in
                    let late = model.now().timeIntervalSince(since) > FirstPaint.patience
                    PlaceholderRows(count: 6, waitingFor: late ? ArtifactsWords.opening(slug, v, bytes: model.shownFile?.bytes ?? v.bytes) : nil)
                }
            case nil:
                Text(verbatim: "This version has no files.")
                    .metistryFont(.body)
                    .foregroundStyle(p[.textSecondary])
            }
        }
    }
}

/// The text, line by line, with each thread level with its line.
struct ArtifactTextWithMargin: View {
    @Environment(\.colorScheme) private var scheme
    let model: ArtifactsModel
    let text: ArtifactText
    let assistantName: String?
    /// Where each thread's line sits, from the lines' own frames.
    @State private var tops: [Int: CGFloat] = [:]

    nonisolated static let space = "artifact-page"

    var body: some View {
        let p = Palette(scheme)
        let marked = model.threadLines
        let threads = model.marginThreads
        let counts = Dictionary(grouping: threads.compactMap(\.line), by: { $0 }).mapValues(\.count)
        HStack(alignment: .top, spacing: MetistrySpace.s4) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(text.lines.enumerated()), id: \.offset) { i, line in
                    let n = i + 1
                    lineView(line, number: n, marked: marked.contains(n), threads: counts[n] ?? 0, p)
                }
            }
            .textSelection(.enabled)
            .frame(maxWidth: MetistrySize.contentMax, alignment: .leading)
            .layoutPriority(1)
            if !threads.isEmpty {
                ThreadMarginLayout(wants: threads.map { tops[$0.line ?? 0] ?? 0 }) {
                    ForEach(threads) { t in
                        ThreadCard(thread: t, unfolded: model.unfolded.contains(t.id), assistantName: assistantName, now: model.now(), clock: model.clock) { model.toggleReplies(t.id) }
                    }
                    ForEach(threads) { _ in
                        MarginLeader()
                            .stroke(p[.borderStrong], lineWidth: 1)
                            .accessibilityHidden(true)
                    }
                }
                .frame(width: ReadingView.marginWidth)
                .accessibilityElement(children: .contain)
                .accessibilityLabel(Text(verbatim: ArtifactsWords.threads))
            }
        }
        .coordinateSpace(name: Self.space)
    }

    @ViewBuilder
    private func lineView(_ line: String, number: Int, marked: Bool, threads: Int, _ p: Palette) -> some View {
        let row = Text(verbatim: line.isEmpty ? " " : line)
            .metistryFont(Self.style(line, kind: text.kind), design: text.kind == "markdown" ? .sans : .mono, weight: Self.weight(line, kind: text.kind))
            .foregroundStyle(p[.textPrimary])
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, MetistrySpace.s1)
            .padding(.vertical, 1)
        if marked {
            row
                .background(p[.accentQuiet], in: RoundedRectangle(cornerRadius: MetistryRadius.xs, style: .continuous))
                .onGeometryChange(for: CGFloat.self) { proxy in
                    proxy.frame(in: .named(Self.space)).minY
                } action: { y in
                    tops[number] = y
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Text(verbatim: ArtifactsWords.markedLine(line, number: number, threads: threads)))
        } else {
            row
        }
    }

    /// Markdown headings read as headings; everything else is the body, or mono for data.
    static func style(_ line: String, kind: String) -> MetistryTextStyle {
        guard kind == "markdown" else { return .footnote }
        if line.hasPrefix("# ") { return .title2 }
        if line.hasPrefix("## ") { return .title3 }
        if line.hasPrefix("### ") { return .headline }
        return .body
    }

    static func weight(_ line: String, kind: String) -> TypeWeight? {
        kind == "markdown" && line.hasPrefix("#") ? .semibold : nil
    }
}

/// The margin (§1): each card at its line's height unless the card above
/// would overlap it — then 8 pt below that card, with a leader back to its
/// line. Subviews are the cards, in line order, then as many leaders.
struct ThreadMarginLayout: Layout {
    var wants: [CGFloat]
    var gap: CGFloat = ThreadMarginPlacement.gap

    /// The gutter the leaders run down, left of the cards.
    static let leaderWidth: CGFloat = 12
    /// How far below a line's top its leader meets it — about a line's middle.
    static let leaderDrop: CGFloat = 10

    private func measure(_ width: CGFloat, _ subviews: Subviews) -> (ys: [CGFloat], heights: [CGFloat], cardWidth: CGFloat) {
        let n = min(wants.count, subviews.count)
        let cardWidth = max(width - Self.leaderWidth, 0)
        let heights = (0..<n).map { subviews[$0].sizeThatFits(ProposedViewSize(width: cardWidth, height: nil)).height }
        return (ThreadMarginPlacement.place(wants: Array(wants.prefix(n)), heights: heights, gap: gap), heights, cardWidth)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? ReadingView.marginWidth
        let m = measure(width, subviews)
        return CGSize(width: width, height: zip(m.ys, m.heights).map { $0 + $1 }.max() ?? 0)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let m = measure(bounds.width, subviews)
        let n = m.ys.count
        for i in 0..<n {
            subviews[i].place(at: CGPoint(x: bounds.minX + Self.leaderWidth, y: bounds.minY + m.ys[i]), anchor: .topLeading, proposal: ProposedViewSize(width: m.cardWidth, height: m.heights[i]))
            if subviews.count > n + i {
                let drop = max(m.ys[i] - wants[i], 0)
                subviews[n + i].place(at: CGPoint(x: bounds.minX, y: bounds.minY + wants[i]), anchor: .topLeading, proposal: ProposedViewSize(width: Self.leaderWidth, height: drop + Self.leaderDrop + 1))
            }
        }
    }
}

/// A pushed card's leader: from its line, down the gutter, into the card. A
/// card level with its line draws none.
struct MarginLeader: Shape {
    func path(in rect: CGRect) -> Path {
        let t = ThreadMarginLayout.leaderDrop
        let drop = rect.height - t - 1
        var path = Path()
        guard drop >= 0.5 else { return path }
        path.move(to: CGPoint(x: rect.minX, y: rect.minY + t))
        path.addLine(to: CGPoint(x: rect.midX, y: rect.minY + t))
        path.addLine(to: CGPoint(x: rect.midX, y: rect.minY + t + drop))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY + t + drop))
        return path
    }
}

/// One thread: its line, who and when, its words; replies folded to a count.
struct ThreadCard: View {
    @Environment(\.colorScheme) private var scheme
    let thread: ArtifactThreadRecord
    let unfolded: Bool
    let assistantName: String?
    let now: Date
    let clock: ClockTime
    let onToggle: () -> Void

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            message(thread, head: true, p)
            if !thread.replies.isEmpty {
                ControlButton(ControlSpec(ArtifactsWords.replies(thread.replies.count), glyph: unfolded ? .disclosureOpen : .disclosure, role: .plain, selected: unfolded, name: unfolded ? "Hide \(ArtifactsWords.replies(thread.replies.count))" : "Show \(ArtifactsWords.replies(thread.replies.count))"), action: onToggle)
                if unfolded {
                    ForEach(thread.replies) { r in
                        message(r, head: false, p)
                            .padding(.leading, MetistrySpace.s2)
                    }
                }
            }
        }
        .padding(MetistrySpace.s2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(p[.elevated], in: RoundedRectangle(cornerRadius: MetistryRadius.sm, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: MetistryRadius.sm, style: .continuous).strokeBorder(p[.borderStrong], lineWidth: 1))
        .accessibilityElement(children: .contain)
    }

    /// The words of one message. An agent's take the `agent` rule and the reply serif, as in a room.
    @ViewBuilder
    private func message(_ m: ArtifactThreadRecord, head: Bool, _ p: Palette) -> some View {
        let who = ArtifactsWords.author(m.author, assistantName: assistantName)
        let when = m.at.map { clock.moment($0, now: now) }
        let line = head ? m.line.map(ArtifactsWords.line) : nil
        let resolved = head && !m.isOpen ? "Resolved" : nil
        let meta = ([who, when] + [line, resolved]).compactMap { $0 }.joined(separator: " · ")
        HStack(alignment: .top, spacing: MetistrySpace.s2) {
            if m.isAgent {
                Rectangle().fill(p[.agent]).frame(width: 2).accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: meta)
                    .metistryFont(.caption1, design: m.isAgent ? .mono : .sans)
                    .foregroundStyle(p[m.isAgent ? .agent : .textSecondary])
                    .fixedSize(horizontal: false, vertical: true)
                Text(verbatim: m.body)
                    .metistryFont(.callout, design: m.isAgent ? .serif : .sans)
                    .foregroundStyle(p[.textPrimary])
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: "\(meta.replacingOccurrences(of: " · ", with: ", ")): \(m.body)"))
    }
}

// MARK: - Compare

struct CompareView: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: ArtifactsModel

    var body: some View {
        let p = Palette(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: MetistrySpace.s4) {
                if let c = model.comparison, let from = model.version(c.from), let to = model.version(c.to) {
                    Text(verbatim: ArtifactsWords.compareHeading(from, to))
                        .metistryFont(.title3)
                        .foregroundStyle(p[.textPrimary])
                        .accessibilityAddTraits(.isHeader)
                    FlowLayout(spacing: MetistrySpace.s4) {
                        picker(ArtifactsWords.from, c.from) { id in Task { await model.compare(from: id, to: c.to) } }
                        picker(ArtifactsWords.to, c.to) { id in Task { await model.compare(from: c.from, to: id) } }
                    }
                    if let staying = model.staying {
                        FlowLayout(spacing: MetistrySpace.s3) {
                            Text(verbatim: staying.sentence)
                                .metistryFont(.body)
                                .foregroundStyle(p[.textPrimary])
                                .fixedSize(horizontal: false, vertical: true)
                            ControlButton(ControlSpec(staying.action, role: .secondary)) {
                                Task { await model.show(version: staying.versionID) }
                            }
                        }
                        .padding(MetistrySpace.s3)
                        .frame(maxWidth: MetistrySize.contentMax, alignment: .leading)
                        .background(p[.sunken], in: RoundedRectangle(cornerRadius: MetistryRadius.sm, style: .continuous))
                    }
                    diff(c, p)
                }
            }
            .padding(MetistrySpace.s5)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func picker(_ label: String, _ selected: String, _ choose: @escaping (String) -> Void) -> some View {
        Picker(selection: Binding(get: { selected }, set: choose)) {
            ForEach(model.versionList) { v in Text(verbatim: v.label).tag(v.id) }
        } label: {
            Text(verbatim: label)
        }
        .fixedSize()
    }

    @ViewBuilder
    private func diff(_ c: ArtifactComparison, _ p: Palette) -> some View {
        switch c.diff {
        case .waiting:
            PlaceholderRows(count: 6, waitingFor: nil)
        case .failed(let why, _):
            StatePanel(
                StatePanelModel(.failed, title: "Couldn't Compare", sentence: "The console didn't answer with the diff.", reason: why, action: StateWords.tryAgain),
                now: model.now(), clock: model.clock
            ) { Task { await model.compare(from: c.from, to: c.to) } }
        case .loaded(let reading):
            if reading.isEmpty {
                Text(verbatim: ArtifactsWords.noChanges)
                    .metistryFont(.body)
                    .foregroundStyle(p[.textSecondary])
            } else {
                ForEach(reading.files) { file in
                    VStack(alignment: .leading, spacing: 0) {
                        Text(verbatim: "\(file.path)  +\(file.added) −\(file.removed)")
                            .metistryFont(.subhead, design: .mono)
                            .foregroundStyle(p[.textPrimary])
                            .accessibilityLabel(Text(verbatim: "\(file.path): \(file.added) added, \(file.removed) removed"))
                            .accessibilityAddTraits(.isHeader)
                            .padding(.bottom, MetistrySpace.s1)
                        ForEach(Array(file.lines.enumerated()), id: \.offset) { _, line in
                            MarkView(Self.mark(line))
                        }
                    }
                    .frame(maxWidth: MetistrySize.contentMax, alignment: .leading)
                }
            }
        }
    }

    /// A diff line as the request body draws one: + on `ok-quiet`, − on `failed-quiet`, the glyph carrying it too.
    static func mark(_ line: ArtifactDiffLine) -> Mark {
        let text = line.text.isEmpty ? " " : line.text
        switch line.kind {
        case .added: return Mark(text, glyph: .added, glyphInk: .ok, style: .footnote, design: .mono, ink: .textPrimary, plate: .okQuiet, on: .surface, shape: .band, spoken: "added: \(line.text)")
        case .removed: return Mark(text, glyph: .removed, glyphInk: .failed, style: .footnote, design: .mono, ink: .textPrimary, plate: .failedQuiet, on: .surface, shape: .band, spoken: "removed: \(line.text)")
        case .context: return Mark(text, style: .footnote, design: .mono, ink: .textSecondary, on: .surface, shape: .band)
        case .hunk: return Mark(text, style: .caption1, design: .mono, ink: .textSecondary, plate: .sunken, on: .surface, shape: .band)
        }
    }
}

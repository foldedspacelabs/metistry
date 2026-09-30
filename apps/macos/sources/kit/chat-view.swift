// Chat, drawn (design-build-plan T6-2; screen-01-chat.md as the round-0 final
// draws it — `docs/product/design/boards/chat.py`; C16, C69, C72; P1, P8, P9).
//
// ONE CAPPED COLUMN (§2). The turns run in one left-aligned column whose width
// IS the reply measure — 620pt at the Mac's reply size, growing with the text
// size — centred in whatever width the pane has, so resizing the window moves
// the column and never rewraps a line. Only the owner's turns carry a fill
// (`accent-quiet`); the assistant's have none, and a 2px `agent` rule hangs in
// the gutter, 18pt to the left of the prose, so the prose starts on the owner's
// own left edge (C69). Tool strips, chips and cards fill the same width.
//
// §2.18, for this screen:
//
//   * Keyboard. ⌘↩ sends; ↑ in an empty composer brings back the last turn you
//     wrote; Esc leaves it; ⇧⌘N is File ▸ New Conversation (published through
//     `shellScreenActions`); the *↓ New Reply* pill is a button, and Return on
//     it scrolls. Screen 1 §6's `/` is not in components-02's table, so it is
//     not bound (T6-16's audit, hotkeys.swift).
//   * VoiceOver (screen-01 §7, verbatim with the configured name): a reply is
//     *from <name>: …*; your turn is *your turn, 9:14 AM. …*; the pill is *New
//     reply available*; a strip is *4 tools, collapsed*. A reply that arrives
//     while you are scrolled up is announced once, politely — never scrolled to.
//   * Reduce Motion. The waiting dots hold flat at 0.5 (C16); nothing else here
//     moves, and nothing animates on arrival (P8).
//   * The largest text. The measure is in the reply's own size, so the column
//     widens with the text until the pane caps it, and every row grows longer,
//     never wider.
//   * Full Keyboard Access. Every custom control is a `ControlButton` or
//     carries the accent focus ring.

import SwiftUI

// MARK: - Geometry

public enum ChatLayout {
    /// The reply size at the Mac's width (tokens.json `reply.size`: a 16pt ceiling).
    public static let replySize: CGFloat = 16
    /// `--mt-reply-measure`, 38em — drawn and measured at 620pt (§2.1).
    public static let measure: CGFloat = 620
    /// The rule and its 16pt padding: the gutter the rule hangs in (C69).
    public static let gutter: CGFloat = 18
    /// The preview pane's width (§3b).
    public static let paneWidth: CGFloat = 400
    /// Line box 1.45 over the face's own ~1.2: the extra leading, per point of size.
    static let leading: CGFloat = 0.25

    /// The column's width at a text size, in a pane this wide — never wider
    /// than the pane can hold with the gutter on both sides.
    public static func column(available: CGFloat, size: DynamicTypeSize) -> CGFloat {
        let wanted = measure * MetistryType.factor(size)
        let room = available - 2 * (gutter + MetistrySpace.s4)
        return max(min(wanted, room), 120)
    }

    /// Whether the preview pane fits beside the column without narrowing it;
    /// if not, it opens as a sheet over the transcript (§3b).
    public static func paneFitsBeside(available: CGFloat, size: DynamicTypeSize) -> Bool {
        let wanted = measure * MetistryType.factor(size) + 2 * (gutter + MetistrySpace.s4)
        return available - paneWidth >= wanted
    }
}

// MARK: - The words, as marks (so a test can hold every ink to its ground)

public enum ChatMarks {
    /// *YOU · 9:14 AM* above the owner's turn, on the transcript's ground.
    public static func yours(at: Date?, clock: ClockTime) -> [Mark] {
        var marks = [Mark("You", style: .caption1, weight: .bold, ink: .textSecondary, on: .bg, uppercase: true)]
        if let at { marks.append(Mark(clock.time(at), style: .caption1, ink: .textTertiary, on: .bg)) }
        return marks
    }

    /// The owner's words in their bubble.
    public static func yoursBody(_ text: String) -> Mark {
        Mark(text, style: .body, ink: .textPrimary, on: .accentQuiet)
    }

    /// *Not sent · Retry* (components-03): the reason, kept with the words.
    public static func notSent(_ reason: String, held: Bool) -> Mark {
        Mark(held ? "Not sent — \(StateWords.unreachable)" : "Not sent — \(reason)", glyph: .failed, style: .footnote, ink: .failed, on: .bg, spoken: "Not sent. \(held ? StateWords.unreachable : reason)")
    }

    /// The attribution a reply and a working turn carry: the spark, the name, the time.
    public static func attribution(name: String?, at: Date?, kind: String?, clock: ClockTime) -> [Mark] {
        var marks: [Mark] = []
        if let name {
            marks.append(Mark(name, glyph: .spark, style: .caption1, weight: .bold, ink: .agent, on: .bg, uppercase: true, spoken: "from \(name)"))
        } else {
            marks.append(Mark("", glyph: .spark, style: .caption1, ink: .agent, on: .bg))
        }
        if let at { marks.append(Mark(clock.time(at), style: .caption1, ink: .textTertiary, on: .bg)) }
        // A reply is the default; anything else says what it is — an identifier, as-is (P10).
        if let kind, kind != "reply" { marks.append(Mark(kind, style: .caption1, design: .mono, ink: .textSecondary, on: .bg)) }
        return marks
    }

    /// The reply's prose, for its contrast: the serif body on the transcript's ground.
    public static func replyBody(_ text: String) -> Mark {
        Mark(text, style: .body, design: .serif, ink: .textPrimary, on: .bg)
    }

    /// A held turn's line (`inbound_messages.status = held`): the provider
    /// refused the account, so the turn waits unsent on a Needs You report.
    public static func held() -> [Mark] {
        [
            Mark("waiting on the provider", style: .subhead, ink: .textPrimary, on: .degradedQuiet),
            Mark("· see Needs You", style: .subhead, ink: .textSecondary, on: .degradedQuiet),
        ]
    }

    /// The working turn's line on its `agent-quiet` band, moment by moment (§5.1).
    public static func waiting(_ moment: ChatWaitingMoment) -> [Mark] {
        switch moment {
        case .dots:
            return [Mark("working", style: .subhead, ink: .textSecondary, on: .agentQuiet)]
        case .tools(let running, let count, let elapsed):
            var marks: [Mark] = []
            marks.append(running.map { Mark($0, style: .subhead, design: .mono, ink: .textPrimary, on: .agentQuiet) } ?? Mark("working", style: .subhead, ink: .textSecondary, on: .agentQuiet))
            marks.append(Mark("· \(toolCount(count)) · \(seconds(elapsed))", style: .subhead, ink: .textSecondary, on: .agentQuiet))
            return marks
        case .silent(let quiet, _):
            return [
                Mark("working", style: .subhead, ink: .textPrimary, on: .degradedQuiet),
                Mark("· nothing back for \(seconds(quiet))", style: .subhead, ink: .textPrimary, on: .degradedQuiet),
            ]
        }
    }

    /// `▸ 4 tools · 6.2s · $0.031` on `sunken` (§3 item 4), and *failed* when the turn did.
    public static func strip(_ activity: ChatTurnActivity) -> [Mark] {
        var parts = [toolCount(activity.calls.count)]
        if let ms = activity.durationMs { parts.append(String(format: "%.1fs", Double(ms) / 1000)) }
        if let cost = activity.costUSD { parts.append(String(format: "$%.3f", cost)) }
        var marks = [Mark(parts.joined(separator: " · "), glyph: activity.isExpanded ? .disclosureOpen : .disclosure, style: .subhead, ink: .textSecondary, on: .sunken)]
        if activity.state == .failed || activity.calls.contains(where: \.failed) {
            marks.append(Mark("failed", glyph: .failed, style: .subhead, ink: .failed, on: .sunken))
        }
        return marks
    }

    /// One call, expanded: glyph · tool · duration · outcome, and a failure's reason.
    public static func call(_ call: ChatToolCall) -> [Mark] {
        var marks = [Mark(call.tool, glyph: call.failed ? .failed : nil, style: .subhead, design: .mono, ink: call.failed ? .failed : .textPrimary, on: .sunken)]
        if let ms = call.durationMs { marks.append(Mark(duration(ms), style: .subhead, ink: .textSecondary, on: .sunken)) }
        marks.append(Mark(call.isRunning ? "running" : call.failed ? "failed" : "ok", style: .subhead, ink: call.failed ? .failed : .textSecondary, on: .sunken))
        if let error = call.error, call.failed { marks.append(Mark(error, style: .footnote, design: .mono, ink: .textPrimary, on: .sunken)) }
        return marks
    }

    /// A page a reply links to, on the wash because the reference is agent-sourced (P1).
    public static func chip(_ reference: ChatPageReference) -> [Mark] {
        [
            Mark(reference.name, style: .subhead, weight: .medium, ink: .textPrimary, on: .agentQuiet),
            Mark(reference.path, style: .caption1, design: .mono, ink: .textSecondary, on: .agentQuiet),
        ]
    }

    /// The tier chip: *auto · default* in secondary ink, or the pinned tier in accent.
    public static func tierChip(pin: ChatPin?, tiers: [ChatTier], routerLast: String?) -> Mark {
        if let pin {
            let effort = tiers.first { $0.name == pin.tier }?.effort
            return Mark([pin.tier, effort].compactMap { $0 }.joined(separator: " · "), style: .caption1, weight: .semibold, ink: .accent, on: .surface, spoken: "Tier, pinned to \(pin.tier) for \(pin.scope == .turn ? "this turn" : "this conversation")")
        }
        return Mark(["auto", routerLast].compactMap { $0 }.joined(separator: " · "), style: .caption1, ink: .textSecondary, on: .surface, spoken: "Tier, chosen by the router\(routerLast.map { ", last \($0)" } ?? "")")
    }

    /// The line beneath a pinned chip: that it is pinned, and how to undo it.
    public static func pinnedLine(_ pin: ChatPin) -> Mark {
        Mark("Pinned to \(pin.tier) for \(pin.scope == .turn ? "the next message" : "this conversation") — Reset to the Router's Choice in the menu", style: .footnote, ink: .textSecondary, on: .surface)
    }

    /// *40ms* · *1.2s* · *2m 5s* — a call's time, never a clock time.
    static func duration(_ ms: Int) -> String {
        if ms < 1000 { return "\(ms)ms" }
        if ms < 60_000 { return String(format: "%.1fs", Double(ms) / 1000) }
        return ClockTime.duration(Double(ms) / 1000)
    }

    static func toolCount(_ n: Int) -> String { n == 1 ? "1 tool" : "\(n) tools" }
    static func seconds(_ t: TimeInterval) -> String { "\(max(Int(t), 0))s" }
}

// MARK: - What VoiceOver says (screen-01 §7)

public enum ChatSpoken {
    /// *from Aide: The compute budget is at 68 percent…* — the configured name,
    /// never *agent, assistant* (C88); with no name yet, just the words.
    public static func reply(_ text: String, name: String?, rating: Rating?) -> String {
        let rated = rating.map { $0 == .up ? " Rated good." : " Rated bad." } ?? ""
        return (name.map { "from \($0): " } ?? "") + text + rated
    }

    /// *your turn, 9:14 AM. Where is the compute budget this month…*
    public static func yours(_ text: String, at: Date?, clock: ClockTime) -> String {
        "your turn\(at.map { ", \(clock.time($0))" } ?? ""). \(text)"
    }

    /// *4 tools, collapsed.*
    public static func strip(_ activity: ChatTurnActivity) -> String {
        "\(ChatMarks.toolCount(activity.calls.count)), \(activity.isExpanded ? "expanded" : "collapsed")"
    }

    public static let newReply = "New reply available"
}

// MARK: - The screen

public struct ChatView: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dynamicTypeSize) private var textSize
    @Bindable var model: ChatModel
    let assistantName: String?
    let clock: ClockTime
    let calendar: Calendar
    @FocusState private var composerFocused: Bool
    @State private var sheetPreview = false

    public init(model: ChatModel, assistantName: String?, clock: ClockTime = ClockTime(), calendar: Calendar = .current) {
        self.model = model
        self.assistantName = assistantName
        self.clock = clock
        self.calendar = calendar
    }

    public var body: some View {
        let p = Palette(scheme)
        GeometryReader { geo in
            let beside = model.preview != nil && ChatLayout.paneFitsBeside(available: geo.size.width, size: textSize)
            let transcriptWidth = beside ? geo.size.width - ChatLayout.paneWidth : geo.size.width
            let column = ChatLayout.column(available: transcriptWidth, size: textSize)
            HStack(spacing: 0) {
                VStack(spacing: 0) {
                    ZStack(alignment: .bottom) {
                        transcript(column: column)
                        if model.showsNewReplyPill {
                            NewReplyPill { model.jumpToNewReply() }
                                .padding(.bottom, MetistrySpace.s3)
                        }
                    }
                    ChatComposer(model: model, assistantName: assistantName, focused: $composerFocused)
                        .frame(width: column)
                        .padding(.vertical, MetistrySpace.s3)
                        .frame(maxWidth: .infinity)
                }
                .frame(width: transcriptWidth)
                if beside, let preview = model.preview {
                    ChatPreviewPane(preview: preview, clock: clock) { model.closePreview() }
                        .frame(width: ChatLayout.paneWidth)
                }
            }
            .onChange(of: model.preview?.reference) { _, reference in
                sheetPreview = reference != nil && !ChatLayout.paneFitsBeside(available: geo.size.width, size: textSize)
            }
        }
        .background(p[.bg])
        .sheet(isPresented: $sheetPreview, onDismiss: { model.closePreview() }) {
            if let preview = model.preview {
                ChatPreviewPane(preview: preview, clock: clock) { model.closePreview() }
                    .frame(minWidth: ChatLayout.paneWidth, minHeight: 480)
            }
        }
        .task {
            // The screen's own clock: every read is still asked only when due.
            while !Task.isCancelled {
                await model.tick()
                try? await Task.sleep(for: .seconds(1))
            }
        }
        .shellScreenActions([
            .newConversation: {
                model.newConversation()
                composerFocused = true
            },
        ])
    }

    @ViewBuilder
    private func transcript(column: CGFloat) -> some View {
        let section = model.transcript.section
        if section.isFirstLoad {
            ChatPlaceholderRows(width: column)
        } else if case .failed(let reason) = section.state, !section.hasValue {
            StatePanel(
                StatePanelModel(.failed, title: "Couldn't Read the Conversation", sentence: "The console didn't answer with the transcript.", reason: reason, action: StateWords.tryAgain),
                on: .bg
            ) {
                Task { await model.refresh() }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if model.isEmpty {
            StatePanel(StatePanelModel(.empty, title: assistantName.map { "Ask \($0) Anything" } ?? "Ask Anything", sentence: "Replies arrive here, and nothing moves while you read. ⌘↩ sends."), on: .bg)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ChatTranscript(model: model, assistantName: assistantName, column: column, clock: clock, calendar: calendar)
        }
    }
}

// MARK: - The transcript

struct ChatTranscript: View {
    @Bindable var model: ChatModel
    let assistantName: String?
    let column: CGFloat
    let clock: ClockTime
    let calendar: Calendar

    var body: some View {
        let rows = model.rows(calendar: calendar)
        GeometryReader { outer in
            ScrollViewReader { proxy in
                ScrollView {
                    // Not lazy: a chat page is thirty rows, and every row laid out
                    // is what lets the end's position say, exactly, whether the
                    // reader is at the bottom — the fact P9 turns on.
                    VStack(alignment: .leading, spacing: MetistrySpace.s5) {
                        ForEach(rows) { row in
                            ChatRowView(row: row, model: model, assistantName: assistantName, clock: clock, calendar: calendar)
                                .equatable()
                                .id(row.id)
                        }
                        Color.clear
                            .frame(height: 1)
                            .id(ChatTranscript.end)
                            .background(GeometryReader { g in
                                Color.clear.preference(key: ChatEndOffset.self, value: g.frame(in: .named(ChatTranscript.space)).minY)
                            })
                            .accessibilityHidden(true)
                    }
                    .frame(width: column, alignment: .leading)
                    .padding(.vertical, MetistrySpace.s5)
                    .frame(maxWidth: .infinity)
                }
                .coordinateSpace(name: ChatTranscript.space)
                .onPreferenceChange(ChatEndOffset.self) { endY in
                    // The end is inside the viewport: the reader is at the bottom.
                    let atBottom = endY <= outer.size.height + 4
                    Task { @MainActor in
                        if atBottom { model.reachedBottom() } else if model.isAtBottom { model.isAtBottom = false }
                    }
                }
                // The only scroll this screen makes: the owner's own send, the
                // first paint, a reply while already at the end, or the pill.
                .onChange(of: model.followRequests) {
                    proxy.scrollTo(ChatTranscript.end, anchor: .bottom)
                }
                .onAppear { proxy.scrollTo(ChatTranscript.end, anchor: .bottom) }
                // The conversation's landmark; arrivals are announced by the
                // model, politely (P2), never by moving focus.
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Conversation")
            }
        }
    }

    static let end = "chat:end"
    static let space = "chat:transcript"
}

/// Where the transcript's end sits in the viewport's coordinates.
struct ChatEndOffset: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

struct ChatRowView: View, Equatable {
    let row: ChatRow
    let model: ChatModel
    let assistantName: String?
    let clock: ClockTime
    let calendar: Calendar

    nonisolated static func == (a: ChatRowView, b: ChatRowView) -> Bool {
        a.row == b.row && a.assistantName == b.assistantName
    }

    var body: some View {
        switch row {
        case .day(let day):
            ChatDaySeparator(label: day.label(now: model.now(), calendar: calendar, clock: clock))
        case .yours(let yours):
            ChatYoursView(row: yours, model: model, clock: clock)
        case .activity(let activity):
            ChatActivityView(activity: activity, model: model, assistantName: assistantName, clock: clock)
        case .reply(let message):
            ChatReplyView(message: message, model: model, assistantName: assistantName, clock: clock)
        }
    }
}

struct ChatDaySeparator: View {
    @Environment(\.colorScheme) private var scheme
    let label: String

    var body: some View {
        let p = Palette(scheme)
        HStack(spacing: MetistrySpace.s3) {
            Rectangle().fill(p[.border]).frame(height: 1)
            Text(verbatim: label)
                .metistryFont(.caption1, weight: .semibold)
                .foregroundStyle(p[.textSecondary])
                .fixedSize()
            Rectangle().fill(p[.border]).frame(height: 1)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: label))
        .accessibilityAddTraits(.isHeader)
    }
}

// MARK: - The owner's turn

struct ChatYoursView: View {
    @Environment(\.colorScheme) private var scheme
    let row: ChatYoursRow
    let model: ChatModel
    let clock: ClockTime

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                ForEach(Array(ChatMarks.yours(at: row.at, clock: clock).enumerated()), id: \.offset) { MarkView($0.element) }
            }
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 0) {
                Text(verbatim: row.text)
                    .metistryFont(.body)
                    .foregroundStyle(p[.textPrimary])
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            .padding(.vertical, MetistrySpace.s3)
            .padding(.horizontal, MetistrySpace.s4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(p[.accentQuiet], in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(verbatim: ChatSpoken.yours(row.text, at: row.at, clock: clock)))
            if let local = row.local, case .notSent(let reason, let held) = local.state {
                HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                    MarkView(ChatMarks.notSent(reason, held: held))
                    Spacer(minLength: 0)
                    ControlButton(ControlSpec(StateWords.tryAgain, role: .secondary, disabledBecause: model.sendingUnavailableReason)) {
                        Task { await model.retry(local.id) }
                    }
                }
                if let because = model.sendingUnavailableReason { FactNote(FactNoteModel(because), on: .bg) }
            }
        }
    }
}

// MARK: - What a message set working: the waiting moments, then the strip

struct ChatActivityView: View {
    @Environment(\.colorScheme) private var scheme
    let activity: ChatTurnActivity
    let model: ChatModel
    let assistantName: String?
    let clock: ClockTime

    var body: some View {
        if activity.state == .working {
            // The waiting line counts seconds, so it redraws each second — on its own.
            TimelineView(.periodic(from: .now, by: 1)) { _ in
                // the tick redraws; the clock is the model's, so a test's frozen
                // now stays frozen and the wall clock never leaks into the words
                working(now: model.now())
            }
        } else if activity.state == .held {
            held
        } else {
            ChatToolStrip(activity: activity, model: model)
        }
    }

    /// Static on purpose: nothing is running, so nothing moves or counts.
    private var held: some View {
        let p = Palette(scheme)
        return HStack(alignment: .center, spacing: MetistrySpace.s2) {
            ForEach(Array(ChatMarks.held().enumerated()), id: \.offset) { MarkView($0.element) }
        }
        .padding(.vertical, MetistrySpace.s1)
        .padding(.horizontal, MetistrySpace.s2 + 2)
        .background(p[.degradedQuiet], in: RoundedRectangle(cornerRadius: MetistryRadius.sm, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: "Waiting on the provider — see Needs You"))
    }

    private func working(now: Date) -> some View {
        let p = Palette(scheme)
        let moment = ChatWaitingMoment.of(activity, now: now) ?? .dots
        let silent: Bool = { if case .silent = moment { return true }; return false }()
        return VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                ForEach(Array(ChatMarks.attribution(name: assistantName, at: activity.startedAt, kind: nil, clock: clock).enumerated()), id: \.offset) { MarkView($0.element) }
            }
            .accessibilityHidden(true)
            HStack(alignment: .center, spacing: MetistrySpace.s2) {
                if case .dots = moment { WaitingDots() }
                if case .tools(let running, _, _) = moment, running != nil {
                    Image(systemName: MetistryGlyph.spark.rawValue).foregroundStyle(p[.agent]).accessibilityHidden(true)
                }
                ForEach(Array(ChatMarks.waiting(moment).enumerated()), id: \.offset) { MarkView($0.element) }
            }
            .padding(.vertical, silent ? MetistrySpace.s1 : MetistrySpace.s2 + 2)
            .padding(.horizontal, silent ? MetistrySpace.s2 + 2 : MetistrySpace.s3)
            .background(p[silent ? .degradedQuiet : .agentQuiet], in: RoundedRectangle(cornerRadius: silent ? MetistryRadius.sm : MetistryRadius.md, style: .continuous))
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: Self.spoken(moment, name: assistantName)))
    }

    static func spoken(_ moment: ChatWaitingMoment, name: String?) -> String {
        let who = name.map { "\($0) is working" } ?? "working"
        switch moment {
        case .dots: return who
        case .tools(let running, let count, let elapsed):
            return "\(who)\(running.map { ", running \($0)" } ?? ""), \(ChatMarks.toolCount(count)), \(Int(elapsed)) seconds"
        case .silent(let quiet, _):
            return "\(who), nothing back for \(Int(quiet)) seconds"
        }
    }
}

/// Three 5pt `agent` dots on a 1.45 s opacity loop — the product's one
/// looping animation (C16) — held flat at 0.5 under Reduce Motion.
struct WaitingDots: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if ChatDots.isAnimated(reduceMotion: reduceMotion) {
            TimelineView(.animation) { context in
                dots(ChatDots.opacities(at: context.date.timeIntervalSinceReferenceDate, reduceMotion: false))
            }
        } else {
            dots(ChatDots.opacities(at: 0, reduceMotion: true))
        }
    }

    private func dots(_ opacities: [Double]) -> some View {
        let p = Palette(scheme)
        return HStack(spacing: MetistrySpace.s1) {
            ForEach(0..<3, id: \.self) { i in
                Circle().fill(p[.agent]).frame(width: 5, height: 5).opacity(opacities[i])
            }
        }
        .accessibilityHidden(true)
    }
}

/// The collapsed strip, `▸ 4 tools · 6.2s · $0.031`, that opens to one line
/// per call — collapsed by default, open by itself only when a call failed.
struct ChatToolStrip: View {
    @Environment(\.colorScheme) private var scheme
    let activity: ChatTurnActivity
    let model: ChatModel
    @FocusState private var focused: Bool

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            Button {
                model.toggleStrip(activity.messageID)
            } label: {
                HStack(spacing: MetistrySpace.s2) {
                    ForEach(Array(ChatMarks.strip(activity).enumerated()), id: \.offset) { MarkView($0.element) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .focused($focused)
            .focusEffectDisabled()
            .accessibilityLabel(Text(verbatim: ChatSpoken.strip(activity)))
            .accessibilityAddTraits(.isButton)
            if activity.isExpanded {
                ForEach(activity.calls) { call in
                    FlowLayout(spacing: MetistrySpace.s2) {
                        ForEach(Array(ChatMarks.call(call).enumerated()), id: \.offset) { MarkView($0.element) }
                    }
                    .textSelection(.enabled)
                }
            }
        }
        .padding(.vertical, MetistrySpace.s2)
        .padding(.horizontal, MetistrySpace.s3)
        .background(p[.sunken], in: RoundedRectangle(cornerRadius: MetistryRadius.sm, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: MetistryRadius.sm, style: .continuous).inset(by: -3).strokeBorder(focused ? p[.focusRing] : .clear, lineWidth: 2))
    }
}

// MARK: - A reply

struct ChatReplyView: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dynamicTypeSize) private var textSize
    let message: ChatMessage
    let model: ChatModel
    let assistantName: String?
    let clock: ClockTime
    @State private var askingNote = false
    @State private var note = ""

    var body: some View {
        let p = Palette(scheme)
        let rating = model.rating(of: message)
        let size = ChatLayout.replySize * MetistryType.factor(textSize)
        let references = ChatPageReference.all(in: message.text)
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            HStack(alignment: .center, spacing: MetistrySpace.s2) {
                ForEach(Array(ChatMarks.attribution(name: assistantName, at: message.ts, kind: message.status, clock: clock).enumerated()), id: \.offset) { MarkView($0.element) }
                    .accessibilityHidden(true)
                Spacer(minLength: 0)
                // The rating as drawn beside the name (the Chat board's thumbs);
                // the same two verbs are the turn's right-click menu (P8).
                ControlButton(ControlSpec("", glyph: .good, role: .plain, selected: rating == .up, name: "Good")) { rate(.up) }
                ControlButton(ControlSpec("", glyph: .bad, role: .plain, selected: rating == .down, name: "Bad")) { rate(.down) }
                    .popover(isPresented: $askingNote, arrowEdge: .bottom) { noteField }
            }
            VStack(alignment: .leading, spacing: MetistrySpace.s3) {
                ForEach(Array(Self.paragraphs(message.text).enumerated()), id: \.offset) { item in
                    Text(verbatim: item.element)
                        .font(.system(size: size, design: .serif))
                        .lineSpacing(size * ChatLayout.leading)
                        .foregroundStyle(p[.textPrimary])
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(verbatim: ChatSpoken.reply(message.text, name: assistantName, rating: rating)))
            .accessibilityActions {
                Button("Good") { rate(.up) }
                Button("Bad") { rate(.down) }
                if rating != nil { Button("Clear Rating") { rate(nil) } }
            }
            if !references.isEmpty {
                FlowLayout(spacing: MetistrySpace.s2) {
                    ForEach(references) { reference in
                        ChatPageChip(reference: reference) { Task { await model.open(reference) } }
                    }
                }
            }
            if let problem = model.ratingProblem, problem.messageID == message.messageID {
                MarkView(Mark(problem.text, glyph: .failed, style: .footnote, ink: .failed, on: .bg))
            }
            if let card = model.promptCard(for: message, assistantName: assistantName) {
                ChatPromptCard(card: card, model: model)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // C69: a 2px `agent` rule, hung in the gutter so the prose keeps the owner's left edge.
        .overlay(alignment: .leading) {
            Rectangle().fill(p[.agent]).frame(width: 2).offset(x: -ChatLayout.gutter)
        }
        .contextMenu {
            Button("Good") { rate(.up) }
            Button("Bad…") { rate(.down) }
            if rating != nil { Button("Clear Rating") { rate(nil) } }
        }
    }

    /// Pressing the lit one clears it; Bad asks for an optional note (reply-feedback.md).
    private func rate(_ pressed: Rating?) {
        let current = model.rating(of: message)
        let next: Rating? = pressed == nil ? nil : (current == pressed ? nil : pressed)
        Task { await model.rate(message, next) }
        if next == .down { note = ""; askingNote = true }
    }

    private var noteField: some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            TextField(text: $note, prompt: Text(verbatim: "What was wrong with it? (optional)")) { Text(verbatim: "What was wrong with it? (optional)") }
                .labelsHidden()
                .textFieldStyle(.roundedBorder)
                .frame(width: 280)
            HStack {
                Spacer()
                ControlButton(ControlSpec("Skip", role: .plain)) { askingNote = false }
                ControlButton(ControlSpec("Add Note", role: .primary)) {
                    askingNote = false
                    Task { await model.rate(message, .down, note: note) }
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(MetistrySpace.s3)
    }

    /// Paragraphs are separated by a blank line; each keeps its own line breaks.
    static func paragraphs(_ text: String) -> [String] {
        text.components(separatedBy: "\n\n").map { $0.trimmingCharacters(in: .newlines) }.filter { !$0.isEmpty }
    }
}

struct ChatPageChip: View {
    @Environment(\.colorScheme) private var scheme
    let reference: ChatPageReference
    let open: () -> Void
    @FocusState private var focused: Bool

    var body: some View {
        let p = Palette(scheme)
        let marks = ChatMarks.chip(reference)
        Button(action: open) {
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                Image(systemName: "doc.text").foregroundStyle(p[.agent]).accessibilityHidden(true)
                ForEach(Array(marks.enumerated()), id: \.offset) { MarkView($0.element) }
            }
            .padding(.horizontal, MetistrySpace.s2 + 2)
            .padding(.vertical, MetistrySpace.s1)
            .background(p[.agentQuiet], in: RoundedRectangle(cornerRadius: MetistryRadius.sm, style: .continuous))
        }
        .buttonStyle(.plain)
        .focused($focused)
        .focusEffectDisabled()
        .overlay(RoundedRectangle(cornerRadius: MetistryRadius.sm, style: .continuous).inset(by: -3).strokeBorder(focused ? p[.focusRing] : .clear, lineWidth: 2))
        .accessibilityLabel(Text(verbatim: "Page, \(reference.name), \(reference.path)"))
        .accessibilityHint(Text(verbatim: "Opens beside the conversation"))
    }
}

/// The question a reply ended with (§3.5), drawn as its request card with an
/// `accent` left rule: the same card Needs You draws, so answering here and
/// there is one act on one row.
struct ChatPromptCard: View {
    @Environment(\.colorScheme) private var scheme
    let card: RequestAnswering
    let model: ChatModel

    var body: some View {
        let p = Palette(scheme)
        RequestCardView(card, allowsDecisions: model.allowsSending, today: ChatPromptCard.today(model.now()))
            .overlay(alignment: .leading) {
                Rectangle().fill(p[.accent]).frame(width: 3)
            }
            .clipShape(RoundedRectangle(cornerRadius: MetistryRadius.md, style: .continuous))
    }

    static func today(_ now: Date) -> TaskDay {
        let d = Calendar.current.dateComponents([.year, .month, .day], from: now)
        return TaskDay(String(format: "%04d-%02d-%02d", d.year ?? 1970, d.month ?? 1, d.day ?? 1))!
    }
}

// MARK: - The pill (P9)

/// *↓ New Reply* — the one element that exists because something arrived, and
/// it exists so that nothing else moves.
struct NewReplyPill: View {
    @Environment(\.colorScheme) private var scheme
    let action: () -> Void
    @FocusState private var focused: Bool

    var body: some View {
        let p = Palette(scheme)
        Button(action: action) {
            Label {
                Text(verbatim: "New Reply").metistryFont(.subhead, weight: .semibold)
            } icon: {
                Image(systemName: "arrow.down")
            }
            .foregroundStyle(p[.onAccent])
            .padding(.horizontal, MetistrySpace.s4)
            .frame(minHeight: MetistrySize.touchTarget)
            .background(p[.accent], in: Capsule())
            .overlay(Capsule().inset(by: -3).strokeBorder(focused ? p[.focusRing] : .clear, lineWidth: 2))
        }
        .buttonStyle(.plain)
        .focused($focused)
        .focusEffectDisabled()
        .onKeyPress(.return) {
            action()
            return .handled
        }
        .accessibilityLabel(Text(verbatim: ChatSpoken.newReply))
    }
}

// MARK: - The composer

struct ChatComposer: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: ChatModel
    let assistantName: String?
    var focused: FocusState<Bool>.Binding

    var body: some View {
        let p = Palette(scheme)
        let working = model.isWorking
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            // The prompt is the field's name on the Mac (see mac-app.md: a
            // SwiftUI field's label does not reach the AppKit field).
            TextField(text: $model.draft, prompt: Text(verbatim: "Ask anything…"), axis: .vertical) { Text(verbatim: "Message") }
                .labelsHidden()
                .textFieldStyle(.plain)
                .metistryFont(.body)
                .lineLimit(1...5)
                .focused(focused)
                .onKeyPress(.upArrow) {
                    model.recallLast() ? .handled : .ignored
                }
                .onExitCommand { focused.wrappedValue = false }
            HStack(alignment: .center, spacing: MetistrySpace.s2) {
                ChatTierMenu(model: model)
                Spacer(minLength: 0)
                if working {
                    // Send becomes Stop while a turn works (§5.1) — and Stop has
                    // no route behind it, so it says so and Send stays: a
                    // composer that could only offer a dead Stop would be a dead end.
                    ControlButton(ControlSpec("Stop", role: .plain, disabledBecause: ChatModel.stopUnavailable)) {}
                }
                ControlButton(ControlSpec("Send", role: .primary, shortcut: "Command-Return", disabledBecause: model.sendingUnavailableReason)) {
                    Task { await model.send() }
                }
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            if let pin = model.pin { MarkView(ChatMarks.pinnedLine(pin)) }
            if working { FactNote(FactNoteModel(ChatModel.stopUnavailable), on: .surface) }
            if let because = model.sendingUnavailableReason { FactNote(FactNoteModel(because), on: .surface) }
        }
        .padding(.vertical, MetistrySpace.s3)
        .padding(.horizontal, MetistrySpace.s4 - 2)
        .background(p[.surface], in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(p[.borderControl], lineWidth: 1))
    }
}

/// The tier chip and its menu (§3c): the router decides, and the menu says so
/// first; the instance's tiers as `GET /api/commands` names them, each with
/// what it runs on; this turn or this conversation; and the way back.
struct ChatTierMenu: View {
    @Environment(\.colorScheme) private var scheme
    let model: ChatModel
    @State private var open = false
    @FocusState private var focused: Bool

    var body: some View {
        let p = Palette(scheme)
        let chip = ChatMarks.tierChip(pin: model.pin, tiers: model.tiers, routerLast: model.routerLastTier)
        Button {
            open.toggle()
        } label: {
            HStack(spacing: MetistrySpace.s1) {
                if model.pin != nil { Image(systemName: "pin.fill").foregroundStyle(p[.accent]) }
                MarkView(chip)
                Image(systemName: MetistryGlyph.disclosureOpen.rawValue).font(.caption2).foregroundStyle(p[.textSecondary])
            }
            .padding(.horizontal, MetistrySpace.s2)
            .padding(.vertical, 2)
            // The chip OPENS the menu, so its outline is a control boundary (`border-control`).
            .overlay(Capsule().strokeBorder(p[.borderControl], lineWidth: 1))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .focused($focused)
        .focusEffectDisabled()
        .overlay(Capsule().inset(by: -3).strokeBorder(focused ? p[.focusRing] : .clear, lineWidth: 2))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: chip.voice))
        .accessibilityAddTraits(.isButton)
        .help(chip.voice)
        .popover(isPresented: $open, arrowEdge: .top) {
            ChatTierPicker(model: model) { open = false }
        }
    }

    /// *deep — opus · high* — the tier, then what it runs on right now.
    static func row(_ tier: ChatTier) -> String {
        let runs = [tier.model, tier.effort].compactMap { $0 }.joined(separator: " · ")
        return runs.isEmpty ? tier.name : "\(tier.name) — \(runs)"
    }
}

/// The picker's four parts. Selection is never carried by fill alone: the
/// chosen row takes an accent check and accent text (§6.1 fault 2).
struct ChatTierPicker: View {
    @Environment(\.colorScheme) private var scheme
    let model: ChatModel
    let done: () -> Void

    var body: some View {
        let p = Palette(scheme)
        let tiers = model.tiers
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                Text(verbatim: model.routerLastTier.map { "The router picked \($0) for your last message" } ?? "The router picks the tier for each message")
                    .metistryFont(.subhead, weight: .medium)
                    .foregroundStyle(p[.textPrimary])
                Text(verbatim: "A pin here chooses the tier; the rules still decide what may run.")
                    .metistryFont(.caption1)
                    .foregroundStyle(p[.textSecondary])
            }
            .fixedSize(horizontal: false, vertical: true)
            .padding(MetistrySpace.s3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(p[.sunken])
            .accessibilityElement(children: .combine)

            Text(verbatim: "Preset").textCase(.uppercase)
                .metistryFont(.caption1, weight: .bold)
                .foregroundStyle(p[.textSecondary])
                .padding(.horizontal, MetistrySpace.s3)
                .padding(.top, MetistrySpace.s3)
                .accessibilityAddTraits(.isHeader)
            if tiers.isEmpty {
                Text(verbatim: model.commands.section.problem.map { "No tiers: \($0)" } ?? "The console hasn't listed any tiers yet")
                    .metistryFont(.subhead)
                    .foregroundStyle(p[.textSecondary])
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(MetistrySpace.s3)
            }
            ForEach(tiers) { tier in
                let chosen = model.pin?.tier == tier.name
                Button {
                    model.pinTier(tier.name, scope: model.pin?.scope ?? .turn)
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                        Image(systemName: "checkmark").foregroundStyle(p[.accent]).opacity(chosen ? 1 : 0)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: ChatTierMenu.row(tier))
                                .metistryFont(.subhead, design: .mono, weight: chosen ? .semibold : .regular)
                                .foregroundStyle(p[chosen ? .accent : .textPrimary])
                            if let about = tier.about {
                                Text(verbatim: about).metistryFont(.caption1).foregroundStyle(p[.textSecondary])
                            }
                        }
                        .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, MetistrySpace.s3)
                    .padding(.vertical, MetistrySpace.s2)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(verbatim: "\(tier.name)\(tier.model.map { ", \($0)" } ?? "")\(tier.effort.map { ", \($0) effort" } ?? "")"))
                .accessibilityValue(Text(verbatim: chosen ? MetistryGlyph.radioOn.spoken : ""))
                .accessibilityAddTraits(chosen ? .isSelected : [])
            }

            Divider().padding(.top, MetistrySpace.s2)
            Picker(selection: Binding(get: { model.pin?.scope ?? .turn }, set: { model.setPinScope($0) })) {
                ForEach(ChatPinScope.allCases, id: \.self) { Text(verbatim: $0.rawValue).tag($0) }
            } label: {
                Text(verbatim: "Scope")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .accessibilityLabel("Scope")
            .disabled(model.pin == nil)
            .padding(MetistrySpace.s3)

            HStack {
                Text(verbatim: "Each tier's model and effort are set in Settings ▸ Compute.")
                    .metistryFont(.caption1)
                    .foregroundStyle(p[.textSecondary])
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: MetistrySpace.s2)
                ControlButton(ControlSpec("Reset to the Router's Choice", role: .plain)) {
                    model.resetTier()
                    done()
                }
                .disabled(model.pin == nil)
            }
            .padding([.horizontal, .bottom], MetistrySpace.s3)
        }
        .frame(width: 340)
        .background(p[.elevated])
    }
}

// MARK: - The first load

/// Placeholder rows, only on the very first load (C135).
struct ChatPlaceholderRows: View {
    @Environment(\.colorScheme) private var scheme
    let width: CGFloat

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s5) {
            ForEach([0.55, 0.9, 0.4], id: \.self) { fraction in
                RoundedRectangle(cornerRadius: MetistryRadius.md, style: .continuous)
                    .fill(p[.sunken])
                    .frame(width: width * fraction, height: 44)
            }
        }
        .frame(width: width, alignment: .leading)
        .padding(.vertical, MetistrySpace.s5)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Reading the conversation")
    }
}

// MARK: - The preview pane (§3b)

/// A page read without leaving Metistry: kind · name · path, and the page at
/// reading measure. A third column when the window holds it, a sheet when not.
struct ChatPreviewPane: View {
    @Environment(\.colorScheme) private var scheme
    let preview: ChatPreview
    let clock: ClockTime
    let close: () -> Void

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                Image(systemName: "doc.text").foregroundStyle(p[.agent]).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: preview.reference.name).metistryFont(.headline).foregroundStyle(p[.textPrimary])
                        .accessibilityAddTraits(.isHeader)
                    Text(verbatim: preview.reference.path).metistryFont(.caption1, design: .mono).foregroundStyle(p[.textSecondary])
                        .textSelection(.enabled)
                }
                Spacer(minLength: 0)
                ControlButton(ControlSpec("Close", role: .plain, shortcut: "Esc", name: "Close Preview"), action: close)
                    .keyboardShortcut(.cancelAction)
            }
            .padding(MetistrySpace.s4)
            Divider()
            content(p)
        }
        .background(p[.surface])
        .overlay(alignment: .leading) { Rectangle().fill(p[.border]).frame(width: 1) }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(verbatim: "Preview, \(preview.reference.name)"))
    }

    @ViewBuilder
    private func content(_ p: Palette) -> some View {
        switch preview.state {
        case .loading:
            MarkView(Mark("Opening \(preview.reference.name)…", style: .subhead, ink: .textSecondary, on: .surface))
                .padding(MetistrySpace.s4)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        case .failed(let reason):
            StatePanel(StatePanelModel(.failed, title: "Couldn't Open the Page", sentence: "The console didn't return \(preview.reference.path).", reason: reason))
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        case .loaded(let page):
            ScrollView {
                Text(Self.rendered(page.content))
                    .metistryFont(.body)
                    .foregroundStyle(p[.textPrimary])
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(MetistrySpace.s4)
            }
        }
    }

    /// Markdown's inline marks, the page's own line breaks kept.
    static func rendered(_ markdown: String) -> AttributedString {
        (try? AttributedString(markdown: markdown, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(markdown)
    }
}

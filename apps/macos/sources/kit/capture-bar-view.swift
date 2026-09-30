// The floating bar, drawn (screen 11 §2–§7). The panel that holds it — a
// floating, non-activating window on the edge the owner picked — is the app
// target's (sources/app/capture-bar-panel.swift); everything it shows is
// here, platform-neutral, and decided by `CaptureBarModel`.
//
// GLASS AT THE MEASURED FLOORS (§7, C70, C73, C74). Four layers, one of them
// not decoration: the platform's own behind-window blur (the lensed
// backdrop), a `surface` scrim that never dips under its floor — 0.75 on the
// rail, which carries marks only, 0.86 on every panel, which carries text —
// a 0.5pt edge with a 1pt specular highlight, and a contact shadow under a
// wide soft one. After ten idle seconds only the decoration (the highlight
// and the shadows) fades; the scrim and the ink never do (review 01). The
// rail carries no words: `text-tertiary` is not legal on thin glass, and a
// label there would need it.
//
// THE ONE BREATH (§3.1). While a session runs the mark's halo breathes —
// 2.6 s, ease-in-out, scale 1 → 1.5, opacity 0.85 → 0.12, one ring in the
// `agent` hue at 1.5pt, no colour change. The mark stays filled at all times,
// so the state never depends on the animation. Under Reduce Motion the halo
// holds at its widest, still and visible. This is the second and last
// animation in the product.
//
// ACCESSIBILITY (§2.18, components-02 §3). The bar is one group, *Metistry
// capture bar*. Each glyph-only control speaks its name (and its shortcut,
// when one is on); Record speaks what it would take; the live mark speaks
// the recording's status, and the model announces it once. Panels have a
// fixed width, so the largest text grows them longer, never wider.

import SwiftUI

// MARK: - The measured values

/// The glass, as numbers (screen 11 §7).
public enum CaptureBarGlass {
    /// A surface carrying only marks in `text-secondary`, `agent` or `accent`.
    public static let marksFloor = 0.75
    /// A surface carrying text: secondary ink in dark binds it (0.83 measured).
    public static let textFloor = 0.86
    /// The specular highlight's white, by scheme.
    public static let specularLight = 0.62
    public static let specularDark = 0.20
    /// Concentric radii: 18 outside, 11 inside — the difference is the padding.
    public static let outerRadius: CGFloat = 18
    public static let innerRadius: CGFloat = 11
    /// The rail is a capsule: half its width.
    public static let railWidth: CGFloat = 34
    public static let railRadius: CGFloat = 17

    /// The scrim's stops, top to bottom: thicker at the top where the
    /// specular sits, and never — at any stop — under the floor (C74).
    public static func scrimStops(floor: Double) -> [(location: Double, opacity: Double)] {
        [(0, floor + 0.02), (0.46, floor), (1, floor)]
    }
}

/// The breath, as numbers (screen 11 §3.1; boards/lib.py `motioncss`).
public struct CaptureBarBreath: Sendable, Equatable {
    public struct Frame: Sendable, Equatable {
        public let scale: Double
        public let opacity: Double
    }

    public static let period: TimeInterval = 2.6
    public static let rest = Frame(scale: 1, opacity: 0.85)
    public static let widest = Frame(scale: 1.5, opacity: 0.12)
    /// Reduce Motion: the ring holds at its widest, still — and visible.
    public static let held = Frame(scale: 1.5, opacity: 0.4)

    public let reduceMotion: Bool

    public init(reduceMotion: Bool) {
        self.reduceMotion = reduceMotion
    }

    /// Whether anything moves.
    public var breathes: Bool { !reduceMotion }

    /// The halo at either end of the cycle. Under Reduce Motion both ends are
    /// the same still frame, so nothing can move whatever the view does.
    public func frame(out: Bool) -> Frame {
        guard breathes else { return Self.held }
        return out ? Self.widest : Self.rest
    }

    /// Half the period each way, eased, forever — or nothing at all.
    public var animation: Animation? {
        breathes ? .easeInOut(duration: Self.period / 2).repeatForever(autoreverses: true) : nil
    }
}

// MARK: - Glass

struct CaptureBarGlassBackground: View {
    @Environment(\.colorScheme) private var scheme
    let floor: Double
    let radius: CGFloat
    /// The ring takes the `agent` hue while a session runs.
    var live = false
    var faded = false

    var body: some View {
        let p = Palette(scheme)
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        let dark = scheme == .dark
        let stops = CaptureBarGlass.scrimStops(floor: floor).map { Gradient.Stop(color: p[.surface].opacity($0.opacity), location: $0.location) }
        ZStack {
            // 1. The lensed backdrop: the platform's behind-window blur.
            shape.fill(.ultraThinMaterial)
            // 2. The scrim — the one layer that keeps the inks legal.
            shape.fill(LinearGradient(stops: stops, startPoint: .top, endPoint: .bottom))
            // 3. The specular edge: a 0.5pt ring and a 1pt highlight along the top.
            shape.strokeBorder(live ? p[.agent].opacity(0.6) : (dark ? Color.white.opacity(0.13) : p[.borderStrong].opacity(0.55)), lineWidth: 0.5)
            shape.inset(by: 0.5)
                .stroke(LinearGradient(colors: [Color.white.opacity(dark ? CaptureBarGlass.specularDark : CaptureBarGlass.specularLight), .clear], startPoint: .top, endPoint: UnitPoint(x: 0.5, y: 0.14)), lineWidth: 1)
                .opacity(faded ? 0 : 1)
        }
        // 4. The ground: a tight contact shadow under a wide soft one.
        .shadow(color: .black.opacity(faded ? 0 : 0.10), radius: 1, y: 1)
        .shadow(color: .black.opacity(faded ? 0 : 0.28), radius: 17, y: 12)
        .accessibilityHidden(true)
    }
}

// MARK: - The bar

/// The rail and whatever is open beside it.
public struct CaptureBarView: View {
    @Bindable private var model: CaptureBarModel

    public init(model: CaptureBarModel) {
        self.model = model
    }

    public var body: some View {
        HStack(alignment: .top, spacing: MetistrySpace.s2) {
            VStack(alignment: .trailing, spacing: MetistrySpace.s2) {
                if let panel = model.panel {
                    switch panel {
                    case .note, .todo: CaptureBarJotField(model: model)
                    case .ask: CaptureBarAskPanel(model: model)
                    case .record: CaptureBarRecordSheet(model: model)
                    }
                } else {
                    CaptureBarNotices(model: model)
                }
            }
            CaptureBarRail(model: model)
        }
        .padding(MetistrySpace.s3)
        #if os(macOS)
        .onHover { inside in if inside { model.noteActivity() } }
        .onExitCommand { model.close() }
        #endif
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(verbatim: CaptureBarWords.group))
    }
}

// MARK: - The rail

struct CaptureBarRail: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: CaptureBarModel

    var body: some View {
        let p = Palette(scheme)
        let controls = model.railControls
        VStack(spacing: 3) {
            Group {
                if model.isRecording {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        CaptureBarBreathingMark()
                            .accessibilityElement()
                            .accessibilityLabel(Text(verbatim: model.spokenStatus(at: context.date)))
                            .accessibilityAddTraits(.updatesFrequently)
                    }
                } else {
                    CaptureBarMark(live: false)
                        .accessibilityHidden(true)
                }
            }
            .frame(height: 22)
            if model.isRecording {
                // The senses that are OPEN, read from the recorder (P5): a
                // display while a picture is taken, a microphone while the
                // owner is heard. The glyph alone, `agent` ink, no plate (C73).
                VStack(spacing: 7) {
                    if model.recorder?.senses.display == true { senseGlyph("display") }
                    if model.recorder?.senses.microphone == true { senseGlyph("mic") }
                }
                .padding(.vertical, 3)
                .foregroundStyle(p[.agent])
                .accessibilityHidden(true)   // spoken in the status, as part of its row
            }
            separator(p)
            railButton("bubble.left", controls[0]) { model.open(.ask) }
            railButton("note.text", controls[1]) { model.open(.note) }
            railButton("checklist", controls[2]) { model.open(.todo) }
            separator(p)
            if model.isRecording {
                railButton("stop.circle", controls[3], ink: .degraded) { Task { await model.stopRecording() } }
            } else {
                railButton("record.circle", controls[3]) { model.open(.record) }
            }
        }
        .padding(.top, 10)
        .padding(.bottom, 5)
        .frame(width: CaptureBarGlass.railWidth)
        .background(CaptureBarGlassBackground(floor: CaptureBarGlass.marksFloor, radius: CaptureBarGlass.railRadius, live: model.isRecording, faded: model.decorationFaded))
    }

    private func senseGlyph(_ name: String) -> some View {
        Image(systemName: name).font(.system(size: 12, weight: .medium))
    }

    private func separator(_ p: Palette) -> some View {
        Rectangle().fill(p[.textSecondary].opacity(0.35)).frame(width: 14, height: 0.5).padding(.vertical, 2).accessibilityHidden(true)
    }

    private func railButton(_ symbol: String, _ control: ControlSpec, ink: MetistryColorRole = .textSecondary, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 15, weight: .medium))
                .frame(width: 28, height: 28)
                .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(CaptureBarRailButtonStyle(ink: ink))
        .accessibilityLabel(Text(verbatim: control.spoken))
        .accessibilityHint(control.disabledBecause.map { Text(verbatim: $0) } ?? Text(verbatim: ""))
        .help(control.spoken)
    }
}

/// A 28pt target holding a 16pt glyph. Pressed or hovered: a quiet plate
/// behind the glyph, never a change of the glyph's colour. The focus ring
/// under Full Keyboard Access (§2.18.6).
struct CaptureBarRailButtonStyle: ButtonStyle {
    let ink: MetistryColorRole

    func makeBody(configuration: Configuration) -> some View {
        Styled(configuration: configuration, ink: ink)
    }

    struct Styled: View {
        @Environment(\.colorScheme) private var scheme
        @Environment(\.isFocused) private var focused
        @State private var hovering = false
        let configuration: ButtonStyle.Configuration
        let ink: MetistryColorRole

        var body: some View {
            let p = Palette(scheme)
            let shape = RoundedRectangle(cornerRadius: 8, style: .continuous)
            configuration.label
                .foregroundStyle(p[ink])
                .background(p[.textPrimary].opacity(configuration.isPressed || hovering ? 0.08 : 0), in: shape)
                .overlay(shape.inset(by: -2).strokeBorder(focused ? p[.focusRing] : .clear, lineWidth: 2))
                #if os(macOS)
                .onHover { hovering = $0 }
                #endif
        }
    }
}

/// The mark: a rounded square with a bar in it. At rest in `text-secondary`;
/// live, `agent`, filled — filled at all times while live, so the state never
/// depends on the halo.
struct CaptureBarMark: View {
    @Environment(\.colorScheme) private var scheme
    let live: Bool
    var size: CGFloat = 14

    var body: some View {
        let p = Palette(scheme)
        let ink = p[live ? .agent : .textSecondary]
        ZStack {
            RoundedRectangle(cornerRadius: 4.5, style: .continuous)
                .fill(live ? p[.agent].opacity(0.26) : .clear)
            RoundedRectangle(cornerRadius: 4.5, style: .continuous)
                .strokeBorder(ink, lineWidth: 1.6)
            Rectangle().fill(ink).frame(width: max(3, size / 4), height: 1.6)
        }
        .frame(width: size, height: size)
    }
}

/// The live mark and its halo — the one breath.
public struct CaptureBarBreathingMark: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    /// A test's override; nil follows the system.
    private let reduceMotion: Bool?
    private let size: CGFloat
    @State private var out = false

    public init(size: CGFloat = 14, reduceMotion: Bool? = nil) {
        self.size = size
        self.reduceMotion = reduceMotion
    }

    public var breath: CaptureBarBreath { CaptureBarBreath(reduceMotion: reduceMotion ?? systemReduceMotion) }

    public var body: some View {
        let p = Palette(scheme)
        let breath = self.breath
        let frame = breath.frame(out: out)
        ZStack {
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .strokeBorder(p[.agent], lineWidth: 1.5)
                .frame(width: size + 10, height: size + 10)
                .scaleEffect(frame.scale)
                .opacity(frame.opacity)
            CaptureBarMark(live: true, size: size)
        }
        .onAppear {
            guard let animation = breath.animation else { return }
            withAnimation(animation) { out = true }
        }
        .onChange(of: breath.breathes) { _, breathes in
            // Reduce Motion turned on mid-breath: stop where the rule says.
            out = breathes
        }
    }
}

// MARK: - Note and To-do

struct CaptureBarJotField: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: CaptureBarModel
    @FocusState private var focused: Bool

    static let width: CGFloat = 270

    var body: some View {
        let p = Palette(scheme)
        let kind = model.jotKind
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            HStack(spacing: 9) {
                Image(systemName: kind == .note ? "note.text" : "checklist")
                    .foregroundStyle(p[.textSecondary])
                    .accessibilityHidden(true)
                TextField(kind.fieldName, text: $model.jotText, prompt: Text(verbatim: kind == .note ? "note…" : "to-do…"))
                    .textFieldStyle(.plain)
                    .metistryFont(.callout)
                    .foregroundStyle(p[.textPrimary])
                    .focused($focused)
                    .onSubmit { Task { await model.saveJot() } }
                    .accessibilityLabel(Text(verbatim: kind.fieldName))
                Text(verbatim: "↩")
                    .metistryFont(.subhead, design: .mono)
                    .foregroundStyle(p[.textSecondary])
                    .accessibilityHidden(true)
            }
            if let problem = model.jotProblem {
                MarkView(Mark(problem, glyph: .failed, style: .callout, ink: .failed, on: .elevated, spoken: "\(kind.fieldName) not saved: \(problem)"))
            }
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 9)
        .frame(width: Self.width, alignment: .leading)
        .background(CaptureBarGlassBackground(floor: CaptureBarGlass.textFloor, radius: 12, faded: model.decorationFaded))
        .onAppear { focused = true }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(verbatim: kind.fieldName))
    }
}

/// What sits beside the rail with no panel open: the jot's one-second line,
/// the two-hour reminder, the disk, and a session that ended by itself.
struct CaptureBarNotices: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: CaptureBarModel

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .trailing, spacing: MetistrySpace.s2) {
            if let confirmation = model.jotConfirmation {
                HStack(spacing: 7) {
                    Image(systemName: confirmation.queued ? MetistryGlyph.degraded.rawValue : "checkmark")
                        .foregroundStyle(p[confirmation.queued ? .degraded : .ok])
                        .accessibilityHidden(true)
                    Text(verbatim: confirmation.text(clock: ClockTime()))
                        .metistryFont(.callout)
                        .foregroundStyle(p[.textPrimary])
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, 11)
                .padding(.vertical, 8)
                .frame(maxWidth: CaptureBarJotField.width, alignment: .leading)
                .background(CaptureBarGlassBackground(floor: CaptureBarGlass.textFloor, radius: 12))
                .accessibilityElement(children: .combine)
            }
            if model.reminderLine != nil || model.diskLine != nil || model.actionProblem != nil {
                notice(p) {
                    if let reminder = model.reminderLine { line(reminder, p, .textPrimary) }
                    if let disk = model.diskLine { line(disk, p, .degraded) }
                    if let problem = model.actionProblem { line(problem, p, .failed) }
                    HStack(spacing: MetistrySpace.s2) {
                        ControlButton(ControlSpec("Stop Recording", role: .secondary)) { Task { await model.stopRecording() } }
                        if model.reminderLine != nil {
                            ControlButton(ControlSpec(CaptureBarWords.keepGoing, role: .primary)) { Task { await model.keepGoing() } }
                        }
                    }
                }
            }
            if let ended = model.ended {
                notice(p) {
                    line(ended.words, p, .textPrimary)
                    HStack(spacing: MetistrySpace.s2) {
                        if model.availability == .ready {
                            ControlButton(ControlSpec(CaptureBarWords.recordAgain, role: .primary)) { model.open(.record) }
                        }
                        ControlButton(ControlSpec("Dismiss", role: .secondary)) { model.dismissEnded() }
                    }
                }
            }
        }
    }

    private func line(_ text: String, _ p: Palette, _ ink: MetistryColorRole) -> some View {
        Text(verbatim: text)
            .metistryFont(.callout)
            .foregroundStyle(p[ink])
            .fixedSize(horizontal: false, vertical: true)
    }

    private func notice<Content: View>(_ p: Palette, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s2) { content() }
            .padding(MetistrySpace.s3)
            .frame(width: CaptureBarJotField.width, alignment: .leading)
            .background(CaptureBarGlassBackground(floor: CaptureBarGlass.textFloor, radius: CaptureBarGlass.outerRadius))
            .accessibilityElement(children: .contain)
    }
}

// MARK: - Ask

public struct CaptureBarAskPanel: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable private var model: CaptureBarModel
    @FocusState private var focused: Bool

    public init(model: CaptureBarModel) {
        self.model = model
    }

    public var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: 0) {
            header(p)
            Rectangle().fill(p[.border].opacity(0.85)).frame(height: 0.5).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 11) {
                ForEach(model.askTail) { turn in
                    row(turn, p)
                }
                if model.askIsWorking {
                    Text(verbatim: "\(model.assistantName() ?? "It") is working on it…")
                        .metistryFont(.callout)
                        .foregroundStyle(p[.textSecondary])
                }
                composer(p)
                if let jots = model.sessionJotLine {
                    Rectangle().fill(p[.border].opacity(0.85)).frame(height: 0.5).accessibilityHidden(true)
                    Text(verbatim: jots)
                        .metistryFont(.subhead)
                        .foregroundStyle(p[.textSecondary])
                }
            }
            .padding(.horizontal, 13)
            .padding(.top, 12)
            .padding(.bottom, 13)
        }
        .frame(width: CaptureBarModel.askWidth, alignment: .leading)
        .background(CaptureBarGlassBackground(floor: CaptureBarGlass.textFloor, radius: CaptureBarGlass.outerRadius, live: model.isRecording, faded: model.decorationFaded))
        .onAppear { focused = true }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(verbatim: ShellCommand.ask.title(assistantName: model.assistantName())))
    }

    @ViewBuilder
    private func header(_ p: Palette) -> some View {
        HStack(spacing: 9) {
            if model.isRecording {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    HStack(spacing: 9) {
                        CaptureBarBreathingMark(size: 15)
                        if let elapsed = model.elapsed(at: context.date) {
                            Text(verbatim: CaptureBarWords.elapsed(elapsed))
                                .metistryFont(.callout, design: .mono)
                                .foregroundStyle(p[.agent])
                        }
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(Text(verbatim: model.spokenStatus(at: context.date)))
                }
                Spacer(minLength: 0)
            } else {
                CaptureBarMark(live: false, size: 15).accessibilityHidden(true)
                Text(verbatim: model.assistantName() ?? "Chat")
                    .metistryFont(.callout, weight: .semibold)
                    .foregroundStyle(p[.textPrimary])
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 0)
            }
        }
        .padding(.horizontal, 13)
        .padding(.top, 11)
        .padding(.bottom, 10)
    }

    @ViewBuilder
    private func row(_ turn: CaptureBarTurn, _ p: Palette) -> some View {
        switch turn.kind {
        case .yours:
            Text(verbatim: turn.text)
                .metistryFont(.callout)
                .foregroundStyle(p[.textPrimary])
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(p[.accentQuiet], in: RoundedRectangle(cornerRadius: CaptureBarGlass.innerRadius, style: .continuous))
        case .notSent(let reason, let turnID):
            VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                Text(verbatim: turn.text)
                    .metistryFont(.callout)
                    .foregroundStyle(p[.textPrimary])
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: MetistrySpace.s2) {
                    MarkView(Mark("Not sent · \(reason)", glyph: .failed, style: .subhead, ink: .failed, on: .elevated, spoken: "Not sent: \(reason)"))
                    ControlButton(ControlSpec("Retry", role: .secondary)) { Task { await model.retryAsk(turnID) } }
                }
            }
        case .reply:
            // The agent's prose: the 2pt `agent` rule and the serif (C69).
            VStack(alignment: .leading, spacing: 6) {
                Text(verbatim: turn.text)
                    .metistryFont(.callout, design: .serif)
                    .foregroundStyle(p[.textPrimary])
                    .lineLimit(turn.opensInChat ? CaptureBarModel.replyLines : nil)
                    .fixedSize(horizontal: false, vertical: true)
                if turn.opensInChat {
                    Button { model.openInChat() } label: {
                        Text(verbatim: "\(CaptureBarWords.openInChat) ↗")
                            .metistryFont(.subhead, weight: .semibold)
                            .foregroundStyle(p[.accent])
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Text(verbatim: CaptureBarWords.openInChat))
                }
            }
            .padding(.leading, 12)
            .overlay(alignment: .leading) { Rectangle().fill(p[.agent]).frame(width: 2).accessibilityHidden(true) }
        }
    }

    private func composer(_ p: Palette) -> some View {
        HStack(spacing: MetistrySpace.s2) {
            TextField("Message", text: $model.askDraft, prompt: Text(verbatim: "\(ShellCommand.ask.title(assistantName: model.assistantName()))…"), axis: .vertical)
                .lineLimit(1...5)
                .textFieldStyle(.plain)
                .metistryFont(.callout)
                .foregroundStyle(p[.textPrimary])
                .focused($focused)
                .onSubmit { Task { await model.sendAsk() } }
                .accessibilityLabel(Text(verbatim: "Message"))
            Button { Task { await model.sendAsk() } } label: {
                Image(systemName: "arrow.up.circle").foregroundStyle(p[.textSecondary])
            }
            .buttonStyle(.plain)
            .disabled(model.askUnavailableBecause != nil)
            .accessibilityLabel(Text(verbatim: "Send"))
            .help(model.askUnavailableBecause ?? "Send")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(p[.bg].opacity(0.72), in: RoundedRectangle(cornerRadius: CaptureBarGlass.innerRadius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: CaptureBarGlass.innerRadius, style: .continuous).strokeBorder(p[.borderControl], lineWidth: 0.5))
    }
}

// MARK: - Record

public struct CaptureBarRecordSheet: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable private var model: CaptureBarModel

    public static let width: CGFloat = 360

    public init(model: CaptureBarModel) {
        self.model = model
    }

    public var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            Text(verbatim: "Record")
                .metistryFont(.headline)
                .foregroundStyle(p[.textPrimary])
                .accessibilityAddTraits(.isHeader)
            if let reason = model.recordingOffBecause {
                Text(verbatim: reason)
                    .metistryFont(.callout)
                    .foregroundStyle(p[.textPrimary])
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: MetistrySpace.s2) {
                    ControlButton(ControlSpec(StateWords.tryAgain, role: .primary)) { Task { await model.tryAgain() } }
                    ControlButton(ControlSpec("Cancel", role: .secondary)) { model.close() }
                }
            } else {
                controls(p)
            }
        }
        .padding(.horizontal, 15)
        .padding(.vertical, 13)
        .frame(width: Self.width, alignment: .leading)
        .background(CaptureBarGlassBackground(floor: CaptureBarGlass.textFloor, radius: CaptureBarGlass.outerRadius, faded: model.decorationFaded))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(verbatim: "Record"))
    }

    @ViewBuilder
    private func controls(_ p: Palette) -> some View {
        Picker("What to record", selection: $model.sheet.mode) {
            ForEach(CaptureRecordSheet.modes, id: \.self) { mode in
                Text(verbatim: CaptureRecordSheet.title(mode)).tag(mode)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .accessibilityLabel(Text(verbatim: "What to record"))
        .disabled(model.isStarting)

        if let line = model.sheet.pickerLine {
            Text(verbatim: line)
                .metistryFont(.callout)
                .foregroundStyle(p[.textSecondary])
                .fixedSize(horizontal: false, vertical: true)
        } else {
            appsMenu(p)
        }
        Rectangle().fill(p[.border].opacity(0.85)).frame(height: 0.5).accessibilityHidden(true)
        HStack(spacing: 6) {
            Text(verbatim: model.sheet.audioLabel).metistryFont(.callout).foregroundStyle(p[.textPrimary])
            Spacer(minLength: MetistrySpace.s2)
            CaptureBarSwitch(name: model.sheet.audioLabel, isOn: $model.sheet.appAudio)
        }
        HStack(spacing: 6) {
            Text(verbatim: "Your microphone").metistryFont(.callout).foregroundStyle(p[.textPrimary])
            Text(verbatim: "your side only").metistryFont(.subhead).foregroundStyle(p[.textSecondary])
            Spacer(minLength: MetistrySpace.s2)
            CaptureBarSwitch(name: "Your microphone, your side only", isOn: $model.sheet.microphone)
        }

        if model.isStarting {
            Text(verbatim: model.sheet.mode.takesPicture ? "Choose in the macOS picker…" : "Starting…")
                .metistryFont(.callout)
                .foregroundStyle(p[.textSecondary])
        }
        if let problem = model.startProblem {
            MarkView(Mark(problem, glyph: .failed, style: .callout, ink: .failed, on: .elevated, spoken: "Not recording: \(problem)"))
        }
        if model.screenNotAllowed {
            Text(verbatim: CaptureBarWords.screenNotAllowed)
                .metistryFont(.callout)
                .foregroundStyle(p[.textPrimary])
            HStack(spacing: MetistrySpace.s2) {
                ControlButton(ControlSpec(CaptureBarWords.openSystemSettings, role: .secondary)) { model.openScreenSettings() }
                ControlButton(ControlSpec(CaptureBarWords.audioOnly, role: .secondary)) { model.switchToAudioOnly() }
            }
        }
        if let why = model.sheet.cannotStartBecause {
            Text(verbatim: why)
                .metistryFont(.callout)
                .foregroundStyle(p[.textSecondary])
        }
        HStack(spacing: MetistrySpace.s2) {
            ControlButton(ControlSpec("Record", role: .primary, disabledBecause: model.sheet.cannotStartBecause ?? (model.isStarting ? "starting" : nil))) {
                Task { await model.beginRecording() }
            }
            ControlButton(ControlSpec("Cancel", role: .secondary)) { model.close() }
        }
    }

    private func appsMenu(_ p: Palette) -> some View {
        let chosen = model.runningApps.filter { model.sheet.apps.contains($0.bundleID) }.map(\.name)
        let label = chosen.isEmpty ? "Choose apps" : chosen.joined(separator: ", ")
        return Menu {
            ForEach(model.runningApps) { app in
                Toggle(isOn: Binding(get: { model.sheet.apps.contains(app.bundleID) }, set: { _ in model.toggleApp(app.bundleID) })) {
                    Text(verbatim: app.name)
                }
            }
        } label: {
            Text(verbatim: label).metistryFont(.callout)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .accessibilityLabel(Text(verbatim: "Apps to hear: \(chosen.isEmpty ? "none chosen" : chosen.joined(separator: ", "))"))
    }
}

/// The sheet's switch, drawn rather than borrowed: AppKit's switch is a
/// platform view SwiftUI cannot name for VoiceOver, so this one is a button
/// that says its name and its state, and toggles on Space or a click.
struct CaptureBarSwitch: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.isFocused) private var focused
    let name: String
    @Binding var isOn: Bool

    var body: some View {
        let p = Palette(scheme)
        Button { isOn.toggle() } label: {
            ZStack(alignment: isOn ? .trailing : .leading) {
                Capsule().fill(p[isOn ? .accent : .sunken])
                Capsule().strokeBorder(p[isOn ? .accent : .borderControl], lineWidth: 1)
                Circle().fill(p[isOn ? .bg : .textSecondary]).frame(width: 17, height: 17).padding(3)
            }
            .frame(width: 40, height: 23)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .overlay(Capsule().inset(by: -3).strokeBorder(focused ? p[.focusRing] : .clear, lineWidth: 2))
        .accessibilityLabel(Text(verbatim: name))
        .accessibilityValue(Text(verbatim: isOn ? "on" : "off"))
        .accessibilityAddTraits(.isToggle)
    }
}

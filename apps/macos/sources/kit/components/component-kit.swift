// The pieces every shared component is made of (design-build-plan T5-3).
//
// A COMPONENT IS A PRESENTATION, THEN A VIEW. Each component in this folder
// first computes a plain value — the words it shows, in order, each as a
// `Mark` naming its type step, its ink and the ground it is painted on, and
// each control as a `ControlSpec` with the words VoiceOver says — and its view
// only draws that value. The decisions (which facet comes first, which state
// takes the one tint, what the legend says, what an Undo is called) live in
// the value, where a test can read them, dump them to a committed baseline in
// light, dark and the largest text, and check every ink against the ground it
// actually sits on (amendments §1.7: "check the composite, never the token").
//
// ONE GLYPH, ONE MEANING (amendments §8.3). Every symbol a component draws is
// a case of `MetistryGlyph`, so the same meaning cannot pick up a second mark
// and a mark cannot pick up a second meaning without a diff here.
//
// THE LARGEST TEXT. On macOS, SwiftUI's semantic fonts do not follow
// `dynamicTypeSize` — `Text("…").font(.body)` measures 214 × 16 at `.large`
// and at `.accessibility5` alike (measured on macOS 26.4) — so a test at the
// largest size would pass without anything growing. `metistryFont` therefore
// scales the Mac's own point sizes by body's Dynamic Type ratios whenever the
// environment asks for a size other than `.large`, and hands the platform's
// semantic font through untouched at `.large` (every Mac today) and on iOS,
// where Dynamic Type already does the job. Nothing on the Mac sets the size
// yet; the components are ready for whatever does.

import SwiftUI

// MARK: - Glyphs

public enum MetistryGlyph: String, CaseIterable, Sendable {
    /// The spark: on content, *the assistant wrote this* (facets-and-colour §4).
    case spark = "sparkle"
    /// ⏱ a verb that waits for the owner — Ask (screen 7 §4.1). Not Later's clock-arrow.
    case asksFirst = "timer"
    /// ⧉ reached through Metistry's proxy (screen 7 §4.1; the relay glyph of §8.3).
    case relay = "square.on.square"
    /// Later — a snooze, not a decision (components-01 §2.4).
    case later = "clock.arrow.circlepath"
    case empty = "tray"
    /// The plug is *absent*, and only absent (§8.3).
    case absent = "powerplug"
    /// Failed has its own mark so it never differs from degraded by colour alone (§8.3).
    case failed = "xmark.octagon"
    case degraded = "exclamationmark.triangle"
    case stale = "hourglass"
    /// A control off because of a fact about the system (components-01 §1.3).
    case lock = "lock"
    /// Due — a calendar, then the date (facets §8.2).
    case due = "calendar"
    /// Estimate — a clock, then the estimate (facets §8.2).
    case estimate = "clock"
    case added = "plus"
    case removed = "minus"
    case good = "hand.thumbsup"
    case bad = "hand.thumbsdown"
    case undo = "arrow.uturn.backward"
    /// A closed disclosure, and an open one.
    case disclosure = "chevron.right"
    case disclosureOpen = "chevron.down"
    /// A proposed to-do: a dashed ring, never a checkbox — there is nothing to tick until it is a task.
    case proposed = "circle.dashed"
    /// Pick one, unchosen and chosen.
    case radio = "circle"
    case radioOn = "largecircle.fill.circle"
    /// Pick any, unchosen and chosen.
    case checkbox = "square"
    case checkboxOn = "checkmark.square"
    case edit = "pencil"
    /// Approve's check and Decline's cross: the two most consequential buttons
    /// in the product keep their glyphs, so they are told apart in greyscale
    /// and not by fill alone (components-01 §2.4).
    case approve = "checkmark"
    case decline = "xmark"

    /// The symbol drawn when a control holding this glyph is selected (a lit rating).
    public var selectedName: String {
        switch self {
        case .good, .bad: return rawValue + ".fill"
        default: return rawValue
        }
    }

    /// What VoiceOver says for the glyph where it carries meaning on its own.
    public var spoken: String {
        switch self {
        case .spark: return "written by"
        case .asksFirst: return PermissionWords.asksYouFirst
        case .relay: return PermissionWords.relayed
        case .later: return "Later"
        case .empty: return "empty"
        case .absent: return "not configured"
        case .failed: return "failed"
        case .degraded: return "warning"
        case .stale: return "stale"
        case .lock: return "unavailable"
        case .due: return "due"
        case .estimate: return "estimate"
        case .added: return "added"
        case .removed: return "removed"
        case .good: return "Good"
        case .bad: return "Bad"
        case .undo: return "Undo"
        case .disclosure: return "show more"
        case .disclosureOpen: return "show less"
        case .proposed: return "proposed"
        case .radio, .checkbox: return "not chosen"
        case .radioOn, .checkboxOn: return "chosen"
        case .edit: return "Edit"
        case .approve: return "Approve"
        case .decline: return "Decline"
        }
    }
}

// MARK: - Type

public enum TypeDesign: String, Sendable {
    case sans
    /// Agent prose (C32, C35): SwiftUI's `.serif` — New York, with Dynamic Type intact.
    case serif
    /// Identifiers: agent ids, paths, tool names — as-is, never case-corrected (P10).
    case mono

    var font: Font.Design {
        switch self {
        case .sans: return .default
        case .serif: return .serif
        case .mono: return .monospaced
        }
    }
}

public enum TypeWeight: String, Sendable {
    case regular, medium, semibold, bold

    var font: Font.Weight {
        switch self {
        case .regular: return .regular
        case .medium: return .medium
        case .semibold: return .semibold
        case .bold: return .bold
        }
    }
}

extension MetistryTextStyle {
    /// The point size AppKit gives this step on macOS
    /// (`NSFont.preferredFont(forTextStyle:)`, measured on macOS 26.4; unchanged since macOS 11).
    public var macPointSize: CGFloat {
        switch self {
        case .largeTitle: return 26
        case .title1: return 22
        case .title2: return 17
        case .title3: return 15
        case .headline, .body, .mono: return 13
        case .callout: return 12
        case .subhead: return 11
        case .footnote, .caption1, .caption2: return 10
        }
    }

    var textStyle: Font.TextStyle {
        switch self {
        case .largeTitle: return .largeTitle
        case .title1: return .title
        case .title2: return .title2
        case .title3: return .title3
        case .headline: return .headline
        case .body, .mono: return .body
        case .callout: return .callout
        case .subhead: return .subheadline
        case .footnote: return .footnote
        case .caption1: return .caption
        case .caption2: return .caption2
        }
    }
}

public enum MetistryType {
    /// Body's size at each Dynamic Type step over its size at `.large` — iOS's
    /// own table (14 · 15 · 16 · 17 · 19 · 21 · 23 · 28 · 33 · 40 · 47 · 53 pt).
    public static func factor(_ size: DynamicTypeSize) -> CGFloat {
        let body: CGFloat
        switch size {
        case .xSmall: body = 14
        case .small: body = 15
        case .medium: body = 16
        case .large: body = 17
        case .xLarge: body = 19
        case .xxLarge: body = 21
        case .xxxLarge: body = 23
        case .accessibility1: body = 28
        case .accessibility2: body = 33
        case .accessibility3: body = 40
        case .accessibility4: body = 47
        case .accessibility5: body = 53
        @unknown default: body = 17
        }
        return body / 17
    }

    /// The point size a step is drawn at on the Mac at a text size.
    public static func pointSize(_ style: MetistryTextStyle, _ size: DynamicTypeSize) -> CGFloat {
        (style.macPointSize * factor(size)).rounded()
    }

    public static func font(_ style: MetistryTextStyle, design: TypeDesign, weight: TypeWeight?, size: DynamicTypeSize) -> Font {
        let w = weight?.font ?? style.weight
        let d: TypeDesign = style == .mono ? .mono : design
        #if os(macOS)
        if size != .large {
            return .system(size: pointSize(style, size), weight: w, design: d.font)
        }
        #endif
        return .system(style.textStyle, design: d.font, weight: w)
    }
}

struct MetistryFont: ViewModifier {
    @Environment(\.dynamicTypeSize) private var size
    let style: MetistryTextStyle
    let design: TypeDesign
    let weight: TypeWeight?

    func body(content: Content) -> some View {
        content.font(MetistryType.font(style, design: design, weight: weight, size: size))
    }
}

public extension View {
    /// A type step that grows with the text size on the Mac too (see the file header).
    func metistryFont(_ style: MetistryTextStyle, design: TypeDesign = .sans, weight: TypeWeight? = nil) -> some View {
        modifier(MetistryFont(style: style, design: design, weight: weight))
    }
}

// MARK: - The mark

/// One run of words, painted: the unit a component's presentation is made of.
public struct Mark: Sendable, Equatable {
    public enum Shape: String, Sendable {
        /// Words on the container's ground.
        case text
        /// A pill on its own quiet plate — a thing you can open, or a state (facets §13.3 rungs 2–3).
        case chip
        /// The priority badge: one shape for all four steps (facets §7.1).
        case badge
        /// A full-width line on its own plate — a diff line, a quoted block.
        case band
    }

    /// The words, verbatim. Empty for a glyph alone.
    public var text: String
    public var glyph: MetistryGlyph?
    /// The glyph after the words rather than before (*Dispatch ⏱*).
    public var glyphAfter: Bool
    /// The glyph's own ink when it differs from the words' (a diff's + and −).
    public var glyphInk: MetistryColorRole?
    public var style: MetistryTextStyle
    public var design: TypeDesign
    public var weight: TypeWeight?
    public var ink: MetistryColorRole
    /// The mark's own plate, when it paints one (a chip's quiet fill, a badge's solid fill).
    public var plate: MetistryColorRole?
    /// The ground the mark sits on — the container's. Ink is checked against
    /// `plate ?? on`; an outline against `on`.
    public var on: MetistryColorRole
    public var outline: MetistryColorRole?
    public var shape: Shape
    /// Section labels keep the small all-caps style — furniture, not attributes (facets §3).
    public var uppercase: Bool
    /// What VoiceOver says, when it is not the words themselves.
    public var spoken: String?

    public init(
        _ text: String,
        glyph: MetistryGlyph? = nil,
        glyphAfter: Bool = false,
        glyphInk: MetistryColorRole? = nil,
        style: MetistryTextStyle = .body,
        design: TypeDesign = .sans,
        weight: TypeWeight? = nil,
        ink: MetistryColorRole = .textPrimary,
        plate: MetistryColorRole? = nil,
        on: MetistryColorRole,
        outline: MetistryColorRole? = nil,
        shape: Shape = .text,
        uppercase: Bool = false,
        spoken: String? = nil
    ) {
        self.text = text
        self.glyph = glyph
        self.glyphAfter = glyphAfter
        self.glyphInk = glyphInk
        self.style = style
        self.design = design
        self.weight = weight
        self.ink = ink
        self.plate = plate
        self.on = on
        self.outline = outline
        self.shape = shape
        self.uppercase = uppercase
        self.spoken = spoken
    }

    /// The ground the ink is read against.
    public var ground: MetistryColorRole { plate ?? on }

    /// What VoiceOver says for this mark.
    public var voice: String {
        if let spoken { return spoken }
        if text.isEmpty { return glyph?.spoken ?? "" }
        return text
    }
}

public struct MarkView: View {
    @Environment(\.colorScheme) private var scheme
    let mark: Mark

    public init(_ mark: Mark) {
        self.mark = mark
    }

    public var body: some View {
        let p = Palette(scheme)
        let glyph = mark.glyph.map { g in
            Image(systemName: g.rawValue)
                .foregroundStyle(p[mark.glyphInk ?? mark.ink])
                .accessibilityHidden(true)
        }
        let label = HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s1) {
            if !mark.glyphAfter { glyph }
            if !mark.text.isEmpty {
                Text(verbatim: mark.text)
                    .textCase(mark.uppercase ? .uppercase : nil)
                    .foregroundStyle(p[mark.ink])
                    .fixedSize(horizontal: false, vertical: true)
            }
            if mark.glyphAfter { glyph }
        }
        .metistryFont(mark.style, design: mark.design, weight: mark.weight)

        Group {
            switch mark.shape {
            case .text:
                label
            case .chip:
                label
                    .padding(.horizontal, MetistrySpace.s2)
                    .padding(.vertical, 2)
                    .background(mark.plate.map { p[$0] } ?? .clear, in: Capsule())
                    .overlay(Capsule().strokeBorder(mark.outline.map { p[$0] } ?? .clear, lineWidth: 1))
            case .band:
                label
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, MetistrySpace.s2)
                    .padding(.vertical, 2)
                    .background(mark.plate.map { p[$0] } ?? .clear)
            case .badge:
                label
                    .padding(.horizontal, MetistrySpace.s1 + 2)
                    .padding(.vertical, 1)
                    .frame(minWidth: 24)
                    .background(mark.plate.map { p[$0] } ?? .clear, in: RoundedRectangle(cornerRadius: MetistryRadius.xs, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: MetistryRadius.xs, style: .continuous).strokeBorder(mark.outline.map { p[$0] } ?? .clear, lineWidth: 1))
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: mark.voice))
    }
}

// MARK: - Controls

/// A control a component draws: its words, and what VoiceOver says for it
/// (§2.18.3: a glyph-only control speaks its name, and its shortcut when set).
public struct ControlSpec: Sendable, Equatable {
    public enum Role: String, Sendable {
        /// The one filled accent button of a set.
        case primary
        /// Outlined in `border-control` (C92).
        case secondary
        /// A filled destructive button — only for an act that cannot be undone, and it confirms first (§8.2).
        case destructive
        /// A glyph or a word with no plate.
        case plain
    }

    /// The visible words, HIG Title Case. Empty for a glyph-only control.
    public var label: String
    public var glyph: MetistryGlyph?
    public var role: Role
    /// The shortcut, as a menu prints it (`⌘Z`), spoken after the name.
    public var shortcut: String?
    public var selected: Bool
    /// Why the control is off, when a fact about the system turned it off.
    /// A control disabled by the owner's own state carries no line (components-01 §1.3).
    public var disabledBecause: String?
    /// The name VoiceOver says for a glyph-only control.
    public var name: String?

    public init(_ label: String, glyph: MetistryGlyph? = nil, role: Role = .secondary, shortcut: String? = nil, selected: Bool = false, disabledBecause: String? = nil, name: String? = nil) {
        self.label = label
        self.glyph = glyph
        self.role = role
        self.shortcut = shortcut
        self.selected = selected
        self.disabledBecause = disabledBecause
        self.name = name
    }

    public var isEnabled: Bool { disabledBecause == nil }

    /// What VoiceOver says: the name, then the shortcut.
    public var spoken: String {
        let base = name ?? (label.isEmpty ? glyph?.spoken ?? "" : label)
        guard !base.isEmpty else { return "" }
        return shortcut.map { "\(base), \($0)" } ?? base
    }
}

public struct ControlButton: View {
    let control: ControlSpec
    let action: () -> Void

    public init(_ control: ControlSpec, action: @escaping () -> Void) {
        self.control = control
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            HStack(spacing: MetistrySpace.s1) {
                if let glyph = control.glyph {
                    Image(systemName: control.selected ? glyph.selectedName : glyph.rawValue)
                        .accessibilityHidden(true)
                }
                if !control.label.isEmpty {
                    Text(verbatim: control.label).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .buttonStyle(MetistryButtonStyle(role: control.role))
        .disabled(!control.isEnabled)
        .focusEffectDisabled()
        .accessibilityLabel(Text(verbatim: control.spoken))
        .accessibilityAddTraits(control.selected ? .isSelected : [])
        .help(control.spoken)
    }
}

/// The four button weights, and the focus ring every custom control carries
/// under Full Keyboard Access (§2.18.6) — the `focus-ring` token, 2px.
public struct MetistryButtonStyle: ButtonStyle {
    let role: ControlSpec.Role

    public init(role: ControlSpec.Role) {
        self.role = role
    }

    public func makeBody(configuration: Configuration) -> some View {
        StyledLabel(configuration: configuration, role: role)
    }

    struct StyledLabel: View {
        @Environment(\.colorScheme) private var scheme
        @Environment(\.isEnabled) private var enabled
        @Environment(\.isFocused) private var focused
        let configuration: ButtonStyle.Configuration
        let role: ControlSpec.Role

        var body: some View {
            let p = Palette(scheme)
            let shape = RoundedRectangle(cornerRadius: MetistryRadius.sm, style: .continuous)
            configuration.label
                .metistryFont(.body, weight: role == .plain ? nil : .medium)
                // A disabled control takes a dimmer ink at full opacity, never opacity (C63).
                .foregroundStyle(p[ink])
                .padding(.horizontal, role == .plain ? MetistrySpace.s1 : MetistrySpace.s3)
                .padding(.vertical, role == .plain ? 2 : MetistrySpace.s1 + 1)
                .background(fill.map { p[$0] } ?? .clear, in: shape)
                .overlay(shape.strokeBorder(role == .secondary ? p[.borderControl] : .clear, lineWidth: 1))
                .overlay(shape.inset(by: -3).strokeBorder(focused ? p[.focusRing] : .clear, lineWidth: 2))
                .contentShape(shape)
        }

        var ink: MetistryColorRole {
            guard enabled else { return .textTertiary }
            switch role {
            case .primary: return .onAccent
            case .destructive: return .onDestructive
            case .secondary: return .textPrimary
            case .plain: return .textSecondary
            }
        }

        var fill: MetistryColorRole? {
            guard enabled else { return nil }
            switch role {
            case .primary: return configuration.isPressed ? .accentHover : .accent
            case .destructive: return .destructive
            case .secondary, .plain: return nil
            }
        }
    }
}

// MARK: - Layouts

/// Chips that wrap onto the next line rather than widen the row: a facet row
/// at the largest text size grows longer, never wider (§2.18.5).
public struct FlowLayout: Layout {
    var spacing: CGFloat
    var lineSpacing: CGFloat

    public init(spacing: CGFloat = MetistrySpace.s2, lineSpacing: CGFloat = MetistrySpace.s1) {
        self.spacing = spacing
        self.lineSpacing = lineSpacing
    }

    public func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(proposal.width ?? .infinity, subviews)
        let width = rows.map { $0.width }.max() ?? 0
        let height = rows.map(\.height).reduce(0, +) + lineSpacing * CGFloat(max(rows.count - 1, 0))
        return CGSize(width: width, height: height)
    }

    public func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(bounds.width, subviews) {
            var x = bounds.minX
            for item in row.items {
                subviews[item.index].place(at: CGPoint(x: x, y: y), anchor: .topLeading, proposal: ProposedViewSize(item.size))
                x += item.size.width + spacing
            }
            y += row.height + lineSpacing
        }
    }

    private struct Row {
        var items: [(index: Int, size: CGSize)] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func arrange(_ maxWidth: CGFloat, _ subviews: Subviews) -> [Row] {
        var rows: [Row] = []
        var row = Row()
        for (index, subview) in subviews.enumerated() {
            var size = subview.sizeThatFits(.unspecified)
            if size.width > maxWidth {
                // A piece wider than a whole line wraps its own words.
                size = subview.sizeThatFits(ProposedViewSize(width: maxWidth, height: nil))
            }
            let needed = row.items.isEmpty ? size.width : row.width + spacing + size.width
            if !row.items.isEmpty && needed > maxWidth {
                rows.append(row)
                row = Row()
            }
            row.width = row.items.isEmpty ? size.width : row.width + spacing + size.width
            row.height = max(row.height, size.height)
            row.items.append((index, size))
        }
        if !row.items.isEmpty { rows.append(row) }
        return rows
    }
}

/// Columns at fixed fractions of the width, so a table's cells line up from
/// row to row and wrap inside their column instead of widening it.
public struct ColumnsLayout: Layout {
    var fractions: [CGFloat]
    var spacing: CGFloat

    public init(_ fractions: [CGFloat], spacing: CGFloat = MetistrySpace.s3) {
        self.fractions = fractions
        self.spacing = spacing
    }

    private func widths(_ total: CGFloat, _ count: Int) -> [CGFloat] {
        let usable = max(total - spacing * CGFloat(max(count - 1, 0)), 0)
        let sum = fractions.prefix(count).reduce(0, +)
        return (0..<count).map { i in i < fractions.count && sum > 0 ? usable * fractions[i] / sum : 0 }
    }

    public func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let total = proposal.width, total.isFinite else {
            let ideal = subviews.map { $0.sizeThatFits(.unspecified) }
            return CGSize(width: ideal.map(\.width).reduce(0, +) + spacing * CGFloat(max(ideal.count - 1, 0)), height: ideal.map(\.height).max() ?? 0)
        }
        let w = widths(total, subviews.count)
        let height = subviews.enumerated().map { $0.element.sizeThatFits(ProposedViewSize(width: w[$0.offset], height: nil)).height }.max() ?? 0
        return CGSize(width: total, height: height)
    }

    public func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let w = widths(bounds.width, subviews.count)
        var x = bounds.minX
        for (i, subview) in subviews.enumerated() {
            subview.place(at: CGPoint(x: x, y: bounds.minY), anchor: .topLeading, proposal: ProposedViewSize(width: w[i], height: nil))
            x += w[i] + spacing
        }
    }
}

// MARK: - Contrast, on the ground actually painted

enum Contrast {
    /// WCAG 2 contrast between two roles in one scheme.
    static func ratio(_ ink: MetistryColorRole, _ ground: MetistryColorRole, _ scheme: ColorScheme) -> Double {
        let a = luminance(ink.components(scheme))
        let b = luminance(ground.components(scheme))
        return (max(a, b) + 0.05) / (min(a, b) + 0.05)
    }

    private static func luminance(_ c: (red: Double, green: Double, blue: Double, opacity: Double)) -> Double {
        func channel(_ v: Double) -> Double { v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
        return 0.2126 * channel(c.red) + 0.7152 * channel(c.green) + 0.0722 * channel(c.blue)
    }
}

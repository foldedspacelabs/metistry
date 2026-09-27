// Agent prose — one component (facets §7.3), two treatments (C69, amendments §6.2).
//
//   * `.rule` — inside a transcript: a 2px `agent` rule and no fill. The rule
//     hangs in the GUTTER, outside the measure, so the prose starts on the
//     user turn's own left edge and one number still governs the column; and
//     unlike a wash it survives a reply holding a table, a diff or a card.
//   * `.wash` — everywhere else agent text can be mistaken for the interface:
//     feed rows, card notes, a brief, calendar help. The `agent-quiet` ground.
//
// Either way the body is set in the serif (C32, C35) — you can tell the
// assistant wrote it before reading a word, and the face survives being
// quoted where the wash does not — the attribution is the configured name
// with the spark (C88), and every piece with a `prose_id` is rateable with the
// same two verbs Chat has (C33). Prose generated outside a fold says so:
// *written, not retrieved* (C103).

import SwiftUI

public struct AgentProseModel: Sendable, Equatable {
    public enum Treatment: String, Sendable {
        /// A transcript reply: the gutter rule, no fill.
        case rule
        /// Agent text anywhere else: the `agent-quiet` wash.
        case wash
    }

    public var treatment: Treatment
    public var author: AgentChipModel
    /// The words, verbatim — data, never case-corrected or styled as a control (P1).
    public var text: String
    public var at: Date?
    /// Generated rather than retrieved — the brief, Next Up's line, calendar help (C103).
    public var generated: Bool
    /// The stable id feedback is keyed by (`POST /api/prose/:id/feedback`). No id, no rating.
    public var proseID: String?
    public var rating: Rating?

    public init(treatment: Treatment, author: AgentChipModel, text: String, at: Date? = nil, generated: Bool = false, proseID: String? = nil, rating: Rating? = nil) {
        self.treatment = treatment
        self.author = author
        self.text = text
        self.at = at
        self.generated = generated
        self.proseID = proseID
        self.rating = rating
    }

    /// What pressing a rating does: rates, or — pressing the lit one — clears (nil), as Chat does.
    public func rating(afterPressing pressed: Rating) -> Rating? {
        rating == pressed ? nil : pressed
    }

    /// The label *written, not retrieved* says, once, in one place.
    public static let generatedNote = "written, not retrieved"

    public struct Presentation: Sendable, Equatable {
        public var treatment: Treatment
        /// The rule's ink, drawn in the gutter; nil for the wash.
        public var rule: MetistryColorRole?
        /// The wash; nil for the rule.
        public var wash: MetistryColorRole?
        public var attribution: [Mark]
        public var body: Mark
        public var controls: [ControlSpec]
        public var spoken: String
    }

    public func presentation(on container: MetistryColorRole, clock: ClockTime) -> Presentation {
        let ground: MetistryColorRole = treatment == .wash ? .agentQuiet : container
        var attribution = [
            Mark(author.label, glyph: .spark, style: .caption1, weight: .semibold, ink: .agent, on: ground, spoken: author.isAssistant ? author.label : "agent \(author.label)"),
        ]
        if let at { attribution.append(Mark(clock.time(at), style: .caption1, ink: .textSecondary, on: ground)) }
        if generated { attribution.append(Mark(Self.generatedNote, style: .caption1, ink: .textSecondary, on: ground)) }
        let controls: [ControlSpec] = proseID == nil ? [] : [
            ControlSpec("", glyph: .good, role: .plain, selected: rating == .up, name: "Good"),
            ControlSpec("", glyph: .bad, role: .plain, selected: rating == .down, name: "Bad"),
        ]
        let spoken = ([author.isAssistant ? "\(author.label) wrote" : "agent \(author.label) wrote"] + (generated ? [Self.generatedNote] : []) + [text]).joined(separator: ", ")
        return Presentation(
            treatment: treatment,
            rule: treatment == .rule ? .agent : nil,
            wash: treatment == .wash ? .agentQuiet : nil,
            attribution: attribution,
            body: Mark(text, style: .body, design: .serif, ink: .textPrimary, on: ground),
            controls: controls,
            spoken: spoken
        )
    }
}

public struct AgentProse: View {
    @Environment(\.colorScheme) private var scheme
    let model: AgentProseModel
    let ground: MetistryColorRole
    let clock: ClockTime
    let onRate: ((Rating?) -> Void)?

    /// `onRate` gets the new rating — nil when the lit one is pressed again, which clears it.
    public init(_ model: AgentProseModel, on ground: MetistryColorRole = .surface, clock: ClockTime = ClockTime(), onRate: ((Rating?) -> Void)? = nil) {
        self.model = model
        self.ground = ground
        self.clock = clock
        self.onRate = onRate
    }

    /// The gutter the rule hangs in: the rule plus its gap.
    public static let gutter: CGFloat = 2 + MetistrySpace.s3

    public var body: some View {
        let p = Palette(scheme)
        let view = model.presentation(on: ground, clock: clock)
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                FlowLayout(spacing: MetistrySpace.s2) {
                    ForEach(Array(view.attribution.enumerated()), id: \.offset) { MarkView($0.element) }
                }
                Spacer(minLength: 0)
                if onRate != nil {
                    ForEach(Array(view.controls.enumerated()), id: \.offset) { item in
                        ControlButton(item.element) { rate(item.offset == 0 ? .up : .down) }
                    }
                }
            }
            Text(verbatim: model.text)
                .metistryFont(.body, design: .serif)
                .foregroundStyle(p[.textPrimary])
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
        .padding(view.wash == nil ? 0 : MetistrySpace.s3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(view.wash.map { p[$0] } ?? .clear, in: RoundedRectangle(cornerRadius: MetistryRadius.md, style: .continuous))
        .overlay(alignment: .leading) {
            if let rule = view.rule {
                Rectangle().fill(p[rule]).frame(width: 2).offset(x: -Self.gutter)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(verbatim: view.spoken))
    }

    private func rate(_ pressed: Rating) {
        onRate?(model.rating(afterPressing: pressed))
    }
}

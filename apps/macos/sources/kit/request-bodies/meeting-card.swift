// The meeting card (screen 3 §10.3; §2.12): one card over a meeting's parts,
// its to-dos as the body, and Accept All · Decline All — each held ten seconds
// behind Undo, then one answer per part, in order (meeting-group.swift). The
// outcome is a band that counts: *4 of 5 accepted. One was already answered
// elsewhere.* — colour on the glyph, the words in `text-primary` (§3.1).

import SwiftUI

public struct MeetingCardPresentation: Sendable, Equatable {
    public var header: [Mark]
    public var ask: Mark
    public var body: RequestBodyPresentation
    /// Each part's own receipt, as it lands.
    public var receipts: [Mark]
    /// Accept All, the one filled button, then Decline All, outlined (C92).
    public var controls: [GroupControl]
    /// Nothing sent yet, Undo open.
    public var undo: UndoWindow?
    /// *Sending 2 of 5* — a count, not a spinner.
    public var progress: Mark?
    public var outcome: [Mark]
    public var retry: ControlSpec?
    public var facts: [Mark]

    public struct GroupControl: Sendable, Equatable {
        public var verb: GroupVerb
        public var control: ControlSpec
    }
}

@MainActor
public enum MeetingCard {
    public static func presentation(
        _ model: GroupAnswering,
        assistantName: String,
        allowsDecisions: Bool,
        on ground: MetistryColorRole = .surface,
        today: TaskDay,
        now: Date,
        clock: ClockTime
    ) -> MeetingCardPresentation {
        let group = model.group
        let shape = RequestShape.meeting
        var header = [Mark(shape.word, style: .caption2, ink: .textSecondary, on: ground, uppercase: true)]
        if let agent = group.parts.first?.sourceAgent {
            header.append(AgentChipModel(agentID: agent, assistantName: assistantName).mark(on: ground))
        }
        if let first = group.parts.first.flatMap({ WireTime.date($0.ts) }) {
            header.append(Mark(ClockTime.age(now.timeIntervalSince(first)), style: .caption1, ink: .textSecondary, on: ground))
        }
        let ask = Mark(group.title(assistantName: assistantName), style: .headline, ink: .textPrimary, on: ground)
        let body = RequestBodyBlock.todos(group.todos(assistantName: assistantName)).presentation(on: ground, today: today, now: now, clock: clock)

        let receipts: [Mark] = group.parts.compactMap { part in
            guard let outcome = model.outcomes[part.id] else { return nil }
            let what = RequestReading(part, assistantName: assistantName).ask
            switch outcome {
            case .applied(let r), .alreadyAnswered(let r):
                return Mark("\(what): \(r.text)", glyph: r.glyph, glyphInk: .textSecondary, style: .subhead, ink: .textPrimary, on: ground)
            case .stale:
                return Mark("\(what): changed while this was open, so nothing was sent", glyph: .stale, glyphInk: .stale, style: .subhead, ink: .textPrimary, on: ground)
            case .refused(let why):
                return Mark("\(what): \(why)", glyph: .failed, glyphInk: .failed, style: .subhead, ink: .textPrimary, on: ground, spoken: "failed. \(what): \(why)")
            case .held:
                return Mark("\(what): not sent", glyph: .lock, glyphInk: .stale, style: .subhead, ink: .textPrimary, on: ground)
            }
        }

        let unreachable = allowsDecisions ? nil : StateWords.unreachable
        var controls: [MeetingCardPresentation.GroupControl] = []
        var undo: UndoWindow?
        var progress: Mark?
        var outcome: [Mark] = []
        var retry: ControlSpec?
        switch model.phase {
        case .holding(_, let window):
            undo = window
        case .sending(let verb, let done, let of):
            progress = Mark("\(verb.doing) \(done + 1 > of ? of : done + 1) of \(of)", style: .subhead, ink: .textSecondary, on: ground)
        case .open, .done:
            for verb in [GroupVerb.acceptAll, .declineAll] where !model.reach(verb).isEmpty {
                let answer = verb == .acceptAll ? shape.primary : shape.decline
                controls.append(.init(verb: verb, control: ControlSpec(answer?.label ?? "", glyph: verb == .acceptAll ? .approve : .decline, role: verb == .acceptAll ? .primary : .secondary, disabledBecause: unreachable)))
            }
            if case .done(let result) = model.phase {
                let glyph: MetistryGlyph = result.isPartial ? .degraded : (result.verb == .acceptAll ? .approve : .decline)
                outcome.append(Mark(result.headline, glyph: glyph, glyphInk: result.isPartial ? .degraded : .textSecondary, style: .subhead, weight: .semibold, ink: .textPrimary, on: ground, spoken: result.isPartial ? "partial. \(result.headline)" : result.headline))
                if let why = result.explanation { outcome.append(Mark(why, style: .subhead, ink: .textPrimary, on: ground)) }
                let n = result.retryable.count
                if n > 0 { retry = ControlSpec(StateWords.tryAgain, role: .secondary, disabledBecause: unreachable, name: "Try again, \(n) \(n == 1 ? "part" : "parts")") }
            }
        }
        let facts = unreachable.map { [FactNoteModel($0).mark(on: ground)] } ?? []
        return MeetingCardPresentation(header: header, ask: ask, body: body, receipts: receipts, controls: controls, undo: undo, progress: progress, outcome: outcome, retry: retry, facts: facts)
    }
}

public struct MeetingCardView: View {
    @Environment(\.colorScheme) private var scheme
    let model: GroupAnswering
    let assistantName: String
    let allowsDecisions: Bool
    let today: TaskDay
    let now: Date
    let clock: ClockTime
    let ground: MetistryColorRole

    public init(_ model: GroupAnswering, assistantName: String, allowsDecisions: Bool, today: TaskDay, now: Date = Date(), clock: ClockTime = ClockTime(), on ground: MetistryColorRole = .surface) {
        self.model = model
        self.assistantName = assistantName
        self.allowsDecisions = allowsDecisions
        self.today = today
        self.now = now
        self.clock = clock
        self.ground = ground
    }

    public var body: some View {
        let p = Palette(scheme)
        let view = MeetingCard.presentation(model, assistantName: assistantName, allowsDecisions: allowsDecisions, on: ground, today: today, now: now, clock: clock)
        VStack(alignment: .leading, spacing: MetistrySpace.s3) {
            FlowLayout(spacing: MetistrySpace.s2) {
                ForEach(Array(view.header.enumerated()), id: \.offset) { MarkView($0.element) }
            }
            MarkView(view.ask).accessibilityAddTraits(.isHeader)
            RequestBodyView(.todos(model.group.todos(assistantName: assistantName)), on: ground, today: today, now: now, clock: clock)
            ForEach(Array(view.receipts.enumerated()), id: \.offset) { MarkView($0.element) }
            ForEach(Array(view.outcome.enumerated()), id: \.offset) { MarkView($0.element) }
            if let retry = view.retry {
                ControlButton(retry) { Task { await model.retry() } }
            }
            if let progress = view.progress { MarkView(progress) }
            if let undo = view.undo {
                UndoBar(undo, on: .elevated) { model.undo() }
            }
            FlowLayout(spacing: MetistrySpace.s2) {
                ForEach(Array(view.controls.enumerated()), id: \.offset) { item in
                    ControlButton(item.element.control) { model.start(item.element.verb) }
                        .disabled(model.isBusy)
                }
            }
            ForEach(Array(view.facts.enumerated()), id: \.offset) { MarkView($0.element) }
        }
        .padding(MetistrySpace.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(p[ground], in: RoundedRectangle(cornerRadius: MetistryRadius.md, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: MetistryRadius.md, style: .continuous).strokeBorder(p[.border], lineWidth: 1))
        .accessibilityElement(children: .contain)
    }
}

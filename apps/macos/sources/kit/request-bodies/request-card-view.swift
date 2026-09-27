// The request card, drawn: request-card.swift decides every word and control;
// this draws them and routes each gesture to `RequestAnswering`.
//
// §2.18, for this view:
//
//   * Keyboard. The Item menu's Approve · Revise · Decline · Later (A R D L)
//     answer the selected request — `RequestAnswering.itemActions`, which the
//     list hands the shell for its selection; the shell attaches the single
//     keys only while a list has focus. 1–9 choose an
//     answer on a question and ⌘↩ sends answers (components-02 §1); Return in
//     a text field is a new line, never a send.
//   * VoiceOver. The ask is the card's heading; each answer says its name,
//     Later says *Later, L*, Send Answers says how many questions are left;
//     agent words carry their prefix (components-01 §2.8).
//   * Reduce Motion. The next question cross-fades instead of sliding (C122).
//   * The largest text. Answers wrap onto a second line rather than widen the
//     card; nothing is truncated or line-limited.
//   * Full Keyboard Access. The question block takes the accent focus ring.

import SwiftUI

/// How the next question arrives (§13.2; C122).
public enum QuestionMotion {
    public enum Kind: Sendable, Equatable { case slide, crossFade }

    public static func kind(reduceMotion: Bool) -> Kind { reduceMotion ? .crossFade : .slide }

    static func transition(reduceMotion: Bool) -> AnyTransition {
        switch kind(reduceMotion: reduceMotion) {
        case .crossFade: return .opacity
        case .slide: return .asymmetric(insertion: .move(edge: .trailing).combined(with: .opacity), removal: .move(edge: .leading).combined(with: .opacity))
        }
    }

    static let animation = Animation.easeInOut(duration: 0.2)
}

public struct RequestCardView: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Bindable var model: RequestAnswering
    let allowsDecisions: Bool
    let today: TaskDay
    let now: Date
    let clock: ClockTime
    let ground: MetistryColorRole
    @FocusState private var fieldFocused: Bool
    @FocusState private var choicesFocused: Bool

    /// `allowsDecisions` is O3's — `ConsoleSession.allowsDecisions`. The gate
    /// refuses a decision anyway; this is the control saying so first.
    public init(_ model: RequestAnswering, allowsDecisions: Bool, today: TaskDay, now: Date = Date(), clock: ClockTime = ClockTime(), on ground: MetistryColorRole = .surface) {
        self.model = model
        self.allowsDecisions = allowsDecisions
        self.today = today
        self.now = now
        self.clock = clock
        self.ground = ground
    }

    public var body: some View {
        let p = Palette(scheme)
        let view = RequestCard.presentation(model, allowsDecisions: allowsDecisions, on: ground, today: today, now: now, clock: clock)
        VStack(alignment: .leading, spacing: MetistrySpace.s3) {
            FlowLayout(spacing: MetistrySpace.s2) {
                ForEach(Array(view.header.enumerated()), id: \.offset) { MarkView($0.element) }
            }
            MarkView(view.ask).accessibilityAddTraits(.isHeader)
            if let receipt = view.receipt {
                MarkView(receipt)
            } else {
                content(view, p)
            }
        }
        .padding(MetistrySpace.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(p[ground], in: RoundedRectangle(cornerRadius: MetistryRadius.md, style: .continuous))
        // A repainted card keeps its border in `stale` (components-01 §2.5).
        .overlay(RoundedRectangle(cornerRadius: MetistryRadius.md, style: .continuous).strokeBorder(p[model.repainted ? .stale : .border], lineWidth: 1))
        .accessibilityElement(children: .contain)
    }

    // MARK: - The parts under the ask

    @ViewBuilder
    private func content(_ view: RequestCardPresentation, _ p: Palette) -> some View {
        if let context = view.context {
            AgentProse(context, on: ground, clock: clock)
        }
        if let holds = view.holds { MarkView(holds) }
        if !view.refs.isEmpty {
            FlowLayout(spacing: MetistrySpace.s2) {
                ForEach(Array(view.refs.enumerated()), id: \.offset) { MarkView($0.element) }
            }
        }
        ForEach(Array(view.notices.enumerated()), id: \.offset) { MarkView($0.element) }
        if let reason = view.reason { MarkView(reason).textSelection(.enabled) }

        body(view, p)

        if let partial = view.partial { MarkView(partial) }
        ForEach(Array(view.notes.enumerated()), id: \.offset) { MarkView($0.element) }
        if let composer = view.composer { self.composer(composer) }
        if let remaining = view.remaining { MarkView(remaining) }
        answers(view)
        ForEach(Array(view.facts.enumerated()), id: \.offset) { MarkView($0.element) }
    }

    // MARK: - The body

    @ViewBuilder
    private func body(_ view: RequestCardPresentation, _ p: Palette) -> some View {
        if let steps = view.steps {
            HStack(spacing: MetistrySpace.s1) {
                ForEach(Array(steps.segments.enumerated()), id: \.offset) { item in
                    Capsule()
                        .fill(p[item.element.answered ? .accent : .sunken])
                        .overlay(Capsule().strokeBorder(item.element.showing ? p[.focusRing] : .clear, lineWidth: 1.5))
                        .frame(height: 4)
                }
            }
            // *Question 2 of 3* says it; the bar is the same fact drawn.
            .accessibilityHidden(true)
        }
        if let summary = view.steps?.summary {
            VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                MarkView(Mark("Your Answers", style: .caption2, ink: .textSecondary, on: ground, uppercase: true)).accessibilityAddTraits(.isHeader)
                ForEach(summary, id: \.index) { row in
                    HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s3) {
                        VStack(alignment: .leading, spacing: 2) {
                            MarkView(row.question)
                            MarkView(row.answer)
                        }
                        Spacer(minLength: 0)
                        ControlButton(row.edit) { model.steps?.edit(row.index) }
                    }
                }
            }
            .transition(QuestionMotion.transition(reduceMotion: reduceMotion))
        } else if let body = view.body {
            if case .choices = body.kind, let choices = model.steps?.body() {
                RequestBodyView(.choices(choices), on: ground, today: today, now: now, clock: clock) { event in
                    handle(event)
                }
                .id(model.steps?.step ?? 0)
                .transition(QuestionMotion.transition(reduceMotion: reduceMotion))
                .focusable()
                .focused($choicesFocused)
                .focusEffectDisabled()
                .overlay(RoundedRectangle(cornerRadius: MetistryRadius.sm, style: .continuous).inset(by: -3).strokeBorder(choicesFocused ? p[.focusRing] : .clear, lineWidth: 2))
                .onKeyPress(characters: .decimalDigits, phases: .down) { press in
                    guard let n = Int(press.characters), n >= 1 else { return .ignored }
                    Task { await model.choose(n - 1) }
                    return .handled
                }
            } else if let block = model.expandable {
                RequestBodyView(block, on: ground, today: today, now: now, clock: clock) { event in
                    if event == .toggleExpanded { model.expanded.toggle() }
                }
            }
        }
    }

    private func handle(_ event: RequestBodyEvent) {
        switch event {
        case .choose(let index):
            Task { await model.choose(index) }
        case .other(let text):
            model.steps?.type(text)
        case .toggleExpanded:
            break
        }
    }

    // MARK: - The words an answer carries

    @ViewBuilder
    private func composer(_ c: RequestCardPresentation.ComposerPresentation) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            switch c.field {
            case .words(let placeholder):
                // The prompt is the field's name as VoiceOver reads it on the Mac:
                // SwiftUI (macOS 26) does not carry `.accessibilityLabel` or a
                // title onto the AppKit field, and an empty field says its
                // prompt. The label is kept for the platforms that do read it.
                TextField(text: $model.words, prompt: Text(verbatim: placeholder), axis: .vertical) { Text(verbatim: "Your words") }
                    .labelsHidden()
                    .metistryFont(.body)
                    .textFieldStyle(.roundedBorder)
                    .focused($fieldFocused)
            case .area(let prefix):
                HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s1) {
                    MarkView(prefix)
                    TextField(text: $model.areaTail, prompt: Text(verbatim: "Folder to grant instead")) { Text(verbatim: "Folder to grant instead") }
                        .labelsHidden()
                        .metistryFont(.body, design: .mono)
                        .textFieldStyle(.roundedBorder)
                        .focused($fieldFocused)
                }
            }
            if let rule = c.rule { MarkView(rule) }
            if let problem = c.problem { MarkView(problem) }
            FlowLayout(spacing: MetistrySpace.s2) {
                ControlButton(c.send) { Task { await model.press(c.slot) } }
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(model.isDeciding)
                ControlButton(c.cancel) { model.cancelComposing() }
                    .keyboardShortcut(.cancelAction)
            }
        }
        .onAppear { fieldFocused = true }
    }

    // MARK: - The answers

    private func answers(_ view: RequestCardPresentation) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
            FlowLayout(spacing: MetistrySpace.s2) {
                ForEach(Array(view.answers.enumerated()), id: \.offset) { item in
                    answerButton(item.element)
                }
            }
            Spacer(minLength: 0)
            if let later = view.later {
                ControlButton(later) { Task { await model.later() } }
                    .disabled(model.isDeciding)
            }
        }
        // Deciding: the row itself is the working state — disabled, nothing spins.
    }

    @ViewBuilder
    private func answerButton(_ answer: RequestCardPresentation.Answer) -> some View {
        let button = ControlButton(answer.control) { perform(answer.action) }
            .disabled(model.isDeciding)
            .accessibilityHint(Text(verbatim: answer.control.disabledBecause ?? ""))
        if answer.action == .send {
            button.keyboardShortcut(.return, modifiers: .command)
        } else {
            button
        }
    }

    private func perform(_ action: RequestCardPresentation.Answer.Action) {
        switch action {
        case .back:
            withAnimation(QuestionMotion.animation) { model.steps?.back() }
        case .next:
            withAnimation(QuestionMotion.animation) { model.steps?.next() }
        case .send:
            Task { await model.press(.primary) }
        case .slot(let slot):
            Task { await model.press(slot) }
        }
    }
}

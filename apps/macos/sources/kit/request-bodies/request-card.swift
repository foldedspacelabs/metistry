// One request, as the Needs You detail draws it: screen 3 §12.2's five parts
// — header · the ask · context · ONE body · answers — and the states the card
// can be in (components-01 §2.5).
//
// A PRESENTATION, THEN A VIEW (components/component-kit.swift). Every word
// and control the card draws is decided here, as `Mark`s and `ControlSpec`s,
// where a test can read it, dump it in light, dark and the largest text, and
// check each ink against the ground it sits on. request-card-view.swift only
// draws this.
//
// THE ANSWERS (C92; components-01 §2.4). The type's primary verb is the one
// filled accent button; Revise and Decline are outlined, in that order; then
// the spacer, then Later as a glyph that says its name and its key. Approve
// keeps its check and Decline its cross, so the pair survives greyscale. A
// control off because of a FACT says the fact under itself — the instance is
// unreachable (O3), this build cannot reach that door — and one off because
// of the owner's own state (an in-flight answer) carries no line; the one
// exception is Send Answers, whose count of what is left is the design's own
// line (§12.3).

import Foundation

public struct RequestCardPresentation: Sendable, Equatable {
    /// type · who asked · provenance · age.
    public var header: [Mark]
    public var ask: Mark
    /// The asker's own words, on the wash.
    public var context: AgentProseModel?
    public var contextPresentation: AgentProseModel.Presentation?
    /// Access: what the credential holds now, as `describeScope` said it.
    public var holds: Mark?
    public var refs: [Mark]
    /// The stale repaint's sentence, a refusal, a failed consequence (C45), O3's hold.
    public var notices: [Mark]
    /// The refusal's own words, verbatim.
    public var reason: Mark?
    public var body: RequestBodyPresentation?
    /// Question steps: the segmented bar, and Your Answers.
    public var steps: StepsPresentation?
    public var partial: Mark?
    public var notes: [Mark]
    public var composer: ComposerPresentation?
    /// *1 question unanswered* — above Send Answers while it is dimmed (§12.3).
    public var remaining: Mark?
    /// The answers, in order: primary · Revise · Decline — then Later.
    public var answers: [Answer]
    public var later: ControlSpec?
    /// The facts that turned controls off, once each.
    public var facts: [Mark]
    /// Settled: the one line the card collapses to.
    public var receipt: Mark?
    public var spoken: String

    public struct Answer: Sendable, Equatable {
        public enum Action: Sendable, Equatable {
            case slot(RequestAnswerSlot)
            case back, next, send
        }

        public var control: ControlSpec
        public var action: Action
    }

    public struct StepsPresentation: Sendable, Equatable {
        /// One per question: answered, and the one showing.
        public var segments: [(answered: Bool, showing: Bool)]
        /// Your Answers, when it is the showing step.
        public var summary: [SummaryRow]?

        public static func == (a: StepsPresentation, b: StepsPresentation) -> Bool {
            a.segments.map(\.answered) == b.segments.map(\.answered) && a.segments.map(\.showing) == b.segments.map(\.showing) && a.summary == b.summary
        }
    }

    public struct SummaryRow: Sendable, Equatable {
        public var index: Int
        public var question: Mark
        public var answer: Mark
        public var edit: ControlSpec
    }

    public struct ComposerPresentation: Sendable, Equatable {
        public enum Field: Sendable, Equatable {
            /// Free words, with the field's own prompt.
            case words(placeholder: String)
            /// A folder under the asked area (C40) — the prefix is fixed text, not an edit.
            case area(prefix: Mark)
        }

        public var slot: RequestAnswerSlot
        public var field: Field
        public var send: ControlSpec
        public var cancel: ControlSpec
        /// C40's one line: Revise can only grant less.
        public var rule: Mark?
        public var problem: Mark?
    }
}

@MainActor
public enum RequestCard {
    /// The line a stale repaint puts above the current version (components-01 §2.5).
    nonisolated public static let staleNotice = "This moved while the card was open, so nothing was sent. The card below is the current version."

    public static func presentation(
        _ model: RequestAnswering,
        allowsDecisions: Bool,
        on ground: MetistryColorRole = .surface,
        today: TaskDay,
        now: Date,
        clock: ClockTime
    ) -> RequestCardPresentation {
        let reading = model.reading
        let shape = reading.shape

        // MARK: header · the ask
        var header = [Mark(shape.word, style: .caption2, ink: .textSecondary, on: ground, uppercase: true)]
        if let asker = reading.asker { header.append(asker.mark(on: ground)) }
        if let provenance = reading.provenance {
            header.append(Mark(provenance, style: .caption1, ink: .textSecondary, plate: .sunken, on: ground, shape: .chip))
        }
        let age = reading.submitted.map { ClockTime.age(now.timeIntervalSince($0)) }
        if let age { header.append(Mark(age, style: .caption1, ink: .textSecondary, on: ground)) }
        let ask = Mark(reading.ask, style: .headline, ink: .textPrimary, on: ground)
        let spoken = [
            [reading.asker.map { "\($0.spoken): \(shape.word)" } ?? shape.word, reading.ask].joined(separator: ", "),
            age.map { "\($0)" },
        ].compactMap { $0 }.joined(separator: ". ")

        // Settled: the card collapses to one line (components-01 §2.5).
        switch model.phase {
        case .settled(let receipt), .alreadyDecided(let receipt):
            let line = Mark(receipt.text, glyph: receipt.glyph, glyphInk: .textSecondary, style: .body, ink: .textPrimary, on: ground)
            return RequestCardPresentation(header: header, ask: ask, context: nil, contextPresentation: nil, holds: nil, refs: [], notices: [], reason: nil, body: nil, steps: nil, partial: nil, notes: [], composer: nil, remaining: nil, answers: [], later: nil, facts: [], receipt: line, spoken: "\(spoken). \(receipt.text)")
        default:
            break
        }

        // MARK: context
        let context = reading.context.flatMap { words in reading.asker.map { AgentProseModel(treatment: .wash, author: $0, text: words) } }
        let holds = reading.holds.map { Mark("Holds now: \($0)", style: .footnote, ink: .textSecondary, on: ground) }
        let refs = reading.refs.map { Mark($0, style: .caption1, design: .mono, ink: .textSecondary, plate: .sunken, on: ground, shape: .chip) }

        // MARK: notices — what went differently, in the console's words
        var notices: [Mark] = []
        var reason: Mark?
        if model.repainted {
            notices.append(Mark(staleNotice, glyph: .stale, glyphInk: .stale, style: .subhead, ink: .textPrimary, plate: .staleQuiet, on: ground, shape: .band, spoken: "stale. \(staleNotice)"))
        }
        switch model.phase {
        case .refused(let why):
            notices.append(Mark("That answer didn't go through — the request is still waiting", glyph: .failed, glyphInk: .failed, style: .subhead, ink: .textPrimary, on: ground, spoken: "failed. That answer didn't go through — the request is still waiting"))
            reason = Mark(why, style: .footnote, design: .mono, ink: .textPrimary, plate: .sunken, on: ground, shape: .band)
        case .held(let why):
            notices.append(Mark("Nothing was sent — \(why)", glyph: .lock, glyphInk: .stale, style: .subhead, ink: .textPrimary, on: ground))
        default:
            if let failure = reading.failure {
                // C45: a consequence that failed left the request pending, and says so.
                let when = failure.at.map { " · \(clock.moment($0, now: now))" } ?? ""
                let lead = "\(failure.lead) — it is still waiting\(when)"
                notices.append(Mark(lead, glyph: .failed, glyphInk: .failed, style: .subhead, ink: .textPrimary, on: ground, spoken: "failed. \(lead)"))
                reason = Mark(failure.message, style: .footnote, design: .mono, ink: .textPrimary, plate: .sunken, on: ground, shape: .band)
            }
        }

        // MARK: the body
        var body: RequestBodyPresentation?
        var steps: RequestCardPresentation.StepsPresentation?
        if let s = model.steps {
            let showing = s.isOnSummary ? nil : s.step
            var summary: [RequestCardPresentation.SummaryRow]?
            if s.isOnSummary {
                summary = s.summary.map { line in
                    RequestCardPresentation.SummaryRow(
                        index: line.index,
                        question: Mark(line.prompt, style: .subhead, ink: .textSecondary, on: ground, spoken: "Question \(line.index + 1). \(line.prompt)"),
                        answer: Mark(line.answer ?? "Not answered", style: .body, ink: line.answer == nil ? .textSecondary : .textPrimary, on: ground),
                        edit: ControlSpec("Edit", glyph: .edit, role: .plain, name: "Edit question \(line.index + 1)")
                    )
                }
                body = nil
            } else if let choices = s.body() {
                body = RequestBodyBlock.choices(choices).presentation(on: ground, today: today, now: now, clock: clock)
            }
            steps = s.isSingle && summary == nil ? nil : .init(segments: s.segments.enumerated().map { ($0.element, $0.offset == showing) }, summary: summary)
        } else if let block = model.expandable {
            body = block.presentation(on: ground, today: today, now: now, clock: clock)
        }
        let partial = reading.partial?.mark(on: ground)

        // MARK: the notes beside the answers
        let notes: [Mark] = reading.notes.map { note in
            switch note {
            case .trade(let words):
                return Mark(words, glyph: .degraded, style: .subhead, ink: .degraded, on: ground, spoken: "warning. \(words)")
            case .askedAgain(let declinedAt, _):
                let when = declinedAt.map { ", after you declined it \(clock.moment($0, now: now))" } ?? ""
                return Mark("Asked again", style: .caption1, ink: .textSecondary, plate: .sunken, on: ground, shape: .chip, spoken: "Asked again\(when)")
            case .makesTask(let words):
                return Mark(words, style: .subhead, ink: .textSecondary, on: ground)
            }
        }

        // MARK: the answers
        let unreachable = allowsDecisions ? nil : StateWords.unreachable
        let (answers, later) = Self.answers(model, allowsDecisions: allowsDecisions)
        let remaining = answers.contains { $0.action == .send } ? model.steps?.unansweredSentence.map { Mark($0, style: .footnote, ink: .textSecondary, on: ground) } : nil

        // MARK: the words an answer carries
        var composer: RequestCardPresentation.ComposerPresentation?
        if let slot = model.composing, let answer = shape.answer(slot) {
            let label = answer.label ?? "Send"
            let cancel = ControlSpec("Cancel", role: .plain)
            if answer.carrying == .area, let asked = model.askedArea {
                let granting = model.revisedArea ?? asked
                let leaf = granting.split(separator: "/").last.map(String.init) ?? granting
                composer = .init(
                    slot: slot,
                    field: .area(prefix: Mark("\(asked)/", style: .body, design: .mono, ink: .textSecondary, on: ground, spoken: "under \(asked)")),
                    send: ControlSpec("Approve \(leaf)", role: .secondary, disabledBecause: unreachable ?? model.areaProblem),
                    cancel: cancel,
                    rule: Mark("Revise can only grant less — \(asked) or a folder under it. To grant more, change its access on Agents.", style: .footnote, ink: .textSecondary, on: ground),
                    problem: model.areaProblem.map { Mark($0, glyph: .degraded, style: .footnote, ink: .degraded, on: ground) }
                )
            } else {
                let placeholder = slot == .revise ? (answer.isRequired ? "What should change?" : "What should change? Your words go back to whoever asked") : "Your reply"
                composer = .init(slot: slot, field: .words(placeholder: placeholder), send: ControlSpec(label, role: .secondary, disabledBecause: unreachable), cancel: cancel, rule: nil, problem: nil)
            }
        }

        // MARK: the facts, once each
        var facts: [String] = []
        for fact in (answers.map(\.control) + [later]).compactMap(\.disabledBecause) where !facts.contains(fact) {
            // Send Answers' count is its own line, above it (§12.3), not a fact about the system.
            if model.steps?.unansweredSentence == fact { continue }
            facts.append(fact)
        }

        return RequestCardPresentation(
            header: header, ask: ask,
            context: context, contextPresentation: context?.presentation(on: ground, clock: clock),
            holds: holds, refs: refs, notices: notices, reason: reason,
            body: body, steps: steps, partial: partial, notes: notes, composer: composer,
            remaining: remaining, answers: answers, later: later,
            facts: facts.map { FactNoteModel($0).mark(on: ground) },
            receipt: nil, spoken: spoken
        )
    }

    /// The answers in order — a question's Back and Next, then primary ·
    /// Revise · Decline — and Later. The card draws them; the Item menu offers
    /// the enabled ones (`RequestAnswering.itemActions`).
    static func answers(_ model: RequestAnswering, allowsDecisions: Bool) -> (answers: [RequestCardPresentation.Answer], later: ControlSpec) {
        let unreachable = allowsDecisions ? nil : StateWords.unreachable
        let shape = model.reading.shape
        var answers: [RequestCardPresentation.Answer] = []
        if let s = model.steps, !s.isSingle {
            if s.step > 0 { answers.append(.init(control: ControlSpec("Back", role: .plain), action: .back)) }
            if !s.isOnSummary { answers.append(.init(control: ControlSpec("Next", role: .secondary), action: .next)) }
        }
        for slot in RequestAnswerSlot.allCases {
            guard let answer = shape.answer(slot) else { continue }
            if let control = control(for: slot, answer, model: model, unreachable: unreachable) {
                answers.append(.init(control: control, action: slot == .primary && shape.bodyKind == .choices ? .send : .slot(slot)))
            }
        }
        let later = ControlSpec("", glyph: .later, role: .plain, shortcut: "L", disabledBecause: unreachable, name: "Later")
        return (answers, later)
    }

    /// One answer's control: its word, its weight, its glyph, and the fact that turns it off.
    static func control(for slot: RequestAnswerSlot, _ answer: RequestShape.Answer, model: RequestAnswering, unreachable: String?) -> ControlSpec? {
        // A report's act is named by what raised it; with none, there is no act to offer.
        guard let label = answer.label ?? (slot == .primary ? model.reading.act : nil) else { return nil }
        var glyph: MetistryGlyph?
        var fact = unreachable
        switch answer.send {
        case .decision(let d):
            switch (slot, d) {
            case (.primary, "allow"), (.primary, "accept_as_work"): glyph = .approve
            case (.revise, _): glyph = .edit
            case (.decline, "deny"), (.decline, "skip"): glyph = .decline
            default: break
            }
            if d == "answers" {
                // No questions arrived (the reading says so, as `partial`): nothing to send.
                guard slot == .primary, let s = model.steps else { return nil }
                // Send Answers: only on Your Answers — or on the one question
                // when choosing alone cannot send it (pick any, or *Something else…*).
                let single = s.isSingle && (s.current?.multi == true || s.current?.otherIndex.map { s.chosen[0].contains($0) } == true)
                guard s.isOnSummary || single else { return nil }
                return ControlSpec(label, role: .primary, disabledBecause: fact ?? s.unansweredSentence, name: "Send answers")
            }
            if !RequestAnswering.knownDecisions.contains(d) { return nil }
        case .door(let name):
            guard let door = RequestDoor(rawValue: name) else { return nil }
            if slot == .revise { glyph = .edit }
            if door == .delegate { glyph = .spark }
            fact = fact ?? model.doors.unavailable(door, row: model.row)
        }
        return ControlSpec(label, glyph: glyph, role: slot == .primary ? .primary : .secondary, disabledBecause: fact)
    }
}

extension RequestAnswering {
    /// The decisions this build knows how to send from a card (`REQUEST_DECISIONS`).
    static let knownDecisions: Set<String> = ["answers", "allow", "accept_as_work", "accept_with_changes", "deny", "skip"]

    /// The Item menu for this request (components-02 §1): Approve · Revise ·
    /// Decline · Later, each only while it can be pressed — for the list to
    /// hand the shell as the selection's actions (`NeedsYouView(rowActions:)`).
    /// Approve is the type's primary verb, whatever its word.
    public func itemActions(allowsDecisions: Bool) -> ShellActionTable {
        guard !isSettled, !isDeciding else { return [:] }
        let (answers, later) = RequestCard.answers(self, allowsDecisions: allowsDecisions)
        var table: ShellActionTable = [:]
        for answer in answers where answer.control.isEnabled {
            let slot: RequestAnswerSlot
            switch answer.action {
            case .slot(let s): slot = s
            case .send: slot = .primary
            case .back, .next: continue
            }
            let command: ShellCommand = slot == .primary ? .approve : slot == .revise ? .revise : .decline
            table[command] = { [weak self] in Task { await self?.press(slot) } }
        }
        if later.isEnabled { table[.later] = { [weak self] in Task { await self?.later() } } }
        return table
    }
}

/// One `RequestAnswering` per request, so the detail and the Item menu act on
/// the same card — and a card keeps what the owner typed while the list
/// refreshes around it. A row that moved meanwhile is the `409` repaint's
/// business, not a reason to throw the draft away.
@MainActor
public final class RequestCards {
    private var byID: [Int: RequestAnswering] = [:]
    private let store: any NeedsYouStore
    private let doors: any RequestDoorHandling
    private let assistantName: String

    public init(store: any NeedsYouStore, doors: any RequestDoorHandling = UnwiredRequestDoors(), assistantName: String) {
        self.store = store
        self.doors = doors
        self.assistantName = assistantName
    }

    public func card(for row: RequestRow) -> RequestAnswering {
        if let card = byID[row.id] { return card }
        let card = RequestAnswering(row, store: store, doors: doors, assistantName: assistantName)
        byID[row.id] = card
        return card
    }

    /// Let go of the cards for requests no longer in the queue.
    public func keep(only ids: Set<Int>) {
        byID = byID.filter { ids.contains($0.key) }
    }
}

// A question, one step at a time (screen 3 §13.2; C105; components-02 §3).
//
//   * One question fills the card, with a segmented bar and *Question 2 of 3*.
//     Number keys choose; Next brings the next; Back is always there.
//   * The last step, **Your Answers**, lists each answer with **Edit**, and
//     **Send Answers** (⌘↩) sends them together — one reply to the asker, not
//     three. It fills only when every question has an answer, and the count
//     beside it says how many are left.
//   * A single-question request skips the summary: choosing sends.
//   * Every question ends in *Something else…* — an answer in the owner's own
//     words, sent as that question's answer — unless the asker said it can
//     take nothing but its options (T2-3's `allow_other: false`).
//
// This is a value: what is chosen and typed on each step, and which step is
// showing. The card draws it (request-card-view.swift); `RequestAnswering`
// sends what it builds. Nothing here reaches the console.
//
// TWO PAYLOADS. The question every console to date stores is v1 — one
// `title`, two to eight `options` (packages/core/src/decision-block.ts) —
// answered with the chosen option AS the decision (`{"decision": "<option>"}`,
// the T2-3 fixture). v2 — `questions: [{prompt, options, multi,
// allow_other}]`, several per request — is T2-3's, answered with
// `{"decision": "answers", "answers": [...]}` (F-5 `answers`). A v1 question
// answered in the owner's own words has only the second form to travel in.

import Foundation

/// One question as the asker put it.
public struct RequestQuestion: Sendable, Equatable {
    public let prompt: String
    public let options: [String]
    /// Pick any, rather than pick one.
    public let multi: Bool
    public let allowsOther: Bool

    public init(prompt: String, options: [String], multi: Bool = false, allowsOther: Bool = true) {
        self.prompt = prompt
        self.options = options
        self.multi = multi
        self.allowsOther = allowsOther
    }

    /// *Something else…*'s index, when it is offered.
    public var otherIndex: Int? { allowsOther ? options.count : nil }
}

public struct QuestionSteps: Sendable, Equatable {
    public let questions: [RequestQuestion]
    /// The v1 payload: one question whose option is sent as the decision itself.
    public let optionIsTheDecision: Bool
    /// `0 ..< questions.count` a question; `questions.count` the summary (several questions only).
    public private(set) var step: Int
    public private(set) var chosen: [Set<Int>]
    public private(set) var other: [String]

    public init(questions: [RequestQuestion], optionIsTheDecision: Bool = false) {
        self.questions = questions
        self.optionIsTheDecision = optionIsTheDecision && questions.count == 1
        self.step = 0
        self.chosen = Array(repeating: [], count: questions.count)
        self.other = Array(repeating: "", count: questions.count)
    }

    /// The questions a request asks: **`request.questions`** (ruling 26,
    /// X-22) — core's own `questionsOf` reading of the row, v2's several
    /// questions or a row from before v2 read as its one pick-one question —
    /// never re-derived from `payload` here. Only a console old enough to
    /// send no `request` at all (pre-X-5, `requestQuestions` nil) falls back
    /// to reading v1's `title` and `options` straight off the payload. Nil
    /// when neither carries a question.
    public init?(payload: JSONValue?, requestQuestions: JSONValue? = nil) {
        if let v2 = requestQuestions?.arrayValue {
            let questions = v2.compactMap { q -> RequestQuestion? in
                guard let prompt = q.string("prompt", "title") else { return nil }
                return RequestQuestion(
                    prompt: prompt,
                    options: q["options"]?.arrayValue?.compactMap(\.stringValue) ?? [],
                    multi: q.bool("multi") ?? false,
                    allowsOther: q.bool("allow_other") ?? true
                )
            }
            guard !questions.isEmpty else { return nil }
            // v1's wire (the option itself as `decision`) still answers a row
            // the console stores under v1's shape alone — `payload.questions`
            // absent — asking exactly one pick-one question (checked below,
            // in the struct's own `init`).
            self.init(questions: questions, optionIsTheDecision: payload?["questions"] == nil)
            return
        }
        guard let title = payload?.string("title") else { return nil }
        let options = payload?["options"]?.arrayValue?.compactMap(\.stringValue) ?? []
        self.init(questions: [RequestQuestion(prompt: title, options: options)], optionIsTheDecision: true)
    }

    // MARK: - Where it stands

    public var isSingle: Bool { questions.count == 1 }
    /// Several questions end on Your Answers; one does not (§13.2).
    public var isOnSummary: Bool { !isSingle && step == questions.count }
    public var current: RequestQuestion? { step < questions.count ? questions[step] : nil }

    public func isAnswered(_ index: Int) -> Bool {
        guard questions.indices.contains(index) else { return false }
        return answer(for: index).isAnswered
    }

    public var unanswered: Int { questions.indices.filter { !isAnswered($0) }.count }
    public var canSend: Bool { unanswered == 0 }

    /// *1 question unanswered* — what Send Answers says while it is dimmed (components-02 §3).
    public var unansweredSentence: String? {
        switch unanswered {
        case 0: return nil
        case 1: return "1 question unanswered"
        default: return "\(unanswered) questions unanswered"
        }
    }

    // MARK: - What the owner does

    /// Choose (pick one) or toggle (pick any) option `index` on the showing
    /// step; `options.count` is *Something else…*. Returns true when choosing
    /// IS sending: one question, pick one, a real option (§13.2).
    @discardableResult
    public mutating func choose(_ index: Int) -> Bool {
        guard let q = current else { return false }
        let limit = q.options.count + (q.allowsOther ? 1 : 0)
        guard index >= 0, index < limit else { return false }
        if q.multi {
            if chosen[step].contains(index) { chosen[step].remove(index) } else { chosen[step].insert(index) }
            return false
        }
        chosen[step] = [index]
        return isSingle && index < q.options.count
    }

    /// The owner's words for *Something else…* on the showing step.
    public mutating func type(_ text: String) {
        guard current != nil else { return }
        other[step] = text
    }

    public mutating func next() {
        step = min(step + 1, isSingle ? 0 : questions.count)
    }

    public mutating func back() {
        step = max(step - 1, 0)
    }

    /// From Your Answers, back to one question.
    public mutating func edit(_ index: Int) {
        guard questions.indices.contains(index) else { return }
        step = index
    }

    /// Keep what was chosen when a repaint brings back the same questions —
    /// and nothing when they changed, since an answer to a different question
    /// is not an answer to this one.
    public mutating func carry(from old: QuestionSteps) {
        guard old.questions == questions else { return }
        chosen = old.chosen
        other = old.other
        step = min(old.step, isSingle ? 0 : questions.count)
    }

    // MARK: - What it sends

    public func answer(for index: Int) -> QuestionAnswer {
        let q = questions[index]
        let picked = chosen[index].filter { $0 < q.options.count }.sorted().map { q.options[$0] }
        let typing = q.otherIndex.map { chosen[index].contains($0) } ?? false
        return QuestionAnswer(choices: picked, other: typing ? other[index] : nil)
    }

    /// Send Answers' answer — nil until every question has one. A v1
    /// question answered with one of its own options sends that option as
    /// the decision, the form every console to date accepts; anything else
    /// is one answer per question.
    public var answer: RequestAnswer? {
        guard canSend else { return nil }
        let all = questions.indices.map { answer(for: $0) }
        if optionIsTheDecision, let only = all.first, only.other == nil, only.choices.count == 1 {
            return .option(only.choices[0])
        }
        return .answers(all)
    }

    // MARK: - What it draws

    /// The showing question as T5-3's choices block. Nil on the summary.
    public func body() -> ChoicesBody? {
        guard let q = current else { return nil }
        return ChoicesBody(prompt: q.prompt, options: q.options, multi: q.multi, step: step + 1, of: questions.count, chosen: chosen[step], other: other[step], allowsOther: q.allowsOther)
    }

    /// One line of Your Answers.
    public struct SummaryLine: Sendable, Equatable {
        public let index: Int
        public let prompt: String
        /// The options chosen, then the owner's words in quotes; nil when unanswered.
        public let answer: String?
    }

    public var summary: [SummaryLine] {
        questions.indices.map { i in
            let a = answer(for: i)
            var parts = a.choices
            if let words = a.other?.trimmingCharacters(in: .whitespacesAndNewlines), !words.isEmpty { parts.append("“\(words)”") }
            return SummaryLine(index: i, prompt: questions[i].prompt, answer: a.isAnswered ? parts.joined(separator: ", ") : nil)
        }
    }

    /// The segmented bar: one segment per question, answered or not.
    public var segments: [Bool] { questions.indices.map(isAnswered) }
}

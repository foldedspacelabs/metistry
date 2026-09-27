// The request body blocks — screen 3 §12.2's closed set: every request is
// header · the ask · context · ONE body · answers, and the body is exactly
// one of seven blocks. A new request type picks a block (packages/core/src/
// requests.ts, `REQUEST_BODIES` and the type table), so a new type renders
// without new UI. This file is the seven blocks; which type draws which, and
// the answers under them, are the Needs You view's (T5-4b).
//
//     choices       one question at a time, and every one ends in
//                   *Something else…* — an answer in the owner's words (C105)
//     diff          collapsed to a summary and two counts; expands in place to
//                   added and removed lines — `ok` and `failed` doing the one
//                   other job they have, marked + and − so colour never
//                   carries it alone (screen 5 §14.2)
//     thread        the lines under discussion, then the conversation
//     before_after  the change FIRST, the total behind a disclosure
//                   (components-01 §2.3) — or two versions side by side
//     preview       what the affirming answer would do; an agent's own words
//                   on the wash, never unseen (screen 3 §11)
//     todos         proposed to-dos with their facets — no checkbox: nothing
//                   is a task until the answer makes it one
//     excerpt       a quoted passage, its source, and for a failure both
//                   timestamps (C64)
//
// The blocks are stateless: what is chosen, typed or expanded is the
// caller's, handed in, and every gesture comes back as a `RequestBodyEvent`.

import SwiftUI

/// `REQUEST_BODIES`, packages/core/src/requests.ts — closed.
public enum RequestBodyKind: String, CaseIterable, Sendable {
    case choices, diff, thread
    case beforeAfter = "before_after"
    case preview, todos, excerpt
}

// MARK: - The blocks' contents

public struct ChoicesBody: Sendable, Equatable {
    public var prompt: String
    public var options: [String]
    /// Pick any, rather than pick one.
    public var multi: Bool
    /// *Question 2 of 3*.
    public var step: Int
    public var of: Int
    /// Chosen option indices; `options.count` is *Something else…*.
    public var chosen: Set<Int>
    /// The owner's own words, when *Something else…* is chosen.
    public var other: String
    /// C105: every question ends in *Something else…* — unless the asker said
    /// its options are the only answers it can take (T2-3's `allow_other:
    /// false`), in which case offering it would invite a refusal.
    public var allowsOther: Bool

    /// Every question ends in it (C105). Its index is `options.count`.
    public static let somethingElse = "Something else…"

    public init(prompt: String, options: [String], multi: Bool = false, step: Int = 1, of: Int = 1, chosen: Set<Int> = [], other: String = "", allowsOther: Bool = true) {
        self.prompt = prompt
        self.options = options
        self.multi = multi
        self.step = step
        self.of = of
        self.chosen = chosen
        self.other = other
        self.allowsOther = allowsOther
    }

    /// The options as drawn: the question's own, then *Something else…*.
    public var drawn: [String] { options + (allowsOther ? [Self.somethingElse] : []) }
    public var somethingElseIndex: Int { options.count }
}

public struct DiffLine: Sendable, Equatable {
    public enum Kind: String, Sendable { case added, removed, context }
    public var kind: Kind
    public var text: String

    public init(_ kind: Kind, _ text: String) {
        self.kind = kind
        self.text = text
    }
}

public struct DiffBody: Sendable, Equatable {
    /// What changed: a path, a task line, *Your day*.
    public var title: String
    public var lines: [DiffLine]
    /// Collapsed by default — the summary is enough nine times in ten.
    public var expanded: Bool

    public init(title: String, lines: [DiffLine], expanded: Bool = false) {
        self.title = title
        self.lines = lines
        self.expanded = expanded
    }

    public var added: Int { lines.filter { $0.kind == .added }.count }
    public var removed: Int { lines.filter { $0.kind == .removed }.count }
}

public struct ThreadMessage: Sendable, Equatable {
    /// The author as the source spells them — a person, an agent id, the assistant's name.
    public var author: String
    /// Agent-written words are data and sit on the wash (P1).
    public var byAgent: Bool
    public var at: Date?
    public var text: String

    public init(author: String, byAgent: Bool = false, at: Date? = nil, text: String) {
        self.author = author
        self.byAgent = byAgent
        self.at = at
        self.text = text
    }
}

public struct ThreadBody: Sendable, Equatable {
    /// `apps/console/src/server.ts:630` — where the conversation is.
    public var location: String?
    /// The lines under discussion, verbatim.
    public var code: [String]
    public var messages: [ThreadMessage]

    public init(location: String? = nil, code: [String] = [], messages: [ThreadMessage]) {
        self.location = location
        self.code = code
        self.messages = messages
    }
}

public struct BeforeAfterBody: Sendable, Equatable {
    public struct Version: Sendable, Equatable {
        /// *Yours · 9:12 PM*, *The fold's · 9:14 PM* — who, and when; named, not inferred.
        public var label: String
        public var text: String

        public init(label: String, text: String) {
            self.label = label
            self.text = text
        }
    }

    public enum Content: Sendable, Equatable {
        /// A set that changes — folders an agent could read. `total` says what the
        /// expanded list is: *It would then read 4 folders*.
        case sets(before: [String], after: [String], total: String)
        /// Two versions of one thing — a conflicted note, a prompt overlay.
        case versions(before: Version, after: Version)
    }

    /// What the affirming answer does, as a section label: *What Approve Does*.
    public var heading: String
    public var content: Content
    public var expanded: Bool

    public init(heading: String, content: Content, expanded: Bool = false) {
        self.heading = heading
        self.content = content
        self.expanded = expanded
    }
}

public struct PreviewBody: Sendable, Equatable {
    /// *Where It Would Be Written*.
    public var heading: String
    public var path: String?
    public var text: String
    /// The agent's own words — a comment it would post — on the wash, in the serif.
    public var agentWords: Bool

    public init(heading: String, path: String? = nil, text: String, agentWords: Bool = false) {
        self.heading = heading
        self.path = path
        self.text = text
        self.agentWords = agentWords
    }
}

public struct TodoItem: Sendable, Equatable {
    public var text: String
    /// Proposed due dates and people (C102 — owed is a facet).
    public var facets: TaskFacets

    public init(_ text: String, facets: TaskFacets = TaskFacets()) {
        self.text = text
        self.facets = facets
    }
}

public struct ExcerptBody: Sendable, Equatable {
    public var text: String
    /// *GitHub · foldedspacelabs/metistry#418*.
    public var source: String?
    /// A failure's two timestamps (C64): when it failed, and when it last worked.
    public var failedAt: Date?
    public var lastSucceeded: Date?
    /// The reason, verbatim: *token expired*.
    public var reason: String?

    public init(text: String, source: String? = nil, failedAt: Date? = nil, lastSucceeded: Date? = nil, reason: String? = nil) {
        self.text = text
        self.source = source
        self.failedAt = failedAt
        self.lastSucceeded = lastSucceeded
        self.reason = reason
    }
}

public enum RequestBodyBlock: Sendable, Equatable {
    case choices(ChoicesBody)
    case diff(DiffBody)
    case thread(ThreadBody)
    case beforeAfter(BeforeAfterBody)
    case preview(PreviewBody)
    case todos([TodoItem])
    case excerpt(ExcerptBody)

    public var kind: RequestBodyKind {
        switch self {
        case .choices: return .choices
        case .diff: return .diff
        case .thread: return .thread
        case .beforeAfter: return .beforeAfter
        case .preview: return .preview
        case .todos: return .todos
        case .excerpt: return .excerpt
        }
    }
}

/// What the owner did inside a body.
public enum RequestBodyEvent: Sendable, Equatable {
    /// Chose (or, for pick-any, toggled) option `index`; `options.count` is *Something else…*.
    case choose(Int)
    /// Typed in *Something else…*.
    case other(String)
    /// Opened or closed the diff or the total.
    case toggleExpanded
}

// MARK: - The presentation

public struct RequestBodyPresentation: Sendable, Equatable {
    public var kind: RequestBodyKind
    /// The section label, or the question.
    public var heading: [Mark]
    /// One entry per line, each flowed.
    public var lines: [[Mark]]
    /// What the disclosure opens onto, under it: the diff's lines, the whole set.
    public var detail: [[Mark]]
    /// The block's ground: `sunken` for quoted material, `agent-quiet` for an agent's words, nil for none.
    public var plate: MetistryColorRole?
    public var controls: [ControlSpec]
    /// Where *Something else…*'s field goes, when it is chosen.
    public var otherField: String?
    public var spoken: String
}

public extension RequestBodyBlock {
    func presentation(on ground: MetistryColorRole = .surface, today: TaskDay, now: Date, clock: ClockTime) -> RequestBodyPresentation {
        func label(_ text: String) -> Mark {
            Mark(text, style: .caption2, ink: .textSecondary, on: ground, uppercase: true)
        }
        switch self {
        case .choices(let c):
            let heading = [
                Mark("Question \(c.step) of \(c.of)", style: .caption1, ink: .textSecondary, on: ground),
                Mark(c.prompt, style: .headline, ink: .textPrimary, on: ground, spoken: "Question \(c.step) of \(c.of). \(c.prompt)"),
            ]
            let controls = c.drawn.enumerated().map { i, option -> ControlSpec in
                let on = c.chosen.contains(i)
                let glyph: MetistryGlyph = c.multi ? (on ? .checkboxOn : .checkbox) : (on ? .radioOn : .radio)
                let said = option.hasSuffix("…") ? String(option.dropLast()) : option
                return ControlSpec(option, glyph: glyph, role: .plain, selected: on, name: "\(said). \(i + 1) of \(c.drawn.count)")
            }
            let typing = c.chosen.contains(c.somethingElseIndex)
            return RequestBodyPresentation(kind: .choices, heading: heading, lines: [], detail: [], plate: nil, controls: controls, otherField: typing ? c.other : nil, spoken: heading[1].voice)

        case .diff(let d):
            let summary = Mark("\(d.title)  +\(d.added) −\(d.removed)", style: .subhead, design: .mono, ink: .textPrimary, on: .sunken, spoken: "\(d.title): \(d.added) added, \(d.removed) removed")
            var detail: [[Mark]] = []
            if d.expanded {
                detail = d.lines.map { line in
                    switch line.kind {
                    case .added: return [Mark(line.text, glyph: .added, glyphInk: .ok, style: .footnote, design: .mono, ink: .textPrimary, plate: .okQuiet, on: .sunken, shape: .band, spoken: "added: \(line.text)")]
                    case .removed: return [Mark(line.text, glyph: .removed, glyphInk: .failed, style: .footnote, design: .mono, ink: .textPrimary, plate: .failedQuiet, on: .sunken, shape: .band, spoken: "removed: \(line.text)")]
                    case .context: return [Mark(line.text, style: .footnote, design: .mono, ink: .textSecondary, on: .sunken, shape: .band)]
                    }
                }
            }
            let toggle = ControlSpec(d.expanded ? "Hide Lines" : "Show \(d.lines.count) Lines", glyph: d.expanded ? .disclosureOpen : .disclosure, role: .plain, selected: d.expanded)
            return RequestBodyPresentation(kind: .diff, heading: [], lines: [[summary]], detail: detail, plate: .sunken, controls: [toggle], otherField: nil, spoken: summary.voice)

        case .thread(let t):
            var lines: [[Mark]] = []
            if let location = t.location { lines.append([Mark(location, style: .caption1, design: .mono, ink: .textSecondary, on: ground)]) }
            lines += t.code.map { [Mark($0, style: .footnote, design: .mono, ink: .textPrimary, plate: .sunken, on: ground, shape: .band)] }
            for m in t.messages {
                var head = [Mark(m.author, style: .subhead, design: m.byAgent ? .mono : .sans, weight: .semibold, ink: m.byAgent ? .agent : .textPrimary, on: ground)]
                if let at = m.at { head.append(Mark(clock.moment(at, now: now), style: .caption1, ink: .textSecondary, on: ground)) }
                lines.append(head)
                lines.append([m.byAgent
                    ? Mark(m.text, style: .body, design: .serif, ink: .textPrimary, plate: .agentQuiet, on: ground, shape: .band)
                    : Mark(m.text, style: .body, ink: .textPrimary, on: ground)])
            }
            let spoken = t.messages.map { "\($0.author): \($0.text)" }.joined(separator: ". ")
            return RequestBodyPresentation(kind: .thread, heading: [], lines: lines, detail: [], plate: nil, controls: [], otherField: nil, spoken: spoken)

        case .beforeAfter(let b):
            switch b.content {
            case .sets(let before, let after, let total):
                let adds = after.filter { !before.contains($0) }
                let removes = before.filter { !after.contains($0) }
                var lines: [[Mark]] = adds.map { [Mark("Adds", style: .subhead, weight: .semibold, ink: .textPrimary, on: .sunken), Mark($0, style: .subhead, design: .mono, ink: .textPrimary, on: .sunken)] }
                lines += removes.map { [Mark("Removes", style: .subhead, weight: .semibold, ink: .textPrimary, on: .sunken), Mark($0, style: .subhead, design: .mono, ink: .textPrimary, on: .sunken)] }
                if adds.isEmpty && removes.isEmpty { lines.append([Mark("No change", style: .subhead, ink: .textSecondary, on: .sunken)]) }
                var detail: [[Mark]] = []
                if b.expanded {
                    detail = after.map { item in
                        adds.contains(item)
                            ? [Mark(item, style: .footnote, design: .mono, ink: .textPrimary, on: .sunken), Mark("new", style: .caption1, weight: .semibold, ink: .textPrimary, on: .sunken)]
                            : [Mark(item, style: .footnote, design: .mono, ink: .textSecondary, on: .sunken)]
                    }
                }
                let spoken = (adds.map { "adds \($0)" } + removes.map { "removes \($0)" }).joined(separator: ", ")
                return RequestBodyPresentation(kind: .beforeAfter, heading: [label(b.heading)], lines: lines, detail: detail, plate: .sunken, controls: [ControlSpec(total, glyph: b.expanded ? .disclosureOpen : .disclosure, role: .plain, selected: b.expanded)], otherField: nil, spoken: "\(b.heading): \(spoken.isEmpty ? "no change" : spoken)")
            case .versions(let before, let after):
                let lines: [[Mark]] = [
                    [Mark(before.label, style: .caption1, weight: .semibold, ink: .textSecondary, on: .sunken)],
                    [Mark(before.text, style: .footnote, design: .mono, ink: .textPrimary, on: .sunken)],
                    [Mark(after.label, style: .caption1, weight: .semibold, ink: .textSecondary, on: .sunken)],
                    [Mark(after.text, style: .footnote, design: .mono, ink: .textPrimary, on: .sunken)],
                ]
                return RequestBodyPresentation(kind: .beforeAfter, heading: [label(b.heading)], lines: lines, detail: [], plate: .sunken, controls: [], otherField: nil, spoken: "\(b.heading): \(before.label), then \(after.label)")
            }

        case .preview(let v):
            let plate: MetistryColorRole = v.agentWords ? .agentQuiet : .sunken
            var lines: [[Mark]] = []
            if let path = v.path { lines.append([Mark(path, style: .caption1, design: .mono, ink: .textSecondary, on: plate)]) }
            lines.append([v.agentWords
                ? Mark(v.text, style: .body, design: .serif, ink: .textPrimary, on: plate)
                : Mark(v.text, style: .footnote, design: .mono, ink: .textPrimary, on: plate)])
            return RequestBodyPresentation(kind: .preview, heading: [label(v.heading)], lines: lines, detail: [], plate: plate, controls: [], otherField: nil, spoken: "\(v.heading): \(v.text)")

        case .todos(let items):
            let lines = items.map { item -> [Mark] in
                [Mark(item.text, glyph: .proposed, glyphInk: .textSecondary, style: .body, ink: .textPrimary, on: ground)] + FacetRowModel(item.facets, today: today).presentation(on: ground).marks
            }
            let spoken = items.map { item -> String in
                let facets = FacetRowModel(item.facets, today: today).presentation(on: ground).spoken
                return facets.isEmpty ? item.text : "\(item.text). \(facets)"
            }.joined(separator: ". ")
            return RequestBodyPresentation(kind: .todos, heading: [label("Proposed To-dos")], lines: lines, detail: [], plate: nil, controls: [], otherField: nil, spoken: spoken)

        case .excerpt(let e):
            var lines: [[Mark]] = [[Mark(e.text, style: .body, ink: .textPrimary, plate: .sunken, on: ground, shape: .band)]]
            if let source = e.source { lines.append([Mark(source, style: .caption1, ink: .textSecondary, on: ground)]) }
            var facts: [String] = []
            if let failedAt = e.failedAt { facts.append("Failed \(clock.moment(failedAt, now: now))") }
            if let last = e.lastSucceeded { facts.append("last succeeded \(ClockTime.age(now.timeIntervalSince(last)))") }
            if let reason = e.reason { facts.append(reason) }
            if !facts.isEmpty { lines.append([Mark(facts.joined(separator: " · "), style: .footnote, ink: .textSecondary, on: ground)]) }
            return RequestBodyPresentation(kind: .excerpt, heading: [], lines: lines, detail: [], plate: nil, controls: [], otherField: nil, spoken: ([e.text] + (e.source.map { [$0] } ?? []) + facts).joined(separator: ". "))
        }
    }
}

// MARK: - The view

public struct RequestBodyView: View {
    @Environment(\.colorScheme) private var scheme
    let block: RequestBodyBlock
    let ground: MetistryColorRole
    let today: TaskDay
    let now: Date
    let clock: ClockTime
    let onEvent: (RequestBodyEvent) -> Void

    public init(_ block: RequestBodyBlock, on ground: MetistryColorRole = .surface, today: TaskDay, now: Date = Date(), clock: ClockTime = ClockTime(), onEvent: @escaping (RequestBodyEvent) -> Void = { _ in }) {
        self.block = block
        self.ground = ground
        self.today = today
        self.now = now
        self.clock = clock
        self.onEvent = onEvent
    }

    public var body: some View {
        let p = Palette(scheme)
        let view = block.presentation(on: ground, today: today, now: now, clock: clock)
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            ForEach(Array(view.heading.enumerated()), id: \.offset) { item in
                MarkView(item.element).accessibilityAddTraits(item.offset == view.heading.count - 1 ? .isHeader : [])
            }
            if case .choices = block {
                choices(view)
            } else {
                VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                    lines(view.lines)
                    ForEach(Array(view.controls.enumerated()), id: \.offset) { item in
                        ControlButton(item.element) { onEvent(.toggleExpanded) }
                    }
                    lines(view.detail)
                }
                .padding(view.plate == nil ? 0 : MetistrySpace.s3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(view.plate.map { p[$0] } ?? .clear, in: RoundedRectangle(cornerRadius: MetistryRadius.sm, style: .continuous))
            }
        }
        .accessibilityElement(children: .contain)
    }

    /// Each line flowed — except a line that is one band, which takes the whole width.
    private func lines(_ lines: [[Mark]]) -> some View {
        ForEach(Array(lines.enumerated()), id: \.offset) { line in
            if line.element.count == 1, line.element[0].shape == .band {
                MarkView(line.element[0])
            } else {
                FlowLayout(spacing: MetistrySpace.s2, lineSpacing: 2) {
                    ForEach(Array(line.element.enumerated()), id: \.offset) { MarkView($0.element) }
                }
            }
        }
    }

    @ViewBuilder
    private func choices(_ view: RequestBodyPresentation) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            ForEach(Array(view.controls.enumerated()), id: \.offset) { item in
                ControlButton(item.element) { onEvent(.choose(item.offset)) }
                    .accessibilityAddTraits(.isButton)
            }
            if let other = view.otherField {
                TextField(ChoicesBody.somethingElse, text: Binding(get: { other }, set: { onEvent(.other($0)) }), axis: .vertical)
                    .metistryFont(.body)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityLabel(Text(verbatim: "Your answer"))
            }
        }
    }
}

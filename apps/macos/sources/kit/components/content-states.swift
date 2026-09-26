// The four states, plus `partial` (components-01 §1; amendments §2; C28,
// ratified 2026-09-26).
//
//     state    means                                   replaces the content?
//     empty    nothing has happened yet                yes
//     absent   never configured — a fact, not a fault  yes
//     failed   it answered, and the answer was an error yes
//     stale    it was answering and has not lately      NO — it annotates
//     partial  part of it is a fact and part is not     NO — it annotates
//
// The first three are PANEL states: nothing true can be shown, so the panel
// says why instead — glyph, a Title Case title, one sentence, for `failed`
// the reason quoted verbatim from the API's own envelope (P4) and, when
// known, when it last succeeded (C64: one timestamp is a quieter lie), and
// one action where there is a sensible one. Never an apology, never an
// illustration.
//
// `stale` is drawn by stale-band.swift. `partial` is a row whose data is
// partly a fact — a task line with one unreadable token, a conflicted file
// whose path is known and whose title is not yet: the row renders what is
// known and a note says why the rest is missing, rather than a blank or the
// filename dressed up as a title.
//
// And the control that is off because of a fact (components-01 §1.3): a
// control disabled by a fact about the system always shows that fact; one
// disabled by the owner's own state does not.

import SwiftUI

public enum ContentState: String, CaseIterable, Sendable {
    case empty, absent, failed, stale, partial

    /// Whether the state takes the content's place, or annotates it.
    public var replacesContent: Bool {
        switch self {
        case .empty, .absent, .failed: return true
        case .stale, .partial: return false
        }
    }
}

/// Words the states share (the States board; amendments §8.1).
public enum StateWords {
    /// Retry, everywhere. In prose it is *Couldn't …*.
    public static let tryAgain = "Try Again"
    /// O3: decisions are disabled while the instance is unreachable, never
    /// queued — the gate's own sentence (stores/reachability-gate.swift), so
    /// the refusal and the line under the control cannot drift (P3).
    public static let unreachable = ReachabilityGate.decisionsNeedTheConnection
}

// MARK: - The panel states

public struct StatePanelModel: Sendable, Equatable {
    public enum Kind: String, Sendable {
        case empty, absent, failed

        var glyph: MetistryGlyph {
            switch self {
            case .empty: return .empty
            case .absent: return .absent
            case .failed: return .failed
            }
        }

        var tint: MetistryColorRole {
            switch self {
            case .empty: return .textTertiary
            case .absent: return .absent
            case .failed: return .failed
            }
        }
    }

    public var kind: Kind
    /// Title Case: *Nothing on the Board*, *Not Configured*, *Couldn't Read Spend*.
    public var title: String
    /// One sentence, sentence case.
    public var sentence: String
    /// `failed` only: the API's own reason, verbatim.
    public var reason: String?
    /// `failed` only: when it last worked, if known.
    public var lastSucceeded: Date?
    /// The one action: what configures it (absent), retry (failed), usually none (empty).
    public var action: String?

    public init(_ kind: Kind, title: String, sentence: String, reason: String? = nil, lastSucceeded: Date? = nil, action: String? = nil) {
        self.kind = kind
        self.title = title
        self.sentence = sentence
        self.reason = kind == .failed ? reason : nil
        self.lastSucceeded = kind == .failed ? lastSucceeded : nil
        self.action = action
    }

    public struct Presentation: Sendable, Equatable {
        public var glyph: Mark
        public var title: Mark
        public var sentence: Mark
        public var reason: Mark?
        public var lastSucceeded: Mark?
        public var controls: [ControlSpec]
        public var spoken: String
    }

    public func presentation(on ground: MetistryColorRole = .surface, now: Date, clock: ClockTime) -> Presentation {
        let glyph = Mark("", glyph: kind.glyph, style: .title1, ink: kind.tint, on: ground, spoken: kind == .absent ? "not configured" : kind.rawValue)
        let when = lastSucceeded.map { Mark("Last succeeded \(ClockTime.age(now.timeIntervalSince($0))) · \(clock.moment($0, now: now))", style: .footnote, ink: .textSecondary, on: ground) }
        let reason = reason.map { Mark($0, style: .footnote, design: .mono, ink: .textPrimary, plate: .sunken, on: ground) }
        let spoken = ([glyph.voice, title, sentence] + [reason?.text, when?.text].compactMap { $0 }).joined(separator: ". ")
        return Presentation(
            glyph: glyph,
            title: Mark(title, style: .headline, ink: .textPrimary, on: ground),
            sentence: Mark(sentence, style: .subhead, ink: .textSecondary, on: ground),
            reason: reason,
            lastSucceeded: when,
            controls: action.map { [ControlSpec($0, role: .secondary)] } ?? [],
            spoken: spoken
        )
    }
}

public struct StatePanel: View {
    @Environment(\.colorScheme) private var scheme
    let model: StatePanelModel
    let ground: MetistryColorRole
    let now: Date
    let clock: ClockTime
    let onAction: (() -> Void)?

    public init(_ model: StatePanelModel, on ground: MetistryColorRole = .surface, now: Date = Date(), clock: ClockTime = ClockTime(), onAction: (() -> Void)? = nil) {
        self.model = model
        self.ground = ground
        self.now = now
        self.clock = clock
        self.onAction = onAction
    }

    public var body: some View {
        let p = Palette(scheme)
        let view = model.presentation(on: ground, now: now, clock: clock)
        VStack(spacing: MetistrySpace.s2) {
            MarkView(view.glyph)
            MarkView(view.title).accessibilityAddTraits(.isHeader)
            MarkView(view.sentence).multilineTextAlignment(.center).frame(maxWidth: 250)
            if let reason = view.reason {
                MarkView(reason)
                    .padding(MetistrySpace.s2)
                    .background(p[.sunken], in: RoundedRectangle(cornerRadius: MetistryRadius.sm, style: .continuous))
                    .textSelection(.enabled)
            }
            if let when = view.lastSucceeded { MarkView(when) }
            if let action = view.controls.first, let onAction {
                ControlButton(action, action: onAction).padding(.top, MetistrySpace.s1)
            }
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .padding(MetistrySpace.s6)
        .accessibilityElement(children: .contain)
    }
}

// MARK: - Partial

public struct PartialNoteModel: Sendable, Equatable {
    /// Why the missing part is missing, sentence case.
    public var text: String

    public init(_ text: String) {
        self.text = text
    }

    /// A task line with one unreadable token: the rest is fine (screen 5 §3).
    public static func parseWarning(token: String) -> PartialNoteModel {
        PartialNoteModel("couldn't read `\(token)` — the rest of the line is fine")
    }

    public func mark(on ground: MetistryColorRole) -> Mark {
        Mark(text, glyph: .degraded, style: .subhead, ink: .degraded, on: ground, spoken: "partial: \(text)")
    }
}

public struct PartialNote: View {
    let model: PartialNoteModel
    let ground: MetistryColorRole

    public init(_ model: PartialNoteModel, on ground: MetistryColorRole = .surface) {
        self.model = model
        self.ground = ground
    }

    public var body: some View {
        MarkView(model.mark(on: ground))
    }
}

// MARK: - Off because of a fact

public struct FactNoteModel: Sendable, Equatable {
    public var fact: String

    public init(_ fact: String) {
        self.fact = fact
    }

    /// O3 (components-01 §1.3).
    public static let unreachable = FactNoteModel(StateWords.unreachable)

    public func mark(on ground: MetistryColorRole) -> Mark {
        Mark(fact, glyph: .lock, style: .footnote, ink: .stale, on: ground)
    }
}

/// The line beneath a control a fact turned off.
public struct FactNote: View {
    let model: FactNoteModel
    let ground: MetistryColorRole

    public init(_ model: FactNoteModel, on ground: MetistryColorRole = .surface) {
        self.model = model
        self.ground = ground
    }

    public var body: some View {
        MarkView(model.mark(on: ground))
    }
}

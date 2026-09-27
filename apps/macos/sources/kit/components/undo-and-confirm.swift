// Undo or confirm (C136; components-03 §3; P3).
//
// REVERSIBLE → ACT AT ONCE, THEN UNDO FOR TEN SECONDS. Decline All, Keep Mine
// / Take the Fold's, a move: no dialog in front of an act that can be taken
// back — asking for ceremony there teaches the owner to click through the
// dialog that matters (screen 7 §5). The receipt says what happened; Undo is
// a second write, offered while the window is open.
//
// IRREVERSIBLE → CONFIRM, NAMING THE COST. Purge Now lists the unfolded
// sessions and offers Fold First; Sign Out Everywhere lists the devices;
// deleting a secret in use lists what stops. Never a bare *Are you sure?*:
// a `CostConfirmation` that names no cost, or whose button is not the act's
// own verb (*Purge Now*, *Widen* — never *OK*), cannot be made. The act is the
// one filled destructive button; Cancel is the default (P3).

import SwiftUI

// MARK: - Undo

public struct UndoWindow: Sendable, Equatable {
    /// How long Undo is offered (C136).
    public static let seconds: TimeInterval = 10

    /// What happened, sentence case: *Declined 5 requests*.
    public var receipt: String
    public var actedAt: Date

    public init(_ receipt: String, actedAt: Date) {
        self.receipt = receipt
        self.actedAt = actedAt
    }

    public func isOpen(at now: Date) -> Bool {
        let elapsed = now.timeIntervalSince(actedAt)
        return elapsed >= 0 && elapsed < Self.seconds
    }

    public struct Presentation: Sendable, Equatable {
        public var receipt: Mark
        /// Undo while the window is open; nothing after.
        public var controls: [ControlSpec]
    }

    public func presentation(at now: Date, on ground: MetistryColorRole = .elevated) -> Presentation {
        let open = isOpen(at: now)
        return Presentation(
            receipt: Mark(receipt, style: .body, ink: .textPrimary, on: ground, spoken: open ? "\(receipt). Undo available" : receipt),
            controls: open ? [ControlSpec("Undo", glyph: .undo, role: .secondary)] : []
        )
    }
}

/// The receipt, with Undo for ten seconds. It hides itself when the window closes.
public struct UndoBar: View {
    @Environment(\.colorScheme) private var scheme
    let window: UndoWindow
    let ground: MetistryColorRole
    let onUndo: () -> Void

    public init(_ window: UndoWindow, on ground: MetistryColorRole = .elevated, onUndo: @escaping () -> Void) {
        self.window = window
        self.ground = ground
        self.onUndo = onUndo
    }

    public var body: some View {
        // Two moments matter — the act and ten seconds after it — so the
        // timeline wakes twice rather than every second: nothing counts down.
        TimelineView(.explicit([window.actedAt, window.actedAt.addingTimeInterval(UndoWindow.seconds)])) { context in
            let p = Palette(scheme)
            let view = window.presentation(at: context.date, on: ground)
            if let undo = view.controls.first {
                HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s3) {
                    MarkView(view.receipt)
                    Spacer(minLength: 0)
                    ControlButton(undo, action: onUndo)
                }
                .padding(.horizontal, MetistrySpace.s3)
                .padding(.vertical, MetistrySpace.s2)
                .background(p[ground], in: RoundedRectangle(cornerRadius: MetistryRadius.md, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: MetistryRadius.md, style: .continuous).strokeBorder(p[.border], lineWidth: 1))
                .accessibilityElement(children: .contain)
            }
        }
    }
}

// MARK: - Confirm, naming the cost

public struct CostConfirmation: Sendable, Equatable {
    /// Title Case, the act as a question: *Purge 3 Sessions Now?*
    public let title: String
    /// What the list is, sentence case: *These sessions have not been folded yet:*
    public let costHeading: String
    /// The cost, named: sessions, devices, what stops. Never empty.
    public let costs: [String]
    /// The act's own verb, Title Case: *Purge Now*, *Sign Out Everywhere*.
    public let confirm: String
    /// A way round the cost, when there is one: *Fold First*.
    public let alternative: String?
    /// A filled destructive button — the act cannot be undone. A widening
    /// confirms too (screen 7 §5) but is not destructive.
    public let destructive: Bool

    /// Words a confirm button may not be: a button must say the act (P3; screen 7 §5).
    public static let bareWords: Set<String> = ["ok", "okay", "yes", "confirm", "continue", "proceed", "sure", "done", "accept"]

    /// Nil — no confirmation at all — when it names no cost or its button does not name the act.
    public init?(title: String, costHeading: String, costs: [String], confirm: String, alternative: String? = nil, destructive: Bool = true) {
        let named = costs.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        let verb = confirm.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !named.isEmpty, !verb.isEmpty, !Self.bareWords.contains(verb.lowercased()) else { return nil }
        self.title = title
        self.costHeading = costHeading
        self.costs = named
        self.confirm = verb
        self.alternative = alternative
        self.destructive = destructive
    }

    public struct Presentation: Sendable, Equatable {
        public var title: Mark
        public var heading: Mark
        public var costs: [Mark]
        /// In reading order: the way round (if any), Cancel, the act.
        public var controls: [ControlSpec]
        public var spoken: String
    }

    public static let cancel = "Cancel"

    public func presentation(on ground: MetistryColorRole = .elevated) -> Presentation {
        var controls: [ControlSpec] = []
        if let alternative { controls.append(ControlSpec(alternative, role: .secondary)) }
        controls.append(ControlSpec(Self.cancel, role: .secondary, shortcut: "Return"))
        controls.append(ControlSpec(confirm, role: destructive ? .destructive : .primary))
        return Presentation(
            title: Mark(title, style: .headline, ink: .textPrimary, on: ground),
            heading: Mark(costHeading, style: .body, ink: .textPrimary, on: ground),
            costs: costs.map { Mark($0, style: .body, ink: .textPrimary, on: ground) },
            controls: controls,
            spoken: "\(title) \(costHeading) \(costs.joined(separator: ", "))"
        )
    }
}

public struct CostConfirmView: View {
    public enum Choice: Sendable, Equatable { case confirm, alternative, cancel }

    @Environment(\.colorScheme) private var scheme
    let confirmation: CostConfirmation
    let ground: MetistryColorRole
    let onChoice: (Choice) -> Void

    public init(_ confirmation: CostConfirmation, on ground: MetistryColorRole = .elevated, onChoice: @escaping (Choice) -> Void) {
        self.confirmation = confirmation
        self.ground = ground
        self.onChoice = onChoice
    }

    public var body: some View {
        let p = Palette(scheme)
        let view = confirmation.presentation(on: ground)
        VStack(alignment: .leading, spacing: MetistrySpace.s3) {
            MarkView(view.title).accessibilityAddTraits(.isHeader)
            MarkView(view.heading)
            VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                ForEach(Array(view.costs.enumerated()), id: \.offset) { item in
                    HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                        Text(verbatim: "•").foregroundStyle(p[.textSecondary]).accessibilityHidden(true)
                        MarkView(item.element)
                    }
                }
            }
            .padding(.leading, MetistrySpace.s2)
            FlowLayout(spacing: MetistrySpace.s2) {
                ForEach(Array(view.controls.enumerated()), id: \.offset) { item in
                    button(item.element)
                }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .padding(MetistrySpace.s5)
        .background(p[ground])
        #if os(macOS)
        .onExitCommand { onChoice(.cancel) }
        #endif
    }

    @ViewBuilder
    private func button(_ control: ControlSpec) -> some View {
        if control.label == CostConfirmation.cancel {
            // Cancel is the default (P3): Return cancels, and so does Esc.
            ControlButton(control) { onChoice(.cancel) }.keyboardShortcut(.defaultAction)
        } else if control.label == confirmation.confirm {
            ControlButton(control) { onChoice(.confirm) }
        } else {
            ControlButton(control) { onChoice(.alternative) }
        }
    }
}

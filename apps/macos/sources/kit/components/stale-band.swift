// Stale, and first paint (components-01 §1.2; components-03 §1; C135).
//
// STALE ANNOTATES; IT NEVER REPLACES. The reading on screen is still the last
// true thing the system knew, so a stale screen keeps it and says when it is
// from — hiding a number because it is old is the lie (amendments §2.2).
// Staleness is neutral: the `stale` role is a grey, because the tint is for
// something wrong (§8.3).
//
//   * The pill, welded to a row's name: the component takes `isStale` and an
//     age string and draws them. It never decides a row is stale from a
//     timestamp — the source's threshold belongs to the source.
//   * The band, over a screen past its own age limit: *Showing the board as
//     of 9:14 AM*, with the one action that refreshes it where there is one.
//
// FIRST PAINT (C135). Show what Metistry last had, at once; placeholder rows
// only on a screen's very first load; a wait over one second says what it
// waits for — never a bare spinner, and the placeholders do not shimmer
// (motion is closed at two, amendments §6.1).

import SwiftUI

// MARK: - The pill

public struct StalePillModel: Sendable, Equatable {
    public var isStale: Bool
    /// *3 days ago* — the caller's words for the age.
    public var age: String

    public init(isStale: Bool, age: String) {
        self.isStale = isStale
        self.age = age
    }

    /// Nothing at all when the row is not stale.
    public func mark(on ground: MetistryColorRole) -> Mark? {
        guard isStale else { return nil }
        return Mark(age, glyph: .stale, style: .caption1, ink: .stale, plate: .staleQuiet, on: ground, shape: .chip, spoken: "stale, \(age)")
    }
}

public struct StalePill: View {
    let model: StalePillModel
    let ground: MetistryColorRole

    public init(isStale: Bool, age: String, on ground: MetistryColorRole = .surface) {
        self.model = StalePillModel(isStale: isStale, age: age)
        self.ground = ground
    }

    public var body: some View {
        if let mark = model.mark(on: ground) { MarkView(mark) }
    }
}

// MARK: - The band

public struct StaleBandModel: Sendable, Equatable {
    public enum When: Sendable, Equatable {
        /// *as of 9:14 AM* (or *as of 27 Sep, 9:14 AM* on another day).
        case clock
        /// *as of 40 minutes ago*.
        case age
    }

    /// What is shown, as the band leads with it: *Showing the board*, *Spend*.
    public var lead: String
    public var asOf: Date
    public var when: When
    /// The one action that refreshes it, Title Case: *Sync Now*, *Check Now*.
    public var action: String?

    public init(_ lead: String, asOf: Date, when: When = .clock, action: String? = nil) {
        self.lead = lead
        self.asOf = asOf
        self.when = when
        self.action = action
    }

    public struct Presentation: Sendable, Equatable {
        public var text: Mark
        public var plate: MetistryColorRole
        public var controls: [ControlSpec]
    }

    public func presentation(now: Date, clock: ClockTime) -> Presentation {
        let moment = when == .clock ? clock.moment(asOf, now: now) : ClockTime.age(now.timeIntervalSince(asOf))
        let text = "\(lead) as of \(moment)"
        return Presentation(
            text: Mark(text, glyph: .stale, glyphInk: .stale, style: .subhead, ink: .textPrimary, on: .staleQuiet, spoken: "stale. \(text)"),
            plate: .staleQuiet,
            // Plain, not outlined: `border-control` on `stale-quiet` is 2.94:1
            // light and 2.62:1 dark — under the 3:1 an outline needs.
            controls: action.map { [ControlSpec($0, role: .plain)] } ?? []
        )
    }
}

public struct StaleBand: View {
    @Environment(\.colorScheme) private var scheme
    let model: StaleBandModel
    let now: Date
    let clock: ClockTime
    let onAction: (() -> Void)?

    public init(_ model: StaleBandModel, now: Date = Date(), clock: ClockTime = ClockTime(), onAction: (() -> Void)? = nil) {
        self.model = model
        self.now = now
        self.clock = clock
        self.onAction = onAction
    }

    public var body: some View {
        let p = Palette(scheme)
        let view = model.presentation(now: now, clock: clock)
        HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s3) {
            MarkView(view.text)
            Spacer(minLength: 0)
            if let action = view.controls.first, let onAction {
                ControlButton(action, action: onAction)
            }
        }
        .padding(.horizontal, MetistrySpace.s3)
        .padding(.vertical, MetistrySpace.s2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(p[view.plate])
        .accessibilityElement(children: .contain)
    }
}

// MARK: - First paint

public enum FirstPaint: Sendable, Equatable {
    /// The screen has never had data: placeholder rows — and, past a second, what it waits for.
    case placeholders(waitingFor: String?)
    /// Data, at once. `staleSince` is set when it is older than the screen's
    /// age limit, or its last refresh failed — draw the band.
    case content(staleSince: Date?)
    /// Nothing to show, and the answer was an error: the failed panel, with this reason.
    case failed(String)

    /// How long a wait goes unexplained.
    public static let patience: TimeInterval = 1

    /// - Parameters:
    ///   - asOf: when the data the screen last had is from (the reply's `as_of`); nil if it never had any.
    ///   - loadingSince: when the load in flight started; nil if none is.
    ///   - ageLimit: the screen's own limit (C135) — a fact about the screen, not a guess about the data.
    ///   - waitingFor: what it waits for, with a count when one is known (*Reading your vault · 312 of 1,240*).
    public static func paint(asOf: Date?, loadingSince: Date?, ageLimit: TimeInterval, waitingFor: String, now: Date) -> FirstPaint {
        if let asOf {
            return .content(staleSince: now.timeIntervalSince(asOf) > ageLimit ? asOf : nil)
        }
        guard let loadingSince, now.timeIntervalSince(loadingSince) > patience else { return .placeholders(waitingFor: nil) }
        return .placeholders(waitingFor: waitingFor)
    }
}

public extension FirstPaint {
    /// The same decision over a store section (instance-store.swift's
    /// `Section`, which a `SectionModel` holds): what it last had and when the
    /// console said that was true, and whether the last refresh failed —
    /// a failed refresh over data on screen is stale, never a blank.
    static func paint<Value>(_ section: Section<Value>, loadingSince: Date?, ageLimit: TimeInterval, waitingFor: String, now: Date) -> FirstPaint {
        if section.hasValue {
            if case .stale = section.state { return .content(staleSince: section.asOf) }
            guard let asOf = section.asOf else { return .content(staleSince: nil) }
            return paint(asOf: asOf, loadingSince: loadingSince, ageLimit: ageLimit, waitingFor: waitingFor, now: now)
        }
        if case .failed(let why) = section.state { return .failed(why) }
        return paint(asOf: nil, loadingSince: loadingSince, ageLimit: ageLimit, waitingFor: waitingFor, now: now)
    }
}

/// Placeholder rows for a screen's very first load: still, and saying what they wait for.
public struct PlaceholderRows: View {
    @Environment(\.colorScheme) private var scheme
    let count: Int
    let waitingFor: String?
    let ground: MetistryColorRole

    public init(count: Int = 3, waitingFor: String?, on ground: MetistryColorRole = .surface) {
        self.count = count
        self.waitingFor = waitingFor
        self.ground = ground
    }

    public var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s3) {
            ForEach(0..<count, id: \.self) { i in
                RoundedRectangle(cornerRadius: MetistryRadius.xs, style: .continuous)
                    .fill(p[.sunken])
                    .frame(height: 12)
                    .frame(maxWidth: i % 2 == 0 ? .infinity : 240, alignment: .leading)
            }
            if let waitingFor {
                MarkView(Mark(waitingFor, style: .subhead, ink: .textSecondary, on: ground))
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: waitingFor ?? "Loading"))
    }
}

// Keeping the Mac awake, as the app models it: the four choices with what each
// one costs, and the reading of doctor's `keep-awake` row.
//
// NO VIEW HERE, deliberately — the pane this belongs to (Settings → Services,
// a switch with a radio pair under it) is the designer's, and shipping a
// control before its design would be building the thing twice. What is here is
// the half that has decisions in it: the vocabulary, the consequence copy, and
// the row reading, all of it testable.
//
// THE APP WRITES NO FILE. The choice is a `metistry deployment set-keep-awake`
// call (metistry-cli.swift) — `deployment.yaml` is a §4.7 protected path, the
// CLI writes it through the reconciler as the `user` principal, and an app
// that edited the YAML itself would be the invariant-2 boundary broken in the
// one place it is easiest to break (research doc §6).
//
// ON THE DUPLICATED COPY. `KEEP_AWAKE_CHOICES` in
// `packages/core/src/power.ts` is the same table in the same order; Swift
// cannot import it, so the strings are mirrored here and a test asserts the
// vocabulary rather than trusting the eye. Any wording change is a change in
// both places or it is a bug.

import Foundation

public enum KeepAwakeSetting: String, CaseIterable, Sendable, Identifiable {
    case never
    case allowSleepOnBattery = "allow_sleep_on_battery"
    case always
    case alwaysLidClosed = "always_lid_closed"

    public var id: String { rawValue }

    /// The order a person is OFFERED them: the recommendation first, the one
    /// we advise against last. `allCases` is the enum's declaration order and
    /// is not that order, so nothing renders from it.
    public static let offered: [KeepAwakeSetting] = [.allowSleepOnBattery, .always, .never, .alwaysLidClosed]

    /// What `metistry init` offers as the default answer. A recommendation the
    /// user can decline — never a value the app writes on their behalf.
    public static let recommended: KeepAwakeSetting = .allowSleepOnBattery

    public var label: String {
        switch self {
        case .allowSleepOnBattery: return "Keep this Mac awake on power"
        case .always: return "Keep this Mac awake on power and on battery"
        case .never: return "Never keep this Mac awake"
        case .alwaysLidClosed: return "Keep this Mac awake even with the lid closed"
        }
    }

    /// What this choice COSTS, which is the whole of informed consent here.
    public var consequence: String {
        switch self {
        case .allowSleepOnBattery:
            return "Held while this Mac is on wall power; released on battery and on a UPS, so a laptop away from a charger sleeps normally and the install pauses with it."
        case .always:
            return "Held whichever way this Mac is powered. On a laptop away from a charger that drains the battery faster; a Mac still sleeps at low battery and when you close the lid."
        case .never:
            return "Nothing is held and your own sleep settings decide. Metistry pauses whenever the Mac sleeps: remote captures, scheduled collectors and the assistant's queue wait until it wakes."
        case .alwaysLidClosed:
            return "Not recommended, and this one is not ours to give: Metistry holds it awake exactly as the option above, and the lid-closed half needs an administrator change you make yourself. A closed laptop drains its battery."
        }
    }

    public var isRecommended: Bool { self == Self.recommended }

    /// Offered, never defaulted, and marked wherever it is shown.
    public var isNotRecommended: Bool { self == .alwaysLidClosed }

    /// The sentence the app must print beside the fourth choice rather than
    /// implying the app can arrange it. Mirrors core's `LID_CLOSED_NOT_AVAILABLE`.
    public static let lidClosedNotAvailable =
        "Keeping this Mac awake with the lid closed is not available on this Mac without an administrator change: an idle-sleep assertion does not survive lid close, and the only switch that does is a system-wide `sudo pmset -a disablesleep 1`, which Metistry will not make for you."
}

/// Doctor's `keep-awake` row, read rather than re-derived: the app runs no
/// `pmset`, holds no assertion and decides nothing about power. Every field is
/// something the CLI observed.
public struct KeepAwakeFacts: Sendable, Equatable {
    /// `ok` / `degraded` / `absent` — never `failed`, by the row's contract.
    public let status: CheckStatus
    public let setting: KeepAwakeSetting?
    public let holding: Bool
    /// The holding process's pid, cross-checked by the CLI against `pmset -g assertions`.
    public let pid: Int?
    public let since: String?
    /// `ac` / `battery` / `ups` / `unknown`, as `pmset -g ps` reported it.
    public let powerSource: String?
    /// Other processes holding the same assertion. Informational: neither app
    /// nor CLI may touch another holder's assertion, or take credit for it.
    public let otherHolders: Int
    /// The owner's ruling-E finding: the Mac slept while the setting said it should not have.
    public let sleptAt: String?
    /// The row's own remediation, shown verbatim (§3.16: never re-worded).
    public let remediation: String?

    public init(row: DoctorRow) {
        status = row.status
        setting = row.meta?["mode"]?.stringValue.flatMap(KeepAwakeSetting.init(rawValue:))
        holding = row.meta?["holding"]?.boolValue ?? false
        pid = row.meta?["pid"]?.intValue
        since = row.meta?["since"]?.stringValue
        powerSource = row.meta?["power_source"]?.stringValue
        otherHolders = row.meta?["other_holders"]?.intValue ?? 0
        sleptAt = row.meta?["last_cutoff"]?["at"]?.stringValue
        remediation = row.remediation
    }

    /// One line for a status list. "Released on battery" is SUCCESS, not a
    /// downgrade — it is the setting doing what it says.
    public var summary: String {
        guard let setting else { return "not reported" }
        switch setting {
        case .never: return "Off — this Mac sleeps on its own schedule"
        case .allowSleepOnBattery, .always, .alwaysLidClosed:
            if holding { return "Holding\(pid.map { " (pid \($0))" } ?? "")" }
            return powerSource == "battery" || powerSource == "ups" ? "Released on battery, which is what this setting asks for" : "Not holding"
        }
    }

    /// `true` when the app should offer the repair the CLI names: the Mac slept
    /// anyway. The offer itself is the CLI's sentence, never a new one.
    public var sleptAnyway: Bool { sleptAt != nil }
}

public extension DoctorReport {
    /// macOS only, and absent from an install whose CLI predates the row —
    /// `nil` means "this install cannot tell us", which is a fact to print,
    /// not a default to assume.
    var keepAwake: KeepAwakeFacts? {
        rows.first { $0.kind == "keep-awake" }.map(KeepAwakeFacts.init(row:))
    }
}

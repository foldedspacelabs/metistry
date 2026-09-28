// Keeping the Mac awake, as the app models it: the switch and its two
// sub-switches (the object form, T4-20), the four legacy values with what each
// one costs, the lid dialog's words, and the reading of doctor's `keep-awake`
// row.
//
// The view is Settings ▸ Services ▸ When it runs (settings-panes/
// services-pane.swift, T6-11): *Keep this Mac Awake*, and under it — disabled
// while it is off — *Allow sleep on battery* and *Allow sleep when the lid is
// closed*, both on by default (screen-15 §5.2, C129). What is here is the half
// that has decisions in it, all of it testable.
//
// THE APP WRITES NO FILE. Every change is a `metistry deployment
// set-keep-awake` call (§2.2 M4, through `ManagementRunner`) —
// `deployment.yaml` is a §4.7 protected path, the CLI writes it through the
// reconciler as the `user` principal, and an app that edited the YAML itself
// would be the invariant-2 boundary broken in the one place it is easiest to
// break (research doc §6).
//
// THE LID (plan §2.15, ruling 3). `sleep_lid_closed: false` is stored as asked,
// and only an administrator setting delivers it. The dialog shows the command
// with Copy, how to undo it, and the warning — and RUNS NOTHING. No `pmset`
// can reach a runner from this app at all: `ManagementCommand` holds §2.2's
// verbs and nothing else.
//
// ON THE DUPLICATED COPY. `packages/core/src/power.ts` holds the same table,
// the same object form and the same dialog words; Swift cannot import it, so
// they are mirrored here and a test reads power.ts and compares, rather than
// trusting the eye. Any wording change is a change in both places or CI fails.

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

// MARK: - The object form (T4-20)

/// `keep_awake: { enabled, sleep_on_battery, sleep_lid_closed }` — core's
/// `KeepAwakeSetting`, the one shape everything below the parse reads. The
/// four values above still load and mean what they meant; each maps to exactly
/// one of these (`init(_:)`, core's `keepAwakeSetting`).
public struct KeepAwakeSwitches: Sendable, Equatable {
    /// The switch. Off holds nothing, whatever the two below say — they are
    /// remembered, not applied.
    public var enabled: Bool
    /// true = released on battery and on a UPS; false = held on any power.
    public var sleepOnBattery: Bool
    /// true = a closed lid sleeps, as every Mac does. false = the owner wants
    /// a closed Mac kept awake — stored as asked, delivered only by an
    /// administrator setting made by hand.
    public var sleepLidClosed: Bool

    public init(enabled: Bool, sleepOnBattery: Bool = true, sleepLidClosed: Bool = true) {
        self.enabled = enabled
        self.sleepOnBattery = sleepOnBattery
        self.sleepLidClosed = sleepLidClosed
    }

    /// A legacy value as the one shape — core's `keepAwakeSetting`, row for row.
    public init(_ value: KeepAwakeSetting) {
        switch value {
        case .never: self.init(enabled: false, sleepOnBattery: true, sleepLidClosed: true)
        case .allowSleepOnBattery: self.init(enabled: true, sleepOnBattery: true, sleepLidClosed: true)
        case .always: self.init(enabled: true, sleepOnBattery: false, sleepLidClosed: true)
        case .alwaysLidClosed: self.init(enabled: true, sleepOnBattery: false, sleepLidClosed: false)
        }
    }

    /// Either spelling off the wire: the object `metistry deployment --json`
    /// reports as `keep_awake_setting`, or one of the four values. A missing
    /// sub-switch takes its safe answer (sleep), as core's schema does; an
    /// object that does not say whether the switch is on is not a setting.
    public init?(json: JSONValue) {
        if let value = json.stringValue {
            guard let setting = KeepAwakeSetting(rawValue: value) else { return nil }
            self.init(setting)
            return
        }
        guard let enabled = json["enabled"]?.boolValue else { return nil }
        self.init(
            enabled: enabled,
            sleepOnBattery: json["sleep_on_battery"]?.boolValue ?? true,
            sleepLidClosed: json["sleep_lid_closed"]?.boolValue ?? true
        )
    }

    /// Absent means the owner was never asked: `never`, the switch off with
    /// both sub-switches at their safe answer.
    public static let unanswered = KeepAwakeSwitches(.never)

    /// The named value this reads as — core's `keepAwakeValue`. The one
    /// setting no value names (on, sleep on battery, lid wanted awake) reads
    /// as `allow_sleep_on_battery`: the lid half is the administrator's.
    public var nearest: KeepAwakeSetting {
        if !enabled { return .never }
        if sleepOnBattery { return .allowSleepOnBattery }
        return sleepLidClosed ? .always : .alwaysLidClosed
    }

    /// Is the lid-closed half asked for — core's `wantsLidClosedAwake`.
    public var wantsLidClosedAwake: Bool { enabled && !sleepLidClosed }

    public subscript(_ which: KeepAwakeSwitch) -> Bool {
        get {
            switch which {
            case .enabled: return enabled
            case .sleepOnBattery: return sleepOnBattery
            case .sleepLidClosed: return sleepLidClosed
            }
        }
        set {
            switch which {
            case .enabled: enabled = newValue
            case .sleepOnBattery: sleepOnBattery = newValue
            case .sleepLidClosed: sleepLidClosed = newValue
            }
        }
    }
}

/// One of the three switches, and the `set-keep-awake` flag that changes only it.
public enum KeepAwakeSwitch: String, CaseIterable, Sendable {
    case enabled
    case sleepOnBattery
    case sleepLidClosed

    /// `packages/cli/src/main.ts`'s `keepAwakeFlags`: each takes `true` or
    /// `false`, never bare — a bare `--sleep-lid-closed` is refused there.
    public var flag: String {
        switch self {
        case .enabled: return "--enabled"
        case .sleepOnBattery: return "--sleep-on-battery"
        case .sleepLidClosed: return "--sleep-lid-closed"
        }
    }

    /// The pane's switch labels, screen-15 §5.2 verbatim.
    public var title: String {
        switch self {
        case .enabled: return "Keep this Mac Awake"
        case .sleepOnBattery: return "Allow sleep on battery"
        case .sleepLidClosed: return "Allow sleep when the lid is closed"
        }
    }

    /// The warning tip each sub-switch carries (C129): what turning it OFF costs.
    public var warning: String? {
        switch self {
        case .enabled: return nil
        case .sleepOnBattery:
            return "Off keeps this Mac awake on battery too. Away from a charger that drains the battery faster."
        case .sleepLidClosed:
            return "Off asks for a closed Mac to stay awake, which only an administrator setting you make yourself delivers. Not recommended."
        }
    }
}

/// The lid dialog's words — core's `LID_CLOSED_*` (power.ts), mirrored. Text for
/// a person to read and copy. Nothing in this app runs either command.
public enum LidClosedDialog {
    public static let title = "Keeping a closed Mac awake needs an administrator setting Metistry will not change for you"
    /// What the owner runs, in Terminal, as an administrator — Copy's text.
    public static let command = "sudo pmset -a disablesleep 1"
    /// How to undo it.
    public static let undo = "sudo pmset -a disablesleep 0"
    /// Said every time the command is.
    public static let warning =
        "Not recommended: it applies to the whole Mac and every app, not only Metistry; it persists across restarts; and it can overheat a laptop in a bag and run the battery flat."
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
    /// While the lid half is asked for: `in effect`, `not in effect` or
    /// `unknown`, from doctor's read of `pmset -g` (P5). `nil` when it is not asked for.
    public let lidClosed: String?

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
        lidClosed = row.meta?["lid_closed"]?.stringValue
    }

    /// The lid switch says *not in effect* until `pmset -g` says it is.
    public var lidClosedInEffect: Bool { lidClosed == "in effect" }

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

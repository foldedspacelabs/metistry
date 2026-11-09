// Recording through a working day — C137 (components-03 §4, plan §2.15):
//
//   every 2 hours   Still recording · 2 hours · Stop Recording · Keep Going
//   10 hours        stops; everything is saved
//   disk low        warning at 10 GB free; stops at 5 GB
//   Mac slept       paused; resumed; the gap is marked in the transcript
//
// Pure: `evaluate` takes the time and the free space and says what must
// happen. The helper calls it on a timer and after a wake; a test calls it
// with a fake clock. The stop is the helper's — not the bar's, not the
// bridge's — so a recording ends at ten hours even if nothing else in
// Metistry is running.

import Foundation

public struct LifecyclePolicy: Equatable {
    public var remindEvery: TimeInterval
    public var maxDuration: TimeInterval
    public var warnBelowFreeBytes: Int64
    public var stopBelowFreeBytes: Int64

    public init(remindEvery: TimeInterval, maxDuration: TimeInterval, warnBelowFreeBytes: Int64, stopBelowFreeBytes: Int64) {
        self.remindEvery = remindEvery
        self.maxDuration = maxDuration
        self.warnBelowFreeBytes = warnBelowFreeBytes
        self.stopBelowFreeBytes = stopBelowFreeBytes
    }

    /// limit: fixed — the owner's ruling (C137, ruled 2026-09-26): reminders
    /// every two hours, a hard stop at ten measured on the wall clock from
    /// Record (a sleep does not extend it), warn at 10 GB free, stop at 5 GB.
    public static let c137 = LifecyclePolicy(
        remindEvery: 2 * 3600,
        maxDuration: 10 * 3600,
        warnBelowFreeBytes: 10 * 1_000_000_000,
        stopBelowFreeBytes: 5 * 1_000_000_000
    )
}

/// Why a session ended — the words `session.json` and the bridge carry.
public enum StopReason: String, Equatable {
    /// The owner pressed Stop.
    case owner
    /// Ten hours (C137).
    case maxDuration = "max_duration"
    /// Under 5 GB free (C137).
    case diskFull = "disk_full"
    /// The helper was not running when it should have been: saved up to the
    /// last write, found at the next start (T8-2b raises the one report).
    case crashed
    /// A stream could not be reopened after the Mac woke.
    case resumeFailed = "resume_failed"
    /// *Window* / *Screen*: the system stopped the picture (the window
    /// closed, the grant was withdrawn). A picture recording with no picture
    /// ends, rather than report a display it no longer has.
    case pictureLost = "picture_lost"
    /// The helper was told to quit (launchd stopping it, a logout): a clean
    /// save, not a crash.
    case helperStopped = "helper_stopped"
}

public enum LifecycleAction: Equatable {
    /// *Still recording · N hours*.
    case remind(hours: Int)
    /// Under the warning line; said once per session.
    case warnDisk(freeBytes: Int64)
    case stop(StopReason)
}

/// What the lifecycle has already said for one session.
public struct LifecycleState: Equatable {
    public let startedAt: Date
    public var remindersRaised: Int = 0
    public var diskWarned: Bool = false

    public init(startedAt: Date) { self.startedAt = startedAt }
}

/// What must happen now. A stop wins: once a stop is due nothing else is said.
/// `freeBytes` nil means the probe could not read the volume — nothing is
/// inferred from that (P5: state is reported, never inferred).
public func evaluate(_ state: inout LifecycleState, now: Date, freeBytes: Int64?, policy: LifecyclePolicy = .c137) -> [LifecycleAction] {
    let elapsed = now.timeIntervalSince(state.startedAt)
    if elapsed >= policy.maxDuration { return [.stop(.maxDuration)] }
    if let free = freeBytes, free < policy.stopBelowFreeBytes { return [.stop(.diskFull)] }

    var actions: [LifecycleAction] = []
    // Every whole interval passed, but never one at or past the stop: the
    // reminders are at 2, 4, 6 and 8 hours, and 10 is the stop itself.
    let due = Int(elapsed / policy.remindEvery)
    while state.remindersRaised < due {
        state.remindersRaised += 1
        let at = Double(state.remindersRaised) * policy.remindEvery
        if at < policy.maxDuration { actions.append(.remind(hours: Int(at / 3600))) }
    }
    if let free = freeBytes, free < policy.warnBelowFreeBytes, !state.diskWarned {
        state.diskWarned = true
        actions.append(.warnDisk(freeBytes: free))
    }
    return actions
}

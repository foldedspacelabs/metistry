// Controlling a recording (design-build-plan §2.2 "device-local", §2.15,
// §2.16). The app talks to the LOCAL live-capture bridge directly — the
// console never starts a recording, and the bridge has no `exposes` entry
// that does (invariant 9): the owner's hand starts one, from the bar. What a
// recording produces reaches Metistry through `POST /capture` like any
// capture (`CaptureStore`).
//
// F-7 freezes the three acts the bar needs; the bridge and its wire are
// T8-2a's, the bar is T8-5's, and the states are `ConsoleBody`-style JSON
// until those tickets type them. An absent bridge is a state, not a failure:
// the bar is hidden entirely (docs/research/2026-09-21-live-capture-bar.md §4b).

import Foundation

public protocol LiveCaptureClient: Sendable {
    /// Recording or idle, the scope, the elapsed time, the grants — the bridge's `check()`.
    func state() async -> Result<LiveCaptureState, LiveCaptureError>
    /// Start recording exactly this scope; the picker's choice is the only filter the helper builds.
    func start(_ scope: LiveCaptureScope) async -> Result<LiveCaptureState, LiveCaptureError>
    /// Stop, and say what was kept.
    func stop() async -> Result<LiveCaptureStopped, LiveCaptureError>
}

/// What a recording may see (C76): one window, one display, or audio only from named apps.
public enum LiveCaptureScope: Sendable, Equatable {
    case window(id: Int)
    case screen(displayID: Int)
    case audioOnly(bundleIDs: [String])
}

public struct LiveCaptureState: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
public struct LiveCaptureStopped: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }

public enum LiveCaptureError: LocalizedError, Equatable {
    /// No bridge on this Mac: hide the bar, say nothing is wrong.
    case absent
    /// The bridge answered and declined, in its own words (a missing grant, a full disk).
    case refused(String)
    /// The bridge did not answer.
    case unreachable(String)

    public var errorDescription: String? {
        switch self {
        case .absent: return "live capture is not set up on this Mac"
        case .refused(let why): return why
        case .unreachable(let why): return why
        }
    }
}

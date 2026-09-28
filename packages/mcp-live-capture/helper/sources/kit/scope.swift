// The ONE path that decides what a recording may hear (plan §2.15, research
// 2026-09-21 §4(a) property 3). *Audio only* is a Core Audio process tap, and
// a process tap is per-process BY CONSTRUCTION: Core Audio mixes only the
// processes its description names, so a tap built from [zoom] cannot produce
// the sound of anything else. The helper's half of that promise is this
// file — the description it builds names the owner's chosen apps and nothing
// else, on every OS version, through one function.
//
// What makes it hold, rather than hoping it holds:
//
//   * `TapPlan` cannot express "everything except". Core Audio offers
//     `…GlobalTapButExcludeProcesses:` and an `exclusive` flag; neither has a
//     representation here, so no caller can ask for one — and an empty scope,
//     which is the one input that could slide into "no filter", is refused
//     before a plan exists (`ScopeError.empty`).
//   * A bundle ID is matched exactly, or as one of the app's own helpers
//     (`com.google.Chrome.helper` under `com.google.Chrome`) — a dot
//     boundary, never a bare prefix, so `us.zoom.xos` never matches
//     `us.zoom.xosfake`. No wildcards: `*` is not a bundle-ID character.
//   * The helper never taps itself.
//
// Pure Foundation: the Core Audio adapter (sources/helper/core-audio.swift)
// turns a plan into a `CATapDescription` and does nothing else with it.

import Foundation

/// One process Core Audio knows about (`kAudioHardwarePropertyProcessObjectList`).
public struct AudioProcess: Equatable, Hashable {
    public let objectID: UInt32
    public let pid: Int32
    public let bundleID: String

    public init(objectID: UInt32, pid: Int32, bundleID: String) {
        self.objectID = objectID
        self.pid = pid
        self.bundleID = bundleID
    }
}

/// The apps the owner chose on the record sheet, validated.
public struct CaptureScope: Equatable {
    public let apps: [String]
}

public enum ScopeError: Error, Equatable {
    /// No app named. Never read as "everything".
    case empty
    /// Not a bundle identifier (reverse-DNS, at least one dot, no wildcard).
    case invalidBundleID(String)
    /// More apps than a meeting has.
    case tooMany(Int)
    /// Below macOS 26 a tap names process objects, so the app must be running.
    case notRunning([String])

    public var message: String {
        switch self {
        case .empty: return "choose at least one app to record — a recording never hears everything"
        case .invalidBundleID(let s): return "\"\(s)\" is not an app's bundle identifier"
        case .tooMany(let n): return "\(n) apps is more than one recording takes (at most \(maxScopeApps))"
        case .notRunning(let ids): return "not running, so nothing to record from yet: \(ids.joined(separator: ", ")) — open it first"
        }
    }
}

/// limit: fixed — a meeting is one or two apps (the call, perhaps a browser);
/// the record sheet offers a list, not a filter language.
public let maxScopeApps = 16

/// Reverse-DNS: two or more labels of letters, digits and hyphens. `*`, `?`
/// and spaces are not bundle-ID characters, so no pattern can pass as one.
private let bundleIDShape = try! NSRegularExpression(pattern: "^[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+$")

public func isBundleID(_ s: String) -> Bool {
    s.count <= 255 && bundleIDShape.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
}

/// The owner's list, checked. Duplicates collapse; order is kept for display.
public func validateScope(_ apps: [String]) throws -> CaptureScope {
    var seen = Set<String>()
    var out: [String] = []
    for raw in apps {
        let id = raw.trimmingCharacters(in: .whitespaces)
        guard isBundleID(id) else { throw ScopeError.invalidBundleID(raw) }
        if seen.insert(id).inserted { out.append(id) }
    }
    guard !out.isEmpty else { throw ScopeError.empty }
    guard out.count <= maxScopeApps else { throw ScopeError.tooMany(out.count) }
    return CaptureScope(apps: out)
}

/// True when `bundleID` is `app` itself or one of its own helper processes.
public func belongs(_ bundleID: String, to app: String) -> Bool {
    bundleID == app || bundleID.hasPrefix(app + ".")
}

/// What the Core Audio adapter builds a tap from. Inclusive only.
public struct TapPlan: Equatable {
    public enum Mode: String, Equatable {
        /// macOS 26: `CATapDescription.bundleIDs`, so an app that restarts
        /// mid-meeting rejoins the tap (and one not yet open can be named).
        case bundleIDs = "bundle_ids"
        /// macOS 14.2–15: `processes:` — the object IDs running now.
        case processes
    }

    public let mode: Mode
    /// The process objects to mix, sorted. Set in both modes: on macOS 26
    /// the adapter hands both to Core Audio.
    public let processObjectIDs: [UInt32]
    /// The exact bundle IDs to mix, sorted — the owner's apps plus the helper
    /// processes of theirs that are running.
    public let bundleIDs: [String]
    /// The running processes the plan covers, for the status read-back.
    public let matched: [AudioProcess]
}

/// Build the tap plan for `scope` from what is running. The only function in
/// the helper that decides what a recording hears.
public func planTap(scope: CaptureScope, running: [AudioProcess], bundleIDTaps: Bool, ownBundleID: String) throws -> TapPlan {
    let matched = running
        .filter { p in !belongs(p.bundleID, to: ownBundleID) && scope.apps.contains { belongs(p.bundleID, to: $0) } }
        .sorted { $0.objectID < $1.objectID }
    if bundleIDTaps {
        let ids = Set(scope.apps.filter { !belongs($0, to: ownBundleID) } + matched.map(\.bundleID))
        guard !ids.isEmpty else { throw ScopeError.empty }
        return TapPlan(mode: .bundleIDs, processObjectIDs: matched.map(\.objectID), bundleIDs: ids.sorted(), matched: matched)
    }
    guard !matched.isEmpty else { throw ScopeError.notRunning(scope.apps) }
    return TapPlan(
        mode: .processes,
        processObjectIDs: matched.map(\.objectID),
        bundleIDs: Array(Set(matched.map(\.bundleID))).sorted(),
        matched: matched
    )
}

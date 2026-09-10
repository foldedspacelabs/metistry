// What the Updates pane and the menu bar know about updating, with no Sparkle
// in sight.
//
// Sparkle is a macOS framework and it owns its own preferences
// (`SUEnableAutomaticChecks`, `SULastCheckTime`, `SUAutomaticallyUpdate` — read
// and written by the framework, never by us; the app's own defaults are the
// three in `AppPreference`). So the kit holds a plain observable box, and the
// executable target's Sparkle controller fills it in and supplies the two
// actions as closures. An iOS target hands over a box whose `checkNow` opens the
// App Store, and no view changes.
//
// The other half of updating is the product runtime, which does NOT come through
// Sparkle: that is `metistry update` in release mode (docs/ops/releases.md).
// Two channels, both signed, on purpose — the pane says so.

import Foundation
import Observation

@MainActor
@Observable
public final class UpdateStatus {
    /// This app's version — `CFBundleShortVersionString`. "(dev build)" when the
    /// executable is running outside a bundle.
    public var appVersion: String
    /// The appcast this app checks. One feed today, so one channel; it is read
    /// from `Info.plist` rather than named here so the app cannot disagree with
    /// the workflow that signs the feed.
    public var feedURL: String?
    public var channel: String
    public var automaticChecksEnabled: Bool = true
    public var lastCheckedAt: Date?
    /// Set by Sparkle's delegate when a check finds something. Drives the menu's
    /// "Update Available: x.y.z" item, which only appears when there is one.
    public var availableVersion: String?
    public var canCheck: Bool = false

    /// Supplied by the platform. Defaults do nothing, which is what a unit test
    /// and a not-yet-wired iOS target both want.
    public var checkNow: @MainActor () -> Void = {}
    public var setAutomaticChecks: @MainActor (Bool) -> Void = { _ in }

    public init(
        appVersion: String,
        feedURL: String? = nil,
        channel: String = "stable",
        automaticChecksEnabled: Bool = true,
        canCheck: Bool = false
    ) {
        self.appVersion = appVersion
        self.feedURL = feedURL
        self.channel = channel
        self.automaticChecksEnabled = automaticChecksEnabled
        self.canCheck = canCheck
    }

    public static let devBuildVersion = "(dev build)"
}

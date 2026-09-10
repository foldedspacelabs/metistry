// Everything the app itself remembers — and it is a short list on purpose.
//
// THE RULE (owner direction 2026-09-09): every setting in this app is a front
// for a file the CLI owns. `identity.yaml` names the assistant, `deployment.yaml`
// says which shape the services run in, `.env` and the login Keychain hold the
// secrets, `metistry.lock` pins the product. None of them is duplicated here,
// and none of them is written by this app: the first two are §4.7 protected
// paths (the user's own hand), and the last two have `metistry` verbs.
//
// So the app persists three things, all of them POINTERS rather than
// configuration:
//
//   activeInstance             which install the app is looking at
//   recentInstances            the ones it looked at before, for the menu
//   developerProductDirectory  a product checkout, for a build with no runtime
//                              bundled inside it (Advanced; see below)
//
// plus Sparkle's own preferences, which Sparkle owns and reads itself.
//
// WHAT WAS REMOVED. The scaffold's `productDirectory` was a *preference*: the
// app asked where the product was, and the answer was the first thing first run
// wanted. It is gone. A shipped app's product is the runtime inside its own
// bundle, so there is nothing to ask; the only build that needs an answer is a
// developer's, and that override now lives in Advanced under its own key. An
// existing value is migrated once, so a developer who set it does not have to
// find the folder again.

import Foundation
import Observation

/// The only keys this app writes. A test asserts that nothing else appears in
/// its defaults domain — the list is the contract, not a comment.
public enum AppPreference: String, CaseIterable, Sendable {
    case activeInstance
    case recentInstances
    case developerProductDirectory

    /// The scaffold's key, read once and removed (see the file header).
    public static let legacyProductDirectory = "productDirectory"
}

/// The active instance and the ones before it.
///
/// A "recent" is a path, not a security-scoped bookmark: the app is not
/// sandboxed (`apps/macos/resources/metistry.entitlements` explains at length
/// why not — it drives an installer), so a path it can read today it can read
/// tomorrow. If the app is ever sandboxed this is where bookmarks go, and the
/// type boundary is already here.
@MainActor
@Observable
public final class InstanceBookmarks {
    /// How many recents the Instance pane and the wizard offer. Long enough to
    /// cover a work install, a personal one and a scratch one; short enough that
    /// the list is read rather than searched.
    public static let recentsLimit = 8

    private let defaults: UserDefaults

    public private(set) var active: URL?
    public private(set) var recents: [URL] = []

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        active = defaults.string(forKey: AppPreference.activeInstance.rawValue).map { URL(fileURLWithPath: $0) }
        recents = (defaults.stringArray(forKey: AppPreference.recentInstances.rawValue) ?? []).map { URL(fileURLWithPath: $0) }
        // An active instance that never made it into recents (a defaults domain
        // written by hand, or an older build) belongs there.
        if let active, !recents.contains(where: { $0.path == active.path }) {
            recents.insert(active, at: 0)
            persistRecents()
        }
    }

    /// Make `url` the active instance, most-recent-first, no duplicates.
    public func activate(_ url: URL) {
        let url = url.standardizedFileURL
        active = url
        recents.removeAll { $0.path == url.path }
        recents.insert(url, at: 0)
        if recents.count > Self.recentsLimit { recents.removeLast(recents.count - Self.recentsLimit) }
        defaults.set(url.path, forKey: AppPreference.activeInstance.rawValue)
        persistRecents()
    }

    /// Forget one. Forgetting the active instance leaves the app with none,
    /// which is the state the first-launch wizard exists for — it is not an
    /// error.
    public func forget(_ url: URL) {
        recents.removeAll { $0.path == url.path }
        if active?.path == url.standardizedFileURL.path {
            active = nil
            defaults.removeObject(forKey: AppPreference.activeInstance.rawValue)
        }
        persistRecents()
    }

    public func clearActive() {
        active = nil
        defaults.removeObject(forKey: AppPreference.activeInstance.rawValue)
    }

    private func persistRecents() {
        defaults.set(recents.map(\.path), forKey: AppPreference.recentInstances.rawValue)
    }
}

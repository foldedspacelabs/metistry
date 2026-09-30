// Everything the app itself remembers — and it is a short list on purpose.
//
// THE RULE (owner direction 2026-09-09): every setting in this app is a front
// for a file the CLI owns. `identity.yaml` names the assistant, `deployment.yaml`
// says which shape the services run in, `.env` and the login Keychain hold the
// secrets, `metistry.lock` pins the product. None of them is duplicated here,
// and none of them is written by this app: the first two are §4.7 protected
// paths (the user's own hand), and the last two have `metistry` verbs.
//
// So the app persists four things, all of them POINTERS rather than
// configuration:
//
//   activeInstance             which install the app is looking at
//   recentInstances            the ones it looked at before, for the menu
//   developerProductDirectory  a product checkout, for a build with no runtime
//                              bundled inside it (Advanced; see below)
//   pinnedItems.<instance_id>  the sidebar's Pinned area, per instance
//
// and TWO settings that front no file, because none can exist — plan §2.2
// makes both device-local, "no CLI and no API":
//
//   anyAppShortcuts            the switch and keys of Settings ▸ Keyboard's
//                              shortcuts in any app (T6-16)
//   captureBar                 the floating capture bar's switch, which edge it
//                              sits on and which display (screen-11 §8, T6-15;
//                              docs/ops/client-api.md, "Device-local")
//
// plus Sparkle's own preferences, which Sparkle owns and reads itself, and one
// FILE, not a default (owner ruling 19, 2026-09-27 — see `AppFileStore`
// below): the offline capture queue, because unsent work is not a setting.
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
    /// A PREFIX, never a key on its own: the sidebar's pins are filed under
    /// `pinnedItems.<instance_id>`, because a pin points at a project, page,
    /// saved search or agent in ONE instance (app-ux-plan.md §3.4). Still a
    /// pointer rather than configuration — the pinned object lives where it
    /// always did, and losing the list costs one drag (pinned-items.swift).
    case pinnedItemsPrefix = "pinnedItems"
    /// Settings ▸ Keyboard's switch and the five keys under it (T6-16,
    /// hotkeys.swift). The one entry here that is configuration rather than a
    /// pointer, and deliberately so: plan §2.2 lists global hot keys as
    /// device-local, "no CLI and no API", so there is no file the CLI owns
    /// for them to front. Written only when the owner changes one.
    case anyAppShortcuts
    /// The floating capture bar: on or off, which edge, which display
    /// (`CaptureBarPreferences` below). Written only when the owner changes
    /// one of the three, so an untouched app's domain never holds it.
    case captureBar

    /// The scaffold's key, read once and removed (see the file header).
    public static let legacyProductDirectory = "productDirectory"
}

// MARK: - The capture bar's placement (screen-11 §8, T6-15)

/// Which edge the bar rests on. Top and bottom are not offered — the menu bar
/// owns the top, the Dock and the system's own recording pill the bottom
/// (screen-11 §8) — so the type cannot hold them.
public enum CaptureBarEdge: String, Codable, CaseIterable, Sendable, Identifiable {
    case left, right

    public var id: String { rawValue }

    /// Title Case — the control's spoken name.
    public var title: String {
        switch self {
        case .left: return "Left edge"
        case .right: return "Right edge"
        }
    }
}

/// What Settings ▸ Live Capture stores and the bar (T8-5) reads: whether the
/// surface is on at all, which edge, which display. Nothing here is a
/// recording setting — the recorder has none this app could hold.
public struct CaptureBarPlacement: Equatable, Sendable {
    /// The bar is drawn at all. Distinct from the bridge being absent, which
    /// hides the bar whatever this says.
    public var enabled: Bool
    public var edge: CaptureBarEdge
    /// `NSScreen`'s display id, as the platform hands it in; nil is the main
    /// display — a display that is unplugged falls back to it.
    public var displayID: Int?

    public init(enabled: Bool = true, edge: CaptureBarEdge = .right, displayID: Int? = nil) {
        self.enabled = enabled
        self.edge = edge
        self.displayID = displayID
    }

    static let enabledKey = "enabled", edgeKey = "edge", displayKey = "display_id"

    /// The defaults dictionary, readable by hand: `{enabled, edge, display_id?}`.
    var dictionary: [String: Any] {
        var d: [String: Any] = [Self.enabledKey: enabled, Self.edgeKey: edge.rawValue]
        if let displayID { d[Self.displayKey] = displayID }
        return d
    }

    init?(dictionary: [String: Any]?) {
        guard let dictionary else { return nil }
        self.init(
            enabled: dictionary[Self.enabledKey] as? Bool ?? true,
            edge: (dictionary[Self.edgeKey] as? String).flatMap(CaptureBarEdge.init(rawValue:)) ?? .right,
            displayID: dictionary[Self.displayKey] as? Int
        )
    }
}

/// The one defaults key the bar's placement lives under. Read at launch,
/// written on change; a missing or unreadable value is the default placement,
/// never a crash.
@MainActor
@Observable
public final class CaptureBarPreferences {
    private let defaults: UserDefaults
    public private(set) var placement: CaptureBarPlacement

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        placement = CaptureBarPlacement(dictionary: defaults.dictionary(forKey: AppPreference.captureBar.rawValue)) ?? CaptureBarPlacement()
    }

    public func setEnabled(_ on: Bool) {
        guard placement.enabled != on else { return }
        placement.enabled = on
        persist()
    }

    public func setEdge(_ edge: CaptureBarEdge) {
        guard placement.edge != edge else { return }
        placement.edge = edge
        persist()
    }

    public func setDisplay(_ id: Int?) {
        guard placement.displayID != id else { return }
        placement.displayID = id
        persist()
    }

    private func persist() {
        defaults.set(placement.dictionary, forKey: AppPreference.captureBar.rawValue)
    }
}

/// The one approved exception to the rule above (owner ruling 19,
/// 2026-09-27): a store beyond this allowlist, because the offline capture
/// queue (T5-5's `CaptureComposerModel`, persisted by
/// `stores/capture-store.swift`'s `JSONCaptureQueueStore`) is unsent work,
/// not a setting — a `UserDefaults` domain is not where that belongs. A FILE,
/// not a key, so it is named here rather than added to `AppPreference`:
/// adding it there would make `settings-model-tests.swift`'s "nothing else
/// appears in this defaults domain" assertion false for the wrong reason.
public enum AppFileStore {
    /// Under this app's own Application Support directory — never the
    /// instance's, which is a vault, not app state.
    public static let captureQueueFilename = "capture-queue.json"
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
    /// cover a second install, a personal one and a scratch one; short enough that
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

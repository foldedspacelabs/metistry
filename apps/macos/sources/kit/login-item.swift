// Start at login: `SMAppService.mainApp`, and only the app itself.
//
// The scaffold's Services pane carried a disabled toggle and a paragraph
// explaining that `SMAppService` needed a `metistry up` that hands the app its
// job set. That conflated two different registrations, and this file separates
// them:
//
//   THE APP as a login item — `SMAppService.mainApp`. One call, one approval in
//   System Settings › General › Login Items, nothing to write, and no CLI change
//   at all. That is what this is, and it is real.
//
//   THE LAUNCHD AGENTS — `metistry up` renders them into ~/Library/LaunchAgents
//   and bootstraps them, exactly as the terminal path does. Moving those under
//   `SMAppService.agent(plistName:)` would mean their plists live INSIDE
//   `Metistry.app/Contents/Library/LaunchAgents`, signed with the app and
//   therefore unwritable and bundle-relative — which is a different product
//   (the jobs would be the app's, not the install's, and one app could not serve
//   several instance directories). It is recorded as the follow-up in
//   docs/product/desktop-app-plan.md and deliberately NOT attempted here:
//   `metistry up` owns those jobs.
//
// The kit holds the state machine and the prose; `ServiceManagement` itself is
// macOS-only, so the call lives in the executable target behind
// `LoginItemService` (MetistryKit stays free of AppKit and of platform
// frameworks, so an iOS target shares every model unchanged).

import Foundation
import Observation

/// `SMAppService.Status`, as the app has to talk about it.
///
/// The raw values are Apple's (`SMAppService.Status` is an `Int`-backed
/// `NSInteger` enum: 0 notRegistered, 1 enabled, 2 requiresApproval, 3
/// notFound). Mapping them here rather than in the executable target is what
/// makes the mapping testable without a signed bundle to register — and a value
/// Apple adds later becomes `unknown(n)` and says so, instead of being rounded
/// to "off" (design-system P5 — state is reported, never inferred).
public enum LoginItemStatus: Sendable, Equatable {
    case notRegistered
    case enabled
    case requiresApproval
    case notFound
    case unknown(Int)

    public init(rawValue: Int) {
        switch rawValue {
        case 0: self = .notRegistered
        case 1: self = .enabled
        case 2: self = .requiresApproval
        case 3: self = .notFound
        default: self = .unknown(rawValue)
        }
    }

    /// Whether the app is registered at all. `requiresApproval` IS registered —
    /// macOS is holding it, waiting for the person — so the toggle reads on and
    /// the row explains what is outstanding, rather than the toggle flicking
    /// back off and looking broken.
    public var isRegistered: Bool {
        switch self {
        case .enabled, .requiresApproval: return true
        case .notRegistered, .notFound, .unknown: return false
        }
    }

    public var needsApproval: Bool { self == .requiresApproval }

    /// One sentence, sentence case — it is prose, not a name (design-system P10).
    public var label: String {
        switch self {
        case .enabled:
            return "on — macOS launches Metistry when you log in"
        case .requiresApproval:
            return "registered, but waiting for you: approve in System Settings › General › Login Items"
        case .notRegistered:
            return "off — Metistry only runs when you open it"
        case .notFound:
            return "unavailable — macOS has no registration for this build"
        case .unknown(let raw):
            return "macOS reported a status this app does not know (SMAppService.Status \(raw))"
        }
    }

    public var colorRole: MetistryColorRole {
        switch self {
        case .enabled: return .ok
        case .requiresApproval: return .degraded
        case .notRegistered: return .absent
        case .notFound, .unknown: return .failed
        }
    }
}

/// The seam. `SMAppService` lives in `ServiceManagement`, which the kit does not
/// import; the executable target supplies this.
public protocol LoginItemService: Sendable {
    /// `SMAppService.mainApp.status`.
    func currentStatus() -> LoginItemStatus
    /// `SMAppService.mainApp.register()`.
    func register() throws
    /// `SMAppService.mainApp.unregister()`.
    func unregister() throws
    /// `SMAppService.openSystemSettingsLoginItems()`.
    func openSystemSettings()
}

@MainActor
@Observable
public final class LoginItemModel {
    /// Registering the app requires it to BE an app: `SMAppService.mainApp` on a
    /// raw `swift build` executable has no bundle to register and answers
    /// `notFound`. The pane says exactly that rather than "failed".
    public nonisolated static let notAnAppBundleNote =
        "`swift build` alone produces an executable, not an app bundle — there is nothing for macOS to register. "
        + "Build a real Metistry.app with ops/release/build-app.sh."

    /// What §4.7 and invariant 2 have to say about this toggle: nothing. It
    /// writes no file the CLI owns — macOS keeps the registration itself, which
    /// is the whole reason to prefer it to a plist of ours.
    public nonisolated static let note =
        "This registers Metistry itself as a login item through SMAppService — macOS keeps the registration, "
        + "so there is no plist to edit and nothing of ours to keep in sync. It does NOT start the install's services: "
        + "those are the launchd jobs `metistry up` owns, and they already start at login on their own."

    private let service: (any LoginItemService)?

    public private(set) var status: LoginItemStatus
    /// The last register/unregister failure, verbatim. Not cleared by a refresh
    /// that succeeds at reading a status — the write is what failed.
    public private(set) var lastError: String?

    public init(service: (any LoginItemService)?) {
        self.service = service
        self.status = service?.currentStatus() ?? .notFound
    }

    /// `nil` on a platform with no `SMAppService` — the pane disables the toggle
    /// and says why, rather than showing one that does nothing.
    public var isSupported: Bool { service != nil }

    public var isOn: Bool { status.isRegistered }

    public func refresh() {
        guard let service else { return }
        status = service.currentStatus()
    }

    /// Turn it on or off. The status is re-read from macOS afterwards rather than
    /// assumed from the call returning: `register()` succeeding and the status
    /// being `requiresApproval` is the normal first-time path, and a toggle that
    /// asserted `.enabled` there would be lying.
    public func set(_ on: Bool) {
        guard let service else { return }
        lastError = nil
        do {
            if on { try service.register() } else { try service.unregister() }
        } catch {
            lastError = error.localizedDescription
        }
        status = service.currentStatus()
    }

    public func openSystemSettings() {
        service?.openSystemSettings()
    }
}

// The ONE background item, registered by the app:
// `SMAppService.agent(plistName: "com.foldedspacelabs.metistry.plist")`.
//
// This is the second of two registrations, and the two are not the same thing
// (login-item.swift is the first):
//
//   THE APP as a login item — `SMAppService.mainApp`. "Open Metistry when I log
//   in." It starts a window, not a service.
//
//   THE INSTALL'S SUPERVISOR — this file. Postgres, the console, the
//   reconciler, the assistant and any configured bridge run as its children
//   (docs/ops/deployment-shapes.md, "One background item, called Metistry"),
//   and it is the thing that has to be running for anything to be collected,
//   remembered or answered while no window is open.
//
// WHY THE APP REGISTERS IT AT ALL. `metistry up` can install the same agent
// itself, by writing the plist into `~/Library/LaunchAgents` and bootstrapping
// it with `launchctl` — and for a terminal install that is exactly what still
// happens. But an item bootstrapped that way is nobody's: System Settings ›
// General › Login Items lists it beside the app, under whatever its program is
// called, with no way to turn it off except a terminal. Registered through
// `SMAppService.agent(plistName:)` it is THE APP'S — one row, "Metistry", with
// the agent nested underneath, attributed to Folded Space Labs, and a toggle
// in both System Settings and this app that means the same thing.
//
// WHAT THE APP DOES NOT GAIN BY THIS. It still installs nothing and writes
// nothing of its own: the plist it registers is the one sealed inside the
// bundle at build time, and everything install-specific — which instance, which
// node, which product tree — lives in files `metistry up --register-via app`
// wrote (docs/ops/mac-app.md). The app's whole part is register/unregister and
// reporting what macOS says. Invariant 2 is untouched: this toggle is a
// registration macOS keeps, not a file the CLI owns.
//
// `ServiceManagement` is macOS-only, so the four calls live in the executable
// target behind this protocol; MetistryKit stays free of platform frameworks.

import Foundation
import Observation

/// The seam. Same four calls as `LoginItemService`, a different registration:
/// `SMAppService.agent(plistName:)` rather than `SMAppService.mainApp`.
public protocol BackgroundAgentService: Sendable {
    /// `SMAppService.agent(plistName: BackgroundAgentModel.plistName).status`.
    func currentStatus() -> LoginItemStatus
    /// `…register()`. Throws what `SMAppService` throws, verbatim.
    func register() throws
    /// `…unregister()`.
    func unregister() throws
    /// `SMAppService.openSystemSettingsLoginItems()`.
    func openSystemSettings()
}

@MainActor
@Observable
public final class BackgroundAgentModel {
    /// The file `SMAppService.agent(plistName:)` looks for, at exactly one
    /// path: `Metistry.app/Contents/Library/LaunchAgents/<this>`.
    /// `ops/release/build-app.sh` puts it there and a release-tooling test
    /// holds the two to the same name.
    public nonisolated static let plistName = "com.foldedspacelabs.metistry.plist"

    /// The launchd label inside it — the same one `metistry up` renders, the
    /// same one `metistry doctor` probes. Only ever ONE of the two registrars
    /// owns it (docs/ops/deployment-shapes.md, "Two registrars").
    public nonisolated static let label = "com.foldedspacelabs.metistry"

    /// The row's title. Sentence case, because it says something rather than
    /// naming something (design-system P10).
    public nonisolated static let title = "Run Metistry in the background"

    /// What this toggle is, and — as importantly — what it is not.
    public nonisolated static let note =
        "This is the install's services: Postgres, the console, the reconciler, the assistant and any bridge you have configured, "
        + "all running under one launchd agent that macOS lists as a single background item. Turning it off stops them; "
        + "it does not uninstall anything, and nothing in your instance directory is touched. "
        + "The setting above it, Start at login, is a different thing — that one just opens this window."

    /// A `swift build` executable has no `Contents/Library/LaunchAgents` to
    /// register from, so macOS answers `notFound`. Said plainly, the same way
    /// the login-item row says it, rather than reported as a failure.
    public nonisolated static let notAnAppBundleNote =
        "`swift build` alone produces an executable, not an app bundle — there is no "
        + "Contents/Library/LaunchAgents/\(plistName) for macOS to register. "
        + "Build a real Metistry.app with ops/release/build-app.sh."

    /// What a terminal install does instead. Shown when there is no bundled
    /// agent to register, so the row is never a dead end.
    public nonisolated static let terminalNote =
        "A terminal install registers the same agent itself: `metistry up` writes the plist to ~/Library/LaunchAgents and "
        + "bootstraps it with launchctl. Either registrar works and only one is ever used — `metistry doctor` says which owns it."

    private let service: (any BackgroundAgentService)?

    public private(set) var status: LoginItemStatus
    /// The last register/unregister failure, verbatim. A later refresh that
    /// reads a status does not clear it — the write is what failed.
    public private(set) var lastError: String?

    public init(service: (any BackgroundAgentService)?) {
        self.service = service
        self.status = service?.currentStatus() ?? .notFound
    }

    /// `nil` on a platform with no `SMAppService` — the row is disabled and
    /// says why, rather than offering a toggle that does nothing.
    public var isSupported: Bool { service != nil }

    /// Whether THIS BUILD has an agent to register at all — the thing that
    /// decides whether the app's `metistry up` should say `--register-via app`.
    /// `notFound` is macOS answering "no such service in that bundle", which
    /// is the honest answer for a raw `swift build` executable.
    public var bundlesAgent: Bool { isSupported && status != .notFound }

    /// `requiresApproval` reads as ON, the same as the login item's: macOS has
    /// the registration and is waiting for the person, and a toggle that
    /// flicked back off there would look broken when nothing is wrong.
    public var isOn: Bool { status.isRegistered }

    public var needsApproval: Bool { status.needsApproval }

    /// One sentence about the SERVICES, not about the app. The login item's
    /// own prose would be wrong here ("macOS launches Metistry when you log
    /// in" is not what this registers), so the two rows say different things.
    public var statusLabel: String {
        switch status {
        case .enabled:
            return "on — your install runs in the background and starts with your Mac"
        case .requiresApproval:
            return "registered, but waiting for you: allow it in System Settings › General › Login Items"
        case .notRegistered:
            return "off — nothing of yours is running in the background"
        case .notFound:
            return "unavailable — this build has no background agent to register"
        case .unknown(let raw):
            return "macOS reported a status this app does not know (SMAppService.Status \(raw))"
        }
    }

    public var colorRole: MetistryColorRole { status.colorRole }

    public func refresh() {
        guard let service else { return }
        status = service.currentStatus()
    }

    /// Turn it on or off, then ask macOS what actually happened. `register()`
    /// returning and the status being `requiresApproval` is the normal first
    /// time; asserting `.enabled` there would be a lie.
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

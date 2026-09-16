// `SMAppService`, the calls of it this app makes — two registrations, kept
// apart because they are two different promises.
//
// It lives in the executable target because `ServiceManagement` is macOS-only
// and MetistryKit is shared with an iOS target that has no such thing. The kit
// holds the status mapping and the prose (login-item.swift,
// background-agent.swift); this is the seam.
//
// `SMAppService.mainApp` registers THIS APP as a login item: it opens a window
// when you log in, and starts nothing. `SMAppService.agent(plistName:)`
// registers the install's ONE background item — the supervisor, and therefore
// every service under it — from the plist sealed inside
// `Contents/Library/LaunchAgents`. A terminal install registers the same-named
// agent with `launchctl bootstrap` instead, and `metistry up` detects which
// registrar owns it so the two are never both loaded
// (docs/ops/deployment-shapes.md, "Two registrars").

import Foundation
import MetistryKit
import ServiceManagement

struct SMAppServiceLoginItem: LoginItemService {
    /// `SMAppService.Status` is `Int`-backed, and the kit maps the raw value so
    /// the mapping is testable without a signed bundle to register.
    func currentStatus() -> LoginItemStatus {
        LoginItemStatus(rawValue: SMAppService.mainApp.status.rawValue)
    }

    func register() throws {
        try SMAppService.mainApp.register()
    }

    func unregister() throws {
        try SMAppService.mainApp.unregister()
    }

    /// Apple's own deep link to General › Login Items — better than an
    /// `x-apple.systempreferences:` URL of ours, which is an implementation
    /// detail of one macOS version.
    func openSystemSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }
}

/// The install's supervisor, registered from the bundle.
///
/// `SMAppService.agent(plistName:)` resolves exactly one path —
/// `Contents/Library/LaunchAgents/<plistName>` — and answers `notFound` when
/// there is nothing there, which is what a raw `swift build` executable gets
/// and what the kit's row explains. Nothing is copied, nothing is written: the
/// plist is the one sealed into the signature at build time.
struct SMAppServiceBackgroundAgent: BackgroundAgentService {
    private var agent: SMAppService { SMAppService.agent(plistName: BackgroundAgentModel.plistName) }

    func currentStatus() -> LoginItemStatus {
        LoginItemStatus(rawValue: agent.status.rawValue)
    }

    func register() throws {
        try agent.register()
    }

    func unregister() throws {
        try agent.unregister()
    }

    func openSystemSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }
}

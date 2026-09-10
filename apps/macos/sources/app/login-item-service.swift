// `SMAppService`, the four calls of it this app makes.
//
// It lives in the executable target because `ServiceManagement` is macOS-only
// and MetistryKit is shared with an iOS target that has no such thing. The kit
// holds the status mapping and the prose (login-item.swift); this is the seam.
//
// `SMAppService.mainApp` registers THIS APP as a login item. It does not
// register the install's launchd jobs — `metistry up` owns those, and moving
// them here would make them the app's rather than the install's. The plan doc
// records what that would take.

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

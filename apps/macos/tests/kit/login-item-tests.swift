// Start at login: the SMAppService status mapping, and the one behaviour that
// makes the toggle trustworthy — the status is always re-read from macOS, never
// assumed from the call returning.

import Foundation
import Testing

@testable import MetistryKit

@Test func everySMAppServiceStatusMapsToSomethingTheToggleCanSay() {
    // Apple's raw values, in order (SMAppService.Status is Int-backed).
    #expect(LoginItemStatus(rawValue: 0) == .notRegistered)
    #expect(LoginItemStatus(rawValue: 1) == .enabled)
    #expect(LoginItemStatus(rawValue: 2) == .requiresApproval)
    #expect(LoginItemStatus(rawValue: 3) == .notFound)
    // A value Apple adds later is reported, not rounded to "off".
    #expect(LoginItemStatus(rawValue: 4) == .unknown(4))
    #expect(LoginItemStatus(rawValue: 4).label.contains("4"))

    for raw in 0...4 {
        #expect(!LoginItemStatus(rawValue: raw).label.isEmpty)
    }
}

@Test func requiresApprovalIsRegisteredSoTheToggleStaysOn() {
    // The first-time path: register() succeeds and macOS holds it until the
    // person allows it. A toggle that flicked back off here would read as broken
    // when nothing is wrong.
    #expect(LoginItemStatus.requiresApproval.isRegistered)
    #expect(LoginItemStatus.requiresApproval.needsApproval)
    #expect(LoginItemStatus.requiresApproval.colorRole == .degraded)
    #expect(LoginItemStatus.requiresApproval.label.contains("System Settings"))

    #expect(LoginItemStatus.enabled.isRegistered)
    #expect(!LoginItemStatus.enabled.needsApproval)
    #expect(!LoginItemStatus.notRegistered.isRegistered)
    // notRegistered is `absent` — off is a state, not a fault (§3.13).
    #expect(LoginItemStatus.notRegistered.colorRole == .absent)
    // notFound is: macOS has no registration for this build at all.
    #expect(LoginItemStatus.notFound.colorRole == .failed)
}

@MainActor
@Test func theToggleReportsWhatMacOSSaysAfterwardsNotWhatItAskedFor() {
    // register() succeeds and the status becomes requiresApproval — the normal
    // first time. The model must show that, not `.enabled`.
    let service = FakeLoginItemService(status: .notRegistered, afterRegister: .requiresApproval)
    let model = LoginItemModel(service: service)
    #expect(!model.isOn)

    model.set(true)
    #expect(service.registered == 1)
    #expect(model.status == .requiresApproval)
    #expect(model.isOn)
    #expect(model.lastError == nil)

    model.set(false)
    #expect(service.unregistered == 1)
    #expect(model.status == .notRegistered)
    #expect(!model.isOn)
}

@MainActor
@Test func aRefusedRegistrationIsReportedVerbatimAndTheStatusIsStillRead() {
    let service = FakeLoginItemService(status: .notRegistered, registerError: "Operation not permitted")
    let model = LoginItemModel(service: service)
    model.set(true)
    #expect(model.lastError == "Operation not permitted")
    // Still off, because macOS still says so — the error did not become a state.
    #expect(!model.isOn)
}

@MainActor
@Test func withNoServiceTheToggleIsDisabledRatherThanInert() {
    let model = LoginItemModel(service: nil)
    #expect(!model.isSupported)
    #expect(model.status == .notFound)
    // Nothing happens, and nothing pretends to.
    model.set(true)
    #expect(!model.isOn)
    #expect(model.lastError == nil)
}

@Test func theNoteSaysWhatThisDoesNotDo() {
    // The whole reason this shipped and the launchd agents did not: registering
    // the APP is one call with no CLI change; registering the install's jobs
    // would move ownership of them out of `metistry up`.
    #expect(LoginItemModel.note.contains("SMAppService"))
    #expect(LoginItemModel.note.contains("metistry up"))
    #expect(LoginItemModel.notAnAppBundleNote.contains("build-app.sh"))
}

private final class FakeLoginItemService: LoginItemService, @unchecked Sendable {
    private var status: LoginItemStatus
    private let afterRegister: LoginItemStatus
    private let registerError: String?
    private(set) var registered = 0
    private(set) var unregistered = 0
    private(set) var openedSettings = 0

    init(status: LoginItemStatus, afterRegister: LoginItemStatus = .enabled, registerError: String? = nil) {
        self.status = status
        self.afterRegister = afterRegister
        self.registerError = registerError
    }

    func currentStatus() -> LoginItemStatus { status }

    func register() throws {
        registered += 1
        if let registerError { throw NSError(domain: "SMAppServiceErrorDomain", code: 1, userInfo: [NSLocalizedDescriptionKey: registerError]) }
        status = afterRegister
    }

    func unregister() throws {
        unregistered += 1
        status = .notRegistered
    }

    func openSystemSettings() { openedSettings += 1 }
}

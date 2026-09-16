// The install's ONE background item, as the app registers it:
// `SMAppService.agent(plistName:)` behind a fake, so every state the toggle can
// be in is exercised without registering anything on the machine running the
// tests. (Registering for real is the one thing these tests must never do —
// it would install a launchd agent on a developer's Mac.)

import Foundation
import Testing

@testable import MetistryKit

@MainActor
@Test func theFirstTimeIsRegisterThenWaitForApprovalAndTheRowSaysSo() {
    // A fresh Mac: the bundled agent exists, nothing has registered it yet.
    let service = FakeBackgroundAgent(status: .notRegistered, afterRegister: .requiresApproval)
    let model = BackgroundAgentModel(service: service)
    #expect(model.isSupported)
    #expect(model.bundlesAgent)
    #expect(!model.isOn)
    #expect(model.statusLabel.contains("off"))

    model.set(true)
    #expect(service.registered == 1)
    // requiresApproval IS registered: macOS is holding it, waiting for the
    // person, so the toggle stays on and the row explains what is outstanding.
    #expect(model.status == .requiresApproval)
    #expect(model.isOn)
    #expect(model.needsApproval)
    #expect(model.colorRole == .degraded)
    #expect(model.statusLabel.contains("System Settings"))
    #expect(model.lastError == nil)

    // …the person allows it in Login Items and comes back.
    service.setStatus(.enabled)
    model.refresh()
    #expect(model.status == .enabled)
    #expect(!model.needsApproval)
    #expect(model.colorRole == .ok)

    model.set(false)
    #expect(service.unregistered == 1)
    #expect(model.status == .notRegistered)
    #expect(!model.isOn)
}

@MainActor
@Test func theStatusIsWhatMacOSSaysAfterwardsNeverWhatTheCallAskedFor() {
    // register() returning is not the same as the item being on. A model that
    // assumed .enabled here would report a background item that is not running.
    let service = FakeBackgroundAgent(status: .notRegistered, afterRegister: .requiresApproval)
    let model = BackgroundAgentModel(service: service)
    model.set(true)
    #expect(model.status == .requiresApproval)
    #expect(service.reads > 1)
}

@MainActor
@Test func aRefusedRegistrationIsReportedVerbatimAndIsNotMistakenForAState() {
    let service = FakeBackgroundAgent(status: .notRegistered, registerError: "Operation not permitted")
    let model = BackgroundAgentModel(service: service)
    model.set(true)
    #expect(model.lastError == "Operation not permitted")
    // Still off, because macOS still says off — the error did not become a status.
    #expect(!model.isOn)
    #expect(model.status == .notRegistered)
}

@MainActor
@Test func theApprovalRouteIsOneButtonAndApplesOwnDeepLink() {
    let service = FakeBackgroundAgent(status: .requiresApproval)
    let model = BackgroundAgentModel(service: service)
    #expect(model.needsApproval)
    model.openSystemSettings()
    #expect(service.openedSettings == 1)
}

@MainActor
@Test func aSwiftBuildExecutableHasNoAgentToRegisterAndSaysThatRatherThanFailing() {
    // `SMAppService.agent(plistName:)` answers notFound when the bundle has no
    // Contents/Library/LaunchAgents/<name> — which is every `swift build`.
    let model = BackgroundAgentModel(service: FakeBackgroundAgent(status: .notFound))
    #expect(model.isSupported)
    #expect(!model.bundlesAgent)
    #expect(!model.isOn)
    #expect(model.statusLabel.contains("unavailable"))
    #expect(BackgroundAgentModel.notAnAppBundleNote.contains("build-app.sh"))
    // and the row still tells you what DOES work
    #expect(BackgroundAgentModel.terminalNote.contains("metistry up"))
    #expect(BackgroundAgentModel.terminalNote.contains("launchctl"))
}

@MainActor
@Test func withNoServiceAtAllTheRowIsDisabledRatherThanInert() {
    let model = BackgroundAgentModel(service: nil)
    #expect(!model.isSupported)
    #expect(!model.bundlesAgent)
    #expect(model.status == .notFound)
    model.set(true)
    #expect(!model.isOn)
    #expect(model.lastError == nil)
}

@Test func theNamesThisRegistrationDependsOnAreTheOnesTheBundleShips() {
    // SMAppService.agent(plistName:) resolves exactly one path, and
    // ops/release/build-app.sh writes exactly one file. A release-tooling test
    // holds the build script to the same string from the other side.
    #expect(BackgroundAgentModel.plistName == "com.foldedspacelabs.metistry.plist")
    #expect(BackgroundAgentModel.label == "com.foldedspacelabs.metistry")
    #expect(BackgroundAgentModel.plistName == BackgroundAgentModel.label + ".plist")
}

@MainActor
@Test func theProseSeparatesTheTwoRegistrationsPeopleConfuse() {
    // The whole reason there are two rows: one opens a window, the other runs
    // the install. Each note has to say which it is.
    #expect(BackgroundAgentModel.title == "Run Metistry in the background")
    #expect(BackgroundAgentModel.note.contains("Start at login"))
    #expect(LoginItemModel.note.contains("does NOT start the install's services"))
    // Every status Apple can return says something, including one added later.
    for raw in 0...4 {
        let model = BackgroundAgentModel(service: FakeBackgroundAgent(status: LoginItemStatus(rawValue: raw)))
        #expect(!model.statusLabel.isEmpty)
    }
    #expect(BackgroundAgentModel(service: FakeBackgroundAgent(status: .unknown(9))).statusLabel.contains("9"))
}

private final class FakeBackgroundAgent: BackgroundAgentService, @unchecked Sendable {
    private var status: LoginItemStatus
    private let afterRegister: LoginItemStatus
    private let registerError: String?
    private(set) var registered = 0
    private(set) var unregistered = 0
    private(set) var openedSettings = 0
    /// How many times the model asked macOS — the guard on "never assume the
    /// status from the call returning".
    private(set) var reads = 0

    init(status: LoginItemStatus, afterRegister: LoginItemStatus = .enabled, registerError: String? = nil) {
        self.status = status
        self.afterRegister = afterRegister
        self.registerError = registerError
    }

    func setStatus(_ s: LoginItemStatus) { status = s }

    func currentStatus() -> LoginItemStatus {
        reads += 1
        return status
    }

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

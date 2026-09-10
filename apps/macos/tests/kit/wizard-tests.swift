// The wizard is a state machine over the plan's seven steps. These tests are
// what stops it becoming a maze: you can always go back, you can always skip
// what is genuinely optional, you can never be stuck on a step the product
// cannot do, and every choice on screen carries both sides of itself.

import Foundation
import Testing

@testable import MetistryKit

@MainActor
private func wizard(
    withRuntime: Bool = true,
    runner: any CommandRunner = WizardNoopRunner(),
    passkey: PasskeyEnrolmentModel? = nil
) -> WizardModel {
    let runtime = MetistryRuntime(
        source: .checkout,
        executable: URL(fileURLWithPath: "/usr/bin/node"),
        leadingArguments: ["/src/packages/cli/dist/main.js"],
        productDir: URL(fileURLWithPath: "/src")
    )
    let cli = withRuntime ? MetistryCLI(runtime: runtime, runner: runner) : nil
    let steps = FirstRunModel(
        cli: cli,
        resolution: RuntimeResolution(runtime: withRuntime ? runtime : nil, attempts: []),
        passkey: passkey ?? PasskeyEnrolmentModel()
    )
    return WizardModel(steps: steps)
}

@MainActor
@Test func itWalksTheSevenStepsInOrderAndBacksOutOfThem() {
    let w = wizard()
    w.present()
    #expect(w.isPresented)
    #expect(w.current == .runtime)
    #expect(!w.canGoBack)
    #expect(w.progressLabel == "Step 1 of 7")

    // Step 1 is satisfied the moment a runtime is located.
    #expect(w.canContinue)
    w.advance()
    #expect(w.current == .instance)
    #expect(w.canGoBack)
    w.back()
    #expect(w.current == .runtime)
}

@MainActor
@Test func theTwoRequiredStepsBlockAndTheRestDoNot() {
    let w = wizard()
    w.present(from: .instance)
    // Nothing chosen: instance is required, so Continue is off and Skip is not
    // offered.
    #expect(!w.canContinue)
    #expect(!w.canSkip)

    w.steps.instanceMode = .adopt
    w.steps.instanceDirectory = URL(fileURLWithPath: "/Users/you/instance")
    w.steps.markAdopted()
    #expect(w.canContinue)

    w.advance()
    #expect(w.current == .versioning)
    // Versioning is optional: continue past it or skip it, both allowed.
    #expect(w.canContinue)
    #expect(w.canSkip)
}

@MainActor
@Test func withNoRuntimeStepOneIsAWall() {
    let w = wizard(withRuntime: false)
    w.present()
    #expect(!w.canContinue)
    #expect(!w.canSkip) // runtime is required; there is no install without it
}

@MainActor
@Test func skippingIsRecordedAndNamedRatherThanForgotten() {
    let w = wizard()
    w.present(from: .versioning)
    w.skip()
    #expect(w.current == .secrets)
    w.skip()
    #expect(w.skippedTitles == ["3. Versioning", "4. Secrets"])
    // Coming back and continuing clears the skip: it is a record of what
    // happened, not a permanent label.
    w.back()
    #expect(w.current == .secrets)
    w.advance()
    #expect(w.skippedTitles == ["3. Versioning"])
}

@MainActor
@Test func stepsSixAndSevenAnswerFromTheirOwnModelsAndNeverWallTheWizard() {
    let w = wizard()
    w.present(from: .door)
    // Neither is a `metistry` verb, so neither has an argument array or a run
    // row — and neither is satisfied until the thing itself happened. Step 6's
    // "thing" is now a successful whoami, which has not been asked yet.
    #expect(!w.steps.canRun(.door))
    #expect(!w.isSatisfied(.door))
    // Optional, so Continue and Skip are both open. The passkey in particular
    // may be unreachable natively for reasons the step explains and nobody can
    // fix from this screen; walling the wizard on it would be a trap.
    #expect(w.canContinue)
    #expect(w.canSkip)

    w.advance()
    #expect(w.current == .claude)
    #expect(w.isOnLastStep)
    #expect(!w.isSatisfied(.claude))
    #expect(w.canContinue)
}

// MARK: - Step 6, since the owner decision of 2026-09-10

@MainActor
@Test func theDoorStepLeadsWithThisMacBeingSignedInAlready() async {
    // The reframing, in the copy the screen actually prints: the step is no
    // longer "get a door", it is "this Mac has one; the other devices might
    // not".
    #expect(FirstRunStep.door.summary == "Your Mac is signed in automatically. Enrol a passkey only for browsers and your phone.")
    // The default is what is already true, so the common case asks nothing.
    let w = wizard()
    #expect(w.steps.doorPlan == .thisMacOnly)
    // Passkeys are not deprecated, and the step says so rather than leaving
    // someone to wonder whether they still work.
    #expect(WizardOptions.doorNote.contains("Passkeys did not change"))
}

@MainActor
@Test func aSignedInMacSatisfiesTheDoorWithNoCeremonyAtAll() async {
    let runner = FixedWizardRunner(result: CommandResult(
        exitCode: 0,
        stdout: #"{"principal":"user","via":"local_owner_token","management":true,"url":"http://127.0.0.1:8080"}"#,
        stderr: ""
    ))
    let w = wizard(runner: runner)
    w.present(from: .door)
    #expect(!w.isSatisfied(.door))

    await w.steps.consoleSignIn.refresh()
    // The console has a door the moment it takes this Mac as the owner. No
    // ASAuthorization ran, nothing was enrolled, and the step is done.
    #expect(w.steps.consoleSignIn.signIn?.isSignedIn == true)
    #expect(w.isSatisfied(.door))
    // Satisfied, so there is nothing to skip past.
    #expect(!w.canSkip)
    #expect(w.canContinue)
}

@MainActor
@Test func aTokenlessInstallLeavesTheDoorUnsatisfiedAndSaysWhatToRun() async {
    let stderr = "metistry console whoami: METISTRY_LOCAL_OWNER_TOKEN is not set (env, <instance>/state/.env, or the login Keychain)"
    let w = wizard(runner: FixedWizardRunner(result: CommandResult(exitCode: 1, stdout: "", stderr: stderr)))
    w.present(from: .door)
    await w.steps.consoleSignIn.refresh()

    #expect(w.isSatisfied(.door) == false)
    // Still optional — an install with no token is not an install that cannot
    // be finished — and the command is on the screen.
    #expect(w.canContinue)
    #expect(w.canSkip)
    #expect(w.steps.consoleSignIn.signIn?.remedy == ConsoleSignIn.mintCommands)
}

@MainActor
@Test func anEnrolledPasskeyStillSatisfiesTheDoorBecauseItIsTheSameDoor() async {
    // The enrolment path is unchanged — it is still `/auth/enroll/start`, the
    // ceremony, `/auth/enroll/finish` — and a door opened that way is a door.
    // Driven end to end through the real client rather than by setting a phase,
    // so this test also pins that the ceremony still works.
    let passkey = PasskeyEnrolmentModel(
        registrar: SucceedingRegistrar(),
        transport: EnrolmentTransport(),
        associatedDomains: ["studio.ts.net"]
    )
    let w = wizard(passkey: passkey)
    #expect(!w.isSatisfied(.door))

    w.steps.doorPlan = .otherDevices
    passkey.adopt(consoleURL: "https://studio.ts.net")
    #expect(passkey.route == .native(rpID: "studio.ts.net"))
    passkey.enrolmentCode = "abcdefghijklmnopqrstuv"
    passkey.deviceLabel = "the phone"
    await passkey.enrol()

    #expect(passkey.phase == .enrolled("enrolled as “the phone” — the console has a door"))
    #expect(w.isSatisfied(.door))
}

/// `/auth/enroll/start` answers options; `/auth/enroll/finish` answers ok.
private struct EnrolmentTransport: ConsoleTransport {
    func send(method: String, url: URL, body: Data?, cookie: String?) async throws -> (status: Int, body: Data, setCookie: String?) {
        if url.path == "/auth/enroll/start" {
            let json = #"{"options":{"challenge":"Y2hhbGxlbmdl","rp":{"id":"studio.ts.net","name":"metistry"},"user":{"id":"dXNlcg","name":"owner"}}}"#
            return (200, Data(json.utf8), nil)
        }
        return (200, Data(#"{"ok":true}"#.utf8), "metistry_session=abc; HttpOnly")
    }
}

private struct SucceedingRegistrar: PasskeyRegistrar {
    func register(rpID: String, challenge: Data, userID: Data, userName: String) async -> Result<PasskeyRegistrationResponse, PasskeySystemError> {
        .success(PasskeyRegistrationResponse(
            credentialIDBase64URL: "Y3JlZA",
            clientDataJSONBase64URL: "Y2xpZW50",
            attestationObjectBase64URL: "YXR0ZXN0"
        ))
    }
}

@Test func theAskMacOSProbeMovedRatherThanVanished() {
    // It is real measured behaviour and worth keeping — but it is a diagnostic,
    // not a setup step, so the wizard names where it went instead of leaving
    // someone to wonder whether it was deleted.
    #expect(WizardOptions.doorDiagnosticLocation == "Settings → Advanced")
    #expect(WizardOptions.doorNote.contains(WizardOptions.doorDiagnosticLocation))
    #expect(WizardOptions.doorNote.contains("ASAuthorization"))
}

@MainActor
@Test func finishingTheLastStepClosesTheSheet() {
    let w = wizard()
    w.present(from: .claude)
    w.advance()
    #expect(w.isFinished)
    #expect(!w.isPresented)
}

@MainActor
@Test func theInstanceFolderIsHandedBackWhenTheInstanceStepIsLeft() {
    let w = wizard()
    var adopted: [String] = []
    w.onInstanceChosen = { adopted.append($0.path) }
    w.present(from: .instance)
    w.steps.instanceMode = .adopt
    w.steps.instanceDirectory = URL(fileURLWithPath: "/Users/you/instance")
    w.steps.markAdopted()
    w.advance()
    #expect(adopted == ["/Users/you/instance"])
}

@MainActor
@Test func settingUpAgainRestartsRatherThanResuming() {
    let w = wizard()
    w.present()
    w.steps.instanceMode = .adopt
    w.steps.instanceDirectory = URL(fileURLWithPath: "/Users/you/instance")
    w.steps.markAdopted()
    w.advance()                    // 1 -> 2
    w.advance()                    // 2 -> 3, the folder is adopted
    w.skip()                       // 3 -> 4
    #expect(w.current == .secrets)

    w.present()
    #expect(w.current == .runtime)
    #expect(w.skipped.isEmpty)
    #expect(!w.isFinished)
}

// MARK: - The choices, and what they turn into

@MainActor
@Test func adoptingAnExistingFolderRunsNothingAtAll() {
    let w = wizard()
    w.steps.instanceDirectory = URL(fileURLWithPath: "/Users/you/instance")
    w.steps.instanceMode = .adopt
    #expect(w.steps.plannedArguments(.instance) == nil)
    #expect(!w.steps.canRun(.instance))
    w.steps.markAdopted()
    #expect(w.steps.state(.instance) == .succeeded("using the existing folder /Users/you/instance"))
}

@MainActor
@Test func theAuthChoiceIsTheAuthFlag() {
    let w = wizard()
    w.steps.instanceDirectory = URL(fileURLWithPath: "/Users/you/instance")
    w.steps.remoteURL = "https://github.com/you/instance.git"
    #expect(w.steps.plannedArguments(.versioning)?.contains("device") == true)
    w.steps.repoAuth = .ssh
    #expect(w.steps.plannedArguments(.versioning)?.contains("ssh") == true)
    #expect(w.steps.canRun(.versioning))
    // The one mode the app cannot drive is offered, explained, and not runnable.
    w.steps.repoAuth = .token
    #expect(!w.steps.canRun(.versioning))
    #expect(RepoAuth.token.runnableFromTheApp == false)
}

@MainActor
@Test func decidingToConnectLaterRunsNothing() {
    let w = wizard()
    w.steps.instanceDirectory = URL(fileURLWithPath: "/Users/you/instance")
    w.steps.remoteURL = "https://github.com/you/instance.git"
    w.steps.repoPlan = .later
    #expect(w.steps.plannedArguments(.versioning) == nil)
    #expect(!w.steps.canRun(.versioning))
}

@MainActor
@Test func enablingBridgesMintsTheirTokensAsFollowUpCommands() {
    let w = wizard()
    #expect(w.steps.plannedFollowUps(.secrets).isEmpty)
    w.steps.bridgeSelection = ["eventkit", "apple-fm"]
    let followUps = w.steps.plannedFollowUps(.secrets)
    #expect(followUps.count == 2)
    // Sorted, so the screen and the run agree on the order.
    #expect(followUps[0] == [
        "/usr/bin/node", "/src/packages/cli/dist/main.js",
        "secrets", "mint", "METISTRY_BRIDGE_TOKEN_APPLE_FM", "--product-dir", "/src",
    ])
    #expect(followUps[1] == [
        "/usr/bin/node", "/src/packages/cli/dist/main.js",
        "secrets", "mint", "METISTRY_BRIDGE_TOKEN_EVENTKIT", "--product-dir", "/src",
    ])
    // Only the secrets step has them.
    #expect(w.steps.plannedFollowUps(.services).isEmpty)
}

@MainActor
@Test func theShapePreviewIsADryRunWithTheOverrideVariableAndNothingElse() {
    let w = wizard()
    let planned = w.steps.plannedPreviewArguments(shape: "launchd")
    #expect(planned?.first == "METISTRY_DEPLOYMENT_SHAPE=launchd")
    #expect(planned?.contains("--dry-run") == true)
    #expect(planned?.contains("up") == true)
}

@MainActor
@Test func settingTheShapeIsAVerbWithAnExplicitYesAndTheInstance() throws {
    let w = wizard()
    w.steps.instanceDirectory = URL(fileURLWithPath: "/Users/you/instance")
    let planned = try #require(w.steps.plannedSetShapeArguments(shape: "launchd"))
    #expect(planned.contains("deployment"))
    #expect(planned.contains("set-shape"))
    #expect(planned.contains("launchd"))
    // `set-shape` is preview-then-confirm like every other destructive verb; the
    // wizard collected the confirmation by showing the preview first, so --yes
    // is that answer and not a bypass of it.
    #expect(planned.contains("--yes"))
    #expect(planned.contains("--instance"))
    #expect(planned.contains("/Users/you/instance"))
    // The app still writes no file: the verb does.
    #expect(!planned.contains("deployment.yaml"))
}

@MainActor
@Test func aSetShapeThatSucceededDoesNotClaimTheServicesStep() async {
    let w = wizard(runner: FixedWizardRunner(result: CommandResult(exitCode: 0, stdout: "shape set to launchd\n", stderr: "")))
    await w.steps.setShape("launchd")
    // A shape that was written is not an install that is up: `metistry up` still
    // has to run, so the step goes back to pending rather than green.
    #expect(w.steps.state(.services) == .pending)
}

@MainActor
@Test func aCliWithoutSetShapeSaysSoRatherThanReportingAFailedWrite() async {
    let stale = CommandResult(exitCode: 2, stdout: "", stderr: "unknown command: deployment\n\nmetistry — Metistry command line\n")
    let w = wizard(runner: FixedWizardRunner(result: stale))
    await w.steps.setShape("launchd")
    #expect(w.steps.state(.services) == .failed(
        "this CLI has no `deployment set-shape` verb yet — update it (metistry update, or Check for Updates…)"
    ))
}

private struct FixedWizardRunner: CommandRunner {
    let result: CommandResult

    func run(
        executable: URL, arguments: [String], environment: [String: String],
        currentDirectory: URL?, onOutput: @escaping @Sendable (OutputLine) -> Void
    ) async throws -> CommandResult {
        result
    }
}

@Test func everyChoiceCarriesBothSidesOfItself() {
    func check<V: Hashable & Sendable>(_ options: [WizardOption<V>], _ what: String) {
        #expect(options.count >= 2, "\(what) with one option is not a choice")
        for option in options {
            #expect(!option.pro.isEmpty, "\(what): \(option.title) has no upside stated")
            #expect(!option.con.isEmpty, "\(what): \(option.title) has no cost stated")
            if !option.isAvailable {
                #expect(option.unavailable?.isEmpty == false, "\(what): \(option.title) is closed without saying why")
            }
        }
    }
    check(WizardOptions.instanceMode, "instance mode")
    check(WizardOptions.repoPlan, "repository plan")
    check(WizardOptions.repoAuth, "repository auth")
    check(WizardOptions.shape, "deployment shape")
    check(WizardOptions.door, "the door")
    // Both shapes of the door are offered, so neither is silently the only one.
    #expect(Set(WizardOptions.door.map(\.value)) == Set(DoorPlan.allCases))
    // Every auth mode the CLI has is represented, so none is silently dropped.
    #expect(Set(WizardOptions.repoAuth.map(\.value)) == Set(RepoAuth.allCases))
}

@Test func theReassuranceIsOnScreenAtAllTimes() {
    #expect(WizardModel.reassurance.contains("Settings"))
}

private struct WizardNoopRunner: CommandRunner {
    func run(
        executable: URL, arguments: [String], environment: [String: String],
        currentDirectory: URL?, onOutput: @escaping @Sendable (OutputLine) -> Void
    ) async throws -> CommandResult {
        CommandResult(exitCode: 0, stdout: "", stderr: "")
    }
}

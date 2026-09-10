// The wizard is a state machine over the plan's seven steps. These tests are
// what stops it becoming a maze: you can always go back, you can always skip
// what is genuinely optional, you can never be stuck on a step the product
// cannot do, and every choice on screen carries both sides of itself.

import Foundation
import Testing

@testable import MetistryKit

@MainActor
private func wizard(withRuntime: Bool = true) -> WizardModel {
    let runtime = MetistryRuntime(
        source: .checkout,
        executable: URL(fileURLWithPath: "/usr/bin/node"),
        leadingArguments: ["/src/packages/cli/dist/main.js"],
        productDir: URL(fileURLWithPath: "/src")
    )
    let cli = withRuntime ? MetistryCLI(runtime: runtime, runner: WizardNoopRunner()) : nil
    let steps = FirstRunModel(
        cli: cli,
        resolution: RuntimeResolution(runtime: withRuntime ? runtime : nil, attempts: [])
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
@Test func stepsSixAndSevenAreSatisfiedByBeingHonestNotByBeingDone() {
    let w = wizard()
    w.present(from: .door)
    #expect(w.steps.state(.door) == .notYet)
    #expect(w.isSatisfied(.door))
    #expect(w.canContinue)
    #expect(!w.steps.canRun(.door))
    w.advance()
    #expect(w.current == .claude)
    #expect(w.isOnLastStep)
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

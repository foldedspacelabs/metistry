// The app's promise on every first-run screen is "here is exactly the command
// I will run". These tests are what keeps that literal.

import Foundation
import Testing

@testable import MetistryKit

@MainActor
private func model() -> FirstRunModel {
    let runtime = MetistryRuntime(
        source: .checkout,
        executable: URL(fileURLWithPath: "/usr/bin/node"),
        leadingArguments: ["/src/packages/cli/dist/main.js"],
        productDir: URL(fileURLWithPath: "/src")
    )
    return FirstRunModel(
        cli: MetistryCLI(runtime: runtime, runner: NoopRunner()),
        resolution: RuntimeResolution(runtime: runtime, attempts: [])
    )
}

@MainActor
@Test func everyImplementedStepPlansTheVerbTheDocSays() {
    let m = model()
    m.instanceDirectory = URL(fileURLWithPath: "/Users/you/instance")
    m.assistantName = "Ada"
    m.remoteURL = "https://github.com/you/instance.git"

    #expect(m.plannedArguments(.instance) == [
        "/usr/bin/node", "/src/packages/cli/dist/main.js",
        "init", "/Users/you/instance", "--name", "Ada",
        "--product-dir", "/src",
    ])
    #expect(m.plannedArguments(.versioning) == [
        "/usr/bin/node", "/src/packages/cli/dist/main.js",
        "connect-repo", "https://github.com/you/instance.git",
        "--instance", "/Users/you/instance", "--auth", "device",
        "--product-dir", "/src",
    ])
    // both carry --instance: an instance directory is self-contained, so the
    // app has to say which one it opened
    #expect(m.plannedArguments(.secrets) == [
        "/usr/bin/node", "/src/packages/cli/dist/main.js",
        "secrets", "sync", "--to", "keychain",
        "--instance", "/Users/you/instance",
        "--product-dir", "/src",
    ])
    #expect(m.plannedArguments(.services) == [
        "/usr/bin/node", "/src/packages/cli/dist/main.js",
        "up", "--instance", "/Users/you/instance",
        "--product-dir", "/src",
    ])
    // Steps that run nothing say so rather than inventing a command.
    #expect(m.plannedArguments(.runtime) == nil)
    #expect(m.plannedArguments(.door) == nil)
    #expect(m.plannedArguments(.compute) == nil)
}

@MainActor
@Test func aBlankAssistantNameIsOmittedRatherThanSentEmpty() {
    let m = model()
    m.instanceDirectory = URL(fileURLWithPath: "/Users/you/instance")
    m.assistantName = "   "
    #expect(m.plannedArguments(.instance)?.contains("--name") == false)
}

@MainActor
@Test func stepsWithoutTheirInputsCannotRun() {
    let m = model()
    #expect(!m.canRun(.instance)) // no folder chosen
    m.instanceDirectory = URL(fileURLWithPath: "/Users/you/instance")
    #expect(m.canRun(.instance))
    #expect(!m.canRun(.versioning)) // no remote url
    m.remoteURL = "https://github.com/you/instance.git"
    #expect(m.canRun(.versioning))
    // 6 and 7 own their own screens: neither is a `metistry` verb, so neither
    // goes through the run row.
    #expect(!m.canRun(.door))
    #expect(!m.canRun(.compute))
}

@MainActor
@Test func theTwoStepsThatAreNotVerbsAreTheTwoThatOwnTheirOwnScreens() {
    let withOwnScreens = FirstRunStep.allCases.filter(\.hasOwnScreen)
    #expect(withOwnScreens == [.door, .compute])
    // A step with its own screen shows no argument array, because there is none
    // to show: one is an ASAuthorization ceremony, the other an interactive
    // terminal login.
    let m = model()
    for step in withOwnScreens {
        #expect(m.plannedArguments(step) == nil, "\(step.title) must not claim to run a verb")
        #expect(step.verb == nil)
    }
}

@MainActor
@Test func secretsDirectionChangesTheArgument() {
    let m = model()
    #expect(m.plannedArguments(.secrets)?.contains("keychain") == true)
    m.secretsDirection = .toEnv
    #expect(m.plannedArguments(.secrets)?.contains("env") == true)
    #expect(m.plannedArguments(.secrets)?.contains("keychain") == false)
}

@Test func parsesTheDeviceCodeTheCliActuallyPrints() {
    // Verbatim from packages/cli/src/connect-repo.ts.
    let lines = [
        OutputLine(stream: .standardOutput, text: ""),
        OutputLine(stream: .standardOutput, text: "   Open https://github.com/login/device and enter this code:   ABCD-1234"),
        OutputLine(stream: .standardOutput, text: "   (valid for 15 minutes; waiting…)"),
    ]
    let code = FirstRunModel.parseDeviceCode(from: lines)
    #expect(code?.verificationURI == "https://github.com/login/device")
    #expect(code?.userCode == "ABCD-1234")
}

@Test func noDeviceCodeInUnrelatedOutputIsNil() {
    let lines = [OutputLine(stream: .standardOutput, text: "origin set to https://github.com/you/instance.git")]
    #expect(FirstRunModel.parseDeviceCode(from: lines) == nil)
}

private struct NoopRunner: CommandRunner {
    func run(
        executable: URL, arguments: [String], environment: [String: String],
        currentDirectory: URL?, standardInput: String?, onOutput: @escaping @Sendable (OutputLine) -> Void
    ) async throws -> CommandResult {
        CommandResult(exitCode: 0, stdout: "", stderr: "")
    }
}

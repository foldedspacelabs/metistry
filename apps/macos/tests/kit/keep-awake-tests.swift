// The app's half of keep-awake: the vocabulary (which is duplicated from
// packages/core/src/power.ts and therefore has to be asserted rather than
// trusted), the argument array the write verb runs, and the reading of
// doctor's row in the states that matter.

import Foundation
import Testing

@testable import MetistryKit

private func cli(instance: String? = "/Users/you/instance") -> MetistryCLI {
    let runtime = MetistryRuntime(
        source: .checkout,
        executable: URL(fileURLWithPath: "/usr/bin/node"),
        leadingArguments: ["/src/packages/cli/dist/main.js"],
        productDir: URL(fileURLWithPath: "/src")
    )
    return MetistryCLI(runtime: runtime, runner: KeepAwakeNoopRunner(), instanceDir: instance.map { URL(fileURLWithPath: $0) })
}

private func row(
    status: CheckStatus = .ok,
    remediation: String? = nil,
    meta: [String: JSONValue]
) -> DoctorRow {
    DoctorRow(name: "keep-awake", kind: "keep-awake", status: status, latencyMs: 1, probe: "probe", remediation: remediation, meta: .object(meta))
}

@Test func theFourValuesAreTheCLIsFourValues() {
    // the YAML/CLI spellings, exactly — a rename on either side fails here
    #expect(KeepAwakeSetting.allCases.map(\.rawValue).sorted() == ["allow_sleep_on_battery", "always", "always_lid_closed", "never"])
    #expect(KeepAwakeSetting(rawValue: "allow_sleep_on_battery") == .allowSleepOnBattery)
    #expect(KeepAwakeSetting(rawValue: "alway") == nil)
}

@Test func theOfferNamesOneRecommendationAndPutsTheLidClosedChoiceLast() {
    #expect(KeepAwakeSetting.offered.first == .allowSleepOnBattery)
    #expect(KeepAwakeSetting.offered.last == .alwaysLidClosed)
    #expect(KeepAwakeSetting.offered.count == KeepAwakeSetting.allCases.count)
    #expect(KeepAwakeSetting.offered.filter(\.isRecommended) == [.allowSleepOnBattery])
    #expect(KeepAwakeSetting.offered.filter(\.isNotRecommended) == [.alwaysLidClosed])
    // informed consent is the consequence text: every choice carries one, and
    // the two that cost something say what
    for setting in KeepAwakeSetting.allCases { #expect(setting.consequence.count > 40, "\(setting.rawValue)") }
    #expect(KeepAwakeSetting.always.consequence.contains("battery"))
    #expect(KeepAwakeSetting.never.consequence.contains("wait until it wakes"))
    #expect(KeepAwakeSetting.lidClosedNotAvailable.contains("not available on this Mac without an administrator change"))
    #expect(KeepAwakeSetting.lidClosedNotAvailable.contains("pmset -a disablesleep 1"))
}

@Test func theWriteVerbIsTheCLIsOwnPreviewThenConfirm() {
    let c = cli()
    #expect(c.plannedSetKeepAwakeArguments(.always) == [
        "/usr/bin/node", "/src/packages/cli/dist/main.js",
        "deployment", "set-keep-awake", "always", "--yes",
        "--instance", "/Users/you/instance",
        "--product-dir", "/src",
    ])
    // the preview is the same call without the confirmation
    #expect(!c.plannedSetKeepAwakeArguments(.always, confirm: false).contains("--yes"))
    // no instance chosen yet: no --instance to name, and the verb still parses
    #expect(!cli(instance: nil).setKeepAwakeVerb(.never).contains("--instance"))
}

@MainActor
@Test func firstRunPassesTheAnswerToInitOnlyWhenThereIsOne() {
    let runtime = MetistryRuntime(
        source: .checkout,
        executable: URL(fileURLWithPath: "/usr/bin/node"),
        leadingArguments: ["/src/packages/cli/dist/main.js"],
        productDir: URL(fileURLWithPath: "/src")
    )
    let m = FirstRunModel(cli: MetistryCLI(runtime: runtime, runner: KeepAwakeNoopRunner()), resolution: RuntimeResolution(runtime: runtime, attempts: []))
    m.instanceDirectory = URL(fileURLWithPath: "/Users/you/instance")
    m.assistantName = "Ada"
    // unanswered: `init` is run without the flag, asks nobody (the runner gives
    // every verb an empty stdin), and writes no value
    #expect(m.plannedArguments(.instance)?.contains("--keep-awake") == false)
    m.keepAwake = .allowSleepOnBattery
    #expect(m.plannedArguments(.instance) == [
        "/usr/bin/node", "/src/packages/cli/dist/main.js",
        "init", "/Users/you/instance", "--name", "Ada",
        "--keep-awake", "allow_sleep_on_battery",
        "--product-dir", "/src",
    ])
}

@Test func theRowIsReadRatherThanReDerived() {
    let held = KeepAwakeFacts(row: row(meta: [
        "mode": .string("always"),
        "holding": .bool(true),
        "pid": .number(4242),
        "since": .string("2026-09-19T12:00:00.000Z"),
        "power_source": .string("ac"),
        "other_holders": .number(1),
    ]))
    #expect(held.setting == .always)
    #expect(held.holding)
    #expect(held.pid == 4242)
    #expect(held.otherHolders == 1)
    #expect(held.summary == "Holding (pid 4242)")
    #expect(!held.sleptAnyway)
}

@Test func releasedOnBatteryReadsAsTheSettingWorking() {
    let facts = KeepAwakeFacts(row: row(meta: [
        "mode": .string("allow_sleep_on_battery"),
        "holding": .bool(false),
        "power_source": .string("battery"),
    ]))
    #expect(facts.status == .ok)
    #expect(facts.summary.contains("what this setting asks for"))
    #expect(!facts.sleptAnyway)
}

@Test func theMacSleptAnywayIsOfferedWithTheCLIsOwnRepair() {
    let facts = KeepAwakeFacts(row: row(
        status: .degraded,
        remediation: "this Mac slept at 2026-09-19T02:41:00.000Z for about 41m while keep_awake: always was set — …",
        meta: [
            "mode": .string("always"),
            "holding": .bool(true),
            "pid": .number(4242),
            "power_source": .string("ac"),
            "last_cutoff": .object(["at": .string("2026-09-19T02:41:00.000Z"), "gap_ms": .number(2_460_000)]),
        ]
    ))
    #expect(facts.sleptAnyway)
    #expect(facts.sleptAt == "2026-09-19T02:41:00.000Z")
    // the offer is the CLI's sentence, verbatim — the app invents none of it
    #expect(facts.remediation?.contains("slept at") == true)
}

@Test func anInstallWhoseCLIPredatesTheRowSaysSoRatherThanAssuming() {
    let report = DoctorReport(asOf: "now", productDir: "/src", shape: "launchd", ok: true, rows: [])
    #expect(report.keepAwake == nil)
    let off = DoctorReport(asOf: "now", productDir: "/src", shape: "launchd", ok: true, rows: [row(status: .absent, meta: ["mode": .string("never")])])
    #expect(off.keepAwake?.setting == .never)
    #expect(off.keepAwake?.summary.contains("Off") == true)
}

private struct KeepAwakeNoopRunner: CommandRunner {
    func run(
        executable: URL, arguments: [String], environment: [String: String],
        currentDirectory: URL?, standardInput: String?, onOutput: @escaping @Sendable (OutputLine) -> Void
    ) async throws -> CommandResult {
        CommandResult(exitCode: 0, stdout: "", stderr: "")
    }
}

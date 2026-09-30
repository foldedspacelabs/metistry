// Settings ▸ Secrets and Settings ▸ Variables (T6-14, screen-19, plan §2.14).
//
// The ticket's two bold tests are here: A VALUE IS NEVER RENDERED AFTER SAVE —
// it reaches the CLI on stdin and nowhere else, the draft is gone before the
// process starts, and neither the pane nor the sheet nor any description of
// the command holds it — and DELETING A SECRET IN USE NAMES WHAT STOPS, from
// `secrets remove`'s own preview. Then: a key-shaped variable is refused with
// Store as Secret and no *Save as Variable*; a refused grant (X-41) reads on
// its own row; every write is a §2.2 verb, exactly as argv; §2.18 for the
// panes opened up and for both sheets.

#if os(macOS)
import AppKit
import Foundation
import SwiftUI
import Testing

@testable import MetistryKit

/// Shapes of real credentials — built by concatenation so no scanner mistakes
/// this file for a leak (packages/core/test/variables.test.ts's own KEYS).
private let keys: [String: String] = [
    "openai": "sk-" + "proj-" + "Ab3dEf6hIj9kLm2nOp5qRs8t",
    "anthropic": "sk-" + "ant-api03-" + "x7Yq2Lm9Pz4Kd8Wn3Rt6Vb1Hc5Jf0",
    "stripe": "sk_" + "live_" + "51HqAbCdEfGh12345678",
    "github": "gh" + "p_" + "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0",
    "github_pat": "github_" + "pat_" + "11ABCDEFG0123456789_abcdefghij",
    "gitlab": "gl" + "pat-" + "xY7zW3vU9tS1rQ5p",
    "slack": "xo" + "xb-" + "1234567890-abcdefghij",
    "aws": "AK" + "IA" + "IOSFODNN7EXAMPLE",
    "google": "AI" + "za" + "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q",
    "linear": "lin_" + "api_" + "aBcDeFgHiJkLmNoPqRsTuVwXyZ012345",
    "devin": "ap" + "k_" + "user_ZGV2aW4tdGVzdC1rZXk",
    "jwt": "ey" + "JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    "pem": "-----BEGIN " + "OPENSSH PRIVATE KEY-----",
    "bearer": "Bearer " + "abcdef0123456789",
    "url_password": "https://owner:" + "hunter2hunter2@git.example.com/repo.git",
    "url_token": "https://calendar.example.com/feed.ics?" + "token=Zq81mNa0pLx",
    "hex": "3f9a1c0b7e2d4a6f8b1c3e5d7f9a0b2c4d6e8f01",
    "base64": "q8ZtR2mXv9LpW4kN7sJ1hG5fD3aB6cE0yU",
    "base36": "k8s7df9a0lqz3mx2vb6n4c1r5t",
    "in_prose": "use " + "gh" + "p_" + "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0 for pushes",
]

private let plain = [
    "Platform",
    "foldedspacelabs/metistry, foldedspacelabs/metistry-instance",
    "https://github.com/foldedspacelabs/metistry",
    "platform-team-infrastructure-2026",
    "MyCompanyEngineering2026",
    "ENG",
    "3f2a8c1e-9b4d-4e6f-8a1c-2b3d4e5f6a7b",
    "Acme Corporation, Inc.",
    "2026-10-01",
    "/Users/owner/Development/metistry-instance",
]

private let instance = URL(fileURLWithPath: "/tmp/instance")

/// Whether a node says `text` in any of what VoiceOver reads.
private func says(_ node: AXNode, _ text: String) -> Bool {
    if node.label.contains(text) { return true }
    if node.title.contains(text) { return true }
    return node.value.contains(text)
}

// MARK: - A value is never rendered after save

@MainActor
@Test func aValueIsNeverRenderedAfterSave() async throws {
    let (app, runner, cleanup) = try await accessApp()
    defer { cleanup() }
    let settings = app.settings
    let value = try #require(keys["linear"])

    settings.beginNewSecret()
    settings.secretsPane.draft?.name = "linear_key"
    settings.secretsPane.draft?.hosts = "mcp.linear.app"
    settings.secretsPane.draft?.value = value
    let draft = try #require(settings.secretsPane.draft)
    // the command the sheet shows before it runs has no value in it
    let planned = try #require(settings.plannedSecretCommand(draft))
    #expect(!planned.joined(separator: " ").contains(value))
    // and a draft printed, dumped or interpolated does not either
    var dumped = ""
    dump(draft, to: &dumped)
    #expect(!String(describing: draft).contains(value))
    #expect(!"\(draft)".contains(value))
    #expect(!dumped.contains(value))

    await settings.saveSecret()

    // M7, the value on stdin and nowhere else
    let command = try #require(runner.commands.last)
    #expect(command.row == .secrets)
    #expect(command.arguments == ["secrets", "set", "linear_key", "--hosts", "mcp.linear.app", "--instance", instance.path])
    #expect(command.standardInput == value)
    #expect(!command.arguments.contains { $0.contains(value) })
    var commandDump = ""
    dump(command, to: &commandDump)
    #expect(!command.description.contains(value))
    #expect(!commandDump.contains(value))
    #expect(!"\(command)".contains(value))

    // after save: no draft, no confirmation, and the outcome is the CLI's words and the command — not the value
    #expect(settings.secretsPane.draft == nil)
    #expect(settings.confirmation == nil)
    let outcome = try #require(settings.outcome)
    #expect(outcome.ok)
    #expect(!outcome.command.contains(value))
    #expect(!outcome.words.contains(value))
    #expect(!outcome.lines.joined().contains(value))

    // the pane, every secret opened up, says no value anywhere a person or VoiceOver could read one
    for secret in settings.secretsPane.rows { settings.secretsPane.expanded.insert(secret.name) }
    let pane = try await AccessibilityProbe.snapshot(SettingsPaneContent(section: .secrets, model: app, actions: SettingsActions()).frame(width: SettingsLayout.pane))
    defer { pane.close() }
    #expect(!pane.nodes.isEmpty)
    #expect(!pane.nodes.contains { says($0, value) })
    #expect(pane.nodes.contains { $0.name.contains("Value hidden") }, "the Value section is dots, said as hidden")

    // a refused save reopens the sheet with the name and hosts kept, and the value field EMPTY
    runner.reply = { _ in CommandResult(exitCode: 1, stdout: "", stderr: "metistry secrets set: linear_key is already set in secrets.yaml — `metistry secrets replace linear_key` swaps its value\n") }
    settings.beginNewSecret(name: "linear_key")
    settings.secretsPane.draft?.hosts = "mcp.linear.app"
    settings.secretsPane.draft?.value = value
    await settings.saveSecret()
    let reopened = try #require(settings.secretsPane.draft)
    #expect(reopened.value.isEmpty)
    #expect(reopened.name == "linear_key")
    #expect(reopened.hosts == "mcp.linear.app")
    #expect(reopened.refusal?.contains("already set") == true)
    let sheet = try await AccessibilityProbe.snapshot(SecretEditorView(settings: settings))
    defer { sheet.close() }
    #expect(!sheet.nodes.contains { says($0, value) })
    #expect(sheet.unlabeledBesidesFields.isEmpty, "unlabeled: \(sheet.unlabeledBesidesFields)")
    #expect(sheet.fieldsWithoutAPrompt.isEmpty)

    // Cancel takes whatever was typed with it
    settings.secretsPane.draft?.value = value
    settings.cancelSecretDraft()
    #expect(settings.secretsPane.draft == nil)
}

@MainActor
@Test func replaceSendsTheNewValueOnStdinAndKeepsThePolicy() async throws {
    let (app, runner, cleanup) = try await accessApp()
    defer { cleanup() }
    let value = try #require(keys["github"])
    app.settings.beginReplace("github_write")
    #expect(app.settings.secretsPane.draft?.isReplace == true)
    app.settings.secretsPane.draft?.value = value
    app.settings.secretsPane.draft?.expires = "2026-12-31"
    await app.settings.saveSecret()
    let command = try #require(runner.commands.last)
    #expect(command.arguments == ["secrets", "replace", "github_write", "--expires", "2026-12-31", "--instance", instance.path])
    #expect(command.standardInput == value)
    #expect(app.settings.secretsPane.draft == nil)
}

// MARK: - Deleting a secret in use names what stops

@MainActor
@Test func deletingASecretInUseNamesWhatStops() async throws {
    let (app, runner, cleanup) = try await accessApp()
    defer { cleanup() }
    let settings = app.settings
    runner.reply = { command in
        command.arguments.contains("--json")
            ? CommandResult(exitCode: 0, stdout: #"{"name":"github_mcp_key","referencedBy":[".metistry/connections/github.yaml",".metistry/agents/crew/triage.md"],"removed":false,"itemDeleted":false}"#, stderr: "referenced by — these stop working once it is gone: …\n")
            : CommandResult(exitCode: 0, stdout: "removed github_mcp_key — the Keychain item is deleted and its line in secrets.yaml.\n", stderr: "")
    }
    let secret = try #require(settings.secretsPane.rows.first { $0.name == "github_mcp_key" })
    #expect(secret.usedBy.map(\.to) == ["connection:github", "agent:devin"])

    await settings.proposeSecretRemoval(secret)

    // the preview ran first — `remove` without --yes deletes nothing
    let preview = try #require(runner.commands.last)
    #expect(preview.arguments.starts(with: ["secrets", "remove", "github_mcp_key", "--json"]))
    #expect(!preview.arguments.contains("--yes"))
    #expect(preview.standardInput == nil)

    // then the confirmation, naming what stops: each file as what it is, and the grantee no file named
    let pending = try #require(settings.confirmation)
    #expect(pending.destructive)
    #expect(pending.title == "Delete github_mcp_key?")
    #expect(pending.cost.hasPrefix("What stops: "))
    #expect(pending.cost.contains("the github connection (.metistry/connections/github.yaml)"))
    #expect(pending.cost.contains("agent triage (.metistry/agents/crew/triage.md)"))
    #expect(pending.cost.contains("agent devin, granted Ask"))
    #expect(!pending.cost.contains("the github connection, granted"), "a grantee a file already named is not said twice")
    #expect(pending.cost.contains("cannot be read back"))
    #expect(runner.commands.count == 1, "nothing is deleted before the confirmation")

    await settings.confirm(pending)
    let removal = try #require(runner.commands.last)
    #expect(removal.arguments == ["secrets", "remove", "github_mcp_key", "--yes", "--instance", instance.path])
    #expect(settings.outcome?.ok == true)

    // a secret nothing uses says so, rather than naming nothing
    runner.reply = { _ in CommandResult(exitCode: 0, stdout: #"{"name":"spare","referencedBy":[],"removed":false,"itemDeleted":false}"#, stderr: "") }
    await settings.proposeSecretRemoval(NamedSecret(name: "spare"))
    #expect(settings.confirmation?.cost.hasPrefix("Nothing under .metistry/ references it, and no one is granted it.") == true)
    settings.cancelConfirmation()

    // a preview the CLI refuses is said on the row, and nothing is confirmed
    runner.reply = { _ in CommandResult(exitCode: 1, stdout: "", stderr: "metistry secrets remove: this instance has no secret named ghost\n") }
    await settings.proposeSecretRemoval(NamedSecret(name: "ghost"))
    #expect(settings.confirmation == nil)
    #expect(settings.secretsPane.removalRefusal?.name == "ghost")
    #expect(settings.secretsPane.removalRefusal?.words.contains("no secret named ghost") == true)
}

// MARK: - Sent only to, and who may use it

@MainActor
@Test func hostsAndGrantsAreM7VerbsConfirmedFirst() async throws {
    let (app, runner, cleanup) = try await accessApp()
    defer { cleanup() }
    let settings = app.settings
    let secret = try #require(settings.secretsPane.rows.first { $0.name == "github_mcp_key" })

    // unchanged hosts propose nothing
    settings.proposeHosts(secret)
    #expect(settings.confirmation == nil)
    settings.secretsPane.hostDrafts[secret.name] = "api.github.com, uploads.github.com"
    #expect(settings.secretsPane.hostsChanged(secret))
    settings.proposeHosts(secret)
    let hosts = try #require(settings.confirmation)
    #expect(hosts.command.arguments == ["secrets", "hosts", "github_mcp_key", "api.github.com", "uploads.github.com", "--instance", instance.path])
    #expect(runner.commands.isEmpty)
    settings.cancelConfirmation()
    settings.secretsPane.hostDrafts[secret.name] = "  "
    settings.proposeHosts(secret)
    #expect(settings.confirmation?.command.arguments == ["secrets", "hosts", "github_mcp_key", "--clear", "--instance", instance.path])
    settings.cancelConfirmation()

    // a grant already at that mode asks nothing; an unlisted grantee is Off
    settings.proposeGrant(secret, to: SecretGrantee("connection:github"), .on)
    #expect(settings.confirmation == nil)
    #expect(secret.mode(for: "agent:cursor") == .off)
    settings.proposeGrant(secret, to: SecretGrantee("agent:cursor"), .ask)
    let grant = try #require(settings.confirmation)
    #expect(grant.command.arguments == ["secrets", "grant", "github_mcp_key", "agent:cursor", "ask", "--instance", instance.path])
    #expect(grant.cost.contains("GITHUB_MCP_KEY"), "an agent is told how it gets it")
    #expect(runner.commands.isEmpty)
}

@MainActor
@Test func aRefusedGrantReadsOnItsOwnRow() async throws {
    let (app, runner, cleanup) = try await accessApp()
    defer { cleanup() }
    let settings = app.settings
    // github_mcp_key, not github_write: an owner-door secret (X-41) is never
    // offered agent:devin as a grantee at all (it is refused before the CLI
    // is even asked), so it cannot demonstrate a CLI-side refusal reaching
    // this row — github_mcp_key already grants agent:devin Ask, which is
    // what makes it a known grantee here to propose widening.
    let secret = try #require(settings.secretsPane.rows.first { $0.name == "github_mcp_key" })
    let refusal = "github_mcp_key: the reconciler could not reach the vault to write secrets.yaml — try again"
    runner.reply = { _ in CommandResult(exitCode: 1, stdout: "", stderr: "metistry secrets grant: \(refusal)\n") }

    settings.proposeGrant(secret, to: SecretGrantee("agent:devin"), .on)
    await settings.confirm(try #require(settings.confirmation))

    // the CLI's words, on that grantee's row — without the verb's prefix — and the switch where the file has it
    #expect(settings.secretsPane.grantRefusal("github_mcp_key", "agent:devin") == refusal)
    #expect(settings.secretsPane.grantRefusal("github_mcp_key", "connection:github") == nil)
    let reread = try #require(settings.secretsPane.rows.first { $0.name == "github_mcp_key" })
    #expect(reread.mode(for: "agent:devin") == .ask)
    settings.secretsPane.expanded.insert("github_mcp_key")
    let tree = try await AccessibilityProbe.snapshot(SettingsPaneContent(section: .secrets, model: app, actions: SettingsActions()).frame(width: SettingsLayout.pane))
    defer { tree.close() }
    #expect(tree.nodes.contains { $0.name == "Not changed: \(refusal)" }, "the refusal is spoken on its row")

    // the next accepted change clears it
    runner.reply = { _ in CommandResult(exitCode: 0, stdout: "agent:devin may use github_mcp_key: on\n", stderr: "") }
    settings.proposeGrant(secret, to: SecretGrantee("agent:devin"), .on)
    await settings.confirm(try #require(settings.confirmation))
    #expect(settings.secretsPane.grantRefusal("github_mcp_key", "agent:devin") == nil)
}

// MARK: - The recorded rows

@MainActor
@Test func thePaneIsTheRecordedRows() async throws {
    let (app, _, cleanup) = try await accessApp()
    defer { cleanup() }
    let pane = app.settings.secretsPane
    #expect(pane.phase == .read)

    // github_write is an owner door (X-41): present, its own hosts and last
    // used, but no grants at all — never a connection's or an agent's row.
    let door = try #require(pane.rows.first { $0.name == "github_write" })
    #expect(door.hosts == ["api.github.com"])
    #expect(door.present == true)
    #expect(door.usedByLine == "No one yet")
    #expect(door.lastUsed != nil)

    let secret = try #require(pane.rows.first { $0.name == "github_mcp_key" })
    #expect(secret.name == "github_mcp_key")
    #expect(secret.hosts == ["api.github.com"])
    #expect(secret.present == true)
    #expect(secret.usedByLine == "connection:github, agent:devin (Ask)")
    #expect(secret.sentOnlyToLine == "api.github.com")
    let lastUsed = try #require(secret.lastUsed)
    #expect(secret.lastUsedLine(now: lastUsed.addingTimeInterval(3 * 3600)) == "Used 3 hours ago")
    // who a grant can name: every connection and agent the console knows, and every grantee the file has
    let grantees = pane.grantees(for: secret).map(\.id)
    #expect(grantees.first == "connection:github")
    #expect(grantees.contains("agent:devin"))
    #expect(grantees.contains("agent:cursor"))
    #expect(grantees == grantees.sorted { SecretGrantee($0) < SecretGrantee($1) })

    // Expired, in the failed ink, when the service's date has passed
    let expiring = NamedSecret(name: "devin_api_key", expires: "2026-09-01", lastUsed: lastUsed)
    #expect(expiring.isExpired(now: WireTime.date("2026-09-02T00:00:01Z")!))
    #expect(!expiring.isExpired(now: WireTime.date("2026-09-01T12:00:00Z")!), "a date expires at the end of that day")
    #expect(expiring.lastUsedLine(now: WireTime.date("2026-09-30T00:00:00Z")!) == "Expired")
    #expect(NamedSecret(name: "unused", present: false).lastUsedLine(now: Date()) == "Never used")

    let variables = app.settings.variablesPane
    #expect(variables.phase == .read)
    #expect(variables.rows.map(\.name) == ["company", "team_name"])
    let team = try #require(variables.rows.last)
    #expect(team.usedInLine == ".metistry/connections/github.yaml — read by connection:github")
    #expect(variables.rows.first?.usedInLine == "Not used yet")
}

// MARK: - Variables

@MainActor
@Test func aKeyShapedVariableIsRefusedWithStoreAsSecretAndNoOverride() async throws {
    let (app, runner, cleanup) = try await accessApp()
    defer { cleanup() }
    let settings = app.settings
    let key = try #require(keys["github"])

    settings.beginNewVariable()
    settings.variablesPane.draft?.name = "deploy"
    settings.variablesPane.draft?.value = key
    // no command is drawn with a key in it
    let keyDraft = try #require(settings.variablesPane.draft)
    #expect(settings.plannedVariableCommand(keyDraft) == nil)

    await settings.saveVariable()
    // refused here: no process ever had it in its argv
    #expect(runner.commands.isEmpty)
    #expect(settings.confirmation == nil)
    #expect(settings.variablesPane.draft?.refusal == .keyShaped)

    let sheet = try await AccessibilityProbe.snapshot(VariableEditorView(settings: settings))
    defer { sheet.close() }
    #expect(sheet.controlNames.contains("Store as Secret"), "controls: \(sheet.controlNames)")
    #expect(!sheet.nodes.contains { $0.name.localizedCaseInsensitiveContains("Save as Variable") }, "no override")
    #expect(!sheet.controlNames.contains("Save Variable"), "no way to save it anyway")
    #expect(sheet.texts.contains { $0.contains("This looks like a key. Variables can be read by agents.") })
    #expect(sheet.unlabeledBesidesFields.isEmpty)

    // Store as Secret moves the name and the value to New Secret; nothing runs until that sheet's button
    settings.storeVariableAsSecret()
    #expect(settings.variablesPane.draft == nil)
    #expect(settings.secretsPane.draft?.name == "deploy")
    #expect(settings.secretsPane.draft?.value == key)
    #expect(settings.secretsPane.draft?.isReplace == false)
    #expect(runner.commands.isEmpty)
    settings.cancelSecretDraft()

    // a key the app's patterns miss is still the CLI's to refuse — and the sheet reads the same
    runner.reply = { _ in CommandResult(exitCode: 1, stdout: "", stderr: "metistry variables set: deploy: This looks like a key. Variables can be read by agents — Store as Secret: `metistry secrets set deploy` (the value on stdin)\n") }
    settings.beginNewVariable()
    settings.variablesPane.draft?.name = "deploy"
    settings.variablesPane.draft?.value = "hunter2 hunter2"
    await settings.saveVariable()
    #expect(settings.variablesPane.draft?.refusal?.storeAsSecret == true)
    #expect(settings.variablesPane.draft?.refusal?.words.hasPrefix("deploy: This looks like a key") == true)
}

@Test func theKeyShapeCheckIsCoresPatternForPattern() {
    for (label, value) in keys { #expect(KeyShape.looksLikeKey(value), "\(label)") }
    for value in plain { #expect(!KeyShape.looksLikeKey(value), "\(value)") }
}

@MainActor
@Test func aVariableIsSetAndRemovedThroughM14() async throws {
    let (app, runner, cleanup) = try await accessApp()
    defer { cleanup() }
    let settings = app.settings

    settings.beginNewVariable()
    settings.variablesPane.draft?.name = "company"
    settings.variablesPane.draft?.value = "  Acme Corporation, Inc. "
    let draft = try #require(settings.variablesPane.draft)
    let planned = try #require(settings.plannedVariableCommand(draft))
    #expect(Array(planned.dropFirst()) == ["variables", "set", "company", "Acme Corporation, Inc.", "--instance", instance.path])
    await settings.saveVariable()
    #expect(runner.commands.last?.row == .variables)
    #expect(runner.commands.last?.arguments == ["variables", "set", "company", "Acme Corporation, Inc.", "--instance", instance.path])
    #expect(settings.variablesPane.draft == nil)

    // the CLI's refusal reopens the sheet in its words — a schedule is not a variable (ruling 2)
    runner.reply = { _ in CommandResult(exitCode: 1, stdout: "", stderr: "metistry variables set: standup_time: a schedule or a time is not a variable — a routine's timing is its own schedule (Scheduled)\n") }
    settings.beginNewVariable()
    settings.variablesPane.draft?.name = "standup_time"
    settings.variablesPane.draft?.value = "09:15"
    await settings.saveVariable()
    let refused = try #require(settings.variablesPane.draft?.refusal)
    #expect(!refused.storeAsSecret)
    #expect(refused.words.hasPrefix("standup_time: a schedule or a time"))
    settings.cancelVariableDraft()

    // Edit keeps the name; Remove names what stops filling in
    let team = try #require(settings.variablesPane.rows.first { $0.name == "team_name" })
    settings.beginEditVariable(team)
    let editing = try #require(settings.variablesPane.draft)
    #expect(editing.name == "team_name")
    #expect(editing.value == "Platform")
    settings.cancelVariableDraft()
    settings.proposeVariableRemoval(team)
    let pending = try #require(settings.confirmation)
    #expect(pending.destructive)
    #expect(pending.command.arguments == ["variables", "unset", "team_name", "--instance", instance.path])
    #expect(pending.cost.hasPrefix("{{ variable.team_name }} stops filling in: .metistry/connections/github.yaml (read by connection:github)."))
}

// MARK: - §2.18

@MainActor
@Test func bothPanesOpenedUpAndBothSheetsSpeakEveryControl() async throws {
    let (app, _, cleanup) = try await accessApp()
    defer { cleanup() }
    let settings = app.settings
    settings.secretsPane.expanded.insert("github_write")
    for section in [SettingsModel.Section.secrets, .variables] {
        let tree = try await AccessibilityProbe.snapshot(SettingsPaneContent(section: section, model: app, actions: SettingsActions()).frame(width: SettingsLayout.pane))
        defer { tree.close() }
        #expect(tree.unlabeledBesidesFields.isEmpty, "\(section) unlabeled: \(tree.unlabeledBesidesFields)")
        #expect(tree.fieldsWithoutAPrompt.isEmpty, "\(section): a field that would say nothing")
        #expect(tree.saysAssistant.isEmpty)
    }
    let secrets = try await AccessibilityProbe.snapshot(SettingsPaneContent(section: .secrets, model: app, actions: SettingsActions()).frame(width: SettingsLayout.pane))
    defer { secrets.close() }
    for heading in ["Secrets", "Metistry's Own", "Value", "Sent Only To", "Who May Use It"] {
        #expect(secrets.headings.contains(heading), "\(heading) — headings: \(secrets.headings)")
    }
    for control in ["New Secret…", "Replace the value of github_write", "Save the hosts for github_write", "Delete github_write"] {
        #expect(secrets.controlNames.contains(control), "\(control) — controls: \(secrets.controlNames)")
    }

    settings.beginNewSecret()
    let newSecret = try await AccessibilityProbe.snapshot(SecretEditorView(settings: settings))
    defer { newSecret.close() }
    #expect(newSecret.unlabeledBesidesFields.isEmpty)
    #expect(newSecret.fieldsWithoutAPrompt.isEmpty)
    settings.beginNewVariable()
    let newVariable = try await AccessibilityProbe.snapshot(VariableEditorView(settings: settings))
    defer { newVariable.close() }
    #expect(newVariable.unlabeledBesidesFields.isEmpty)
    #expect(newVariable.fieldsWithoutAPrompt.isEmpty)
    settings.cancelVariableDraft()

    // the largest text: opened up, the Secrets pane still grows longer, never wider
    let width = SettingsLayout.pane
    var heights: [DynamicTypeSize: CGFloat] = [:]
    for size in [DynamicTypeSize.large, .accessibility5] {
        let renderer = ImageRenderer(content: SettingsPaneContent(section: .secrets, model: app, actions: SettingsActions())
            .padding(MetistrySpace.s5)
            .frame(width: width)
            .environment(\.dynamicTypeSize, size))
        renderer.proposedSize = ProposedViewSize(width: width, height: nil)
        renderer.scale = 1
        let image = try #require(renderer.cgImage)
        #expect(CGFloat(image.width) <= width, "\(image.width) wide at \(size)")
        heights[size] = CGFloat(image.height)
    }
    #expect((heights[.accessibility5] ?? 0) > (heights[.large] ?? 0))
}

// MARK: - Fixtures

private let fakeRuntime = MetistryRuntime(source: .path, executable: URL(fileURLWithPath: "/usr/local/bin/metistry"))

/// The whole app over the recorded console, a CLI answering each read verb
/// from canned JSON, and a management runner that records every command —
/// with both panes read.
@MainActor
private func accessApp() async throws -> (AppModel, ScriptedManagementRunner, () -> Void) {
    let id = "com.foldedspacelabs.metistry.tests.secrets-variables.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: id)!
    let reads = CannedVerbs([
        "secrets": #"[{"name":"METISTRY_DB_PASSWORD","scope":"instance","inKeychain":true,"foundUnder":"instance","inEnv":true}]"#,
    ])
    let app = AppModel(bundleResourceURL: nil, runner: reads, defaults: defaults)
    app.activateInstance(instance)
    let runner = ScriptedManagementRunner()
    app.console.adopt(transport: try FixtureConsole.recorded(), management: runner)
    let cli = MetistryCLI(runtime: fakeRuntime, runner: reads, instanceDir: instance)
    app.settings.adopt(cli: cli, instanceDir: instance)
    await app.settings.refreshSecretsPane()
    await app.settings.refreshVariablesPane()
    await app.settings.refreshSecrets()
    return (app, runner, { UserDefaults.standard.removePersistentDomain(forName: id) })
}

/// Answers `metistry <verb> …` with the JSON filed under its first word.
private struct CannedVerbs: CommandRunner {
    let replies: [String: String]
    init(_ replies: [String: String]) { self.replies = replies }

    func run(
        executable: URL, arguments: [String], environment: [String: String],
        currentDirectory: URL?, standardInput: String?, onOutput: @escaping @Sendable (OutputLine) -> Void
    ) async throws -> CommandResult {
        CommandResult(exitCode: 0, stdout: replies[arguments.first ?? ""] ?? "", stderr: "")
    }
}

/// Records every management command, and answers each as `reply` says.
private final class ScriptedManagementRunner: ManagementRunner, @unchecked Sendable {
    private let lock = NSLock()
    private var _commands: [ManagementCommand] = []
    private var _reply: @Sendable (ManagementCommand) -> CommandResult = { _ in CommandResult(exitCode: 0, stdout: "ok\n", stderr: "") }

    var commands: [ManagementCommand] { lock.withLock { _commands } }
    var reply: @Sendable (ManagementCommand) -> CommandResult {
        get { lock.withLock { _reply } }
        set { lock.withLock { _reply = newValue } }
    }

    func plannedArguments(_ command: ManagementCommand) -> [String] { ["metistry"] + command.arguments }

    func run(_ command: ManagementCommand, onOutput: @escaping @Sendable (OutputLine) -> Void) async throws -> CommandResult {
        let answer = lock.withLock { () -> @Sendable (ManagementCommand) -> CommandResult in
            _commands.append(command)
            return _reply
        }
        return answer(command)
    }
}
#endif

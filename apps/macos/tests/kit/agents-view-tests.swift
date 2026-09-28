// Agents (T6-5; screen-07-agents.md): built against the recorded fixtures
// (F-7, U9) — `GET /api/agents`, `agent_presence`, `GET /api/scheduled`, a
// crew's definition — with a console that can answer differently where a test
// needs a record to move, and a management runner that records the one verb
// the screen runs (`metistry agents define`, M12).
//
// The ticket's two first: a widening confirms with `autonomyWidenings`' own
// strings, and the definition editor is absent on a remote client.

#if os(macOS)
import AppKit
import Foundation
import SwiftUI
import Testing

@testable import MetistryKit

// MARK: - The ticket's two

@MainActor
@Test func aWideningConfirmsWithAutonomyWideningsOwnStrings() async throws {
    let console = AgentsConsole()
    let (model, session) = agentsModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.load()
    await model.open("cursor")
    model.beginAccessEdit("cursor")
    model.access?.autonomy.level = "propose"
    console.reset()

    await model.commitAccess()

    // Nothing is sent before the owner says Widen — the route widens the moment it lands.
    #expect(console.calls.allSatisfy { $0.method == "GET" }, "\(console.calls.map(\.path))")
    let confirm = try #require(model.widening?.confirmation)
    // core's own strings (packages/core/test/actions.test.ts), and the route's
    // own `widened` for the same change (the recorded PUT) — word for word
    let core = ["level observe → propose", "actions.dispatch deny → propose", "actions.task_update deny → propose", "actions.comment deny → propose", "actions.capture deny → propose"]
    #expect(confirm.costs == core)
    let recorded = try ConsoleFixture.load("put-api-agents-id-autonomy")
    #expect(confirm.costs == recorded.replyJSON?["widened"]?.arrayValue?.compactMap(\.stringValue))
    #expect(confirm.confirm == "Widen")
    #expect(!confirm.destructive)
    #expect(confirm.presentation().controls.map(\.label) == ["Cancel", "Widen"])

    await model.confirmWidening()
    let put = try #require(console.calls.first { $0.method == "PUT" })
    #expect(put.path == "/api/agents/cursor/autonomy")
    #expect(put.body == .object(["level": .string("propose")]))
    #expect(model.access == nil && model.widening == nil)
}

@MainActor
@Test func theDefinitionEditorIsAbsentOnARemoteClient() async throws {
    // A remote client: no management runner, so `metistry agents define` is not there to run.
    let (remote, remoteSession) = agentsModel(AgentsConsole(), runner: nil)
    defer { withExtendedLifetime(remoteSession) {} }
    await remote.load()
    await remote.open("researcher")
    #expect(remote.definitions["researcher"]?.value != nil, "the definition is still read and shown")
    #expect(!remote.isLocalClient)
    #expect(!remote.canEditDefinition("researcher"))
    remote.beginEdit("researcher")
    #expect(remote.editor == nil, "no door opens the editor")

    let tree = try await AccessibilityProbe.snapshot(AgentsView(model: remote, assistantName: "Aide", tick: .seconds(3600)).frame(width: 760, height: 1600))
    defer { tree.close() }
    #expect(!tree.controlNames.contains { $0.hasPrefix("Edit Definition") || $0.hasPrefix("Edit Draft") }, "\(tree.controlNames)")
    #expect(!tree.controls.contains { $0.role == "AXTextArea" || $0.role == "AXTextField" }, "an editor field on a remote client")
    #expect(tree.nodes.contains { $0.name.contains(AgentWords.editOnTheMac) }, "it says where the definition is edited")

    // …and on the Mac that runs Metistry it is there.
    let (local, localSession) = agentsModel(AgentsConsole(), runner: RecordingRunner())
    defer { withExtendedLifetime(localSession) {} }
    await local.load()
    await local.open("researcher")
    #expect(local.canEditDefinition("researcher"))
    let localTree = try await AccessibilityProbe.snapshot(AgentsView(model: local, assistantName: "Aide", tick: .seconds(3600)).frame(width: 760, height: 1600))
    defer { localTree.close() }
    #expect(localTree.controlNames.contains("Edit Definition"), "\(localTree.controlNames)")
}

// MARK: - core's arithmetic, carried over

@Test func autonomyWideningsSaysWhatCoreSays() {
    typealias R = AgentAutonomy.Record
    // packages/core/test/actions.test.ts, "autonomyWidenings — what the owner's hand is required for"
    #expect(AgentAutonomy.widenings(R(), R(level: "propose")) == [
        "level observe → propose", "actions.dispatch deny → propose", "actions.task_update deny → propose", "actions.comment deny → propose", "actions.capture deny → propose",
    ])
    #expect(AgentAutonomy.widenings(R(level: "propose"), R(level: "act_within_scope", actions: ["dispatch": "allow"])) == [
        "level propose → act_within_scope", "actions.dispatch propose → allow", "actions.task_update propose → allow", "actions.comment propose → allow", "actions.capture propose → allow",
    ])
    #expect(AgentAutonomy.widenings(R(level: "act_within_scope"), R(level: "propose")) == [])
    #expect(AgentAutonomy.widenings(R(level: "propose"), R(level: "propose")) == [])
    #expect(AgentAutonomy.widenings(R(level: "act_within_scope"), R(level: "act_within_scope", actions: ["comment": "deny"])) == [])
    // an entry raised under a ceiling that refuses it changes nothing
    #expect(AgentAutonomy.widenings(R(level: "propose"), R(level: "propose", actions: ["comment": "allow"])) == [])
    // a stored key the console does not know is dropped, never widened
    #expect(R(json: .object(["level": .string("root"), "actions": .object(["dispatch": .string("always")])])) == R())
    // effectiveActions agrees with the recorded `scope.autonomy.actions`
    #expect(AgentAutonomy.effective(R(level: "propose")) == ["dispatch": "propose", "task_update": "propose", "comment": "propose", "capture": "propose"])
    #expect(AgentAutonomy.effective(R(level: "act_within_scope")) == ["dispatch": "propose", "task_update": "allow", "comment": "allow", "capture": "allow"])
}

@Test func reachWideningsNameWhatIsAddedAndNothingForANarrowing() {
    let base = AgentReach(tier: "areas", areas: ["Areas/Ops"], queries: false, projects: [])
    #expect(AgentReach.widenings(base, AgentReach(tier: "areas", areas: ["Areas/Ops", "Areas/Finance"], queries: true, projects: ["metistry"])) == [
        "areas + Areas/Finance", "queries off → on", "projects + metistry",
    ])
    #expect(AgentReach.widenings(base, AgentReach(tier: "areas", areas: ["Areas/Ops/Vendors"])) == [], "a folder under one it holds is less, not more")
    #expect(AgentReach.widenings(base, AgentReach(tier: "index")) == [])
    #expect(AgentReach.widenings(AgentReach(), AgentReach(tier: "areas", areas: ["Projects"])) == ["tier none → areas", "areas + Projects"])
}

// MARK: - Changing things (§5)

@MainActor
@Test func aNarrowingAppliesOnCommitWithNoConfirmation() async throws {
    let console = AgentsConsole()
    let (model, session) = agentsModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.load()
    await model.open("opencode")
    model.beginAccessEdit("opencode")
    model.access?.autonomy.level = "observe"
    console.reset()
    await model.commitAccess()
    #expect(model.widening == nil)
    let put = try #require(console.calls.first { $0.method == "PUT" })
    #expect(put.path == "/api/agents/opencode/autonomy")
    #expect(put.body == .object(["level": .string("observe")]))
}

@MainActor
@Test func aRecordThatMovedWhileTheEditorWasOpenSendsNothing() async throws {
    let console = AgentsConsole()
    let (model, session) = agentsModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.load()
    await model.open("opencode")
    model.beginAccessEdit("opencode")
    model.access?.reach.tier = "index"
    // someone else narrowed it meanwhile
    console.registry = registry { agents in
        agents["opencode"]?["autonomy"] = .object(["level": .string("observe")])
    }
    console.reset()
    await model.commitAccess()
    #expect(console.calls.allSatisfy { $0.method == "GET" }, "nothing was sent: \(console.calls.map(\.path))")
    #expect(model.accessNotice == AgentWords.changedWhileOpen)
    let again = try #require(model.access)
    #expect(again.baseAutonomy == AgentAutonomy.Record(level: "observe"), "the new values")
    #expect(again.reach.tier == "index", "the edit, offered again")
}

@MainActor
@Test func revokingStatesTheCascadeBeforeTheButton() async throws {
    let console = AgentsConsole()
    let (model, session) = agentsModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.load()
    await model.open("cursor")
    console.reset()
    model.askToRevoke("cursor")
    let c = try #require(model.revokeConfirmation)
    #expect(c.confirm == "Revoke" && c.destructive)
    #expect(c.costs.contains { $0.contains("settled") }, "pending asks settled")
    #expect(c.costs.contains { $0.contains("Areas/Ops") }, "the override approved in Needs You goes with it: \(c.costs)")
    #expect(console.calls.isEmpty)
    await model.confirmRevoke()
    #expect(console.calls.contains { $0.method == "POST" && $0.path == "/api/agents/cursor/revoke" })
}

// MARK: - The definition (M12)

@MainActor
@Test func escKeepsADraftAndSaveRunsDefineWithThePromptOnStandardInput() async throws {
    let runner = RecordingRunner()
    let (model, session) = agentsModel(AgentsConsole(), runner: runner)
    defer { withExtendedLifetime(session) {} }
    await model.load()
    await model.open("researcher")
    let reading = try #require(model.definitions["researcher"]?.value)
    #expect(reading.path == "seed/agents/example/researcher.md")
    #expect(reading.model == AgentModelChoice.sameAsDefaultWire)

    model.beginEdit("researcher")
    model.editor?.prompt = "You research, briefly."
    model.abandonEdit(try #require(model.editor))
    #expect(model.editor == nil)
    #expect(model.keptDraft == "researcher", "Esc keeps a draft (C136)")
    #expect(AgentWords.draftKept("researcher") == "Draft of researcher kept")
    model.beginEdit("researcher")
    #expect(model.editor?.prompt == "You research, briefly.", "the draft comes back")

    await model.saveDefinition()
    let command = try #require(runner.commands.first)
    #expect(command.row == .agentDefinitions)
    #expect(command.arguments == ["agents", "define", "researcher", "--prompt-file", "-", "--if-sha256", try #require(reading.sha256), "--json"])
    #expect(command.standardInput == "You research, briefly.")
    #expect(model.editor == nil && model.drafts["researcher"] == nil)
}

@MainActor
@Test func aStaleSaveIsReadAgainAndTheEditOfferedAgainstIt() async throws {
    let runner = RecordingRunner()
    runner.result = CommandResult(exitCode: 1, stdout: "", stderr: "error: stale: .metistry/agents/example/researcher.md is not the definition this edit was made against — re-read it and edit again; nothing was written\n")
    let (model, session) = agentsModel(AgentsConsole(), runner: runner)
    defer { withExtendedLifetime(session) {} }
    await model.load()
    await model.open("researcher")
    model.beginEdit("researcher")
    model.editor?.model = "lmstudio/gemma"
    await model.saveDefinition()
    #expect(model.saveProblem?.hasPrefix("stale:") == true, "the CLI's own words: \(model.saveProblem ?? "")")
    #expect(model.editor?.model == "lmstudio/gemma", "the edit is offered again")
    #expect(runner.commands.first?.arguments.contains("--model") == true)
    #expect(runner.commands.first?.standardInput == nil, "the prompt did not change, so nothing is on stdin")
}

@MainActor
@Test func theModelDropdownOffersYourModelsAndSameAsTheName() async throws {
    let (model, session) = agentsModel(AgentsConsole(), runner: RecordingRunner())
    defer { withExtendedLifetime(session) {} }
    await model.load()
    await model.open("researcher")
    let choices = model.modelChoices(current: "openrouter/anthropic/claude-sonnet-5", assistantName: "Aide")
    #expect(choices.first == AgentModelChoice(value: AgentModelChoice.sameAsDefaultWire, label: "Same as Aide"))
    #expect(choices.map(\.value).contains("lmstudio/gemma"))
    #expect(choices.map(\.value).contains("lmstudio/qwen"))
    #expect(choices.last?.label == "anthropic/claude-sonnet-5 — openrouter", "the definition's own model, when compute does not name it")
    #expect(AgentModelChoice.sameAsDefault(nil).label == "Same as the default model", "never a default name")
}

// MARK: - The roster (§2)

@MainActor
@Test func theRosterNeverListsTheAssistantAndSaysPresenceInTwoColours() async throws {
    let (model, session) = agentsModel(AgentsConsole())
    defer { withExtendedLifetime(session) {} }
    await model.load()
    let roster = try #require(model.roster(assistantName: "Aide"))
    #expect(roster.yours.map(\.id) == ["researcher"])
    #expect(roster.connected.map(\.id) == ["cursor", "old-laptop", "opencode"])
    #expect(!roster.ids.contains("assistant"), "C52")
    let cursor = try #require(roster.connected.first { $0.id == "cursor" })
    #expect(cursor.presence == .queued && cursor.presence.isFilled)
    #expect(cursor.whatItIs == "Cursor · metistry", "connected names its project")
    let opencode = try #require(roster.connected.first { $0.id == "opencode" })
    #expect(opencode.presence == .idle && opencode.presence.word == nil, "idle carries no word")
    #expect(opencode.whatItIs == "OpenCode · nothing granted")
    let researcher = try #require(roster.yours.first)
    #expect(researcher.whatItIs == "fri at 15:00 · Weekly Digest", "yours names its routine")
    #expect(AgentRoster.yoursLine([], assistantName: "Aide") == "when Aide delegates")
    #expect(AgentPresenceMark(state: "over-cap").isWrong && AgentPresenceMark(state: "interrupted").isWrong)
}

@MainActor
@Test func aFailedRegistryIsNotDrawnEmpty() async throws {
    let console = AgentsConsole()
    console.down = "connect ECONNREFUSED 127.0.0.1:1"
    let (model, session) = agentsModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.load()
    guard case .failed(let state) = model.panel else {
        Issue.record("\(model.panel)")
        return
    }
    #expect(state.title == "Couldn't Load Agents")
    #expect(state.reason?.contains("ECONNREFUSED") == true, "the error verbatim")
    #expect(model.roster(assistantName: "Aide") == nil, "nothing is known, so no roster")
}

@MainActor
@Test func theCeilingIsSaidWhereTheQuietWouldHideIt() async throws {
    let console = AgentsConsole()
    console.registry = registry({ _ in }, ceilings: [
        .object(["agent": .string("cursor"), "area": .string("Areas/Finance"), "declines": .number(2), "last_proposal": .number(388), "hits": .number(3)]),
    ])
    let (model, session) = agentsModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.load()
    let ceilings = model.ceilings(of: "cursor")
    #expect(ceilings.count == 1)
    #expect(AgentWords.ceiling(ceilings[0]) == "Asked twice for Areas/Finance · declined both · it can no longer ask (refused 3 times since)")
    #expect(model.ceilings(of: "opencode").isEmpty)
}

// MARK: - Run Now and New Agent (C138)

@MainActor
@Test func runNowWithNothingScheduledIsDimmedWithItsReasonAndLeadsSomewhere() async throws {
    let console = AgentsConsole()
    let (model, session) = agentsModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.load()
    // the recorded Scheduled gives researcher one routine: Run Now runs it
    let run = model.runNowControl("researcher")
    #expect(run.isEnabled && run.shortcut == "⌘R")
    console.reset()
    await model.runNow("researcher")
    #expect(console.calls.contains { $0.method == "POST" && $0.path == "/api/scheduled/routines/weekly-digest/run" })

    // with nothing scheduled: dimmed, the reason said, and Give It One beside it
    console.scheduled = .object(["routines": .array([]), "syncs": .array([])])
    await model.scheduled.refresh()
    let dimmed = model.runNowControl("researcher")
    #expect(dimmed.disabledBecause == "Nothing is scheduled for researcher.")
    await model.open("researcher")
    #expect(model.itemActions[.runNow] == nil, "Item ▸ Run Now is dimmed too")
    var scheduledTaps = 0
    let tree = try await AccessibilityProbe.snapshot(AgentsView(model: model, assistantName: "Aide", tick: .seconds(3600), onGoToScheduled: { scheduledTaps += 1 }).frame(width: 760, height: 1600))
    defer { tree.close() }
    #expect(tree.controlNames.contains("Give researcher a routine"), "\(tree.controlNames)")
    #expect(tree.nodes.contains { $0.name.contains("Nothing is scheduled for researcher.") })
}

@MainActor
@Test func newAgentAsksTheKindFirstAndARemoteClientIsToldWhy() async throws {
    #expect(NewAgentKind.allCases.map(\.title) == ["A Local Agent", "Connect an Agent", "A Tool That Works for You"])
    let (remote, remoteSession) = agentsModel(AgentsConsole(), runner: nil)
    defer { withExtendedLifetime(remoteSession) {} }
    for kind in NewAgentKind.allCases {
        #expect(kind.unavailableBecause(isLocalClient: remote.isLocalClient) == AgentWords.onlyTheMac)
    }
    remote.chooseNewAgent(.tool)
    #expect(remote.registration == nil)

    let console = AgentsConsole()
    let (model, session) = agentsModel(console, runner: RecordingRunner())
    defer { withExtendedLifetime(session) {} }
    await model.load()
    model.chooseNewAgent(.tool)
    model.registration?.id = "cursor"
    model.registration?.displayName = "Cursor"
    #expect(model.registration?.isSendable == true)
    console.reset()
    await model.register()
    let post = try #require(console.calls.first { $0.method == "POST" })
    #expect(post.path == "/api/agents")
    #expect(post.body?["kind"] == .string("external"), "only external rows are minted (T4-6)")
    #expect(model.credential?.token.isEmpty == false, "the token, shown once")
    model.dismissCredential()
    #expect(model.credential == nil)

    model.chooseNewAgent(.local)
    model.newLocal?.id = "vendor-research"
    model.newLocal?.area = "research"
    model.newLocal?.prompt = "Compare vendors."
    let command = try #require(model.newLocal?.command)
    #expect(command.arguments == ["agents", "define", "vendor-research", "--area", "research", "--model", AgentModelChoice.sameAsDefaultWire, "--effort", "low", "--prompt-file", "-", "--json"])
    #expect(command.standardInput == "Compare vendors.")
}

// MARK: - §2.18

@MainActor
@Test func everyControlOnAgentsSpeaksItsName() async throws {
    let (model, session) = agentsModel(AgentsConsole(), runner: RecordingRunner())
    defer { withExtendedLifetime(session) {} }
    await model.load()
    for open in [nil, "researcher", "cursor"] as [String?] {
        if let open { await model.open(open) } else { model.back() }
        let tree = try await AccessibilityProbe.snapshot(AgentsView(model: model, assistantName: "Aide", tick: .seconds(3600)).frame(width: 760, height: 1600))
        defer { tree.close() }
        let where_ = open ?? "roster"
        #expect(tree.unlabeledBesidesFields.isEmpty, "\(where_) unlabeled: \(tree.unlabeledBesidesFields)")
        #expect(tree.fieldsWithoutAPrompt.isEmpty, "\(where_): a field that would say nothing")
        // The detail quotes data — a crew's own prompt, what the activity rows
        // say — so it is the screen's own words and controls that are held here.
        #expect((open == nil ? tree.saysAssistant : tree.controls.filter { $0.name.localizedCaseInsensitiveContains("assistant") }).isEmpty, "\(where_): \(tree.saysAssistant)")
        if open == nil {
            #expect(tree.controlNames.contains("New Agent"))
            #expect(tree.nodes.contains { $0.name.hasPrefix("cursor, Cursor · metistry, queued") }, "a row says its whole sentence: \(tree.nodes.map(\.name).filter { !$0.isEmpty })")
        } else {
            #expect(tree.controlNames.contains("Back to Agents"))
            #expect(tree.headings.contains("Permissions"), "\(tree.headings)")
        }
    }
    // the editors, open
    await model.open("researcher")
    model.beginEdit("researcher")
    let editing = try await AccessibilityProbe.snapshot(AgentsView(model: model, assistantName: "Aide", tick: .seconds(3600)).frame(width: 760, height: 1800))
    defer { editing.close() }
    #expect(editing.unlabeledBesidesFields.isEmpty, "editor unlabeled: \(editing.unlabeledBesidesFields)")
    #expect(editing.fieldsWithoutAPrompt.isEmpty)
    #expect(editing.controlNames.contains("Close, keeping the draft"))

    await model.open("cursor")
    model.beginAccessEdit("cursor")
    let access = try await AccessibilityProbe.snapshot(AccessEditorSheet(model: model).frame(width: 520, height: 1000))
    defer { access.close() }
    #expect(access.unlabeledBesidesFields.isEmpty, "access editor unlabeled: \(access.unlabeledBesidesFields)")
    #expect(access.fieldsWithoutAPrompt.isEmpty)
    #expect(access.controlNames.contains("Remove Projects"), "\(access.controlNames)")

    let chooser = try await AccessibilityProbe.snapshot(NewAgentChooser(model: model, onOpenConnections: {}).frame(width: 460))
    defer { chooser.close() }
    #expect(chooser.unlabeledBesidesFields.isEmpty)
    for kind in NewAgentKind.allCases { #expect(chooser.controlNames.contains(kind.title)) }
}

@MainActor
@Test func agentsGrowLongerNeverWiderAtTheLargestText() async throws {
    let (model, session) = agentsModel(AgentsConsole(), runner: RecordingRunner())
    defer { withExtendedLifetime(session) {} }
    await model.load()
    let roster = try #require(model.roster(assistantName: "Aide"))
    await model.open("cursor")
    let width: CGFloat = 360
    let pieces: [(String, AnyView)] = [
        ("row", AnyView(AgentRosterRowView(row: roster.connected[0]).frame(width: width))),
        ("connection", AnyView(AgentConnectionSection(model: model, record: try #require(model.record("cursor"))).frame(width: width))),
        ("ceiling", AnyView(AgentCeilingSection(ceilings: [AgentAccessCeiling(agent: "cursor", area: "Areas/Finance", declines: 2, hits: 3)]).frame(width: width))),
        ("chooser", AnyView(NewAgentChooser(model: model, onOpenConnections: {}).frame(width: width))),
    ]
    for (name, view) in pieces {
        var heights: [DynamicTypeSize: CGFloat] = [:]
        for size in [DynamicTypeSize.large, .accessibility5] {
            let renderer = ImageRenderer(content: view.environment(\.dynamicTypeSize, size))
            renderer.proposedSize = ProposedViewSize(width: width, height: nil)
            renderer.scale = 1
            let image = try #require(renderer.cgImage, "\(name) did not render")
            #expect(CGFloat(image.width) <= width, "\(name) is \(image.width) wide at \(size)")
            heights[size] = CGFloat(image.height)
        }
        #expect((heights[.accessibility5] ?? 0) > (heights[.large] ?? 0), "\(name) did not grow at the largest text: \(heights)")
    }
}

@MainActor
@Test func openingAgentsNeverRaisesTheWindowsMinimum() async throws {
    let (model, session) = agentsModel(AgentsConsole(), runner: RecordingRunner())
    defer { withExtendedLifetime(session) {} }
    await model.load()
    let probe = MinimumProbe()
    let roster = probe.minimum(of: AgentsView(model: model, assistantName: "Aide", tick: .seconds(3600)))
    #expect(roster.height <= 460, "roster asks for \(roster)")
    await model.open("researcher")
    let detail = probe.minimum(of: AgentsView(model: model, assistantName: "Aide", tick: .seconds(3600)))
    #expect(detail.height <= 460, "detail asks for \(detail)")
    let down = AgentsConsole()
    down.down = "connect ECONNREFUSED 127.0.0.1:1"
    let (failed, failedSession) = agentsModel(down)
    defer { withExtendedLifetime(failedSession) {} }
    await failed.load()
    let failedSize = probe.minimum(of: AgentsView(model: failed, assistantName: "Aide", tick: .seconds(3600)))
    #expect(failedSize.height <= 460, "failed asks for \(failedSize)")
}

@Test func noStringInAgentsSourcesSaysAssistantOrNamesOne() throws {
    let kit = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("sources/kit")
    var literals: [String] = []
    for file in ["agents-view.swift", "agent-detail-view.swift", "agents-model.swift"] {
        let text = try String(contentsOf: kit.appendingPathComponent(file), encoding: .utf8)
        // §2.18.4: nothing here moves; C119: no key outside the closed menu table
        #expect(!text.contains("withAnimation") && !text.contains(".animation(") && !text.contains(".transition("), "\(file)")
        #expect(!text.contains(".keyboardShortcut("), "\(file)")
        for line in text.split(separator: "\n") where !line.trimmingCharacters(in: .whitespaces).hasPrefix("//") {
            let parts = line.split(separator: "\"", omittingEmptySubsequences: false)
            literals += stride(from: 1, to: parts.count, by: 2).map { String(parts[$0]) }
        }
    }
    #expect(literals.count > 100, "the scan found almost nothing")
    for literal in literals {
        // a wire token (`same_as_assistant`) is a key, not a word anyone reads
        let isWireToken = literal.range(of: #"^[a-z_]+$"#, options: .regularExpression) != nil && literal.contains("_")
        #expect(isWireToken || !literal.localizedCaseInsensitiveContains("assistant"), "\"\(literal)\"")
        #expect(literal.range(of: #"\bMetis\b"#, options: .regularExpression) == nil, "\"\(literal)\"")
    }
}

// MARK: - Helpers

/// A minute after the recorded presence's `as_of`: nothing is stale.
private let recordedNow = WireTime.date("2026-09-26T22:55:15.273Z")!

@MainActor
private func agentsModel(_ console: AgentsConsole, runner: RecordingRunner? = nil) -> (AgentsModel, ConsoleSession) {
    let session = ConsoleSession(transport: console, management: runner)
    return (AgentsModel(session: session, timeZone: TimeZone(identifier: "UTC")!, now: { recordedNow }), session)
}

/// The recorded registry, changed: agents by id, and the ceiling list.
private func registry(_ change: (inout [String: [String: JSONValue]]) -> Void, ceilings: [JSONValue] = []) -> JSONValue {
    let recorded = (try? ConsoleFixture.load("get-api-agents"))?.replyJSON ?? .null
    var order: [String] = []
    var byID: [String: [String: JSONValue]] = [:]
    for agent in recorded["agents"]?.arrayValue ?? [] {
        guard case .object(let o) = agent, let id = o["id"]?.stringValue else { continue }
        order.append(id)
        byID[id] = o
    }
    change(&byID)
    return .object([
        "agents": .array(order.compactMap { byID[$0].map(JSONValue.object) }),
        "access_requests": .array([]),
        "access_ceilings": .array(ceilings),
    ])
}

/// The recorded fixtures, with the registry and Scheduled replaceable, a
/// console that can be down, and every call logged.
private final class AgentsConsole: ConsoleCallTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _calls: [FixtureCall] = []
    private var _down: String?
    private var _registry: JSONValue?
    private var _scheduled: JSONValue?
    private let fallback = try? FixtureConsole.recorded()

    var calls: [FixtureCall] { lock.withLock { _calls } }
    func reset() { lock.withLock { _calls.removeAll() } }
    var down: String? { get { lock.withLock { _down } } set { lock.withLock { _down = newValue } } }
    var registry: JSONValue? { get { lock.withLock { _registry } } set { lock.withLock { _registry = newValue } } }
    var scheduled: JSONValue? { get { lock.withLock { _scheduled } } set { lock.withLock { _scheduled = newValue } } }

    func call(_ method: String, _ path: String, body: Data?, idempotencyKey: String?) async -> Result<Data, ConsoleError> {
        let sent = body.flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) }
        let scripted: Result<Data, ConsoleError>? = lock.withLock {
            _calls.append(FixtureCall(method: method, path: path, body: sent, idempotencyKey: idempotencyKey, lastEventID: nil, servedBy: nil))
            if let down = _down { return .failure(.transport(down)) }
            let bare = String(path.split(separator: "?").first ?? "")
            if method == "GET", bare == "/api/agents", let r = _registry { return .success(try! JSONEncoder().encode(r)) }
            if method == "GET", bare == "/api/scheduled", let s = _scheduled { return .success(try! JSONEncoder().encode(s)) }
            return nil
        }
        if let scripted { return scripted }
        guard let fallback else { return .failure(.transport("no fixtures")) }
        return await fallback.call(method, path, body: body, idempotencyKey: idempotencyKey)
    }
}

/// A management runner that records what it was handed and answers as told.
private final class RecordingRunner: ManagementRunner, @unchecked Sendable {
    private let lock = NSLock()
    private var _commands: [ManagementCommand] = []
    private var _result = CommandResult(exitCode: 0, stdout: "{}", stderr: "")

    var commands: [ManagementCommand] { lock.withLock { _commands } }
    var result: CommandResult { get { lock.withLock { _result } } set { lock.withLock { _result = newValue } } }

    func plannedArguments(_ command: ManagementCommand) -> [String] { ["metistry"] + command.arguments }

    func run(_ command: ManagementCommand, onOutput: @escaping @Sendable (OutputLine) -> Void) async throws -> CommandResult {
        lock.withLock {
            _commands.append(command)
            return _result
        }
    }
}
#endif

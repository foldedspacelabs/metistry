// Settings ▸ Compute (T6-12; screen-15 §5.3, C130–C133).
//
// The ticket's bold test is first: A MODEL IS WRITTEN THE SAME WAY IN EVERY
// PLACE IT APPEARS — the dropdown's field and menu, Your Models, a search
// result, a tier. Then the two doors: the client API for what a phone may also
// change (the model and its effort, a tier, a spending limit, a project's
// budget), each held to the route and the body it sends; and §2.2's M16/M17
// for the boundary (a provider's switch, gear and removal; a model's install,
// load and unload), each confirmed with the exact command before anything
// runs. Then components-03's state row, §2.18 (every control speaks; the
// largest text grows the pane longer, never wider) and the key's one path.
//
// The reads are the recorded fixtures (F-7, U9) or a scripted console; the
// verbs are a recording runner. Nothing here spawns a process, opens a file or
// touches a Keychain.

#if os(macOS)
import AppKit
import Foundation
import SwiftUI
import Testing

@testable import MetistryKit

// MARK: - A model, written one way (the bold test)

@MainActor
@Test func aModelIsWrittenTheSameWayInEveryPlaceItAppears() async throws {
    let (model, _, _) = try await fixtureModel()
    let ref = "lmstudio/google/gemma-3-4b"

    // the one line, from the catalogue: **name** maker · provider · tag
    let line = model.line(for: ref)
    #expect(line.text == "Gemma 3 4B Google \u{00B7} lmstudio \u{00B7} Local")
    #expect(line.spoken == "Gemma 3 4B, Google, lmstudio, Local")

    // the dropdown's menu — the assistant's and every tier's
    let inMenu = try #require(model.modelOptions().first { $0.ref == ref })
    let inTierMenu = try #require(model.modelOptions(including: "lmstudio/qwen").first { $0.ref == ref })
    // Your Models, with no search
    let inList = try #require(model.yourModels.onThisMac.first { $0.ref == ref })
    // a search result, grouped by model
    model.query = "gemma"
    await model.search()
    let result = try #require(model.visibleResults.first { $0.key == "gemma-3-4b" })
    let inResult = try #require(result.lines.first { $0.ref == ref })
    for other in [inMenu, inTierMenu, inList, inResult] {
        #expect(other == line, "\(other.text) ≠ \(line.text)")
    }
    // and the dropdown's field — the assigned value — is the same line too
    let assigned = try #require(model.assistantModel)
    #expect(model.modelOptions(including: assigned.ref).first { $0.ref == assigned.ref } == model.line(for: assigned.ref))
    // the menu item and the field say the same words as the list's view
    #expect(ModelMenu.menuText(line) == line.text)
    let cloud = model.line(for: "openrouter/google/gemma-3-4b-it")
    #expect(cloud.text == "Gemma 3 4B Google \u{00B7} openrouter \u{00B7} Cloud")
    #expect(ModelMenu.menuText(cloud) == "\(cloud.text)    $0.02 / $0.04 per M")

    // a model the catalogue does not hold is still written the same shape:
    // name, provider, the provider's own tag
    let bare = model.line(for: "lmstudio/qwen")
    #expect(bare.text == "qwen lmstudio \u{00B7} Local")
    #expect(model.tiers.map { model.line(for: $0.ref) } == [bare])
}

@Test func thereIsNoByTokenTagAndASubscriptionPlaceIsInThePlan() {
    #expect(ComputeTag.allCases.map(\.label) == ["Local", "Cloud", "Subscription"])
    #expect(ComputeModelLine.price(inPerM: 3, outPerM: 15, included: true) == "In your plan")
    #expect(ComputeModelLine.price(inPerM: 0.1, outPerM: nil, included: false) == "$0.10 per M")
    #expect(ComputeModelLine.price(inPerM: nil, outPerM: nil, included: false) == nil)
    // an unknown wire tag is read as off this Mac, never as local
    #expect(ComputeTag(wire: "by_token") == .cloud)
}

// MARK: - Reading: GET /api/compute and its catalogue

@MainActor
@Test func thePaneReadsTheRecordedRouteAndItsLimits() async throws {
    let (model, console, _) = try await fixtureModel()
    #expect(model.phase == .read)
    #expect(console.calls.map { "\($0.method) \($0.path.split(separator: "?").first ?? "")" } == ["GET /api/compute", "GET /api/compute/catalogue"])
    // the switch and the one tag, as served
    let ollama = try #require(model.report?.provider(named: "ollama"))
    #expect(!ollama.enabled)
    #expect(ollama.tag == .local)
    #expect(model.report?.provider(named: "openrouter")?.secretName == "openrouter_api_key")
    // a switched-off provider is not offered
    #expect(!model.modelOptions().contains { $0.provider == "ollama" })
    // T4-19's limits, side by side
    let limits = try #require(model.limits)
    #expect(limits.instance?.scope == "instance")
    #expect(limits.instance?.spentThisMonth == 0.0245)
    #expect(limits.providers.map(\.name) == ["openrouter", "lmstudio", "ollama"])
    #expect(limits.projects?.map(\.id) == ["metistry"])
    // the assistant uses the default; the rest are tiers
    #expect(model.assistantModel?.ref == "lmstudio/gemma")
    #expect(model.tiers.map(\.target) == ["fast"])
    // SettingsModel's summary is the same read
    #expect(ComputePaneView.usesTitle("Aide") == "Aide Uses")
}

@MainActor
@Test func aSubscriptionsWindowIsItsLimitAndHasNoDollars() async throws {
    let body = computeBody(limits: """
    { "instance": { "kind": "usd", "scope": "instance", "field": "budgets.instance", "daily_usd": 5, "monthly_usd": null, "action": "stop", "spent": { "daily": 1, "monthly": 3 } },
      "providers": [ { "name": "claude", "tag": "subscription", "enabled": true, "kind": "window", "scope": "provider:claude", "used": { "calls_today": 4, "calls_this_month": 90 } } ],
      "projects": null }
    """)
    let (model, _) = await scriptedModel(["GET /api/compute": .success(Data(body.utf8))])
    let claude = try #require(model.limits?.providers.first)
    #expect(claude.isWindow)
    #expect(claude.dollar == nil)
    #expect(ComputePaneView.windowWords(claude).contains("window is its limit"))
    #expect(ComputePaneView.windowWords(claude).contains("4 calls today, 90 this month"))
    #expect(model.limits?.instance?.action == .stop)
    // projects_rollup not loaded is not an empty list
    #expect(model.limits?.projects == nil)
}

// MARK: - The client-API writes, at once

@MainActor
@Test func theAssistantsModelAndEffortAreOneAssignOnTheDefault() async throws {
    let (model, console, runner) = try await fixtureModel()
    console.reset()
    await model.assign(target: "default", ref: "openrouter/google/gemma-3-4b-it", effort: .high)
    let post = try #require(console.calls.first)
    #expect(post.method == "POST" && post.path == "/api/compute/assign")
    #expect(post.body == .object(["tier": .string("default"), "model": .string("openrouter/google/gemma-3-4b-it"), "effort": .string("high")]))
    #expect(model.lastOutcome?.ok == true)
    #expect(model.lastOutcome?.message.contains(model.line(for: "openrouter/google/gemma-3-4b-it").text) == true)
    // and it re-read what it changed; no §2.2 verb ran
    #expect(console.calls.dropFirst().first?.path == "/api/compute")
    #expect(runner.commands.isEmpty)
}

@MainActor
@Test func aTierIsAssignedAndRemovedThroughTheRoutesAndACrewIsItsOwnKey() async throws {
    let (model, console, _) = try await fixtureModel()
    console.reset()
    await model.unassign(target: "fast")
    #expect(console.calls.first?.path == "/api/compute/unassign")
    #expect(console.calls.first?.body == .object(["tier": .string("fast")]))
    console.reset()
    await model.assign(target: "crew:collator", ref: "lmstudio/qwen", effort: .low)
    #expect(console.calls.first?.body?["crew"] == .string("collator"))
    #expect(console.calls.first?.body?["tier"] == nil)
    // default is reassigned, never unassigned
    console.reset()
    await model.unassign(target: "default")
    #expect(console.calls.isEmpty)
}

@MainActor
@Test func aSpendingLimitIsTheBudgetRouteAndAnEmptyFieldIsLeftAlone() async throws {
    let (model, console, _) = try await fixtureModel()
    console.reset()
    await model.setLimit(scope: "provider:openrouter", daily: 20, monthly: nil, action: .criticalOnly)
    let post = try #require(console.calls.first)
    #expect(post.path == "/api/compute/budget")
    #expect(post.body?["scope"] == .string("provider:openrouter"))
    #expect(post.body?["daily"] == .number(20))
    #expect(post.body?["monthly"] == nil)
    #expect(post.body?["action"] == .string("critical_only"))
    #expect(model.lastOutcome?.message.contains("enforced before every call") == true)
    // a project's daily budget is the Projects door, not compute.yaml
    console.reset()
    await model.setProjectBudget("metistry", daily: 5)
    #expect(console.calls.first?.method == "PUT")
    #expect(console.calls.first?.path == "/api/projects/metistry")
    #expect(console.calls.first?.body?["daily_budget_usd"] == .number(5))
}

@MainActor
@Test func aRefusalIsTheConsolesOwnSentenceNamingTheField() async throws {
    let refusal = #"{"error":{"code":"invalid_request","message":"budgets.providers.claude: a subscription provider has no dollar limit — its plan's window is its limit"}}"#
    let (model, _) = await scriptedModel([
        "GET /api/compute": .success(Data(computeBody().utf8)),
        "POST /api/compute/budget": .failure(.http(status: 400, envelope: ConsoleErrorEnvelope(json: try JSONDecoder().decode(JSONValue.self, from: Data(refusal.utf8))))),
    ])
    await model.setLimit(scope: "provider:claude", daily: 5, monthly: nil, action: .stop)
    #expect(model.lastOutcome?.ok == false)
    #expect(model.lastOutcome?.message == "budgets.providers.claude: a subscription provider has no dollar limit — its plan's window is its limit")
}

// MARK: - §2.2, confirmed first

@MainActor
@Test func aProvidersSwitchIsM16ConfirmedWithTheExactCommandBeforeAnythingRuns() async throws {
    let (model, _, runner) = try await fixtureModel()
    let openrouter = try #require(model.report?.provider(named: "openrouter"))
    model.proposeSwitch(openrouter, on: false)
    let pending = try #require(model.confirmation)
    #expect(pending.command.row == .computeProviders)
    #expect(pending.said == "metistry compute providers set openrouter --enabled off --json")
    #expect(pending.cost.contains("Refused while an assignment still names it"))
    // nothing ran on the proposal
    #expect(runner.commands.isEmpty)
    // the switch that is already where it is asks nothing
    model.cancelConfirmation()
    model.proposeSwitch(openrouter, on: true)
    #expect(model.confirmation == nil)

    model.proposeSwitch(openrouter, on: false)
    await model.confirm(try #require(model.confirmation))
    #expect(runner.commands.map(\.arguments) == [["compute", "providers", "set", "openrouter", "--enabled", "off", "--json"]])
    #expect(model.confirmation == nil)
    #expect(model.running == nil)
}

@MainActor
@Test func removingIsDestructiveAndARefusalIsTheCLIsOwnWords() async throws {
    let runner = ComputeRecordingRunner()
    runner.result = CommandResult(exitCode: 1, stdout: "", stderr: "metistry compute: openrouter is still named by budgets.providers.openrouter — /i/compute.yaml was NOT changed\n")
    let (model, _, _) = try await fixtureModel(runner: runner)
    model.proposeRemove(try #require(model.report?.provider(named: "openrouter")))
    let pending = try #require(model.confirmation)
    #expect(pending.destructive)
    #expect(pending.said == "metistry compute providers remove openrouter --json")
    #expect(pending.cost.contains("The secret openrouter_api_key stays"))
    await model.confirm(pending)
    #expect(model.lastOutcome?.ok == false)
    #expect(model.lastOutcome?.message.contains("budgets.providers.openrouter") == true)
    #expect(model.lastOutcome?.message.contains("was NOT changed") == true)
}

@MainActor
@Test func theGearSendsOnlyWhatChangedAndTheKeyIsASecretsName() async throws {
    let (model, _, runner) = try await fixtureModel()
    let openrouter = try #require(model.report?.provider(named: "openrouter"))
    model.openGear(openrouter)
    // nothing changed: nothing to confirm
    #expect(model.gear?.command == nil)
    model.gear?.secret = "openrouter_work"
    model.gear?.billing = .subscription
    #expect(model.gear?.command?.arguments == ["compute", "providers", "set", "openrouter", "--secret", "openrouter_work", "--billing", "subscription", "--json"])
    model.proposeGearSave()
    #expect(model.gear == nil)
    #expect(model.confirmation?.said == "metistry compute providers set openrouter --secret openrouter_work --billing subscription --json")
    #expect(runner.commands.isEmpty)
    // a local provider has no key and no billing to set
    model.cancelConfirmation()
    model.openGear(try #require(model.report?.provider(named: "lmstudio")))
    #expect(model.gear?.billing == nil)
    model.gear?.baseURL = "http://127.0.0.1:1235/v1"
    #expect(model.gear?.command?.arguments == ["compute", "providers", "set", "lmstudio", "--base-url", "http://127.0.0.1:1235/v1", "--json"])
}

@MainActor
@Test func loadIsOfferedOnlyWhereItIsRealAndSaysLoadingIntoMemory() async throws {
    let runner = ComputeRecordingRunner()
    runner.lines = ["loading google/gemma-3-4b"]
    runner.result = CommandResult(exitCode: 0, stdout: #"{"provider":"lmstudio","server":"lmstudio","model":"google/gemma-3-4b","ok":true,"detail":"google/gemma-3-4b loaded"}"#, stderr: "")
    let (model, _, _) = try await fixtureModel(runner: runner)
    let line = model.line(for: "lmstudio/google/gemma-3-4b")
    model.proposeLoad(line, unload: false)
    let pending = try #require(model.confirmation)
    #expect(pending.command.row == .localModels)
    #expect(pending.said == "metistry compute models load lmstudio/google/gemma-3-4b --json")
    #expect(pending.waiting == "Loading into memory…")
    #expect(pending.cost.contains("GB of memory is free for a model (an estimate)"))
    await model.confirm(pending)
    #expect(model.lastOutcome?.message == "google/gemma-3-4b loaded")
    #expect(model.output.map(\.text).contains("loading google/gemma-3-4b"))

    // a provider with no addressable load gets no Load at all
    model.proposeLoad(ComputeModelLine(ref: "openrouter/x", name: "x", maker: nil, provider: "openrouter", tag: .cloud, price: nil), unload: false)
    #expect(model.confirmation == nil)
}

@MainActor
@Test func anInstallSaysDiskAndMemoryBeforeItRunsAndStreamsItsProgress() async throws {
    let runner = ComputeRecordingRunner()
    runner.lines = ["downloading qwen3:8b", "  12% · 600 MB of 5.0 GB", "  100% · 5.0 GB"]
    runner.result = CommandResult(exitCode: 0, stdout: #"{"provider":"lmstudio","server":"lmstudio","model":"qwen/qwen3-8b","ok":true,"detail":"5.0 GB"}"#, stderr: "")
    let (model, _, _) = try await fixtureModel(runner: runner)
    #expect(model.installableProviders == ["lmstudio", "llamaserver"])
    model.beginInstall()
    model.install?.model = "qwen/qwen3-8b"
    model.proposeInstall()
    let pending = try #require(model.confirmation)
    #expect(pending.said == "metistry compute models install lmstudio/qwen/qwen3-8b --json")
    #expect(pending.cost.contains("212 GB free on this Mac\u{2019}s disk"))
    #expect(pending.cost.contains("12.0 GB of memory is free for a model (an estimate)"))
    await model.confirm(pending)
    #expect(model.output.map(\.text) == runner.lines)
    #expect(model.lastOutcome?.ok == true)
}

@MainActor
@Test func aCLIOlderThanTheVerbIsToldAboutRatherThanReportedAsAFailedWrite() async throws {
    let runner = ComputeRecordingRunner()
    runner.result = CommandResult(exitCode: 2, stdout: "", stderr: "unknown command: compute\n")
    let (model, _, _) = try await fixtureModel(runner: runner)
    model.proposeRemove(try #require(model.report?.provider(named: "ollama")))
    await model.confirm(try #require(model.confirmation))
    #expect(model.lastOutcome?.ok == false)
    #expect(model.lastOutcome?.message == "this CLI has no `compute providers remove` verb yet — update it (metistry update, or Check for Updates…)")
}

@Test func everyVerbThePaneRunsIsOneOfSection2point2s() {
    // the switch, the gear, removal, and the models on this Mac — M16, M17
    #expect(ManagementCommand(.computeProviders, ["compute", "providers", "set", "x", "--enabled", "off"]) != nil)
    #expect(ManagementCommand(.localModels, ["compute", "models", "install", "ollama/qwen3:8b"]) != nil)
    // inside the boundary is the API, never a verb
    #expect(ManagementCommand(.computeProviders, ["compute", "assign", "default", "x/y"]) == nil)
    #expect(ManagementCommand(.computeProviders, ["compute", "budget", "instance"]) == nil)
    // and there is no verb that removes a model, so no button pretends to
    #expect(ManagementCommand(.localModels, ["compute", "models", "remove", "ollama/qwen3:8b"]) == nil)
}

// MARK: - components-03 §2: the state row

@MainActor
@Test func aProvidersIssueIsItsTestItsKeyOrItsServerAndNamesItsAction() async throws {
    let rejected = #"{"name":"openrouter","ok":false,"url":"https://openrouter.ai/api/v1","models":[],"detail":"https://openrouter.ai/api/v1/models → HTTP 401","notes":[]}"#
    let (model, _) = await scriptedModel([
        "GET /api/compute": .success(Data(computeBody(openrouterKeyPresent: false).utf8)),
        "POST /api/compute/providers/test": .success(Data(rejected.utf8)),
    ], status: await doctoredStatus(lmstudioStatus: "failed"))
    let openrouter = try #require(model.report?.provider(named: "openrouter"))
    // the key it names is not set
    #expect(model.issue(for: openrouter) == .keyNotSet)
    #expect(ProviderIssue.keyNotSet.actionLabel == "Replace Key")
    // a test that came back 401: the key was rejected
    await model.testProvider("openrouter")
    #expect(model.issue(for: openrouter) == .keyRejected)
    // a local server doctor found not running
    let lmstudio = try #require(model.report?.provider(named: "lmstudio"))
    #expect(model.issue(for: lmstudio) == .notRunning)
    #expect(ProviderIssue.notRunning.actionLabel == "Retry")
    // anything else that failed is *Not answering*
    #expect(ProviderIssue.fromFailure("connect ECONNREFUSED 127.0.0.1:1234") == .notAnswering)
}

@MainActor
@Test func aSilentProviderIsNamedAndAListFromYesterdaySaysSo() async throws {
    let catalogue = """
    { "query": "", "providers": [
        { "name": "openrouter", "tag": "cloud", "ok": false, "detail": "https://openrouter.ai/api/v1/models → timed out", "count": 0, "read_at": "2026-09-28T09:00:00.000Z" },
        { "name": "lmstudio", "tag": "local", "ok": true, "detail": "3 model(s)", "count": 3, "read_at": "2026-09-27T09:00:00.000Z" } ],
      "skipped": [ { "name": "ollama", "why": "switched off" } ], "rows": [] }
    """
    let (model, _) = await scriptedModel([
        "GET /api/compute": .success(Data(computeBody().utf8)),
        "GET /api/compute/catalogue": .success(Data(catalogue.utf8)),
    ], now: "2026-09-28T12:00:00.000Z")
    let notes = model.catalogueNotes
    #expect(notes.first { $0.provider == "openrouter" }?.silent == true)
    #expect(notes.first { $0.provider == "openrouter" }?.words.contains("timed out") == true)
    #expect(notes.first { $0.provider == "lmstudio" }?.words == "lmstudio\u{2019}s list is from yesterday")
    #expect(notes.first { $0.provider == "ollama" }?.words == "ollama is not searched — switched off")
    #expect(ComputeModel.staleWords("2026-09-25T09:00:00.000Z", now: WireTime.date("2026-09-28T12:00:00.000Z")!) == "from 3 days ago")
}

@MainActor
@Test func searchFiltersAndSortsWhatTheReplyCarriesAndSaysWhenNothingMatches() async throws {
    let (model, _, _) = try await fixtureModel()
    model.query = "gemma"
    await model.search()
    #expect(model.visibleResults.map(\.key) == ["lmstudio/gemma", "gemma-3-4b"])
    let gemma = try #require(model.visibleResults.last)
    #expect(gemma.summary == "Local or cloud \u{00B7} from $0.02 per M")
    #expect(gemma.facts == "Google \u{00B7} 131K context \u{00B7} vision \u{00B7} 2 places")
    model.sort = .largestContext
    #expect(model.visibleResults.first?.key == "gemma-3-4b")
    model.filters = [.cloud]
    #expect(model.visibleResults.map(\.key) == ["gemma-3-4b"])
    model.filters = [.tools]
    #expect(model.visibleResults.isEmpty)
    #expect(model.noMatch == "No models match \u{201C}gemma\u{201D}")
    // an empty field is no search
    model.query = "  "
    await model.search()
    #expect(model.results == nil)
    #expect(model.noMatch == nil)
}

// MARK: - The engine banner

@MainActor
@Test func theAbsentAssistantIsSaidAndTheOnlyButtonIsTheOneThatFixesIt() async throws {
    let (empty, _) = await scriptedModel(["GET /api/compute": .success(Data(emptyBody.utf8))], status: await doctoredStatus())
    let banner = try #require(empty.engineBanner)
    #expect(banner.headline == "assistant: absent — no default assignment")
    #expect(banner.action == .addProvider)
    // doctor's own remediation, not a paraphrase
    #expect(banner.detail.contains("metistry compute assign default"))
    // with a provider, the fix is the dropdown already on the pane
    let (one, _) = await scriptedModel(["GET /api/compute": .success(Data(oneProviderBody.utf8))], status: await doctoredStatus())
    #expect(one.engineBanner?.action == nil)
    // an engine: no banner
    let (running, _, _) = try await fixtureModel()
    #expect(running.engineBanner == nil)
    // the add-a-provider sheet on an install with no engine also assigns the default
    empty.openAddProvider(template: .lmstudio)
    #expect(empty.draft.assignsDefault)
}

// MARK: - The key's one path (the wizard's model, unchanged)

@MainActor
@Test func theKeyGoesToStdinAndNeverIntoAnArgument() async {
    let runner = FakeRunner(results: [CommandResult(exitCode: 0, stdout: #"{"name":"work"}"#, stderr: "")])
    let model = ComputeModel(status: StatusModel(cli: nil), cli: fakeCLI(runner))
    model.openAddProvider(template: .openrouter)
    model.draft.assignsDefault = false
    model.draft.providerName = "work"
    model.draft.apiKey = "  sk-or-v1-SECRET\n"
    await model.addProvider()
    let add = runner.calls[0]
    #expect(add.standardInput == "sk-or-v1-SECRET\n")
    for call in runner.calls {
        for argument in call.arguments { #expect(!argument.contains("SECRET")) }
    }
    #expect(model.draft.apiKey.isEmpty)
    #expect(model.lastOutcome?.ok == true)
}

// MARK: - this Mac

@Test func theLocalServersComeFromDoctorsOwnRowsAndAbsentIsNotAFailure() throws {
    let servers = try DoctorReport.decode(from: Data(localModelDoctorJSON().utf8)).localServers
    #expect(servers.map(\.server) == ["lmstudio", "ollama", "llamaserver", "applefm"])
    #expect(servers.first { $0.server == "lmstudio" }?.canLoad == true)
    #expect(servers.first { $0.server == "ollama" }?.status == .absent)
    #expect(servers.first { $0.server == "applefm" }?.canInstall == false)
}

@Test func theMemoryFigureSaysEstimateBecauseItIsOne() {
    let sixteen: UInt64 = 16 * 1024 * 1024 * 1024
    #expect(MemoryHeadroom.headroomBytes(physical: sixteen) == 12 * 1024 * 1024 * 1024)
    #expect(MemoryHeadroom.summary(physical: sixteen).contains("estimate"))
    #expect(DiskCapacity(totalBytes: 1000, availableBytes: 250).usedFraction == 0.75)
}

@Test func theProseTheCliPrintsBeforeItsJsonDoesNotHideTheJson() {
    #expect(JSONValue.parseTrailing(in: "stored\n{\n  \"name\": \"openrouter\"\n}")?.string("name") == "openrouter")
    #expect(JSONValue.parseTrailing(in: "nothing to do here\n") == nil)
}

@Test func theAssistantsNameIsNeverWrittenIntoThePane() throws {
    // CLAUDE.md: the name lives only in identity.yaml — the pane templates it
    let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("sources/kit")
    for file in ["compute-view.swift", "compute-model.swift"] {
        let body = try String(contentsOf: sources.appendingPathComponent(file), encoding: .utf8)
        let code = body.split(separator: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }.joined(separator: "\n")
        #expect(code.range(of: #"\bMetis\b"#, options: .regularExpression) == nil, "\(file) names the assistant")
    }
    #expect(ComputePaneView.usesTitle(nil) == "The Assistant Uses")
}

// MARK: - §2.18

@MainActor
@Test func everyControlOnTheComputePaneSpeaksItsName() async throws {
    let (model, _, _) = try await fixtureModel()
    let pane = try await AccessibilityProbe.snapshot(
        VStack(alignment: .leading, spacing: MetistrySpace.s5) { ComputePaneView(model: model, assistantName: "Aide") }
            .frame(width: SettingsLayout.pane)
    )
    defer { pane.close() }
    #expect(pane.unlabeledBesidesFields.isEmpty, "unlabeled: \(pane.unlabeledBesidesFields)")
    #expect(pane.fieldsWithoutAPrompt.isEmpty)
    for heading in ["Aide Uses", "Providers", "Your Models", "Spending Limits", "Advanced"] {
        #expect(pane.headings.contains(heading), "\(heading) is not a heading: \(pane.headings)")
    }
    // the provider's gear speaks its name; a model line is spoken whole
    #expect(pane.nodes.contains { $0.name == "openrouter settings" })
    #expect(pane.nodes.contains { $0.name == "Gemma 3 4B, Google, lmstudio, Local" })

    model.openGear(try #require(model.report?.provider(named: "openrouter")))
    let gear = try await AccessibilityProbe.snapshot(ProviderGearSheet(model: model))
    defer { gear.close() }
    #expect(gear.unlabeledBesidesFields.isEmpty)
    #expect(gear.fieldsWithoutAPrompt.isEmpty)
    model.gear = nil
    model.beginInstall()
    let install = try await AccessibilityProbe.snapshot(InstallModelSheet(model: model))
    defer { install.close() }
    #expect(install.unlabeledBesidesFields.isEmpty)
    #expect(install.fieldsWithoutAPrompt.isEmpty)
}

@MainActor
@Test func theLargestTextGrowsTheComputePaneLongerNeverWider() async throws {
    let (model, _, _) = try await fixtureModel()
    model.query = "gemma"
    await model.search()
    let width = SettingsLayout.pane
    var heights: [DynamicTypeSize: CGFloat] = [:]
    for size in [DynamicTypeSize.large, .accessibility5] {
        let renderer = ImageRenderer(content: VStack(alignment: .leading, spacing: MetistrySpace.s5) { ComputePaneView(model: model, assistantName: "Aide") }
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

private let fixedNow = WireTime.date("2026-09-27T12:00:00.000Z")!

/// The pane over the recorded console, a doctored status and a recording
/// runner, with this Mac's memory and disk fixed.
@MainActor
private func fixtureModel(runner: ComputeRecordingRunner = ComputeRecordingRunner()) async throws -> (ComputeModel, FixtureConsole, ComputeRecordingRunner) {
    let console = try FixtureConsole.recorded()
    let session = ConsoleSession(transport: console, management: runner)
    let model = ComputeModel(status: await doctoredStatus(), cli: nil, session: session)
    pin(model)
    await model.refresh()
    return (model, console, runner)
}

/// The pane over a console that answers exactly what it is told.
@MainActor
private func scriptedModel(
    _ replies: [String: Result<Data, ConsoleError>],
    status: StatusModel? = nil,
    now: String? = nil
) async -> (ComputeModel, ScriptedConsole) {
    let console = ScriptedConsole(replies)
    let session = ConsoleSession(transport: console, management: ComputeRecordingRunner())
    let model = ComputeModel(status: status ?? StatusModel(cli: nil), cli: nil, session: session)
    pin(model)
    if let now, let date = WireTime.date(now) { model.now = { date } }
    await model.refresh()
    return (model, console)
}

@MainActor
private func pin(_ model: ComputeModel) {
    model.physicalMemory = 16 * 1024 * 1024 * 1024
    model.diskCapacity = { DiskCapacity(totalBytes: 1_000_000_000_000, availableBytes: 212_000_000_000) }
    model.now = { fixedNow }
}

@MainActor
private func fakeCLI(_ runner: FakeRunner) -> MetistryCLI {
    MetistryCLI(
        runtime: MetistryRuntime(source: .path, executable: URL(fileURLWithPath: "/usr/local/bin/metistry")),
        runner: runner,
        instanceDir: URL(fileURLWithPath: "/i")
    )
}

/// A `StatusModel` that has really run `doctor --json`, through the same
/// `MetistryCLI` path the app uses, against a fake runner.
@MainActor
private func doctoredStatus(lmstudioStatus: String = "ok") async -> StatusModel {
    let status = StatusModel(cli: fakeCLI(FakeRunner(results: [CommandResult(exitCode: 0, stdout: localModelDoctorJSON(lmstudio: lmstudioStatus), stderr: "")])))
    await status.refresh()
    return status
}

/// `GET /api/compute` with one provider off this Mac and one on it.
private func computeBody(limits: String = "null", openrouterKeyPresent: Bool = true) -> String {
    """
    { "file": "<instance>/.metistry/compute.yaml", "instance_file": "<instance>/.metistry/compute.yaml",
      "providers": [
        { "name": "openrouter", "kind": "openai-compatible", "locality": "off_machine", "base_url": "https://openrouter.ai/api/v1", "zdr": true,
          "enabled": true, "tag": "cloud", "secret": "{{ secret.openrouter_api_key }}", "secret_name": "openrouter_api_key", "secret_present": \(openrouterKeyPresent), "models_assigned": [] },
        { "name": "lmstudio", "kind": "openai-compatible", "locality": "on_machine", "base_url": "http://127.0.0.1:1234/v1", "enabled": true, "tag": "local", "models_assigned": ["gemma"] } ],
      "assignments": [ { "target": "default", "provider": "lmstudio", "model": "gemma", "effort": "medium", "warn_non_zdr": false } ],
      "assigns_nothing": false, "spend": null, "limits": \(limits), "writable": true, "as_of": "2026-09-28T12:00:00.000Z" }
    """
}

private let emptyBody = #"{ "instance_file": "/i/compute.yaml", "providers": [], "assignments": [], "assigns_nothing": true, "writable": true }"#
private let oneProviderBody = #"{ "instance_file": "/i/compute.yaml", "assigns_nothing": true, "assignments": [], "writable": true, "providers": [ { "name": "lmstudio", "kind": "openai-compatible", "locality": "on_machine", "base_url": "http://127.0.0.1:1234/v1", "tag": "local", "models_assigned": [] } ] }"#

/// A doctor report with the rows this pane reads: the four local servers and
/// the `assistant` row absent for the reason the banner names.
private func localModelDoctorJSON(lmstudio: String = "ok") -> String {
    """
    {
      "as_of": "2026-09-17T09:00:00.000Z", "product_dir": "/p", "shape": "launchd", "ok": true,
      "rows": [
        { "name": "assistant", "kind": "service", "status": "absent", "latency_ms": 0,
          "probe": "compute.yaml assigns a default → the supervisor starts the engine",
          "remediation": "no assignments.default in compute.yaml — `metistry compute assign default <provider/model>`; meanwhile the assistant is not started at all (docs/ops/assistant-tools.md)" },
        { "name": "local:lmstudio", "kind": "local-model", "status": "\(lmstudio)", "latency_ms": 22, "probe": "http://127.0.0.1:1234/v1/models answers",
          "meta": { "url": "http://127.0.0.1:1234/v1", "models": ["google/gemma-3-4b", "gemma"], "loaded": 1, "provider": "lmstudio" } },
        { "name": "local:ollama", "kind": "local-model", "status": "absent", "latency_ms": 2, "probe": "http://127.0.0.1:11434/v1/models answers",
          "remediation": "Ollama is not answering — nothing is wrong unless you meant to run it", "meta": { "url": "http://127.0.0.1:11434/v1" } },
        { "name": "local:llamaserver", "kind": "local-model", "status": "ok", "latency_ms": 9, "probe": "http://127.0.0.1:7813/v1/models answers",
          "meta": { "url": "http://127.0.0.1:7813/v1", "models": ["qwen3-30b-q4"], "provider": "llamaserver" } },
        { "name": "local:applefm", "kind": "local-model", "status": "ok", "latency_ms": 6, "probe": "http://127.0.0.1:7810/v1/models answers",
          "meta": { "url": "http://127.0.0.1:7810/v1", "models": ["foundation-model"], "provider": "applefm" } }
      ]
    }
    """
}

/// Answers a scripted table, by `METHOD /path` (the query ignored).
private final class ScriptedConsole: ConsoleCallTransport, @unchecked Sendable {
    private let replies: [String: Result<Data, ConsoleError>]
    init(_ replies: [String: Result<Data, ConsoleError>]) { self.replies = replies }

    func call(_ method: String, _ path: String, body: Data?, idempotencyKey: String?) async -> Result<Data, ConsoleError> {
        let key = "\(method) \(path.split(separator: "?").first ?? "")"
        return replies[key] ?? .failure(.http(status: 404, envelope: ConsoleErrorEnvelope(code: "not_found", message: "no scripted reply for \(key)")))
    }
}

/// A §2.2 runner that records every command, streams the lines it is given,
/// and answers as told.
final class ComputeRecordingRunner: ManagementRunner, @unchecked Sendable {
    private let lock = NSLock()
    private var _commands: [ManagementCommand] = []
    private var _result = CommandResult(exitCode: 0, stdout: #"{"ok":true}"#, stderr: "")
    private var _lines: [String] = []

    var commands: [ManagementCommand] { lock.withLock { _commands } }
    var result: CommandResult { get { lock.withLock { _result } } set { lock.withLock { _result = newValue } } }
    var lines: [String] { get { lock.withLock { _lines } } set { lock.withLock { _lines = newValue } } }

    func plannedArguments(_ command: ManagementCommand) -> [String] { ["metistry"] + command.arguments }

    func run(_ command: ManagementCommand, onOutput: @escaping @Sendable (OutputLine) -> Void) async throws -> CommandResult {
        let (result, lines) = lock.withLock {
            _commands.append(command)
            return (_result, _lines)
        }
        for line in lines { onOutput(OutputLine(stream: .standardOutput, text: line)) }
        return result
    }
}

/// Answers a scripted list and records what each call was handed — arguments
/// and standard input both, because "the key is not in argv" is only a fact if
/// the test can see both.
private final class FakeRunner: CommandRunner, @unchecked Sendable {
    struct Call: Sendable {
        let arguments: [String]
        let standardInput: String?
    }

    private let lock = NSLock()
    private nonisolated(unsafe) var queued: [CommandResult]
    private nonisolated(unsafe) var recorded: [Call] = []

    init(results: [CommandResult]) {
        self.queued = results
    }

    var calls: [Call] { lock.withLock { recorded } }

    func run(
        executable: URL, arguments: [String], environment: [String: String],
        currentDirectory: URL?, standardInput: String?, onOutput: @escaping @Sendable (OutputLine) -> Void
    ) async throws -> CommandResult {
        let result: CommandResult = lock.withLock {
            recorded.append(Call(arguments: arguments, standardInput: standardInput))
            return queued.isEmpty ? CommandResult(exitCode: 0, stdout: "{}", stderr: "") : queued.removeFirst()
        }
        for line in result.stdout.split(separator: "\n", omittingEmptySubsequences: false) {
            onOutput(OutputLine(stream: .standardOutput, text: String(line)))
        }
        return result
    }
}
#endif

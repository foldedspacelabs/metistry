// Work ▸ Projects (T6-8). Built against the recorded fixtures first — the
// projects, the registry, the board, the feed — and a scripted console where a
// fixture cannot say it (a budget's flip, an empty list, a refusal).
//
// The ticket's bold test is the first: **a chosen Review is never tinted; a
// budget-forced one is.** Then the list, a project, the confirmations, the
// grants, and §2.18. macOS only, as the accessibility probe is
// (shell-accessibility-tests.swift).

#if os(macOS)
import AppKit
import Foundation
import SwiftUI
import Testing

@testable import MetistryKit

// MARK: - The ticket's test

@MainActor
@Test func aChosenReviewIsNeverTintedAndABudgetForcedOneIs() async throws {
    let (model, _, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    let recorded = try #require(model.project("metistry"))
    // The recording: in Review since the row was made, no change on record — someone's choice.
    #expect(recorded.mode == "review")
    #expect(recorded.lastModeChange == nil)
    #expect(ProjectMode(recorded) == .review(since: nil))

    let toggled = project(recorded, change: ProjectModeChange(at: at("14:40"), by: "user", reason: "toggle", to: "review"))
    let forced = project(recorded, budget: 3, spent: 3.2, change: ProjectModeChange(at: at("14:40"), by: "budget", reason: "budget", to: "review"))
    // Over its budget, and the owner then set it back and into Review again: still a choice.
    let chosenOverBudget = project(recorded, budget: 3, spent: 3.2, change: ProjectModeChange(at: at("15:10"), by: "user", reason: "toggle", to: "review"))

    for chosen in [recorded, toggled, chosenOverBudget] {
        let chip = ProjectModeChip(ProjectMode(chosen))
        #expect(!chip.isTinted, "a chosen Review took a state colour: \(chip)")
        #expect(chip.text == "Review")
        #expect(chip.glyph == .reviewMode, "the review mark")
        #expect(chip.outlineWidth == 2, "weight: the heavier outline")
        #expect(chip.plate == nil)
    }
    let tinted = ProjectModeChip(ProjectMode(forced))
    #expect(ProjectMode(forced) == .overBudget(since: at("14:40")))
    #expect(tinted.isTinted, "the budget's Review is a fault, and takes the tint")
    #expect(tinted.plate == .degradedQuiet)
    #expect(tinted.text == "Review · over budget")
    #expect(tinted.spoken == "Review, over budget", "the tint is said in words, never colour alone")

    let autonomous = ProjectModeChip(ProjectMode(project(recorded, mode: "autonomous", change: ProjectModeChange(at: at("09:00"), by: "user", reason: "toggle", to: "autonomous"))))
    #expect(!autonomous.isTinted)
    #expect(autonomous.outlineWidth == 1 && autonomous.glyph == nil, "a quiet outline")

    // …and as drawn: the rows say which, in words.
    let console = ProjectsConsole()
    console.projects = [projectJSON(forced, id: "forced"), projectJSON(toggled, id: "chosen")]
    let (scripted, s2) = projectsModel(console)
    defer { withExtendedLifetime(s2) {} }
    await scripted.load()
    let tree = try await AccessibilityProbe.snapshot(projectsView(scripted).frame(width: 820, height: 700))
    defer { tree.close() }
    let said = tree.labels + tree.texts
    #expect(said.contains { $0.hasPrefix("Metistry, Review, over budget, ") }, "\(said)")
    #expect(said.contains { $0.hasPrefix("Metistry, Review, 1 agent") && !$0.contains("over budget") }, "\(said)")
}

// MARK: - The list

@MainActor
@Test func theListReadsTheRecordedProjectWithTheBoardsBlockedCount() async throws {
    let (model, console, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    #expect(model.list.map(\.id) == ["metistry"])
    let p = try #require(model.project("metistry"))
    #expect(p.members == ["assistant", "cursor"], "the rollup lists the instance's own agent in every project")
    #expect(p.grants == ProjectGrant(tier: "areas", areas: ["Projects/Metistry"]))
    #expect(model.blockedCount("metistry") == 1, "the board's Blocked column, counted")
    // The instance's own agent inherits nothing and is not counted as joined (T4-7).
    #expect(model.agentCount(p) == 1)
    let row = ProjectRowWords(p, agents: model.agentCount(p), blocked: model.blockedCount(p.id), now: recordedNow)
    #expect(row.facts == "1 agent · 4 open · 1 blocked · active 1 hour ago")
    #expect(row.spend.line == "$0.00 today · no budget")
    #expect(row.spoken == "Metistry, Review, 1 agent, 4 open, 1 blocked, active 1 hour ago, $0.00 today · no budget")
    // One read path each: the list, the registry, the board — nothing else.
    let asked = Set(console.calls.map { String($0.path.split(separator: "?").first ?? "") })
    #expect(asked == ["/api/projects", "/api/agents", "/api/q/board"], "\(asked)")
}

@Test func theSpendBarTakesTheTintOnlyAtTheBudget() {
    let under = ProjectSpend(spent: 1.2, budget: 5)
    #expect(under.line == "$1.20 of $5 today")
    #expect(under.barInk == .accent && !under.isOver)
    #expect(under.fraction == 0.24)
    let over = ProjectSpend(spent: 5.2, budget: 5)
    #expect(over.isOver && over.barInk == .degraded)
    #expect(over.fraction == 1)
    #expect(over.spoken == "$5.20 of $5 today, over budget")
    let none = ProjectSpend(spent: 0, budget: nil)
    #expect(none.fraction == nil, "no budget, no bar to fill")
    #expect(none.line == "$0.00 today · no budget")
}

@MainActor
@Test func anEmptyListLeadsToTheBoardNeverToNewProject() async throws {
    let console = ProjectsConsole()
    console.projects = []
    let (model, session) = projectsModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.load()
    #expect(model.paint == .content(staleSince: nil))
    var wentToBoard = false
    let tree = try await AccessibilityProbe.snapshot(ProjectsView(model: model, assistantName: "Aide", tick: .seconds(3600), onGoToBoard: { wentToBoard = true }).frame(width: 820, height: 600))
    defer { tree.close() }
    let said = tree.labels + tree.texts
    #expect(said.contains { $0.contains("No Projects Yet") }, "\(said)")
    #expect(said.contains { $0.contains(ProjectsWords.emptySentence) }, "\(said)")
    #expect(tree.controlNames.contains { $0.hasPrefix(ProjectsWords.openBoard) }, "\(tree.controlNames)")
    #expect(!tree.controlNames.contains { $0.localizedCaseInsensitiveContains("New Project") }, "projects appear on first use (plan §1.4)")
    #expect(!wentToBoard)
}

@MainActor
@Test func oldSpendSaysWhenItIsFromAndOffersSyncNow() async throws {
    let console = ProjectsConsole()
    let (model, session) = projectsModel(console, now: recordedNow.addingTimeInterval(40 * 60))
    defer { withExtendedLifetime(session) {} }
    await model.load()
    guard case .content(let since?) = model.paint else { Issue.record("\(model.paint)"); return }
    let band = StaleBandModel("Spend", asOf: since, when: .age, action: ProjectsWords.syncNow).presentation(now: model.now(), clock: model.clock)
    #expect(band.text.text == "Spend as of 1 hour ago", "components-03 §2: *Spend as of 40 minutes ago* · Sync Now")
    #expect(band.controls.map(\.label) == ["Sync Now"])
}

@MainActor
@Test func aConsoleThatDoesNotAnswerIsTheFailedPanelWithTryAgain() async throws {
    let console = ProjectsConsole()
    console.down = (503, "connect ECONNREFUSED 127.0.0.1:1")
    let (model, session) = projectsModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.load()
    guard case .failed(let why) = model.paint else { Issue.record("\(model.paint)"); return }
    #expect(why.contains("ECONNREFUSED"))
}

// MARK: - A project

@MainActor
@Test func aProjectsAgentsShowOnlyWhatTheyHoldBeyondIt() async throws {
    let (model, _, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    let p = try #require(model.project("metistry"))
    let members = model.members(of: p)
    #expect(members.map(\.id) == ["cursor"], "the instance's own agent is drawn apart, never as a member that inherits")
    let cursor = try #require(members.first)
    // cursor's own Projects, its approval, and its own queries flag — not the
    // project's Projects/Metistry, and not its tools on the project's work.
    #expect(cursor.line == "+ Projects · Areas/Ops (Approved in Needs You · #4) · Named queries")
    #expect(cursor.spoken == "Cursor, + Projects · Areas/Ops (Approved in Needs You · #4) · Named queries")
    #expect(model.ownAgent(of: p)?.id == "assistant")
    #expect(ProjectsWords.ownAgentLine("Aide") == "Aide works in every project on its own access. It inherits nothing from a project.")

    // A member that holds nothing beyond the project says so.
    let inherited = PermissionRow(resource: PermissionResource(kind: "knowledge"), label: "Knowledge", read: [PermissionEntry(key: "Projects/Metistry", label: "Projects/Metistry", provenance: .project("metistry"))])
    #expect(ProjectMember.beyond(agent("qa", permissions: [inherited]), in: p) == .projectOnly)
    #expect(ProjectMember(id: "qa", name: "QA", kind: "external", reach: .projectOnly).line == "project access only")
    // Another project's grant is beyond THIS one, and carries its name.
    let other = PermissionRow(resource: PermissionResource(kind: "knowledge"), label: "Knowledge", read: [PermissionEntry(key: "Areas/Beta", label: "Areas/Beta", provenance: .project("beta"))])
    guard case .beyond(let extra) = ProjectMember.beyond(agent("qa", permissions: [other]), in: p) else { Issue.record("no extra"); return }
    #expect(ProjectMember(id: "qa", name: "QA", kind: "external", reach: .beyond(extra)).line == "+ Areas/Beta (via project beta)")
}

@MainActor
@Test func theProjectsGrantIsDrawnInCoresWordsAsEveryMemberGetsThese() throws {
    #expect(ProjectGrant(tier: "areas", areas: ["Projects/Metistry"], queries: true).rows.map(PermissionRowText.rowText) == [
        ["Knowledge", "Projects/Metistry", "—"], ["Queries", "Named queries", "—"],
    ])
    #expect(ProjectGrant(tier: "index").rows.map(PermissionRowText.rowText) == [["Knowledge", "Titles only", "—"]])
    #expect(ProjectGrant(tier: "none").rows.isEmpty && ProjectGrant(tier: "none").isEmpty)
    #expect(ProjectGrant(tier: "widen", areas: ["Areas/X"]).rows.isEmpty, "an unknown tier is none, as core reads a stored grant")
    // The words are core's own (packages/core/src/access.ts): one table, three surfaces.
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let access = try String(contentsOf: root.appendingPathComponent("packages/core/src/access.ts"), encoding: .utf8)
    #expect(access.contains("TITLES_ONLY_LABEL = \"\(ProjectsWords.titlesOnly)\""))
    #expect(access.contains("WHOLE_VAULT_LABEL = \"\(ProjectsWords.wholeVault)\""))
    #expect(access.contains("verb(\"named\", \"\(ProjectsWords.namedQueries)\")"))
    #expect(access.contains("knowledge: \"Knowledge\"") && access.contains("queries: \"Queries\""))
}

@MainActor
@Test func theHeaderSaysWhyAndOverBudgetOffersRaiseBudget() async throws {
    let clock = ClockTime(timeZone: utc)
    let base = ProjectRecord(id: "metistry", title: "Metistry", mode: "review", dailyBudgetUSD: 3, maxOpenBundles: 20)
    let forced = project(base, change: ProjectModeChange(at: at("14:40"), by: "budget", reason: "budget", to: "review"))
    #expect(ProjectsWords.budgetLine(forced) == "$3 a day · 20 handoffs at once")
    #expect(ProjectsWords.budgetLine(project(base, budget: .some(nil))) == "No daily budget · 20 handoffs at once")
    #expect(ProjectsWords.sinceLine(forced, now: recordedNow, clock: clock) == "review since 27 Sep, 2:40 PM (over budget)")
    #expect(ProjectsWords.overBudgetSentence(forced, now: at("16:00"), clock: clock) == "Went over its $3 budget at 2:40 PM. Handoffs between agents now come to you.")
    let chosen = project(base, change: ProjectModeChange(at: at("14:40"), by: "user", reason: "toggle", to: "review"))
    #expect(ProjectsWords.sinceLine(chosen, now: at("16:00"), clock: clock) == "review since 2:40 PM (you set it)")
    #expect(ProjectsWords.overBudgetSentence(chosen, now: at("16:00"), clock: clock) == nil, "a choice has no fault to explain")

    let console = ProjectsConsole()
    console.projects = [projectJSON(forced, id: "metistry")]
    let (model, session) = projectsModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.load()
    await model.open("metistry")
    var raised = false
    let tree = try await AccessibilityProbe.snapshot(ProjectsView(model: model, assistantName: "Aide", tick: .seconds(3600), onRaiseBudget: { raised = true }).frame(width: 820, height: 1400))
    defer { tree.close() }
    #expect(tree.controlNames.contains { $0.hasPrefix(ProjectsWords.raiseBudget) }, "\(tree.controlNames)")
    #expect((tree.labels + tree.texts).contains { $0.hasPrefix("Went over its $3 budget at") }, "\(tree.labels + tree.texts)")
    #expect(!raised)
}

// MARK: - The confirmations (§4)

@MainActor
@Test func backToAutonomousConfirmsWithTheDestructiveButtonAndSendsOnlyThen() async throws {
    let (model, console, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    let p = try #require(model.project("metistry"))
    model.requestMode(review: true, for: p)
    #expect(model.confirmation == nil, "already in Review: nothing to ask")

    console.reset()
    model.requestMode(review: false, for: p)
    let pending = try #require(model.confirmation)
    #expect(pending.cost.title == "Set Metistry Back to Autonomous?")
    #expect(pending.cost.costs == ["Its agents will hand work to each other without you again."])
    #expect(pending.cost.presentation().controls.last == ControlSpec("Set to Autonomous", role: .destructive), "destructive role on the button (§3.12, P3)")
    #expect(console.calls.isEmpty, "nothing is sent until the owner confirms")

    model.cancel()
    #expect(model.confirmation == nil && console.calls.isEmpty)

    model.requestMode(review: false, for: p)
    await model.confirm()
    let put = try #require(console.calls.first { $0.method == "PUT" })
    #expect(put.path == "/api/projects/metistry")
    #expect(put.body == .object(["mode": .string("autonomous")]))
    #expect(console.calls.contains { $0.method == "GET" && $0.path == "/api/projects" }, "the row is read again after")
}

@Test func intoReviewSaysHowManyHandoffsWillWait() throws {
    let p = ProjectRecord(id: "metistry", title: "Metistry", mode: "autonomous", bundlesInFlight: 3)
    let c = try #require(ProjectsModel.modeConfirmation(review: true, for: p))
    #expect(c.cost.title == "Set Metistry to Review?")
    #expect(c.cost.costs == ["3 handoffs in flight will wait for you."])
    #expect(c.cost.presentation().controls.last == ControlSpec("Set to Review", role: .primary), "the safe direction confirms, but is not destructive")
    #expect(c.act == .setMode(project: "metistry", to: "review"))
    let one = try #require(ProjectsModel.modeConfirmation(review: true, for: ProjectRecord(id: "a", bundlesInFlight: 1)))
    #expect(one.cost.costs == ["1 handoff in flight will wait for you."])
    let none = try #require(ProjectsModel.modeConfirmation(review: true, for: ProjectRecord(id: "a")))
    #expect(none.cost.costs == ["Handoffs between its agents will come to you."])
}

@MainActor
@Test func addingAnAgentNamesExactlyWhatItInherits() async throws {
    let (model, console, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    let p = try #require(model.project("metistry"))
    // Connected, let in, not a member: the instance's own agent and a crew are never offered.
    #expect(model.candidates(for: p).map(\.id) == ["old-laptop", "opencode"])

    let opencode = try #require(model.agents.section.value?.first { $0.id == "opencode" })
    model.requestAdd(opencode, to: p)
    let pending = try #require(model.confirmation)
    #expect(pending.cost.title == "Add OpenCode to Metistry?")
    #expect(pending.cost.costHeading == "Joining is a grant. OpenCode will reach:")
    #expect(pending.cost.costs == [
        "Metistry's tasks and artifacts, as far as its own permissions reach them",
        "Knowledge, read: Projects/Metistry — inherited from Metistry",
    ])
    #expect(pending.cost.presentation().controls.last?.label == "Add to Project")

    // One that already reads what the project grants inherits nothing more — and is told so.
    let reader = agent("reader", permissions: [PermissionRow(resource: PermissionResource(kind: "knowledge"), label: "Knowledge", read: [PermissionEntry(key: "Projects", label: "Projects")])])
    #expect(ProjectMember.inherits(reader, from: p).isEmpty)
    let told = try #require(ProjectsModel.addConfirmation(reader, to: p))
    #expect(told.cost.costs.last == "Nothing more to inherit — it already reads what Metistry grants")
    // Titles only adds nothing to an agent that reads content; the queries flag nothing to one that has it.
    let indexed = project(p, grants: ProjectGrant(tier: "index", queries: true))
    #expect(ProjectMember.inherits(reader, from: indexed).map(PermissionRowText.rowText) == [["Queries", "Named queries", "—"]])

    console.reset()
    model.requestAdd(opencode, to: p)
    await model.confirm()
    let put = try #require(console.calls.first { $0.method == "PUT" })
    #expect(put.path == "/api/agents/opencode/projects")
    #expect(put.body == .object(["projects": .array([.string("metistry")])]), "PUT replaces the list: its projects, and this one")
}

@MainActor
@Test func aRefusedToggleSaysWhyAndChangesNothingOnScreen() async throws {
    let console = ProjectsConsole()
    console.refuse = (400, "mode must be autonomous | review")
    let (model, session) = projectsModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.load()
    let p = try #require(model.project("metistry"))
    model.requestMode(review: false, for: p)
    await model.confirm()
    #expect(model.notice == "Not changed — mode must be autonomous | review")
    #expect(model.project("metistry")?.mode == "review", "the list shows what the console says")
}

// MARK: - §2.18

@MainActor
@Test func theListAndAProjectSpeakEveryRowAndEveryControl() async throws {
    let (model, _, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    let list = try await AccessibilityProbe.snapshot(projectsView(model).frame(width: 820, height: 600))
    #expect(list.unlabeledControls.isEmpty, "unlabeled: \(list.unlabeledControls)")
    #expect(list.headings.contains("Projects"), "\(list.headings)")
    #expect((list.labels + list.texts).contains { $0.hasPrefix("Metistry, Review, 1 agent, 4 open, 1 blocked") }, "\(list.labels + list.texts)")
    list.close()

    await model.open("metistry")
    let detail = try await AccessibilityProbe.snapshot(projectsView(model).frame(width: 820, height: 1600))
    defer { detail.close() }
    #expect(detail.unlabeledControls.isEmpty, "unlabeled: \(detail.unlabeledControls)")
    for h in ["Metistry", "In Flight", "Permissions", "Agents", "Recent Runs"] {
        #expect(detail.headings.contains(h), "headings: \(detail.headings)")
    }
    let controls = detail.controlNames
    for name in ["Back to Projects", "Review", ProjectsWords.addAgent] {
        #expect(controls.contains { $0.hasPrefix(name) }, "controls: \(controls)")
    }
    let said = detail.labels + detail.texts
    #expect(said.contains("Review"), "the chip says its mode: \(said)")
    #expect(said.contains(ProjectsWords.everyMemberGetsThese), "\(said)")
    #expect(said.contains("Cursor, + Projects · Areas/Ops (Approved in Needs You · #4) · Named queries"), "\(said)")
    #expect(said.contains(ProjectsWords.ownAgentLine("Aide")), "templated, never a hardcoded name: \(said)")
    #expect(said.contains("Blocked, 1"), "\(said)")
    #expect(said.contains { $0.hasPrefix("Handoffs in flight, 0 of 20") }, "\(said)")
    #expect(detail.saysAssistant.isEmpty, "the configured name, never the internal word: \(detail.saysAssistant)")
}

@MainActor
@Test func aProjectRowGrowsLongerNeverWiderAtTheLargestText() throws {
    let p = ProjectRecord(id: "metistry", title: "Metistry, and a longer name that wraps", mode: "review", dailyBudgetUSD: 3, members: ["a", "b"], openTasks: 12, spendTodayUSD: 3.2, lastActivity: recordedNow.addingTimeInterval(-7200), lastModeChange: ProjectModeChange(at: at("14:40"), by: "budget", reason: "budget", to: "review"))
    let pieces: [(String, AnyView)] = [
        ("row", AnyView(ProjectRowView(row: ProjectRowWords(p, agents: 2, blocked: 1, now: recordedNow)))),
        ("chip", AnyView(ProjectModeChipView(chip: ProjectModeChip(ProjectMode(p))))),
        ("fact", AnyView(ProjectFactRow(label: "Handoffs in flight", value: "3 of 20"))),
    ]
    let width: CGFloat = 320
    for (name, view) in pieces {
        var heights: [DynamicTypeSize: CGFloat] = [:]
        for size in [DynamicTypeSize.large, .accessibility5] {
            let renderer = ImageRenderer(content: view.frame(width: width).environment(\.dynamicTypeSize, size))
            renderer.proposedSize = ProposedViewSize(width: width, height: nil)
            renderer.scale = 1
            let image = try #require(renderer.cgImage, "\(name) did not render")
            #expect(CGFloat(image.width) <= width, "\(name) is \(image.width) wide at \(size), offered \(width)")
            heights[size] = CGFloat(image.height)
        }
        #expect((heights[.accessibility5] ?? 0) > (heights[.large] ?? 0), "\(name) did not grow at the largest text: \(heights)")
    }
}

@MainActor
@Test func openingProjectsNeverRaisesTheWindowsMinimum() async throws {
    let (model, _, session) = try await fixtureModel()
    let down = ProjectsConsole()
    down.down = (503, "connect ECONNREFUSED 127.0.0.1:1")
    let (failed, failedSession) = projectsModel(down)
    let (waiting, waitingSession) = projectsModel(ProjectsConsole())
    defer { withExtendedLifetime([session, failedSession, waitingSession]) {} }
    await failed.load()
    let window = try await ShellProbe.acrossTheSwitch { projectsView(model) }
    #expect(window.after.minimum.height <= max(window.before.minimum.height, 460), "opening Projects raised the window's minimum to \(window.after.minimum)")
    #expect(window.after.frame == window.before.frame)
    let probe = MinimumProbe()
    for (name, m) in [("list", model), ("failed", failed), ("waiting", waiting)] {
        let size = probe.minimum(of: projectsView(m))
        #expect(size.height <= 460, "\(name) asks for \(size) at the least")
    }
    await model.open("metistry")
    let detail = probe.minimum(of: projectsView(model))
    #expect(detail.height <= 460, "a project asks for \(detail) at the least")
}

@MainActor
@Test func everyInkOnProjectsClearsItsGround() {
    // The chip and the bar on the list's grounds: the surface, and a selected row's accent-quiet.
    let pairs: [(MetistryColorRole, MetistryColorRole, Double)] = [
        (.textPrimary, .surface, 4.5), (.textSecondary, .surface, 4.5), (.textPrimary, .accentQuiet, 4.5), (.textSecondary, .accentQuiet, 4.5),
        (.textPrimary, .degradedQuiet, 4.5), (.degraded, .degradedQuiet, 3), (.degraded, .surface, 3), (.degraded, .accentQuiet, 3),
        (.borderControl, .surface, 3), (.textPrimary, .elevated, 4.5), (.accent, .surface, 3), (.failed, .surface, 3),
    ]
    for scheme in [ColorScheme.light, .dark] {
        for (ink, ground, floor) in pairs {
            let ratio = Contrast.ratio(ink, ground, scheme)
            #expect(ratio >= floor, "\(ink.rawValue) on \(ground.rawValue) is \(ratio) in \(scheme)")
        }
    }
}

@Test func noStringInProjectsSourceSaysAssistantOrNamesOne() throws {
    let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("sources/kit")
    for file in ["projects-view.swift", "projects-model.swift"] {
        let text = try String(contentsOf: dir.appendingPathComponent(file), encoding: .utf8)
        var literals: [String] = []
        for line in text.split(separator: "\n") where !line.trimmingCharacters(in: .whitespaces).hasPrefix("//") && !line.trimmingCharacters(in: .whitespaces).hasPrefix("///") {
            let code = line.components(separatedBy: " // ").first ?? String(line)
            let parts = code.split(separator: "\"", omittingEmptySubsequences: false)
            literals += stride(from: 1, to: parts.count, by: 2).map { String(parts[$0]) }
        }
        #expect(literals.count > 30, "\(file): the scan found almost nothing")
        // §2.18.4: nothing on the screen moves, so Reduce Motion has nothing to stop.
        #expect(!text.contains("withAnimation") && !text.contains(".animation(") && !text.contains(".transition("), "\(file)")
        // No bare key outside the menu table (C119).
        #expect(!text.contains(".keyboardShortcut("), "\(file)")
        for literal in literals {
            #expect(!literal.localizedCaseInsensitiveContains("assistant"), "\(file): \"\(literal)\"")
            #expect(literal.range(of: #"\bMetis\b"#, options: .regularExpression) == nil, "\(file): \"\(literal)\"")
            // C94: the glossary's words, never the old ones.
            #expect(literal.range(of: #"\b(Supervised|Auto)\b"#, options: .regularExpression) == nil, "\(file): \"\(literal)\"")
        }
    }
}

// MARK: - Helpers

private let utc = TimeZone(identifier: "UTC")!
/// An hour after the recorded projects fixture.
private let recordedNow = WireTime.date("2026-09-28T23:04:20.779Z")!

/// 27 Sep at a UTC clock time.
private func at(_ hhmm: String) -> Date {
    WireTime.date("2026-09-27T\(hhmm):00.000Z")!
}

@MainActor
private func projectsModel(_ console: any ConsoleCallTransport, now: Date = recordedNow) -> (ProjectsModel, ConsoleSession) {
    let session = ConsoleSession(transport: console, management: nil)
    return (ProjectsModel(session: session, timeZone: utc, now: { now }), session)
}

@MainActor
private func fixtureModel() async throws -> (ProjectsModel, FixtureConsole, ConsoleSession) {
    let console = try FixtureConsole.recorded()
    let (model, session) = projectsModel(console)
    await model.load()
    return (model, console, session)
}

@MainActor
private func projectsView(_ model: ProjectsModel) -> ProjectsView {
    ProjectsView(model: model, assistantName: "Aide", tick: .seconds(3600), onOpenInObsidian: { _ in }, onRaiseBudget: {}, onOpenRun: { _ in }, onGoToBoard: {})
}

private func project(_ p: ProjectRecord, mode: String? = nil, budget: Double?? = .none, spent: Double? = nil, change: ProjectModeChange? = nil, grants: ProjectGrant? = nil) -> ProjectRecord {
    ProjectRecord(
        id: p.id, title: p.title, area: p.area, mode: mode ?? p.mode, dailyBudgetUSD: budget ?? p.dailyBudgetUSD,
        maxOpenBundles: p.maxOpenBundles, members: p.members, openTasks: p.openTasks, bundlesInFlight: p.bundlesInFlight,
        bundlesQueued: p.bundlesQueued, openThreads: p.openThreads, pendingReviews: p.pendingReviews,
        spendTodayUSD: spent ?? p.spendTodayUSD, lastActivity: p.lastActivity, lastModeChange: change ?? p.lastModeChange, grants: grants ?? p.grants
    )
}

private func projectJSON(_ p: ProjectRecord, id: String) -> JSONValue {
    var o: [String: JSONValue] = [
        "id": .string(id), "title": p.title.map(JSONValue.string) ?? .null, "area": .null, "mode": .string(p.mode),
        "daily_budget_usd": p.dailyBudgetUSD.map(JSONValue.number) ?? .null, "max_open_bundles": .number(Double(p.maxOpenBundles)),
        "members": .array(["assistant", "cursor"].map(JSONValue.string)), "open_tasks": .number(Double(p.openTasks)),
        "bundles_in_flight": .number(Double(p.bundlesInFlight)), "bundles_queued": .number(0), "open_threads": .number(0),
        "pending_reviews": .number(0), "spend_today_usd": .string(String(p.spendTodayUSD)), "last_activity": .null,
        "grants": .object(["tier": .string(p.grants.tier), "areas": .array(p.grants.areas.map(JSONValue.string))]),
    ]
    if let c = p.lastModeChange {
        o["last_mode_change"] = .object(["ts": .string(ISO8601DateFormatter().string(from: c.at!)), "by": .string(c.by), "reason": .string(c.reason), "to": .string(c.to)])
    } else {
        o["last_mode_change"] = .null
    }
    return .object(o)
}

private func agent(_ id: String, permissions: [PermissionRow]) -> AgentRecord {
    let rows = try! JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(permissions))
    let json: JSONValue = .object(["id": .string(id), "kind": .string("external"), "projects": .array([]), "permissions": rows])
    return try! JSONDecoder().decode(AgentRecord.self, from: JSONEncoder().encode(json))
}

/// The recorded fixtures, with the projects list scripted where a test needs
/// it to say something else — a refusal, and a console that is down.
private final class ProjectsConsole: ConsoleCallTransport, @unchecked Sendable {
    private let lock = NSLock()
    private let fallback = try! FixtureConsole.recorded()
    private var _projects: [JSONValue]?
    private var _down: (Int, String)?
    private var _refuse: (Int, String)?
    private var _calls: [FixtureCall] = []

    var projects: [JSONValue]? { get { lock.withLock { _projects } } set { lock.withLock { _projects = newValue } } }
    var down: (Int, String)? { get { lock.withLock { _down } } set { lock.withLock { _down = newValue } } }
    var refuse: (Int, String)? { get { lock.withLock { _refuse } } set { lock.withLock { _refuse = newValue } } }
    var calls: [FixtureCall] { lock.withLock { _calls } }

    func call(_ method: String, _ path: String, body: Data?, idempotencyKey: String?) async -> Result<Data, ConsoleError> {
        let sent = body.flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) }
        lock.withLock { _calls.append(FixtureCall(method: method, path: path, body: sent, idempotencyKey: idempotencyKey, lastEventID: nil, servedBy: nil)) }
        let bare = String(path.split(separator: "?", maxSplits: 1).first ?? "")
        if let (status, message) = down {
            return .failure(.http(status: status, envelope: ConsoleErrorEnvelope(code: "not_available", message: message)))
        }
        if method == "PUT", let (status, message) = refuse {
            return .failure(.http(status: status, envelope: ConsoleErrorEnvelope(code: "invalid_request", message: message)))
        }
        if method == "GET", bare == "/api/projects", let rows = projects {
            return .success(try! JSONEncoder().encode(JSONValue.object(["projects": .array(rows), "as_of": .string("2026-09-28T23:04:00.000Z")])))
        }
        return await fallback.call(method, path, body: body, idempotencyKey: idempotencyKey)
    }
}
#endif

// The permissions table (T4-6): the CLI, the console and MetistryKit print
// ONE table. The rows come from the server (core's `describePermissions`,
// carried on every `GET /api/agents` row); `PermissionsTable` says them in
// core's words (`permissionRowText`). This test holds the Kit to the recorded
// fixture in the very strings `apps/console/test/pwa-reads.test.ts` holds
// core, the CLI and the console's panel to — the same fixture, the same
// table, on both sides of the language boundary.

import Foundation
import Testing

@testable import MetistryKit

/// The table each recorded agent prints — identical to `ONE_TABLE` in apps/console/test/pwa-reads.test.ts.
private let oneTable: [String: [[String]]] = [
    "cursor": [
        ["Knowledge", "Projects, Areas/Ops (approved in Needs You · #4)", "—"],
        ["Work", "metistry", "Create, Update, Comment"],
        ["Artifacts", "metistry", "Publish, Comment, Review"],
        ["Inbox", "—", "Capture"],
        ["Queries", "Named queries", "—"],
    ],
    "old-laptop": [["Inbox", "—", "Capture"]],
    "opencode": [
        ["Work", "—", "Update ⏱, Comment ⏱, Dispatch ⏱"],
        ["Artifacts", "—", "Comment ⏱"],
        ["Inbox", "—", "Capture"],
    ],
    "assistant": [
        ["Knowledge", "The whole vault", "The whole vault"],
        ["Work", "All tasks", "Create, Update, Comment"],
        ["Artifacts", "All", "Publish, Comment, Review"],
        ["Inbox", "—", "Capture"],
        ["Queries", "Named queries", "—"],
        ["Agents", "—", "Delegate"],
    ],
    "researcher": [["Knowledge", "Projects, Resources", "—"]],
]

@Test func theKitPrintsTheRecordedPermissionsTableInCoresWords() throws {
    let fixture = try ConsoleFixture.load("get-api-agents")
    let list = try JSONDecoder().decode(AgentList.self, from: fixture.reply)
    #expect(Set(list.agents.map(\.id)) == Set(oneTable.keys))
    for agent in list.agents {
        let rows = try #require(agent.permissions, "\(agent.id) carries no permission rows")
        #expect(rows.map(PermissionsTable.rowText) == oneTable[agent.id], "\(agent.id)")
    }
    // the assistant's reach is configuration, never a grant (C52): every entry is the base, from the environment
    let assistant = try #require(list.agents.first { $0.id == "assistant" }?.permissions)
    #expect(assistant.flatMap { $0.read + $0.write }.allSatisfy { $0.provenance.kind == "base" })
}

@Test func absenceIsTheDashAndEveryMarkerIsSaidInWords() {
    let approved = AgentPermissionRow.Entry(key: "Areas/Finance", label: "Areas/Finance", provenance: .init(kind: "approved", proposalID: 311))
    let byHand = AgentPermissionRow.Entry(key: "Me/Health", label: "Me/Health", provenance: .init(kind: "approved"))
    let routine = AgentPermissionRow.Entry(key: "Areas/Ops", label: "Areas/Ops", provenance: .init(kind: "routine", routine: "morning-brief"))
    let asks = AgentPermissionRow.Entry(key: "create_issue", label: "create_issue", asks: true)
    #expect(PermissionsTable.cellText([]) == "—")
    #expect(PermissionsTable.entryText(approved) == "Areas/Finance (approved in Needs You · #311)")
    #expect(PermissionsTable.entryText(byHand) == "Me/Health (approved in Needs You)")
    #expect(PermissionsTable.entryText(routine) == "Areas/Ops (during morning-brief only)")
    let linear = AgentPermissionRow(resource: .init(kind: "connection", name: "linear"), label: "linear", read: [], write: [asks])
    #expect(PermissionsTable.rowText(linear) == ["linear ⧉", "—", "create_issue ⏱"])
}

@Test func anOlderConsoleSendsNoRowsAndTheKitSaysNothingRatherThanGuessing() throws {
    let json = Data(#"{"agents":[{"id":"x","revoked":false,"remote":false,"pending":false}]}"#.utf8)
    let list = try JSONDecoder().decode(AgentList.self, from: json)
    #expect(list.agents[0].permissions == nil)
}

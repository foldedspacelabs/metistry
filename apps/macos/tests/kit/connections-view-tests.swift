// Settings ▸ Connections — the list and one connection (T6-13a,
// screen-09-resources.md §10.1–§10.4, plan §2.6).
//
// The ticket's bold test is first: A SECRET HEADED FOR AN UNLISTED HOST
// BLOCKS THE PREVIEW — worked out the way core's egress door works it out
// (the exact host, and the port unless it is 443), shown blocked and never as
// sent, with *Allow <host>* the one confirmed M7 verb that would change it.
// Then the list and the detail against the recorded fixtures, every change a
// confirmed §2.2 verb exactly as argv, the words against the CLI's own, and
// §2.18 on the detail.

#if os(macOS)
import AppKit
import Foundation
import SwiftUI
import Testing

@testable import MetistryKit

// MARK: - A secret headed for an unlisted host blocks the preview

@Test func aSecretHeadedForAnUnlistedHostBlocksThePreview() throws {
    let key = secret("linear_key", hosts: ["api.linear.app"], grant: "on")
    func preview(_ url: String, _ secrets: [SecretPolicy]? = nil) throws -> WhatItSends {
        let row = try #require(ConnectionRow.parse(try JSONValue.parse(Data(httpConnection(url: url).utf8))))
        return try #require(WhatItSends.of(row, secrets: secrets ?? [key]))
    }

    // the connection's host is not on the key's Sent only to list: blocked, and not sent
    let unlisted = try preview("https://mcp.linear.app/mcp")
    #expect(unlisted.blocked)
    #expect(unlisted.sends.map(\.verdict) == [.hostNotListed(destination: "mcp.linear.app", listed: ["api.linear.app"])])
    #expect(unlisted.sends.first?.hostToAllow == "mcp.linear.app")
    #expect(unlisted.sends.first?.said.hasPrefix("Blocked") == true)
    #expect(unlisted.sends.first?.masked == "•••••• (linear_key)", "the name, masked — never a value")

    // the door's matching, exactly: a look-alike, another port, plain http's port 80
    for url in ["https://api.linear.app.evil.example/graphql", "https://api.linear.app:8443/graphql", "http://api.linear.app/graphql", "https://evil.example/?h=api.linear.app"] {
        #expect(try preview(url).blocked, "\(url) must block")
    }
    #expect(try preview("https://api.linear.app:8443/graphql").sends.first?.hostToAllow == "api.linear.app:8443")

    // on the list — the host lowercased, 443 implied — it is sent, and nothing blocks
    for url in ["https://api.linear.app/graphql", "https://API.Linear.app:443/graphql"] {
        let listed = try preview(url)
        #expect(!listed.blocked, "\(url)")
        #expect(listed.sends.map(\.verdict) == [.sent(to: "api.linear.app")])
    }

    // when the preview cannot tell, it shows nothing as sent: the list did not read, or the host is a variable
    let row = try #require(ConnectionRow.parse(try JSONValue.parse(Data(httpConnection(url: "https://api.linear.app/graphql").utf8))))
    #expect(WhatItSends.of(row, secrets: nil)?.blocked == true)
    #expect(try preview("https://{{ variable.linear_host }}/graphql").blocked)
    // a secret secrets.yaml does not describe lists no host at all
    #expect(try preview("https://api.linear.app/graphql", [secret("other", hosts: ["api.linear.app"], grant: "on")]).sends.map(\.verdict) == [.notDescribed])
    // listed but not granted to this connection: blocked; Ask First is sent after approval
    #expect(try preview("https://api.linear.app/graphql", [secret("linear_key", hosts: ["api.linear.app"], grant: nil)]).blocked)
    #expect(try preview("https://api.linear.app/graphql", [secret("linear_key", hosts: ["api.linear.app"], grant: "off")]).blocked)
    #expect(try preview("https://api.linear.app/graphql", [secret("linear_key", hosts: ["api.linear.app"], grant: "ask")]).sends.map(\.verdict) == [.sentAfterApproval(to: "api.linear.app")])
    // listed, granted, and this instance's Keychain holds no item: blocked
    #expect(try preview("https://api.linear.app/graphql", [secret("linear_key", hosts: ["api.linear.app"], grant: "on", present: false)]).blocked)
}

@MainActor
@Test func theDetailDrawsTheBlockedPreviewAndOnlyAllowHostWouldChangeIt() async throws {
    let (settings, runner, console) = try connectionsSettings(
        connection: httpConnection(url: "https://mcp.linear.app/mcp"),
        secrets: #"{"secrets":[{"name":"linear_key","hosts":["api.linear.app"],"grants":[{"to":"connection:linear","mode":"on"}],"expires":null,"present":true,"last_used":null}],"as_of":"2026-09-28T13:05:00.000Z"}"#
    )
    let pane = settings.connectionsPane
    await pane.refresh()
    await pane.open("linear")
    let row = try #require(pane.shown)
    #expect(pane.detailPhase == .read)
    // the list, the secret list and the variable names (T6-13b: what a variable field may pick) in any order, then the detail
    #expect(Set(console.calls.dropLast().map(\.path)) == ["/api/connections", "/api/secrets", "/api/variables"], "\(console.calls.map(\.path))")
    #expect(console.calls.last?.path == "/api/connections/linear")

    let tree = try await AccessibilityProbe.snapshot(
        ConnectionDetailView(row: row, pane: pane, settings: settings).padding(MetistrySpace.s5).frame(width: SettingsLayout.pane)
    )
    defer { tree.close() }
    let said = tree.nodes.map(\.name)
    #expect(said.contains { $0.hasPrefix("Blocked — Metistry would send nothing") }, "the preview is blocked: \(said)")
    #expect(said.contains { $0.contains("linear_key, masked. Blocked — mcp.linear.app is not on its Sent only to list (api.linear.app)") }, "\(said)")
    #expect(!said.contains { $0.contains("Sent to mcp.linear.app") }, "never drawn as sent")
    #expect(said.contains("Allow linear_key to be sent to mcp.linear.app"), "the fix, on its row")

    // Allow <host> is M7, confirmed with the whole list it writes — and runs nothing until confirmed
    let allow = try #require(pane.allowHost("mcp.linear.app", for: "linear_key"))
    #expect(allow.command == ManagementCommand(.secrets, ["secrets", "hosts", "linear_key", "api.linear.app", "mcp.linear.app"]))
    #expect(allow.said == "metistry secrets hosts linear_key api.linear.app mcp.linear.app")
    #expect(allow.after == .connections)
    #expect(runner.commands.isEmpty)
    #expect(pane.allowHost("api.linear.app", for: "linear_key") == nil, "already listed: nothing to allow")
}

// MARK: - The list

@MainActor
@Test func theListIsTheRecordedRouteWithTypeUsedByAndTheOfferMark() async throws {
    let (settings, runner, console) = try recordedSettings()
    let pane = settings.connectionsPane
    #expect(pane.phase == .idle)
    await pane.refresh()
    #expect(pane.phase == .read)
    #expect(console.calls.allSatisfy { $0.servedBy != nil }, "every read is a recorded route: \(console.calls)")

    let github = try #require(pane.rows.first)
    #expect(pane.rows.map(\.name) == ["github", "intranet"])
    #expect(github.kind == .mcp)
    #expect(github.status == .ok)
    #expect(github.typeLabel == "MCP · By command")
    #expect(github.reach == .command(command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], cwd: nil, env: ["GITHUB_PERSONAL_ACCESS_TOKEN", "GITHUB_TEAM"], runsOn: "host"))
    #expect(github.usedBy == [ConnectionUser(kind: "sync", name: "github-state")])
    #expect(!github.offerToAgents)
    #expect(github.tools(in: .changes).map(\.name) == ["create_issue", "delete_issue"])
    #expect(github.tools(in: .reads).map { $0.mode } == [.on])
    #expect(ConnectionListRow.spoken(github, expired: []) == "github, ok, MCP · By command, Used by sync github-state, not offered to agents")
    #expect(pane.policy(for: "github_mcp_key")?.hosts == ["api.github.com"])

    // a command's environment: granted On, given to the command only
    let sends = try #require(pane.whatItSends(github))
    #expect(sends.target == "npx -y @modelcontextprotocol/server-github")
    #expect(sends.sends.map(\.verdict) == [.givenToCommand])
    #expect(!sends.blocked)

    // Nobody yet is a real value; Key expired leads, in words
    let nobody = try #require(ConnectionRow.parse(try JSONValue.parse(Data(httpConnection(url: "https://api.linear.app/graphql").utf8))))
    #expect(ConnectionListRow.spoken(nobody, expired: ["linear_key"]) == "linear, ok, MCP · By URL, Key expired, Nobody yet, offered to agents")
    #expect(runner.commands.isEmpty, "reading runs nothing")

    // every control on the list speaks its name, and the pane has its heading
    let tree = try await AccessibilityProbe.snapshot(ConnectionsListView(pane: pane).frame(width: SettingsLayout.pane))
    defer { tree.close() }
    #expect(tree.unlabeledBesidesFields.isEmpty, "\(tree.unlabeledBesidesFields)")
    #expect(tree.headings.contains("Connections"))
    #expect(tree.controlNames.contains(ConnectionListRow.spoken(github, expired: [])), "\(tree.controlNames)")
}

@MainActor
@Test func aListThatCannotBeReadSaysWhyAndOffersTryAgain() async throws {
    let console = FixtureConsole([])
    let session = ConsoleSession(transport: console, management: SettingsRecordingRunner())
    let pane = ConnectionsModel(session: session)
    await pane.refresh()
    guard case .unavailable(let why) = pane.phase else {
        Issue.record("a list with no answer is unavailable, not empty: \(pane.phase)")
        return
    }
    #expect(why.contains("no fixture for GET /api/connections"))
    #expect(pane.rows.isEmpty)
    #expect(pane.secrets == nil, "and the preview will show nothing as sent")

    let tree = try await AccessibilityProbe.snapshot(ConnectionsListView(pane: pane).frame(width: SettingsLayout.pane))
    defer { tree.close() }
    #expect(tree.controlNames.contains(StateWords.tryAgain))
    #expect(tree.headings.contains("Couldn't Read Connections"))

    // with no session at all it says so rather than a blank pane
    let none = ConnectionsModel(session: nil)
    await none.refresh()
    #expect(none.phase == .unavailable("no console session for this instance"))
}

// MARK: - Who uses it, when it was checked, which header carries which secret (X-96)

@MainActor
@Test func theRecordedListSaysWhoUsesItWhenItWasCheckedAndWhichHeaderCarriesWhichSecret() async throws {
    let (settings, _, _) = try recordedSettings()
    let pane = settings.connectionsPane
    await pane.refresh()
    let github = try #require(pane.rows.first { $0.name == "github" })
    let intranet = try #require(pane.rows.first { $0.name == "intranet" })

    // an agent lent a connection is a user beside the syncs — the list says it, in words
    #expect(intranet.usedBy == [ConnectionUser(kind: "agent", name: "opencode")])
    #expect(ConnectionListRow.usedBy(intranet) == "Used by agent opencode")
    #expect(github.usedBy == [ConnectionUser(kind: "sync", name: "github-state")])

    // a check stamps its time and doctor's word; a connection nobody checked reads never
    let stamp = try #require(intranet.lastChecked)
    #expect(stamp.status == .degraded)
    #expect(stamp.at == WireTime.date("2026-09-30T06:50:00.000Z"))
    #expect(github.lastChecked == nil)
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    let said = stamp.said(locale: Locale(identifier: "en_US"), calendar: calendar)
    #expect(said.hasPrefix("Sep 30") && said.contains("6:50") && said.hasSuffix(" — degraded"), "\(said)")
    #expect(ConnectionDetailView.checked(github) == "Never checked")
    #expect(ConnectionDetailView.checked(intranet).hasPrefix("Last checked "))

    // each header with the secrets its value names: a header with no secret says so
    #expect(intranet.headerSecrets == [ConnectionHeader(name: "X-Api-Key", secrets: ["github_mcp_key"]), ConnectionHeader(name: "X-Team", secrets: [])])
    #expect(ConnectionDetailView.carries(intranet.headerSecrets[0]) == "{{ secret.github_mcp_key }}")
    #expect(ConnectionDetailView.carries(intranet.headerSecrets[1]) == "no secret")
    #expect(github.headerSecrets.isEmpty)
    #expect(ConnectionDetailView.carries(ConnectionHeader(name: "X-Org-Token", secrets: ["a", "b"])) == "{{ secret.a }}, {{ secret.b }}")
}

@MainActor
@Test func aHeaderPerSecretShowsASecretEachAndTheDetailDrawsTheCheck() async throws {
    let row = #"{"name":"relay","type":"mcp","provider":"custom","description":null,"status":"ok","issues":[],"reach":{"class":"http","url":"https://mcp.example.com/mcp","auth":"none","headers":["X-Api-Key","X-Org-Token"],"header_secrets":[{"header":"X-Api-Key","secrets":["relay_key"]},{"header":"X-Org-Token","secrets":["relay_org"]}],"query":[],"timeout_s":null},"secrets":["relay_key","relay_org"],"variables":[],"tools":[],"offer_to_agents":true,"used_by":[{"kind":"sync","name":"mirror"},{"kind":"crew","name":"scribe"}],"last_checked":{"at":"2026-10-01T08:00:00.000Z","status":"ok"}}"#
    let (settings, _, _) = try connectionsSettings(connection: row, secrets: #"{"secrets":[],"as_of":"2026-09-28T13:05:00.000Z"}"#)
    let pane = settings.connectionsPane
    await pane.refresh()
    await pane.open("relay")
    let shown = try #require(pane.shown)
    #expect(shown.headerSecrets.map(\.secrets) == [["relay_key"], ["relay_org"]], "two headers, two secret names")
    #expect(shown.usedBy.map(\.said) == ["sync mirror", "crew scribe"])
    #expect(shown.lastChecked?.status == .ok)

    let tree = try await AccessibilityProbe.snapshot(
        ConnectionDetailView(row: shown, pane: pane, settings: settings).padding(MetistrySpace.s5).frame(width: SettingsLayout.pane)
    )
    defer { tree.close() }
    let said = tree.nodes.map(\.name)
    // one line per header (the value beside it is `carries`, held above)
    #expect(said.contains { $0.contains("Header X-Api-Key") }, "\(said)")
    #expect(said.contains { $0.contains("Header X-Org-Token") }, "\(said)")
    #expect(!said.contains { $0 == "Headers" }, "the one-line list gives way to a line each: \(said)")
    #expect(said.contains { $0.hasPrefix("Last checked ") && $0.hasSuffix("ok") }, "the Check section says when: \(said)")

    // a console that predates the fields draws what it always did — the header names, and never checked
    let old = try #require(ConnectionRow.parse(try JSONValue.parse(Data(httpConnection(url: "https://api.linear.app/graphql").utf8))))
    #expect(old.lastChecked == nil && old.headerSecrets.isEmpty)
}

// MARK: - Every change is a §2.2 verb, confirmed

@MainActor
@Test func eachChangeIsAConfirmedConnectionsVerbExactlyAsArgv() async throws {
    let (settings, runner, console) = try recordedSettings()
    let pane = settings.connectionsPane
    await pane.refresh()
    await pane.open("github")
    let github = try #require(pane.shown)
    #expect(github.file == ".metistry/connections/github.yaml", "the detail route's own field")
    let create = try #require(github.tools.first { $0.name == "create_issue" })

    // a tool's mode: `policy <name> <tool> allow|ask|never`, in the owner's words
    let allow = try #require(pane.setMode(create, of: github, to: .on))
    #expect(allow.command == ManagementCommand(.connections, ["connections", "policy", "github", "create_issue", "allow"]))
    #expect(allow.title == "create_issue: Allow?")
    #expect(allow.actionTitle == "Allow")
    #expect(pane.setMode(create, of: github, to: .off)?.command.arguments == ["connections", "policy", "github", "create_issue", "never"])
    #expect(pane.setMode(create, of: github, to: .ask) == nil, "already Ask First: nothing to confirm")

    // the offer switch (C115), naming who reaches it when off
    let offer = try #require(pane.setOffer(true, of: github, assistantName: "Aide"))
    #expect(offer.command == ManagementCommand(.connections, ["connections", "policy", "github", "--offer", "on"]))
    #expect(pane.setOffer(false, of: github, assistantName: "Aide") == nil)

    // Test dials, so it says what it starts
    let test = try #require(pane.test(github))
    #expect(test.command == ManagementCommand(.connections, ["connections", "test", "github"]))
    #expect(test.cost.contains("starts npx on this Mac"))

    // Grant is M7
    #expect(pane.grant("github_mcp_key", to: github)?.command == ManagementCommand(.secrets, ["secrets", "grant", "github_mcp_key", "connection:github", "on"]))

    // nothing ran until the owner confirmed — then exactly the command they read, and the pane re-read
    #expect(runner.commands.isEmpty)
    console.reset()
    await settings.confirm(allow)
    #expect(runner.commands == [allow.command])
    #expect(settings.outcome?.command == "metistry connections policy github create_issue allow")
    #expect(console.calls.map(\.path).contains("/api/connections"), "re-read after the verb: \(console.calls.map(\.path))")
    #expect(console.calls.map(\.path).contains("/api/connections/github"))

    // every argument list the pane can build is a ManagementCommand — nothing else can run
    for command in [allow, offer, test].map(\.command) {
        #expect(command.row == .connections)
        #expect(!command.arguments.contains { $0.contains("{{") }, "a reference, never a value, and not even that on argv")
    }
}

@MainActor
@Test func backReturnsToTheListAndAnInstanceSwitchDropsEverything() async throws {
    let (settings, _, _) = try recordedSettings()
    let pane = settings.connectionsPane
    await pane.refresh()
    await pane.open("github")
    #expect(pane.selected == "github")
    pane.close()
    #expect(pane.shown == nil)
    #expect(!pane.rows.isEmpty)
    await pane.open("github")
    settings.adopt(cli: nil, instanceDir: nil)
    #expect(pane.rows.isEmpty && pane.selected == nil && pane.secrets == nil && pane.phase == .idle)
}

// MARK: - The words are the CLI's

@Test func theGroupsAndModesAreTheCLIsWords() throws {
    let cli = try String(contentsOf: repoRoot().appendingPathComponent("packages/cli/src/connections.ts"), encoding: .utf8)
    #expect(cli.contains(#"TOOL_MODE_LABEL: Readonly<Record<ToolMode, string>> = { on: "\#(ConnectionToolMode.on.title)", ask: "\#(ConnectionToolMode.ask.title)", off: "\#(ConnectionToolMode.off.title)" }"#))
    #expect(cli.contains(#"TOOL_GROUP_LABEL: Readonly<Record<ToolGroup, string>> = { reads: "\#(ConnectionToolGroup.reads.title)", changes: "\#(ConnectionToolGroup.changes.title)", starts_agent: "\#(ConnectionToolGroup.startsAgent.title)" }"#))
    #expect(ConnectionToolMode.allCases.map(\.verbWord) == ["allow", "ask", "never"])
    // the connection types are plan §2.6's closed list, as core names them
    let core = try String(contentsOf: repoRoot().appendingPathComponent("packages/core/src/connections.ts"), encoding: .utf8)
    for kind in ConnectionKind.allCases { #expect(core.contains("\"\(kind.rawValue)\""), "\(kind)") }
    // and the destination is the door's: host, and :port unless 443
    let egress = try String(contentsOf: repoRoot().appendingPathComponent("packages/core/src/egress.ts"), encoding: .utf8)
    #expect(egress.contains("entry: port === EGRESS_DEFAULT_PORT ? host : `${host}:${port}`"))
}

// MARK: - §2.18 on the detail

@MainActor
@Test func everyControlOnTheDetailSpeaksItsNameAndEachSectionIsAHeading() async throws {
    let (settings, _, _) = try recordedSettings()
    let pane = settings.connectionsPane
    await pane.refresh()
    await pane.open("github")
    let row = try #require(pane.shown)
    let tree = try await AccessibilityProbe.snapshot(
        ConnectionDetailView(row: row, pane: pane, settings: settings).padding(MetistrySpace.s5).frame(width: SettingsLayout.pane)
    )
    defer { tree.close() }
    #expect(tree.unlabeledBesidesFields.isEmpty, "unlabeled: \(tree.unlabeledBesidesFields)")
    for heading in ["github", "How Metistry Reaches It", "What It Sends", "Offer to Agents", "Tools", "Changes things", "Reads", "Used By", "Check"] {
        #expect(tree.headings.contains(heading), "\(heading) is not a heading: \(tree.headings)")
    }
    let controls = tree.controlNames
    for name in ["Back to all connections", "Offer github to agents through Metistry", "Test github"] {
        #expect(controls.contains(name), "\(name) not spoken: \(controls)")
    }
    // each tool's three modes say the tool they set
    #expect(controls.filter { $0.hasPrefix("create_issue: ") } == ["create_issue: Allow", "create_issue: Ask First", "create_issue: Never"])
    // secrets are references, and what the key may reach is on its row
    let said = tree.nodes.map(\.name)
    #expect(said.contains { $0.contains("{{ secret.github_mcp_key }}") && $0.contains("Sent only to: api.github.com") }, "\(said)")
    #expect(said.contains { $0.contains("Nobody yet") } == false, "github is used by a sync")
}

@MainActor
@Test func theDetailGrowsLongerNeverWiderAtTheLargestText() async throws {
    let (settings, _, _) = try connectionsSettings(
        connection: httpConnection(url: "https://mcp.linear.app/mcp"),
        secrets: #"{"secrets":[{"name":"linear_key","hosts":["api.linear.app"],"grants":[{"to":"connection:linear","mode":"on"}],"expires":"2026-01-01","present":true,"last_used":null}],"as_of":"2026-09-28T13:05:00.000Z"}"#
    )
    let pane = settings.connectionsPane
    await pane.refresh()
    await pane.open("linear")
    let row = try #require(pane.shown)
    #expect(pane.keyNeedsReplacing(row), "an expired key offers Replace Key")
    #expect(pane.expiredKeys(row) == ["linear_key"])
    let width = SettingsLayout.pane
    var heights: [DynamicTypeSize: CGFloat] = [:]
    for size in [DynamicTypeSize.large, .accessibility5] {
        for view in [AnyView(ConnectionDetailView(row: row, pane: pane, settings: settings)), AnyView(ConnectionsListView(pane: pane))] {
            let renderer = ImageRenderer(content: view.padding(MetistrySpace.s5).frame(width: width).environment(\.dynamicTypeSize, size))
            renderer.proposedSize = ProposedViewSize(width: width, height: nil)
            renderer.scale = 1
            let image = try #require(renderer.cgImage)
            #expect(CGFloat(image.width) <= width, "\(image.width) wide at \(size)")
            heights[size, default: 0] += CGFloat(image.height)
        }
    }
    #expect((heights[.accessibility5] ?? 0) > (heights[.large] ?? 0), "\(heights)")
}

@Test func nothingOnThePaneMovesBindsAKeyOrNamesTheAssistant() throws {
    let kit = repoRoot().appendingPathComponent("apps/macos/sources/kit")
    for file in ["connections-view.swift", "connections-model.swift"] {
        let text = try String(contentsOf: kit.appendingPathComponent(file), encoding: .utf8)
        #expect(!text.contains("withAnimation") && !text.contains(".animation(") && !text.contains(".transition("), "\(file)")
        #expect(!text.contains(".keyboardShortcut("), "\(file)")
        #expect(text.range(of: #"\bMetis\b"#, options: .regularExpression) == nil, "\(file)")
        // a value has no field to live in: nothing reads a header's or an environment variable's value
        #expect(!text.contains("\"value\""), "\(file)")
    }
}

// MARK: - Helpers

private func repoRoot() -> URL { HeldToCore.repoRoot }

private func secret(_ name: String, hosts: [String], grant: String?, present: Bool? = true) -> SecretPolicy {
    SecretPolicy(name: name, hosts: hosts, grants: grant.map { ["connection:linear": $0] } ?? [:], expires: nil, present: present)
}

/// One HTTP MCP connection, as `GET /api/connections` serves a row.
private func httpConnection(url: String) -> String {
    #"{"name":"linear","type":"mcp","provider":"custom","description":null,"status":"ok","issues":[],"reach":{"class":"http","url":"\#(url)","auth":"bearer","headers":[],"query":[],"timeout_s":null},"secrets":["linear_key"],"variables":[],"tools":[{"name":"list_issues","group":"reads","mode":"on"},{"name":"create_issue","group":"changes","mode":"ask"}],"offer_to_agents":true,"used_by":[]}"#
}

private func contract(_ route: String, _ path: String, _ body: String) throws -> ConsoleFixture {
    let data = Data(body.utf8)
    return ConsoleFixture(
        stem: "t6-13a\(path.replacingOccurrences(of: "/", with: "-"))", route: route, source: "contract", ticket: "T6-13a",
        method: "GET", path: path, body: nil, idempotencyKey: nil, lastEventID: nil,
        status: 200, reply: data, replyJSON: try JSONValue.parse(data), stream: nil
    )
}

/// Settings over a console that serves one connection and a secret list.
@MainActor
private func connectionsSettings(connection: String, secrets: String) throws -> (SettingsModel, SettingsRecordingRunner, FixtureConsole) {
    let name = try #require(try JSONValue.parse(Data(connection.utf8)).string("name"))
    let console = FixtureConsole([
        try contract("GET /api/connections", "/api/connections", #"{"connections":[\#(connection)],"as_of":"2026-09-28T13:05:00.000Z"}"#),
        try contract("GET /api/connections/:name", "/api/connections/\(name)", #"{"connection":\#(connection.dropLast()),"file":".metistry/connections/\#(name).yaml","provider_unit":null},"as_of":"2026-09-28T13:05:00.000Z"}"#),
        try contract("GET /api/secrets", "/api/secrets", secrets),
    ])
    return settings(over: console)
}

// MARK: - The Mac's loopback set is core's (X-95)

/// Every host core calls loopback the Mac calls loopback, and no other. Held to
/// core by the cases core's own test runs through `isLoopbackHost`
/// (`packages/core/test/held-to-core/loopback-hosts.json`, X-100) — not by a
/// table copied here or a scan of core's source text.
@Test func everyHostCoreCallsLoopbackTheMacCallsLoopbackAndNoOther() throws {
    let core = try HeldToCore.cases("loopback-hosts")
    let yes = HeldToCore.strings(core["loopback"])
    let no = HeldToCore.strings(core["not_loopback"])
    #expect(yes.count > 10 && no.count > 10, "the shared cases did not load")
    for host in yes { #expect(EgressDestination.isLoopbackHost(host), "core calls \(host.debugDescription) loopback") }
    // including the spellings the Mac used to accept (`*.localhost`) and the ones a regex port gets wrong
    for host in no { #expect(!EgressDestination.isLoopbackHost(host), "core does not call \(host.debugDescription) loopback") }

    // Both places the Mac decides "cleartext" use it: a URL, and an IMAP mailbox.
    func cleartext(_ url: String) throws -> Bool { try #require(EgressDestination(url: url)).cleartext }
    #expect(try !cleartext("http://localhost:7812/check") && !cleartext("http://[::1]:7812/") && !cleartext("http://127.4.5.6/"))
    #expect(try cleartext("http://foo.localhost/") && cleartext("http://0.0.0.0:8080/") && cleartext("http://example.com/"))
    #expect(try !cleartext("https://example.com/"))
    func mailbox(_ host: String, _ security: String = "plain") -> Bool? {
        ConnectionReach.imap(host: host, port: 143, security: security).imapDestination?.cleartext
    }
    #expect(mailbox("127.0.0.2") == false && mailbox("localhost") == false && mailbox("::1") == false && mailbox("LOCALHOST") == false)
    #expect(mailbox("foo.localhost") == true && mailbox("127.0.0.1.example.com") == true && mailbox("mail.example.com") == true)
    #expect(mailbox("mail.example.com", "tls") == false)
}

/// Settings over every recorded fixture.
@MainActor
private func recordedSettings() throws -> (SettingsModel, SettingsRecordingRunner, FixtureConsole) {
    settings(over: try FixtureConsole.recorded())
}

@MainActor
private func settings(over console: FixtureConsole) -> (SettingsModel, SettingsRecordingRunner, FixtureConsole) {
    let runner = SettingsRecordingRunner()
    let session = ConsoleSession(transport: console, management: runner)
    let settings = SettingsModel(status: StatusModel(cli: nil), cli: nil, instanceDir: nil, session: session, management: runner)
    return (settings, runner, console)
}
#endif

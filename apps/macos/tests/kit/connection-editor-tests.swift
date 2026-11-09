// Settings ▸ Connections ▸ Add Connection and Configure (T6-13b,
// screen-09-resources.md §10.5, plan §2.6–§2.7).
//
// The ticket's bold test is first: A CONNECTION TYPE LOADED FROM AN EXTENSION
// RENDERS ITS FORM — a type the console lists under `types` with `origin:
// extension` and a field of every closed kind is offered as a known service
// once its type is chosen, and its form is drawn from its fields, a secret
// and a variable field as pickers of NAMES (never a text field), an oauth
// field as a note — with no Swift that knows the service. Then: the draft
// becomes exactly one §2.2 verb, `connections add|set …` with `--config
// key=value`, a secret as its name; What it sends and the host guards on a
// draft, the way the detail draws them; the recorded fixtures' `types`;
// signing in is `connections authorize`, confirmed; save runs what the editor
// showed and a refusal keeps the draft; and §2.18 on the editor.

#if os(macOS)
import AppKit
import Foundation
import SwiftUI
import Testing

@testable import MetistryKit

/// An extension connection type with a field of every kind, as `GET /api/connections` serves it under `types` (T6-13b).
private let ACME_TYPE = #"""
{"name":"acme-tracker","title":"Acme Tracker","description":"Acme Tracker — issues and tasks at a workspace of yours.",
 "origin":"extension","provides":"mcp","transports":["http"],"auth":["none","bearer","oauth"],"capabilities":[],
 "fields":[
   {"key":"workspace","kind":"text","label":"Workspace","help":"The workspace's short name","required":true},
   {"key":"server","kind":"url","label":"Server","help":null,"required":false,"default":"https://mcp.acme.example/mcp"},
   {"key":"region","kind":"choice","label":"Region","help":null,"required":false,"default":"eu","choices":[{"value":"eu","label":"Europe"},{"value":"us","label":"United States"}]},
   {"key":"team","kind":"variable","label":"Team","help":null,"required":false},
   {"key":"api_key","kind":"secret","label":"API key","help":null,"required":false},
   {"key":"account","kind":"oauth","label":"Acme account","help":null,"required":false}],
 "tools":[{"name":"list_issues","group":"reads"}]}
"""#

// MARK: - A connection type loaded from an extension renders its form

@MainActor
@Test func aConnectionTypeLoadedFromAnExtensionRendersItsForm() async throws {
    let (settings, runner, _) = try editorSettings(types: [ACME_TYPE])
    let pane = settings.connectionsPane
    await pane.refresh()
    #expect(pane.types.map(\.name) == ["acme-tracker"])
    let acme = try #require(pane.types.first)
    #expect(acme.isExtension && acme.originTag == "Extension" && acme.provides == .mcp)
    #expect(acme.fields.map { "\($0.key):\($0.kind.rawValue)" } == ["workspace:text", "server:url", "region:choice", "team:variable", "api_key:secret", "account:oauth"])
    #expect(pane.types(providing: .mcp).map(\.name) == ["acme-tracker"], "offered once its type is chosen")
    #expect(pane.types(providing: .calendar).isEmpty)

    // type first, then the service: the extension's type is a tile beside Custom
    pane.beginAdd()
    pane.draft?.name = "work"
    pane.draft?.choose(kind: .mcp)
    let tiles = try await AccessibilityProbe.snapshot(ConnectionEditorView(pane: pane, settings: settings).padding(MetistrySpace.s5).frame(width: SettingsLayout.pane))
    #expect(tiles.controlNames.contains("Acme Tracker, extension: Acme Tracker — issues and tasks at a workspace of yours."), "\(tiles.controlNames)")
    #expect(tiles.controlNames.contains("Custom: By URL · By command"))
    tiles.close()

    // the form is the manifest's fields, by kind — no Swift knows Acme
    pane.draft?.choose(service: acme)
    #expect(pane.draft?.provider == "acme-tracker")
    #expect(pane.draft?.reaches == [.http], "the type's transports")
    #expect(pane.draft?.auths == [.none, .bearer, .oauth], "the type's declared sign-ins")
    let tree = try await AccessibilityProbe.snapshot(ConnectionEditorView(pane: pane, settings: settings).padding(MetistrySpace.s5).frame(width: SettingsLayout.pane))
    defer { tree.close() }
    #expect(tree.unlabeledBesidesFields.isEmpty, "unlabeled: \(tree.unlabeledBesidesFields)")
    for heading in ["Add Connection", "Service", "How Metistry Reaches It", "Settings", "Add"] {
        #expect(tree.headings.contains(heading), "\(heading): \(tree.headings)")
    }
    let controls = tree.controls
    let names = controls.map(\.name)
    // every field is labelled in words, and a text field speaks its prompt when empty (the probe reads a field's value, not its label)
    for label in ["Name", "Description", "URL", "Workspace", "Server (optional)", "Region (optional)", "Team (optional)", "API key (optional)"] {
        #expect(tree.texts.contains(label), "\(label): \(tree.texts)")
    }
    #expect(tree.fieldsWithoutAPrompt.isEmpty, "\(tree.fieldPrompts)")
    #expect(tree.fieldPrompts.contains("The workspace's short name"), "a text field's prompt is its help")
    #expect(tree.fieldPrompts.contains("https://mcp.acme.example/mcp"), "a url field's prompt is its default")
    // a choice, a variable and a secret are pickers of names — never a text field: the only text fields are the name, the description, the URL, the two typed fields
    let popups = controls.filter { $0.role == "AXPopUpButton" }
    #expect(popups.count == 5, "authentication, region, team, api_key, and the headers' reference picker: \(popups)")
    #expect(popups.contains { $0.name == "Default (Europe)" }, "the choice's default, named: \(popups.map(\.name))")
    #expect(controls.filter { $0.role == "AXTextField" }.count == 5, "\(controls.filter { $0.role == "AXTextField" })")
    #expect(!tree.fieldPrompts.contains { $0.localizedCaseInsensitiveContains("key") }, "no text field is for the key")
    #expect(names.contains("New secret for API key (optional)"), "a secret is stored through the Secrets sheet, never typed here")
    #expect(tree.texts.contains { $0.hasPrefix("Acme account: signed in after adding") }, "an oauth field is a note: \(tree.texts)")
    #expect(tree.texts.contains("The workspace's short name"), "a field's help is drawn")
    #expect(runner.commands.isEmpty, "rendering runs nothing")

    // the draft becomes the exact verb, a secret field as its NAME — the CLI writes the reference and refuses a value
    pane.draft?.url = "https://mcp.acme.example/mcp"
    #expect(pane.draft?.missing == ["Workspace"], "the one required field with no default")
    pane.draft?.fields["workspace"] = "platform"
    pane.draft?.fields["region"] = "us"
    pane.draft?.fields["team"] = "team_name"
    pane.draft?.fields["api_key"] = "acme_key"
    pane.draft?.auth = .bearer
    pane.draft?.secretName = "acme_key"
    #expect(pane.draft?.missing == [])
    #expect(pane.draft?.arguments == [
        "connections", "add", "work", "--type", "mcp", "--provider", "acme-tracker",
        "--url", "https://mcp.acme.example/mcp", "--auth", "bearer", "--secret", "acme_key",
        "--config", "workspace=platform", "--config", "region=us", "--config", "team=team_name", "--config", "api_key=acme_key",
    ])
    #expect(ManagementCommand(.connections, pane.draft!.arguments!) != nil)
    // a value typed where a name belongs stops the button
    pane.draft?.fields["api_key"] = "not a name"
    #expect(pane.draft?.missing == ["API key: the name of a secret"])
}

// MARK: - The draft is exactly one verb

@Test func theDraftBecomesExactlyOneVerbForEveryReach() throws {
    // custom HTTP with an API key and a header
    var d = ConnectionDraft()
    d.name = "costs"
    d.choose(kind: .api)
    d.choose(service: nil)
    #expect(d.reaches == [.http] && d.auths == [.none, .bearer, .apiKey, .oauth], "a custom one: any sign-in but Basic")
    d.url = "https://api.example.com/v1"
    d.auth = .apiKey
    d.authHeader = "X-API-Key"
    d.secretName = "costs_key"
    d.headers = [ConnectionNameValue(name: "Accept", value: "application/json")]
    d.description = "Cost Explorer"
    d.discover = false
    #expect(d.arguments == ["connections", "add", "costs", "--type", "api", "--url", "https://api.example.com/v1", "--auth", "api_key", "--auth-header", "X-API-Key", "--secret", "costs_key", "--header", "Accept=application/json", "--description", "Cost Explorer", "--no-discover"])

    // a command: the environment as name=value, the command line last, after --
    var c = ConnectionDraft()
    c.name = "github"
    c.choose(kind: .mcp)
    c.choose(service: nil)
    c.reach = .command
    c.commandLine = "npx -y @modelcontextprotocol/server-github"
    c.env = [ConnectionNameValue(name: "GITHUB_PERSONAL_ACCESS_TOKEN", value: "{{ secret.github_read }}")]
    c.runsInContainer = true
    #expect(c.arguments == ["connections", "add", "github", "--type", "mcp", "--env", "GITHUB_PERSONAL_ACCESS_TOKEN={{ secret.github_read }}", "--runs-on", "container", "--", "npx", "-y", "@modelcontextprotocol/server-github"])
    #expect(c.referencedSecrets == ["github_read"], "a reference typed into a value is a secret it names")

    // a path
    var f = ConnectionDraft()
    f.name = "notes"
    f.choose(kind: .files)
    f.choose(service: nil)
    #expect(f.reach == .path && f.reaches == [.path, .http])
    f.path = "~/Documents/Notes"
    f.include = "*.md, *.txt"
    f.skip = "drafts/**"
    #expect(f.arguments == ["connections", "add", "notes", "--type", "files", "--path", "~/Documents/Notes", "--include", "*.md", "--include", "*.txt", "--skip", "drafts/**"])

    // a mailbox, through a known service reached by imap: the app password by name, nothing else
    let gmail = try #require(ConnectionTypeSummary.parse(try JSONValue.parse(Data(#"{"name":"gmail-mail","title":"Gmail over IMAP","origin":"product","provides":"mail","transports":["imap"],"auth":["basic"],"capabilities":["read","draft"],"fields":[],"tools":[]}"#.utf8))))
    var m = ConnectionDraft()
    m.name = "gmail"
    m.choose(kind: .mail)
    #expect(m.missing.contains("a known service, or custom"))
    m.choose(service: gmail)
    #expect(m.reach == .imap)
    m.imapHost = "IMAP.gmail.com"
    m.username = "you@gmail.com"
    m.secretName = "gmail_app_password"
    #expect(m.arguments == ["connections", "add", "gmail", "--type", "mail", "--provider", "gmail-mail", "--imap", "imap.gmail.com", "--username", "you@gmail.com", "--secret", "gmail_app_password"])
    m.imapPort = "1993"
    m.imapPlain = true
    #expect(m.arguments?.suffix(4) == ["--secret", "gmail_app_password", "--plain"].suffix(4) || m.arguments?.contains("--plain") == true)
    #expect(m.arguments?.contains("imap.gmail.com:1993") == true)

    // a custom mail connection has nothing to run it
    var bare = ConnectionDraft()
    bare.name = "mail"
    bare.choose(kind: .mail)
    bare.choose(service: nil)
    #expect(bare.missing.first?.hasPrefix("a connection type — a custom mail has nothing to run it") == true)

    // custom OAuth brings its own client (C118)
    var o = ConnectionDraft()
    o.name = "tracker"
    o.choose(kind: .mcp)
    o.choose(service: nil)
    o.url = "https://mcp.example.com/mcp"
    o.auth = .oauth
    #expect(o.missing == ["the authorize URL (https)", "the token URL (https)", "at least one scope", "the secret your client id is kept in — a custom connection brings its own"])
    o.authorizeURL = "https://auth.example.com/authorize"
    o.tokenURL = "https://auth.example.com/token"
    o.scopes = "read offline_access"
    o.clientIdSecret = "tracker_client"
    #expect(o.arguments == ["connections", "add", "tracker", "--type", "mcp", "--url", "https://mcp.example.com/mcp", "--auth", "oauth", "--authorize-url", "https://auth.example.com/authorize", "--token-url", "https://auth.example.com/token", "--scope", "read", "--scope", "offline_access", "--client-id-secret", "tracker_client"])
    #expect(o.referencedSecrets == ["tracker_client", "tracker_oauth_token"], "the sign-in the CLI will keep, named ahead")

    // nothing a draft prints is a value: every argument is a name, a URL, a command word or a reference
    for args in [d.arguments!, c.arguments!, f.arguments!, m.arguments!, o.arguments!] {
        #expect(!args.contains { $0.contains("{{ secret.") && !$0.contains("=") }, "a reference rides only in a name=value pair: \(args)")
    }
}

@Test func configureSendsOnlyWhatChangedAsSetAndNothingWhenNothingDid() throws {
    let row = try #require(ConnectionRow.parse(try JSONValue.parse(Data(httpRow(url: "https://mcp.linear.app/mcp", auth: "bearer", headers: ["Accept"]).utf8))))
    var d = ConnectionDraft(configuring: row, type: nil)
    #expect(!d.isAdd && d.reach == .http && d.url == "https://mcp.linear.app/mcp" && d.auth == .bearer)
    #expect(d.headers.map(\.name) == ["Accept"] && d.headers.map(\.value) == [""], "a served header is a name; its value is not known here")
    #expect(d.arguments == nil, "nothing changed")
    #expect(d.missing == ["a change"])
    d.url = "https://mcp.linear.app/v2/mcp"
    d.description = "Linear's MCP server"
    d.headers[0].value = "application/json"
    #expect(d.arguments == ["connections", "set", "linear", "--url", "https://mcp.linear.app/v2/mcp", "--header", "Accept=application/json", "--description", "Linear's MCP server"])
    // a known service's field on set: only the ones filled ride, the rest keep what the file holds
    let acme = try #require(ConnectionTypeSummary.parse(try JSONValue.parse(Data(ACME_TYPE.utf8))))
    var known = ConnectionDraft(configuring: row, type: acme)
    known.fields["region"] = "us"
    #expect(known.arguments == ["connections", "set", "linear", "--config", "region=us"])
    #expect(known.missing == [], "a required field is not demanded again on set")
    // changing the sign-in
    var auth = ConnectionDraft(configuring: row, type: nil)
    auth.auth = .none
    #expect(auth.arguments == ["connections", "set", "linear", "--auth", "none"])
    // a command's line, changed
    let cmd = try #require(ConnectionRow.parse(try JSONValue.parse(Data(#"{"name":"gh","type":"mcp","provider":"custom","status":"ok","issues":[],"reach":{"class":"command","command":"npx","args":["-y","x"],"cwd":null,"env":["TOKEN"],"runs_on":"host"},"secrets":[],"variables":[],"tools":[],"offer_to_agents":false,"used_by":[]}"#.utf8))))
    var c = ConnectionDraft(configuring: cmd, type: nil)
    #expect(c.commandLine == "npx -y x" && c.env.map(\.name) == ["TOKEN"])
    #expect(c.arguments == nil)
    c.commandLine = "npx -y y"
    c.env[0].value = "{{ secret.gh_token }}"
    #expect(c.arguments == ["connections", "set", "gh", "--env", "TOKEN={{ secret.gh_token }}", "--", "npx", "-y", "y"])
}

// MARK: - What it sends, and the guards, on a draft

/// The preview of a draft, as the editor draws it.
private func preview(_ d: ConnectionDraft, _ secrets: [SecretPolicy]) throws -> WhatItSends {
    let row = try #require(d.previewRow)
    return try #require(WhatItSends.of(row, secrets: secrets))
}

@Test func whatItSendsFromADraftBlocksASecretHeadedForAnUnlistedHostAndFlagsTheGuards() throws {
    let key = SecretPolicy(name: "linear_key", hosts: ["api.linear.app"], grants: ["connection:linear": "on"], expires: nil, present: true)
    var d = ConnectionDraft()
    d.name = "linear"
    d.choose(kind: .mcp)
    d.choose(service: nil)
    d.url = "https://mcp.linear.app/mcp"
    d.auth = .bearer
    d.secretName = "linear_key"
    let blocked = try preview(d, [key])
    #expect(blocked.blocked)
    #expect(blocked.sends.map(\.verdict) == [.hostNotListed(destination: "mcp.linear.app", listed: ["api.linear.app"])])
    #expect(blocked.sends.first?.hostToAllow == "mcp.linear.app")
    #expect(blocked.sends.first?.masked == "•••••• (linear_key)")
    d.url = "https://api.linear.app/graphql"
    #expect(try preview(d, [key]).sends.map(\.verdict) == [.sent(to: "api.linear.app")])
    #expect(d.guards.isEmpty)

    // a secret in a URL is flagged; plain http off this Mac too
    d.url = "https://api.linear.app/?key={{ secret.linear_key }}"
    #expect(d.guards.first?.hasPrefix("A secret in the URL is refused") == true)
    d.url = "http://api.linear.app/graphql"
    #expect(d.guards.contains { $0.hasPrefix("Plain http off this Mac") })
    #expect(try preview(d, [key]).blocked)

    // a command's environment: given to this command only — and a secret on the command line is flagged
    var c = ConnectionDraft()
    c.name = "gh"
    c.choose(kind: .mcp)
    c.choose(service: nil)
    c.reach = .command
    c.commandLine = "npx server"
    c.env = [ConnectionNameValue(name: "TOKEN", value: "{{ secret.gh }}")]
    let env = try preview(c, [SecretPolicy(name: "gh", hosts: [], grants: ["connection:gh": "on"], expires: nil, present: true)])
    #expect(env.sends.map(\.verdict) == [.givenToCommand] && !env.blocked)
    c.commandLine = "npx server --token {{ secret.gh }}"
    #expect(c.guards.first?.hasPrefix("A secret on the command line is refused") == true)

    // a mailbox: the app password to exactly host:port
    var m = ConnectionDraft()
    m.name = "mail"
    m.kind = .mail
    m.provider = "imap"
    m.reach = .imap
    m.imapHost = "imap.example.com"
    m.username = "me"
    m.secretName = "mail_pw"
    let listed = SecretPolicy(name: "mail_pw", hosts: ["imap.example.com:993"], grants: ["connection:mail": "on"], expires: nil, present: true)
    #expect(try preview(m, [listed]).sends.map(\.verdict) == [.sent(to: "imap.example.com:993")])
    #expect(try preview(m, [SecretPolicy(name: "mail_pw", hosts: ["imap.example.com"], grants: ["connection:mail": "on"], expires: nil, present: true)]).blocked, "the exact host:port, as the socket door spells it")
}

// MARK: - The recorded route: the seed's types, and a detail's unit

@MainActor
@Test func theRecordedListCarriesTheSeedsConnectionTypesWithTheirFields() async throws {
    let console = try FixtureConsole.recorded()
    let pane = ConnectionsModel(session: ConsoleSession(transport: console, management: SettingsRecordingRunner()))
    await pane.refresh()
    #expect(pane.phase == .read)
    #expect(pane.types.map(\.name) == ["caldav", "devin", "fastmail-calendar", "github", "github-issues", "gmail-mail", "google-calendar", "icloud-calendar", "ics", "imap", "linear"], "seed/connection-types, through the registry")
    #expect(pane.types.allSatisfy { $0.origin == "product" })
    let icloud = try #require(pane.type(named: "icloud-calendar"))
    #expect(icloud.provides == .calendar && icloud.transports == ["http"] && icloud.auth == ["basic"])
    let server = try #require(icloud.fields.first)
    #expect(server.key == "server" && server.kind == .url && !server.required && server.defaultValue == "https://caldav.icloud.com/")
    #expect(icloud.title == "iCloud Calendar over CalDAV with an app-specific password")
    #expect(pane.types(providing: .calendar).map(\.name) == ["caldav", "fastmail-calendar", "google-calendar", "icloud-calendar", "ics"].sorted { a, b in
        pane.type(named: a)!.title.localizedCaseInsensitiveCompare(pane.type(named: b)!.title) == .orderedAscending
    })
    #expect(pane.types(providing: .mail).map(\.name).sorted() == ["gmail-mail", "imap"])
    // Google Calendar (T4-14): OAuth only, its one field an oauth field — drawn as a note, signed in after adding
    let google = try #require(pane.type(named: "google-calendar"))
    #expect(google.auth == ["oauth"] && google.fields.map(\.kind) == [.oauth])
    pane.beginAdd()
    pane.draft?.name = "google"
    pane.draft?.choose(kind: .calendar)
    pane.draft?.choose(service: google)
    #expect(pane.draft?.auth == .oauth && pane.draft?.auths == [.oauth])
    pane.draft?.url = "https://www.googleapis.com/calendar/v3"
    #expect(pane.draft?.arguments == ["connections", "add", "google", "--type", "calendar", "--provider", "google-calendar", "--url", "https://www.googleapis.com/calendar/v3", "--auth", "oauth"])
    #expect(pane.types(providing: .tracker).map(\.name).sorted() == ["github", "linear"])
    // an agent connection type (T4-11): a dispatch target's fields, text the editor takes as it is
    #expect(pane.types(providing: .agent).map(\.name).sorted() == ["devin", "github-issues"])
    let devin = try #require(pane.type(named: "devin"))
    #expect(devin.auth == ["bearer"] && devin.fields.contains { $0.key == "org" && $0.kind == .text && $0.mustBeGiven })
    #expect(pane.variables == ["company", "team_name"], "the variables a variable field may name, from GET /api/variables")
    // an iCloud calendar draft, from the seed's type alone: Basic only, the server field with its default
    pane.beginAdd()
    pane.draft?.name = "icloud"
    pane.draft?.choose(kind: .calendar)
    pane.draft?.choose(service: icloud)
    #expect(pane.draft?.auth == .basic && pane.draft?.auths == [.basic])
    pane.draft?.url = "https://caldav.icloud.com/"
    pane.draft?.username = "you@icloud.com"
    pane.draft?.secretName = "icloud_app_password"
    #expect(pane.draft?.arguments == ["connections", "add", "icloud", "--type", "calendar", "--provider", "icloud-calendar", "--url", "https://caldav.icloud.com/", "--auth", "basic", "--username", "you@icloud.com", "--secret", "icloud_app_password"])

    // a detail's provider_unit carries the same unit
    let detail = try #require(ConnectionRow.parse(try JSONValue.parse(Data(#"{"name":"work","type":"mcp","provider":"acme-tracker","status":"ok","issues":[],"reach":{"class":"http","url":"https://mcp.acme.example/mcp","auth":"bearer","headers":[],"query":[],"timeout_s":null},"secrets":["acme_key"],"variables":[],"tools":[],"offer_to_agents":false,"used_by":[],"file":".metistry/connections/work.yaml","provider_unit":{"name":"acme-tracker","origin":"extension","provides":"mcp","capabilities":[],"implementation":"native","sync":null,"tools":[{"name":"list_issues","group":"reads"}],"type":\#(ACME_TYPE)}}"#.utf8))))
    #expect(detail.providerUnit?.type?.fields.count == 6)
    #expect(detail.providerUnit?.type?.isExtension == true)
    // and an imap row draws as a mailbox
    let mail = try #require(ConnectionRow.parse(try JSONValue.parse(Data(#"{"name":"gmail","type":"mail","provider":"gmail-mail","status":"ok","issues":[],"reach":{"class":"imap","host":"imap.gmail.com","port":993,"security":"tls","auth":"basic"},"secrets":["gmail_app_password"],"variables":[],"tools":[],"offer_to_agents":false,"used_by":[]}"#.utf8))))
    #expect(mail.reach == .imap(host: "imap.gmail.com", port: 993, security: "tls"))
    #expect(mail.typeLabel == "Mail · gmail-mail")
}

// MARK: - Signing in is `authorize`, confirmed; save runs what the editor showed

@MainActor
@Test func signInIsTheAuthorizeVerbConfirmedAndOnlyForOAuth() async throws {
    let (settings, runner, _) = try editorSettings(types: [ACME_TYPE], connections: [httpRow(url: "https://mcp.acme.example/mcp", auth: "oauth", headers: [])])
    let pane = settings.connectionsPane
    await pane.refresh()
    let row = try #require(pane.rows.first)
    let signIn = try #require(pane.signIn(row))
    #expect(signIn.command == ManagementCommand(.connections, ["connections", "authorize", "linear"]))
    #expect(signIn.said == "metistry connections authorize linear")
    #expect(signIn.actionTitle == "Sign In" && signIn.after == .connections)
    #expect(signIn.cost.contains("127.0.0.1") && signIn.cost.contains("one answer"))
    #expect(runner.commands.isEmpty, "nothing runs until confirmed")
    await settings.confirm(signIn)
    #expect(runner.commands == [signIn.command])
    // a bearer connection does not sign in
    let bearer = try #require(ConnectionRow.parse(try JSONValue.parse(Data(httpRow(url: "https://x.example/mcp", auth: "bearer", headers: []).utf8))))
    #expect(pane.signIn(bearer) == nil)
    // the detail offers it, spoken
    await pane.open("linear")
    let tree = try await AccessibilityProbe.snapshot(ConnectionDetailView(row: try #require(pane.shown), pane: pane, settings: settings).padding(MetistrySpace.s5).frame(width: SettingsLayout.pane))
    defer { tree.close() }
    #expect(tree.controlNames.contains("Sign in linear in the browser"), "\(tree.controlNames)")
    #expect(tree.controlNames.contains("Configure linear"))
}

@MainActor
@Test func saveRunsExactlyTheCommandTheEditorShowedAndARefusalKeepsTheDraft() async throws {
    // the console already lists `work` (as it will once the CLI has written it), so the re-read after success can open it
    let (settings, runner, console) = try editorSettings(types: [ACME_TYPE], connections: [httpRow(url: "https://mcp.acme.example/mcp", auth: "bearer", headers: []).replacingOccurrences(of: #""name":"linear""#, with: #""name":"work""#)])
    let pane = settings.connectionsPane
    await pane.refresh()
    pane.beginAdd()
    pane.draft?.name = "work"
    pane.draft?.choose(kind: .mcp)
    pane.draft?.choose(service: pane.types.first)
    await settings.saveConnectionDraft()
    #expect(runner.commands.isEmpty, "a draft that cannot run runs nothing")
    pane.draft?.url = "https://mcp.acme.example/mcp"
    pane.draft?.fields["workspace"] = "platform"
    let planned = try #require(pane.draft?.arguments)

    // the CLI refuses: the editor stays open with its words, nothing else changes
    runner.result = CommandResult(exitCode: 2, stdout: "", stderr: "error: metistry connections add: --config workspace: this looks like a key\n")
    await settings.saveConnectionDraft()
    #expect(runner.commands == [ManagementCommand(.connections, planned)])
    #expect(pane.draft?.refusal == "metistry connections add: --config workspace: this looks like a key")
    #expect(pane.draft?.fields["workspace"] == "platform", "the draft is kept")

    // it succeeds: the editor closes, the pane re-reads and opens the connection
    runner.result = CommandResult(exitCode: 0, stdout: "add work (mcp · acme-tracker): 1 tool\n", stderr: "")
    console.reset()
    await settings.saveConnectionDraft()
    #expect(runner.commands.count == 2 && runner.commands.last == ManagementCommand(.connections, planned))
    #expect(pane.draft == nil)
    #expect(pane.selected == "work")
    #expect(console.calls.map(\.path).contains("/api/connections"), "re-read: \(console.calls.map(\.path))")
    #expect(settings.outcome?.ok == true)
}

// MARK: - §2.18 on the editor

@MainActor
@Test func theEditorGrowsLongerNeverWiderAtTheLargestTextAndEveryControlSpeaks() async throws {
    let (settings, _, _) = try editorSettings(types: [ACME_TYPE])
    let pane = settings.connectionsPane
    await pane.refresh()
    pane.beginAdd()
    pane.draft?.name = "work"
    pane.draft?.choose(kind: .mcp)
    pane.draft?.choose(service: nil)
    pane.draft?.url = "https://mcp.example.com/mcp"
    pane.draft?.auth = .oauth
    pane.draft?.headers = [ConnectionNameValue(name: "Accept", value: "application/json")]
    let tree = try await AccessibilityProbe.snapshot(ConnectionEditorView(pane: pane, settings: settings).padding(MetistrySpace.s5).frame(width: SettingsLayout.pane))
    defer { tree.close() }
    #expect(tree.unlabeledBesidesFields.isEmpty, "\(tree.unlabeledBesidesFields)")
    #expect(tree.fieldsWithoutAPrompt.isEmpty, "\(tree.fieldPrompts)")
    for name in ["Back to all connections, discarding this draft", "New secret for Your client id", "Remove Accept", "Add Header", "Cancel", "Reach it once to list what it offers"] {
        #expect(tree.controlNames.contains(name), "\(name): \(tree.controlNames)")
    }
    for label in ["Name", "URL", "Authorize URL", "Token URL", "Scopes", "Your client id"] {
        #expect(tree.texts.contains(label), "\(label): \(tree.texts)")
    }
    #expect(tree.headings.contains("Headers") && tree.headings.contains("What It Sends"), "\(tree.headings)")
    #expect(tree.controlNames.contains("Insert a reference…"), "the reference picker speaks its line: \(tree.controlNames)")
    #expect(tree.controlNames.contains { $0.hasPrefix("Add Connection — runs the command above") })
    #expect(tree.texts.contains { $0.hasPrefix("Still needed:") })

    let width = SettingsLayout.pane
    var heights: [DynamicTypeSize: CGFloat] = [:]
    for size in [DynamicTypeSize.large, .accessibility5] {
        let renderer = ImageRenderer(content: ConnectionEditorView(pane: pane, settings: settings).padding(MetistrySpace.s5).frame(width: width).environment(\.dynamicTypeSize, size))
        renderer.proposedSize = ProposedViewSize(width: width, height: nil)
        renderer.scale = 1
        let image = try #require(renderer.cgImage)
        #expect(CGFloat(image.width) <= width, "\(image.width) wide at \(size)")
        heights[size] = CGFloat(image.height)
    }
    #expect((heights[.accessibility5] ?? 0) > (heights[.large] ?? 0), "\(heights)")
}

@Test func nothingInTheEditorMovesBindsAKeyNamesTheAssistantOrHoldsAValue() throws {
    let kit = repoRoot().appendingPathComponent("apps/macos/sources/kit")
    for file in ["connection-editor-view.swift", "connection-editor-model.swift"] {
        let text = try String(contentsOf: kit.appendingPathComponent(file), encoding: .utf8)
        #expect(!text.contains("withAnimation") && !text.contains(".animation(") && !text.contains(".transition("), "\(file)")
        #expect(!text.contains(".keyboardShortcut("), "\(file)")
        #expect(text.range(of: #"\bMetis\b"#, options: .regularExpression) == nil, "\(file)")
        #expect(!text.contains("SecureField"), "\(file): a secret's value is typed in the Secrets sheet and nowhere else")
    }
    // M13's verbs now include the sign-in door, and nothing else joined
    #expect(ManagementRow.connections.verbs == ["add", "set", "remove", "policy", "test", "authorize"].map { ["connections", $0] })
    #expect(ManagementCommand(.connections, ["connections", "authorize", "x"]) != nil)
    #expect(ManagementCommand(.connections, ["connections", "list"]) == nil, "a read is not a management verb")
    // the field kinds are core's closed vocabulary
    let core = try String(contentsOf: repoRoot().appendingPathComponent("packages/core/src/connections.ts"), encoding: .utf8)
    #expect(core.contains(#"FIELD_KINDS = ["text", "secret", "variable", "url", "choice", "oauth"]"#))
    #expect(ConnectionFieldKind.allCases.map(\.rawValue) == ["text", "secret", "variable", "url", "choice", "oauth"])
}

// MARK: - Helpers

private func repoRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent()
}

/// One HTTP MCP connection named linear, as `GET /api/connections` serves a row.
private func httpRow(url: String, auth: String, headers: [String]) -> String {
    let h = headers.map { "\"\($0)\"" }.joined(separator: ",")
    return #"{"name":"linear","type":"mcp","provider":"custom","description":null,"status":"ok","issues":[],"reach":{"class":"http","url":"\#(url)","auth":"\#(auth)","headers":[\#(h)],"query":[],"timeout_s":null},"secrets":["linear_key"],"variables":[],"tools":[{"name":"list_issues","group":"reads","mode":"on"}],"offer_to_agents":false,"used_by":[]}"#
}

private func contract(_ route: String, _ path: String, _ body: String) throws -> ConsoleFixture {
    let data = Data(body.utf8)
    return ConsoleFixture(
        stem: "t6-13b\(path.replacingOccurrences(of: "/", with: "-"))", route: route, source: "contract", ticket: "T6-13b",
        method: "GET", path: path, body: nil, idempotencyKey: nil, lastEventID: nil,
        status: 200, reply: data, replyJSON: try JSONValue.parse(data), stream: nil
    )
}

/// Settings over a console that lists these types, these connections, one secret and one variable.
@MainActor
private func editorSettings(types: [String], connections: [String] = []) throws -> (SettingsModel, SettingsRecordingRunner, FixtureConsole) {
    var fixtures = [
        try contract("GET /api/connections", "/api/connections", #"{"connections":[\#(connections.joined(separator: ","))],"types":[\#(types.joined(separator: ","))],"as_of":"2026-09-28T13:05:00.000Z"}"#),
        try contract("GET /api/secrets", "/api/secrets", #"{"secrets":[{"name":"acme_key","hosts":["mcp.acme.example"],"grants":[{"to":"connection:work","mode":"on"}],"expires":null,"present":true,"last_used":null},{"name":"linear_key","hosts":["api.linear.app"],"grants":[{"to":"connection:linear","mode":"on"}],"expires":null,"present":true,"last_used":null}],"as_of":"2026-09-28T13:05:00.000Z"}"#),
        try contract("GET /api/variables", "/api/variables", #"{"variables":[{"name":"team_name","value":"Platform","read_by":[],"used_in":[]}],"as_of":"2026-09-28T13:05:00.000Z"}"#),
    ]
    for connection in connections {
        let name = try #require(try JSONValue.parse(Data(connection.utf8)).string("name"))
        fixtures.append(try contract("GET /api/connections/:name", "/api/connections/\(name)", #"{"connection":\#(connection.dropLast()),"file":".metistry/connections/\#(name).yaml","provider_unit":null},"as_of":"2026-09-28T13:05:00.000Z"}"#))
    }
    let console = FixtureConsole(fixtures)
    let runner = SettingsRecordingRunner()
    let session = ConsoleSession(transport: console, management: runner)
    let settings = SettingsModel(status: StatusModel(cli: nil), cli: nil, instanceDir: nil, session: session, management: runner)
    return (settings, runner, console)
}
#endif

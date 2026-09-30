// Settings ▸ Connections — the list and one connection (T6-13a,
// screen-09-resources.md §10.1–§10.4). The model, and why every value on it is
// a served field and every change a confirmed §2.2 verb, is
// connections-model.swift.
//
// The list (§10.1): status · the name with its type's glyph · Type · Used By
// — *Key expired* first, in the failed ink, when a key it names has expired —
// and the shield when it is offered to agents. *Nobody yet* is a real value.
//
// One connection (§10.3): how Metistry reaches it, with each secret as a
// reference and where it may be sent; *What it sends*, where a secret headed
// for a host outside its *Sent only to* list blocks the preview; the offer
// switch; the tools by what they do, each Allow · Ask First · Never; used by;
// and Test, with Replace Key when a key is the problem (components-03 §2).
//
// Nothing here moves (§2.18.4), no key is bound outside the menu table
// (C119), and the pane grows longer, never wider, at the largest text: rows
// whose controls cannot sit side by side stack (`SettingsControls`).

import SwiftUI

struct ConnectionsPane: View {
    let model: AppModel

    private var settings: SettingsModel { model.settings }
    private var pane: ConnectionsModel { settings.connectionsPane }

    var body: some View {
        Group {
            if let row = pane.shown {
                ConnectionDetailView(row: row, pane: pane, settings: settings)
            } else {
                ConnectionsListView(pane: pane)
            }
        }
        .task(id: model.instances.active) { await pane.refresh() }
    }
}

// MARK: - The list

struct ConnectionsListView: View {
    @Environment(\.colorScheme) private var scheme
    let pane: ConnectionsModel
    var now = Date()

    var body: some View {
        let p = Palette(scheme)
        SettingsSection("Connections") {
            if case .unavailable(let why) = pane.phase, pane.rows.isEmpty {
                if pane.noInstance {
                    StatePanel(StatePanelModel(.absent, title: "Not Configured", sentence: "This deployment has no instance directory, so it holds no connections."))
                } else {
                    StatePanel(StatePanelModel(.failed, title: "Couldn't Read Connections", sentence: "The console did not answer with the list.", reason: why, action: StateWords.tryAgain)) {
                        Task { await pane.refresh() }
                    }
                }
            } else if pane.phase != .read, pane.rows.isEmpty {
                PlaceholderRows(count: 2, waitingFor: "Reading your connections")
            } else if pane.rows.isEmpty {
                StatePanel(StatePanelModel(.empty, title: "No Connections Yet", sentence: "Metistry can reach servers your agents cannot, and lend them. Add one with `metistry connections add` in Terminal."))
            } else {
                ForEach(pane.rows) { row in
                    ConnectionListRow(row: row, expired: pane.expiredKeys(row, now: now)) {
                        Task { await pane.open(row.name) }
                    }
                }
            }
            Text("Read from .metistry/connections/ — names, never a value. Adding one is `metistry connections add`; everything else is here, confirmed with its exact command.")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

struct ConnectionListRow: View {
    @Environment(\.colorScheme) private var scheme
    let row: ConnectionRow
    let expired: [String]
    let onOpen: () -> Void

    /// What the row says, in one breath — status, name, type, users, the shield.
    static func spoken(_ row: ConnectionRow, expired: [String]) -> String {
        var parts = [row.name, row.status.label, row.typeLabel]
        if !expired.isEmpty { parts.append("Key expired") }
        parts.append(usedBy(row))
        parts.append(row.offerToAgents ? "offered to agents" : "not offered to agents")
        return parts.joined(separator: ", ")
    }

    static func usedBy(_ row: ConnectionRow) -> String {
        row.usedBy.isEmpty ? "Nobody yet" : "Used by " + row.usedBy.map(\.said).joined(separator: " · ")
    }

    var body: some View {
        let p = Palette(scheme)
        Button(action: onOpen) {
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s3) {
                StatusDot(row.status)
                VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                    HStack(spacing: MetistrySpace.s2) {
                        Image(systemName: row.kind?.symbolName ?? "questionmark.square.dashed")
                            .foregroundStyle(p[.textSecondary])
                            .accessibilityHidden(true)
                        Text(row.name).metistryText(.body, p)
                    }
                    Text(row.typeLabel)
                        .metistryText(.footnote, p, .textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s1) {
                        if !expired.isEmpty {
                            Text("Key expired ·").metistryText(.footnote, p, .failed)
                        }
                        Text(Self.usedBy(row))
                            .metistryText(.footnote, p, row.usedBy.isEmpty ? .textTertiary : .textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: MetistrySpace.s2)
                if row.offerToAgents {
                    Image(systemName: "shield")
                        .foregroundStyle(p[.accent])
                        .accessibilityHidden(true)
                }
                Image(systemName: MetistryGlyph.disclosure.rawValue)
                    .foregroundStyle(p[.textTertiary])
                    .accessibilityHidden(true)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Self.spoken(row, expired: expired))
        .accessibilityHint("Opens \(row.name)")
        .accessibilityAddTraits(.isButton)
    }
}

// MARK: - One connection

struct ConnectionDetailView: View {
    @Environment(\.colorScheme) private var scheme
    let row: ConnectionRow
    let pane: ConnectionsModel
    let settings: SettingsModel
    var now = Date()

    private var busy: Bool { settings.management == nil || settings.running != nil }
    private var assistantName: String { settings.identity?.assistantName ?? "the assistant" }

    private func propose(_ confirmation: SettingsConfirmation?) {
        if let confirmation { settings.confirmation = confirmation }
    }

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s5) {
            Button {
                pane.close()
            } label: {
                Label("All Connections", systemImage: "chevron.left")
            }
            .buttonStyle(.plain)
            .foregroundStyle(p[.accent])
            .accessibilityLabel("Back to all connections")

            header(p)
            reach(p)
            sends(p)
            offer(p)
            tools(p)
            usedBy(p)
            check(p)
        }
    }

    // MARK: The connection

    @ViewBuilder
    private func header(_ p: Palette) -> some View {
        SettingsSection(row.name) {
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                StatusDot(row.status)
                Text(row.status.label).metistryText(.callout, p, row.status.colorRole)
                Text("·").metistryText(.callout, p, .textTertiary).accessibilityHidden(true)
                Text(row.typeLabel).metistryText(.callout, p, .textSecondary)
            }
            .accessibilityElement(children: .combine)
            if let description = row.description {
                Text(description)
                    .metistryText(.footnote, p, .textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(row.issues, id: \.self) { issue in
                Text(issue)
                    .metistryText(.footnote, p, row.status == .failed ? .failed : .absent)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if case .unavailable(let why) = pane.detailPhase {
                Text("Showing the list's row — the connection itself did not read: \(why)")
                    .metistryText(.caption1, p, .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: How Metistry reaches it

    @ViewBuilder
    private func reach(_ p: Palette) -> some View {
        SettingsSection("How Metistry Reaches It") {
            switch row.reach {
            case .http(let url, let auth, let headers, let query, let timeout):
                fact("URL", url, p)
                fact("Authentication", Self.authWords(auth), p)
                if !headers.isEmpty { fact("Headers", headers.joined(separator: ", "), p) }
                if !query.isEmpty { fact("Query parameters", query.joined(separator: ", "), p) }
                if let timeout { fact("Timeout", "\(timeout) s", p) }
            case .command(let command, let args, let cwd, let env, let runsOn):
                fact("Command", ([command] + args).joined(separator: " "), p)
                if let cwd { fact("Folder", cwd, p) }
                if !env.isEmpty { fact("Environment", env.joined(separator: ", "), p) }
                fact("Runs on", runsOn == "container" ? "A container" : "This Mac", p)
            case .path(let path, let include, let skip, let watch):
                fact("Path", path, p)
                if !include.isEmpty { fact("Include", include.joined(separator: ", "), p) }
                if !skip.isEmpty { fact("Skip", skip.joined(separator: ", "), p) }
                fact("Watch for changes", watch ? "On" : "Off", p)
            case nil:
                Text("How it is reached is not shown: the file did not validate, and a file that broke a rule shows nothing it holds.")
                    .metistryText(.footnote, p, .textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(row.secrets, id: \.self) { secret in
                secretRow(secret, p)
            }
            ForEach(row.variables, id: \.self) { variable in
                fact("Variable", "{{ variable.\(variable) }}", p)
            }
            if let file = row.file {
                Text(file)
                    .metistryText(.caption1, p, .textTertiary)
                    .textSelection(.enabled)
            }
        }
    }

    static func authWords(_ scheme: String?) -> String {
        switch scheme {
        case "none", nil: return "None"
        case "bearer": return "Bearer"
        case "basic": return "Basic"
        case "api_key": return "API Key"
        case "oauth": return "OAuth"
        default: return scheme ?? "None"
        }
    }

    /// A secret, as a reference, with where it may be sent — never a value.
    @ViewBuilder
    private func secretRow(_ secret: String, _ p: Palette) -> some View {
        let policy = pane.policy(for: secret)
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            fact("Secret", "{{ secret.\(secret) }}", p)
            Group {
                if let policy {
                    Text(policy.hosts.isEmpty ? "Sent only to: no host" : "Sent only to: \(policy.hosts.joined(separator: ", "))")
                        .metistryText(.caption1, p, .textSecondary)
                    if policy.isExpired(now: now) {
                        Text("Key expired").metistryText(.caption1, p, .failed)
                    } else if policy.present == false {
                        Text("No item in this instance's Keychain").metistryText(.caption1, p, .absent)
                    }
                } else if pane.secrets == nil {
                    Text("Where it may be sent is not known — the secret list did not read\(pane.secretsProblem.map { ": \($0)" } ?? "")")
                        .metistryText(.caption1, p, .textTertiary)
                } else {
                    Text("Not in secrets.yaml — it may be sent nowhere").metistryText(.caption1, p, .failed)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    private func fact(_ label: String, _ value: String, _ p: Palette) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s3) {
                Text(label).metistryText(.footnote, p, .textSecondary).frame(width: 150, alignment: .leading)
                Text(value).metistryText(.mono, p).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                Text(label).metistryText(.footnote, p, .textSecondary)
                Text(value).metistryText(.mono, p).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: What it sends

    @ViewBuilder
    private func sends(_ p: Palette) -> some View {
        if let preview = pane.whatItSends(row) {
            SettingsSection("What It Sends") {
                Text(preview.target)
                    .metistryText(.mono, p)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                if !preview.names.isEmpty {
                    Text("Names: \(preview.names.joined(separator: ", "))")
                        .metistryText(.caption1, p, .textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if preview.sends.isEmpty {
                    Text("No secret — nothing is filled in on the way out.")
                        .metistryText(.footnote, p, .textSecondary)
                }
                if preview.blocked {
                    HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                        Image(systemName: MetistryGlyph.lock.rawValue)
                            .foregroundStyle(p[.failed])
                            .accessibilityHidden(true)
                        Text("Blocked — Metistry would send nothing with a secret below until it is fixed.")
                            .metistryText(.callout, p, .failed)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .accessibilityElement(children: .combine)
                }
                ForEach(preview.sends) { send in
                    sendRow(send, p)
                }
                Text("Secrets are masked. The door fills a value just before it leaves, only for a host on its Sent only to list, and redacts it from whatever comes back.")
                    .metistryText(.caption1, p, .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private func sendRow(_ send: SecretSend, _ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                Image(systemName: send.blocks ? MetistryGlyph.lock.rawValue : MetistryGlyph.approve.rawValue)
                    .foregroundStyle(p[send.blocks ? .failed : .ok])
                    .accessibilityHidden(true)
                Text(send.masked).metistryText(.mono, p)
            }
            Text(send.said)
                .metistryText(.footnote, p, send.blocks ? .failed : .textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(send.secret), masked. \(send.said)")
        SettingsControls {
            if let host = send.hostToAllow {
                Button("Allow \(host)…") { propose(pane.allowHost(host, for: send.secret)) }
                    .disabled(busy || pane.policy(for: send.secret) == nil)
                    .accessibilityLabel("Allow \(send.secret) to be sent to \(host)")
            }
            if case .notGranted = send.verdict {
                Button("Grant…") { propose(pane.grant(send.secret, to: row)) }
                    .disabled(busy)
                    .accessibilityLabel("Grant \(send.secret) to \(row.name)")
            }
        }
    }

    // MARK: Offer to agents

    @ViewBuilder
    private func offer(_ p: Palette) -> some View {
        SettingsSection("Offer to Agents") {
            Toggle(isOn: Binding(get: { row.offerToAgents }, set: { on in propose(pane.setOffer(on, of: row, assistantName: assistantName)) })) {
                HStack(spacing: MetistrySpace.s2) {
                    Image(systemName: "shield").foregroundStyle(p[.accent]).accessibilityHidden(true)
                    Text("Offer to agents through Metistry").metistryText(.body, p)
                }
            }
            .disabled(busy)
            .accessibilityLabel("Offer \(row.name) to agents through Metistry")
            Text(row.offerToAgents
                 ? "On: agents you grant it to reach it through Metistry's proxy. They never reach the service or hold its key."
                 : "Off: \(assistantName) and syncs only.")
                .metistryText(.footnote, p, .textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: Tools — by what they do

    @ViewBuilder
    private func tools(_ p: Palette) -> some View {
        SettingsSection("Tools") {
            if row.tools.isEmpty {
                Text("No tools listed. The file is the allowlist: a tool it does not list is refused before anything is dialled.")
                    .metistryText(.footnote, p, .textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(Array(ConnectionToolGroup.allCases.map(Optional.some)) + [nil], id: \.self) { group in
                let listed = row.tools(in: group)
                if !listed.isEmpty {
                    Text(group?.title ?? "Other")
                        .metistryText(.subhead, p, .textSecondary)
                        .accessibilityAddTraits(.isHeader)
                    ForEach(listed) { tool in
                        toolRow(tool, p)
                    }
                }
            }
            if !row.declaredNotListed.isEmpty {
                Text("\(row.provider ?? "Its provider") also declares \(row.declaredNotListed.joined(separator: ", ")) — not listed, so refused until you list one.")
                    .metistryText(.caption1, p, .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text("\(PermissionWords.allow) runs it — a Read at once, anything else previewed first. \(PermissionWords.ask) waits for you in Needs You. \(PermissionWords.never) refuses it and does not offer it.")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private func toolRow(_ tool: ConnectionTool, _ p: Palette) -> some View {
        SettingsControls {
            Text(tool.name).metistryText(.mono, p)
            Spacer(minLength: MetistrySpace.s2)
            if let mode = tool.mode {
                // three buttons, not a segmented picker: each says the tool it
                // sets and whether it is the mode now (§2.18.3)
                HStack(spacing: MetistrySpace.s1) {
                    ForEach(ConnectionToolMode.allCases, id: \.self) { m in
                        ControlButton(ControlSpec(m.title, role: m == mode ? .primary : .secondary, selected: m == mode, name: "\(tool.name): \(m.title)")) {
                            propose(pane.setMode(tool, of: row, to: m))
                        }
                    }
                }
                .disabled(busy)
            } else {
                Text("a mode this build does not know").metistryText(.footnote, p, .absent)
            }
        }
    }

    // MARK: Used by

    @ViewBuilder
    private func usedBy(_ p: Palette) -> some View {
        SettingsSection("Used By") {
            if row.usedBy.isEmpty {
                Text("Nobody yet").metistryText(.body, p, .textTertiary)
            }
            ForEach(row.usedBy) { user in
                HStack(spacing: MetistrySpace.s2) {
                    Text(user.kind.capitalized).metistryText(.footnote, p, .textSecondary)
                    Text(user.name).metistryText(.mono, p)
                }
                .accessibilityElement(children: .combine)
            }
            Text("\(assistantName) reaches every connection. Agents reach one only when it is offered and granted to them.")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: Test, and Replace Key

    @ViewBuilder
    private func check(_ p: Palette) -> some View {
        SettingsSection("Check") {
            SettingsControls {
                Button("Test…") { propose(pane.test(row)) }
                    .disabled(busy)
                    .accessibilityLabel("Test \(row.name)")
                if pane.keyNeedsReplacing(row, now: now) {
                    Button("Replace Key…") { settings.section = .secrets }
                        .accessibilityLabel("Replace \(row.name)'s key in Secrets")
                }
            }
            Text("Test dials it once from this Mac, asks what it offers and calls no tool: `metistry connections test \(row.name)`. Its answer is the CLI's own words, at the top of this pane.")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

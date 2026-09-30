// Settings ▸ Connections ▸ Add Connection, and Configure one (T6-13b,
// screen-09-resources.md §10.5 C118, plan §2.6–§2.7). The draft and every
// rule about it are connection-editor-model.swift.
//
// Type first (§10.2's eight), then a known service — one of the connection
// types the console lists, its form RENDERED FROM ITS FIELDS: a text, a URL, a
// choice, a variable's name, a secret's name, an OAuth sign-in — or custom,
// configured by how it is reached: HTTP (URL · authentication · headers), a
// command (command · environment · runs on), a path (folder or file · include
// and skip), or a mailbox (server · username · app password by name).
//
// NO FIELD HERE TAKES A VALUE A SECRET COULD BE. A secret is picked by name
// from the list `GET /api/secrets` serves, or stored first through the Secrets
// sheet (the one place a value is typed, onto the CLI's stdin). *What it
// sends* is the same drawing the detail makes (`WhatItSends.of`): a secret
// headed for a host outside its *Sent only to* list shows blocked on its row
// with *Allow <host>…*; a secret in a URL or on a command line is flagged; a
// secret in a command's environment is *given to this command only*.
//
// THE BUTTON RUNS ONE VERB, SHOWN FIRST: `metistry connections add …` or
// `connections set …` (M13), the whole argument array in the card above it —
// a secret field as `--config KEY=<name>`, a name the CLI turns into a
// reference and refuses anything else. `add` dials once (the card says so).
// Signing an OAuth connection in is a second confirmed verb, `connections
// authorize`, offered on the connection once it is written.
//
// Nothing moves (§2.18.4), no key is bound outside the menu table (C119), and
// the pane grows longer, never wider, at the largest text (`SettingsControls`).

import SwiftUI

struct ConnectionEditorView: View {
    @Environment(\.colorScheme) private var scheme
    let pane: ConnectionsModel
    let settings: SettingsModel

    private var draft: ConnectionDraft { pane.draft ?? ConnectionDraft() }
    private var busy: Bool { settings.management == nil || settings.running != nil }
    private var assistantName: String { settings.identity?.assistantName ?? "the assistant" }

    private func edit(_ change: (inout ConnectionDraft) -> Void) {
        guard var d = pane.draft else { return }
        change(&d)
        d.refusal = nil
        pane.draft = d
    }

    private func text(_ key: WritableKeyPath<ConnectionDraft, String>) -> Binding<String> {
        Binding(get: { pane.draft?[keyPath: key] ?? "" }, set: { v in edit { $0[keyPath: key] = v } })
    }

    private func field(_ key: String) -> Binding<String> {
        Binding(get: { pane.draft?.fields[key] ?? "" }, set: { v in edit { $0.fields[key] = v } })
    }

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s5) {
            Button {
                pane.cancelEditing()
            } label: {
                Label(draft.isAdd ? "All Connections" : draft.name, systemImage: "chevron.left")
            }
            .buttonStyle(.plain)
            .foregroundStyle(p[.accent])
            .accessibilityLabel(draft.isAdd ? "Back to all connections, discarding this draft" : "Back to \(draft.name), discarding these changes")

            connection(p)
            if draft.kind != nil, draft.isAdd { service(p) }
            if draft.provider != nil {
                reach(p)
                if !draft.typeFields.isEmpty { fields(p) }
                sends(p)
            }
            command(p)
        }
    }

    // MARK: The connection: name and type

    @ViewBuilder
    private func connection(_ p: Palette) -> some View {
        SettingsSection(draft.isAdd ? "Add Connection" : "Configure \(draft.name)") {
            if draft.isAdd {
                labeled("Name", p) {
                    TextField("Name", text: text(\.name), prompt: Text(verbatim: "lowercase, like work-calendar"))
                        .textFieldStyle(.roundedBorder)
                        .accessibilityLabel("Name")
                }
                Text("Type").metistryText(.subhead, p, .textSecondary).accessibilityAddTraits(.isHeader)
                // eight tiles, not a menu: each says what it is (§10.2), and the chosen one is selected
                ForEach(ConnectionKind.allCases, id: \.self) { kind in
                    typeTile(kind, p)
                }
            } else if let row = draft.configuring {
                HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                    StatusDot(row.status)
                    Text(row.typeLabel).metistryText(.callout, p, .textSecondary)
                }
                .accessibilityElement(children: .combine)
                Text("How it is reached and its settings can change here; its tools and the offer switch are on the connection itself. Removing it, or changing what kind of thing it is, is `metistry connections remove` and a new one.")
                    .metistryText(.caption1, p, .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            labeled("Description", p) {
                TextField("Description", text: text(\.description), prompt: Text(verbatim: "optional — what it is, in a line"))
                    .textFieldStyle(.roundedBorder)
                    .accessibilityLabel("Description")
            }
        }
    }

    @ViewBuilder
    private func typeTile(_ kind: ConnectionKind, _ p: Palette) -> some View {
        let chosen = draft.kind == kind
        Button {
            edit { $0.choose(kind: kind) }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s3) {
                Image(systemName: chosen ? MetistryGlyph.radioOn.rawValue : MetistryGlyph.radio.rawValue)
                    .foregroundStyle(p[chosen ? .accent : .textTertiary])
                    .accessibilityHidden(true)
                Image(systemName: kind.symbolName).foregroundStyle(p[.textSecondary]).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                    Text(kind.title).metistryText(.body, p)
                    Text(kind.explained).metistryText(.footnote, p, .textSecondary).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(kind.title): \(kind.explained)")
        .accessibilityAddTraits(chosen ? [.isButton, .isSelected] : .isButton)
    }

    // MARK: The service: known, or custom

    @ViewBuilder
    private func service(_ p: Palette) -> some View {
        let kind = draft.kind ?? .mcp
        let known = pane.types(providing: kind)
        SettingsSection("Service") {
            if known.isEmpty, kind.customReaches.isEmpty {
                Text("No connection type installed provides a \(kind.title.lowercased()), and a custom one has nothing to run it. `metistry extensions add <dir>` installs one.")
                    .metistryText(.footnote, p, .absent)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(known) { type in
                serviceTile(type, p)
            }
            if !kind.customReaches.isEmpty {
                customTile(kind, p)
            }
            Text("A known service brings its own fields — from its connection type's manifest, the product's or an extension's. Custom is configured by how it is reached.")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private func serviceTile(_ type: ConnectionTypeSummary, _ p: Palette) -> some View {
        let chosen = draft.provider == type.name
        Button {
            edit { $0.choose(service: type) }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s3) {
                Image(systemName: chosen ? MetistryGlyph.radioOn.rawValue : MetistryGlyph.radio.rawValue)
                    .foregroundStyle(p[chosen ? .accent : .textTertiary])
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                    HStack(spacing: MetistrySpace.s2) {
                        Text(type.title).metistryText(.body, p)
                        Text(type.originTag).metistryText(.caption2, p, type.isExtension ? .accent : .textTertiary)
                    }
                    if let description = type.description {
                        Text(description).metistryText(.footnote, p, .textSecondary).fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(type.title), \(type.originTag.lowercased())\(type.description.map { ": \($0)" } ?? "")")
        .accessibilityAddTraits(chosen ? [.isButton, .isSelected] : .isButton)
    }

    @ViewBuilder
    private func customTile(_ kind: ConnectionKind, _ p: Palette) -> some View {
        let chosen = draft.isCustom
        let how = kind.customReaches.map { "By \($0 == .http ? "URL" : $0 == .command ? "command" : "path")" }.joined(separator: " · ")
        Button {
            edit { $0.choose(service: nil) }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s3) {
                Image(systemName: chosen ? MetistryGlyph.radioOn.rawValue : MetistryGlyph.radio.rawValue)
                    .foregroundStyle(p[chosen ? .accent : .textTertiary])
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                    Text("Custom").metistryText(.body, p)
                    Text(how).metistryText(.footnote, p, .textSecondary)
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Custom: \(how)")
        .accessibilityAddTraits(chosen ? [.isButton, .isSelected] : .isButton)
    }

    // MARK: How Metistry reaches it

    @ViewBuilder
    private func reach(_ p: Palette) -> some View {
        let reaches = draft.reaches
        SettingsSection("How Metistry Reaches It") {
            if reaches.count > 1, draft.isAdd {
                Picker("Reached by", selection: Binding(get: { draft.reach }, set: { r in edit { $0.reach = r } })) {
                    ForEach(reaches, id: \.self) { r in
                        Text("\(r.title) — \(r.usedFor)").tag(r)
                    }
                }
                .pickerStyle(.menu)
                .disabled(busy)
                .accessibilityLabel("Reached by")
            }
            switch draft.reach {
            case .http: http(p)
            case .command: command(reach: p)
            case .path: path(p)
            case .imap: imap(p)
            }
            ForEach(draft.guards, id: \.self) { warning in
                HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                    Image(systemName: MetistryGlyph.lock.rawValue).foregroundStyle(p[.failed]).accessibilityHidden(true)
                    Text(warning).metistryText(.footnote, p, .failed).fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    @ViewBuilder
    private func http(_ p: Palette) -> some View {
        labeled("URL", p) {
            TextField("URL", text: text(\.url), prompt: Text(verbatim: "https://… — or a {{ variable.name }} that holds one"))
                .textFieldStyle(.roundedBorder)
                .accessibilityLabel("URL")
        }
        let auths = draft.auths
        if auths.count > 1 {
            Picker("Authentication", selection: Binding(get: { draft.auth }, set: { a in edit { $0.auth = a } })) {
                ForEach(auths, id: \.self) { a in Text(a.title).tag(a) }
            }
            .pickerStyle(.menu)
            .disabled(busy)
            .accessibilityLabel("Authentication")
        } else if let only = auths.first {
            fact("Authentication", only.title, p)
        }
        if draft.auth.takesSecret {
            secretPicker(draft.auth == .basic ? "App password" : draft.auth == .bearer ? "Token" : "Key", text(\.secretName), p)
        }
        if draft.auth == .apiKey {
            labeled("Header", p) {
                TextField("Header", text: text(\.authHeader), prompt: Text(verbatim: "the header the key is sent in, e.g. X-API-Key"))
                    .textFieldStyle(.roundedBorder)
                    .accessibilityLabel("Header the key is sent in")
            }
        }
        if draft.auth == .basic {
            labeled("Username", p) {
                TextField("Username", text: text(\.username), prompt: Text(verbatim: "you@example.com"))
                    .textFieldStyle(.roundedBorder)
                    .accessibilityLabel("Username")
            }
            Text("The username is written to the file; the app password is a secret, filled in at the door for its listed host only.")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        if draft.auth == .oauth { oauth(p) }
        rows("Headers", \.headers, addTitle: "Add Header", namePrompt: "Header", p)
    }

    @ViewBuilder
    private func oauth(_ p: Palette) -> some View {
        if draft.isCustom {
            labeled("Authorize URL", p) {
                TextField("Authorize URL", text: text(\.authorizeURL), prompt: Text(verbatim: "https://…/authorize")).textFieldStyle(.roundedBorder).accessibilityLabel("Authorize URL")
            }
            labeled("Token URL", p) {
                TextField("Token URL", text: text(\.tokenURL), prompt: Text(verbatim: "https://…/token")).textFieldStyle(.roundedBorder).accessibilityLabel("Token URL")
            }
            labeled("Scopes", p) {
                TextField("Scopes", text: text(\.scopes), prompt: Text(verbatim: "space-separated, e.g. read offline_access")).textFieldStyle(.roundedBorder).accessibilityLabel("Scopes")
            }
            secretPicker("Your client id", text(\.clientIdSecret), p)
            secretPicker("Your client secret (if the provider needs one)", text(\.clientSecretSecret), p, optional: true)
            Text("A custom connection brings its own OAuth client — no connection type supplies one (C118). PKCE, and the answer comes back to this Mac on 127.0.0.1.")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            secretPicker("Your own client id (optional)", text(\.clientIdSecret), p, optional: true)
            Text("Signs in with \(draft.type?.title ?? "the service")'s shipped client unless you bring your own. Until the provider has verified Metistry, its consent page may warn that the app is unverified; a client id of your own avoids that.")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        Text("Nothing signs in here: once the connection is written, Sign In on it opens the browser (`metistry connections authorize`) and keeps the sign-in in this instance's Keychain.")
            .metistryText(.caption1, p, .textTertiary)
            .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private func command(reach p: Palette) -> some View {
        labeled("Command", p) {
            TextField("Command", text: text(\.commandLine), prompt: Text(verbatim: "npx -y @modelcontextprotocol/server-github"))
                .textFieldStyle(.roundedBorder)
                .accessibilityLabel("Command and arguments")
        }
        rows("Environment", \.env, addTitle: "Add Variable", namePrompt: "NAME", p)
        Text("A secret in the environment is given to this command only; never written to disk. The command is started with only the environment named here.")
            .metistryText(.caption1, p, .textTertiary)
            .fixedSize(horizontal: false, vertical: true)
        Toggle(isOn: Binding(get: { draft.runsInContainer }, set: { on in edit { $0.runsInContainer = on } })) {
            Text("Runs in a container").metistryText(.body, p)
        }
        .disabled(busy)
        .accessibilityLabel("Runs in a container, not on this Mac")
    }

    @ViewBuilder
    private func path(_ p: Palette) -> some View {
        labeled("Folder or file", p) {
            TextField("Folder or file", text: text(\.path), prompt: Text(verbatim: "~/Documents/Notes"))
                .textFieldStyle(.roundedBorder)
                .accessibilityLabel("Folder or file")
        }
        labeled("Include", p) {
            TextField("Include", text: text(\.include), prompt: Text(verbatim: "patterns, e.g. *.md"))
                .textFieldStyle(.roundedBorder)
                .accessibilityLabel("Include patterns")
        }
        labeled("Skip", p) {
            TextField("Skip", text: text(\.skip), prompt: Text(verbatim: "patterns, e.g. drafts/**"))
                .textFieldStyle(.roundedBorder)
                .accessibilityLabel("Skip patterns")
        }
    }

    @ViewBuilder
    private func imap(_ p: Palette) -> some View {
        labeled("Mail server", p) {
            TextField("Mail server", text: text(\.imapHost), prompt: Text(verbatim: "imap.example.com"))
                .textFieldStyle(.roundedBorder)
                .accessibilityLabel("Mail server")
        }
        labeled("Port", p) {
            TextField("Port", text: text(\.imapPort), prompt: Text(verbatim: "993"))
                .textFieldStyle(.roundedBorder)
                .accessibilityLabel("Port, 993 unless given")
        }
        labeled("Username", p) {
            TextField("Username", text: text(\.username), prompt: Text(verbatim: "you@example.com"))
                .textFieldStyle(.roundedBorder)
                .accessibilityLabel("Username")
        }
        secretPicker("App password", text(\.secretName), p)
        Toggle(isOn: Binding(get: { draft.imapPlain }, set: { on in edit { $0.imapPlain = on } })) {
            Text("Without TLS — a server on this Mac only").metistryText(.body, p)
        }
        .disabled(busy)
        .accessibilityLabel("Without TLS — a server on this Mac only")
        Text("Nothing sends mail: an IMAP connection reads headers and appends drafts you send yourself. The app password goes to exactly this server and port, over TLS.")
            .metistryText(.caption1, p, .textTertiary)
            .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: A known service's fields, rendered from their kinds

    @ViewBuilder
    private func fields(_ p: Palette) -> some View {
        SettingsSection("Settings") {
            ForEach(draft.typeFields) { field in
                fieldRow(field, p)
            }
            if let type = draft.type {
                Text("\(type.title)'s fields, from its manifest\(type.isExtension ? " (an extension of yours)" : ""). \(draft.isAdd ? "" : "A field left empty keeps what the file holds.")")
                    .metistryText(.caption1, p, .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private func fieldRow(_ field: ConnectionTypeField, _ p: Palette) -> some View {
        let label = field.required && field.defaultValue == nil && field.kind != .oauth ? field.label : "\(field.label) (optional)"
        switch field.kind {
        case .text, .url:
            labeled(label, p) {
                TextField(field.label, text: self.field(field.key), prompt: Text(verbatim: field.defaultValue ?? field.help ?? (field.kind == .url ? "https://…" : field.label)))
                    .textFieldStyle(.roundedBorder)
                    .accessibilityLabel(field.label)
            }
        case .choice:
            Picker(label, selection: self.field(field.key)) {
                Text(field.defaultValue.map { d in "Default (\(field.choices.first { $0.value == d }?.label ?? d))" } ?? "Choose…").tag("")
                ForEach(field.choices) { choice in Text(choice.label).tag(choice.value) }
            }
            .pickerStyle(.menu)
            .disabled(busy)
            .accessibilityLabel(field.label)
        case .secret:
            secretPicker(label, self.field(field.key), p, optional: !field.mustBeGiven)
        case .variable:
            variablePicker(label, self.field(field.key), p)
        case .oauth:
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                Image(systemName: "person.badge.key").foregroundStyle(p[.textSecondary]).accessibilityHidden(true)
                Text("\(field.label): signed in after adding — choose OAuth above, then Sign In on the connection.")
                    .metistryText(.footnote, p, .textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)
        }
        if let help = field.help, field.kind != .oauth {
            Text(help).metistryText(.caption1, p, .textTertiary).fixedSize(horizontal: false, vertical: true)
        }
    }

    /// A secret by NAME — the list `GET /api/secrets` serves, or a new one through the Secrets sheet. Never a text field.
    @ViewBuilder
    private func secretPicker(_ label: String, _ selection: Binding<String>, _ p: Palette, optional: Bool = false) -> some View {
        let names = (pane.secrets ?? []).map(\.name).sorted()
        SettingsControls {
            Picker(label, selection: selection) {
                Text(optional ? "None" : "Choose a secret…").tag("")
                ForEach(names, id: \.self) { name in Text(name).tag(name) }
                if !selection.wrappedValue.isEmpty, !names.contains(selection.wrappedValue) {
                    Text("\(selection.wrappedValue) (not in secrets.yaml)").tag(selection.wrappedValue)
                }
            }
            .pickerStyle(.menu)
            .disabled(busy)
            .accessibilityLabel(label)
            Button("New Secret…") { settings.beginNewSecret() }
                .disabled(busy)
                .accessibilityLabel("New secret for \(label)")
        }
        if pane.secrets == nil {
            Text("The secret list did not read, so no name can be picked here\(pane.secretsProblem.map { ": \($0)" } ?? "").")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// A variable by name — the list `GET /api/variables` serves.
    @ViewBuilder
    private func variablePicker(_ label: String, _ selection: Binding<String>, _ p: Palette) -> some View {
        let names = (pane.variables ?? []).sorted()
        Picker(label, selection: selection) {
            Text("None").tag("")
            ForEach(names, id: \.self) { name in Text(name).tag(name) }
            if !selection.wrappedValue.isEmpty, !names.contains(selection.wrappedValue) {
                Text("\(selection.wrappedValue) (not set)").tag(selection.wrappedValue)
            }
        }
        .pickerStyle(.menu)
        .disabled(busy)
        .accessibilityLabel(label)
        if names.isEmpty {
            Text("No variables yet — Settings ▸ Variables sets one.").metistryText(.caption1, p, .textTertiary)
        }
    }

    // MARK: Name/value rows — headers, environment

    @ViewBuilder
    private func rows(_ title: String, _ key: WritableKeyPath<ConnectionDraft, [ConnectionNameValue]>, addTitle: String, namePrompt: String, _ p: Palette) -> some View {
        let list = draft[keyPath: key]
        Text(title).metistryText(.subhead, p, .textSecondary).accessibilityAddTraits(.isHeader)
        ForEach(list) { row in
            nameValueRow(row, key, namePrompt: namePrompt, p)
        }
        SettingsControls {
            Button(addTitle) { edit { $0[keyPath: key].append(ConnectionNameValue()) } }
                .disabled(busy)
                .accessibilityLabel(addTitle)
            // a picker, not a menu: the popup speaks its own line, and a pick appends one row holding the reference
            Picker("Insert a reference", selection: Binding(get: { "" }, set: { ref in
                if !ref.isEmpty { edit { d in d[keyPath: key].append(ConnectionNameValue(name: "", value: ref)) } }
            })) {
                Text("Insert a reference…").tag("")
                ForEach((pane.secrets ?? []).map(\.name).sorted(), id: \.self) { name in Text("{{ secret.\(name) }}").tag("{{ secret.\(name) }}") }
                ForEach((pane.variables ?? []).sorted(), id: \.self) { name in Text("{{ variable.\(name) }}").tag("{{ variable.\(name) }}") }
            }
            .pickerStyle(.menu)
            .labelsHidden()
            .disabled(busy)
            .accessibilityLabel("Insert a secret or variable reference as a new \(title.lowercased()) row")
        }
        Text("Names are plain text; a value may be text, {{ secret.name }} or {{ variable.name }} — a value that looks like a key is refused.")
            .metistryText(.caption1, p, .textTertiary)
            .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private func nameValueRow(_ row: ConnectionNameValue, _ key: WritableKeyPath<ConnectionDraft, [ConnectionNameValue]>, namePrompt: String, _ p: Palette) -> some View {
        SettingsControls {
            TextField(namePrompt, text: Binding(get: { pane.draft?[keyPath: key].first { $0.id == row.id }?.name ?? "" }, set: { v in edit { d in if let i = d[keyPath: key].firstIndex(where: { $0.id == row.id }) { d[keyPath: key][i].name = v } } }), prompt: Text(verbatim: namePrompt))
                .textFieldStyle(.roundedBorder)
                .accessibilityLabel("\(namePrompt) name")
            TextField("Value", text: Binding(get: { pane.draft?[keyPath: key].first { $0.id == row.id }?.value ?? "" }, set: { v in edit { d in if let i = d[keyPath: key].firstIndex(where: { $0.id == row.id }) { d[keyPath: key][i].value = v } } }), prompt: Text(verbatim: "value, or {{ secret.name }}"))
                .textFieldStyle(.roundedBorder)
                .accessibilityLabel("\(row.name.isEmpty ? namePrompt : row.name) value")
            Button {
                edit { d in d[keyPath: key].removeAll { $0.id == row.id } }
            } label: {
                Image(systemName: "xmark").accessibilityHidden(true)
            }
            .buttonStyle(.plain)
            .disabled(busy)
            .accessibilityLabel("Remove \(row.name.isEmpty ? "this row" : row.name)")
        }
    }

    // MARK: What it sends

    @ViewBuilder
    private func sends(_ p: Palette) -> some View {
        if let preview = pane.whatItSends(draft) {
            SettingsSection("What It Sends") {
                Text(preview.target).metistryText(.mono, p).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                if !preview.names.isEmpty {
                    Text("Names: \(preview.names.joined(separator: ", "))").metistryText(.caption1, p, .textTertiary).fixedSize(horizontal: false, vertical: true)
                }
                if preview.sends.isEmpty {
                    Text("No secret — nothing is filled in on the way out.").metistryText(.footnote, p, .textSecondary)
                }
                if preview.blocked {
                    HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                        Image(systemName: MetistryGlyph.lock.rawValue).foregroundStyle(p[.failed]).accessibilityHidden(true)
                        Text("Blocked — Metistry would send nothing with a secret below until it is fixed. It can still be added; the row on the connection says what to fix.")
                            .metistryText(.callout, p, .failed)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .accessibilityElement(children: .combine)
                }
                ForEach(preview.sends) { send in
                    VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                        HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                            Image(systemName: send.blocks ? MetistryGlyph.lock.rawValue : MetistryGlyph.approve.rawValue)
                                .foregroundStyle(p[send.blocks ? .failed : .ok])
                                .accessibilityHidden(true)
                            Text(send.masked).metistryText(.mono, p)
                        }
                        Text(send.said).metistryText(.footnote, p, send.blocks ? .failed : .textSecondary).fixedSize(horizontal: false, vertical: true)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("\(send.secret), masked. \(send.said)")
                    if let host = send.hostToAllow {
                        Button("Allow \(host)…") { if let c = pane.allowHost(host, for: send.secret) { settings.confirmation = c } }
                            .disabled(busy || pane.policy(for: send.secret) == nil)
                            .accessibilityLabel("Allow \(send.secret) to be sent to \(host)")
                    }
                }
                Text("Secrets are masked. The door fills a value just before it leaves, only for a host on its Sent only to list, and redacts it from whatever comes back.")
                    .metistryText(.caption1, p, .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: The verb, shown first

    @ViewBuilder
    private func command(_ p: Palette) -> some View {
        SettingsSection(draft.isAdd ? "Add" : "Save") {
            CommandCard(argument: draft.arguments.map { ["metistry"] + $0 }, placeholder: draft.missing.first.map { "needs \($0)" } ?? "nothing to change")
            if draft.isAdd {
                Toggle(isOn: Binding(get: { draft.discover }, set: { on in edit { $0.discover = on } })) {
                    Text("Reach it once to list what it offers").metistryText(.body, p)
                }
                .disabled(busy || draft.reach == .imap || draft.auth == .oauth)
                .accessibilityLabel("Reach it once to list what it offers")
                Text(draft.reach == .imap
                     ? "A mailbox is not dialled on add — Test signs in."
                     : draft.auth == .oauth
                     ? "An OAuth connection is written first and signed in from the connection — nothing is dialled on add."
                     : "On: `add` starts the command or reaches the URL once — initialize and tools/list, no tool called — and writes nothing if it does not answer. Off: written as it is (`--no-discover`), with the tools its type declares.")
                    .metistryText(.caption1, p, .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !draft.missing.isEmpty {
                Text("Still needed: \(draft.missing.joined(separator: "; ")).").metistryText(.footnote, p, .textSecondary).fixedSize(horizontal: false, vertical: true)
            }
            if let refusal = draft.refusal {
                UnavailableCard(what: draft.isAdd ? "Not added" : "Not changed", reason: refusal)
            }
            SettingsControls {
                Button("Cancel") { pane.cancelEditing() }
                    .disabled(busy)
                Button(draft.isAdd ? "Add Connection" : "Save Changes") { Task { await settings.saveConnectionDraft() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy || !draft.canRun)
                    .accessibilityLabel(draft.isAdd ? "Add Connection — runs the command above" : "Save Changes — runs the command above")
            }
            Text("Written to .metistry/connections/\(draft.trimmedName.isEmpty ? "<name>" : draft.trimmedName).yaml, a protected file, as you. Secrets and variables are names in it, never values; the CLI judges the file exactly as the reader will before anything is written.")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: Small pieces

    private func labeled<Content: View>(_ label: String, _ p: Palette, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            Text(label).metistryText(.footnote, p, .textSecondary)
            content()
        }
    }

    private func fact(_ label: String, _ value: String, _ p: Palette) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s3) {
            Text(label).metistryText(.footnote, p, .textSecondary)
            Text(value).metistryText(.body, p)
        }
        .accessibilityElement(children: .combine)
    }
}

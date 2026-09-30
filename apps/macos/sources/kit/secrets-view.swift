// Settings ▸ Secrets (T6-14, screen-19 §1): the list — name · Used by and
// Sent only to · last used or *Expired* — each secret's Value, Sent Only To
// and Who May Use It, and *Metistry's own* as a collapsed group.
//
// Nothing on this pane can show a value: the rows it draws have no field for
// one (secrets-model.swift), the Value section is dots, and the one field a
// value is typed into is a `SecureField` in the New Secret / Replace sheet,
// cleared before the command it feeds runs. Every write shows its exact
// command first — the sheet's, or the window's confirmation.

import SwiftUI

public struct SecretsPaneView: View {
    @Environment(\.colorScheme) private var scheme
    let model: AppModel
    let now: () -> Date

    public init(model: AppModel, now: @escaping () -> Date = Date.init) {
        self.model = model
        self.now = now
    }

    private var settings: SettingsModel { model.settings }
    private var pane: SecretsModel { settings.secretsPane }

    public var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s5) {
            SettingsSection("Secrets") {
                SettingsControls {
                    Button("New Secret…") { settings.beginNewSecret() }
                    if pane.phase == .reading {
                        ProgressView().controlSize(.small).accessibilityLabel("Reading the secrets")
                    }
                    Text(pane.rows.count == 1 ? "1 secret" : "\(pane.rows.count) secrets")
                        .metistryText(.caption1, p, .textTertiary)
                        .monospacedDigit()
                }
                if case .unavailable(let why) = pane.phase {
                    UnavailableCard(what: "Could not read the secrets", reason: why, command: "GET /api/secrets — on this Mac, `metistry secrets list --named` says the same")
                } else if pane.rows.isEmpty {
                    Text(pane.phase == .read
                        ? "No secrets yet. New Secret stores one in this Mac's Keychain, for this instance only."
                        : "Reading this instance's secrets…")
                        .metistryText(.callout, p, .textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                ForEach(pane.rows) { secret in
                    SecretRowView(secret: secret, settings: settings, now: now())
                }
                Text(SecretsModel.usedNeverRead)
                    .metistryText(.caption1, p, .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            MetistrysOwnSection(settings: settings)
        }
        .task(id: model.instances.active) {
            await settings.refreshSecretsPane()
            await settings.refreshSecrets()
        }
        .accessEditorSheet(settings)
    }
}

/// One secret: its line in the list, and — opened — its three sections.
struct SecretRowView: View {
    @Environment(\.colorScheme) private var scheme
    let secret: NamedSecret
    let settings: SettingsModel
    let now: Date

    private var pane: SecretsModel { settings.secretsPane }

    var body: some View {
        let p = Palette(scheme)
        let expired = secret.isExpired(now: now)
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            HStack(alignment: .top, spacing: MetistrySpace.s3) {
                Image(systemName: secret.present == false ? "key.slash" : "key.fill")
                    .foregroundStyle(p[secret.present == false ? .absent : .ok])
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                    Text(secret.name).metistryText(.mono, p)
                    Text("Used by: \(secret.usedByLine)")
                        .metistryText(.caption1, p, .textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("Sent only to: \(secret.sentOnlyToLine)")
                        .metistryText(.caption1, p, .textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: MetistrySpace.s2)
                Text(secret.lastUsedLine(now: now))
                    .metistryText(.caption1, p, expired ? .failed : .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)

            DisclosureGroup(isExpanded: Binding(
                get: { pane.expanded.contains(secret.name) },
                set: { open in if open { pane.expanded.insert(secret.name) } else { pane.expanded.remove(secret.name) } }
            )) {
                SecretDetailView(secret: secret, settings: settings, now: now)
                    .padding(.top, MetistrySpace.s2)
            } label: {
                Text("Details")
                    .metistryText(.footnote, p, .textSecondary)
                    .accessibilityLabel("Details for \(secret.name)")
            }
        }
        .padding(.vertical, MetistrySpace.s1)
    }
}

/// Value · Sent Only To · Who May Use It (screen-19 §1.1), then Delete.
struct SecretDetailView: View {
    @Environment(\.colorScheme) private var scheme
    let secret: NamedSecret
    let settings: SettingsModel
    let now: Date

    private var pane: SecretsModel { settings.secretsPane }

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s4) {
            // Value: dots — there is nothing else this view could draw
            VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                Text("Value").metistryText(.subhead, p).accessibilityAddTraits(.isHeader)
                SettingsControls {
                    Text("••••••••••••")
                        .metistryText(.mono, p, .textTertiary)
                        .accessibilityLabel("Value hidden — never shown again after it is stored")
                    Button("Replace…") { settings.beginReplace(secret.name) }
                        .accessibilityLabel("Replace the value of \(secret.name)")
                }
                let presenceRole: MetistryColorRole = secret.present == false ? .absent : .textSecondary
                Text(secret.presenceLine)
                    .metistryText(.caption1, p, presenceRole)
                    .fixedSize(horizontal: false, vertical: true)
                if let expires = secret.expires {
                    let expired: Bool = secret.isExpired(now: now)
                    let role: MetistryColorRole = expired ? .failed : .textSecondary
                    Text("\(expired ? "Expired" : "Expires") \(expires), as the service reported")
                        .metistryText(.caption1, p, role)
                }
            }

            VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                Text("Sent Only To").metistryText(.subhead, p).accessibilityAddTraits(.isHeader)
                SettingsControls {
                    TextField("api.github.com, uploads.github.com", text: Binding(
                        get: { pane.hostText(secret) },
                        set: { pane.hostDrafts[secret.name] = $0 }
                    ))
                    .textFieldStyle(.roundedBorder)
                    .accessibilityLabel("Hosts \(secret.name) is sent to")
                    Button("Save Hosts…") { settings.proposeHosts(secret) }
                        .disabled(!pane.hostsChanged(secret))
                        .accessibilityLabel("Save the hosts for \(secret.name)")
                }
                Text("Metistry refuses any other host. A host name, or host:port — no scheme, no path, no wildcard.")
                    .metistryText(.caption1, p, .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                Text("Who May Use It").metistryText(.subhead, p).accessibilityAddTraits(.isHeader)
                let grantees = pane.grantees(for: secret)
                if grantees.isEmpty {
                    Text("No connection or agent to grant it to yet. Add one, and it is listed here — Off until you turn it on.")
                        .metistryText(.caption1, p, .textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                ForEach(grantees) { grantee in
                    GrantRowView(secret: secret, grantee: grantee, settings: settings)
                }
            }

            VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                SettingsControls {
                    Button("Delete…", role: .destructive) { Task { await settings.proposeSecretRemoval(secret) } }
                        .disabled(pane.previewing != nil)
                        .accessibilityLabel("Delete \(secret.name)")
                    if pane.previewing == secret.name {
                        ProgressView().controlSize(.small).accessibilityLabel("Checking what uses \(secret.name)")
                        Text("Checking what uses it…").metistryText(.caption1, p, .textTertiary)
                    }
                }
                if let refusal = pane.removalRefusal, refusal.name == secret.name {
                    UnavailableCard(what: "Could not check what uses \(secret.name)", reason: refusal.words)
                }
            }
        }
    }
}

/// One grantee: On · Ask · Off, how it is used, and — when the CLI refused a
/// change — its words, right here, with the switch where the file has it.
struct GrantRowView: View {
    @Environment(\.colorScheme) private var scheme
    let secret: NamedSecret
    let grantee: SecretGrantee
    let settings: SettingsModel

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            SettingsControls {
                VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                    Text(grantee.name).metistryText(.mono, p)
                    Text(grantee.kindLabel).metistryText(.caption2, p, .textTertiary)
                }
                .accessibilityElement(children: .combine)
                Spacer(minLength: MetistrySpace.s2)
                Picker("\(grantee.kindLabel) \(grantee.name) may use \(secret.name)", selection: Binding(
                    get: { secret.mode(for: grantee.id) },
                    set: { settings.proposeGrant(secret, to: grantee, $0) }
                )) {
                    ForEach(SecretGrantMode.allCases) { mode in
                        Text(mode.title).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
            }
            Text(grantee.howUsed(secret))
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
            if let refused = settings.secretsPane.grantRefusal(secret.name, grantee.id) {
                HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                    Image(systemName: CheckStatus.failed.symbolName)
                        .foregroundStyle(p[.failed])
                        .accessibilityHidden(true)
                    Text(refused)
                        .metistryText(.caption1, p, .failed)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Not changed: \(refused)")
            }
        }
    }
}

/// *Metistry's own* (screen-19 §1): the install's database, bridge and
/// owner-door tokens — collapsed, names and where each lives only.
struct MetistrysOwnSection: View {
    @Environment(\.colorScheme) private var scheme
    let settings: SettingsModel
    @State private var open = false

    var body: some View {
        let p = Palette(scheme)
        SettingsSection("Metistry's Own") {
            DisclosureGroup(isExpanded: $open) {
                VStack(alignment: .leading, spacing: MetistrySpace.s3) {
                    if case .unavailable(let why) = settings.secretsPhase {
                        UnavailableCard(what: "Could not read the install's own", reason: why, command: settings.secretsCommand)
                    }
                    ForEach(settings.secrets) { listing in
                        HStack(alignment: .top, spacing: MetistrySpace.s3) {
                            Image(systemName: listing.isSet ? "key.fill" : "key")
                                .foregroundStyle(p[listing.isSet ? .ok : .absent])
                                .accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                                Text(listing.name).metistryText(.mono, p)
                                Text(listing.scopeLabel)
                                    .metistryText(.caption1, p, .textTertiary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            Spacer(minLength: 0)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
                .padding(.top, MetistrySpace.s2)
            } label: {
                Text(settings.secrets.count == 1 ? "1 secret the install holds" : "\(settings.secrets.count) secrets the install holds")
                    .metistryText(.callout, p)
            }
            Text(SecretsModel.ownNote)
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

// MARK: - The editor sheet both panes share

extension View {
    /// New Secret / Replace, and New Variable / Edit — one sheet, so Store as
    /// Secret moves from the variable to the secret without a second sheet
    /// presenting over a closing one.
    func accessEditorSheet(_ settings: SettingsModel) -> some View {
        sheet(isPresented: Binding(
            get: { settings.secretsPane.draft != nil || settings.variablesPane.draft != nil },
            set: { shown in
                if !shown {
                    settings.cancelSecretDraft()
                    settings.cancelVariableDraft()
                }
            }
        )) {
            SecretOrVariableSheet(settings: settings)
        }
    }
}

struct SecretOrVariableSheet: View {
    let settings: SettingsModel

    var body: some View {
        if settings.secretsPane.draft != nil {
            SecretEditorView(settings: settings)
        } else if settings.variablesPane.draft != nil {
            VariableEditorView(settings: settings)
        }
    }
}

/// New Secret and Replace. The sheet IS the confirmation: it shows the exact
/// command, and says where the value goes, before its button runs it.
struct SecretEditorView: View {
    @Environment(\.colorScheme) private var scheme
    let settings: SettingsModel

    private var pane: SecretsModel { settings.secretsPane }

    private func binding(_ key: WritableKeyPath<SecretDraft, String>) -> Binding<String> {
        Binding(
            get: { pane.draft?[keyPath: key] ?? "" },
            set: { value in
                pane.draft?[keyPath: key] = value
                pane.draft?.refusal = nil
            }
        )
    }

    var body: some View {
        let p = Palette(scheme)
        let draft = pane.draft ?? SecretDraft()
        VStack(alignment: .leading, spacing: MetistrySpace.s4) {
            Text(draft.isReplace ? "Replace \(draft.name)" : "New Secret")
                .metistryText(.title3, p)
                .accessibilityAddTraits(.isHeader)
            if !draft.isReplace {
                LabeledContent("Name") {
                    TextField("lowercase, like github_write", text: binding(\.name))
                        .textFieldStyle(.roundedBorder)
                }
                LabeledContent("Sent only to") {
                    TextField("api.github.com — the hosts it may be sent to", text: binding(\.hosts))
                        .textFieldStyle(.roundedBorder)
                }
            }
            LabeledContent("Value") {
                SecureField("pasted here, sent to the command's standard input", text: binding(\.value))
                    .textFieldStyle(.roundedBorder)
            }
            LabeledContent("Expires") {
                TextField("optional — the date the service gives, 2026-12-31", text: binding(\.expires))
                    .textFieldStyle(.roundedBorder)
            }
            Text(draft.isReplace
                ? "The new value replaces the old one in this Mac's Keychain; who may use it and where it is sent stay as they are. An expiry recorded for the old value is cleared unless you give the new one."
                : "Stored in this Mac's Keychain, for this instance only. Without a host it is filled in for no server until Sent Only To names one.")
                .metistryText(.caption1, p, .textSecondary)
                .fixedSize(horizontal: false, vertical: true)

            CommandCard(argument: settings.plannedSecretCommand(draft), placeholder: "name the secret")
            Text("The value goes to the command's standard input — never on its command line — and is never shown again.")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)

            if let refusal = draft.refusal {
                UnavailableCard(what: "Not stored", reason: refusal)
            }

            HStack(spacing: MetistrySpace.s3) {
                Spacer(minLength: 0)
                Button("Cancel") { settings.cancelSecretDraft() }
                    .keyboardShortcut(.cancelAction)
                Button(draft.isReplace ? "Replace Value" : "Store Secret") {
                    Task { await settings.saveSecret() }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!draft.canSave || settings.running != nil)
            }
        }
        .padding(MetistrySpace.s5)
        .frame(width: 520)
        .background(p[.bg])
    }
}

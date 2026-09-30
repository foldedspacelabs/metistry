// Settings ▸ Secrets, and the panes whose own tickets have not landed
// (Variables, Live Capture, Sessions). Connections is connections-view.swift
// (T6-13a).
//
// Secrets keeps what it showed before the window became a sidebar —
// `metistry secrets list --json`'s names — until its own pane replaces it
// (screen 19). A pane not built yet says what it will hold and which verb
// does it today: never a dead end (C138).

import SwiftUI

struct SecretsPane: View {
    @Environment(\.colorScheme) private var scheme
    let settings: SettingsModel

    var body: some View {
        let p = Palette(scheme)
        SettingsSection("Secrets") {
            SettingsControls {
                Button("Read List") { Task { await settings.refreshSecrets() } }
                    .disabled(settings.secretsPhase == .reading)
                    .accessibilityLabel("Read the secret list")
                if settings.secretsPhase == .reading {
                    ProgressView().controlSize(.small)
                }
                Text("\(settings.secrets.count) named")
                    .metistryText(.caption1, p, .textTertiary)
                    .monospacedDigit()
            }
            if case .unavailable(let why) = settings.secretsPhase {
                UnavailableCard(what: "Could not read the secret list", reason: why, command: settings.secretsCommand)
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
            Text("Names and scope only. `metistry secrets list --json` has no code path that can print a value, and neither has this pane. The login Keychain is the canonical store, and .env is generated from it by `metistry secrets sync`.")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
            if let command = settings.secretsCommand {
                Text(command)
                    .metistryText(.caption1, p, .textTertiary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

struct PendingPane: View {
    @Environment(\.colorScheme) private var scheme
    let section: SettingsModel.Section

    var body: some View {
        let p = Palette(scheme)
        SettingsSection(section.title) {
            Text(section.pendingNote ?? "")
                .metistryText(.callout, p, .textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

// Settings ▸ Connections, Secrets, and the panes whose own tickets have not
// landed (Variables, Live Capture, Sessions).
//
// Connections and Secrets keep what they showed before the window became a
// sidebar — doctor's bridge rows, and `metistry secrets list --json`'s names —
// until their own panes replace them (screens 9 and 19). A pane not built yet
// says what it will hold and which verb does it today: never a dead end (C138).

import SwiftUI

struct ConnectionsPane: View {
    @Environment(\.colorScheme) private var scheme
    let settings: SettingsModel

    var body: some View {
        let p = Palette(scheme)
        SettingsSection("Bridges") {
            if settings.bridges.isEmpty {
                Text("No bridges in the last doctor report.")
                    .metistryText(.footnote, p, .textSecondary)
            } else {
                ForEach(settings.bridges) { row in
                    HStack(alignment: .top, spacing: MetistrySpace.s3) {
                        StatusDot(row.status)
                        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                            Text(row.name).metistryText(.mono, p)
                            Text(row.remediation ?? row.probe)
                                .metistryText(.caption1, p, .textTertiary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: MetistrySpace.s2)
                        Text(row.status.label).metistryText(.caption2, p, row.status.colorRole)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            Text("From `metistry doctor --json`. Adding and configuring a connection is `metistry connections` in Terminal until this pane does it.")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

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

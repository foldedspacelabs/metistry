// Settings ▸ Updates (screen-15 §5.4): two channels, both signed, on purpose.
//
// THIS APP updates itself through Sparkle, which owns its own preferences and
// reads them itself — the app keeps no copy. THE RUNTIME updates through
// `metistry update` (M2): the running version from `metistry version --json`,
// a newer one as the daily Update Check announced it (`release.available`,
// T2-18), Update Runtime, and — on a release install, which keeps the previous
// release — Roll Back (`metistry update --rollback`). Both are confirmed with
// the exact command; a failure is the CLI's own words with View Log.

import SwiftUI

struct UpdatesPane: View {
    @Environment(\.colorScheme) private var scheme
    let model: AppModel

    private var settings: SettingsModel { model.settings }

    var body: some View {
        let p = Palette(scheme)
        thisApp(p)
        runtime(p)
    }

    @ViewBuilder
    private func thisApp(_ p: Palette) -> some View {
        SettingsSection("This App") {
            FactRow("Version", model.updates.appVersion, mono: true)
            FactRow("Channel", model.updates.channel, help: "One signed appcast today, so one channel.", mono: true)
            if let available = model.updates.availableVersion {
                FactRow("Update available", available, role: .accent)
            }
            SettingsControls {
                Button("Check Now") { model.updates.checkNow() }
                    .disabled(!model.updates.canCheck)
                    .accessibilityLabel("Check for app updates now")
                if let last = model.updates.lastCheckedAt {
                    Text("Last checked \(last.formatted(date: .abbreviated, time: .shortened))")
                        .metistryText(.caption1, p, .textTertiary)
                }
            }
            Toggle("Check for updates automatically", isOn: Binding(
                get: { model.updates.automaticChecksEnabled },
                set: { model.updates.setAutomaticChecks($0) }
            ))
            .disabled(!model.updates.canCheck)
            Text("Sparkle owns these preferences and reads them itself; the app keeps no copy.")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private func runtime(_ p: Palette) -> some View {
        SettingsSection("Metistry Runtime") {
            if case .unavailable(let why) = settings.versionsPhase {
                UnavailableCard(what: "Could not read the versions", reason: why, command: settings.versionsCommand)
            }
            FactRow("Running", settings.versions?.product ?? "unknown", help: "What `metistry version --json` reports for the runtime this app drives.", mono: true, role: settings.versions?.product == nil ? .absent : .textPrimary)
            FactRow("Channel", settings.runtimeChannel ?? "unknown", help: "From the instance's pin, metistry.lock.", mono: true)
            FactRow(
                "Available",
                settings.runtimeAvailable ?? "none announced since the app opened",
                help: "The daily Update Check announces a newer release while the app is open.",
                mono: settings.runtimeAvailable != nil,
                role: settings.runtimeAvailable == nil ? .textSecondary : .accent
            )
            Button("Update Runtime…") { settings.proposeUpdate() }
                .disabled(settings.management == nil || settings.running != nil)
            Divider()
            Text("The previous release is kept when an update installs a new one.")
                .metistryText(.footnote, p, .textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            Button("Roll Back…") { settings.proposeRollBack() }
                .disabled(settings.rollBackUnavailableReason != nil || settings.management == nil || settings.running != nil)
            if let reason = settings.rollBackUnavailableReason {
                Text(reason)
                    .metistryText(.caption1, p, .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let pin = settings.pin {
                FactRow("Instance pin", pin.version ?? "unknown", help: "metistry.lock, \(pin.migrationsApplied) migrations applied\(pin.updatedAt.map { ", updated \($0)" } ?? "").", mono: true)
            }
            Text("`metistry update` moves the install forward: pinned artifacts, migrations under an advisory lock, the new pin written into the instance repository, then doctor.")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .task(id: model.instances.active) { await settings.refreshVersions() }
    }
}

// Settings ▸ Advanced (screen-15 §5.6): where the runtime comes from, the
// developer override, the versions, and the diagnostics (logs, passkeys).
// Doctor moved to Services.

import SwiftUI
import UniformTypeIdentifiers

struct AdvancedPane: View {
    @Environment(\.colorScheme) private var scheme
    let model: AppModel
    let actions: SettingsActions

    @State private var pickingProductDir = false

    private var settings: SettingsModel { model.settings }
    /// Where doctor probed the console, for the passkey diagnostic. The same
    /// source the wizard's step 6 uses.
    private var consoleURL: String? { PasskeyRouting.consoleURL(in: model.status.report) }

    var body: some View {
        let p = Palette(scheme)
        runtime(p)
        developerOverride(p)
        versions(p)
        diagnostics(p)
    }

    @ViewBuilder
    private func runtime(_ p: Palette) -> some View {
        SettingsSection("Runtime") {
            FactRow("Runtime from", Self.runtimeFrom(settings.runtimeChannel), help: "From the instance's pin: a release's artifacts, or a git checkout built in place.")
            if let runtime = model.runtime {
                FactRow("Located", runtime.source.label)
                FactRow("Command", runtime.describedCommand, mono: true)
                if let dir = runtime.productDir {
                    FactRow("Product folder", dir.path, mono: true)
                }
            } else {
                UnavailableCard(what: "No metistry runtime located", reason: model.resolution.attempts.joined(separator: "\n"))
            }
            Button("Look Again") { model.relocate() }
                .accessibilityLabel("Look for the runtime again")
        }
    }

    static func runtimeFrom(_ channel: String?) -> String {
        switch channel {
        case "release": return "Releases"
        case "git": return "Git checkout"
        default: return "unknown"
        }
    }

    @ViewBuilder
    private func developerOverride(_ p: Palette) -> some View {
        SettingsSection("Developer Override") {
            Text(model.developerProductDir?.path ?? "None — the app uses the runtime bundled inside it")
                .metistryText(.footnote, p, model.developerProductDir == nil ? .textTertiary : .textPrimary)
                .lineLimit(2)
                .truncationMode(.head)
                .textSelection(.enabled)
            SettingsControls {
                Button("Choose…") { pickingProductDir = true }
                    .accessibilityLabel("Choose a product checkout")
                if model.developerProductDir != nil {
                    Button("Clear") { model.chooseDeveloperProductDirectory(nil) }
                        .accessibilityLabel("Clear the developer override")
                }
            }
            Text("For a build with no runtime inside it: a Metistry checkout with packages/cli/dist/main.js built. A downloaded Metistry.app never needs this — its own bundle is the product.")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .fileImporter(isPresented: $pickingProductDir, allowedContentTypes: [.folder]) { result in
            if case .success(let url) = result { model.chooseDeveloperProductDirectory(url) }
        }
    }

    @ViewBuilder
    private func versions(_ p: Palette) -> some View {
        SettingsSection("Versions") {
            FactRow("App", model.updates.appVersion, mono: true)
            if case .unavailable(let why) = settings.versionsPhase {
                UnavailableCard(what: "Could not read the versions", reason: why, command: settings.versionsCommand)
            }
            if let product = settings.versions?.product {
                FactRow("Product runtime", product, help: "What `metistry version --json` reports for the runtime this app is driving.", mono: true)
            }
            if let runtime = settings.versions?.runtime {
                FactRow("Runtime pack", runtime, help: "The Node/Postgres/git pack beside it, when there is one.", mono: true)
            }
            if let pin = settings.pin {
                FactRow("Instance pin", "\(pin.version ?? "unknown") (\(pin.source ?? "unknown"))", help: "metistry.lock, \(pin.migrationsApplied) migrations applied.", mono: true)
            }
            Button("Read Versions") { Task { await settings.refreshVersions() } }
                .disabled(settings.versionsPhase == .reading)
        }
        .task(id: model.instances.active) { await settings.refreshVersions() }
    }

    @ViewBuilder
    private func diagnostics(_ p: Palette) -> some View {
        SettingsSection("Logs") {
            FactRow("Log folder", MetistryLogs.conventionalDirectory, mono: true)
            Text(MetistryLogs.note)
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
            Button("Open in Finder") { actions.openInFinder(URL(fileURLWithPath: MetistryLogs.conventionalDirectory)) }
                .accessibilityLabel("Open the log folder in Finder")
        }

        SettingsSection("Passkeys") {
            PasskeyDiagnosticView(model: model.firstRun.passkey)
        }
        .task(id: consoleURL) { model.firstRun.passkey.adopt(consoleURL: consoleURL) }
    }
}

// Settings, in the place macOS users look for it: the app menu, ⌘, and a
// tabbed window (`Settings` scene in the executable target).
//
// Six panes. Every value on them is one of three things, and the pane says which:
// a POINTER the app remembers (the instance directory, the recents, the developer
// override), a READ-THROUGH of a file or a verb the CLI owns, or a labelled
// "not yet". There is no fourth category — no app-private configuration, and no
// second copy of anything in identity.yaml, deployment.yaml or .env.
//
// docs/ops/mac-app.md carries the same split as a table.

import SwiftUI
import UniformTypeIdentifiers

public struct SettingsView: View {
    @Environment(\.colorScheme) private var scheme
    private let model: AppModel
    private let onOpenInFinder: (URL) -> Void
    private let onSetUpAgain: () -> Void

    @State private var pickingInstance = false
    @State private var pickingProductDir = false

    public init(
        model: AppModel,
        onOpenInFinder: @escaping (URL) -> Void,
        onSetUpAgain: @escaping () -> Void
    ) {
        self.model = model
        self.onOpenInFinder = onOpenInFinder
        self.onSetUpAgain = onSetUpAgain
    }

    private var settings: SettingsModel { model.settings }

    public var body: some View {
        TabView(selection: Binding(get: { settings.section }, set: { settings.section = $0 })) {
            ForEach(SettingsModel.Section.allCases) { section in
                pane(section)
                    .tabItem { Label(section.title, systemImage: section.symbolName) }
                    .tag(section)
            }
        }
        .frame(width: 640, height: 520)
    }

    @ViewBuilder
    private func pane(_ section: SettingsModel.Section) -> some View {
        let p = Palette(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: MetistrySpace.s5) {
                switch section {
                case .instance: instancePane(p)
                case .services: servicesPane(p)
                case .connections: connectionsPane(p)
                case .secrets: secretsPane(p)
                case .updates: updatesPane(p)
                case .advanced: advancedPane(p)
                }
            }
            .padding(MetistrySpace.s5)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(p[.bg])
    }

    // MARK: - Instance

    @ViewBuilder
    private func instancePane(_ p: Palette) -> some View {
        SettingsSection("Active Instance") {
            HStack(spacing: MetistrySpace.s2) {
                Text(model.instances.active?.path ?? "none chosen")
                    .metistryText(.mono, p, model.instances.active == nil ? .textTertiary : .textPrimary)
                    .lineLimit(1)
                    .truncationMode(.head)
                    .textSelection(.enabled)
                Spacer(minLength: MetistrySpace.s2)
                Button("Choose…") { pickingInstance = true }
                if let active = model.instances.active {
                    Button("Open in Finder") { onOpenInFinder(active) }
                }
            }
            Text("Every `metistry` verb the app runs is given METISTRY_INSTANCE_DIR=<this path>. An inherited variable wins over the product checkout's .env, so this is the one place that decides which install the app is talking to.")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .fileImporter(isPresented: $pickingInstance, allowedContentTypes: [.folder]) { result in
            if case .success(let url) = result { model.activateInstance(url) }
        }

        if !model.instances.recents.isEmpty {
            SettingsSection("Recents") {
                ForEach(model.instances.recents, id: \.path) { url in
                    HStack(spacing: MetistrySpace.s2) {
                        Image(systemName: url.path == model.instances.active?.path ? "checkmark.circle.fill" : "folder")
                            .foregroundStyle(p[url.path == model.instances.active?.path ? .ok : .textTertiary])
                        Button(url.path) { model.activateInstance(url) }
                            .buttonStyle(.plain)
                            .metistryText(.footnote, p, .textPrimary)
                            .lineLimit(1)
                            .truncationMode(.head)
                        Spacer(minLength: MetistrySpace.s2)
                        Button("Forget") { model.forgetInstance(url) }
                            .metistryText(.caption1, p, .textSecondary)
                    }
                }
            }
        }

        SettingsSection("Assistant") {
            if case .unavailable(let why) = settings.identityPhase {
                UnavailableCard(what: "Could not read the identity", reason: why, command: settings.identityCommand)
            } else if settings.identityPhase == .reading {
                Text("reading `metistry identity --json`…").metistryText(.footnote, p, .textSecondary)
            } else {
                FactRow("Name", settings.assistantNameDisplay, mono: true)
                if let mention = settings.identity?.mention {
                    FactRow("Mention", mention, mono: true)
                }
                if let icon = settings.identity?.icon {
                    FactRow("Icon", icon)
                }
                FactRow(
                    "Instance id",
                    settings.identity?.instanceID ?? "not reported",
                    help: SettingsModel.instanceIdNote,
                    mono: true,
                    role: settings.identity?.instanceID == nil ? .absent : .textPrimary
                )
            }
            Text("From `metistry identity --json`. The assistant is named in the instance's identity.yaml and nowhere else; it is a protected path — only your own hand writes it — so this pane shows the name and offers no field to change it. `metistry init --name` sets it on a new instance.")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .task(id: model.instances.active) { await settings.refreshIdentity() }

        SettingsSection("Set Up Again") {
            Text("Runs the first-launch steps over: create or adopt an instance, connect a repository, sync secrets, bring the services up. Nothing happens until you press Run on a step.")
                .metistryText(.footnote, p, .textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            Button("Set Up Again…", action: onSetUpAgain)
        }
    }

    // MARK: - Services

    @ViewBuilder
    private func servicesPane(_ p: Palette) -> some View {
        if let deployment = settings.deployment {
            SettingsSection("Shape") {
                FactRow("Shape", deployment.shape, help: "From \(deployment.from) — the D4 overlay: the product's seed/deployment.yaml, then the instance's own file if it has one.", mono: true)
            }
            SettingsSection("Services") {
                ForEach(deployment.ordered, id: \.name) { service in
                    serviceRow(name: service.name, plannedShape: service.shape, p)
                }
            }
        } else {
            UnavailableCard(
                what: "No deployment shape reported yet",
                reason: "It comes from `metistry doctor --json`'s deployment row. Run doctor from the Status window, or from Advanced.",
                command: model.status.lastCommand
            )
        }

        SettingsSection("Start at Login") {
            Toggle("Start Metistry at login", isOn: Binding(
                get: { model.loginItem.isOn },
                set: { model.loginItem.set($0) }
            ))
            .disabled(!model.loginItem.isSupported)
            HStack(spacing: MetistrySpace.s2) {
                StatusDot(loginDot)
                Text(model.loginItem.status.label)
                    .metistryText(.footnote, p, model.loginItem.status.colorRole)
                    .fixedSize(horizontal: false, vertical: true)
            }
            // `requiresApproval` is the normal first-time answer: macOS holds
            // the registration until the person allows it, and there is exactly
            // one place to do that.
            if model.loginItem.status.needsApproval {
                Button("Open Login Items…") { model.loginItem.openSystemSettings() }
            }
            if model.loginItem.status == .notFound {
                Text(LoginItemModel.notAnAppBundleNote)
                    .metistryText(.caption1, p, .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let error = model.loginItem.lastError {
                UnavailableCard(what: "SMAppService refused", reason: error)
            }
            Text(LoginItemModel.note)
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .task { model.loginItem.refresh() }
    }

    private var loginDot: CheckStatus {
        switch model.loginItem.status {
        case .enabled: return .ok
        case .requiresApproval: return .degraded
        case .notRegistered: return .absent
        case .notFound, .unknown: return .failed
        }
    }

    private func serviceRow(name: String, plannedShape: String, _ p: Palette) -> some View {
        let row = settings.serviceRow(named: name)
        return HStack(alignment: .top, spacing: MetistrySpace.s3) {
            StatusDot(row?.status ?? .absent)
            VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                Text(name).metistryText(.mono, p)
                Text(row?.remediation ?? row?.probe ?? "not in this doctor report")
                    .metistryText(.caption1, p, .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: MetistrySpace.s2)
            VStack(alignment: .trailing, spacing: MetistrySpace.s1) {
                Text(plannedShape).metistryText(.caption2, p, plannedShape == "disabled" ? .absent : .textSecondary)
                if let row {
                    Text(row.status.label).metistryText(.caption1, p, row.status.colorRole)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: - Connections

    @ViewBuilder
    private func connectionsPane(_ p: Palette) -> some View {
        SettingsSection("Instance Repository") {
            FactRow("Status", settings.repositoryStatus)
            if let facts = settings.reconciler {
                if let head = facts.head {
                    FactRow("HEAD", String(head.prefix(12)), mono: true)
                }
                if let depth = facts.queueDepth {
                    FactRow("Queue depth", String(depth), help: "Writes waiting for the reconciler's next commit.", mono: true)
                }
            }
            Text("Reported by the reconciler, which is the sole committer — the app runs no git of its own. `metistry connect-repo` is what adds or changes a remote; the wizard's step 3 runs it.")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
            Button("Connect a Repository…", action: onSetUpAgain)
        }

        SettingsSection("Claude Token") {
            if let listing = settings.claudeTokenListing {
                FactRow("CLAUDE_CODE_OAUTH_TOKEN", listing.isSet ? "set" : "not set", help: listing.scopeLabel, mono: true, role: listing.isSet ? .ok : .absent)
            } else if case .unavailable(let why) = settings.secretsPhase {
                UnavailableCard(what: "Could not read the secret list", reason: why, command: settings.secretsCommand)
            } else {
                Text(settings.secretsPhase == .reading ? "reading `metistry secrets list`…" : "not read yet — open the Secrets pane, or press Read below.")
                    .metistryText(.footnote, p, .textSecondary)
            }
            Text("Set or not set, from `metistry secrets list --json`. The value is never requested and never displayed. The wizard's step 7 guides `claude setup-token` in a terminal and watches for this name to appear; `\(ClaudeTokenModel.importCommand)` is what carries it into the login Keychain.")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
            Button("Read Secret List") { Task { await settings.refreshSecrets() } }
                .disabled(settings.secretsPhase == .reading)
        }

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
        }
    }

    // MARK: - Secrets

    @ViewBuilder
    private func secretsPane(_ p: Palette) -> some View {
        SettingsSection("Secrets") {
            HStack(spacing: MetistrySpace.s3) {
                Button("Read List") { Task { await settings.refreshSecrets() } }
                    .disabled(settings.secretsPhase == .reading)
                if settings.secretsPhase == .reading {
                    ProgressView().controlSize(.small)
                }
                Spacer(minLength: 0)
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
            Text("Names and scope only. `metistry secrets list --json` has no code path that can print a value, and neither has this pane. The login Keychain is the canonical store — instance-scoped items under this instance's instance_id, user-scoped ones under the per-Mac account — and .env is generated from it by `metistry secrets sync`.")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
            if let command = settings.secretsCommand {
                Text(command).metistryText(.caption1, p, .textTertiary).textSelection(.enabled)
            }
        }
    }

    // MARK: - Updates

    @ViewBuilder
    private func updatesPane(_ p: Palette) -> some View {
        SettingsSection("This App") {
            FactRow("Version", model.updates.appVersion, mono: true)
            FactRow("Channel", model.updates.channel, help: "One signed appcast today, so one channel.", mono: true)
            if let feed = model.updates.feedURL {
                FactRow("Feed", feed, help: "Read by Sparkle from Info.plist, alongside the public EdDSA key the release workflow signs with.", mono: true)
            }
            if let available = model.updates.availableVersion {
                FactRow("Update available", available, role: .accent)
            }
            HStack(spacing: MetistrySpace.s3) {
                Button("Check Now") { model.updates.checkNow() }
                    .disabled(!model.updates.canCheck)
                if let last = model.updates.lastCheckedAt {
                    Text("last checked \(last.formatted(date: .abbreviated, time: .shortened))")
                        .metistryText(.caption1, p, .textTertiary)
                }
            }
            Toggle("Check for updates automatically", isOn: Binding(
                get: { model.updates.automaticChecksEnabled },
                set: { model.updates.setAutomaticChecks($0) }
            ))
            .disabled(!model.updates.canCheck)
            Text("Sparkle owns this preference and reads it itself; the app does not keep a copy.")
                .metistryText(.caption1, p, .textTertiary)
        }

        SettingsSection("The Product Runtime") {
            Text("The app and the product update on two channels, both signed. This app updates itself from the appcast above; the product runtime updates through `metistry update` — pinned artifacts, migrations under an advisory lock, the new pin written into the instance repo.")
                .metistryText(.footnote, p, .textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            if let pin = settings.pin {
                FactRow("Instance pin", pin.version ?? "unknown", help: "metistry.lock, source \(pin.source ?? "unknown"). Updated \(pin.updatedAt ?? "unknown").", mono: true)
            } else if case .unavailable(let why) = settings.versionsPhase {
                Text(why).metistryText(.caption1, p, .textTertiary).fixedSize(horizontal: false, vertical: true)
            }
        }
        .task(id: model.instances.active) { await settings.refreshVersions() }
    }

    // MARK: - Advanced

    @ViewBuilder
    private func advancedPane(_ p: Palette) -> some View {
        SettingsSection("Runtime") {
            if let runtime = model.runtime {
                FactRow("Source", runtime.source.label)
                FactRow("Runs", runtime.describedCommand, mono: true)
                if let dir = runtime.productDir {
                    FactRow("Product directory", dir.path, mono: true)
                }
            } else {
                UnavailableCard(
                    what: "No metistry runtime located",
                    reason: model.resolution.attempts.joined(separator: "\n")
                )
            }
            Button("Look Again") { model.relocate() }
        }

        SettingsSection("Versions") {
            FactRow("App", model.updates.appVersion, mono: true)
            if case .unavailable(let why) = settings.versionsPhase {
                UnavailableCard(what: "Could not read the versions", reason: why, command: settings.versionsCommand)
            }
            if let product = settings.versions?.product {
                FactRow("Product runtime", product, help: "What `metistry version --json` reports for the runtime this app is driving.", mono: true)
            }
            if let runtime = settings.versions?.runtime {
                FactRow("Bundled runtime", runtime, help: "The Node/Postgres/git pack beside it, when there is one.", mono: true)
            }
            if let pin = settings.pin {
                FactRow("Instance pin", "\(pin.version ?? "unknown") (\(pin.source ?? "unknown"))", help: "metistry.lock, \(pin.migrationsApplied) migrations applied.", mono: true)
            }
            Button("Read Versions") { Task { await settings.refreshVersions() } }
                .disabled(settings.versionsPhase == .reading)
        }
        .task(id: model.instances.active) { await settings.refreshVersions() }

        SettingsSection("Developer Runtime Override") {
            HStack(spacing: MetistrySpace.s2) {
                Text(model.developerProductDir?.path ?? "none — the app uses the runtime bundled inside it")
                    .metistryText(.footnote, p, model.developerProductDir == nil ? .textTertiary : .textPrimary)
                    .lineLimit(1)
                    .truncationMode(.head)
                    .textSelection(.enabled)
                Spacer(minLength: MetistrySpace.s2)
                Button("Choose…") { pickingProductDir = true }
                if model.developerProductDir != nil {
                    Button("Clear") { model.chooseDeveloperProductDirectory(nil) }
                }
            }
            Text("For a build with no runtime inside it: a Metistry checkout with packages/cli/dist/main.js built. A downloaded Metistry.app never needs this — its own bundle is the product, which is why there is no product-directory setting anywhere else.")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .fileImporter(isPresented: $pickingProductDir, allowedContentTypes: [.folder]) { result in
            if case .success(let url) = result { model.chooseDeveloperProductDirectory(url) }
        }

        SettingsSection("Doctor") {
            HStack(spacing: MetistrySpace.s3) {
                Button("Run Doctor") { Task { await model.status.refresh() } }
                    .disabled(model.status.isChecking)
                if model.status.isChecking { ProgressView().controlSize(.small) }
                Spacer(minLength: 0)
                Text(model.status.report?.summary ?? "not run yet")
                    .metistryText(.caption1, p, .textTertiary)
            }
            if let command = model.status.lastCommand {
                Text(command).metistryText(.caption1, p, .textTertiary).textSelection(.enabled)
            }
        }

        SettingsSection("Logs") {
            FactRow("Log folder", MetistryLogs.conventionalDirectory, mono: true)
            Text(MetistryLogs.note)
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
            Button("Open in Finder") { onOpenInFinder(URL(fileURLWithPath: MetistryLogs.conventionalDirectory)) }
        }
    }
}

/// Where a launchd job's output lands today, and why the app does not pretend to
/// own that.
///
/// `ops/launchd/*.plist` sets `StandardOutPath` to `/tmp/metistry-<name>.log`.
/// That is a convention, not an interface: a container's log is docker's, and a
/// future systemd unit's is journald's. `metistry logs` is the read path the menu
/// uses for exactly that reason, and "Open in Finder" here is a convenience for
/// the shape this Mac happens to run.
public enum MetistryLogs {
    public static let conventionalDirectory = "/tmp"
    public static let note =
        "Where the launchd jobs write today (StandardOutPath in ops/launchd/*.plist: /tmp/metistry-<name>.log). "
        + "The menu bar's View Log runs `metistry logs <name>` instead, because a container's or a systemd unit's log is not a file here — "
        + "and once `metistry logs --json` reports its own paths, this row can stop assuming one."
}

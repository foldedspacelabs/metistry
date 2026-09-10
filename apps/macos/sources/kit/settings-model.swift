// Settings: what is on screen and where every value came from.
//
// Six sections, and each one is a window onto something else — never a copy of
// it (app-preferences.swift holds the rule and the three things this app does
// persist):
//
//   Instance     the active instance directory + recents (PERSISTED, pointers);
//                the assistant's name from identity.yaml (READ-THROUGH,
//                read-only — a §4.7 protected path)
//   Services     the shape and the service plan from doctor's `deployment` row,
//                which resolved deployment.yaml's D4 overlay (READ-THROUGH)
//   Connections  the instance repo's push state from doctor's `reconciler` row;
//                bridges from doctor's `bridge` rows (READ-THROUGH)
//   Secrets      names and scope from `metistry secrets list` (READ-THROUGH;
//                never a value, and there is no code path here that could hold
//                one)
//   Updates      Sparkle's own preferences, read and written by Sparkle
//   Advanced     the resolved runtime, versions, `metistry doctor`, logs
//
// Nothing here caches to disk. Every read is re-done when the pane opens, so a
// value the user changed in a file or a terminal shows up without a relaunch —
// and a value the app cannot read says "unavailable" in its own row and leaves
// the rest of the pane alone (design-system P5).

import Foundation
import Observation

/// The state of one read-through value. Same four states as everything else in
/// the product, for the same reason: state is reported, never inferred.
public enum ReadPhase: Equatable, Sendable {
    case idle
    case reading
    case read
    case unavailable(String)
}

@MainActor
@Observable
public final class SettingsModel {
    public enum Section: String, CaseIterable, Identifiable, Sendable {
        case instance
        case services
        case connections
        case secrets
        case updates
        case advanced

        public var id: String { rawValue }

        /// Title Case — these are navigation labels (design-system P10).
        public var title: String {
            switch self {
            case .instance: return "Instance"
            case .services: return "Services"
            case .connections: return "Connections"
            case .secrets: return "Secrets"
            case .updates: return "Updates"
            case .advanced: return "Advanced"
            }
        }

        public var symbolName: String {
            switch self {
            case .instance: return "folder"
            case .services: return "gearshape.2"
            case .connections: return "link"
            case .secrets: return "key"
            case .updates: return "arrow.down.circle"
            case .advanced: return "wrench.and.screwdriver"
            }
        }
    }

    public var section: Section = .instance

    /// The shared doctor report. Services and Connections render it; they never
    /// run their own probes (invariant 3 — one read path).
    public let status: StatusModel
    public private(set) var cli: MetistryCLI?
    public private(set) var instanceDir: URL?

    // MARK: read-through, never persisted
    public private(set) var identity: InstanceIdentity?
    public private(set) var identityError: String?
    public private(set) var pin: InstancePin?
    public private(set) var pinError: String?
    public private(set) var secrets: [SecretListing] = []
    public private(set) var secretsPhase: ReadPhase = .idle
    public private(set) var secretsCommand: String?

    public init(status: StatusModel, cli: MetistryCLI?, instanceDir: URL?) {
        self.status = status
        self.cli = cli
        self.instanceDir = instanceDir
        readInstanceFiles()
    }

    public func adopt(cli: MetistryCLI?, instanceDir: URL?) {
        self.cli = cli
        self.instanceDir = instanceDir
        secrets = []
        secretsPhase = .idle
        secretsCommand = nil
        readInstanceFiles()
    }

    // MARK: - Instance

    /// `identity.yaml` and `metistry.lock`, straight off disk. Synchronous
    /// because they are two small local files and an async spinner for a 2 KB
    /// read is theatre.
    public func readInstanceFiles() {
        identity = nil
        identityError = nil
        pin = nil
        pinError = nil
        guard let dir = instanceDir else { return }
        switch InstanceFiles.identity(in: dir) {
        case .success(let value): identity = value
        case .failure(let error): identityError = error.localizedDescription
        }
        switch InstanceFiles.pin(in: dir) {
        case .success(let value): pin = value
        case .failure(let error): pinError = error.localizedDescription
        }
    }

    /// What the Instance pane prints for the assistant's name. `identity.yaml`
    /// is the only place it lives, so an unreadable file says so rather than
    /// falling back to a default that would be a second definition.
    public var assistantNameDisplay: String {
        identity?.assistantName ?? "unknown"
    }

    /// There is no instance ID anywhere in the product — not in `identity.yaml`
    /// (name · mention · voice · icon), not in `metistry.lock`, not in doctor.
    /// The owner direction asked for one; rather than invent an identifier the
    /// rest of the system does not know, the pane shows what actually identifies
    /// an install and this property says so out loud.
    public static let instanceIdNote =
        "identity.yaml carries name, mention, voice and icon — there is no instance id in the schema. "
        + "What identifies this install is the folder path above and the product pin in metistry.lock."

    // MARK: - Secrets

    /// `metistry secrets list` — names and scope. Values are not requested, not
    /// returned by the verb, and could not be rendered if they were.
    public func refreshSecrets() async {
        guard let cli else {
            secretsPhase = .unavailable("no metistry runtime located — choose an instance first")
            return
        }
        let verb = ["secrets", "list"]
        secretsCommand = ([cli.runtime.executable.path] + cli.arguments(for: verb)).joined(separator: " ")
        secretsPhase = .reading
        do {
            let result = try await cli.run(verb)
            let parsed = SecretListing.parse(result.stdout)
            if parsed.isEmpty {
                let why = result.ok
                    ? "`metistry secrets list` named nothing — this install has no .env yet, or no secret-shaped variables in it"
                    : (result.stderr.split(separator: "\n").last.map(String.init) ?? "exit \(result.exitCode)")
                secrets = []
                secretsPhase = .unavailable(why)
            } else {
                secrets = parsed
                secretsPhase = .read
            }
        } catch {
            secrets = []
            secretsPhase = .unavailable(error.localizedDescription)
        }
    }

    // MARK: - Services

    public var deployment: DeploymentFacts? { status.report?.deployment }

    /// A service's doctor row, matched by name, so the Services pane can show
    /// the plan and the state side by side without deciding either.
    public func serviceRow(named name: String) -> DoctorRow? {
        status.report?.rows.first { $0.kind == "service" && $0.name == name }
    }

    /// "Start at login" is not wired to anything, and the pane says so. The
    /// sanctioned mechanism is `SMAppService` (macOS 13+) registering the app's
    /// own launchd agents with one approval in System Settings — which needs a
    /// `metistry up` that can hand the app its job set instead of installing it,
    /// so it is a CLI change first (docs/product/desktop-app-plan.md).
    public static let startAtLoginNote =
        "Not yet. `metistry up` installs the launchd jobs the way the terminal does; "
        + "SMAppService is the sanctioned shape for an app to register them, and it needs a `metistry up` "
        + "that hands over its job set rather than installing it."

    // MARK: - Connections

    public var reconciler: ReconcilerFacts? { status.report?.reconciler }

    /// The instance repo's backup state, in one sentence, from the reconciler's
    /// own report — the sole committer is the only honest source, and the app
    /// runs no git of its own (invariant 9 applied to the client).
    public var repositoryStatus: String {
        guard let facts = reconciler else { return "unknown — doctor has not reported the reconciler yet" }
        guard facts.pushAttempted, let remote = facts.remote else {
            return "no remote — this instance is versioned locally only. `metistry connect-repo` adds one."
        }
        let when = facts.pushedAt.map { " at \($0)" } ?? ""
        return facts.pushOK == true
            ? "pushed to \(remote)\(when)"
            : "last push to \(remote) failed\(when) — see the reconciler row in Status"
    }

    /// The Claude token, as `secrets list` reports it: set or not set, never the
    /// value. `nil` when the list has not been read yet.
    public var claudeTokenListing: SecretListing? {
        secrets.first { $0.name == "CLAUDE_CODE_OAUTH_TOKEN" }
    }

    public var bridges: [DoctorRow] { status.report?.bridges ?? [] }
}

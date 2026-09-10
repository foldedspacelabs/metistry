// Settings: what is on screen and where every value came from.
//
// Six sections, and each one is a window onto something else — never a copy of
// it (app-preferences.swift holds the rule and the three things this app does
// persist):
//
//   Instance     the active instance directory + recents (PERSISTED, pointers);
//                the instance id and the assistant's name from
//                `metistry identity --json` (READ-THROUGH, read-only — the file
//                behind it is a §4.7 protected path)
//   Services     the shape and the service plan from doctor's `deployment` row,
//                which resolved deployment.yaml's D4 overlay (READ-THROUGH)
//   Connections  the instance repo's push state from doctor's `reconciler` row;
//                bridges from doctor's `bridge` rows (READ-THROUGH)
//   Secrets      names and scope from `metistry secrets list` (READ-THROUGH;
//                never a value, and there is no code path here that could hold
//                one)
//   Updates      Sparkle's own preferences, read and written by Sparkle
//   Advanced     the resolved runtime, `metistry version --json`,
//                `metistry doctor`, logs
//
// Nothing here caches to disk. Every read is re-done when the pane opens, so a
// value the user changed in a file or a terminal shows up without a relaunch —
// and a value the app cannot read says "unavailable" in its own row and leaves
// the rest of the pane alone (design-system P5).
//
// EVERY READ IS A VERB NOW. The scaffold read `identity.yaml`, `metistry.lock`
// and a `package.json` off disk because the CLI reported none of it. It does
// now (cli-facts.swift), so this model runs `identity --json`,
// `version --json`, `secrets list --json` and `deployment --json` and holds no
// parser at all. That is why the reads became async: a subprocess is not a
// 2 KB file read, and a spinner on a pane row is honest where one on a file read
// was theatre.

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
    /// Who the console takes this Mac to be. The app's one sign-in model, shared
    /// with the Status header, the menu bar and the wizard — Connections renders
    /// it, and no pane asks the question a second time.
    public let consoleSignIn: ConsoleSignInModel
    public private(set) var cli: MetistryCLI?
    public private(set) var instanceDir: URL?

    // MARK: read-through, never persisted
    public private(set) var identity: InstanceIdentity?
    public private(set) var identityPhase: ReadPhase = .idle
    public private(set) var identityCommand: String?
    public private(set) var versions: VersionFacts?
    public private(set) var versionsPhase: ReadPhase = .idle
    public private(set) var versionsCommand: String?
    public private(set) var secrets: [SecretListing] = []
    public private(set) var secretsPhase: ReadPhase = .idle
    public private(set) var secretsCommand: String?

    public init(
        status: StatusModel,
        cli: MetistryCLI?,
        instanceDir: URL?,
        consoleSignIn: ConsoleSignInModel? = nil
    ) {
        self.status = status
        self.cli = cli
        self.instanceDir = instanceDir
        self.consoleSignIn = consoleSignIn ?? ConsoleSignInModel(cli: cli)
    }

    /// Re-point at another install. Everything read-through is dropped rather
    /// than left showing the previous instance's values while the new reads run —
    /// a stale name beside a new path is the one thing this pane must never do.
    public func adopt(cli: MetistryCLI?, instanceDir: URL?) {
        self.cli = cli
        self.instanceDir = instanceDir
        identity = nil
        identityPhase = .idle
        identityCommand = nil
        versions = nil
        versionsPhase = .idle
        versionsCommand = nil
        secrets = []
        secretsPhase = .idle
        secretsCommand = nil
    }

    // MARK: - Instance

    /// `metistry identity --json`.
    public func refreshIdentity() async {
        guard let cli else {
            identityPhase = .unavailable(CLIReadError.noRuntime.localizedDescription ?? "no runtime")
            return
        }
        identityCommand = cli.plannedArguments(for: ["identity", "--json"]).joined(separator: " ")
        identityPhase = .reading
        switch await cli.identity() {
        case .success(let value):
            identity = value
            identityPhase = .read
        case .failure(let error):
            identity = nil
            identityPhase = .unavailable(error.localizedDescription ?? "unavailable")
        }
    }

    /// `metistry version --json` — the product, the runtime pack, and the
    /// instance's pin, in one read.
    public func refreshVersions() async {
        guard let cli else {
            versionsPhase = .unavailable(CLIReadError.noRuntime.localizedDescription ?? "no runtime")
            return
        }
        versionsCommand = cli.plannedArguments(for: ["version", "--json"]).joined(separator: " ")
        versionsPhase = .reading
        switch await cli.versions() {
        case .success(let value):
            versions = value
            versionsPhase = .read
        case .failure(let error):
            versions = nil
            versionsPhase = .unavailable(error.localizedDescription ?? "unavailable")
        }
    }

    /// The instance's pin, from the same read. `metistry.lock` is not opened by
    /// this app any more.
    public var pin: InstancePin? { versions?.lock }

    /// What the Instance pane prints for the assistant's name. `identity.yaml`
    /// is the only place it lives and `metistry identity` is the only route to
    /// it, so a read that failed says so rather than falling back to a default
    /// that would be a second definition of the name.
    public var assistantNameDisplay: String {
        identity?.assistantName ?? "unknown"
    }

    /// The instance id, and what it is for. `metistry init` mints a v4 UUID into
    /// `identity.yaml`; it is the Keychain account this instance's own secrets
    /// are filed under, which is what makes several instances on one Mac
    /// self-contained (docs/product/desktop-app-plan.md).
    public static let instanceIdNote =
        "The instance id is the v4 UUID `metistry init` minted into identity.yaml. It is this directory's stable identity "
        + "and the login-Keychain account its instance-scoped secrets are filed under, which is what keeps several "
        + "instances on one Mac from reading each other's."

    // MARK: - Secrets

    /// `metistry secrets list --json` — names and scope. Values are not
    /// requested, not returned by the verb, and could not be rendered if they
    /// were.
    public func refreshSecrets() async {
        guard let cli else {
            secretsPhase = .unavailable(CLIReadError.noRuntime.localizedDescription ?? "no runtime")
            return
        }
        secretsCommand = cli.plannedArguments(for: ["secrets", "list", "--json"]).joined(separator: " ")
        secretsPhase = .reading
        switch await cli.secretsList() {
        case .success(let rows):
            secrets = rows
            secretsPhase = rows.isEmpty
                ? .unavailable("`metistry secrets list --json` named nothing — this install has no .env yet, or no secret-shaped variables in it")
                : .read
        case .failure(let error):
            secrets = []
            secretsPhase = .unavailable(error.localizedDescription ?? "unavailable")
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

    /// What the Connections pane says about the console's door, under the
    /// sign-in state itself. The decision, in one paragraph, because "why does
    /// this Mac not need a passkey?" is the question the row provokes.
    public static let consoleSignInNote =
        "This Mac authenticates to the LOCAL console implicitly: the app and the `metistry` command are the same package on the "
        + "same machine, so the console accepts \(ConsoleSignIn.tokenVariable) as the `user` principal — the same principal a "
        + "passkey session yields — but only over a connection from this machine (docs/ops/auth.md). The app never reads the "
        + "token: `metistry console whoami --json` resolves it, presents it, and prints the answer, and there is no field on "
        + "this pane that could hold a value. Passkeys are unchanged, and are what a browser or a phone enrols."
}

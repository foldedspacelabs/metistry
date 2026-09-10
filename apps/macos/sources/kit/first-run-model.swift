// First run: the seven steps from docs/product/desktop-app-plan.md, each one a
// `metistry` verb the app runs with a progress view.
//
// Steps 1–5 are real here. 6 (passkey) and 7 (Claude token) are labelled "not
// yet" on screen and do nothing — the plan's sequencing is what they are
// waiting on, and a screen that pretends to enrol a passkey is worse than one
// that says it cannot.
//
// What this file must never grow: a second implementation of a step. If the app
// needs a behaviour the CLI does not have, the CLI gets it first and the app
// calls it (plan §4.20 — adapters adapt one service).

import Foundation
import Observation

public enum FirstRunStep: Int, CaseIterable, Identifiable, Sendable {
    case runtime = 1
    case instance
    case versioning
    case secrets
    case services
    case door
    case claude

    public var id: Int { rawValue }

    public var title: String {
        switch self {
        case .runtime: return "Runtime"
        case .instance: return "Instance"
        case .versioning: return "Versioning"
        case .secrets: return "Secrets"
        case .services: return "Services"
        case .door: return "Door"
        case .claude: return "Claude"
        }
    }

    /// One sentence, sentence case, saying what the step does — design-system
    /// P10 (Title Case names things; sentence case says things).
    public var summary: String {
        switch self {
        case .runtime:
            return "Find the metistry CLI: the copy bundled inside this app, a product checkout you point it at, or one already on your PATH."
        case .instance:
            return "Create the private instance repo — vault, identity, config — and name the assistant. That name lives in identity.yaml and nowhere else."
        case .versioning:
            return "Point the instance repo at a private GitHub repository, with a token the reconciler can push with unattended."
        case .secrets:
            return "Make the login Keychain the canonical secret store, with .env generated from it instead of edited by hand."
        case .services:
            return "Bring the install to running: containers or launchd jobs, then doctor."
        case .door:
            return "Enrol a passkey against the local origin so the console has a door."
        case .claude:
            return "Sign in to Claude and put the token in the Keychain."
        }
    }

    /// The command this step runs, for the screen to show before it runs it.
    /// `nil` for a step that runs nothing.
    public var verb: String? {
        switch self {
        case .runtime: return nil
        case .instance: return "metistry init <folder> --name <assistant name>"
        case .versioning: return "metistry connect-repo <url> --instance <folder> --auth device"
        case .secrets: return "metistry secrets sync"
        case .services: return "metistry up"
        case .door, .claude: return nil
        }
    }

    public var isImplemented: Bool {
        switch self {
        case .runtime, .instance, .versioning, .secrets, .services: return true
        case .door, .claude: return false
        }
    }

    /// Why a "not yet" step is not yet, and what it is waiting on. Shown on the
    /// screen itself so the app is never mysterious about its own gaps.
    public var notYetReason: String? {
        switch self {
        case .door:
            return "Passkey enrolment needs ASAuthorization against the console's local origin, and a `metistry` verb to register the credential — neither exists yet. Today: enrol from the console in a browser (docs/ops/passkeys.md)."
        case .claude:
            return "`claude setup-token` is an interactive terminal flow; driving it from the app needs a pty, and the token needs a `metistry secrets` path of its own. Today: run `claude setup-token` in a terminal, then `metistry secrets mint CLAUDE_CODE_OAUTH_TOKEN`."
        default:
            return nil
        }
    }
}

public enum StepState: Equatable, Sendable {
    case pending
    case running
    /// Finished with exit 0. The string is the last meaningful line the CLI
    /// printed, so the row says what happened rather than just "done".
    case succeeded(String)
    case failed(String)
    case notYet
}

/// GitHub's device-authorization flow, as `metistry connect-repo --auth device`
/// printed it. Parsed out of the stream so the code can be shown large and
/// copyable instead of buried in a log (design-system P4).
public struct DeviceCode: Equatable, Sendable {
    public let verificationURI: String
    public let userCode: String
}

/// Which way `metistry secrets sync` runs. The Keychain is canonical either
/// way; the question is whether this machine's `.env` is the thing being
/// imported or the thing being regenerated (docs/ops/cli.md).
public enum SecretsDirection: String, CaseIterable, Sendable, Identifiable {
    case toKeychain = "keychain"
    case toEnv = "env"

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .toKeychain: return "Import .env into the Keychain"
        case .toEnv: return "Regenerate .env from the Keychain"
        }
    }

    public var detail: String {
        switch self {
        case .toKeychain: return "Right after `metistry init`, whose printed lines you pasted into .env."
        case .toEnv: return "On a machine whose Keychain already holds the secrets."
        }
    }
}

/// Step 2's two shapes. `metistry init` creates an instance repo; adopting an
/// existing folder runs nothing at all — the app just points at it, which is
/// what a second Mac, a restored backup and a cloned instance repo all look
/// like.
public enum InstanceMode: String, CaseIterable, Sendable, Identifiable {
    case create
    case adopt

    public var id: String { rawValue }
}

/// Step 3 is the one step it is genuinely reasonable to defer: local git works
/// with no remote, and the reconciler simply never pushes.
public enum RepoPlan: String, CaseIterable, Sendable, Identifiable {
    case now
    case later

    public var id: String { rawValue }
}

/// `metistry connect-repo --auth device|token|ssh`.
public enum RepoAuth: String, CaseIterable, Sendable, Identifiable {
    case device
    case token
    case ssh

    public var id: String { rawValue }

    /// `--auth token` reads the PAT from stdin, and the app hands every child an
    /// EMPTY stdin on purpose (process-command-runner.swift) so no verb can hang
    /// a progress view waiting for a paste. Driving it would need a pty, which is
    /// the same thing step 7 is waiting on — so the app offers the two modes that
    /// work and says why the third does not, rather than shipping a button that
    /// hangs.
    public var runnableFromTheApp: Bool { self != .token }
}

@MainActor
@Observable
public final class FirstRunModel {
    public private(set) var cli: MetistryCLI?
    public private(set) var resolution: RuntimeResolution

    public private(set) var states: [Int: StepState] = [:]
    public private(set) var output: [Int: [OutputLine]] = [:]
    public private(set) var deviceCode: DeviceCode?
    public var selected: FirstRunStep = .runtime

    // Inputs the steps need. Empty by default: nothing is guessed on the
    // user's behalf, least of all where their vault goes.
    public var instanceDirectory: URL?
    public var assistantName: String = ""
    public var remoteURL: String = ""
    public var secretsDirection: SecretsDirection = .toKeychain
    public var instanceMode: InstanceMode = .create
    public var repoPlan: RepoPlan = .now
    public var repoAuth: RepoAuth = .device
    /// Bridge names (doctor's own — `apple-fm`, `eventkit`) the user asked to
    /// enable. Enabling one means minting its token; see `plannedFollowUps`.
    public var bridgeSelection: Set<String> = []

    public init(cli: MetistryCLI?, resolution: RuntimeResolution) {
        self.cli = cli
        self.resolution = resolution
        reset()
    }

    public func adopt(cli: MetistryCLI?, resolution: RuntimeResolution) {
        self.cli = cli
        self.resolution = resolution
        // Step 1's verdict changes with the runtime; the rest keep whatever
        // they achieved — re-pointing the app at another checkout does not
        // un-create an instance repo.
        states[FirstRunStep.runtime.rawValue] = cli == nil ? .pending : .succeeded(runtimeSummary)
    }

    public func reset() {
        for step in FirstRunStep.allCases {
            states[step.rawValue] = step.isImplemented ? .pending : .notYet
        }
        states[FirstRunStep.runtime.rawValue] = cli == nil ? .pending : .succeeded(runtimeSummary)
    }

    public func state(_ step: FirstRunStep) -> StepState {
        states[step.rawValue] ?? .pending
    }

    public func lines(_ step: FirstRunStep) -> [OutputLine] {
        output[step.rawValue] ?? []
    }

    public var runtimeSummary: String {
        guard let runtime = cli?.runtime else { return "not located" }
        return "\(runtime.source.label): \(runtime.executable.path)"
    }

    /// Whether the step has everything it needs to run. The button is disabled
    /// rather than the command failing with a usage error.
    public func canRun(_ step: FirstRunStep) -> Bool {
        guard step.isImplemented, cli != nil, state(step) != .running else { return false }
        switch step {
        case .runtime: return true
        case .instance: return instanceDirectory != nil && instanceMode == .create
        case .versioning:
            guard repoPlan == .now, repoAuth.runnableFromTheApp else { return false }
            return instanceDirectory != nil && !remoteURL.trimmingCharacters(in: .whitespaces).isEmpty
        case .secrets, .services: return true
        case .door, .claude: return false
        }
    }

    /// Adopting an existing instance folder runs no command: the app points at
    /// it. Recording that as a *result* rather than leaving the step "not
    /// started" is what lets the wizard move on honestly — nothing was done to
    /// the machine, and the row says which folder was adopted.
    public func markAdopted() {
        guard instanceMode == .adopt, let dir = instanceDirectory else { return }
        states[FirstRunStep.instance.rawValue] = .succeeded("using the existing folder \(dir.path)")
    }

    /// The exact argument array a step will run — shown on screen before the
    /// run, so there is never a mystery about what the app did to the machine.
    public func plannedArguments(_ step: FirstRunStep) -> [String]? {
        guard let cli, let verb = verb(for: step) else { return nil }
        return [cli.runtime.executable.path] + cli.arguments(for: verb)
    }

    /// Commands a step runs AFTER its primary verb, each shown on screen before
    /// it runs like everything else. Today there is one case: enabling a bridge
    /// is minting its token, and the token variable follows the convention
    /// `METISTRY_BRIDGE_TOKEN_<NAME>` that `packages/cli/src/doctor.ts` probes
    /// for. The bridge's `METISTRY_<NAME>_URL` and its launchd job come from
    /// `metistry up`, not from here — the step says so.
    public func plannedFollowUps(_ step: FirstRunStep) -> [[String]] {
        guard let cli, step == .secrets else { return [] }
        return bridgeSelection.sorted().map { name in
            [cli.runtime.executable.path] + cli.arguments(for: ["secrets", "mint", Self.bridgeTokenVariable(name)])
        }
    }

    /// `apple-fm` → `METISTRY_BRIDGE_TOKEN_APPLE_FM`.
    public nonisolated static func bridgeTokenVariable(_ bridgeName: String) -> String {
        "METISTRY_BRIDGE_TOKEN_" + bridgeName.uppercased().replacingOccurrences(of: "-", with: "_")
    }

    private func verb(for step: FirstRunStep) -> [String]? {
        switch step {
        case .runtime, .door, .claude:
            return nil
        case .instance:
            guard instanceMode == .create, let dir = instanceDirectory else { return nil }
            var verb = ["init", dir.path]
            let name = assistantName.trimmingCharacters(in: .whitespacesAndNewlines)
            if !name.isEmpty { verb += ["--name", name] }
            return verb
        case .versioning:
            guard repoPlan == .now, let dir = instanceDirectory else { return nil }
            let url = remoteURL.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !url.isEmpty else { return nil }
            return ["connect-repo", url, "--instance", dir.path, "--auth", repoAuth.rawValue]
        case .secrets:
            // `--instance` names which instance directory this is: an instance
            // directory is self-contained, so its `.env` is written to
            // <instance>/state/.env and its secrets are filed under its own
            // instance_id (docs/product/desktop-app-plan.md).
            var verb = ["secrets", "sync", "--to", secretsDirection.rawValue]
            if let dir = instanceDirectory { verb += ["--instance", dir.path] }
            return verb
        case .services:
            // Plain launchd for now. SMAppService (macOS 13+) is the sanctioned
            // way an app installs its own launchd agents — the user approves
            // once in System Settings and there is no plist to edit — and it is
            // the recorded follow-up (docs/product/desktop-app-plan.md, step 5).
            // `metistry up` writing ~/Library/LaunchAgents by hand is what the
            // terminal path does today, so the app does the same and no second
            // implementation appears. `--instance` says which instance's
            // environment, state and Postgres data directory to bring up.
            var verb = ["up"]
            if let dir = instanceDirectory { verb += ["--instance", dir.path] }
            return verb
        }
    }

    public func run(_ step: FirstRunStep) async {
        if step == .runtime {
            // Step 1 runs no command: it re-resolves. The view calls the app
            // model's relocate(), which calls adopt() above.
            return
        }
        guard let cli, let verb = verb(for: step) else { return }
        states[step.rawValue] = .running
        output[step.rawValue] = []
        if step == .versioning { deviceCode = nil }

        let sink = OutputSink()
        do {
            var result = try await cli.run(verb) { line in sink.append(line) }
            output[step.rawValue] = sink.drain()
            if step == .versioning { deviceCode = Self.parseDeviceCode(from: lines(step)) }
            // Follow-ups only run when the primary verb succeeded: minting a
            // bridge token into a .env that `secrets sync` could not write is a
            // half-done step pretending to be a done one.
            if result.ok, step == .secrets {
                for name in bridgeSelection.sorted() {
                    sink.append(OutputLine(stream: .standardOutput, text: ""))
                    let mint = ["secrets", "mint", Self.bridgeTokenVariable(name)]
                    result = try await cli.run(mint) { line in sink.append(line) }
                    output[step.rawValue] = sink.drain()
                    if !result.ok { break }
                }
            }
            let tail = lines(step).last(where: { !$0.text.trimmingCharacters(in: .whitespaces).isEmpty })?.text
            states[step.rawValue] = result.ok
                ? .succeeded(tail ?? "exit 0")
                : .failed(tail ?? "exit \(result.exitCode)")
        } catch {
            output[step.rawValue] = sink.drain()
            states[step.rawValue] = .failed(error.localizedDescription)
        }
    }

    /// `metistry up --dry-run` with `METISTRY_DEPLOYMENT_SHAPE` set — every
    /// command printed, nothing run.
    ///
    /// This is the honest answer to "launchd or compose?". The shape is
    /// `deployment.yaml`'s to state, and `deployment.yaml` is a §4.7 protected
    /// path: only the user's own hand writes it (invariant 2 — anything defining
    /// how the system behaves is a human change), and no `metistry` verb writes
    /// it either. So the wizard explains both shapes, shows what the other one
    /// WOULD do, and leaves the one-line edit to the person. The variable exists
    /// for exactly this preview (`packages/cli/src/deployment.ts`).
    public func previewShape(_ shape: String) async {
        guard let cli else { return }
        let step = FirstRunStep.services
        states[step.rawValue] = .running
        output[step.rawValue] = []
        let sink = OutputSink()
        do {
            let result = try await cli.run(["up", "--dry-run"], environment: ["METISTRY_DEPLOYMENT_SHAPE": shape]) { line in
                sink.append(line)
            }
            output[step.rawValue] = sink.drain()
            states[step.rawValue] = result.ok
                ? .pending  // a preview changed nothing, so the step is still not done
                : .failed("preview of shape \(shape) failed")
        } catch {
            output[step.rawValue] = sink.drain()
            states[step.rawValue] = .failed(error.localizedDescription)
        }
    }

    public func plannedPreviewArguments(shape: String) -> [String]? {
        guard let cli else { return nil }
        return ["METISTRY_DEPLOYMENT_SHAPE=\(shape)", cli.runtime.executable.path]
            + cli.arguments(for: ["up", "--dry-run"])
    }

    /// `metistry connect-repo --auth device` prints
    /// `   Open <uri> and enter this code:   <code>` while it polls
    /// (packages/cli/src/connect-repo.ts). Parsing that line is what lets the
    /// app show the code as a card; if the wording ever changes the log is
    /// still on screen, so the step degrades to readable rather than broken.
    public nonisolated static func parseDeviceCode(from lines: [OutputLine]) -> DeviceCode? {
        let pattern = #/Open\s+(?<uri>\S+)\s+and enter this code:\s+(?<code>\S+)/#
        for line in lines {
            if let match = line.text.firstMatch(of: pattern) {
                return DeviceCode(verificationURI: String(match.uri), userCode: String(match.code))
            }
        }
        return nil
    }
}

/// Collects streamed lines from the runner's `@Sendable` callback, which can be
/// called from any thread, and hands them back on the main actor.
final class OutputSink: @unchecked Sendable {
    private let lock = NSLock()
    private var lines: [OutputLine] = []

    func append(_ line: OutputLine) {
        lock.lock()
        lines.append(line)
        lock.unlock()
    }

    func drain() -> [OutputLine] {
        lock.lock()
        defer { lock.unlock() }
        return lines
    }
}

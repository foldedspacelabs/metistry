// First run: the seven steps from docs/product/desktop-app-plan.md, each one a
// `metistry` verb the app runs with a progress view.
//
// All seven do something now. Step 1 installs the bundle's read-only runtime to
// a writable product dir (`metistry runtime install`); step 5 SETS the
// deployment shape after previewing it (`metistry deployment set-shape --yes`)
// rather than explaining that it cannot; step 7 chooses where the assistant's
// turns run — a provider template, a key straight to the CLI's stdin, and one
// `compute assign default` line — or skips, which is a supported install and
// says so (compute-step.swift).
//
// STEP 6 CHANGED SHAPE on 2026-09-10 (owner decision). It used to be "enrol a
// passkey, or explain at length why this origin cannot host one". It is now
// "your Mac is already signed in; enrol a passkey only for the devices that are
// not this Mac". The app and the CLI are the same package on the same machine,
// so the console takes the local owner token as the `user` principal over
// loopback and there is nothing for a ceremony to add (docs/ops/auth.md). The
// step therefore LEADS with `consoleSignIn` — the same state the Status header
// and Settings → Connections show — and offers the console's enrolment code for
// browsers and the phone. The `ASAuthorization` probe is still real measured
// behaviour and is still reachable, under Settings → Advanced, where a
// diagnostic belongs.
//
// What this file must never grow: a second implementation of a step. If the app
// needs a behaviour the CLI does not have, the CLI gets it first and the app
// calls it (plan §4.20 — adapters adapt one service). Every one of those new
// verbs is somebody else's; this file only knows their names, and degrades to
// "this CLI has no `X` verb yet — update it" against an install that predates
// them (cli-facts.swift).

import Foundation
import Observation

public enum FirstRunStep: Int, CaseIterable, Identifiable, Sendable {
    case runtime = 1
    case instance
    case versioning
    case secrets
    case services
    case door
    case compute

    public var id: Int { rawValue }

    public var title: String {
        switch self {
        case .runtime: return "Runtime"
        case .instance: return "Instance"
        case .versioning: return "Versioning"
        case .secrets: return "Secrets"
        case .services: return "Services"
        case .door: return "Door"
        case .compute: return "Compute"
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
            return "Your Mac is signed in automatically. Enrol a passkey only for browsers and your phone."
        case .compute:
            return "Choose where the assistant's turns run: a cloud provider on your own key, a local server, or nothing yet."
        }
    }

    /// The command this step runs, for the screen to show before it runs it.
    /// `nil` for a step that runs nothing.
    public var verb: String? {
        switch self {
        case .runtime: return "metistry runtime install --from <bundle> --to <product dir>"
        case .instance: return "metistry init <folder> --name <assistant name>"
        case .versioning: return "metistry connect-repo <url> --instance <folder> --auth device"
        case .secrets: return "metistry secrets sync"
        case .services: return "metistry up"
        case .door: return nil
        case .compute: return nil
        }
    }

    /// Steps 6 and 7 do real work, but not by running ONE `metistry` verb: one
    /// talks to `AuthenticationServices` and the console, the other runs two
    /// compute verbs in order and writes a key to the first one's stdin. They
    /// own their own models, so the generic run row does not apply to them.
    public var hasOwnScreen: Bool {
        self == .door || self == .compute
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

/// Step 6's two shapes, since the owner decision of 2026-09-10.
///
/// This Mac needs nothing: the app is the same package as the CLI on the same
/// machine, so the console takes its local owner token as the `user` principal
/// over loopback and no ceremony happens at all (docs/ops/auth.md). A passkey
/// is what a BROWSER or a PHONE needs — including Safari on this same Mac,
/// which presents a different credential than the CLI does.
public enum DoorPlan: String, CaseIterable, Sendable, Identifiable {
    case thisMacOnly
    case otherDevices

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

    /// Steps 6 and 7 own their own models: one talks to `AuthenticationServices`
    /// and the console, the other drives the `metistry compute` verbs. Neither
    /// is a single `metistry` verb, so neither fits the generic run row.
    public let passkey: PasskeyEnrolmentModel
    public let compute: ComputeStepModel
    /// Step 6 now LEADS with this: whether the console already takes this Mac as
    /// the owner. It is the same instance the Status header and Settings →
    /// Connections show, so the wizard cannot disagree with the rest of the app
    /// about who is signed in.
    public let consoleSignIn: ConsoleSignInModel

    /// Called after `metistry runtime install` succeeds, so the app re-resolves
    /// and starts using the writable copy it just wrote. The model does not
    /// relocate itself: which directories are searched is `RuntimeLocator`'s and
    /// `AppModel`'s business, not a step's.
    public var onRuntimeInstalled: () -> Void = {}

    // Inputs the steps need. Empty by default: nothing is guessed on the
    // user's behalf, least of all where their vault goes.
    public var instanceDirectory: URL?
    public var assistantName: String = ""
    public var remoteURL: String = ""
    public var secretsDirection: SecretsDirection = .toKeychain
    public var instanceMode: InstanceMode = .create
    public var repoPlan: RepoPlan = .now
    public var repoAuth: RepoAuth = .device
    /// Step 6's choice. `thisMacOnly` is the default because it is what is
    /// already true: nothing has to happen for this Mac to be signed in.
    public var doorPlan: DoorPlan = .thisMacOnly
    /// Bridge names (doctor's own — `apple-fm`, `eventkit`) the user asked to
    /// enable. Enabling one means minting its token; see `plannedFollowUps`.
    public var bridgeSelection: Set<String> = []

    public init(
        cli: MetistryCLI?,
        resolution: RuntimeResolution,
        passkey: PasskeyEnrolmentModel = PasskeyEnrolmentModel(),
        compute: ComputeStepModel? = nil,
        consoleSignIn: ConsoleSignInModel? = nil
    ) {
        self.cli = cli
        self.resolution = resolution
        self.passkey = passkey
        self.compute = compute ?? ComputeStepModel(cli: cli)
        self.consoleSignIn = consoleSignIn ?? ConsoleSignInModel(cli: cli)
        reset()
    }

    public func adopt(cli: MetistryCLI?, resolution: RuntimeResolution) {
        self.cli = cli
        self.resolution = resolution
        compute.adopt(cli: cli)
        // Step 1's verdict changes with the runtime; the rest keep whatever
        // they achieved — re-pointing the app at another checkout does not
        // un-create an instance repo.
        states[FirstRunStep.runtime.rawValue] = runtimeStepState
    }

    public func reset() {
        for step in FirstRunStep.allCases {
            states[step.rawValue] = .pending
        }
        states[FirstRunStep.runtime.rawValue] = runtimeStepState
    }

    /// Step 1 is done when there is a runtime AND it is the writable one. A
    /// bundled seed runs every verb perfectly well, so this is not `failed` — it
    /// is "there is one more thing to do here", and the step says what and why.
    private var runtimeStepState: StepState {
        guard cli != nil else { return .pending }
        return resolution.needsRuntimeInstall ? .pending : .succeeded(runtimeSummary)
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
        guard !step.hasOwnScreen, cli != nil, state(step) != .running else { return false }
        switch step {
        case .runtime: return resolution.needsRuntimeInstall
        case .instance: return instanceDirectory != nil && instanceMode == .create
        case .versioning:
            guard repoPlan == .now, repoAuth.runnableFromTheApp else { return false }
            return instanceDirectory != nil && !remoteURL.trimmingCharacters(in: .whitespaces).isEmpty
        case .secrets, .services: return true
        case .door, .compute: return false
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
        case .door, .compute:
            return nil
        case .runtime:
            // `metistry runtime install --from <bundle> --to <writable dir>`.
            //
            // The bundle's `Resources/metistry/` is signed and therefore
            // read-only, and `metistry update` in release mode has to write
            // `releases/<version>/` and flip `current`. So the bundle is a SEED
            // and the writable product dir is
            // ~/Library/Application Support/Metistry/product — the first of the
            // two options docs/product/desktop-app-plan.md set out, which is
            // also what its own "Two channels, both signed" paragraph already
            // reads as. The COPY is the CLI's: an app that laid out a release
            // install itself would be a second implementation of `update`.
            guard let seed = resolution.bundledSeed, resolution.needsRuntimeInstall else { return nil }
            return ["runtime", "install", "--from", seed.path, "--to", resolution.installTarget.path]
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
            if CLIDegradation.isUnknownVerb(result) {
                states[step.rawValue] = .failed(CLIDegradation.message(verb: verb.prefix(2).joined(separator: " ")))
                return
            }
            states[step.rawValue] = result.ok
                ? .succeeded(tail ?? "exit 0")
                : .failed(tail ?? "exit \(result.exitCode)")
            // The writable copy exists now, so the app should be using it rather
            // than the read-only seed it just copied.
            if result.ok, step == .runtime { onRuntimeInstalled() }
        } catch {
            output[step.rawValue] = sink.drain()
            states[step.rawValue] = .failed(error.localizedDescription)
        }
    }

    /// `metistry deployment set-shape <shape> --yes`.
    ///
    /// The scaffold could only EXPLAIN the shape: `deployment.yaml` is a §4.7
    /// protected path, and no verb wrote it, so the app previewed the other
    /// shape and left the one-line edit to the person. There is a verb now, and
    /// it keeps the invariant where it belongs — at the tool: `set-shape` is
    /// preview-then-confirm, and `--yes` is the confirmation this screen already
    /// collected by showing the preview first. The app still writes no file.
    public func setShape(_ shape: String) async {
        guard let cli else { return }
        let step = FirstRunStep.services
        states[step.rawValue] = .running
        let sink = OutputSink()
        for line in lines(step) { sink.append(line) }
        sink.append(OutputLine(stream: .standardOutput, text: ""))
        do {
            let result = try await cli.run(setShapeVerb(shape)) { line in sink.append(line) }
            output[step.rawValue] = sink.drain()
            let tail = lines(step).last(where: { !$0.text.trimmingCharacters(in: .whitespaces).isEmpty })?.text
            if CLIDegradation.isUnknownVerb(result) {
                states[step.rawValue] = .failed(CLIDegradation.message(verb: "deployment set-shape"))
            } else {
                // A shape that was set is not an install that is up: the step is
                // done when `metistry up` has run, so success here returns it to
                // pending rather than claiming the step.
                states[step.rawValue] = result.ok ? .pending : .failed(tail ?? "exit \(result.exitCode)")
            }
        } catch {
            output[step.rawValue] = sink.drain()
            states[step.rawValue] = .failed(error.localizedDescription)
        }
    }

    private func setShapeVerb(_ shape: String) -> [String] {
        var verb = ["deployment", "set-shape", shape, "--yes"]
        if let dir = instanceDirectory { verb += ["--instance", dir.path] }
        return verb
    }

    public func plannedSetShapeArguments(shape: String) -> [String]? {
        guard let cli else { return nil }
        return [cli.runtime.executable.path] + cli.arguments(for: setShapeVerb(shape))
    }

    /// `metistry up --dry-run` with `METISTRY_DEPLOYMENT_SHAPE` set — every
    /// command printed, nothing run.
    ///
    /// This is still the FIRST half of "launchd or compose?", and it stays first
    /// now that `deployment set-shape` exists: the preview is what makes the
    /// confirmation `--yes` carries mean something. Choosing a shape changes
    /// where Postgres's data lives and whether Docker is in the picture at all —
    /// a decision worth seeing spelled out as commands before it is taken. The
    /// override variable exists for exactly this (`packages/cli/src/deployment.ts`).
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

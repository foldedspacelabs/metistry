// What the Mac does OUTSIDE the client API, and only this (design-build-plan
// §2.2, §2.16): the CLI verbs of §2.2's eighteen rows, each there because the
// console cannot or must not do it — credentials, the machine, code that
// runs. Everything else goes through a store and the console's gate.
//
// F-7 froze the interface; T5-1 implements it — `CLIManagementRunner`, below —
// over the existing `CommandRunner` (through `MetistryCLI`, so the runtime and
// the instance resolve exactly as every other verb's do: the same executable,
// `--product-dir`, `METISTRY_INSTANCE_DIR`, and an empty stdin unless the
// command carries a value for it).
//
// NOT BEHIND O3. A management verb talks to this Mac — the supervisor's
// socket, the Keychain, the files the CLI owns — never to the console, so it
// does not go through `ReachabilityGate`. Restarting a console that is down is
// exactly when the owner reaches for M5.
//
// THE SET IS CLOSED AT THE TYPE. A `ManagementCommand` is built from a row and
// an argument array, and it refuses — returns nil — unless the arguments
// start with one of that row's verbs. A verb §2.2 does not list is not a
// management command, so no runner can be handed one. Adding a verb is a
// change to this table and to §2.2, never a string someone passes in.

import Foundation

/// §2.2's rows, M1–M18: the action, its verbs, and why it is not a route.
public enum ManagementRow: String, CaseIterable, Sendable, Equatable {
    case install = "M1"
    case update = "M2"
    case deploymentShape = "M3"
    case keepAwake = "M4"
    case services = "M5"
    case doctor = "M6"
    case secrets = "M7"
    case instanceRepository = "M8"
    case connectTool = "M9"
    case identity = "M10"
    case linkedInstances = "M11"
    case agentDefinitions = "M12"
    case connections = "M13"
    case variables = "M14"
    case extensions = "M15"
    case computeProviders = "M16"
    case localModels = "M17"
    case vaultGit = "M18"

    /// The verbs, as argument prefixes after `metistry` — §2.2's table, word for word.
    public var verbs: [[String]] {
        switch self {
        case .install: return [["init"], ["runtime", "install"], ["up"], ["down"], ["migrate-shape"], ["migrate-layout"], ["migrate-inbox"]]
        case .update: return [["update"]]
        case .deploymentShape: return [["deployment", "set-shape"]]
        case .keepAwake: return [["deployment", "set-keep-awake"]]
        case .services: return [["restart"], ["stop"], ["start"], ["logs"]]
        case .doctor: return [["doctor"]]
        case .secrets: return ["set", "replace", "remove", "hosts", "grant", "migrate-scope", "purge-shared"].map { ["secrets", $0] }
        case .instanceRepository: return [["connect-repo"]]
        case .connectTool: return [["connect"]]
        case .identity: return [["identity", "set"]]
        case .linkedInstances: return ["add", "remove", "refresh"].map { ["instances", $0] }
        case .agentDefinitions: return [["agents", "define"]]
        // `authorize` is T4-10's sign-in door for an OAuth connection (docs/ops/cli.md), used by T6-13b's editor
        case .connections: return ["add", "set", "remove", "policy", "test", "authorize"].map { ["connections", $0] }
        case .variables: return ["set", "unset"].map { ["variables", $0] }
        case .extensions: return ["add", "remove", "list"].map { ["extensions", $0] }
        case .computeProviders: return ["add", "remove", "set"].map { ["compute", "providers", $0] }
        case .localModels: return ["install", "load", "unload"].map { ["compute", "models", $0] }
        case .vaultGit: return [["vault", "settings"], ["vault", "rollback"]]
        }
    }

    /// Why the console does not do it (§2.2's last column).
    public var whyNotTheAPI: String {
        switch self {
        case .install: return "the console is not running yet, or is what is being installed"
        case .update: return "replaces the console itself"
        case .deploymentShape: return "moves the data between shapes"
        case .keepAwake: return "a machine setting; the lid dialog never runs a command"
        case .services: return "the supervisor's local socket; a remote stop locks the owner out"
        case .doctor: return "local probes: launchd, containers, TCC"
        case .secrets: return "the login Keychain; a value never crosses the API"
        case .instanceRepository: return "git remote and credentials"
        case .connectTool: return "writes the tool's own config files"
        case .identity: return ".metistry/identity.yaml"
        case .linkedInstances: return "a trust relationship with another origin"
        case .agentDefinitions: return ".metistry/agents/** — how an actor behaves"
        case .connections: return ".metistry/connections/** — hosts, commands, credentials, tool modes, the offer switch"
        case .variables: return ".metistry/variables.yaml — text agents read"
        case .extensions: return ".metistry/extensions/** — what the product loads"
        case .computeProviders: return "keys and base URLs — where prompts go"
        case .localModels: return "this Mac's disk and memory"
        case .vaultGit: return "the repository's history and its remote; a rollback still waits for Approve in Needs You"
        }
    }
}

/// One management verb, ready to run: its row, the arguments after
/// `metistry`, and — the one way a value avoids argv — its standard input
/// (a pasted key goes there, never on a command line).
public struct ManagementCommand: Sendable, Equatable {
    public let row: ManagementRow
    public let arguments: [String]
    public let standardInput: String?

    /// Nil unless `arguments` begin with one of the row's verbs — and nil for
    /// a `--product-dir` among them: which product runs a verb is the runtime
    /// locator's answer (runtime-locator.swift), appended by the runner, and a
    /// command that named its own would be a second answer to that question.
    public init?(_ row: ManagementRow, _ arguments: [String], standardInput: String? = nil) {
        guard row.verbs.contains(where: { arguments.starts(with: $0) }) else { return nil }
        guard !arguments.contains(where: { $0 == Self.productDirFlag || $0.hasPrefix(Self.productDirFlag + "=") }) else { return nil }
        self.row = row
        self.arguments = arguments
        self.standardInput = standardInput
    }

    static let productDirFlag = "--product-dir"
}

/// Runs §2.2's verbs, and nothing else — a `ManagementCommand` cannot hold any other.
public protocol ManagementRunner: Sendable {
    /// The exact argument array `run` executes, for the view that shows it
    /// BEFORE anything runs (preview, then confirm).
    func plannedArguments(_ command: ManagementCommand) -> [String]
    /// Streams the CLI's own lines as they arrive, and returns its exit and
    /// both streams. Throws only when the process could not be started.
    func run(_ command: ManagementCommand, onOutput: @escaping @Sendable (OutputLine) -> Void) async throws -> CommandResult
}

// MARK: - Over this install's CLI

/// `ManagementRunner` as the Mac runs it: each command is one `metistry`
/// invocation through `MetistryCLI` — an argument array, never a shell string,
/// and a value (a pasted key) on stdin, never on the command line.
public struct CLIManagementRunner: ManagementRunner {
    public let cli: MetistryCLI

    public init(cli: MetistryCLI) {
        self.cli = cli
    }

    /// `[executable, leading…, verb…, --product-dir, <dir>]` — exactly what
    /// `run` executes. The standard input is not in it, and cannot be.
    public func plannedArguments(_ command: ManagementCommand) -> [String] {
        cli.plannedArguments(for: command.arguments)
    }

    /// The CLI's exit and both streams, handed back whole: a refusal is shown
    /// in the CLI's own words (§3.16), and a CLI older than the verb is
    /// `CLIDegradation.isUnknownVerb(result)`, said once, in cli-facts.swift.
    public func run(_ command: ManagementCommand, onOutput: @escaping @Sendable (OutputLine) -> Void) async throws -> CommandResult {
        try await cli.run(command.arguments, standardInput: command.standardInput, onOutput: onOutput)
    }
}

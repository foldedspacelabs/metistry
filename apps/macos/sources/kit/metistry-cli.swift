// The `metistry` verbs the app drives, and the only place the app names one.
//
// Every method here is one CLI invocation with an argument array. There is no
// second implementation of anything: `init`, `connect-repo`, `secrets sync`,
// `up` and `doctor` are the same commands the terminal runs, so the
// open-source path and the app path share one tested code path
// (docs/product/desktop-app-plan.md; plan §4.20).

import Foundation

public struct MetistryCLI: Sendable {
    public let runtime: MetistryRuntime
    /// The instance the app is pointed at, or nil before one is chosen.
    ///
    /// It reaches every verb as `METISTRY_INSTANCE_DIR` rather than as a flag,
    /// because only `connect-repo` takes `--instance`; `deployment.ts`,
    /// `up` and the reconciler all read the variable. The CLI's `.env` loader
    /// fills gaps only (`packages/cli/src/env.ts`: `if (env[k] === undefined)`),
    /// so an inherited value WINS over the product checkout's `.env` — which is
    /// exactly what "the active instance directory" has to mean, and why
    /// Settings → Instance prints the variable it is setting.
    public let instanceDir: URL?
    private let runner: any CommandRunner

    public init(runtime: MetistryRuntime, runner: any CommandRunner, instanceDir: URL? = nil) {
        self.runtime = runtime
        self.runner = runner
        self.instanceDir = instanceDir
    }

    /// The environment every invocation starts from.
    public var baseEnvironment: [String: String] {
        guard let instanceDir else { return [:] }
        return ["METISTRY_INSTANCE_DIR": instanceDir.path]
    }

    /// The arguments an invocation actually gets: the CLI entry point (when the
    /// executable is `node`), the verb, then `--product-dir` so the app is never
    /// relying on the working directory a GUI process happens to have.
    public func arguments(for verb: [String], includeProductDir: Bool = true) -> [String] {
        var args = runtime.leadingArguments + verb
        if includeProductDir, let dir = runtime.productDir {
            args += ["--product-dir", dir.path]
        }
        return args
    }

    @discardableResult
    public func run(
        _ verb: [String],
        includeProductDir: Bool = true,
        environment: [String: String] = [:],
        onOutput: @escaping @Sendable (OutputLine) -> Void = { _ in }
    ) async throws -> CommandResult {
        try await runner.run(
            executable: runtime.executable,
            arguments: arguments(for: verb, includeProductDir: includeProductDir),
            environment: baseEnvironment.merging(environment) { _, override in override },
            currentDirectory: runtime.productDir,
            onOutput: onOutput
        )
    }

    /// `metistry doctor --json`.
    ///
    /// Exit code 1 means "something is `failed`", not "the command broke"
    /// (docs/ops/cli.md), and the report is on stdout either way — so the JSON
    /// is parsed first and the exit code is only consulted when there is no
    /// report to show.
    public func doctor(onOutput: @escaping @Sendable (OutputLine) -> Void = { _ in }) async throws -> DoctorReport {
        let result = try await run(["doctor", "--json"], onOutput: onOutput)
        guard let data = result.stdout.data(using: .utf8), !data.isEmpty else {
            throw DoctorError.noOutput(exitCode: result.exitCode, stderr: result.stderr)
        }
        do {
            return try DoctorReport.decode(from: data)
        } catch {
            throw DoctorError.undecodable(underlying: error, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr)
        }
    }

    // MARK: - The read verbs

    /// One JSON-printing read verb, run and decoded, with the CLI's own answer
    /// for "I do not have that verb" turned into the app's one sentence about it
    /// (cli-facts.swift). Every read below is this function plus a decoder, so
    /// there is one place that decides what a stale CLI looks like on screen.
    private func read<T: Sendable>(
        _ verb: [String],
        naming name: String,
        decode: @Sendable (JSONValue) -> T?
    ) async -> Result<T, CLIReadError> {
        let result: CommandResult
        do {
            result = try await run(verb)
        } catch {
            return .failure(.failed(verb: name, detail: error.localizedDescription))
        }
        if CLIDegradation.isUnknownVerb(result) { return .failure(.noSuchVerb(name)) }
        guard let data = result.stdout.data(using: .utf8), !data.isEmpty else {
            let detail = result.stderr.split(separator: "\n").last.map(String.init) ?? "exit \(result.exitCode), no output"
            return .failure(result.ok ? .undecodable(verb: name, detail: "it printed nothing") : .failed(verb: name, detail: detail))
        }
        guard let json = try? JSONValue.parse(data) else {
            return .failure(.undecodable(verb: name, detail: "not JSON: \(String(result.stdout.prefix(200)))"))
        }
        guard let value = decode(json) else {
            let detail = result.ok
                ? "the JSON did not carry the fields this pane needs"
                : (result.stderr.split(separator: "\n").last.map(String.init) ?? "exit \(result.exitCode)")
            return .failure(result.ok ? .undecodable(verb: name, detail: detail) : .failed(verb: name, detail: detail))
        }
        return .success(value)
    }

    /// `metistry identity --json` — the instance's id and the assistant's name.
    /// Replaces the scaffold's YAML scalar reader over `identity.yaml`.
    public func identity() async -> Result<InstanceIdentity, CLIReadError> {
        await read(["identity", "--json"], naming: "identity") { json in
            let identity = InstanceIdentity(json: json)
            return identity.isEmpty ? nil : identity
        }
    }

    /// `metistry version --json` — product, runtime and the instance's pin.
    /// Replaces the scaffold's `package.json` read and its `metistry.lock`
    /// reader in one go.
    public func versions() async -> Result<VersionFacts, CLIReadError> {
        await read(["version", "--json"], naming: "version") { json in
            let facts = VersionFacts(json: json)
            return facts.isEmpty ? nil : facts
        }
    }

    /// `metistry secrets list --json` — names and scope. Values are not
    /// requested, not returned by the verb, and could not be rendered if they
    /// were.
    public func secretsList() async -> Result<[SecretListing], CLIReadError> {
        await read(["secrets", "list", "--json"], naming: "secrets list") { SecretListing.decode($0) }
    }

    /// `metistry deployment --json` — the resolved shape and the file it came
    /// from, without doctor's full sweep.
    public func deployment() async -> Result<DeploymentShapeFacts, CLIReadError> {
        await read(["deployment", "--json"], naming: "deployment") { DeploymentShapeFacts(json: $0) }
    }

    /// The argument array a read verb runs, for the screen that shows it.
    public func plannedArguments(for verb: [String]) -> [String] {
        [runtime.executable.path] + arguments(for: verb)
    }

    public enum DoctorError: LocalizedError {
        case noOutput(exitCode: Int32, stderr: String)
        case undecodable(underlying: any Error, exitCode: Int32, stdout: String, stderr: String)

        public var errorDescription: String? {
            switch self {
            case .noOutput(let code, let stderr):
                let detail = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
                return "`metistry doctor --json` printed nothing (exit \(code))\(detail.isEmpty ? "" : ": \(detail)")"
            case .undecodable(let underlying, let code, _, let stderr):
                let detail = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
                return "could not read the doctor report (exit \(code)): \(underlying.localizedDescription)\(detail.isEmpty ? "" : " — \(detail)")"
            }
        }
    }
}

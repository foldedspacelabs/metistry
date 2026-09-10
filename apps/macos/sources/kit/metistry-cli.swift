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
    private let runner: any CommandRunner

    public init(runtime: MetistryRuntime, runner: any CommandRunner) {
        self.runtime = runtime
        self.runner = runner
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
            environment: environment,
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

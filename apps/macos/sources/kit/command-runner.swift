// The one seam between the app and the CLI.
//
// Everything the app does to an install it does by running a `metistry` verb
// (docs/product/desktop-app-plan.md: "the app is a front end for the CLI,
// never a second implementation"). That is a single protocol so the view
// models can be exercised without spawning anything, and so the iOS target —
// which has no `Process` at all — can supply the management-API implementation
// instead of a subprocess one without touching a view.
//
// Arguments are always an array. Nothing is interpolated into a shell string,
// which is the same rule the CLI holds itself to (`packages/cli/src/exec.ts`).

import Foundation

public struct CommandResult: Sendable, Equatable {
    public let exitCode: Int32
    public let stdout: String
    public let stderr: String

    public var ok: Bool { exitCode == 0 }

    public init(exitCode: Int32, stdout: String, stderr: String) {
        self.exitCode = exitCode
        self.stdout = stdout
        self.stderr = stderr
    }
}

/// A line of output as it arrived, tagged with which stream it came from, so
/// a progress view can show the CLI's own words rather than a spinner and a
/// guess (design-system P4 — refusals are explained where they happen).
public struct OutputLine: Sendable, Equatable, Identifiable {
    public enum Stream: Sendable, Equatable { case standardOutput, standardError }

    public let id = UUID()
    public let stream: Stream
    public let text: String

    public init(stream: Stream, text: String) {
        self.stream = stream
        self.text = text
    }
}

public protocol CommandRunner: Sendable {
    /// Run `executable` with `arguments`, streaming output lines to `onOutput`
    /// as they arrive, and return the exit code with the full captured streams.
    /// Throws only when the process could not be started at all.
    func run(
        executable: URL,
        arguments: [String],
        environment: [String: String],
        currentDirectory: URL?,
        onOutput: @escaping @Sendable (OutputLine) -> Void
    ) async throws -> CommandResult
}

public enum CommandRunnerError: LocalizedError {
    case notExecutable(URL)
    case launchFailed(URL, underlying: String)
    case unsupportedPlatform

    public var errorDescription: String? {
        switch self {
        case .notExecutable(let url):
            return "\(url.path) is not an executable file"
        case .launchFailed(let url, let underlying):
            return "could not start \(url.path): \(underlying)"
        case .unsupportedPlatform:
            return "this platform cannot run a subprocess — the app talks to the management API instead"
        }
    }
}

// The macOS implementation of MetistryKit's CommandRunner: `Process`.
//
// It lives in the executable target, not in the kit, because `Process` does not
// exist on iOS — that target will supply a management-API runner against the
// same protocol instead.
//
// Environment: a GUI process inherits almost nothing, so the child gets an
// explicit environment rather than whatever launchd handed the app. PATH is
// seeded with the directories a bundled runtime and a Homebrew install live in,
// because `metistry up` and `connect-repo` both spawn `git` and `node`.

import Foundation
import MetistryKit

struct ProcessCommandRunner: CommandRunner {
    /// Directories prepended to the child's PATH, ahead of whatever we inherit.
    let extraPathDirectories: [String]

    init(extraPathDirectories: [String] = []) {
        self.extraPathDirectories = extraPathDirectories
    }

    func run(
        executable: URL,
        arguments: [String],
        environment: [String: String],
        currentDirectory: URL?,
        onOutput: @escaping @Sendable (OutputLine) -> Void
    ) async throws -> CommandResult {
        guard FileManager.default.isExecutableFile(atPath: executable.path) else {
            throw CommandRunnerError.notExecutable(executable)
        }

        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        if let currentDirectory { process.currentDirectoryURL = currentDirectory }
        process.environment = childEnvironment(executable: executable, overrides: environment)

        let out = Pipe()
        let err = Pipe()
        process.standardOutput = out
        process.standardError = err
        // Nothing here is interactive. Handing the child an empty stdin means a
        // verb that would otherwise wait for a paste (`connect-repo --auth
        // token`) fails fast instead of hanging a progress view forever.
        process.standardInput = Pipe()

        let collector = StreamCollector(onOutput: onOutput)
        out.fileHandleForReading.readabilityHandler = { handle in
            collector.consume(handle.availableData, from: .standardOutput)
        }
        err.fileHandleForReading.readabilityHandler = { handle in
            collector.consume(handle.availableData, from: .standardError)
        }

        do {
            try process.run()
        } catch {
            out.fileHandleForReading.readabilityHandler = nil
            err.fileHandleForReading.readabilityHandler = nil
            throw CommandRunnerError.launchFailed(executable, underlying: error.localizedDescription)
        }

        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            process.terminationHandler = { _ in continuation.resume() }
        }

        out.fileHandleForReading.readabilityHandler = nil
        err.fileHandleForReading.readabilityHandler = nil
        // Whatever the handlers had not been called for yet.
        collector.consume(out.fileHandleForReading.readDataToEndOfFile(), from: .standardOutput)
        collector.consume(err.fileHandleForReading.readDataToEndOfFile(), from: .standardError)
        collector.flush()

        return CommandResult(
            exitCode: process.terminationStatus,
            stdout: collector.text(.standardOutput),
            stderr: collector.text(.standardError)
        )
    }

    private func childEnvironment(executable: URL, overrides: [String: String]) -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        var dirs = extraPathDirectories
        // A bundled `node` brings its own `npm`/`npx` beside it, and the
        // reconciler wants the bundled `git` on PATH ahead of anything else
        // (docs/ops/bundled-runtime.md).
        dirs.append(executable.deletingLastPathComponent().path)
        let inherited = env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        var seen = Set<String>()
        env["PATH"] = (dirs + inherited.split(separator: ":").map(String.init))
            .filter { !$0.isEmpty && seen.insert($0).inserted }
            .joined(separator: ":")
        for (key, value) in overrides { env[key] = value }
        return env
    }
}

/// Splits the two streams into lines as they arrive and keeps the full text.
/// `readabilityHandler` fires on an arbitrary queue, so every field is behind a
/// lock.
private final class StreamCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var partial: [OutputLine.Stream: String] = [:]
    private var full: [OutputLine.Stream: String] = [:]
    private let onOutput: @Sendable (OutputLine) -> Void

    init(onOutput: @escaping @Sendable (OutputLine) -> Void) {
        self.onOutput = onOutput
    }

    func consume(_ data: Data, from stream: OutputLine.Stream) {
        guard !data.isEmpty, let chunk = String(data: data, encoding: .utf8) else { return }
        var emit: [String] = []
        lock.lock()
        full[stream, default: ""] += chunk
        var buffer = (partial[stream] ?? "") + chunk
        while let newline = buffer.firstIndex(of: "\n") {
            emit.append(String(buffer[buffer.startIndex..<newline]))
            buffer = String(buffer[buffer.index(after: newline)...])
        }
        partial[stream] = buffer
        lock.unlock()
        for line in emit { onOutput(OutputLine(stream: stream, text: line)) }
    }

    /// Emit anything left without a trailing newline — a prompt, or the last
    /// line of a command that did not end cleanly.
    func flush() {
        var emit: [(OutputLine.Stream, String)] = []
        lock.lock()
        for (stream, rest) in partial where !rest.isEmpty {
            emit.append((stream, rest))
            partial[stream] = ""
        }
        lock.unlock()
        for (stream, text) in emit { onOutput(OutputLine(stream: stream, text: text)) }
    }

    func text(_ stream: OutputLine.Stream) -> String {
        lock.lock()
        defer { lock.unlock() }
        return full[stream] ?? ""
    }
}

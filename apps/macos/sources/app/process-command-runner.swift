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
        standardInput: String?,
        onOutput: @escaping @Sendable (OutputLine) -> Void
    ) async throws -> CommandResult {
        try await run(
            executable: executable, arguments: arguments, environment: environment,
            currentDirectory: currentDirectory, standardInput: standardInput,
            terminateOnCancel: false, onOutput: onOutput
        )
    }

    func run(
        executable: URL,
        arguments: [String],
        environment: [String: String],
        currentDirectory: URL?,
        standardInput: String?,
        terminateOnCancel: Bool,
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
        //
        // The exception is a verb whose whole design is "read the value on
        // stdin so it is never in argv" (`compute providers add`). It is
        // written and the pipe is closed at once — the child gets one value
        // and EOF, never a prompt it can sit at.
        let stdin = Pipe()
        process.standardInput = stdin

        let collector = StreamCollector(onOutput: onOutput)
        out.fileHandleForReading.readabilityHandler = { handle in
            collector.consume(handle.availableData, from: .standardOutput)
        }
        err.fileHandleForReading.readabilityHandler = { handle in
            collector.consume(handle.availableData, from: .standardError)
        }

        // The exit is recorded before the child exists, so an exit that lands
        // before anyone is waiting for it (a task already cancelled, a child
        // that ends at once) is remembered rather than missed.
        let exited = ExitSignal()
        process.terminationHandler = { _ in exited.fire() }

        do {
            try process.run()
        } catch {
            out.fileHandleForReading.readabilityHandler = nil
            err.fileHandleForReading.readabilityHandler = nil
            throw CommandRunnerError.launchFailed(executable, underlying: error.localizedDescription)
        }
        if let standardInput, let data = standardInput.data(using: .utf8) {
            try? stdin.fileHandleForWriting.write(contentsOf: data)
        }
        try? stdin.fileHandleForWriting.close()

        // Only a caller that asked (`terminateOnCancel`: the Compute pane's
        // Cancel Download) has its child ended when its task is cancelled —
        // SIGTERM, then the same exit path as any other termination. Every
        // other caller's verb runs to completion however its task ends.
        await withTaskCancellationHandler {
            await exited.wait()
        } onCancel: {
            if terminateOnCancel, process.isRunning { process.terminate() }
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

/// "The child has exited", set once and awaitable any number of times, in
/// either order: `fire()` before `wait()` is remembered.
private final class ExitSignal: @unchecked Sendable {
    private let lock = NSLock()
    private var fired = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func fire() {
        let pending: [CheckedContinuation<Void, Never>] = lock.withLock {
            fired = true
            defer { waiters.removeAll() }
            return waiters
        }
        for waiter in pending { waiter.resume() }
    }

    func wait() async {
        await withCheckedContinuation { (waiter: CheckedContinuation<Void, Never>) in
            let done = lock.withLock { () -> Bool in
                if fired { return true }
                waiters.append(waiter)
                return false
            }
            if done { waiter.resume() }
        }
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

// MARK: - A long-lived child: `metistry console session --stdio` (F-12)

extension ProcessCommandRunner: SessionSpawner {
    /// Start a child that stays up, with the same environment and PATH a
    /// one-shot gets. Unlike `run`, stdin stays open — it is the request
    /// channel — and stdout is handed over line by line as it arrives.
    func spawn(executable: URL, arguments: [String], environment: [String: String], currentDirectory: URL?) throws -> any SessionProcess {
        guard FileManager.default.isExecutableFile(atPath: executable.path) else {
            throw CommandRunnerError.notExecutable(executable)
        }
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        if let currentDirectory { process.currentDirectoryURL = currentDirectory }
        process.environment = childEnvironment(executable: executable, overrides: environment)
        let child = ProcessSession(process: process)
        do {
            try process.run()
        } catch {
            child.detach()
            throw CommandRunnerError.launchFailed(executable, underlying: error.localizedDescription)
        }
        return child
    }
}

/// `Process` as a `SessionProcess`. Every mutable field is behind a lock:
/// the pipes' handlers and the termination handler fire on arbitrary queues.
private final class ProcessSession: SessionProcess, @unchecked Sendable {
    let lines: AsyncStream<String>
    private let process: Process
    private let stdin = Pipe()
    private let stdout = Pipe()
    private let stderr = Pipe()
    private let continuation: AsyncStream<String>.Continuation
    private let lock = NSLock()
    private var partial = Data()
    private var errText = ""
    private var ended: CommandResult?
    private var waiters: [CheckedContinuation<CommandResult, Never>] = []

    init(process: Process) {
        self.process = process
        (lines, continuation) = AsyncStream<String>.makeStream()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stderr
        // A write to a child that has died must be an error to report, not a
        // SIGPIPE that takes the app down with it.
        _ = fcntl(stdin.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1)
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                self?.finishLines()
            } else {
                self?.consume(data)
            }
        }
        stderr.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            self?.lock.withLock { self?.errText += String(decoding: data, as: UTF8.self) }
        }
        process.terminationHandler = { [weak self] process in
            self?.exited(process.terminationStatus)
        }
    }

    func send(_ line: String) throws {
        try stdin.fileHandleForWriting.write(contentsOf: Data((line + "\n").utf8))
    }

    func terminate() {
        if process.isRunning { process.terminate() }
    }

    func termination() async -> CommandResult {
        await withCheckedContinuation { waiter in
            let done: CommandResult? = lock.withLock {
                if let ended { return ended }
                waiters.append(waiter)
                return nil
            }
            if let done { waiter.resume(returning: done) }
        }
    }

    /// The process never started: nothing will ever arrive.
    func detach() {
        stdout.fileHandleForReading.readabilityHandler = nil
        stderr.fileHandleForReading.readabilityHandler = nil
        continuation.finish()
        exited(-1)
    }

    private func consume(_ data: Data) {
        var emit: [String] = []
        lock.withLock {
            partial.append(data)
            while let newline = partial.firstIndex(of: 0x0A) {
                emit.append(String(decoding: partial[partial.startIndex..<newline], as: UTF8.self))
                partial.removeSubrange(partial.startIndex...newline)
            }
        }
        for line in emit { continuation.yield(line) }
    }

    private func finishLines() {
        let rest: String? = lock.withLock {
            defer { partial.removeAll() }
            return partial.isEmpty ? nil : String(decoding: partial, as: UTF8.self)
        }
        if let rest { continuation.yield(rest) }
        continuation.finish()
    }

    private func exited(_ status: Int32) {
        // stderr may still hold bytes its handler has not been called for.
        stderr.fileHandleForReading.readabilityHandler = nil
        let tail = (try? stderr.fileHandleForReading.readToEnd()).flatMap { $0 }.map { String(decoding: $0, as: UTF8.self) } ?? ""
        let waiting: [CheckedContinuation<CommandResult, Never>] = lock.withLock {
            if ended != nil { return [] }
            errText += tail
            ended = CommandResult(exitCode: status, stdout: "", stderr: errText)
            defer { waiters.removeAll() }
            return waiters
        }
        guard let result = lock.withLock({ ended }) else { return }
        for waiter in waiting { waiter.resume(returning: result) }
    }
}

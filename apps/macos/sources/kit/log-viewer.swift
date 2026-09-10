// "View Log" — `metistry logs <component> --lines 200`, shown in a window.
//
// The app does not know where a component's log file is, and deliberately: the
// path is a property of the shape the component runs in (a launchd job's
// StandardOutPath, a container's docker log, a future journald unit), and
// `metistry logs` is the one place that resolves it. An app that opened
// `/tmp/metistry-<name>.log` itself would be a second implementation of that
// resolution and would be wrong the first time a shape changed.

import Foundation
import Observation

@MainActor
@Observable
public final class LogViewerModel {
    public enum Phase: Equatable, Sendable {
        case idle
        case loading
        case loaded
        case unavailable(String)
    }

    /// How many lines "View Log" asks for. Enough to see what a service said as
    /// it fell over, small enough to render without a virtualised list.
    public static let defaultLineCount = 200

    public var cli: MetistryCLI?
    public private(set) var component: String?
    public private(set) var lines: [OutputLine] = []
    public private(set) var phase: Phase = .idle
    /// The exact command, shown above the output — the same promise every other
    /// screen in this app makes.
    public private(set) var command: String?
    public private(set) var loadedAt: Date?

    public init(cli: MetistryCLI?) {
        self.cli = cli
    }

    public var isLoading: Bool { phase == .loading }

    public func load(component: String, lineCount: Int = LogViewerModel.defaultLineCount) async {
        self.component = component
        guard let cli else {
            phase = .unavailable("no metistry runtime located — choose an instance in Settings")
            return
        }
        let verb = ["logs", component, "--lines", String(lineCount)]
        command = ([cli.runtime.executable.path] + cli.arguments(for: verb)).joined(separator: " ")
        phase = .loading
        lines = []
        let sink = OutputSink()
        do {
            let result = try await cli.run(verb) { line in sink.append(line) }
            lines = sink.drain()
            loadedAt = Date()
            if MenuBarModel.isUnknownVerb(result) {
                phase = .unavailable("this CLI has no `logs` verb yet — update it (metistry update, or Check for Updates…)")
            } else if result.ok || !lines.isEmpty {
                // A non-zero exit with output still has something to read: a
                // service that is down is exactly when its log matters.
                phase = .loaded
            } else {
                phase = .unavailable(result.stderr.isEmpty ? "exit \(result.exitCode), no output" : result.stderr)
            }
        } catch {
            lines = sink.drain()
            phase = .unavailable(error.localizedDescription)
        }
    }

    public func reload() async {
        guard let component else { return }
        await load(component: component)
    }
}

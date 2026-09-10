// The menu-bar item's state and its actions.
//
// The glyph is the worst fault across components (StatusModel.menuBarState).
// The menu lists every component grouped by doctor's own `kind`, and each one
// offers Restart · Stop · Start · View Log — every one of them a `metistry`
// verb, never a `launchctl` or a `docker` this app runs itself. That is the same
// rule as everywhere else: the app is a front end for the CLI, and when the CLI
// lacks a verb the app says so instead of growing a second implementation.
//
// REFRESH. Doctor is re-run when the menu opens and every 30s while it stays
// open. `doctor --json` is a full sweep — it probes every bridge over HTTP and
// runs `docker compose ps` — so it is far too heavy to poll continuously; the
// watchdog already keeps a liveness view of the same components, and its feed is
// the intended faster source once the app has a read path to it (a management
// API query, not a database connection — invariant 3). Until then: on open, and
// every 30s while open.

import Foundation
import Observation

@MainActor
@Observable
public final class MenuBarModel {
    /// The lifecycle verbs. `metistry <verb>` with no component means the whole
    /// install; with one, that component.
    public enum Lifecycle: String, Sendable, CaseIterable {
        case restart
        case stop
        case start

        /// Title Case: these are control labels (design-system P10).
        public var label: String {
            switch self {
            case .restart: return "Restart"
            case .stop: return "Stop"
            case .start: return "Start"
            }
        }

        public var allLabel: String {
            switch self {
            case .restart: return "Restart All"
            case .stop: return "Stop All"
            case .start: return "Start All"
            }
        }
    }

    public let status: StatusModel
    public var cli: MetistryCLI? {
        didSet { status.cli = cli }
    }

    /// What is in flight. The whole-install actions use `wholeInstallKey`, which
    /// is not a legal component name, so it can never collide with one.
    public private(set) var inFlight: Set<String> = []
    /// The last action's outcome, shown in the menu itself (§3.16 — inline at
    /// the control that failed, the reason verbatim).
    public private(set) var lastOutcome: Outcome?

    public static let wholeInstallKey = "*"
    /// How often doctor is re-run while the menu is open.
    public static let refreshInterval: Duration = .seconds(30)

    public struct Outcome: Sendable, Equatable {
        public let verb: String
        public let target: String?
        public let ok: Bool
        public let message: String

        public init(verb: String, target: String?, ok: Bool, message: String) {
            self.verb = verb
            self.target = target
            self.ok = ok
            self.message = message
        }
    }

    private var poll: Task<Void, Never>?

    public init(status: StatusModel, cli: MetistryCLI?) {
        self.status = status
        self.cli = cli
    }

    public var report: DoctorReport? { status.report }
    public var groups: [ComponentGroup] { status.report?.componentGroups ?? [] }

    public func isBusy(_ key: String) -> Bool { inFlight.contains(key) }
    public var isBusyWholeInstall: Bool { inFlight.contains(Self.wholeInstallKey) }

    // MARK: - Refresh

    /// Called from `.onAppear` / `.onDisappear` of the menu's content. Opening
    /// refreshes immediately; closing stops the poll, because a menu-bar app
    /// that runs a full doctor sweep every 30s forever is a background CPU cost
    /// nobody asked for (P2 — silence is the default).
    public func menuOpened() {
        poll?.cancel()
        poll = Task { [weak self] in
            guard let self else { return }
            await self.status.refresh()
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: Self.refreshInterval)
                } catch {
                    return
                }
                if Task.isCancelled { return }
                await self.status.refresh()
            }
        }
    }

    public func menuClosed() {
        poll?.cancel()
        poll = nil
    }

    // MARK: - Actions

    /// `metistry restart|stop|start [<component>]`.
    public func perform(_ lifecycle: Lifecycle, component: String? = nil) async {
        let key = component ?? Self.wholeInstallKey
        guard let cli, !inFlight.contains(key) else { return }
        inFlight.insert(key)
        defer { inFlight.remove(key) }

        var verb = [lifecycle.rawValue]
        if let component { verb.append(component) }

        let sink = OutputSink()
        do {
            let result = try await cli.run(verb) { line in sink.append(line) }
            lastOutcome = Self.outcome(
                verb: lifecycle.rawValue,
                target: component,
                result: result,
                lines: sink.drain()
            )
        } catch {
            lastOutcome = Outcome(verb: lifecycle.rawValue, target: component, ok: false, message: error.localizedDescription)
        }
        // Whatever happened, the truth is the next doctor report, not our guess.
        await status.refresh()
    }

    /// What the menu prints after an action.
    ///
    /// The one case worth its own sentence: a CLI that predates these verbs
    /// answers `unknown command: restart` with exit 2 (`packages/cli/src/main.ts`
    /// default branch). That is not "restart failed" — it is "this install's CLI
    /// is older than this app", and saying so points at the fix.
    public nonisolated static func outcome(
        verb: String,
        target: String?,
        result: CommandResult,
        lines: [OutputLine]
    ) -> Outcome {
        if isUnknownVerb(result) {
            return Outcome(
                verb: verb,
                target: target,
                ok: false,
                message: "this CLI has no `\(verb)` verb yet — update it (metistry update, or Check for Updates…)"
            )
        }
        let tail = lines.last { !$0.text.trimmingCharacters(in: .whitespaces).isEmpty }?.text
            ?? result.stderr.split(separator: "\n").last.map(String.init)
            ?? "exit \(result.exitCode)"
        let what = [verb, target].compactMap { $0 }.joined(separator: " ")
        return Outcome(verb: verb, target: target, ok: result.ok, message: result.ok ? "\(what): \(tail)" : tail)
    }

    /// Exit 2 plus `unknown command` on stderr is the CLI's own answer for a
    /// verb it does not have; a usage error for a verb it *does* have prints
    /// `usage:` instead, and must not be mistaken for one.
    public nonisolated static func isUnknownVerb(_ result: CommandResult) -> Bool {
        result.exitCode == 2 && result.stderr.contains("unknown command")
    }
}

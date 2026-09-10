// The Status panel's state: one `metistry doctor --json` and what it said.
//
// `checking` is a state of the *panel*, not of a row — doctor either answered
// or it did not. When it did not, the panel says so and keeps the previous
// report on screen rather than blanking (design-system P5: if a panel cannot
// answer it says unavailable, and the rest of the page still renders).

import Foundation
import Observation

@MainActor
@Observable
public final class StatusModel {
    public enum Phase: Equatable {
        case idle
        case checking
        case answered
        case unavailable(String)
    }

    public var cli: MetistryCLI?
    public private(set) var phase: Phase = .idle
    public private(set) var report: DoctorReport?
    public private(set) var lastRunAt: Date?
    /// The last report's age matters: a doctor report is a point in time, and a
    /// stale one dressed as live is exactly what P5 forbids.
    public private(set) var lastCommand: String?

    public init(cli: MetistryCLI?) {
        self.cli = cli
    }

    public var isChecking: Bool { phase == .checking }

    public func refresh() async {
        guard let cli else {
            phase = .unavailable("no metistry runtime located — finish step 1 of first run")
            return
        }
        phase = .checking
        lastCommand = ([cli.runtime.executable.path] + cli.arguments(for: ["doctor", "--json"])).joined(separator: " ")
        do {
            let report = try await cli.doctor()
            self.report = report
            self.lastRunAt = Date()
            self.phase = .answered
        } catch {
            self.lastRunAt = Date()
            self.phase = .unavailable(error.localizedDescription)
        }
    }

    /// What the menu-bar glyph shows. Unknown until doctor has answered once —
    /// and it says so rather than showing a green tick it has not earned.
    public var menuBarState: CheckStatus? {
        guard case .answered = phase, let report else { return nil }
        return report.worstFault
    }
}

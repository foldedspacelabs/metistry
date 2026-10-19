// The Status panel's state: one `metistry doctor --check --json` and what it said.
//
// `checking` is a state of the *panel*, not of a row — doctor either answered
// or it did not. When it did not, the panel says so and keeps the previous
// report on screen rather than blanking (design-system P5: if a panel cannot
// answer it says unavailable, and the rest of the page still renders).

// FIX ALL (X-125, ruled 2026-10-04). The panel's one mutating act is a closed
// set of one (invariant 10): the CLI door `doctor --fix --yes --json`, M6, and
// nothing else. The app never chooses a fix and never runs a repair step
// itself — doctor's closed table (`packages/cli/src/doctor-fix.ts`) does, each
// an existing audited service. What the app owns is the ask: it previews what
// the last read named fixable, and when any of it moves files or restarts a
// running service the owner confirms in a `CostConfirmation` BEFORE `--yes` is
// sent. A fix that does not ask runs from the button; a `hand` row is shown
// and run by nobody; `--yes` is never the default.

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

    public var cli: MetistryCLI? {
        // Another install: its Fix All answer, its confirm and its preview are
        // not this one's.
        didSet {
            if !isFixing { fixPhase = .idle }
            confirmation = nil
            previewed = nil
        }
    }
    public private(set) var phase: Phase = .idle
    public private(set) var report: DoctorReport?
    public private(set) var lastRunAt: Date?
    /// The last report's age matters: a doctor report is a point in time, and a
    /// stale one dressed as live is exactly what P5 forbids.
    public private(set) var lastCommand: String?

    /// Where Fix All stands. Separate from `phase`: the read and the repair are
    /// different doors, and a failed repair leaves the last read on screen.
    public enum FixPhase: Equatable, Sendable {
        case idle
        case running
        case done(FixAllOutcome)
        /// The repair could not be run or its answer could not be read — the
        /// reason in the CLI's own words (§3.16).
        case unavailable(String)
    }

    public private(set) var fixPhase: FixPhase = .idle
    /// The confirm on screen, naming every fix that asks. Presenting it runs
    /// nothing. Only `.confirm` through `choose` sends `--yes`.
    public var confirmation: CostConfirmation?
    /// What the confirm on screen was built from — the run is held to it.
    @ObservationIgnored private var previewed: FixAllPlan?
    /// Test seam: the door Fix All runs through. By default the CLI's own
    /// (`CLIManagementRunner`), over whichever install `cli` is.
    @ObservationIgnored public var management: (any ManagementRunner)?

    public init(cli: MetistryCLI?, management: (any ManagementRunner)? = nil) {
        self.cli = cli
        self.management = management
    }

    public var isChecking: Bool { phase == .checking }
    public var isFixing: Bool { fixPhase == .running }

    /// What Fix All would apply, from the report on screen. Nil — no button —
    /// when nothing is fixable, including on a CLI that does not classify rows.
    public var fixAllPlan: FixAllPlan? { report?.fixAllPlan }

    /// Fix All is offered while there is something to fix and nothing else is
    /// in flight (a read, a repair, or a confirm waiting for its answer).
    public var canFixAll: Bool {
        door != nil && fixAllPlan != nil && !isChecking && !isFixing && confirmation == nil
    }

    private var door: (any ManagementRunner)? {
        management ?? cli.map { CLIManagementRunner(cli: $0) }
    }

    public func refresh() async {
        // A repair is in flight (the menu bar re-reads on its own clock): its
        // answer carries the re-check, and a read now would race the repair.
        guard !isFixing else { return }
        guard let cli else {
            phase = .unavailable("no metistry runtime located — finish step 1 of first run")
            return
        }
        phase = .checking
        lastCommand = ([cli.runtime.executable.path] + cli.arguments(for: ManagementRow.doctorCheckArguments)).joined(separator: " ")
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

    // MARK: - Fix All

    /// The button. Reads again first — the preview must be of what is wrong
    /// NOW, not of a report the menu bar took half a minute ago — then either
    /// runs the fix (nothing in it asks) or puts the confirm on screen (some of
    /// it moves files or restarts a running service). Sends no `--yes` here.
    public func proposeFixAll() async {
        guard canFixAll else { return }
        await refresh()
        guard phase == .answered else { return }
        guard let plan = report?.fixAllPlan else {
            fixPhase = .done(FixAllOutcome(fixes: [], unpreviewed: [], exitCode: 0, asOf: report?.asOf))
            return
        }
        guard plan.asks else {
            await runFixAll(previewed: plan)
            return
        }
        guard let confirmation = Self.confirmation(for: plan) else { return }
        previewed = plan
        self.confirmation = confirmation
    }

    /// Only `.confirm` runs; Cancel (and Esc, and dismissing the sheet) sends
    /// nothing and leaves the report as it was.
    public func choose(_ choice: CostConfirmView.Choice) async {
        let plan = previewed
        confirmation = nil
        previewed = nil
        guard choice == .confirm, let plan else { return }
        await runFixAll(previewed: plan)
    }

    /// The sheet's words: every fix, the ones that ask marked, the button the
    /// act's own verb. Nil when the plan names nothing (it never does).
    static func confirmation(for plan: FixAllPlan) -> CostConfirmation? {
        let costs = plan.items.map { item in
            let rows = item.rows.joined(separator: ", ")
            return item.confirm ? "\(item.does) — for \(rows). This moves files or restarts a running service." : "\(item.does) — for \(rows)."
        }
        return CostConfirmation(
            title: "Fix All?",
            costHeading: "Doctor applies each of these once, then checks again:",
            costs: costs,
            confirm: "Fix All",
            destructive: false
        )
    }

    /// The door: `metistry doctor --fix --yes --json` (M6, pinned to exactly
    /// this argv), and what it answers — the re-check's rows and `fixes[]`.
    private func runFixAll(previewed plan: FixAllPlan) async {
        guard let door, let command = ManagementCommand(.doctor, ManagementRow.doctorFixArguments) else {
            fixPhase = .unavailable("no metistry runtime located — finish step 1 of first run")
            return
        }
        fixPhase = .running
        lastCommand = door.plannedArguments(command).joined(separator: " ")
        let result: CommandResult
        do {
            result = try await door.run(command) { _ in }
        } catch {
            fixPhase = .unavailable(error.localizedDescription)
            return
        }
        // Exit 1 means something is still failing, not that the repair broke
        // (docs/ops/cli.md): the document is read first, as the read's is.
        guard let data = result.stdout.data(using: .utf8), !data.isEmpty else {
            let detail = result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            fixPhase = .unavailable("`metistry doctor --fix --yes --json` printed nothing (exit \(result.exitCode))\(detail.isEmpty ? "" : ": \(detail)")")
            return
        }
        let after: DoctorReport
        do {
            after = try DoctorReport.decode(from: data)
        } catch {
            fixPhase = .unavailable("could not read the repair report (exit \(result.exitCode)): \(error.localizedDescription)")
            return
        }
        // A CLI that predates `--fix` would answer with a plain check and no
        // mode; "nothing needed fixing" would then be a lie about a run that
        // never happened.
        guard after.mode == "fix" else {
            fixPhase = .unavailable("this metistry CLI answered without repairing (no `mode: fix` in its report) — update it and try again")
            return
        }
        report = after
        lastRunAt = Date()
        phase = .answered
        let fixes = after.fixes ?? []
        fixPhase = .done(FixAllOutcome(fixes: fixes, unpreviewed: plan.unpreviewed(in: fixes), exitCode: result.exitCode, asOf: after.asOf))
    }
}

/// What a Fix All run came to: each fix, in the order it ran, with the
/// statuses either side of the one re-check — and any that ran without being
/// in the preview the owner confirmed.
public struct FixAllOutcome: Equatable, Sendable {
    public let fixes: [DoctorFixRecord]
    /// Fixes that ran though the confirmed preview did not name them as asking.
    public let unpreviewed: [DoctorFixRecord]
    public let exitCode: Int32
    /// The report's `as_of` — the re-check this outcome is about.
    public let asOf: String?

    /// One line, before the list: how many came to what.
    public var headline: String {
        guard !fixes.isEmpty else { return "Nothing needed fixing." }
        let fixed = fixes.filter { $0.outcome == "fixed" }.count
        let stillFailing = fixes.filter { $0.outcome == "applied" }.count
        let failed = fixes.filter { $0.outcome == "failed" }.count
        let notRun = fixes.count - fixed - stillFailing - failed
        var parts: [String] = []
        if fixed > 0 { parts.append("\(fixed) fixed") }
        if stillFailing > 0 { parts.append("\(stillFailing) ran, still failing") }
        if failed > 0 { parts.append("\(failed) failed") }
        if notRun > 0 { parts.append("\(notRun) not run") }
        return parts.joined(separator: " · ")
    }

    /// Every fix cleared its rows.
    public var allFixed: Bool { !fixes.isEmpty && fixes.allSatisfy(\.cleared) }
}

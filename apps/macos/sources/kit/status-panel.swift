// The Status panel — design-system §3.13.
//
// Anatomy of a row: [state glyph] [component name] [probe, footnote] …
// [state label] [latency]. Grouped by doctor's own `kind`, so a new component
// kind appears here without a change (invariant 5).
//
// `absent` is rendered in `absent` grey and labelled "not configured", with the
// remediation as the link to what would configure it. It is a fact, not a
// fault, and it does not colour the summary or the menu bar.
//
// Fix All (X-125) is the header's second button. It runs the one closed-set
// action behind it — `doctor --fix --yes --json`, M6 — through `StatusModel`,
// which owns the ask: a fix that moves files or restarts a running service is
// confirmed in the sheet below BEFORE the door runs, and a row that is the
// owner's hand shows what to do and offers no button at all.

import SwiftUI

public struct StatusPanel: View {
    @Environment(\.colorScheme) private var scheme
    private let model: StatusModel
    private let signIn: ConsoleSignInModel
    private let runtime: MetistryRuntime?

    public init(model: StatusModel, signIn: ConsoleSignInModel, runtime: MetistryRuntime?) {
        self.model = model
        self.signIn = signIn
        self.runtime = runtime
    }

    public var body: some View {
        let p = Palette(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: MetistrySpace.s4) {
                header(p)
                if case .unavailable(let why) = model.phase {
                    unavailable(why, p)
                }
                fixResult(p)
                if let report = model.report {
                    ForEach(report.groupedByKind, id: \.kind) { group in
                        group_(group.kind, group.rows, p)
                    }
                    footer(report, p)
                } else if model.phase != .checking {
                    empty(p)
                }
            }
            .padding(MetistrySpace.s5)
            .frame(maxWidth: MetistrySize.contentMax, alignment: .leading)
        }
        .background(p[.bg])
        // Fix All's ask (invariant 10): the sheet names every fix and marks the
        // ones that move files or restart a running service. Dismissing it is
        // Cancel; only the Fix All button inside it sends `--yes`.
        .sheet(isPresented: Binding(get: { model.confirmation != nil }, set: { if !$0 && model.confirmation != nil { Task { await model.choose(.cancel) } } })) {
            if let confirmation = model.confirmation {
                CostConfirmView(confirmation) { choice in Task { await model.choose(choice) } }
                    .frame(width: 480)
            }
        }
        .task {
            if model.phase == .idle { await model.refresh() }
            // Doctor first, then whoami: a 401's diagnosis wants the resolved
            // deployment shape to say which of the loopback rule and a stale
            // value is likelier, and doctor is the only thing that knows it.
            signIn.shape = model.report?.shape
            await signIn.refreshIfNeeded()
        }
    }

    // MARK: - Pieces

    private func header(_ p: Palette) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s3) {
            VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                Text("Status").metistryText(.title2, p)
                // The summary answers before the page is read (§3.13).
                Text(model.report?.summary ?? summaryPlaceholder)
                    .metistryText(.footnote, p, .textSecondary)
                // The instance's layout, when it is not the current one. It is
                // already a doctor row further down the page with the CLI's own
                // remediation; this is the header's one sentence, because the
                // whole install reads paths out of the answer and "run one
                // verb" should not need scrolling to find (design-system §3.13,
                // and doctor-report.swift states the sentence once).
                if let notice = model.report?.instanceLayoutNotice {
                    Text(notice)
                        .metistryText(.footnote, p, .degraded)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
                signInLine(p)
            }
            Spacer(minLength: MetistrySpace.s4)
            // Two buttons that wrap rather than clip at the largest text size.
            FlowLayout(spacing: MetistrySpace.s2) {
                if model.fixAllPlan != nil {
                    Button {
                        Task { await model.proposeFixAll() }
                    } label: {
                        if model.isFixing {
                            ProgressView().controlSize(.small)
                        } else {
                            Label("Fix All", systemImage: "wrench.and.screwdriver")
                        }
                    }
                    .disabled(!model.canFixAll)
                    .accessibilityLabel(model.isFixing ? "Fixing: running metistry doctor" : "Fix All: have metistry doctor fix what it can")
                }
                Button {
                    Task { await model.refresh() }
                } label: {
                    if model.isChecking {
                        ProgressView().controlSize(.small)
                    } else {
                        Label("Check again", systemImage: "arrow.clockwise")
                    }
                }
                .disabled(model.isChecking || model.isFixing)
                .accessibilityLabel("Run metistry doctor again")
            }
        }
    }

    /// What the last Fix All did: each fix with its re-check, in the order the
    /// CLI ran them, in the CLI's own words (§3.16) — or why it could not run.
    @ViewBuilder
    private func fixResult(_ p: Palette) -> some View {
        switch model.fixPhase {
        case .idle, .running:
            EmptyView()
        case .unavailable(let why):
            VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                HStack(spacing: MetistrySpace.s2) {
                    Image(systemName: CheckStatus.failed.symbolName).foregroundStyle(p[.failed]).accessibilityHidden(true)
                    Text("Fix All could not run").metistryText(.headline, p)
                        .accessibilityAddTraits(.isHeader)
                }
                Text(why)
                    .metistryText(.mono, p, .textSecondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                if let command = model.lastCommand {
                    Text(command).metistryText(.caption1, p, .textTertiary).textSelection(.enabled)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .metistryCard(p)
        case .done(let outcome):
            VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                Text("Fix All").metistryText(.caption2, p, .textSecondary)
                    .accessibilityHidden(true)
                Text(outcome.headline).metistryText(.headline, p)
                    .accessibilityAddTraits(.isHeader)
                ForEach(outcome.fixes) { fix in
                    FixRecordView(fix: fix)
                }
                if !outcome.unpreviewed.isEmpty {
                    Text("Ran without being in the preview you confirmed: \(outcome.unpreviewed.map(\.does).joined(separator: "; "))")
                        .metistryText(.footnote, p, .degraded)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let asOf = outcome.asOf {
                    Text("re-checked \(asOf)").metistryText(.caption1, p, .textTertiary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .metistryCard(p)
            .accessibilityElement(children: .contain)
        }
    }

    /// Who this Mac is to the console, on the line under the summary.
    ///
    /// It is a header line and not a doctor row because it answers a different
    /// question: doctor's `console` row says whether the service is up, and this
    /// says whether it takes this Mac as the owner. The detail — `via`, and the
    /// exact command when there is one to run — is under Settings ▸ Account;
    /// this line is the one sentence, and it never has a token in it to show
    /// (`ConsoleWhoami` has no field for one).
    @ViewBuilder
    private func signInLine(_ p: Palette) -> some View {
        HStack(spacing: MetistrySpace.s2) {
            if signIn.isChecking {
                ProgressView().controlSize(.small)
            } else if let status = signIn.status {
                Image(systemName: status.symbolName)
                    .foregroundStyle(p[status.colorRole])
                    .accessibilityHidden(true)
            }
            Text(signIn.headline)
                .metistryText(.footnote, p, signIn.status?.colorRole ?? .textTertiary)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            if let via = signIn.signIn?.whoami?.via {
                Text("via \(via)")
                    .metistryText(.caption1, p, .textTertiary)
                    .textSelection(.enabled)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Console sign-in: \(signIn.headline)")
    }

    private var summaryPlaceholder: String {
        switch model.phase {
        case .checking: return "running metistry doctor…"
        case .unavailable: return "doctor did not answer"
        default: return "not checked yet"
        }
    }

    private func unavailable(_ why: String, _ p: Palette) -> some View {
        // §3.16 error envelope: what could not be done, the reason verbatim,
        // what to do. The reason is the CLI's own words, quoted as data.
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            HStack(spacing: MetistrySpace.s2) {
                Image(systemName: CheckStatus.failed.symbolName).foregroundStyle(p[.failed])
                Text("Could not read a doctor report").metistryText(.headline, p)
            }
            Text(why)
                .metistryText(.mono, p, .textSecondary)
                .textSelection(.enabled)
            if let command = model.lastCommand {
                Text(command).metistryText(.caption1, p, .textTertiary).textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .metistryCard(p)
    }

    private func empty(_ p: Palette) -> some View {
        // §3.15: a glyph, one sentence saying what would put something here,
        // one action. No illustration, no apology.
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            Image(systemName: "stethoscope")
                .font(.system(size: MetistrySize.iconLg))
                .foregroundStyle(p[.textTertiary])
            Text("Nothing checked yet — run doctor to fill this in.")
                .metistryText(.callout, p, .textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .metistryCard(p)
    }

    private func group_(_ kind: String, _ rows: [DoctorRow], _ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            Text(kind.uppercased())
                .metistryText(.caption2, p, .textSecondary)
                .accessibilityLabel("\(kind) checks")
            VStack(spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                    if index > 0 {
                        Divider().overlay(p[.border])
                    }
                    DoctorRowView(row: row)
                }
            }
            .background(p[.surface], in: RoundedRectangle(cornerRadius: MetistryRadius.lg, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: MetistryRadius.lg, style: .continuous)
                    .strokeBorder(p[.border], lineWidth: 1)
            )
        }
    }

    private func footer(_ report: DoctorReport, _ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            Text("Shape \(report.shape) · \(report.productDir)")
                .metistryText(.footnote, p, .textSecondary)
                .textSelection(.enabled)
            if let runtime {
                Text("\(runtime.source.label) · \(runtime.executable.path)")
                    .metistryText(.caption1, p, .textTertiary)
                    .textSelection(.enabled)
            }
            Text("as of \(report.asOf)")
                .metistryText(.caption1, p, .textTertiary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

public struct DoctorRowView: View {
    @Environment(\.colorScheme) private var scheme
    private let row: DoctorRow

    public init(row: DoctorRow) {
        self.row = row
    }

    public var body: some View {
        let p = Palette(scheme)
        HStack(alignment: .top, spacing: MetistrySpace.s3) {
            Image(systemName: row.status.symbolName)
                .foregroundStyle(p[row.status.colorRole])
                .frame(width: MetistrySize.iconMd)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                Text(row.name).metistryText(.headline, p)
                // The probe is the behavioural assertion doctor actually made;
                // the remediation replaces it when there is something to do.
                Text(row.remediation ?? row.probe)
                    .metistryText(.footnote, p, row.remediation == nil ? .textTertiary : .textSecondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                // What Fix All will do for this row — doctor's own sentence,
                // never one the app writes — or, after a run, how it came out.
                if let note = fixNote {
                    Text(note)
                        .metistryText(.caption1, p, row.fixed == false ? .degraded : .textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: MetistrySpace.s3)
            VStack(alignment: .trailing, spacing: MetistrySpace.s1) {
                Text(row.status.label)
                    .metistryText(.caption2, p, row.status.colorRole)
                if let tag = fixTag {
                    Text(tag).metistryText(.caption2, p, .textSecondary)
                }
                Text("\(Int(row.latencyMs)) ms")
                    .metistryText(.caption1, p, .textTertiary)
                    .monospacedDigit()
            }
        }
        .padding(.horizontal, MetistrySpace.s3)
        .padding(.vertical, MetistrySpace.s3)
        // One accessibility element per row, read as a sentence rather than as
        // five separate labels (design-system §6).
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(row.name), \(row.kind), \(row.status.label). \(row.remediation ?? row.probe)\(fixSpoken)")
    }

    /// The right-hand tag: who puts a finding right, said once. `info` and
    /// `ok` rows say nothing — a fact is not a task. After a run, the verdict
    /// replaces the promise.
    var fixTag: String? {
        if let fixed = row.fixed { return fixed ? "fixed" : "still failing" }
        if row.isFixable { return "Fix All" }
        if row.isYoursToDo { return "your hand" }
        return nil
    }

    /// The line under the remediation. A your-hand row's remediation IS what
    /// to do (doctor names the exact step), so it adds only that nothing here
    /// will run it.
    var fixNote: String? {
        if row.fixed == true { return "Fixed — the re-check cleared this row." }
        if row.fixed == false { return "Doctor tried a fix and the re-check still finds this." }
        if row.isFixable, let repair = row.repair {
            return repair.confirm ? "Fix All will: \(repair.does). It asks first." : "Fix All will: \(repair.does)."
        }
        if row.isYoursToDo { return "This one is yours to do; Fix All does not touch it." }
        return nil
    }

    private var fixSpoken: String {
        [fixNote].compactMap { $0 }.map { " \($0)" }.joined()
    }
}

/// One fix of a Fix All run: what it did, for which rows, how it came out, and
/// the statuses either side of the re-check. The steps it ran are the CLI's own
/// ledger, selectable, never re-worded.
struct FixRecordView: View {
    @Environment(\.colorScheme) private var scheme
    let fix: DoctorFixRecord

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                Image(systemName: (fix.cleared ? CheckStatus.ok : (fix.outcome == "applied" ? CheckStatus.degraded : CheckStatus.failed)).symbolName)
                    .foregroundStyle(p[fix.cleared ? .ok : (fix.outcome == "applied" ? .degraded : .failed)])
                    .accessibilityHidden(true)
                Text(fix.does).metistryText(.callout, p)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text("\(fix.outcomeLabel) · \(transition)")
                .metistryText(.footnote, p, .textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            if let error = fix.error {
                Text(error).metistryText(.mono, p, .failed)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(Array(fix.steps.enumerated()), id: \.offset) { step in
                Text(step.element).metistryText(.mono, p, .textTertiary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(fix.does). \(fix.outcomeLabel). \(transition)\(fix.error.map { ". \($0)" } ?? "")")
    }

    /// `child:console failed → ok`, for each row the fix was for.
    var transition: String {
        fix.rows.map { name in
            let before = fix.before[name].flatMap(CheckStatus.init(rawValue:))?.label ?? "unknown"
            guard let after = fix.after?[name] else { return "\(name) \(before)" }
            return "\(name) \(before) → \(CheckStatus(rawValue: after)?.label ?? after)"
        }.joined(separator: "; ")
    }
}

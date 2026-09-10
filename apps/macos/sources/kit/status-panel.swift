// The Status panel — design-system §3.13.
//
// Anatomy of a row: [state glyph] [component name] [probe, footnote] …
// [state label] [latency]. Grouped by doctor's own `kind`, so a new component
// kind appears here without a change (invariant 5).
//
// `absent` is rendered in `absent` grey and labelled "not configured", with the
// remediation as the link to what would configure it. It is a fact, not a
// fault, and it does not colour the summary or the menu bar.

import SwiftUI

public struct StatusPanel: View {
    @Environment(\.colorScheme) private var scheme
    private let model: StatusModel
    private let runtime: MetistryRuntime?

    public init(model: StatusModel, runtime: MetistryRuntime?) {
        self.model = model
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
        .task {
            if model.phase == .idle { await model.refresh() }
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
            }
            Spacer(minLength: MetistrySpace.s4)
            Button {
                Task { await model.refresh() }
            } label: {
                if model.isChecking {
                    ProgressView().controlSize(.small)
                } else {
                    Label("Check again", systemImage: "arrow.clockwise")
                }
            }
            .disabled(model.isChecking)
            .accessibilityLabel("Run metistry doctor again")
        }
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
            }
            Spacer(minLength: MetistrySpace.s3)
            VStack(alignment: .trailing, spacing: MetistrySpace.s1) {
                Text(row.status.label)
                    .metistryText(.caption2, p, row.status.colorRole)
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
        .accessibilityLabel("\(row.name), \(row.kind), \(row.status.label). \(row.remediation ?? row.probe)")
    }
}

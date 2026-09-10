// The window "View Log" opens: `metistry logs <component> --lines 200`, the
// command that produced it, and a Reload.
//
// Monospaced, selectable, and NOT auto-scrolling. Design-system P9's rule is
// about the transcript, but the reason generalises: a pane that jumps while you
// are reading it has taken the reading away from you. The newest lines are at
// the bottom, where a log's newest lines are.

import SwiftUI

public struct LogWindowView: View {
    @Environment(\.colorScheme) private var scheme
    private let model: LogViewerModel

    public init(model: LogViewerModel) {
        self.model = model
    }

    public var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: 0) {
            header(p)
            Divider().overlay(p[.border])
            ScrollView {
                VStack(alignment: .leading, spacing: MetistrySpace.s4) {
                    if case .unavailable(let why) = model.phase {
                        UnavailableCard(what: "Could not read the log", reason: why, command: model.command)
                    }
                    if model.lines.isEmpty, model.phase == .loaded {
                        Text("The log is empty — the component has written nothing yet.")
                            .metistryText(.callout, p, .textSecondary)
                    }
                    OutputLogView(title: "Last \(LogViewerModel.defaultLineCount) lines", lines: model.lines)
                }
                .padding(MetistrySpace.s5)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(minWidth: 620, minHeight: 420)
        .background(p[.bg])
    }

    private func header(_ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s3) {
                Text(model.component ?? "Log").metistryText(.title3, p)
                Spacer(minLength: MetistrySpace.s3)
                Button {
                    Task { await model.reload() }
                } label: {
                    if model.isLoading {
                        ProgressView().controlSize(.small)
                    } else {
                        Label("Reload", systemImage: "arrow.clockwise")
                    }
                }
                .disabled(model.isLoading || model.component == nil)
            }
            if let command = model.command {
                Text(command)
                    .metistryText(.caption1, p, .textTertiary)
                    .textSelection(.enabled)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            if let loadedAt = model.loadedAt {
                Text("read \(loadedAt.formatted(date: .omitted, time: .standard))")
                    .metistryText(.caption1, p, .textTertiary)
            }
        }
        .padding(.horizontal, MetistrySpace.s5)
        .padding(.vertical, MetistrySpace.s3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(p[.surface])
    }
}

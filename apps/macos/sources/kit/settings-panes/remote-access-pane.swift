// Settings ▸ Remote Access (design-build-plan §2.23, X-107; screen-15 §1's
// ACCESS group, before Devices): the choice and mode, the origin, the
// provider's doctor rows with when they were checked, **Change…** (the guided
// flow, remote-access-flow.swift, as this window's sheet), **Test** (step 6,
// *answers from this Mac*) and **Turn Off** (back to None, after a confirm
// naming what the provider's revoke undoes). The reads and the doors are
// remote-access-model.swift's; this file draws them.

import SwiftUI

struct RemoteAccessPane: View {
    let model: AppModel

    private var settings: SettingsModel { model.settings }

    var body: some View {
        RemoteAccessPaneBody(pane: settings.remoteAccessPane)
            // Re-read on open and on every instance switch — this IS the refresh.
            .task(id: model.instances.active) { await settings.remoteAccessPane.refresh() }
    }
}

/// The pane's sections over the model alone, so a test drives them without an app.
struct RemoteAccessPaneBody: View {
    @Environment(\.colorScheme) private var scheme
    let pane: RemoteAccessModel

    var body: some View {
        let p = Palette(scheme)
        choice(p)
        rows(p)
    }

    // MARK: The choice

    @ViewBuilder
    private func choice(_ p: Palette) -> some View {
        SettingsSection("How Your Phone Reaches This Mac") {
            if case .unavailable(let why) = pane.phase {
                UnavailableCard(what: "Could not read remote access", reason: why, command: RemoteAccessWords.readCommand)
            } else if let status = pane.status {
                FactRow("Remote access", status.label, help: "`remote:` in this instance's deployment.yaml, read through `metistry remote status --json`; changed only by `metistry remote set`, a protected write.")
                FactRow("Address", status.origin ?? RemoteAccessWords.noneOrigin, mono: status.origin != nil, role: status.origin == nil ? .absent : .textPrimary)
                if !status.origins.isEmpty {
                    FactRow("METISTRY_ORIGIN", status.origins.joined(separator: ", "), help: "The origins the console answers for: the provider's first, this Mac's loopback second. A passkey signs in only at the host it was created on.", mono: true)
                }
                if !status.droppedOrigins.isEmpty {
                    Text(".env also names \(status.droppedOrigins.joined(separator: ", ")) — not carried; `metistry remote set <provider>` is how a remote origin is configured.")
                        .metistryText(.caption1, p, .degraded)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                Text("Reading how this Mac is reached…")
                    .metistryText(.footnote, p, .textTertiary)
            }
            SettingsControls {
                Button(RemoteAccessWords.change) { pane.beginChange() }
                    .buttonStyle(.borderedProminent)
                    .disabled(pane.flow != nil || pane.busy || pane.phase == .reading)
                Button(RemoteAccessWords.test) { Task { await pane.test() } }
                    .disabled(pane.status == nil || pane.testing || pane.busy)
                Button(RemoteAccessWords.turnOff, role: .destructive) { Task { await pane.proposeTurnOff() } }
                    .disabled(pane.status?.isNone != false || pane.busy || pane.testing)
                if pane.busy || pane.testing || pane.phase == .reading {
                    ProgressView().controlSize(.small).accessibilityLabel("Working")
                }
            }
            Text("Change… walks the guided flow — choose, get the tool, sign in at the provider's own page, approve, expose, check, then Add a Phone. Test re-runs the check. Turn Off goes back to None and runs the provider's revoke, after naming what it undoes.")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
            if let note = pane.note {
                SettingsNoteLine(note: note)
            }
            if let command = pane.lastCommand {
                Text(command)
                    .metistryText(.caption1, p, .textTertiary)
                    .textSelection(.enabled)
            }
        }
    }

    // MARK: The rows

    @ViewBuilder
    private func rows(_ p: Palette) -> some View {
        SettingsSection("What the Provider Reports") {
            if pane.rows.isEmpty {
                Text(pane.phase == .reading ? "Reading…" : "No rows yet.")
                    .metistryText(.footnote, p, .textTertiary)
            } else {
                ForEach(pane.rows) { row in
                    DoctorRowView(row: row)
                }
            }
            Text(pane.checkedLine ?? "Not checked yet.")
                .metistryText(.caption1, p, .textTertiary)
            Text(RemoteAccessWords.checkNote)
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// Change… as the Settings window's sheet: the flow, a title, and Done.
/// Closing it in any state cancels a verb that is still running.
public struct RemoteAccessFlowSheet: View {
    @Environment(\.colorScheme) private var scheme
    private let model: RemoteAccessFlowModel
    private let onDone: () -> Void

    public init(model: RemoteAccessFlowModel, onDone: @escaping () -> Void) {
        self.model = model
        self.onDone = onDone
    }

    public static let width: CGFloat = 640

    public var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s4) {
            Text("Set Up \(RemoteAccessWords.title)")
                .metistryText(.title3, p)
                .accessibilityAddTraits(.isHeader)
            ScrollView {
                RemoteAccessFlowView(model: model, inSettings: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 520)
            HStack {
                Spacer(minLength: 0)
                Button(AddPhoneWords.done, action: onDone)
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(MetistrySpace.s5)
        .frame(width: Self.width)
        .background(p[.bg])
        #if os(macOS)
        .onExitCommand { onDone() }
        #endif
        .sheet(isPresented: Binding(get: { model.confirmation != nil }, set: { if !$0 { model.choose(.cancel) } })) {
            if let confirmation = model.confirmation {
                CostConfirmView(confirmation) { choice in model.choose(choice) }
                    .frame(width: 480)
            }
        }
    }
}

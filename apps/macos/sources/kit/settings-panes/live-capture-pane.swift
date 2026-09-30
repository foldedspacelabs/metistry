// Settings ▸ Live Capture (T6-15; screen-11 §8): the floating bar's switch and
// placement, the three permissions as a read-through, what is kept, and Purge
// Now with its count. The facts are live-capture-model.swift's; this file
// draws them. Absent, not off, without the bridge: no bridge, no pane.

import SwiftUI

struct LiveCapturePane: View {
    let model: AppModel
    let actions: SettingsActions

    private var settings: SettingsModel { model.settings }

    var body: some View {
        LiveCapturePaneBody(pane: settings.liveCapturePane, bar: model.captureBar, status: model.status, actions: actions, assistantName: settings.identity?.assistantName)
            // Re-read on open and on every instance switch — this IS the refresh.
            .task(id: model.instances.active) { await settings.liveCapturePane.refresh() }
    }
}

/// The pane's sections over the models alone, so a test drives them without an app.
struct LiveCapturePaneBody: View {
    @Environment(\.colorScheme) private var scheme
    let pane: LiveCaptureModel
    let bar: CaptureBarPreferences
    let status: StatusModel
    let actions: SettingsActions
    let assistantName: String?

    private var name: String { assistantName ?? "the assistant" }

    var body: some View {
        let p = Palette(scheme)
        switch pane.presence {
        case .absent:
            // screen-11 §8: no bridge, no pane, no bar, no grants (`degrades: absent`)
            StatePanel(StatePanelModel(.absent, title: LiveCaptureWords.absentTitle, sentence: LiveCaptureWords.absentSentence))
        case .unknown:
            SettingsSection("Live Capture") {
                HStack(spacing: MetistrySpace.s2) {
                    ProgressView().controlSize(.small)
                    Text("Waiting for doctor to say whether this Mac has a recorder…")
                        .metistryText(.footnote, p, .textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
            }
        case .present:
            theBar(p)
            permissions(p)
            keeps(p)
            recordings(p)
        }
    }

    // MARK: The floating bar

    @ViewBuilder
    private func theBar(_ p: Palette) -> some View {
        SettingsSection("The Floating Bar") {
            Toggle("Show the floating bar", isOn: Binding(get: { bar.placement.enabled }, set: { bar.setEnabled($0) }))
            // Placement: left or right edge, drawn rather than named (§8)
            HStack(alignment: .top, spacing: MetistrySpace.s3) {
                ForEach(CaptureBarEdge.allCases) { edge in
                    EdgePlacementButton(edge: edge, selected: bar.placement.edge == edge) { bar.setEdge(edge) }
                }
                .disabled(!bar.placement.enabled)
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Which edge the bar rests on")
            Picker("Display", selection: Binding<Int?>(get: { bar.placement.displayID }, set: { bar.setDisplay($0) })) {
                Text("Main display").tag(Int?.none)
                ForEach(actions.displays().filter { !$0.isMain }) { display in
                    Text(display.name).tag(Int?.some(display.id))
                }
            }
            .disabled(!bar.placement.enabled)
            .frame(maxWidth: 320, alignment: .leading)
            Text(LiveCaptureWords.barNote)
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: Permissions — whether, not when

    @ViewBuilder
    private func permissions(_ p: Palette) -> some View {
        SettingsSection("Permissions") {
            if let grants = pane.grants {
                ForEach(grants) { grant in
                    VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                        HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                            Image(systemName: (grant.isApproved ? CheckStatus.ok : CheckStatus.degraded).symbolName)
                                .foregroundStyle(p[grant.isApproved ? .ok : .degraded])
                                .accessibilityHidden(true)
                            Text(grant.kind.title).metistryText(.callout, p)
                            Spacer(minLength: MetistrySpace.s2)
                            Text(grant.state).metistryText(.callout, p, grant.isApproved ? .ok : .degraded)
                        }
                        Text(grant.detail ?? grant.kind.purpose)
                            .metistryText(.caption1, p, .textTertiary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("\(grant.kind.title): \(grant.state). \(grant.detail ?? grant.kind.purpose)")
                }
            } else if let row = pane.bridgeRow {
                UnavailableCard(what: "The recorder did not report its permissions", reason: row.remediation ?? row.probe, command: "metistry doctor")
            }
            SettingsControls {
                Button("Open System Settings", action: actions.openSystemSettings)
                    .accessibilityLabel("Open System Settings, Privacy and Security")
                Button("Read Again") { Task { await status.refresh() } }
                    .disabled(status.isChecking)
                    .accessibilityLabel("Read the permissions again")
            }
            Text(LiveCaptureWords.permissionsNote)
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: What the assistant keeps

    @ViewBuilder
    private func keeps(_ p: Palette) -> some View {
        SettingsSection("What \(name) Keeps") {
            FactRow("Audio", LiveCaptureWords.keepsAudio)
            FactRow("Transcript", LiveCaptureWords.keepsTranscript)
            FactRow("Notes", LiveCaptureWords.keepsNotes)
        }
    }

    // MARK: Recordings, and Purge Now with its count

    @ViewBuilder
    private func recordings(_ p: Palette) -> some View {
        SettingsSection("Recordings") {
            SettingsControls {
                Button(LiveCaptureWords.purgeNow, role: .destructive) { pane.purgeNow() }
                    .disabled(pane.purgeUnavailableReason != nil || pane.busy || pane.phase == .reading)
                    .accessibilityLabel("\(LiveCaptureWords.purgeNow): \(pane.countLine)")
                if pane.busy || pane.phase == .reading {
                    ProgressView().controlSize(.small).accessibilityLabel("Counting the recordings")
                }
                // the amount beside the verb (screen-11 §8)
                Text(pane.countLine)
                    .metistryText(.callout, p, .textSecondary)
                    .monospacedDigit()
                    .accessibilityHidden(true)
            }
            if let reason = pane.purgeUnavailableReason {
                Text(reason)
                    .metistryText(.caption1, p, .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if case .unavailable(let why) = pane.phase {
                UnavailableCard(what: "Could not read the recordings", reason: why, command: "GET /api/knowledge/pages?prefix=\(LiveCaptureModel.transcriptsPrefix), then GET /api/recordings/:id")
            }
            ForEach(pane.recordings) { recording in
                VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                    Text(recording.line(clock: pane.clock, now: pane.now()))
                        .metistryText(.callout, p)
                        .monospacedDigit()
                    Text(recording.retentionLine(clock: pane.clock, now: pane.now()))
                        .metistryText(.caption1, p, .textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
            }
            if pane.phase == .read, pane.recordings.isEmpty {
                Text("No recordings in the last 30 days.")
                    .metistryText(.callout, p, .textSecondary)
            }
            if let note = pane.note {
                SettingsNoteLine(note: note)
            }
        }
    }
}

/// One edge, drawn: a screen with the bar resting on its left or right side.
/// The picture is the control; its name is spoken (§2.18.3).
struct EdgePlacementButton: View {
    @Environment(\.colorScheme) private var scheme
    let edge: CaptureBarEdge
    let selected: Bool
    let action: () -> Void

    var body: some View {
        let p = Palette(scheme)
        Button(action: action) {
            ZStack(alignment: edge == .left ? .leading : .trailing) {
                RoundedRectangle(cornerRadius: MetistryRadius.sm, style: .continuous)
                    .fill(p[.sunken])
                    .overlay(RoundedRectangle(cornerRadius: MetistryRadius.sm, style: .continuous).strokeBorder(p[selected ? .accent : .border], lineWidth: selected ? 2 : 1))
                    .frame(width: 72, height: 46)
                Capsule(style: .continuous)
                    .fill(p[selected ? .accent : .textTertiary])
                    .frame(width: 8, height: 26)
                    .padding(.horizontal, 6)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(edge.title)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}

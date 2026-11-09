// Settings ▸ Sessions (T6-15; screen-12 §4): whether the assistant learns
// from the session archive, how long it is kept, and Purge Now with its count.
// The reads and the two writes are sessions-model.swift's; this file draws
// them. Purge Now's confirm is the window's sheet (settings-view.swift), a
// `CostConfirmView` naming the unfolded sessions with *Fold First* (C136).

import SwiftUI

struct SessionsPane: View {
    let model: AppModel

    private var settings: SettingsModel { model.settings }

    var body: some View {
        SessionsPaneBody(pane: settings.sessionsPane, assistantName: settings.identity?.assistantName)
            // Re-read on open and on every instance switch — this IS the refresh.
            .task(id: model.instances.active) {
                settings.sessionsPane.assistantName = settings.identity?.assistantName
                await settings.sessionsPane.refresh()
            }
    }
}

/// The pane's sections over the model alone, so a test drives them without an app.
struct SessionsPaneBody: View {
    @Environment(\.colorScheme) private var scheme
    let pane: SessionsModel
    let assistantName: String?

    private var name: String { assistantName ?? "the assistant" }

    var body: some View {
        let p = Palette(scheme)
        learning(p)
        retention(p)
        purge(p)
    }

    // MARK: Let the assistant learn from them

    @ViewBuilder
    private func learning(_ p: Palette) -> some View {
        SettingsSection("Learning") {
            Toggle("Let \(name) learn from them", isOn: Binding(
                get: { pane.learns ?? true },
                set: { on in Task { await pane.setLearns(on) } }
            ))
            .disabled(pane.learns == nil || pane.busy)
            if case .unavailable(let why) = pane.foldPhase {
                UnavailableCard(what: "Could not read the Session Fold routine", reason: why, command: "GET /api/scheduled/routines/\(SessionsModel.foldRoutine)")
            } else if pane.foldPhase == .reading, pane.fold == nil {
                Text("Reading the Session Fold routine…")
                    .metistryText(.footnote, p, .textTertiary)
            }
            Text("On, the hourly fold reads each session and proposes what \(name) learned — you approve every line in Needs You. \(SessionsWords.learnOff)")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: Keep sessions

    @ViewBuilder
    private func retention(_ p: Palette) -> some View {
        SettingsSection("Keep Sessions") {
            if case .unavailable(let why) = pane.purgePhase {
                UnavailableCard(what: "Could not read the Session Purge routine", reason: why, command: "GET /api/scheduled/routines/\(SessionsModel.purgeRoutineName)")
            } else {
                FactRow("Keep sessions", pane.retentionLine ?? "Reading…", help: SessionsWords.retentionWhere)
            }
            Text(SessionsWords.storedOutsideGit)
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: Purge Now

    @ViewBuilder
    private func purge(_ p: Palette) -> some View {
        SettingsSection(SessionsWords.purgeNow) {
            SettingsControls {
                Button(SessionsWords.purgeNow, role: .destructive) { pane.purgeNow() }
                    .disabled(pane.purgeUnavailableReason != nil || pane.busy || pane.previewPhase == .reading)
                    .accessibilityLabel("\(SessionsWords.purgeNow): \(pane.countLine)")
                if pane.busy || pane.previewPhase == .reading {
                    ProgressView().controlSize(.small).accessibilityLabel("Counting the archive")
                }
                // the amount beside the verb: what it will destroy (screen-11 §8)
                Text(pane.countLine)
                    .metistryText(.callout, p, .textSecondary)
                    .monospacedDigit()
                    .accessibilityHidden(true)
                if let unfolded = pane.preview?.unfoldedLine {
                    Text(unfolded)
                        .metistryText(.callout, p, .degraded)
                        .monospacedDigit()
                }
            }
            if let reason = pane.purgeUnavailableReason {
                Text(reason)
                    .metistryText(.caption1, p, .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text("Deletes every archived session, folded or not, for good. It asks first, naming the sessions \(name) has not learned from yet.")
                    .metistryText(.caption1, p, .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let note = pane.note {
                SettingsNoteLine(note: note)
            }
        }
    }
}

/// What the last act came to, under a section: done in the plain ink, a
/// refusal or a failure in theirs — the words verbatim (§3.16).
struct SettingsNoteLine: View {
    @Environment(\.colorScheme) private var scheme
    let note: ScheduledNote

    var body: some View {
        let p = Palette(scheme)
        HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
            Image(systemName: (note.kind == .done ? CheckStatus.ok : CheckStatus.failed).symbolName)
                .foregroundStyle(p[note.kind == .done ? .ok : .failed])
                .accessibilityHidden(true)
            Text(note.text)
                .metistryText(.footnote, p, note.kind == .done ? .textSecondary : .failed)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel("\(note.kind == .done ? "Done" : "Failed"): \(note.text)")
        }
    }
}

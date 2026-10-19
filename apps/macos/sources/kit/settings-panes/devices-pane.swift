// Settings ▸ Devices (design-build-plan §2.22, X-77; screen-15 §1's ACCESS
// group): Add a Phone…, the devices — a passkey each, with its sessions —
// Remove, and Sign Out Everywhere. The reads and the one door are
// devices-model.swift's; this file draws them. Both confirms are the window's
// sheet (settings-view.swift), a `CostConfirmView` naming the device (C136),
// and Add a Phone… presents the sheet add-phone-sheet.swift draws.

import SwiftUI

struct DevicesPane: View {
    let model: AppModel

    private var settings: SettingsModel { model.settings }

    var body: some View {
        DevicesPaneBody(pane: settings.devicesPane)
            // Re-read on open and on every instance switch — this IS the refresh.
            .task(id: model.instances.active) { await settings.devicesPane.refresh() }
    }
}

/// The pane's sections over the model alone, so a test drives them without an app.
struct DevicesPaneBody: View {
    @Environment(\.colorScheme) private var scheme
    let pane: DevicesModel

    var body: some View {
        let p = Palette(scheme)
        addAPhone(p)
        devices(p)
        signOut(p)
    }

    // MARK: Add a Phone…

    @ViewBuilder
    private func addAPhone(_ p: Palette) -> some View {
        SettingsSection(AddPhoneWords.title) {
            Button(AddPhoneWords.addAPhone) { pane.beginAddPhone() }
                .buttonStyle(.borderedProminent)
                .disabled(pane.addPhone != nil)
            Text(DevicesWords.addNote)
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: The devices

    @ViewBuilder
    private func devices(_ p: Palette) -> some View {
        SettingsSection("Devices") {
            if case .unavailable(let why) = pane.phase {
                UnavailableCard(what: "Could not read the devices", reason: why, command: "GET /api/devices")
            } else if pane.phase == .reading, pane.devices.isEmpty {
                Text("Reading the devices…")
                    .metistryText(.footnote, p, .textTertiary)
            } else if pane.devices.isEmpty {
                Text(DevicesWords.empty)
                    .metistryText(.callout, p, .textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ForEach(pane.devices) { device in
                    DeviceRowView(device: device, clock: pane.clock, now: pane.now(), busy: pane.busy) { pane.proposeRemove(device) }
                    if device.id != pane.devices.last?.id {
                        Divider().overlay(p[.border])
                    }
                }
            }
            Text(DevicesWords.removeNote)
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
            if let note = pane.note {
                SettingsNoteLine(note: note)
            }
        }
    }

    // MARK: Sign Out Everywhere

    @ViewBuilder
    private func signOut(_ p: Palette) -> some View {
        SettingsSection(DevicesWords.signOutEverywhere) {
            SettingsControls {
                Button(DevicesWords.signOutEverywhere, role: .destructive) { pane.proposeSignOutEverywhere() }
                    .disabled(pane.signOutUnavailableReason != nil || pane.busy || pane.phase == .reading)
                    .accessibilityLabel("\(DevicesWords.signOutEverywhere): \(pane.signedIn.count == 1 ? "1 device" : "\(pane.signedIn.count) devices") signed in")
                if pane.busy || pane.phase == .reading {
                    ProgressView().controlSize(.small).accessibilityLabel("Reading the devices")
                }
                Text(pane.signedIn.isEmpty ? DevicesWords.nothingSignedIn : (pane.signedIn.count == 1 ? "1 device signed in" : "\(pane.signedIn.count) devices signed in"))
                    .metistryText(.callout, p, .textSecondary)
                    .monospacedDigit()
                    .accessibilityHidden(true)
            }
            Text(DevicesWords.signOutNote)
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
            Text(DevicesWords.onlyOverTheAPI)
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// One device: its label, *This device*, when it was added and last seen,
/// its sessions, and Remove.
struct DeviceRowView: View {
    @Environment(\.colorScheme) private var scheme
    let device: Device
    let clock: ClockTime
    let now: Date
    let busy: Bool
    let onRemove: () -> Void

    var body: some View {
        let p = Palette(scheme)
        SettingsControls {
            VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                HStack(spacing: MetistrySpace.s2) {
                    Text(device.label).metistryText(.headline, p)
                    if device.thisDevice {
                        Text(DevicesWords.thisDevice)
                            .metistryText(.caption2, p, .accent)
                            .padding(.horizontal, MetistrySpace.s2)
                            .padding(.vertical, 2)
                            .background(p[.accentQuiet], in: Capsule())
                    }
                }
                Text(dates)
                    .metistryText(.caption1, p, .textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(device.sessionsLine)
                    .metistryText(.caption1, p, .textTertiary)
                    .monospacedDigit()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            Button(DevicesWords.remove, role: .destructive, action: onRemove)
                .disabled(busy)
                .accessibilityLabel("\(DevicesWords.remove) \(device.label)")
        }
    }

    /// *Added 19 Oct, 9:14 AM · Last seen 9:41 AM*.
    private var dates: String {
        var parts: [String] = []
        if let added = device.added { parts.append("Added \(clock.moment(added, now: now))") }
        if let seen = device.lastSeen { parts.append("Last seen \(clock.moment(seen, now: now))") }
        return parts.isEmpty ? "Dates not reported" : parts.joined(separator: " · ")
    }
}

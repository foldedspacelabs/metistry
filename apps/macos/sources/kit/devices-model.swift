// Settings ▸ Devices (design-build-plan §2.22, X-77; screen-15 §1's ACCESS
// group gains it): the devices that may sign in, each one a passkey with its
// sessions under it, **Remove**, **Sign Out Everywhere**, and the way in for a
// new one — **Add a Phone…**, the sheet add-phone-model.swift drives.
//
// ONE READ, ONE DOOR, BOTH EXISTING. The list is `GET /api/devices` — one row
// per enrolled passkey: label, added, last seen, `this_device`, its sessions
// — refetched on `run.finished` events of kind `auth` (an add or a remove
// lands in `runs`, §2.22). Remove and Sign Out Everywhere are both
// `POST /api/devices/:id/revoke`, told apart by `scope`: `device` revokes the
// passkey and every session under it, dropping their push subscriptions, so a
// removed phone never signs in again; `sessions` ends this device's sessions
// and keeps its passkey, so it signs in again with Face ID. No console route
// is added for any of it (invariant 10); the phone may do both too (§2.3).
//
// BOTH ARE IRREVERSIBLE, SO BOTH CONFIRM, NAMING THE COST (C136). Remove names
// the device — its label, when it was added, how many sessions end — and the
// button says *Remove*; Sign Out Everywhere lists every signed-in device and
// the button says *Sign Out Everywhere*. A `CostConfirmation` cannot be made
// without a cost or with a bare button (undo-and-confirm.swift). Presenting
// a confirm sends nothing; only `choose(.confirm)` posts, once per device for
// Sign Out Everywhere — the caller's own last, so the others are told first.
//
// Minting an enrolment code is NOT here and not a route: Add a Phone… runs
// `metistry enroll` (M19) through the sheet's model.

import Foundation
import Observation

// MARK: - A device, as `GET /api/devices` serves it

/// One session under a passkey: `{id, created_at, last_seen_at, absolute_expires_at, revoked, push}`.
public struct DeviceSession: Sendable, Equatable, Identifiable {
    public let id: Int
    public let createdAt: Date?
    public let lastSeenAt: Date?
    public let expiresAt: Date?
    public let revoked: Bool
    /// A notification subscription is held.
    public let push: Bool

    public init(id: Int, createdAt: Date?, lastSeenAt: Date?, expiresAt: Date?, revoked: Bool, push: Bool) {
        self.id = id
        self.createdAt = createdAt
        self.lastSeenAt = lastSeenAt
        self.expiresAt = expiresAt
        self.revoked = revoked
        self.push = push
    }

    public init?(json: JSONValue) {
        guard let id = Device.identifier(json["id"]) else { return nil }
        self.init(
            id: id,
            createdAt: WireTime.date(json.string("created_at")),
            lastSeenAt: WireTime.date(json.string("last_seen_at")),
            expiresAt: WireTime.date(json.string("absolute_expires_at")),
            revoked: json.bool("revoked") ?? false,
            push: json.bool("push") ?? false
        )
    }
}

/// A device is a passkey, with its sessions under it (§2.22;
/// docs/ops/client-api.md, "Who you are, and your devices").
public struct Device: Sendable, Equatable, Identifiable {
    /// What Remove posts to `…/:id/revoke`: the device's newest session row.
    public let id: Int
    public let passkeyID: String
    /// The name the device chose at enrolment.
    public let label: String
    /// The host the passkey was created for — the only host it signs in at.
    public let rpID: String?
    public let added: Date?
    public let lastSeen: Date?
    /// The caller's own row. Always false for this Mac, which signs in with
    /// the local owner token and has no passkey.
    public let thisDevice: Bool
    public let sessions: [DeviceSession]

    public init(id: Int, passkeyID: String, label: String, rpID: String?, added: Date?, lastSeen: Date?, thisDevice: Bool, sessions: [DeviceSession]) {
        self.id = id
        self.passkeyID = passkeyID
        self.label = label
        self.rpID = rpID
        self.added = added
        self.lastSeen = lastSeen
        self.thisDevice = thisDevice
        self.sessions = sessions
    }

    public init?(json: JSONValue) {
        guard let id = Self.identifier(json["id"]), let passkeyID = json.string("passkey_id") else { return nil }
        self.init(
            id: id,
            passkeyID: passkeyID,
            label: json.string("label") ?? "Unnamed device",
            rpID: json.string("rp_id"),
            added: WireTime.date(json.string("added", "created_at")),
            lastSeen: WireTime.date(json.string("last_seen", "last_seen_at")),
            thisDevice: json.bool("this_device") ?? false,
            sessions: json["sessions"]?.arrayValue?.compactMap(DeviceSession.init(json:)) ?? []
        )
    }

    /// The body's `devices[]`, in the console's order (newest seen first).
    public static func list(_ json: JSONValue) -> [Device] {
        (json["devices"]?.arrayValue ?? []).compactMap(Device.init(json:))
    }

    /// A row id arrives as the bigint's text (`"3"`) from the console and as a
    /// number from an older recording; both are the same id.
    static func identifier(_ value: JSONValue?) -> Int? {
        if let n = value?.intValue { return n }
        if let s = value?.stringValue { return Int(s) }
        return nil
    }

    /// The sessions that are still signed in.
    public var liveSessions: [DeviceSession] { sessions.filter { !$0.revoked } }
    public var isSignedIn: Bool { !liveSessions.isEmpty }
    public var hasPush: Bool { liveSessions.contains { $0.push } }

    /// *2 sessions · notifications on* — what a row and a confirm count.
    public var sessionsLine: String {
        let n = liveSessions.count
        var parts = [n == 0 ? "Not signed in" : (n == 1 ? "1 session" : "\(n) sessions")]
        if hasPush { parts.append("notifications on") }
        return parts.joined(separator: " · ")
    }
}

// MARK: - The words

public enum DevicesWords {
    public static let remove = "Remove"
    public static let signOutEverywhere = "Sign Out Everywhere"
    public static let thisDevice = "This device"
    /// Under Add a Phone…: what the button does and does not do.
    public static let addNote =
        "Shows a QR code for your phone to scan. The code is minted on this Mac (`metistry enroll`), works once, and dies when you close the sheet. "
        + "The phone creates its own passkey and signs in with Face ID; nothing is sent anywhere else."
    public static let empty = "No phone or browser has been added yet. This Mac signs in on its own, without a passkey."
    public static let removeNote = "Removing a device revokes its passkey and ends every session under it, so it can never sign in again; it is set up again as a new device. It asks first, naming the device."
    public static let signOutNote = "Signs every device out, and keeps its passkey: each one signs in again with Face ID. This Mac is not a device — it stays signed in."
    public static let nothingSignedIn = "No device is signed in."
    public static let onlyOverTheAPI = "Removing and signing out are `POST /api/devices/:id/revoke` — the same door the phone's Settings uses."
}

// MARK: - The model

@MainActor
@Observable
public final class DevicesModel {
    /// What the confirm on screen would do. Nil: none.
    public enum PendingAct: Equatable, Sendable {
        case remove(Device)
        /// Every signed-in device, in the order they are told — the caller's own last.
        case signOutEverywhere([Device])
    }

    public private(set) var devices: [Device] = []
    public private(set) var phase: ReadPhase = .idle
    /// The confirm on screen. Presenting it sends nothing.
    public var confirmation: CostConfirmation?
    public private(set) var pending: PendingAct?
    /// What the last act came to, under the section.
    public private(set) var note: ScheduledNote?
    public private(set) var busy = false
    /// The Add a Phone sheet, while it is open.
    public private(set) var addPhone: AddPhoneModel?

    @ObservationIgnored private weak var session: ConsoleSession?
    @ObservationIgnored public var now: @MainActor () -> Date = Date.init
    @ObservationIgnored public var clock = ClockTime()
    /// The pasteboard, for the sheet's Copy Link; handed in by the platform.
    @ObservationIgnored public var copyText: @MainActor (String) -> Void = { _ in }
    /// Builds the sheet's model. The default is the session's runner and
    /// stores; a test hands in its own.
    @ObservationIgnored public var makeAddPhone: @MainActor () -> AddPhoneModel

    public init(session: ConsoleSession?) {
        self.session = session
        makeAddPhone = { AddPhoneModel(management: session?.management, session: session) }
        // An add or a remove lands in `runs` as kind `auth` (§2.22): the list
        // is refetched through its route, never read off the event.
        session?.events.watch([.runs]) { [weak self] event in
            guard let self else { return false }
            if case .runFinished(_, let kind, _) = event.change, kind == "auth" {
                Task { await self.refresh() }
            }
            return true
        }
    }

    /// Dropped on every instance switch: a device list belongs to the install it was asked about.
    public func reset() {
        devices = []
        phase = .idle
        confirmation = nil
        pending = nil
        note = nil
        busy = false
        if let addPhone {
            self.addPhone = nil
            Task { await addPhone.close() }
        }
    }

    // MARK: Reading

    /// `GET /api/devices`, re-read when the pane opens and after every act.
    public func refresh() async {
        guard let session else {
            phase = .unavailable("no console session for this instance")
            return
        }
        phase = .reading
        switch await session.stores.devices() {
        case .success(let list):
            devices = Device.list(list.json)
            phase = .read
        case .failure(let error):
            phase = .unavailable(error.localizedDescription)
        }
    }

    /// The devices with a live session, others first and the caller's own
    /// last — the order Sign Out Everywhere tells them in.
    public var signedIn: [Device] {
        let live = devices.filter(\.isSignedIn)
        return live.filter { !$0.thisDevice } + live.filter(\.thisDevice)
    }

    /// Why Sign Out Everywhere is off — a fact, always shown. Nil when it may be pressed.
    public var signOutUnavailableReason: String? {
        if case .unavailable(let why) = phase { return why }
        guard phase == .read else { return nil }
        return signedIn.isEmpty ? DevicesWords.nothingSignedIn : nil
    }

    // MARK: Remove

    /// Remove pressed: the confirm, naming the device. Sends nothing.
    public func proposeRemove(_ device: Device) {
        let added = device.added.map { " — added \(clock.moment($0, now: now()))" } ?? ""
        let ends = device.liveSessions.isEmpty ? "no session is signed in" : "\(device.liveSessions.count == 1 ? "its session ends" : "its \(device.liveSessions.count) sessions end")"
        var costs = ["\(device.label)\(added): its passkey is revoked and \(ends)"]
        if device.hasPush { costs.append("Its notifications stop") }
        guard let confirmation = CostConfirmation(
            title: "Remove “\(device.label)”?",
            costHeading: "This cannot be undone. The device is set up again as a new one, with a new passkey:",
            costs: costs,
            confirm: DevicesWords.remove
        ) else { return }
        pending = .remove(device)
        self.confirmation = confirmation
    }

    // MARK: Sign Out Everywhere

    /// Sign Out Everywhere pressed: the confirm, listing every signed-in device. Sends nothing.
    public func proposeSignOutEverywhere() {
        let targets = signedIn
        guard !targets.isEmpty, let confirmation = CostConfirmation(
            title: "Sign Out Everywhere?",
            costHeading: "Each of these signs in again with the passkey it has:",
            costs: targets.map { "\($0.label) · \($0.sessionsLine)" },
            confirm: DevicesWords.signOutEverywhere
        ) else { return }
        pending = .signOutEverywhere(targets)
        self.confirmation = confirmation
    }

    // MARK: The confirm's answer

    /// Only `.confirm` posts. Cancel sends nothing; there is no alternative.
    public func choose(_ choice: CostConfirmView.Choice) async {
        confirmation = nil
        let act = pending
        pending = nil
        guard choice == .confirm, let act, let session else { return }
        busy = true
        defer { busy = false }
        switch act {
        case .remove(let device):
            switch await session.stores.revokeDevice(device.id, scope: .device) {
            case .success(let reply):
                let ended = reply.json.int("sessions") ?? device.liveSessions.count
                note = ScheduledNote(kind: .done, text: "Removed “\(device.label)” — its passkey is revoked and \(ended == 1 ? "1 session" : "\(ended) sessions") ended.")
            case .failure(let error):
                note = ScheduledNote(kind: .failed, text: error.localizedDescription)
            }
        case .signOutEverywhere(let targets):
            var ended = 0
            var failed: [String] = []
            for device in targets {
                switch await session.stores.revokeDevice(device.id, scope: .sessions) {
                case .success(let reply): ended += reply.json.int("sessions") ?? device.liveSessions.count
                case .failure(let error): failed.append("\(device.label): \(error.localizedDescription)")
                }
            }
            note = failed.isEmpty
                ? ScheduledNote(kind: .done, text: "Signed out \(targets.count == 1 ? "1 device" : "\(targets.count) devices") — \(ended == 1 ? "1 session" : "\(ended) sessions") ended; every passkey is kept.")
                : ScheduledNote(kind: .failed, text: failed.joined(separator: "; "))
        }
        await refresh()
    }

    // MARK: Add a Phone…

    /// The sheet opens and starts Checking at once.
    public func beginAddPhone() {
        guard addPhone == nil else { return }
        let model = makeAddPhone()
        model.copyText = { [weak self] text in self?.copyText(text) }
        model.onAdded = { [weak self] _ in Task { await self?.refresh() } }
        addPhone = model
        Task { await model.open() }
    }

    /// Done, Esc, or the sheet dismissed: a live code is cancelled, then the
    /// list is re-read.
    public func closeAddPhone() {
        guard let model = addPhone else { return }
        addPhone = nil
        Task {
            await model.close()
            await refresh()
        }
    }
}

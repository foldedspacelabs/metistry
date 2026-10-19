// Add a Phone (design-build-plan §2.22, X-77): the sheet's model — one
// enrolment code, minted on this Mac, drawn as a QR, and dead when the owner
// is done with it.
//
// THE ROOT OF TRUST DOES NOT MOVE. No HTTP route mints an enrolment code (plan
// §4.2: shell access to the host is the root of trust for a first passkey), so
// the sheet runs `metistry enroll --json` — M19, a `ManagementCommand`, through
// the session's `ManagementRunner` like every other management verb — and
// never asks the console for one. `--cancel <code_id>` runs the same way when
// the sheet closes or the owner asks for a new code, so a QR left on screen or
// in a screenshot is dead the moment the owner is done with it.
//
// THE SHEET, IN ORDER (§2.22): Checking → Refused | Ready → Expired, and
// Added when `GET /api/devices` shows a passkey that was not there when the
// sheet opened. **A refused origin draws no QR**: the CLI refuses BEFORE it
// mints — a loopback host (every install's default), `http:`, an IP literal,
// an origin this Mac cannot reach — and the sheet shows the refusal's own
// words with the fix it names (§3.16: never re-worded) and nothing else.
//
// X-114 adds one state between *Ready* and *Added*: **Opened on your phone**,
// read from `metistry enroll --status <code_id>` once the console stamps
// `auth_enrollment_codes.opened_via` on the proxy listener (§2.23 step 7). It
// goes where `Phase` says, and the arrival check below is where it is read.
//
// Arrival is `GET /api/devices`, refetched on `run.finished` events of kind
// `auth` (an enrolment lands in `runs`, §2.22) and polled while the stream is
// down (§2.20) — no new route, no new read path (invariant 3).

import CoreImage
import Foundation
import Observation

// MARK: - What `metistry enroll --json` says

/// A minted code: `--json`'s one document, `{url, code_id, origin,
/// expires_at}`. `codeID` is the row's id and never the code — the code is in
/// the URL's fragment and nowhere else.
public struct EnrollmentCode: Sendable, Equatable {
    public let url: String
    public let codeID: Int
    public let origin: String
    public let expiresAt: Date

    public init(url: String, codeID: Int, origin: String, expiresAt: Date) {
        self.url = url
        self.codeID = codeID
        self.origin = origin
        self.expiresAt = expiresAt
    }

    public init?(json: JSONValue) {
        guard let url = json.string("url"), let codeID = json.int("code_id"), let origin = json.string("origin"),
              let expiresAt = WireTime.date(json.string("expires_at"))
        else { return nil }
        self.init(url: url, codeID: codeID, origin: origin, expiresAt: expiresAt)
    }

    /// The host the phone must be able to open — what the line under the QR names.
    public var host: String { URL(string: origin)?.host ?? origin }

    public func isLive(at now: Date) -> Bool { expiresAt > now }

    public func remaining(at now: Date) -> TimeInterval { max(expiresAt.timeIntervalSince(now), 0) }

    /// *Expires in 9:41*, counting down; *Expires in 0:00* at the end.
    public func countdown(at now: Date) -> String {
        let seconds = Int(remaining(at: now).rounded(.up))
        return "Expires in \(seconds / 60):\(String(format: "%02d", seconds % 60))"
    }
}

/// A refusal: `{refused: {case, message, origin, fix, detail?}}` — the CLI's
/// own words, shown verbatim (U3: each is a code path with a test in
/// `packages/cli/test/enroll.test.ts`; the sheet adds none of its own).
public struct EnrollmentRefusal: Sendable, Equatable {
    /// `origin_unset`, `origin_invalid`, `loopback`, `http`, `ip_literal`, `unreachable`, `other_instance`.
    public let kind: String
    public let message: String
    public let origin: String?
    /// The pointer every refusal ends with: Settings ▸ Remote Access, `metistry remote`, the guide.
    public let fix: String
    /// The failing probe, when a message alone would hide it.
    public let detail: String?

    public init(kind: String, message: String, origin: String?, fix: String, detail: String? = nil) {
        self.kind = kind
        self.message = message
        self.origin = origin
        self.fix = fix
        self.detail = detail
    }

    public init?(json: JSONValue) {
        guard let kind = json.string("case"), let message = json.string("message"), let fix = json.string("fix") else { return nil }
        self.init(kind: kind, message: message, origin: json.string("origin"), fix: fix, detail: json.string("detail"))
    }
}

// MARK: - The words

public enum AddPhoneWords {
    public static let title = "Add a Phone"
    public static let addAPhone = "Add a Phone…"
    public static let checking = "Checking that your phone could reach this Mac…"
    public static let refusedTitle = "Your phone can't be added yet"
    public static let unavailableTitle = "Could not mint a code"
    public static let expired = "This code expired"
    public static let makeANewCode = "Make a New Code"
    public static let done = "Done"
    public static let copyLink = "Copy Link"
    public static let learnHow = "Learn How"
    /// VoiceOver's name for the image; the URL is its value, the accessible alternative (§2.18).
    public static let qrLabel = "QR code for adding a phone"
    public static let scan = "Scan this with your phone's camera. It works once, for 10 minutes."
    /// The checks are necessary, not sufficient (§2.22): a name that resolves
    /// only on this Mac still passes, so the sheet says what the phone needs.
    public static func mustOpen(_ host: String) -> String { "Your phone must be able to open \(host)." }
    public static func added(_ label: String) -> String { "“\(label)” was added" }
    public static let addedNote = "Your phone has its own passkey now. It signs in with Face ID, and you can remove it from Devices anytime."
    /// The phone guide (X-79 writes it; the website's Docs render this repo's markdown).
    public static let guideURL = URL(string: "https://github.com/foldedspacelabs/metistry/blob/main/docs/ops/phone.md")!
    /// What the sheet runs, said where it runs.
    public static let mintCommand = "metistry enroll --json"
}

// MARK: - The model

@MainActor
@Observable
public final class AddPhoneModel {
    /// The sheet's states, in §2.22's order. **X-114's `openedOnPhone` goes
    /// between `ready` and `added`** — the console saw this code's
    /// `POST /auth/enroll/start` arrive through the proxy listener.
    public enum Phase: Equatable, Sendable {
        /// `metistry enroll --json` is running.
        case checking
        /// The CLI refused before minting; its own words. No QR.
        case refused(EnrollmentRefusal)
        /// The QR, the URL, the countdown.
        case ready(EnrollmentCode)
        /// The code's ten minutes ran out; the QR is replaced, not dimmed.
        case expired(EnrollmentCode)
        /// `GET /api/devices` shows a passkey enrolled after the sheet opened.
        case added(label: String)
        /// The CLI could not answer — no runtime, a CLI older than the verb, no
        /// database — in its own words.
        case unavailable(String)
    }

    public private(set) var phase: Phase = .checking
    /// The minted code that has not expired and has not been cancelled: what
    /// closing the sheet kills. Nil once it is dead, so a second close sends
    /// nothing.
    public private(set) var liveCode: EnrollmentCode?
    /// The QR for `phase == .ready`'s URL, and nil in every other state — the
    /// view draws this, so there is no QR to draw for a refusal.
    public private(set) var qr: CGImage?
    public private(set) var isClosed = false
    /// Cancellations this sheet asked for, newest last: the code ids.
    public private(set) var cancelled: [Int] = []

    /// The clock, injectable: the countdown and the expiry read it.
    @ObservationIgnored public var now: @MainActor () -> Date = Date.init
    /// The pasteboard, handed in by the platform (the kit has no AppKit).
    @ObservationIgnored public var copyText: @MainActor (String) -> Void = { _ in }
    /// Called once with the label the phone chose, when *Added* is reached.
    @ObservationIgnored public var onAdded: @MainActor (String) -> Void = { _ in }
    /// How often `GET /api/devices` is asked while the event stream is down.
    @ObservationIgnored public var pollInterval: Duration = .seconds(5)

    @ObservationIgnored private let management: (any ManagementRunner)?
    @ObservationIgnored private weak var session: ConsoleSession?
    /// The passkeys that were there when the sheet opened; a new one is the arrival.
    @ObservationIgnored private var knownPasskeys: Set<String>?
    @ObservationIgnored private var openedAt: Date?
    @ObservationIgnored private var expiryTask: Task<Void, Never>?
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var watching = false
    /// Moves on every mint and close: a run from before drops what it hears.
    @ObservationIgnored private var generation = 0

    public init(management: (any ManagementRunner)?, session: ConsoleSession?) {
        self.management = management
        self.session = session
    }

    // MARK: Opening

    /// Checking: run `metistry enroll --json`, and read the baseline of
    /// devices the arrival is measured against. Nothing is drawn before the
    /// CLI answers.
    public func open() async {
        openedAt = now()
        await loadBaseline()
        startWatching()
        await mint()
    }

    /// Make a New Code: the old one is cancelled first, then minted again.
    public func makeNewCode() async {
        await cancelLiveCode()
        await mint()
    }

    private func mint() async {
        generation += 1
        let current = generation
        stopExpiry()
        setPhase(.checking)
        guard let management else {
            setPhase(.unavailable("No metistry runtime located — finish step 1 of first run."))
            return
        }
        guard let command = ManagementCommand(.enrollment, ["enroll", "--json"]) else { return }
        let result: CommandResult
        do {
            result = try await management.run(command) { _ in }
        } catch {
            guard current == generation, !isClosed else { return }
            setPhase(.unavailable(error.localizedDescription))
            return
        }
        let document = JSONValue.parseTrailing(in: result.stdout)
        if let minted = document.flatMap(EnrollmentCode.init(json:)) {
            // Minted while the owner was closing the sheet, or after Make a New
            // Code moved on: dead at once, never left live for nobody.
            guard current == generation, !isClosed else {
                await cancel(minted)
                return
            }
            liveCode = minted
            setPhase(.ready(minted))
            scheduleExpiry(minted)
            return
        }
        guard current == generation, !isClosed else { return }
        if let refusal = document?["refused"].flatMap(EnrollmentRefusal.init(json:)) {
            setPhase(.refused(refusal))
        } else if CLIDegradation.isUnknownVerb(result) {
            setPhase(.unavailable(CLIDegradation.message(verb: "enroll")))
        } else {
            setPhase(.unavailable(SettingsModel.cliWords(result, command: AddPhoneWords.mintCommand)))
        }
    }

    private func setPhase(_ phase: Phase) {
        self.phase = phase
        if case .ready(let code) = phase {
            qr = EnrollmentQR.image(for: code.url)
        } else {
            qr = nil
        }
    }

    // MARK: Expiry

    /// The clock reached the code's expiry: the QR is replaced by *This code
    /// expired*. Injected by a test; the real sheet's timer calls it too.
    public func tick(now: Date) {
        guard case .ready(let code) = phase, !code.isLive(at: now) else { return }
        liveCode = nil
        setPhase(.expired(code))
    }

    private func scheduleExpiry(_ code: EnrollmentCode) {
        stopExpiry()
        let wait = code.remaining(at: now())
        expiryTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(wait))
            guard !Task.isCancelled, let self else { return }
            self.tick(now: self.now())
        }
    }

    private func stopExpiry() {
        expiryTask?.cancel()
        expiryTask = nil
    }

    // MARK: Arrival — *Added*

    private func loadBaseline() async {
        guard let session else { return }
        if case .success(let list) = await session.stores.devices() {
            knownPasskeys = Set(Device.list(list.json).map(\.passkeyID))
        }
    }

    private func startWatching() {
        guard !watching, let session else { return }
        watching = true
        // An enrolment lands in `runs` as kind `auth` (§2.22), so `run.finished`
        // of that kind says a device may have arrived; the list is refetched
        // through its own route, never read off the event.
        session.events.watch([.runs]) { [weak self] event in
            guard let self, !self.isClosed else { return false }
            if case .runFinished(_, let kind, _) = event.change, kind == "auth" {
                Task { await self.checkArrival() }
            }
            return true
        }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                try? await Task.sleep(for: self.pollInterval)
                guard !Task.isCancelled, !self.isClosed else { return }
                if self.session?.events.isLive != true { await self.checkArrival() }
            }
        }
    }

    /// `GET /api/devices`: a passkey that was not there when the sheet opened
    /// is the phone. Nothing to compare against — the baseline read failed —
    /// falls back to the passkey's `added` time against when the sheet opened.
    public func checkArrival() async {
        switch phase {
        case .added, .refused: return
        default: break
        }
        guard let session, !isClosed else { return }
        guard case .success(let list) = await session.stores.devices() else { return }
        let devices = Device.list(list.json)
        let arrived = devices.filter { device in
            if let knownPasskeys { return !knownPasskeys.contains(device.passkeyID) }
            guard let added = device.added, let openedAt else { return false }
            return added >= openedAt.addingTimeInterval(-1)
        }
        guard let newest = arrived.max(by: { ($0.added ?? .distantPast) < ($1.added ?? .distantPast) }) else { return }
        stopExpiry()
        setPhase(.added(label: newest.label))
        onAdded(newest.label)
    }

    // MARK: Closing

    /// Done, Esc, the close box: whatever state the sheet is in, a code that
    /// is still live is cancelled before anything else happens.
    public func close() async {
        isClosed = true
        generation += 1
        stopExpiry()
        pollTask?.cancel()
        pollTask = nil
        await cancelLiveCode()
    }

    private func cancelLiveCode() async {
        guard let code = liveCode else { return }
        liveCode = nil
        await cancel(code)
    }

    /// `metistry enroll --cancel <code_id> --json` — the id, never the code.
    /// Its answer is not shown: a code already spent or expired is reported
    /// by the CLI, not an error, and there is nothing for the owner to do.
    private func cancel(_ code: EnrollmentCode) async {
        guard let management, let command = ManagementCommand(.enrollment, ["enroll", "--cancel", String(code.codeID), "--json"]) else { return }
        cancelled.append(code.codeID)
        _ = try? await management.run(command) { _ in }
    }

    // MARK: Copy Link

    public func copyLink() {
        guard case .ready(let code) = phase else { return }
        copyText(code.url)
    }
}

// MARK: - The QR

/// CoreImage's `CIQRCodeGenerator` — part of macOS and iOS, no dependency
/// (§2.22; the objection `mac-app.md` recorded was to an encoder package).
/// Error-correction level M; scaled by an integer factor with nearest-neighbour
/// sampling so the modules stay sharp; a four-module quiet zone baked into the
/// bitmap; dark on light whatever the appearance — scanners need contrast, not
/// the theme.
public enum EnrollmentQR {
    /// Pixels per module.
    public static let scale = 8
    /// Modules of white around the symbol (the standard's quiet zone).
    public static let quietZone = 4

    public static func image(for text: String, scale: Int = scale) -> CGImage? {
        guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        filter.setValue(Data(text.utf8), forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")
        guard let symbol = filter.outputImage else { return nil }
        let factor = CGFloat(max(scale, 1))
        let scaled = symbol.samplingNearest().transformed(by: CGAffineTransform(scaleX: factor, y: factor))
        let margin = CGFloat(quietZone) * factor
        let extent = scaled.extent.insetBy(dx: -margin, dy: -margin)
        let white = CIImage(color: CIColor(red: 1, green: 1, blue: 1)).cropped(to: extent)
        let composed = scaled.composited(over: white)
        return CIContext(options: [.useSoftwareRenderer: true]).createCGImage(composed, from: extent)
    }
}

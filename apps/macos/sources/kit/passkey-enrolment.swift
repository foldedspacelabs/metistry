// Step 6, the door: enrol a passkey.
//
// THE FINDING, up front, because the whole file is shaped by it. A native
// `ASAuthorization` passkey ceremony CANNOT be run against this console's local
// origin, and not for one reason but for four independent ones. Each is checked
// separately below and named on screen, because "passkeys don't work here" is
// not an answer anybody can act on.
//
//   1. `ASAuthorization` synthesizes the ceremony's origin as
//      `https://<relyingPartyIdentifier>` — always https, NEVER a port. The
//      console compares `clientDataJSON.origin` to `METISTRY_ORIGIN` with a
//      plain `!==` (`apps/console/src/webauthn.ts`), so an origin carrying
//      `:8080` can never match, and an `http:` one can never match either.
//   2. The console's RP ID is `new URL(METISTRY_ORIGIN).hostname`. For
//      `http://127.0.0.1:8080` that is the IP literal `127.0.0.1`, which is not
//      a valid WebAuthn relying-party identifier at all — an RP ID is a domain.
//   3. macOS gates the relying-party identifier on the app's
//      `com.apple.developer.associated-domains` entitlement
//      (`webcredentials:<domain>`), which Apple verifies by fetching
//      `https://<domain>/.well-known/apple-app-site-association` through its own
//      CDN. A loopback address, a `.local` name and a tailnet name are all
//      unreachable from that CDN, and this app's entitlements file is
//      deliberately empty (apps/macos/resources/metistry.entitlements explains
//      why at length).
//   4. `localhost` is a valid RP ID in a BROWSER, which is where the console's
//      own PWA flow works — but a browser's secure-context exemption for
//      loopback is not an associated-domain exemption, so (3) still bites.
//
// So the app does what it does everywhere else: it says exactly which of those
// is true of this install, and falls back to the flow that does work — the
// console's own enrolment code, opened in a browser here or typed on a phone.
// A screen that pretended to enrol a passkey would be worse than one that says
// it cannot (docs/product/PRODUCT.md).
//
// The native path is nonetheless WRITTEN, not stubbed: `ConsoleClient` speaks the
// real `/auth/enroll/start` and `/auth/enroll/finish`, and
// `PasskeyRegistrar` is the real `ASAuthorization` call in the executable
// target. When an install's origin is a plain `https://<domain>` on 443 whose
// AASA the app is entitled for, `decide` returns `.native` and that code runs.
// Today no install is, and the screen says so with the reason.

import Foundation
import Observation

/// Which way step 6 can go for THIS install.
public enum PasskeyRoute: Sendable, Equatable {
    /// `ASAuthorization` can be asked, with this relying-party identifier.
    case native(rpID: String)
    /// It cannot, and this is why — verbatim, on screen. The console's own
    /// enrolment-code flow is offered instead.
    case consoleCode(reason: String)

    public var isNative: Bool {
        if case .native = self { return true }
        return false
    }

    public var reason: String? {
        if case .consoleCode(let reason) = self { return reason }
        return nil
    }
}

public enum PasskeyRouting {
    /// Every check, in the order that produces the most useful single sentence.
    ///
    /// `associatedDomains` is what the app is actually entitled for — `[]` for
    /// this build, and passing it in rather than hardcoding `false` is what makes
    /// the rule testable and what makes the day someone adds the entitlement a
    /// one-line change here.
    public static func decide(origin: String, associatedDomains: [String]) -> PasskeyRoute {
        let endpoint = ConsoleEndpoint(origin: origin)
        guard let host = endpoint.host, !host.isEmpty, let scheme = endpoint.scheme else {
            return .consoleCode(reason: "`\(origin)` is not an origin this app can read a host out of. The console's METISTRY_ORIGIN is what defines the relying party.")
        }
        if isIPLiteral(host) {
            return .consoleCode(reason: "This install's origin is `\(origin)`, so the console's relying-party ID is the IP literal `\(host)` (it is `new URL(METISTRY_ORIGIN).hostname`). A WebAuthn relying party must be a domain, so no passkey — native or in a browser — can be registered against it.")
        }
        if scheme != "https" {
            return .consoleCode(reason: "This install's origin is `\(origin)`. ASAuthorization always presents the ceremony's origin as `https://\(host)`, and the console compares that to METISTRY_ORIGIN exactly — so an `\(scheme):` origin can never match.")
        }
        if let port = endpoint.explicitPort {
            return .consoleCode(reason: "This install's origin names port \(port). ASAuthorization's origin carries no port — it is exactly `https://\(host)` — and the console's comparison is on the whole string, so a passkey enrolled natively would be rejected. An origin of `https://\(host)` with no port is the shape that works.")
        }
        if host == "localhost" {
            return .consoleCode(reason: "`localhost` is a valid relying party in a browser, which is why the console's own enrolment page works — but macOS still requires this app to be associated with the domain, and Apple verifies that by fetching https://localhost/.well-known/apple-app-site-association from its own CDN, which cannot reach this Mac.")
        }
        guard associatedDomains.contains(host) else {
            return .consoleCode(reason: "This app is not associated with `\(host)`. macOS only lets an app use a relying-party ID it declares as `webcredentials:\(host)` in com.apple.developer.associated-domains, and Apple verifies that by fetching https://\(host)/.well-known/apple-app-site-association — which needs \(host) reachable from Apple's CDN over HTTPS. This build declares no associated domains (apps/macos/resources/metistry.entitlements).")
        }
        return .native(rpID: host)
    }

    /// An IPv4 dotted quad or anything bracketed/colon-bearing (IPv6). Not a
    /// general address parser: the question is only "is this a domain?", and a
    /// host that is not a domain cannot be a relying party whatever kind of
    /// address it is.
    public static func isIPLiteral(_ host: String) -> Bool {
        if host.contains(":") || host.hasPrefix("[") { return true }
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return false }
        return parts.allSatisfy { part in
            !part.isEmpty && part.allSatisfy(\.isNumber) && (Int(part) ?? 256) <= 255
        }
    }

    /// The origin the app addresses the console at, from doctor's own console
    /// row: `meta.url` is the URL doctor probed (`packages/cli/src/doctor.ts` —
    /// `METISTRY_CONSOLE_URL`, else `http://127.0.0.1:<manifest port>`). A
    /// bridge's own `check()` meta is nested under `bridge_meta` instead, so
    /// both are read and the flat one wins.
    ///
    /// This is the BIND address, which is not necessarily `METISTRY_ORIGIN` — a
    /// tailnet install serves a public origin on a loopback bind. So it is where
    /// the app *talks* to the console, and the RP is asked for separately
    /// (`ConsoleClient.loginOptions`), because only the console knows it.
    public static func consoleURL(in report: DoctorReport?) -> String? {
        guard let meta = report?.rows.first(where: { $0.kind == "service" && $0.name == "console" })?.meta else { return nil }
        return meta.string("url") ?? meta["bridge_meta"]?.string("url")
    }
}

/// The `ASAuthorization` seam. `AuthenticationServices` exists on iOS too, but
/// the controller needs an `ASPresentationAnchor` — an `NSWindow`/`UIWindow` —
/// so the call lives in the platform target and MetistryKit stays free of both.
/// The system's own words about a request it refused. A named type only because
/// `Result`'s failure has to be an `Error`; the message is `NSError`'s domain,
/// code and description, unedited.
public struct PasskeySystemError: Error, Equatable, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
}

public protocol PasskeyRegistrar: Sendable {
    /// Run `ASAuthorizationPlatformPublicKeyCredentialProvider`'s registration
    /// request. On failure the message is the underlying `NSError`, verbatim:
    /// this app never paraphrases what the system said.
    func register(
        rpID: String,
        challenge: Data,
        userID: Data,
        userName: String
    ) async -> Result<PasskeyRegistrationResponse, PasskeySystemError>
}

@MainActor
@Observable
public final class PasskeyEnrolmentModel {
    public enum Phase: Equatable, Sendable {
        case idle
        /// Talking to the console (health, or the RP).
        case asking
        /// The ceremony is up and macOS is showing its sheet.
        case enrolling
        case enrolled(String)
        case failed(String)
    }

    /// Where the enrolment code comes from today. There is no HTTP route that
    /// mints one — deliberately: the root of trust for a first passkey is shell
    /// access to the host (metistry-build-plan.md §4.2, "Recovery") — and
    /// `metistry enroll` is on the CLI's own "Not yet" list (docs/ops/cli.md).
    /// So the app names the command instead of pretending to have a button for
    /// it, and takes the code the user pastes back.
    public nonisolated static func mintCommand(shape: String?) -> String {
        shape == "compose"
            ? "docker compose exec console node scripts/enroll.mjs"
            : "node <product>/apps/console/scripts/enroll.mjs"
    }

    public nonisolated static let mintNote =
        "The code is single-use and lasts ten minutes. Nothing mints one over HTTP on purpose: whoever can run that command "
        + "already controls Postgres and the vault, so shell access to the host is the root of trust for a first passkey "
        + "(plan §4.2). A `metistry enroll` verb would replace the command above; it is on the CLI's own \"not yet\" list."

    /// What the fallback does with the code, and where a QR would go. There is
    /// no QR renderer anywhere in this product yet — `apps/console/scripts/enroll.mjs`
    /// says so itself ("QR rendering arrives with packages/cli") — so the app
    /// shows the URL rather than shipping an encoder nobody asked for.
    public nonisolated static let fallbackNote =
        "Open the link here to enrol this Mac in a browser, or type it on the phone to enrol the phone. It is the console's own "
        + "page — the same flow, the same `passkeys` row — and it works because a browser's relying party may be a loopback or "
        + "a tailnet name, which a native ceremony's may not."

    private let registrar: (any PasskeyRegistrar)?
    private let transport: any ConsoleTransport
    /// What this build is entitled for. `[]` today; see the header.
    public let associatedDomains: [String]

    public private(set) var endpoint: ConsoleEndpoint?
    public private(set) var route: PasskeyRoute?
    public private(set) var phase: Phase = .idle
    /// The console's own answer about its relying party, when it has been asked.
    public private(set) var reportedRPID: String?
    public private(set) var consoleReachable: Bool?
    /// The verbatim `ASAuthorization` error from the last diagnostic run — the
    /// evidence behind the reason on screen, rather than an assertion of it.
    public private(set) var diagnostic: String?

    public var enrolmentCode: String = ""
    public var deviceLabel: String = "this Mac"

    public init(
        registrar: (any PasskeyRegistrar)? = nil,
        transport: any ConsoleTransport = URLSessionConsoleTransport(),
        associatedDomains: [String] = []
    ) {
        self.registrar = registrar
        self.transport = transport
        self.associatedDomains = associatedDomains
    }

    /// Point at the console doctor reported, and decide the route from the origin
    /// alone. Nothing is sent anywhere by this.
    public func adopt(consoleURL: String?) {
        guard let consoleURL else {
            endpoint = nil
            route = .consoleCode(reason: "Doctor has not reported the console yet, so the app does not know its origin. Run doctor from the Status window.")
            return
        }
        let endpoint = ConsoleEndpoint(origin: consoleURL)
        self.endpoint = endpoint
        route = PasskeyRouting.decide(origin: endpoint.origin, associatedDomains: associatedDomains)
    }

    public var enrolmentURL: URL? {
        let code = enrolmentCode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !code.isEmpty else { return nil }
        return endpoint?.enrolmentURL(code: code)
    }

    /// `GET /health` and `POST /auth/login/start`: is the console up, and what
    /// relying party does it actually think it has? The second is asked once,
    /// when the user presses the button — it costs the console one in-memory
    /// challenge with a five-minute life, which is not something to poll.
    public func askTheConsole() async {
        guard let endpoint else { return }
        let client = ConsoleClient(endpoint: endpoint, transport: transport)
        phase = .asking
        switch await client.health() {
        case .success(let ok):
            consoleReachable = ok
        case .failure(let error):
            consoleReachable = false
            phase = .failed(error.localizedDescription ?? "unavailable")
            return
        }
        switch await client.loginOptions() {
        case .success(let options):
            reportedRPID = options.rpID
            // The console's own answer wins over the URL doctor probed: a
            // tailnet install serves a public origin over a loopback bind, and
            // only the console knows METISTRY_ORIGIN.
            route = PasskeyRouting.decide(origin: "https://\(options.rpID)", associatedDomains: associatedDomains)
            phase = .idle
        case .failure(let error):
            phase = .failed(error.localizedDescription ?? "unavailable")
        }
    }

    /// The `ASAuthorization` request, run for its ERROR. No enrolment code is
    /// used, no challenge comes from the console and nothing is posted back —
    /// the challenge is 32 local random bytes, so this cannot register anything
    /// anywhere. It exists so the reason on screen is evidence rather than a
    /// claim: press it and macOS says, in its own words, why the relying party
    /// is refused.
    public func runDiagnostic() async {
        guard let registrar else {
            diagnostic = "no ASAuthorization on this build — the diagnostic needs the app target's registrar"
            return
        }
        let rpID = reportedRPID ?? endpoint?.host ?? "127.0.0.1"
        // `SystemRandomNumberGenerator` is documented as cryptographically
        // secure on Apple platforms, and this challenge is never sent anywhere
        // regardless — the point of the diagnostic is the error, not a
        // credential.
        let challenge = Data((0..<32).map { _ in UInt8.random(in: UInt8.min...UInt8.max) })
        phase = .enrolling
        let result = await registrar.register(rpID: rpID, challenge: challenge, userID: Data("owner".utf8), userName: "owner")
        switch result {
        case .success:
            diagnostic = "ASAuthorization ACCEPTED the relying party `\(rpID)` and produced a credential. Nothing was sent to the console — this diagnostic uses a local challenge — but it means the native route is open for this origin."
            phase = .idle
        case .failure(let error):
            diagnostic = error.message
            phase = .idle
        }
    }

    /// The real thing, for an install whose origin the native route accepts:
    /// `/auth/enroll/start`, the ceremony, `/auth/enroll/finish`.
    ///
    /// The session cookie the console returns is DISCARDED here. The app has no
    /// authenticated console surface yet — every panel it shows comes from a
    /// `metistry` verb — so holding a credential it has no use for would be a
    /// secret kept for nothing.
    public func enrol() async {
        guard case .native(let rpID)? = route, let endpoint, let registrar else { return }
        let code = enrolmentCode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !code.isEmpty else {
            phase = .failed("paste the enrolment code first")
            return
        }
        let client = ConsoleClient(endpoint: endpoint, transport: transport)
        phase = .asking
        let options: ConsoleRegistrationOptions
        switch await client.enrolmentOptions(code: code) {
        case .success(let value): options = value
        case .failure(let error):
            phase = .failed(error.localizedDescription ?? "unavailable")
            return
        }
        guard let challenge = Base64URL.decode(options.challengeBase64URL),
              let userID = Base64URL.decode(options.userIDBase64URL)
        else {
            phase = .failed("the console's challenge was not base64url")
            return
        }
        phase = .enrolling
        let credential: PasskeyRegistrationResponse
        switch await registrar.register(rpID: rpID, challenge: challenge, userID: userID, userName: options.userName) {
        case .success(let value): credential = value
        case .failure(let error):
            diagnostic = error.message
            phase = .failed(error.message)
            return
        }
        switch await client.finishEnrolment(code: code, label: deviceLabel, response: credential) {
        case .success:
            enrolmentCode = ""
            phase = .enrolled("enrolled as “\(deviceLabel)” — the console has a door")
        case .failure(let error):
            phase = .failed(error.localizedDescription ?? "unavailable")
        }
    }
}

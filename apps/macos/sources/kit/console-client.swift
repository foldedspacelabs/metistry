// The app's first HTTP client for the console, and it speaks exactly the four
// routes the PWA speaks — no more.
//
// `apps/console/web/app.js` is the reference implementation and this mirrors it
// field for field: `POST /auth/enroll/start` with `{code}` answering
// `{options}`, `POST /auth/enroll/finish` with `{code, label, response}`
// answering `{ok}` plus a `metistry_session` cookie, `POST /auth/login/start`
// answering `{key, options}`, and `GET /health`. There are no private endpoints
// for the app (docs/product/desktop-app-plan.md, ratified: "no private
// endpoints"), so a native client that needed a route the PWA does not have
// would be a design error rather than a missing feature.
//
// WHAT THIS IS NOT. It is not a second read path into state (invariant 3): the
// only things asked for here are the WebAuthn ceremony's own challenge and the
// console's liveness. Everything else the app shows still comes from a
// `metistry` verb.

import Foundation

/// The console, as the app addresses it.
public struct ConsoleEndpoint: Sendable, Equatable {
    /// The origin, verbatim — scheme, host and port as the console was told them.
    public let origin: String

    public init(origin: String) {
        self.origin = origin.hasSuffix("/") ? String(origin.dropLast()) : origin
    }

    public var url: URL? { URL(string: origin) }
    public var host: String? { url?.host }
    public var scheme: String? { url?.scheme }
    /// The port only when it was written down. `URLComponents.port` is nil for
    /// an origin with no `:port`, which is exactly the distinction that matters
    /// here (see passkey-enrolment.swift).
    public var explicitPort: Int? { URLComponents(string: origin)?.port }

    /// `<origin>/#enroll=<code>` — the enrolment URL `apps/console/scripts/enroll.mjs`
    /// prints and `apps/console/web/app.js` reads out of `location.hash`. The
    /// code is in the FRAGMENT on purpose: a fragment is never sent to the
    /// server in the initial GET.
    public func enrolmentURL(code: String) -> URL? {
        URL(string: "\(origin)/#enroll=\(code)")
    }
}

/// `{"error":{"code":…,"message":…}}` — `packages/core/src/errors.ts`'s envelope,
/// which every console route answers with.
public struct ConsoleErrorEnvelope: Sendable, Equatable {
    public let code: String
    public let message: String

    public init?(json: JSONValue) {
        guard let error = json["error"], let code = error.string("code") else { return nil }
        self.code = code
        self.message = error.string("message") ?? code
    }
}

public enum ConsoleError: LocalizedError, Equatable {
    case badOrigin(String)
    case transport(String)
    case http(status: Int, envelope: ConsoleErrorEnvelope?)
    case undecodable(String)

    public var errorDescription: String? {
        switch self {
        case .badOrigin(let origin):
            return "`\(origin)` is not a URL this app can address the console at"
        case .transport(let detail):
            return "could not reach the console: \(detail)"
        case .http(let status, let envelope):
            // 500 is the console's answer to a WebAuthn verification that
            // THREW rather than returned false — an origin, RP-ID, challenge or
            // user-verification mismatch (apps/console/src/server.ts's top-level
            // catch). Saying so beats "internal error", which is all the body
            // carries.
            let detail = envelope.map { "\($0.code): \($0.message)" } ?? "no error body"
            if status == 500 {
                return "the console returned 500 (\(detail)) — for an /auth/ route that is a verification mismatch: the origin, RP ID, challenge or user verification did not match what it expected"
            }
            return "the console returned \(status) (\(detail))"
        case .undecodable(let detail):
            return "could not read the console's reply: \(detail)"
        }
    }
}

/// `POST /auth/login/start`'s reply. The app asks for it for ONE field: `rpId`.
/// It is the only public route that reports the relying-party identifier the
/// console computed from `METISTRY_ORIGIN`, so it is how the app learns the RP
/// rather than guessing it from the URL doctor happened to probe.
public struct ConsoleLoginOptions: Sendable, Equatable {
    public let key: String
    public let rpID: String

    public init?(json: JSONValue) {
        guard let key = json.string("key"), let rpID = json["options"]?.string("rpId", "rp_id") else { return nil }
        self.key = key
        self.rpID = rpID
    }
}

/// `POST /auth/enroll/start`'s `{options}` — `PublicKeyCredentialCreationOptionsJSON`
/// as `@simplewebauthn/server` v13 emits it. Only the fields the ceremony needs
/// are read; the rest are the library's and are not the app's business.
public struct ConsoleRegistrationOptions: Sendable, Equatable {
    /// base64url, unpadded — handed to `ASAuthorization` as raw bytes and
    /// echoed back inside `clientDataJSON` verbatim.
    public let challengeBase64URL: String
    public let rpID: String
    public let rpName: String
    public let userIDBase64URL: String
    public let userName: String

    public init?(json: JSONValue) {
        guard let options = json["options"] ?? Optional(json),
              let challenge = options.string("challenge"),
              let rpID = options["rp"]?.string("id"),
              let userID = options["user"]?.string("id")
        else { return nil }
        self.challengeBase64URL = challenge
        self.rpID = rpID
        self.rpName = options["rp"]?.string("name") ?? "metistry"
        self.userIDBase64URL = userID
        self.userName = options["user"]?.string("name") ?? "owner"
    }
}

/// `RegistrationResponseJSON`, the object `@simplewebauthn/browser` posts back
/// under `response` and the app builds by hand from
/// `ASAuthorizationPlatformPublicKeyCredentialRegistration`.
///
/// Every byte string is base64url, UNPADDED (RFC 4648 §5) — the library's
/// encoder emits it that way and the server's decoder assumes it.
public struct PasskeyRegistrationResponse: Sendable, Equatable {
    public let credentialIDBase64URL: String
    public let clientDataJSONBase64URL: String
    public let attestationObjectBase64URL: String

    public init(credentialIDBase64URL: String, clientDataJSONBase64URL: String, attestationObjectBase64URL: String) {
        self.credentialIDBase64URL = credentialIDBase64URL
        self.clientDataJSONBase64URL = clientDataJSONBase64URL
        self.attestationObjectBase64URL = attestationObjectBase64URL
    }

    /// `id` and `rawId` are the same value; `type` is the literal
    /// `"public-key"`, which the server checks; `clientExtensionResults` is a
    /// required key that may be empty.
    public var wireBody: [String: Any] {
        [
            "id": credentialIDBase64URL,
            "rawId": credentialIDBase64URL,
            "type": "public-key",
            "clientExtensionResults": [String: Any](),
            "response": [
                "clientDataJSON": clientDataJSONBase64URL,
                "attestationObject": attestationObjectBase64URL,
            ],
        ]
    }
}

/// Base64url without padding, the only encoding on this wire.
public enum Base64URL {
    public static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func decode(_ string: String) -> Data? {
        var s = string.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        s += String(repeating: "=", count: (4 - s.count % 4) % 4)
        return Data(base64Encoded: s)
    }
}

/// The transport, behind a protocol so the models are testable without a
/// server — the same reason `CommandRunner` is one.
public protocol ConsoleTransport: Sendable {
    /// Returns the status, the body and the `Set-Cookie` header verbatim.
    func send(
        method: String,
        url: URL,
        body: Data?,
        cookie: String?
    ) async throws -> (status: Int, body: Data, setCookie: String?)
}

public struct URLSessionConsoleTransport: ConsoleTransport {
    private let timeout: TimeInterval

    public init(timeout: TimeInterval = 10) {
        self.timeout = timeout
    }

    public func send(
        method: String,
        url: URL,
        body: Data?,
        cookie: String?
    ) async throws -> (status: Int, body: Data, setCookie: String?) {
        var request = URLRequest(url: url, timeoutInterval: timeout)
        request.httpMethod = method
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "content-type")
        }
        if let cookie { request.setValue(cookie, forHTTPHeaderField: "cookie") }
        // The session cookie is the app's to hold and replay: it is HttpOnly and
        // the console has no Authorization path to a SESSION, only to an owner
        // token, which is 403 on every management route by design.
        request.httpShouldHandleCookies = false
        let (data, response) = try await URLSession.shared.data(for: request)
        let http = response as? HTTPURLResponse
        return (http?.statusCode ?? 0, data, http?.value(forHTTPHeaderField: "set-cookie"))
    }
}

public struct ConsoleClient: Sendable {
    public let endpoint: ConsoleEndpoint
    private let transport: any ConsoleTransport

    public init(endpoint: ConsoleEndpoint, transport: any ConsoleTransport = URLSessionConsoleTransport()) {
        self.endpoint = endpoint
        self.transport = transport
    }

    private func call(_ method: String, _ path: String, body: [String: Any]? = nil) async -> Result<(JSONValue, String?), ConsoleError> {
        guard let url = URL(string: endpoint.origin + path) else {
            return .failure(.badOrigin(endpoint.origin))
        }
        var payload: Data?
        if let body {
            guard let encoded = try? JSONSerialization.data(withJSONObject: body) else {
                return .failure(.undecodable("could not encode the request body"))
            }
            payload = encoded
        }
        let reply: (status: Int, body: Data, setCookie: String?)
        do {
            reply = try await transport.send(method: method, url: url, body: payload, cookie: nil)
        } catch {
            return .failure(.transport(error.localizedDescription))
        }
        let json = (try? JSONValue.parse(reply.body)) ?? .null
        guard (200..<300).contains(reply.status) else {
            return .failure(.http(status: reply.status, envelope: ConsoleErrorEnvelope(json: json)))
        }
        return .success((json, reply.setCookie))
    }

    /// `GET /health` — public, and the only genuinely side-effect-free probe the
    /// console has.
    public func health() async -> Result<Bool, ConsoleError> {
        (await call("GET", "/health")).map { $0.0.bool("ok") ?? false }
    }

    /// `POST /auth/login/start` — public, no body. Asked for `options.rpId` and
    /// nothing else.
    ///
    /// It is not free: the console keeps the challenge it mints in an in-memory
    /// map for five minutes. One call when the step is opened, never a poll.
    public func loginOptions() async -> Result<ConsoleLoginOptions, ConsoleError> {
        switch await call("POST", "/auth/login/start") {
        case .success(let (json, _)):
            guard let options = ConsoleLoginOptions(json: json) else {
                return .failure(.undecodable("no options.rpId in /auth/login/start's reply"))
            }
            return .success(options)
        case .failure(let error):
            return .failure(error)
        }
    }

    /// `POST /auth/enroll/start` — the enrolment code, for the ceremony's
    /// options. A code that is unknown, used or expired is a uniform 401.
    public func enrolmentOptions(code: String) async -> Result<ConsoleRegistrationOptions, ConsoleError> {
        switch await call("POST", "/auth/enroll/start", body: ["code": code]) {
        case .success(let (json, _)):
            guard let options = ConsoleRegistrationOptions(json: json) else {
                return .failure(.undecodable("no options in /auth/enroll/start's reply"))
            }
            return .success(options)
        case .failure(let error):
            return .failure(error)
        }
    }

    /// `POST /auth/enroll/finish` — the credential, verbatim, under `response`.
    /// Returns the `Set-Cookie` value: the session is a cookie and only a
    /// cookie.
    public func finishEnrolment(
        code: String,
        label: String,
        response: PasskeyRegistrationResponse
    ) async -> Result<String?, ConsoleError> {
        let body: [String: Any] = ["code": code, "label": label, "response": response.wireBody]
        switch await call("POST", "/auth/enroll/finish", body: body) {
        case .success(let (_, cookie)): return .success(cookie)
        case .failure(let error): return .failure(error)
        }
    }
}

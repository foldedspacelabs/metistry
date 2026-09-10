// Step 6's decision, and the four independent reasons a native ceremony cannot
// run against a local origin.
//
// The point of testing this as a pure function is that the reason on screen is
// checkable. "Passkeys don't work here" is not an answer; "your origin names a
// port and ASAuthorization's does not" is.

import Foundation
import Testing

@testable import MetistryKit

@Test func aLoopbackOriginHasNoRelyingPartyAtAll() {
    // `metistry doctor`'s default console URL, and the shape a fresh install has.
    let route = PasskeyRouting.decide(origin: "http://127.0.0.1:8080", associatedDomains: [])
    #expect(!route.isNative)
    let reason = try! #require(route.reason)
    // An RP ID is `new URL(METISTRY_ORIGIN).hostname` (apps/console/src/webauthn.ts),
    // and an IP literal is not a domain — so no passkey, native or in a browser,
    // can bind to it. That is the FIRST thing to say, before anything about
    // entitlements.
    #expect(reason.contains("127.0.0.1"))
    #expect(reason.contains("must be a domain"))
}

@Test func anHttpOriginCanNeverMatchWhatASAuthorizationPresents() {
    let route = PasskeyRouting.decide(origin: "http://studio.example.com", associatedDomains: ["studio.example.com"])
    let reason = try! #require(route.reason)
    // ASAuthorization synthesizes the ceremony origin as https://<rpID>, and the
    // console compares it to METISTRY_ORIGIN with a plain !==.
    #expect(reason.contains("https://studio.example.com"))
    #expect(reason.contains("http:"))
}

@Test func aPortInTheOriginIsTheTrapWorthNamingOnItsOwn() {
    let route = PasskeyRouting.decide(origin: "https://studio.ts.net:8443", associatedDomains: ["studio.ts.net"])
    let reason = try! #require(route.reason)
    #expect(reason.contains("8443"))
    // And it says what WOULD work, because this one is fixable by the person.
    #expect(reason.contains("https://studio.ts.net"))
    #expect(reason.contains("no port"))
}

@Test func localhostWorksInABrowserAndStillNotHere() {
    let route = PasskeyRouting.decide(origin: "https://localhost", associatedDomains: ["localhost"])
    let reason = try! #require(route.reason)
    // The distinction that matters: the console's own page works, which is why
    // the fallback is the fallback. A browser's loopback secure-context
    // exemption is not an associated-domain exemption.
    #expect(reason.contains("browser"))
    #expect(reason.contains("apple-app-site-association"))
}

@Test func aDomainThisAppIsNotAssociatedWithIsRefusedWithTheEntitlementNamed() {
    let route = PasskeyRouting.decide(origin: "https://studio.ts.net", associatedDomains: [])
    let reason = try! #require(route.reason)
    #expect(reason.contains("webcredentials:studio.ts.net"))
    #expect(reason.contains("associated-domains"))
    // And the obstacle behind it, which no origin change fixes.
    #expect(reason.contains("an application identifier"))
}

@Test func theMeasuredDistributionObstacleIsSaidOutLoud() {
    // Measured, not assumed: a Developer ID build signed with this project's
    // identity gets AuthorizationError 1004 for 127.0.0.1, localhost AND
    // studio.ts.net alike, and hand-signing the entitlement gets it SIGKILLed at
    // launch. That is a distribution problem, not an origin problem, and the
    // step must not let someone spend a day fixing METISTRY_ORIGIN over it.
    #expect(PasskeyRouting.distributionNote.contains("1004"))
    #expect(PasskeyRouting.distributionNote.contains("provisioning profile"))
    #expect(PasskeyRouting.distributionNote.contains("Developer ID"))
}

@Test func theNativeRouteOpensOnlyForAnHttpsDomainOnFourFourThreeThisAppIsEntitledFor() {
    // The one shape that passes every check. No install has it today, which is
    // exactly why every other case above says so rather than failing silently.
    let route = PasskeyRouting.decide(origin: "https://studio.ts.net", associatedDomains: ["studio.ts.net"])
    #expect(route == .native(rpID: "studio.ts.net"))
    #expect(route.reason == nil)
}

@Test func anOriginThatIsNotAURLIsSaidSoRatherThanCrashing() {
    #expect(!PasskeyRouting.decide(origin: "", associatedDomains: []).isNative)
    #expect(!PasskeyRouting.decide(origin: "not a url", associatedDomains: []).isNative)
}

@Test func ipLiteralsAreTheOnesThatAreNotDomains() {
    #expect(PasskeyRouting.isIPLiteral("127.0.0.1"))
    #expect(PasskeyRouting.isIPLiteral("192.168.1.42"))
    #expect(PasskeyRouting.isIPLiteral("::1"))
    #expect(PasskeyRouting.isIPLiteral("[::1]"))
    #expect(!PasskeyRouting.isIPLiteral("localhost"))
    #expect(!PasskeyRouting.isIPLiteral("studio.ts.net"))
    #expect(!PasskeyRouting.isIPLiteral("studio.local"))
    // A dotted quad out of range is a (silly) hostname, not an address.
    #expect(!PasskeyRouting.isIPLiteral("999.1.1.1"))
}

@Test func theConsoleURLComesFromDoctorsOwnRow() {
    let report = try! DoctorReport.decode(from: Data(sampleDoctorJSON.utf8))
    #expect(PasskeyRouting.consoleURL(in: report) == "http://127.0.0.1:8080")
    #expect(PasskeyRouting.consoleURL(in: nil) == nil)
}

// MARK: - The wire shapes the console's own PWA uses

@Test func theEnrolmentURLPutsTheCodeInTheFragment() {
    // apps/console/web/app.js reads it out of location.hash — a fragment is
    // never sent to the server in the initial GET.
    let endpoint = ConsoleEndpoint(origin: "http://127.0.0.1:8080/")
    #expect(endpoint.origin == "http://127.0.0.1:8080")
    #expect(endpoint.enrolmentURL(code: "abc123")?.absoluteString == "http://127.0.0.1:8080/#enroll=abc123")
    #expect(endpoint.explicitPort == 8080)
    #expect(ConsoleEndpoint(origin: "https://studio.ts.net").explicitPort == nil)
}

@Test func theRegistrationBodyIsTheShapeSimpleWebAuthnExpects() {
    let response = PasskeyRegistrationResponse(
        credentialIDBase64URL: "Y3JlZA",
        clientDataJSONBase64URL: "Y2xpZW50",
        attestationObjectBase64URL: "YXR0ZXN0"
    )
    let body = response.wireBody
    // id and rawId are the same value; `type` is checked by the server.
    #expect(body["id"] as? String == "Y3JlZA")
    #expect(body["rawId"] as? String == "Y3JlZA")
    #expect(body["type"] as? String == "public-key")
    #expect(body["clientExtensionResults"] != nil)
    let inner = try! #require(body["response"] as? [String: Any])
    #expect(inner["clientDataJSON"] as? String == "Y2xpZW50")
    #expect(inner["attestationObject"] as? String == "YXR0ZXN0")
}

@Test func base64UrlIsUnpaddedBothWays() {
    // @simplewebauthn's encoder emits unpadded RFC 4648 §5 and its decoder
    // assumes it.
    let data = Data([0xFB, 0xFF, 0xFE, 0x00, 0x01])
    let encoded = Base64URL.encode(data)
    #expect(!encoded.contains("="))
    #expect(!encoded.contains("+"))
    #expect(!encoded.contains("/"))
    #expect(Base64URL.decode(encoded) == data)
    // And a padded one still decodes, because the console is not the only thing
    // that will ever hand us one.
    #expect(Base64URL.decode("Y3JlZA==") == Base64URL.decode("Y3JlZA"))
}

@Test func theConsolesRegistrationOptionsAreReadFromItsEnvelope() {
    // Verbatim shape of POST /auth/enroll/start's reply.
    let json = try! JSONValue.parse(Data("""
    { "options": {
        "challenge": "Y2hhbGxlbmdl",
        "rp": { "name": "metistry", "id": "studio.ts.net" },
        "user": { "id": "dXNlcg", "name": "owner", "displayName": "" },
        "timeout": 60000, "attestation": "none"
    } }
    """.utf8))
    let options = try! #require(ConsoleRegistrationOptions(json: json))
    #expect(options.rpID == "studio.ts.net")
    #expect(options.challengeBase64URL == "Y2hhbGxlbmdl")
    #expect(options.userIDBase64URL == "dXNlcg")
    #expect(options.userName == "owner")
}

@Test func theLoginOptionsCarryTheRelyingPartyTheConsoleActuallyHas() {
    // The only PUBLIC route that reports one — note `rpId`, not `rp.id`: the
    // request options and the creation options spell it differently.
    let json = try! JSONValue.parse(Data("""
    { "key": "0d1e", "options": { "rpId": "studio.ts.net", "challenge": "Yw", "timeout": 60000 } }
    """.utf8))
    let options = try! #require(ConsoleLoginOptions(json: json))
    #expect(options.key == "0d1e")
    #expect(options.rpID == "studio.ts.net")
}

@Test func aFiveHundredFromAnAuthRouteIsExplainedRatherThanEchoed() {
    // The console's verify throws (rather than returning false) on an origin,
    // RP-ID, challenge or UV mismatch, and the top-level handler turns that into
    // `internal`. "internal error" alone would send someone hunting the wrong
    // thing.
    let envelope = ConsoleErrorEnvelope(json: try! JSONValue.parse(Data(
        #"{"error":{"code":"internal","message":"internal error"}}"#.utf8
    )))
    let described = ConsoleError.http(status: 500, envelope: envelope).localizedDescription
    #expect(described.contains("verification mismatch"))
    #expect(described.contains("origin"))
}

@MainActor
@Test func theFallbackIsOfferedWithAReasonAndAWorkingLink() {
    let model = PasskeyEnrolmentModel()
    model.adopt(consoleURL: "http://127.0.0.1:8080")
    #expect(model.route?.isNative == false)
    #expect(model.route?.reason?.isEmpty == false)
    // No code, no link: the app does not invent one.
    #expect(model.enrolmentURL == nil)
    model.enrolmentCode = "  YWJjZGVmZ2hpamtsbW5vcA  "
    #expect(model.enrolmentURL?.absoluteString == "http://127.0.0.1:8080/#enroll=YWJjZGVmZ2hpamtsbW5vcA")
}

@MainActor
@Test func withNoConsoleReportedTheStepSaysThatRatherThanGuessing() {
    let model = PasskeyEnrolmentModel()
    model.adopt(consoleURL: nil)
    #expect(model.endpoint == nil)
    #expect(model.route?.reason?.contains("doctor") == true)
}

@MainActor
@Test func enrolDoesNothingAtAllWhenTheRouteIsClosed() async {
    // The guard that matters: a route that decided "console code" cannot be
    // walked into by pressing something. Nothing is sent anywhere.
    let transport = RecordingTransport()
    let model = PasskeyEnrolmentModel(registrar: RefusingRegistrar(), transport: transport, associatedDomains: [])
    model.adopt(consoleURL: "http://127.0.0.1:8080")
    model.enrolmentCode = "abc"
    await model.enrol()
    #expect(transport.calls.isEmpty)
    #expect(model.phase == .idle)
}

@MainActor
@Test func theDiagnosticSendsNothingAndReportsWhatTheSystemSaid() async {
    let transport = RecordingTransport()
    let registrar = RefusingRegistrar(
        message: "com.apple.AuthenticationServices.AuthorizationError 1004: Application with identifier TEAMID.com.foldedspacelabs.metistry is not associated with domain 127.0.0.1"
    )
    let model = PasskeyEnrolmentModel(registrar: registrar, transport: transport)
    model.adopt(consoleURL: "http://127.0.0.1:8080")
    await model.runDiagnostic()
    #expect(model.diagnostic?.contains("1004") == true)
    #expect(model.diagnostic?.contains("not associated with domain") == true)
    // The whole point: it costs the console nothing and can enrol nothing.
    #expect(transport.calls.isEmpty)
    #expect(registrar.attempts.first?.rpID == "127.0.0.1")
    #expect(registrar.attempts.first?.challengeCount == 32)
}

private final class RefusingRegistrar: PasskeyRegistrar, @unchecked Sendable {
    struct Attempt: Sendable { let rpID: String; let challengeCount: Int }
    let message: String
    private(set) var attempts: [Attempt] = []

    init(message: String = "refused") { self.message = message }

    func register(rpID: String, challenge: Data, userID: Data, userName: String) async -> Result<PasskeyRegistrationResponse, PasskeySystemError> {
        attempts.append(Attempt(rpID: rpID, challengeCount: challenge.count))
        return .failure(PasskeySystemError(message))
    }
}

private final class RecordingTransport: ConsoleTransport, @unchecked Sendable {
    private(set) var calls: [String] = []

    func send(method: String, url: URL, body: Data?, cookie: String?) async throws -> (status: Int, body: Data, setCookie: String?) {
        calls.append("\(method) \(url.path)")
        return (200, Data("{}".utf8), nil)
    }
}

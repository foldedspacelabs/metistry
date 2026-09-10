// `ASAuthorizationPlatformPublicKeyCredentialProvider`, the real call.
//
// It lives here rather than in MetistryKit because an `ASAuthorizationController`
// needs an `ASPresentationAnchor` — an `NSWindow` on this platform, a `UIWindow`
// on the other — and the kit holds no AppKit. The kit decides WHETHER to make
// this call (passkey-enrolment.swift, `PasskeyRouting.decide`); this makes it and
// hands back either the three base64url strings the console wants or the
// system's error verbatim.
//
// NOTHING HERE PARAPHRASES macOS. The failure case is the `NSError`'s domain,
// code and description as given, because the whole value of the diagnostic in
// step 6 is being able to read what the system actually said about a
// relying-party identifier it would not accept.

import AppKit
import AuthenticationServices
import Foundation
import MetistryKit

final class ASAuthorizationPasskeyRegistrar: NSObject, PasskeyRegistrar,
    ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding
{
    /// One in flight at a time — a second sheet over the first is not a state
    /// the system offers.
    private var continuation: CheckedContinuation<Result<PasskeyRegistrationResponse, PasskeySystemError>, Never>?
    private var controller: ASAuthorizationController?

    func register(
        rpID: String,
        challenge: Data,
        userID: Data,
        userName: String
    ) async -> Result<PasskeyRegistrationResponse, PasskeySystemError> {
        await withCheckedContinuation { continuation in
            Task { @MainActor in
                if self.continuation != nil {
                    continuation.resume(returning: .failure(PasskeySystemError("a passkey request is already on screen")))
                    return
                }
                self.continuation = continuation
                let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpID)
                let request = provider.createCredentialRegistrationRequest(
                    challenge: challenge,
                    name: userName,
                    userID: userID
                )
                // The console's `generateRegistrationOptions` asks for
                // `userVerification: "preferred"`, but `@simplewebauthn/server`
                // v13's VERIFY defaults `requireUserVerification` to true and
                // the console does not override it — so the ceremony has to
                // actually do Touch ID or the check fails server-side.
                request.userVerificationPreference = .required
                let controller = ASAuthorizationController(authorizationRequests: [request])
                controller.delegate = self
                controller.presentationContextProvider = self
                self.controller = controller
                controller.performRequests()
            }
        }
    }

    // MARK: - ASAuthorizationControllerDelegate

    func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        guard let registration = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration else {
            finish(.failure(PasskeySystemError("ASAuthorization returned a \(type(of: authorization.credential)), not a platform passkey registration")))
            return
        }
        guard let attestation = registration.rawAttestationObject else {
            finish(.failure(PasskeySystemError("the registration carried no rawAttestationObject")))
            return
        }
        finish(.success(PasskeyRegistrationResponse(
            credentialIDBase64URL: Base64URL.encode(registration.credentialID),
            clientDataJSONBase64URL: Base64URL.encode(registration.rawClientDataJSON),
            attestationObjectBase64URL: Base64URL.encode(attestation)
        )))
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: any Error) {
        let ns = error as NSError
        // Domain, code and description, unedited. `ASAuthorizationError.failed`
        // (code 1004) with a message about the application not being associated
        // with the domain is the answer for a relying party the app has no
        // `webcredentials:` entitlement for; `.canceled` (1001) is the user
        // closing the sheet, and is not a fault.
        finish(.failure(PasskeySystemError("\(ns.domain) \(ns.code): \(ns.localizedDescription)")))
    }

    // MARK: - ASAuthorizationControllerPresentationContextProviding

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        NSApplication.shared.keyWindow ?? NSApplication.shared.windows.first ?? NSWindow()
    }

    private func finish(_ result: Result<PasskeyRegistrationResponse, PasskeySystemError>) {
        let pending = continuation
        continuation = nil
        controller = nil
        pending?.resume(returning: result)
    }
}

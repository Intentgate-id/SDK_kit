#if canImport(AuthenticationServices)
import AuthenticationServices
import Foundation
import IntentgateBasicAuth

public enum PasskeyError: Error, Equatable {
    /// The user dismissed the Face ID / Touch ID sheet.
    case cancelled
    case invalidOptions
    case unexpectedCredential
}

/// Registers and uses the worker's passkey with AuthenticationServices.
///
/// The app needs the Associated Domains entitlement `webcredentials:<rpId>` and
/// `https://<rpId>/.well-known/apple-app-site-association` listing the app.
/// The server must accept the app's origin (`https://<rpId>` for native iOS apps).
/// Use from the main thread, one request at a time.
@available(iOS 16.0, macOS 13.0, *)
public final class PasskeySigner: NSObject {
    private let rpId: String
    private let anchor: ASPresentationAnchor
    private var continuation: CheckedContinuation<ASAuthorization, Error>?
    private var controller: ASAuthorizationController?

    public init(rpId: String, anchor: ASPresentationAnchor) {
        self.rpId = rpId
        self.anchor = anchor
    }

    /// Signs a check-in challenge with user verification required.
    /// Returns WebAuthn AuthenticationResponseJSON, ready for `CheckInClient.complete`.
    public func sign(challenge: Data, allowedCredentialIds: [Data] = []) async throws -> Data {
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
        let request = provider.createCredentialAssertionRequest(challenge: challenge)
        request.userVerificationPreference = .required
        request.allowedCredentials = allowedCredentialIds.map { ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0) }
        let authorization = try await perform(request)
        guard let credential = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion else {
            throw PasskeyError.unexpectedCredential
        }
        let id = Base64Url.encode(credential.credentialID)
        let json: JSONValue = [
            "id": .string(id),
            "rawId": .string(id),
            "type": "public-key",
            "authenticatorAttachment": "platform",
            "clientExtensionResults": [:],
            "response": [
                "clientDataJSON": .string(Base64Url.encode(credential.rawClientDataJSON)),
                "authenticatorData": .string(Base64Url.encode(credential.rawAuthenticatorData)),
                "signature": .string(Base64Url.encode(credential.signature)),
                "userHandle": credential.userID.map { .string(Base64Url.encode($0)) } ?? .null,
            ],
        ]
        return Data(try Jcs.canonicalize(json).utf8)
    }

    /// Creates a passkey from the `options` object returned by
    /// POST /v1/workers/{id}/passkeys/options. Returns RegistrationResponseJSON for
    /// POST /v1/workers/{id}/passkeys (send it through your backend with the challenge_id).
    public func register(optionsJSON: Data) async throws -> Data {
        let options = try JSONValue.parse(optionsJSON)
        guard let challengeText = options["challenge"]?.stringValue, let challenge = Base64Url.decode(challengeText),
              let userIdText = options["user"]?["id"]?.stringValue, let userId = Base64Url.decode(userIdText),
              let userName = options["user"]?["name"]?.stringValue else { throw PasskeyError.invalidOptions }
        if let optionsRpId = options["rp"]?["id"]?.stringValue, optionsRpId != rpId { throw PasskeyError.invalidOptions }

        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
        let request = provider.createCredentialRegistrationRequest(challenge: challenge, name: userName, userID: userId)
        request.userVerificationPreference = .required
        let authorization = try await perform(request)
        guard let credential = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration,
              let attestationObject = credential.rawAttestationObject else { throw PasskeyError.unexpectedCredential }
        let id = Base64Url.encode(credential.credentialID)
        let json: JSONValue = [
            "id": .string(id),
            "rawId": .string(id),
            "type": "public-key",
            "authenticatorAttachment": "platform",
            "clientExtensionResults": [:],
            "response": [
                "clientDataJSON": .string(Base64Url.encode(credential.rawClientDataJSON)),
                "attestationObject": .string(Base64Url.encode(attestationObject)),
                "transports": ["internal", "hybrid"],
            ],
        ]
        return Data(try Jcs.canonicalize(json).utf8)
    }

    private func perform(_ request: ASAuthorizationRequest) async throws -> ASAuthorization {
        guard continuation == nil else { throw PasskeyError.unexpectedCredential }
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            self.controller = controller
            controller.performRequests()
        }
    }

    private func finish(_ result: Result<ASAuthorization, Error>) {
        let continuation = self.continuation
        self.continuation = nil
        self.controller = nil
        continuation?.resume(with: result)
    }
}

@available(iOS 16.0, macOS 13.0, *)
extension PasskeySigner: ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    public func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        finish(.success(authorization))
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        finish(.failure((error as? ASAuthorizationError)?.code == .canceled ? PasskeyError.cancelled : error))
    }

    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        anchor
    }
}

@available(iOS 16.0, macOS 13.0, *)
extension CheckInClient {
    /// prepare → passkey (Face ID / Touch ID) → queue. Returns the nonce if the user cancels.
    /// Call from the main thread.
    @discardableResult
    public func checkIn(
        signer: PasskeySigner, type: String, siteToken: String,
        attributes: [String: JSONValue] = [:], allowedCredentialIds: [Data] = []
    ) async throws -> UploadRecord {
        let prepared = try prepare(type: type, siteToken: siteToken, attributes: attributes)
        do {
            let assertion = try await signer.sign(challenge: prepared.challengeData, allowedCredentialIds: allowedCredentialIds)
            return try complete(prepared, assertionJSON: assertion)
        } catch {
            cancel(prepared)
            throw error
        }
    }
}
#endif

#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif
import Foundation

func sha256(_ parts: Data...) -> Data {
    var hasher = SHA256()
    for part in parts { hasher.update(data: part) }
    return Data(hasher.finalize())
}

/// Ed25519 helpers backed by CryptoKit (Apple) or swift-crypto (Linux).
public enum Ed25519 {
    /// Public key (raw 32 bytes) for a 32-byte seed.
    public static func publicKey(seed: Data) throws -> Data {
        try Curve25519.Signing.PrivateKey(rawRepresentation: seed).publicKey.rawRepresentation
    }

    /// A software signer from a 32-byte seed. On the site tablet, keep the seed in the Keychain.
    public static func signer(seed: Data) throws -> SiteToken.Signer {
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        return { message in try key.signature(for: message) }
    }

    public static func verify(signature: Data, message: Data, publicKey: Data) -> Bool {
        guard let key = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKey) else { return false }
        return key.isValidSignature(signature, for: message)
    }
}

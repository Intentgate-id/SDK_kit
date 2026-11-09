import Foundation

/// Rotating site token shown as a QR code on the site tablet:
///   IGS1.<base64url(JCS(payload))>.<base64url(Ed25519 signature over "IGS1.<payload part>")>
public struct SiteToken: Equatable, Sendable {
    public typealias Signer = (Data) throws -> Data

    public static let prefix = "IGS1"
    public static let defaultPeriodSeconds: Int64 = 30

    public let siteId: String
    public let kid: String
    public let t: Int64

    public init(siteId: String, kid: String, t: Int64) {
        self.siteId = siteId
        self.kid = kid
        self.t = t
    }

    public func payloadJSON() throws -> String {
        try Jcs.canonicalize(["v": 1, "site_id": .string(siteId), "kid": .string(kid), "t": .int(t)])
    }

    public func encode(signer: Signer) throws -> String {
        let body = Base64Url.encode(Data(try payloadJSON().utf8))
        let sig = try signer(Data("\(Self.prefix).\(body)".utf8))
        guard sig.count == 64 else { throw ValidationError("Ed25519 signature must be 64 bytes") }
        return "\(Self.prefix).\(body).\(Base64Url.encode(sig))"
    }

    public static func window(_ unixSeconds: Int64, period: Int64 = defaultPeriodSeconds) -> Int64 {
        let q = unixSeconds / period
        return (unixSeconds % period < 0 ? q - 1 : q) * period
    }

    /// Checks structure only. The signature is verified by the server (or `verify`).
    public static func parse(_ token: String) throws -> SiteToken { try parseParts(token).token }

    /// Verifies with a raw 32-byte Ed25519 public key.
    public static func verify(_ token: String, publicKey: Data) throws -> SiteToken {
        let parts = try parseParts(token)
        guard Ed25519.verify(signature: parts.signature, message: Data(parts.signingInput.utf8), publicKey: publicKey) else {
            throw ValidationError("site token signature is invalid")
        }
        return parts.token
    }

    private static func parseParts(_ token: String) throws -> (token: SiteToken, signingInput: String, signature: Data) {
        let parts = token.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 3, parts[0] == prefix,
              let payload = Base64Url.decode(parts[1]), let sig = Base64Url.decode(parts[2]),
              let json = String(data: payload, encoding: .utf8) else { throw ValidationError("malformed site token") }
        guard let value = try? JSONValue.parse(json), let o = value.objectValue,
              Set(o.keys) == ["v", "site_id", "kid", "t"], o["v"] == .int(1),
              let siteId = o["site_id"]?.stringValue, let kid = o["kid"]?.stringValue, let t = o["t"]?.intValue
        else { throw ValidationError("invalid site token payload") }
        let parsed = SiteToken(siteId: siteId, kid: kid, t: t)
        guard try parsed.payloadJSON() == json else { throw ValidationError("site token payload is not canonical") }
        guard sig.count == 64 else { throw ValidationError("invalid site token signature length") }
        return (parsed, "\(prefix).\(parts[1])", sig)
    }
}

/// Produces the token for the current window on the site tablet. Call `current()`
/// every second and redraw the QR code when the string changes. Works offline.
public final class SiteTokenGenerator {
    private let siteId: String
    private let kid: String
    private let signer: SiteToken.Signer
    private let now: () -> Date
    private let period: Int64
    private let lock = NSLock()
    private var cachedWindow = Int64.min
    private var cachedToken = ""

    public init(siteId: String, kid: String, signer: @escaping SiteToken.Signer,
                period: Int64 = SiteToken.defaultPeriodSeconds, now: @escaping () -> Date = Date.init) {
        self.siteId = siteId
        self.kid = kid
        self.signer = signer
        self.period = period
        self.now = now
    }

    public func current() throws -> String {
        lock.lock()
        defer { lock.unlock() }
        let window = SiteToken.window(Int64(now().timeIntervalSince1970.rounded(.down)), period: period)
        if window != cachedWindow {
            cachedToken = try SiteToken(siteId: siteId, kid: kid, t: window).encode(signer: signer)
            cachedWindow = window
        }
        return cachedToken
    }

    /// Seconds until the QR code changes, for a countdown on screen.
    public func secondsUntilRotation() -> Int64 {
        let s = Int64(now().timeIntervalSince1970.rounded(.down))
        return period - (s - SiteToken.window(s, period: period))
    }
}

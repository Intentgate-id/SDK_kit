import Foundation

public struct ValidationError: Error, CustomStringConvertible, Equatable {
    public let description: String
    public init(_ description: String) { self.description = description }
}

/// A check-in event signed by the worker's passkey. Mirrors protocol v1.
public struct CheckInEvent: Equatable, Sendable {
    public static let protocolVersion: Int64 = 1

    public let type: String
    public let deviceId: String
    public let seq: Int64
    public let nonceKid: String
    public let siteToken: String
    /// RFC 3339 with offset, device clock.
    public let occurredAt: String
    public let attributes: [String: JSONValue]

    public init(
        type: String, deviceId: String, seq: Int64, nonceKid: String, siteToken: String,
        occurredAt: String, attributes: [String: JSONValue] = [:]
    ) throws {
        guard Self.matches(type, #"^[a-z][a-z0-9_]{0,63}$"#) else { throw ValidationError("invalid type") }
        guard Self.matches(deviceId, Self.idPattern) else { throw ValidationError("invalid device_id") }
        guard Self.matches(nonceKid, Self.idPattern) else { throw ValidationError("invalid nonce_kid") }
        guard seq >= 0 && seq <= Jcs.maxSafeInteger else { throw ValidationError("invalid seq") }
        guard siteToken.utf16.count <= 1024 else { throw ValidationError("invalid site_token") }
        guard Self.matches(occurredAt, Self.rfc3339Pattern), Self.parseDate(occurredAt) != nil else {
            throw ValidationError("invalid occurred_at")
        }
        _ = try Jcs.canonicalize(.object(attributes)) // rejects floats
        self.type = type
        self.deviceId = deviceId
        self.seq = seq
        self.nonceKid = nonceKid
        self.siteToken = siteToken
        self.occurredAt = occurredAt
        self.attributes = attributes
    }

    /// The JSON object that is canonicalized and signed.
    public var json: JSONValue {
        .object([
            "v": .int(Self.protocolVersion),
            "type": .string(type),
            "device_id": .string(deviceId),
            "seq": .int(seq),
            "nonce_kid": .string(nonceKid),
            "site_token": .string(siteToken),
            "occurred_at": .string(occurredAt),
            "attributes": .object(attributes),
        ])
    }

    public func canonicalJSON() throws -> String { try Jcs.canonicalize(json) }

    public init(json: JSONValue) throws {
        guard json["v"] == .int(Self.protocolVersion) else { throw ValidationError("unsupported protocol version") }
        guard let type = json["type"]?.stringValue,
              let deviceId = json["device_id"]?.stringValue,
              let seq = json["seq"]?.intValue,
              let nonceKid = json["nonce_kid"]?.stringValue,
              let siteToken = json["site_token"]?.stringValue,
              let occurredAt = json["occurred_at"]?.stringValue,
              let attributes = json["attributes"]?.objectValue else { throw ValidationError("malformed event") }
        try self.init(type: type, deviceId: deviceId, seq: seq, nonceKid: nonceKid, siteToken: siteToken,
                      occurredAt: occurredAt, attributes: attributes)
    }

    static let idPattern = #"^[A-Za-z0-9_-]{1,128}$"#
    static let rfc3339Pattern = #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$"#

    static func matches(_ s: String, _ pattern: String) -> Bool {
        s.range(of: pattern, options: .regularExpression) != nil
    }

    static func parseDate(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }

    /// RFC 3339 in the given time zone, whole seconds, e.g. 2026-11-09T07:58:12+09:00.
    static func formatDate(_ date: Date, timeZone: TimeZone) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        f.timeZone = timeZone
        return f.string(from: date)
    }
}

/// challenge = SHA-256( "intentgate-basic-auth/v1" || 0x00 || nonce || JCS(event) )
public enum Challenge {
    public static let domain = "intentgate-basic-auth/v1"
    public static let nonceLength = 32

    public static func compute(nonce: Data, event: CheckInEvent) throws -> Data {
        guard nonce.count == nonceLength else { throw ValidationError("nonce must be \(nonceLength) bytes") }
        return sha256(Data(domain.utf8), Data([0]), nonce, Data(try event.canonicalJSON().utf8))
    }

    public static func computeBase64Url(nonce: Data, event: CheckInEvent) throws -> String {
        Base64Url.encode(try compute(nonce: nonce, event: event))
    }
}

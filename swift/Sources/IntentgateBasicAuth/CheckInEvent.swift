import Foundation

public struct ValidationError: Error, CustomStringConvertible, Equatable {
    public let description: String
    public init(_ description: String) { self.description = description }
}

/// Device position as integers: degrees × 10^7 (about 1 cm) and whole metres.
public struct EventLocation: Equatable, Sendable {
    public static let maxAccuracyM: Int64 = 100_000
    public let latE7: Int64
    public let lngE7: Int64
    public let accuracyM: Int64

    public init(latE7: Int64, lngE7: Int64, accuracyM: Int64) throws {
        guard (-900_000_000...900_000_000).contains(latE7) else { throw ValidationError("invalid location.lat_e7") }
        guard (-1_800_000_000...1_800_000_000).contains(lngE7) else { throw ValidationError("invalid location.lng_e7") }
        guard (0...Self.maxAccuracyM).contains(accuracyM) else { throw ValidationError("invalid location.accuracy_m") }
        self.latE7 = latE7
        self.lngE7 = lngE7
        self.accuracyM = accuracyM
    }

    public var json: JSONValue { .object(["lat_e7": .int(latE7), "lng_e7": .int(lngE7), "accuracy_m": .int(accuracyM)]) }
}

/// A check-in event (protocol v2). The server fixes it when the worker app asks to
/// check in; the worker's passkey signs `Challenge.compute(event)`.
public struct CheckInEvent: Equatable, Sendable {
    public static let protocolVersion: Int64 = 2

    public let type: String
    public let checkinId: String
    public let deviceId: String
    public let siteId: String
    /// 32 random bytes from the server, base64url.
    public let nonce: String
    /// Server time, RFC 3339 UTC ("…Z").
    public let issuedAt: String
    public let location: EventLocation
    public let attributes: [String: JSONValue]

    public init(
        type: String, checkinId: String, deviceId: String, siteId: String, nonce: String,
        issuedAt: String, location: EventLocation, attributes: [String: JSONValue] = [:]
    ) throws {
        guard Self.matches(type, #"^[a-z][a-z0-9_]{0,63}$"#) else { throw ValidationError("invalid type") }
        guard Self.matches(checkinId, Self.idPattern) else { throw ValidationError("invalid checkin_id") }
        guard Self.matches(deviceId, Self.idPattern) else { throw ValidationError("invalid device_id") }
        guard Self.matches(siteId, Self.idPattern) else { throw ValidationError("invalid site_id") }
        guard Base64Url.decode(nonce)?.count == 32 else { throw ValidationError("nonce must be 32 bytes base64url") }
        guard Self.matches(issuedAt, Self.rfc3339UtcPattern), Self.parseDate(issuedAt) != nil else {
            throw ValidationError("issued_at must be RFC 3339 UTC")
        }
        _ = try Jcs.canonicalize(.object(attributes)) // rejects floats
        self.type = type
        self.checkinId = checkinId
        self.deviceId = deviceId
        self.siteId = siteId
        self.nonce = nonce
        self.issuedAt = issuedAt
        self.location = location
        self.attributes = attributes
    }

    /// The JSON object that is canonicalized and signed.
    public var json: JSONValue {
        .object([
            "v": .int(Self.protocolVersion),
            "type": .string(type),
            "checkin_id": .string(checkinId),
            "device_id": .string(deviceId),
            "site_id": .string(siteId),
            "nonce": .string(nonce),
            "issued_at": .string(issuedAt),
            "location": location.json,
            "attributes": .object(attributes),
        ])
    }

    public func canonicalJSON() throws -> String { try Jcs.canonicalize(json) }

    /// Strict parse of a server event: exactly the v2 keys, right types.
    public init(json: JSONValue) throws {
        guard let o = json.objectValue, Set(o.keys) == Self.eventKeys else {
            throw ValidationError("event keys must be exactly: \(Self.eventKeys.sorted().joined(separator: ", "))")
        }
        guard o["v"] == .int(Self.protocolVersion) else { throw ValidationError("unsupported protocol version") }
        guard let loc = o["location"]?.objectValue, Set(loc.keys) == ["lat_e7", "lng_e7", "accuracy_m"],
              let lat = loc["lat_e7"]?.intValue, let lng = loc["lng_e7"]?.intValue, let acc = loc["accuracy_m"]?.intValue
        else { throw ValidationError("malformed location") }
        guard let type = o["type"]?.stringValue,
              let checkinId = o["checkin_id"]?.stringValue,
              let deviceId = o["device_id"]?.stringValue,
              let siteId = o["site_id"]?.stringValue,
              let nonce = o["nonce"]?.stringValue,
              let issuedAt = o["issued_at"]?.stringValue,
              let attributes = o["attributes"]?.objectValue else { throw ValidationError("malformed event") }
        try self.init(type: type, checkinId: checkinId, deviceId: deviceId, siteId: siteId, nonce: nonce,
                      issuedAt: issuedAt, location: try EventLocation(latE7: lat, lngE7: lng, accuracyM: acc), attributes: attributes)
    }

    static let eventKeys: Set<String> = ["v", "type", "checkin_id", "device_id", "site_id", "nonce", "issued_at", "location", "attributes"]
    static let idPattern = #"^[A-Za-z0-9_-]{1,128}$"#
    static let rfc3339UtcPattern = #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$"#

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
}

/// challenge = SHA-256( "intentgate-basic-auth/v2" || 0x00 || JCS(event) )
///
/// The passkey signs clientDataJSON, which carries this challenge, so the signature
/// covers the type, site, device, position, server time and server nonce.
public enum Challenge {
    public static let domain = "intentgate-basic-auth/v2"

    public static func compute(event: CheckInEvent) throws -> Data {
        sha256(Data(domain.utf8), Data([0]), Data(try event.canonicalJSON().utf8))
    }

    public static func computeBase64Url(event: CheckInEvent) throws -> String {
        Base64Url.encode(try compute(event: event))
    }
}

public enum Geo {
    /// Degrees → integer degrees × 10^7, rounded half up like JavaScript's Math.round.
    public static func toE7(_ degrees: Double) -> Int64 {
        Int64((degrees * 1e7 + 0.5).rounded(.down))
    }
}

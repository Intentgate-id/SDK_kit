import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// What the worker app asks for: body of POST /v1/devices/{device_id}/checkins.
/// `latitude`/`longitude` in degrees and `accuracyM` (horizontal accuracy, metres)
/// straight from Core Location (`CLLocation.horizontalAccuracy`).
public struct CheckInRequest: Equatable, Sendable {
    public let type: String
    public let siteId: String
    public let latitude: Double
    public let longitude: Double
    public let accuracyM: Double
    public let attributes: [String: JSONValue]

    public init(type: String, siteId: String, latitude: Double, longitude: Double, accuracyM: Double,
                attributes: [String: JSONValue] = [:]) throws {
        guard latitude.isFinite, (-90...90).contains(latitude) else { throw ValidationError("invalid latitude") }
        guard longitude.isFinite, (-180...180).contains(longitude) else { throw ValidationError("invalid longitude") }
        guard accuracyM.isFinite, accuracyM >= 0 else { throw ValidationError("invalid accuracy") }
        _ = try Jcs.canonicalize(.object(attributes))
        self.type = type
        self.siteId = siteId
        self.latitude = latitude
        self.longitude = longitude
        self.accuracyM = accuracyM
        self.attributes = attributes
    }

    private struct Body: Encodable {
        struct Location: Encodable { let latitude: Double; let longitude: Double; let accuracy_m: Double }
        let type: String
        let site_id: String
        let location: Location
        let attributes: [String: JSONValue]
    }

    /// Request JSON. Coordinates are plain JSON numbers here; only the signed event uses integers.
    public func jsonData() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(Body(type: type, site_id: siteId,
                                       location: .init(latitude: latitude, longitude: longitude, accuracy_m: accuracyM),
                                       attributes: attributes))
    }
}

public struct IssuedCheckInMismatch: Error, CustomStringConvertible, Equatable {
    public let field: String
    public var description: String { "issued event does not match the request: \(field)" }
}

/// Response of POST /v1/devices/{device_id}/checkins: the event the server fixed, to be signed.
public struct IssuedCheckIn: Sendable {
    public let checkinId: String
    public let event: CheckInEvent
    /// base64url, 32 bytes. Hand to the passkey as the WebAuthn challenge.
    public let challenge: String
    public let expiresAt: String
    public let rpId: String
    /// Credential ids (base64url) of the worker's passkeys, for allowCredentials.
    public let allowCredentials: [String]

    public var challengeData: Data { Base64Url.decode(challenge) ?? Data() }
    public var allowCredentialIds: [Data] { allowCredentials.compactMap(Base64Url.decode) }

    public init(json: JSONValue) throws {
        guard let checkinId = json["checkin_id"]?.stringValue, let event = json["event"],
              let challenge = json["challenge"]?.stringValue, let expiresAt = json["expires_at"]?.stringValue,
              let rpId = json["rp_id"]?.stringValue else { throw ValidationError("malformed issued check-in") }
        self.checkinId = checkinId
        self.event = try CheckInEvent(json: event)
        self.challenge = challenge
        self.expiresAt = expiresAt
        self.rpId = rpId
        self.allowCredentials = json["allow_credentials"]?.arrayValue?.compactMap(\.stringValue) ?? []
    }

    /// Refuses to sign anything other than what the app asked for: device, type, site,
    /// attributes, position (±1 in the 7th decimal), ceil(accuracy), and a challenge
    /// that really is the hash of the event.
    public func verify(deviceId: String, requested: CheckInRequest) throws {
        let e = event
        func check(_ ok: Bool, _ field: String) throws { if !ok { throw IssuedCheckInMismatch(field: field) } }
        try check(e.checkinId == checkinId, "checkin_id")
        try check(e.deviceId == deviceId, "device_id")
        try check(e.type == requested.type, "type")
        try check(e.siteId == requested.siteId, "site_id")
        try check(abs(e.location.latE7 - Geo.toE7(requested.latitude)) <= 1, "location.lat_e7")
        try check(abs(e.location.lngE7 - Geo.toE7(requested.longitude)) <= 1, "location.lng_e7")
        try check(e.location.accuracyM == Int64(requested.accuracyM.rounded(.up)), "location.accuracy_m")
        try check(try Jcs.canonicalize(.object(e.attributes)) == Jcs.canonicalize(.object(requested.attributes)), "attributes")
        try check(try Challenge.computeBase64Url(event: e) == challenge, "challenge")
    }
}

/// Answer of the complete call. `flags` e.g. "outside_site", "low_accuracy", "unassigned_site".
public struct CheckInResult: Equatable, Sendable {
    public let checkinId: String
    /// "accepted", or "duplicate" when the same check-in was already completed (safe re-send).
    public let status: String
    public let flags: [String]
    public let billable: Bool
    /// Distance from the site centre, metres.
    public let distanceM: Int64

    public var needsReview: Bool { !flags.isEmpty }

    public init(json: JSONValue) throws {
        guard let checkinId = json["checkin_id"]?.stringValue, let status = json["status"]?.stringValue,
              let flags = json["flags"]?.arrayValue, let billable = json["billable"]?.boolValue,
              let distance = json["distance_m"]?.intValue else { throw ValidationError("malformed result") }
        self.checkinId = checkinId
        self.status = status
        self.flags = flags.compactMap(\.stringValue)
        self.billable = billable
        self.distanceM = distance
    }
}

/// An error answer from Intentgate. `code` is the reason, e.g. "unknown_site", "checkin_expired".
public struct CheckInAPIError: Error, Equatable, CustomStringConvertible {
    public let status: Int
    public let code: String
    public let message: String
    public var description: String { "Intentgate \(status) \(code): \(message)" }
}

/// HTTP POST with a bearer token. Replace it for tests or your own networking stack.
public protocol CheckInTransport: Sendable {
    func post(url: URL, bearerToken: String, body: Data) async throws -> (status: Int, body: Data)
}

public struct URLSessionTransport: CheckInTransport {
    public let session: URLSession
    public init(session: URLSession = .shared) { self.session = session }

    public func post(url: URL, bearerToken: String, body: Data) async throws -> (status: Int, body: Data) {
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.httpMethod = "POST"
        request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "authorization")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = body
        let (data, response) = try await session.data(for: request)
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
    }
}

/// Worker-side check-in (online).
///
///     let issued = try await client.start(CheckInRequest(type: "site_entry", siteId: siteId,
///         latitude: loc.coordinate.latitude, longitude: loc.coordinate.longitude, accuracyM: loc.horizontalAccuracy))
///     // show issued.event to the worker, then Face ID / Touch ID:
///     let assertion = try await signer.sign(challenge: issued.challengeData, allowedCredentialIds: issued.allowCredentialIds)
///     let result = try await client.complete(checkinId: issued.checkinId, assertionJSON: assertion)
///
/// `start` verifies the issued event before returning, so the app never signs something other
/// than what it asked for. `complete` is safe to repeat after a network error: a second call
/// answers status "duplicate" with the stored result.
///
/// `deviceToken` (igd_…) is what your backend handed to this phone. Keep it in the Keychain.
public final class CheckInClient: Sendable {
    public let baseURL: URL
    public let deviceId: String
    private let deviceToken: String
    private let transport: CheckInTransport

    public init(baseURL: URL, deviceId: String, deviceToken: String, transport: CheckInTransport = URLSessionTransport()) {
        self.baseURL = baseURL
        self.deviceId = deviceId
        self.deviceToken = deviceToken
        self.transport = transport
    }

    public func start(_ request: CheckInRequest) async throws -> IssuedCheckIn {
        let body = try await call("v1/devices/\(deviceId)/checkins", try request.jsonData())
        let issued = try IssuedCheckIn(json: body)
        try issued.verify(deviceId: deviceId, requested: request)
        return issued
    }

    /// `assertionJSON` is the WebAuthn AuthenticationResponseJSON from the passkey.
    public func complete(checkinId: String, assertionJSON: Data) async throws -> CheckInResult {
        let assertion = try JSONValue.parse(assertionJSON)
        guard assertion["id"]?.stringValue != nil, assertion["response"]?.objectValue != nil else {
            throw ValidationError("not a WebAuthn assertion")
        }
        let body = Data(try Jcs.canonicalize(.object(["assertion": assertion])).utf8)
        return try CheckInResult(json: try await call("v1/devices/\(deviceId)/checkins/\(checkinId)/complete", body))
    }

    private func call(_ path: String, _ body: Data) async throws -> JSONValue {
        let (status, data) = try await transport.post(url: baseURL.appendingPathComponent(path), bearerToken: deviceToken, body: body)
        let json = try? JSONValue.parse(data)
        guard (200..<300).contains(status), let json else {
            throw CheckInAPIError(status: status, code: json?["error"]?["code"]?.stringValue ?? "http_\(status)",
                                  message: json?["error"]?["message"]?.stringValue ?? String(decoding: data.prefix(200), as: UTF8.self))
        }
        return json
    }
}

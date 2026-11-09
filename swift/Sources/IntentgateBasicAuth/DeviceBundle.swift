import Foundation

/// Nonce batch and settings from POST /v1/devices/{id}/bundle.
public struct DeviceBundle: Equatable, Sendable {
    public struct Nonce: Equatable, Sendable {
        public let seq: Int64
        public let value: Data
    }

    public let deviceId: String
    public let nonceKid: String
    public let nonces: [Nonce]
    /// Event type → billable.
    public let eventTypes: [String: Bool]
    public let lockAfter: Date

    public init(deviceId: String, nonceKid: String, nonces: [Nonce], eventTypes: [String: Bool], lockAfter: Date) {
        self.deviceId = deviceId
        self.nonceKid = nonceKid
        self.nonces = nonces
        self.eventTypes = eventTypes
        self.lockAfter = lockAfter
    }

    public static func parse(_ data: Data) throws -> DeviceBundle {
        let m = try JSONValue.parse(data)
        guard let deviceId = m["device_id"]?.stringValue,
              let nonceKid = m["nonce_kid"]?.stringValue,
              let rawNonces = m["nonces"]?.arrayValue,
              let rawTypes = m["event_types"]?.arrayValue,
              let lockAfterText = m["lock_after"]?.stringValue,
              let lockAfter = CheckInEvent.parseDate(lockAfterText) else { throw ValidationError("malformed bundle") }
        let nonces = try rawNonces.map { n -> Nonce in
            guard let seq = n["seq"]?.intValue, let text = n["nonce"]?.stringValue, let value = Base64Url.decode(text),
                  value.count == Challenge.nonceLength else { throw ValidationError("malformed nonce") }
            return Nonce(seq: seq, value: value)
        }
        var types: [String: Bool] = [:]
        for t in rawTypes {
            guard let type = t["type"]?.stringValue, let billable = t["billable"]?.boolValue else {
                throw ValidationError("malformed event type")
            }
            types[type] = billable
        }
        return DeviceBundle(deviceId: deviceId, nonceKid: nonceKid, nonces: nonces, eventTypes: types, lockAfter: lockAfter)
    }
}

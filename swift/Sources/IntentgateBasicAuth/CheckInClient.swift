import Foundation

/// A signed check-in waiting for upload.
public struct UploadRecord: Equatable, Sendable {
    public let event: CheckInEvent
    /// WebAuthn AuthenticationResponseJSON.
    public let assertion: JSONValue

    public var json: JSONValue { .object(["event": event.json, "assertion": assertion]) }
}

/// Check-in prepared for signing. Pass `challenge` to the passkey as the WebAuthn challenge.
public struct PreparedCheckIn: Sendable {
    public let event: CheckInEvent
    /// base64url, 32 bytes.
    public let challenge: String
    let nonce: DeviceBundle.Nonce

    /// The raw challenge bytes, for platform APIs that take Data.
    public var challengeData: Data { Base64Url.decode(challenge)! }
}

public enum CheckInError: Error, Equatable {
    /// The device has been offline too long; sync before checking in.
    case offlineLocked
    /// No nonces left; sync before checking in.
    case noNonce
    case unknownEventType(String)
    case invalidAssertion
}

/// Worker-side check-in flow. Works fully offline:
///
///     let prepared = try client.prepare(type: "site_entry", siteToken: scannedQR)
///     let assertion = try await signer.sign(challenge: prepared.challengeData)  // Face ID / Touch ID
///     try client.complete(prepared, assertionJSON: assertion)                    // queued until online
///     ...
///     let body = try client.uploadBody()                                         // POST /v1/devices/{id}/events
public final class CheckInClient {
    private let bundles: BundleStore
    private let queue: RecordQueue
    private let now: () -> Date
    private let timeZone: TimeZone

    public init(bundles: BundleStore, queue: RecordQueue, timeZone: TimeZone = .current, now: @escaping () -> Date = Date.init) {
        self.bundles = bundles
        self.queue = queue
        self.timeZone = timeZone
        self.now = now
    }

    /// Store a fresh bundle from POST /v1/devices/{id}/bundle.
    public func sync(bundle: DeviceBundle) { bundles.replace(bundle) }

    /// True when the bundle's offline period is over and the app must sync first.
    public var isLocked: Bool {
        guard let bundle = bundles.current() else { return true }
        return now() > bundle.lockAfter
    }

    public var remainingCheckIns: Int { bundles.remaining() }

    public func prepare(type: String, siteToken: String, attributes: [String: JSONValue] = [:]) throws -> PreparedCheckIn {
        guard let bundle = bundles.current() else { throw CheckInError.noNonce }
        guard !isLocked else { throw CheckInError.offlineLocked }
        guard bundle.eventTypes[type] != nil else { throw CheckInError.unknownEventType(type) }
        _ = try SiteToken.parse(siteToken) // rejects QR codes that are not Intentgate site tokens
        guard let nonce = bundles.takeNonce() else { throw CheckInError.noNonce }
        do {
            let event = try CheckInEvent(
                type: type,
                deviceId: bundle.deviceId,
                seq: nonce.seq,
                nonceKid: bundle.nonceKid,
                siteToken: siteToken,
                occurredAt: CheckInEvent.formatDate(now(), timeZone: timeZone),
                attributes: attributes
            )
            return PreparedCheckIn(event: event, challenge: try Challenge.computeBase64Url(nonce: nonce.value, event: event), nonce: nonce)
        } catch {
            bundles.releaseNonce(nonce)
            throw error
        }
    }

    /// The user cancelled the biometric prompt: return the nonce so no sequence gap appears.
    public func cancel(_ prepared: PreparedCheckIn) { bundles.releaseNonce(prepared.nonce) }

    /// Stores the signed check-in for upload.
    @discardableResult
    public func complete(_ prepared: PreparedCheckIn, assertionJSON: Data) throws -> UploadRecord {
        guard let assertion = try? JSONValue.parse(assertionJSON),
              assertion["id"]?.stringValue != nil, assertion["response"]?.objectValue != nil else {
            throw CheckInError.invalidAssertion
        }
        let record = UploadRecord(event: prepared.event, assertion: assertion)
        queue.add(record)
        return record
    }

    /// JSON body for POST /v1/devices/{device_id}/events, or nil when nothing is pending.
    public func uploadBody() throws -> Data? {
        guard let bundle = bundles.current() else { return nil }
        let pending = queue.pending()
        guard !pending.isEmpty else { return nil }
        let body: JSONValue = ["device_id": .string(bundle.deviceId), "records": .array(pending.map(\.json))]
        return Data(try Jcs.canonicalize(body).utf8)
    }

    /// Drop records the server has answered for (accepted, duplicate or rejected).
    public func acknowledge(_ seqs: [Int64]) { queue.remove(seqs) }
}

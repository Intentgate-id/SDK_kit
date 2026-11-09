package id.intentgate.basicauth

import java.time.Clock
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter

/** A signed check-in waiting for upload. */
data class UploadRecord(val event: CheckInEvent, val assertionJson: String) {
    fun toJsonMap(): Map<String, Any?> = mapOf("event" to event.toJsonMap(), "assertion" to Json.parse(assertionJson))
}

/** Check-in prepared for signing. Pass [challenge] to the passkey as the WebAuthn challenge. */
class PreparedCheckIn internal constructor(
    val event: CheckInEvent,
    /** base64url, 32 bytes. */
    val challenge: String,
    internal val nonce: DeviceBundle.Nonce,
)

class OfflineLockedException : IllegalStateException("device has been offline too long; sync before checking in")
class NoNonceException : IllegalStateException("no nonces left; sync before checking in")
class UnknownEventTypeException(type: String) : IllegalArgumentException("unknown event type: $type")

/**
 * Worker-side check-in flow. Works fully offline:
 *
 *   val prepared = client.prepare("site_entry", scannedQr)
 *   val assertionJson = passkeySigner.sign(prepared.challenge)   // platform passkey, biometric
 *   client.complete(prepared, assertionJson)                      // queued until online
 *   ...
 *   val body = client.uploadBody()                               // POST /v1/devices/{id}/events
 */
class CheckInClient(
    private val bundles: BundleStore,
    private val queue: RecordQueue,
    private val clock: Clock = Clock.systemDefaultZone(),
) {
    /** True when the bundle's offline period is over and the app must sync first. */
    fun isLocked(): Boolean {
        val bundle = bundles.current() ?: return true
        return clock.instant().isAfter(bundle.lockAfter)
    }

    fun prepare(type: String, siteToken: String, attributes: Map<String, Any?> = emptyMap()): PreparedCheckIn {
        val bundle = bundles.current() ?: throw NoNonceException()
        if (isLocked()) throw OfflineLockedException()
        if (type !in bundle.eventTypes) throw UnknownEventTypeException(type)
        SiteToken.parse(siteToken) // rejects QR codes that are not Intentgate site tokens
        val nonce = bundles.takeNonce() ?: throw NoNonceException()
        try {
            val event = CheckInEvent(
                type = type,
                deviceId = bundle.deviceId,
                seq = nonce.seq,
                nonceKid = bundle.nonceKid,
                siteToken = siteToken,
                occurredAt = OffsetDateTime.now(clock).format(RFC3339_SECONDS),
                attributes = attributes,
            )
            return PreparedCheckIn(event, Challenge.computeBase64Url(nonce.value, event), nonce)
        } catch (e: RuntimeException) {
            bundles.releaseNonce(nonce)
            throw e
        }
    }

    /** The user cancelled the biometric prompt: return the nonce so no sequence gap appears. */
    fun cancel(prepared: PreparedCheckIn) = bundles.releaseNonce(prepared.nonce)

    /** Stores the signed check-in for upload. [assertionJson] is the WebAuthn AuthenticationResponseJSON. */
    fun complete(prepared: PreparedCheckIn, assertionJson: String): UploadRecord {
        val parsed = Json.parse(assertionJson) as? Map<*, *> ?: throw IllegalArgumentException("assertion must be a JSON object")
        require(parsed["id"] is String && parsed["response"] is Map<*, *>) { "not a WebAuthn assertion" }
        val record = UploadRecord(prepared.event, assertionJson)
        queue.add(record)
        return record
    }

    /** JSON body for POST /v1/devices/{device_id}/events, or null when nothing is pending. */
    fun uploadBody(): String? {
        val bundle = bundles.current() ?: return null
        val pending = queue.pending()
        if (pending.isEmpty()) return null
        return Jcs.canonicalize(mapOf("device_id" to bundle.deviceId, "records" to pending.map { it.toJsonMap() }))
    }

    /** Drop records the server has answered for (accepted, duplicate or rejected). */
    fun acknowledge(seqs: Collection<Long>) = queue.remove(seqs)

    private companion object {
        // OffsetDateTime.toString() drops ":00" seconds, which RFC 3339 does not allow.
        val RFC3339_SECONDS: DateTimeFormatter = DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ssXXX")
    }
}

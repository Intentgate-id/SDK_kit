package id.intentgate.basicauth

import java.time.OffsetDateTime
import java.time.format.DateTimeParseException

/** A check-in event signed by the worker's passkey. Mirrors protocol v1. */
data class CheckInEvent(
    val type: String,
    val deviceId: String,
    val seq: Long,
    val nonceKid: String,
    val siteToken: String,
    /** RFC 3339 with offset, device clock. */
    val occurredAt: String,
    val attributes: Map<String, Any?> = emptyMap(),
) {
    init {
        require(EVENT_TYPE.matches(type)) { "invalid type" }
        require(ID.matches(deviceId)) { "invalid device_id" }
        require(ID.matches(nonceKid)) { "invalid nonce_kid" }
        require(seq in 0..9_007_199_254_740_991L) { "invalid seq" }
        require(siteToken.length <= 1024) { "invalid site_token" }
        require(RFC3339.matches(occurredAt) && parses(occurredAt)) { "invalid occurred_at" }
        Jcs.canonicalize(attributes) // rejects floats and unsupported values
    }

    /** The JSON object that is canonicalized and signed. */
    fun toJsonMap(): Map<String, Any?> = mapOf(
        "v" to PROTOCOL_VERSION,
        "type" to type,
        "device_id" to deviceId,
        "seq" to seq,
        "nonce_kid" to nonceKid,
        "site_token" to siteToken,
        "occurred_at" to occurredAt,
        "attributes" to attributes,
    )

    fun canonicalJson(): String = Jcs.canonicalize(toJsonMap())

    companion object {
        const val PROTOCOL_VERSION = 1
        private val EVENT_TYPE = Regex("^[a-z][a-z0-9_]{0,63}$")
        private val ID = Regex("^[A-Za-z0-9_-]{1,128}$")
        private val RFC3339 = Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?(?:Z|[+-]\\d{2}:\\d{2})$")

        private fun parses(s: String) = try { OffsetDateTime.parse(s); true } catch (_: DateTimeParseException) { false }

        @Suppress("UNCHECKED_CAST")
        fun fromJsonMap(m: Map<String, Any?>): CheckInEvent {
            require(m["v"] == PROTOCOL_VERSION.toLong()) { "unsupported protocol version" }
            return CheckInEvent(
                type = m["type"] as String,
                deviceId = m["device_id"] as String,
                seq = m["seq"] as Long,
                nonceKid = m["nonce_kid"] as String,
                siteToken = m["site_token"] as String,
                occurredAt = m["occurred_at"] as String,
                attributes = m["attributes"] as Map<String, Any?>,
            )
        }
    }
}

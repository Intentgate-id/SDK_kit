package id.intentgate.basicauth

import java.time.Instant
import java.time.format.DateTimeParseException

/** Device position as integers: degrees × 10^7 (about 1 cm) and whole metres. */
data class EventLocation(val latE7: Long, val lngE7: Long, val accuracyM: Long) {
    init {
        require(latE7 in -900_000_000L..900_000_000L) { "invalid location.lat_e7" }
        require(lngE7 in -1_800_000_000L..1_800_000_000L) { "invalid location.lng_e7" }
        require(accuracyM in 0..MAX_ACCURACY_M) { "invalid location.accuracy_m" }
    }

    fun toJsonMap(): Map<String, Any?> = mapOf("lat_e7" to latE7, "lng_e7" to lngE7, "accuracy_m" to accuracyM)

    companion object {
        const val MAX_ACCURACY_M = 100_000L
    }
}

/**
 * A check-in event (protocol v2). The server fixes it when the worker app asks to
 * check in; the worker's passkey signs [Challenge.compute] of it.
 */
data class CheckInEvent(
    val type: String,
    val checkinId: String,
    val deviceId: String,
    val siteId: String,
    /** 32 random bytes from the server, base64url. */
    val nonce: String,
    /** Server time, RFC 3339 UTC ("…Z"). */
    val issuedAt: String,
    val location: EventLocation,
    val attributes: Map<String, Any?> = emptyMap(),
) {
    init {
        require(EVENT_TYPE.matches(type)) { "invalid type" }
        require(ID.matches(checkinId)) { "invalid checkin_id" }
        require(ID.matches(deviceId)) { "invalid device_id" }
        require(ID.matches(siteId)) { "invalid site_id" }
        require(runCatching { Base64Url.decode(nonce).size == 32 }.getOrDefault(false)) { "nonce must be 32 bytes base64url" }
        require(RFC3339_UTC.matches(issuedAt) && parses(issuedAt)) { "issued_at must be RFC 3339 UTC" }
        Jcs.canonicalize(attributes) // rejects floats and unsupported values
    }

    /** The JSON object that is canonicalized and signed. */
    fun toJsonMap(): Map<String, Any?> = mapOf(
        "v" to PROTOCOL_VERSION,
        "type" to type,
        "checkin_id" to checkinId,
        "device_id" to deviceId,
        "site_id" to siteId,
        "nonce" to nonce,
        "issued_at" to issuedAt,
        "location" to location.toJsonMap(),
        "attributes" to attributes,
    )

    fun canonicalJson(): String = Jcs.canonicalize(toJsonMap())

    companion object {
        const val PROTOCOL_VERSION = 2
        private val EVENT_TYPE = Regex("^[a-z][a-z0-9_]{0,63}$")
        private val ID = Regex("^[A-Za-z0-9_-]{1,128}$")
        private val RFC3339_UTC = Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?Z$")
        private val EVENT_KEYS = setOf("v", "type", "checkin_id", "device_id", "site_id", "nonce", "issued_at", "location", "attributes")
        private val LOCATION_KEYS = setOf("lat_e7", "lng_e7", "accuracy_m")

        private fun parses(s: String) = try { Instant.parse(s); true } catch (_: DateTimeParseException) { false }

        /** Strict parse of a server event: exactly the v2 keys, right types. */
        @Suppress("UNCHECKED_CAST")
        fun fromJsonMap(m: Map<String, Any?>): CheckInEvent {
            require(m.keys == EVENT_KEYS) { "event keys must be exactly: ${EVENT_KEYS.sorted().joinToString()}" }
            require(m["v"] == PROTOCOL_VERSION.toLong()) { "unsupported protocol version" }
            val loc = m["location"] as? Map<String, Any?> ?: throw IllegalArgumentException("location must be an object")
            require(loc.keys == LOCATION_KEYS) { "location keys must be exactly: ${LOCATION_KEYS.sorted().joinToString()}" }
            fun str(k: String) = m[k] as? String ?: throw IllegalArgumentException("invalid $k")
            fun long(k: String) = loc[k] as? Long ?: throw IllegalArgumentException("invalid location.$k")
            return CheckInEvent(
                type = str("type"),
                checkinId = str("checkin_id"),
                deviceId = str("device_id"),
                siteId = str("site_id"),
                nonce = str("nonce"),
                issuedAt = str("issued_at"),
                location = EventLocation(long("lat_e7"), long("lng_e7"), long("accuracy_m")),
                attributes = m["attributes"] as? Map<String, Any?> ?: throw IllegalArgumentException("attributes must be an object"),
            )
        }
    }
}

package id.intentgate.basicauth

import kotlin.math.ceil

/**
 * What the worker app asks for: body of POST /v1/devices/{device_id}/checkins.
 * [latitude]/[longitude] in degrees and [accuracyM] (horizontal accuracy, metres)
 * straight from the platform's location API.
 */
data class CheckInRequest(
    val type: String,
    val siteId: String,
    val latitude: Double,
    val longitude: Double,
    val accuracyM: Double,
    val attributes: Map<String, Any?> = emptyMap(),
) {
    init {
        require(latitude.isFinite() && latitude in -90.0..90.0) { "invalid latitude" }
        require(longitude.isFinite() && longitude in -180.0..180.0) { "invalid longitude" }
        require(accuracyM.isFinite() && accuracyM >= 0) { "invalid accuracy" }
        Jcs.canonicalize(attributes)
    }

    /** Request JSON. Coordinates are plain JSON numbers here; only the signed event uses integers. */
    fun toJson(): String {
        val attrs = Jcs.canonicalize(attributes)
        return """{"type":${Jcs.canonicalize(type)},"site_id":${Jcs.canonicalize(siteId)},""" +
            """"location":{"latitude":${num(latitude)},"longitude":${num(longitude)},"accuracy_m":${num(accuracyM)}},""" +
            """"attributes":$attrs}"""
    }

    private fun num(d: Double): String = if (d == Math.rint(d) && Math.abs(d) < 1e15) d.toLong().toString() else d.toString()
}

class IssuedCheckInMismatchException(what: String) :
    SecurityException("issued event does not match the request: $what")

/** Response of POST /v1/devices/{device_id}/checkins: the event the server fixed, to be signed. */
class IssuedCheckIn(
    val checkinId: String,
    val event: CheckInEvent,
    /** base64url, 32 bytes. Hand to the passkey as the WebAuthn challenge. */
    val challenge: String,
    val expiresAt: String,
    val rpId: String,
    /** Credential ids (base64url) of the worker's passkeys, for allowCredentials. */
    val allowCredentials: List<String>,
) {
    /**
     * Refuses to sign anything other than what the app asked for: device, type, site,
     * attributes, position (±1 in the 7th decimal), ceil(accuracy), and a challenge
     * that really is the hash of the event. Throws [IssuedCheckInMismatchException].
     */
    fun verify(deviceId: String, requested: CheckInRequest) {
        fun mismatch(what: String): Nothing = throw IssuedCheckInMismatchException(what)
        val e = event
        if (e.checkinId != checkinId) mismatch("checkin_id")
        if (e.deviceId != deviceId) mismatch("device_id")
        if (e.type != requested.type) mismatch("type")
        if (e.siteId != requested.siteId) mismatch("site_id")
        if (Math.abs(e.location.latE7 - Geo.toE7(requested.latitude)) > 1) mismatch("location.lat_e7")
        if (Math.abs(e.location.lngE7 - Geo.toE7(requested.longitude)) > 1) mismatch("location.lng_e7")
        if (e.location.accuracyM != ceil(requested.accuracyM).toLong()) mismatch("location.accuracy_m")
        if (Jcs.canonicalize(e.attributes) != Jcs.canonicalize(requested.attributes)) mismatch("attributes")
        if (Challenge.computeBase64Url(e) != challenge) mismatch("challenge")
    }

    companion object {
        @Suppress("UNCHECKED_CAST")
        fun parse(json: String): IssuedCheckIn {
            val m = Json.parse(json) as? Map<String, Any?> ?: throw IllegalArgumentException("not a JSON object")
            fun str(k: String) = m[k] as? String ?: throw IllegalArgumentException("missing $k")
            return IssuedCheckIn(
                checkinId = str("checkin_id"),
                event = CheckInEvent.fromJsonMap(m["event"] as? Map<String, Any?> ?: throw IllegalArgumentException("missing event")),
                challenge = str("challenge"),
                expiresAt = str("expires_at"),
                rpId = str("rp_id"),
                allowCredentials = (m["allow_credentials"] as? List<*>)?.map { it as String } ?: emptyList(),
            )
        }
    }
}

/** Answer of the complete call. [flags] e.g. "outside_site", "low_accuracy", "unassigned_site". */
data class CheckInResult(
    val checkinId: String,
    /** "accepted", or "duplicate" when the same check-in was already completed (safe re-send). */
    val status: String,
    val flags: List<String>,
    val billable: Boolean,
    /** Distance from the site centre, metres. */
    val distanceM: Long,
) {
    val needsReview: Boolean get() = flags.isNotEmpty()

    companion object {
        @Suppress("UNCHECKED_CAST")
        fun parse(json: String): CheckInResult {
            val m = Json.parse(json) as Map<String, Any?>
            return CheckInResult(
                checkinId = m["checkin_id"] as String,
                status = m["status"] as String,
                flags = (m["flags"] as List<*>).map { it as String },
                billable = m["billable"] as Boolean,
                distanceM = m["distance_m"] as Long,
            )
        }
    }
}

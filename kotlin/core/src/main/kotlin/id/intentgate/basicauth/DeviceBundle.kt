package id.intentgate.basicauth

import java.time.Instant

/** Nonce batch and settings from POST /v1/devices/{id}/bundle. */
data class DeviceBundle(
    val deviceId: String,
    val nonceKid: String,
    val nonces: List<Nonce>,
    val eventTypes: Map<String, Boolean>,
    val lockAfter: Instant,
) {
    data class Nonce(val seq: Long, val value: ByteArray) {
        override fun equals(other: Any?) = other is Nonce && other.seq == seq && other.value.contentEquals(value)
        override fun hashCode() = seq.hashCode()
    }

    companion object {
        fun parse(json: String): DeviceBundle {
            val m = Json.parse(json) as? Map<*, *> ?: throw IllegalArgumentException("bundle must be an object")
            val nonces = (m["nonces"] as List<*>).map {
                val n = it as Map<*, *>
                val value = Base64Url.decode(n["nonce"] as String)
                require(value.size == Challenge.NONCE_LENGTH) { "nonce must be 32 bytes" }
                Nonce(n["seq"] as Long, value)
            }
            val types = (m["event_types"] as List<*>).associate {
                val t = it as Map<*, *>
                (t["type"] as String) to (t["billable"] as Boolean)
            }
            return DeviceBundle(
                deviceId = m["device_id"] as String,
                nonceKid = m["nonce_kid"] as String,
                nonces = nonces,
                eventTypes = types,
                lockAfter = Instant.parse(m["lock_after"] as String),
            )
        }
    }
}

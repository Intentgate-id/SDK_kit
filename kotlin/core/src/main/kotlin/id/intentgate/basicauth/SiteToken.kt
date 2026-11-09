package id.intentgate.basicauth

import java.security.KeyFactory
import java.security.Signature
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec

/**
 * Rotating site token shown as a QR code on the site tablet:
 *   IGS1.<base64url(JCS(payload))>.<base64url(Ed25519 signature over "IGS1.<payload part>")>
 */
data class SiteToken(val siteId: String, val kid: String, val t: Long) {

    /** Signs Ed25519 over the given message. Plug in Android Keystore or JDK keys. */
    fun interface Signer {
        fun sign(message: ByteArray): ByteArray
    }

    class SiteTokenException(message: String) : IllegalArgumentException(message)

    fun payloadJson(): String = Jcs.canonicalize(mapOf("v" to 1, "site_id" to siteId, "kid" to kid, "t" to t))

    fun encode(signer: Signer): String {
        val body = Base64Url.encode(payloadJson().toByteArray(Charsets.UTF_8))
        val sig = signer.sign("$PREFIX.$body".toByteArray(Charsets.US_ASCII))
        if (sig.size != 64) throw SiteTokenException("Ed25519 signature must be 64 bytes")
        return "$PREFIX.$body.${Base64Url.encode(sig)}"
    }

    companion object {
        const val PREFIX = "IGS1"
        const val DEFAULT_PERIOD_SECONDS = 30L

        fun window(unixSeconds: Long, period: Long = DEFAULT_PERIOD_SECONDS): Long = Math.floorDiv(unixSeconds, period) * period

        /** Checks structure only. The signature is verified by the server (or [verify]). */
        fun parse(token: String): SiteToken = parseParts(token).first

        private fun parseParts(token: String): Triple<SiteToken, String, ByteArray> {
            val parts = token.split('.')
            if (parts.size != 3 || parts[0] != PREFIX) throw SiteTokenException("malformed site token")
            val (json, sig) = try {
                String(Base64Url.decode(parts[1]), Charsets.UTF_8) to Base64Url.decode(parts[2])
            } catch (e: IllegalArgumentException) {
                throw SiteTokenException("malformed site token")
            }
            val m = try { Json.parse(json) as? Map<*, *> } catch (e: IllegalArgumentException) { null }
                ?: throw SiteTokenException("invalid site token payload")
            if (m.keys != setOf("v", "site_id", "kid", "t") || m["v"] != 1L) throw SiteTokenException("invalid site token payload")
            val siteId = m["site_id"] as? String ?: throw SiteTokenException("invalid site_id")
            val kid = m["kid"] as? String ?: throw SiteTokenException("invalid kid")
            val t = m["t"] as? Long ?: throw SiteTokenException("invalid t")
            val parsed = SiteToken(siteId, kid, t)
            if (parsed.payloadJson() != json) throw SiteTokenException("site token payload is not canonical")
            if (sig.size != 64) throw SiteTokenException("invalid site token signature length")
            return Triple(parsed, "$PREFIX.${parts[1]}", sig)
        }

        /** Verifies with a raw 32-byte Ed25519 public key (JDK 15+, Android API 33+). */
        fun verify(token: String, publicKeyRaw: ByteArray): SiteToken {
            val (parsed, signingInput, sig) = parseParts(token)
            require(publicKeyRaw.size == 32) { "Ed25519 public key must be 32 bytes" }
            val key = KeyFactory.getInstance("Ed25519").generatePublic(X509EncodedKeySpec(X509_PREFIX + publicKeyRaw))
            val ok = Signature.getInstance("Ed25519").run {
                initVerify(key)
                update(signingInput.toByteArray(Charsets.US_ASCII))
                verify(sig)
            }
            if (!ok) throw SiteTokenException("site token signature is invalid")
            return parsed
        }

        /** JDK Ed25519 signer from a 32-byte seed. On Android prefer a Keystore-backed signer. */
        fun jdkSigner(seed: ByteArray): Signer {
            require(seed.size == 32) { "Ed25519 seed must be 32 bytes" }
            val key = KeyFactory.getInstance("Ed25519").generatePrivate(PKCS8EncodedKeySpec(PKCS8_PREFIX + seed))
            return Signer { message ->
                Signature.getInstance("Ed25519").run {
                    initSign(key)
                    update(message)
                    sign()
                }
            }
        }

        private val X509_PREFIX = hexToBytes("302a300506032b6570032100")
        private val PKCS8_PREFIX = hexToBytes("302e020100300506032b657004220420")
    }
}

/**
 * Produces the token for the current window on the site tablet. Call [current]
 * every second and redraw the QR code when the string changes. Works offline.
 */
class SiteTokenGenerator(
    private val siteId: String,
    private val kid: String,
    private val signer: SiteToken.Signer,
    private val clock: java.time.Clock = java.time.Clock.systemUTC(),
    private val periodSeconds: Long = SiteToken.DEFAULT_PERIOD_SECONDS,
) {
    private var cachedWindow = Long.MIN_VALUE
    private var cachedToken = ""

    @Synchronized
    fun current(): String {
        val window = SiteToken.window(clock.instant().epochSecond, periodSeconds)
        if (window != cachedWindow) {
            cachedToken = SiteToken(siteId, kid, window).encode(signer)
            cachedWindow = window
        }
        return cachedToken
    }

    /** Seconds until the QR code changes, for a countdown on screen. */
    fun secondsUntilRotation(): Long = periodSeconds - Math.floorMod(clock.instant().epochSecond, periodSeconds)
}
